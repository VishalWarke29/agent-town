import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { FOLDER_PICK_LIMITS, folderPickHelperLineSchema, type FolderPick, type FolderPickState, type FolderPickUnavailableReason } from '@agent-town/contracts';
import { FOLDER_PICKER_SCRIPT } from './folder-picker-script.js';
import { IdentityError } from './identity/types.js';

/**
 * The "Browse..." folder window (plan items WS1-05 / WS1-07). A web page can never learn the absolute path of a folder
 * it picks, so this service starts a small Windows helper that shows a real folder window on the owner's desktop and
 * prints the chosen path. The picker only ever hands that path back as text; it adds no authority. Adding a folder
 * still goes through the normal add-folder routes, which canonicalise it and refuse unsafe places.
 *
 * Privacy: a chosen path is held in memory for a couple of minutes so the last poll can read it. It is never
 * persisted and never logged, and nothing in this module writes to any log.
 */

export type FolderPickLimits = { -readonly [K in keyof typeof FOLDER_PICK_LIMITS]: number };

/** How long a finished pick stays readable, so the page's last poll can still see `selected` or `cancelled`. */
export const FOLDER_PICK_RETAIN_MS = 2 * 60_000;
/** Finished picks kept at once. Bounds memory if a page starts and cancels in a loop. */
const MAX_FINISHED_PICKS = 8;
/** How long close() waits for a killed helper to finish going away before letting shutdown continue. */
const CLOSE_WAIT_MS = 3_000;
/**
 * Caps on what the helper may print. The protocol is two short lines, so these only stop a runaway or hostile process.
 * The line cap leaves room for the longest allowed path (1,024 characters) even if every character is written as a
 * six-character JSON escape (6,144 characters).
 */
export const HELPER_OUTPUT_LIMITS = { maxOutputBytes: 64 * 1024, maxLineChars: 32 * 1024 } as const;
/** A Windows command line holds about 32,767 characters; the script travels inside it as base64. */
export const MAX_ENCODED_COMMAND_CHARS = 30_000;
const TEMP_PREFIX = 'agent-town-folder-';
/** The helper's exit code for "this session has no interactive desktop" (see folder-picker-script.ts). */
const HELPER_NO_DESKTOP_EXIT = 3;
/** A helper folder older than this was left by a service that was killed before it could clean up. */
const STALE_FOLDER_MS = 24 * 60 * 60_000;

/**
 * Removes helper folders that a force-killed service left in the temporary folder more than a day ago. Only directories
 * whose name starts with this module's prefix, directly under `tempRoot`, are touched; anything else (files, links,
 * other names, recent folders) is left alone. Best effort: returns how many were removed and never throws.
 */
export async function sweepStaleHelperFolders(tempRoot: string, nowMs: number = Date.now(), maxAgeMs: number = STALE_FOLDER_MS): Promise<number> {
  let removed = 0;
  try {
    const root = resolve(tempRoot);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
      const target = join(root, entry.name);
      if (!resolve(target).startsWith(root + sep)) continue;
      try {
        if (nowMs - (await stat(target)).mtimeMs < maxAgeMs) continue;
        await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed++;
      } catch { /* In use or already gone: leave it. */ }
    }
  } catch { /* No temporary folder to look in. */ }
  return removed;
}

// --- Errors shared with the routes ---------------------------------------------------------------------------------

/** One error for an unknown id, an expired id and another workspace's id, so an id reveals nothing. */
export const folderPickNotFound = () => new IdentityError('FOLDER_PICK_NOT_FOUND', 'That folder window is no longer available. Choose the folder again, or type its path.', 404);
const folderPickBusy = () => new IdentityError('FOLDER_PICK_BUSY', 'A folder window is already open on this computer. Finish or close it, then try again.', 409);

// --- The helper process, as the state machine sees it --------------------------------------------------------------

export interface FolderHelperEvents {
  /** A chunk of the helper's standard output. Raw bytes: line splitting and validation belong to the picker. */
  onOutput(chunk: Buffer | string): void;
  /** The helper is gone (exited, failed to start, or was killed). Called at most once, after all output. `code` is
   * its exit code when it had one; 3 means the session has no interactive desktop. */
  onExit(code?: number | null): void;
}

export interface FolderHelperHandle {
  /** End the helper and its whole process tree. Best effort, safe to call more than once or after it exited. */
  kill(): void;
  /** Settles once the helper has exited and its private folder is removed. Never rejects. */
  readonly done?: Promise<void>;
}

export interface FolderHelperRequest {
  /** The helper's own limit for how long its window may stay open. */
  windowMs: number;
}

/** Starts one helper. May throw when it cannot start; the picker then reports `helper-failed`. */
export type FolderHelperLauncher = (request: FolderHelperRequest, events: FolderHelperEvents) => FolderHelperHandle;

export interface FolderPickerOptions {
  /** Starts the helper. Tests inject a fake; production uses createHelperLauncher(). */
  launcher?: FolderHelperLauncher;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  limits?: Partial<FolderPickLimits>;
  retainFinishedMs?: number;
  maxOutputBytes?: number;
  maxLineChars?: number;
}

export interface FolderPicker {
  /** Starts a window, or returns the one this workspace already has open (`alreadyOpen`). Throws FOLDER_PICK_BUSY for another workspace. */
  start(ownerKey: string): FolderPick;
  /**
   * Resolves once the helper has reported its window is really up, or as soon as the pick ends (for example no window
   * appeared within `handshakeMs`). It always settles: the handshake timer ends a pick that never reports in. The start
   * route awaits this, so a `waiting` answer means a window is genuinely open, never just "we asked for one".
   */
  whenOpened(ownerKey: string, id: string): Promise<FolderPick>;
  /** Reads a pick. Also counts as the page's heartbeat: no call for `idleKillMs` ends the helper. */
  status(ownerKey: string, id: string): FolderPick;
  /** Ends a pick that is still waiting; returns the pick unchanged when it already finished. */
  cancel(ownerKey: string, id: string): FolderPick;
  /** Ends any live helper and forgets every pick. Called on service shutdown. */
  close(): Promise<void>;
}

// --- Reading what the helper prints --------------------------------------------------------------------------------

/** Splits standard output into lines across chunk boundaries and enforces the caps. */
class HelperLineReader {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private bytes = 0;
  constructor(private readonly maxBytes: number, private readonly maxLineChars: number) {}

  /** The lines completed by this chunk, or null when a cap was exceeded (the helper is then failed). */
  push(chunk: Buffer | string): string[] | null {
    this.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (this.bytes > this.maxBytes) return null;
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const lines = this.pending.split('\n');
    this.pending = lines.pop()!;
    return lines.some(line => line.length > this.maxLineChars) || this.pending.length > this.maxLineChars ? null : lines;
  }

  /** The unterminated last line, if any. A helper that exits without a final newline still delivers its result. */
  finish(): string[] | null {
    const rest = this.pending + this.decoder.end();
    this.pending = '';
    if (rest.length > this.maxLineChars) return null;
    return rest ? [rest] : [];
  }
}

// Control characters and the invisible marks that can reorder or hide text in a field the person reviews.
const UNSAFE_PATH_CHARACTERS = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}\u{2066}-\u{2069}\u{feff}]/u;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/u;
const UNC_PATH = /^\\\\[^\\/]+[\\/]+[^\\/]/u;

/**
 * The helper's path is text for the person to review, so it must be plain and look like an absolute Windows path.
 * This deliberately does not canonicalise or resolve it: the add-folder routes do that and decide what is allowed.
 */
export function isAcceptableHelperPath(value: string, maxLength: number = FOLDER_PICK_LIMITS.pathMaxLength): boolean {
  return value.length > 0 && value.length <= maxLength && !UNSAFE_PATH_CHARACTERS.test(value) && (DRIVE_PATH.test(value) || UNC_PATH.test(value));
}

// --- The state machine ---------------------------------------------------------------------------------------------

type Timer = ReturnType<typeof setTimeout>;
interface Session {
  id: string;
  ownerKey: string;
  startedAt: number;
  state: FolderPickState;
  path?: string;
  reason?: FolderPickUnavailableReason;
  /** The helper has reported that its window is really up. */
  opened: boolean;
  /** Callers of whenOpened(), released once the window is up or the pick ends. */
  openWaiters?: Array<() => void>;
  reader: HelperLineReader;
  handle?: FolderHelperHandle;
  handshake?: Timer;
  window?: Timer;
  idle?: Timer;
  retain?: Timer;
}

const later = (ms: number, run: () => void): Timer => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; };

export function createFolderPicker(options: FolderPickerOptions = {}): FolderPicker {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const limits: FolderPickLimits = { ...FOLDER_PICK_LIMITS };
  for (const [key, value] of Object.entries(options.limits ?? {})) if (typeof value === 'number') limits[key as keyof FolderPickLimits] = value;
  const retainMs = options.retainFinishedMs ?? FOLDER_PICK_RETAIN_MS;
  const maxOutputBytes = options.maxOutputBytes ?? HELPER_OUTPUT_LIMITS.maxOutputBytes;
  const maxLineChars = options.maxLineChars ?? HELPER_OUTPUT_LIMITS.maxLineChars;
  const supported = platform === 'win32' && Boolean(env.SystemRoot ?? env.SYSTEMROOT);
  const launcher = options.launcher ?? createHelperLauncher({ env });
  const sessions = new Map<string, Session>();
  let live: Session | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const iso = (ms: number) => new Date(ms).toISOString();
  const view = (session: Session, alreadyOpen = false): FolderPick => ({
    id: session.id, state: session.state, startedAt: iso(session.startedAt), expiresAt: iso(session.startedAt + limits.windowMs),
    ...(session.state === 'selected' && session.path !== undefined ? { path: session.path } : {}),
    ...(session.state === 'unavailable' && session.reason ? { reason: session.reason } : {}),
    ...(alreadyOpen ? { alreadyOpen: true } : {}),
  });

  const clearTimers = (session: Session) => {
    for (const name of ['handshake', 'window', 'idle', 'retain'] as const) { clearTimeout(session[name]); session[name] = undefined; }
  };
  const drop = (session: Session) => { clearTimers(session); session.path = undefined; sessions.delete(session.id); };
  const settleOpen = (session: Session) => { const waiters = session.openWaiters; session.openWaiters = undefined; for (const release of waiters ?? []) release(); };

  /** The one place a pick leaves `waiting`. Later calls are ignored, so a late helper line can never change the outcome. */
  const end = (session: Session, state: Exclude<FolderPickState, 'waiting'>, detail: { path?: string; reason?: FolderPickUnavailableReason } = {}) => {
    if (session.state !== 'waiting') return;
    session.state = state;
    if (detail.path !== undefined) session.path = detail.path;
    if (detail.reason) session.reason = detail.reason;
    clearTimers(session);
    if (live === session) live = undefined;
    try { session.handle?.kill(); } catch { /* Best effort: the helper also stops itself when its own limit or the service's process ends. */ }
    if (!closed) session.retain = later(retainMs, () => drop(session));
    settleOpen(session);
  };
  const failHelper = (session: Session, code?: number | null) => end(session, 'unavailable', { reason: code === HELPER_NO_DESKTOP_EXIT ? 'no-desktop' : 'helper-failed' });

  const touch = (session: Session) => {
    if (session.state !== 'waiting') return;
    clearTimeout(session.idle);
    session.idle = later(limits.idleKillMs, () => end(session, 'cancelled'));
  };

  const handleLine = (session: Session, raw: string) => {
    const text = raw.replace(/^\u{feff}/u, '').replace(/\r$/u, '');
    if (!text.trim()) return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { return failHelper(session); }
    const line = folderPickHelperLineSchema.safeParse(value);
    if (!line.success) return failHelper(session);
    if (line.data.state === 'open') {
      if (session.opened) return failHelper(session);
      session.opened = true;
      clearTimeout(session.handshake); session.handshake = undefined;
      settleOpen(session);
      return;
    }
    // A result before the window reported it was up is a broken helper, not a choice the person made.
    if (!session.opened) return failHelper(session);
    if (line.data.state === 'cancelled') return end(session, 'cancelled');
    if (!isAcceptableHelperPath(line.data.path, limits.pathMaxLength)) return failHelper(session);
    end(session, 'selected', { path: line.data.path });
  };
  const receive = (session: Session, lines: string[] | null) => {
    if (!lines) return failHelper(session);
    for (const line of lines) { if (session.state !== 'waiting') return; handleLine(session, line); }
  };
  /** An unexpected failure while handling helper output must not become an uncaught exception in the service. */
  const guarded = (session: Session, run: () => void) => { try { run(); } catch { failHelper(session); } };

  const lookup = (ownerKey: string, id: string): Session => {
    const session = sessions.get(id);
    if (!session || session.ownerKey !== ownerKey) throw folderPickNotFound();
    return session;
  };

  const start = (ownerKey: string): FolderPick => {
    if (closed) throw new IdentityError('SHUTTING_DOWN', 'The service is shutting down.', 503);
    if (live) {
      if (live.ownerKey !== ownerKey) throw folderPickBusy();
      touch(live);
      return view(live, true);
    }
    const finished = [...sessions.values()].filter(session => session.state !== 'waiting');
    for (const old of finished.slice(0, Math.max(0, finished.length - (MAX_FINISHED_PICKS - 1)))) drop(old);

    const session: Session = { id: randomUUID(), ownerKey, startedAt: now(), state: 'waiting', opened: false, reader: new HelperLineReader(maxOutputBytes, maxLineChars) };
    sessions.set(session.id, session);
    if (!supported) {
      // No helper is started, and nothing else has to wait for this pick.
      session.state = 'unavailable'; session.reason = 'unsupported-platform';
      session.retain = later(retainMs, () => drop(session));
      return view(session);
    }
    live = session;
    session.handshake = later(limits.handshakeMs, () => end(session, 'unavailable', { reason: 'no-desktop' }));
    session.window = later(limits.windowMs, () => end(session, 'timed-out'));
    touch(session);
    try {
      session.handle = launcher({ windowMs: limits.windowMs }, {
        onOutput: chunk => { if (session.state === 'waiting') guarded(session, () => receive(session, session.reader.push(chunk))); },
        onExit: code => {
          if (session.state !== 'waiting') return;
          // A helper that exits after printing its result, with no final newline, still delivers that result.
          guarded(session, () => receive(session, session.reader.finish()));
          failHelper(session, code);
        },
      });
    } catch { failHelper(session); }
    // The helper may have finished (or failed) before the launcher returned its handle.
    if (session.state !== 'waiting') { try { session.handle?.kill(); } catch { /* Best effort. */ } }
    return view(session);
  };

  const whenOpened = (ownerKey: string, id: string): Promise<FolderPick> => {
    const session = lookup(ownerKey, id);
    if (session.opened || session.state !== 'waiting') return Promise.resolve(view(session));
    return new Promise<FolderPick>(resolve => { (session.openWaiters ??= []).push(() => resolve(view(session))); });
  };

  const status = (ownerKey: string, id: string): FolderPick => {
    const session = lookup(ownerKey, id);
    touch(session);
    return view(session);
  };

  const cancel = (ownerKey: string, id: string): FolderPick => {
    const session = lookup(ownerKey, id);
    end(session, 'cancelled');
    return view(session);
  };

  const close = (): Promise<void> => {
    closed = true;
    closing ??= (async () => {
      // Every helper, not only the ones still waiting: one that was just cancelled is still going away, and its private
      // folder is only removed once it has (a helper that finished long ago has an already-settled `done`).
      const settling = [...sessions.values()].filter(session => session.handle?.done).map(session => session.handle!.done!);
      for (const session of [...sessions.values()]) { end(session, 'cancelled'); drop(session); }
      live = undefined;
      if (!settling.length) return;
      let timer: Timer | undefined;
      await Promise.race([Promise.allSettled(settling), new Promise<void>(release => { timer = later(CLOSE_WAIT_MS, release); })]);
      clearTimeout(timer);
    })();
    return closing;
  };

  return { start, whenOpened, status, cancel, close };
}

// --- The real helper: Windows PowerShell 5.1 ------------------------------------------------------------------------

export interface HelperLauncherOptions {
  /** Injected in tests. Defaults to child_process.spawn. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  env?: NodeJS.ProcessEnv;
  parentPid?: number;
  script?: string;
  tempRoot?: string;
  makeTempDir?: (prefix: string) => string;
  removeDir?: (path: string) => Promise<void>;
  /** Injected in tests. Defaults to sweepStaleHelperFolders, run once on the first launch. */
  sweep?: (tempRoot: string) => Promise<unknown>;
}

const noop = () => undefined;

/**
 * Starts the folder window helper: the built-in Windows PowerShell 5.1 by its absolute path (no PATH lookup), hidden
 * console, a minimal environment, and a private per-run temporary folder that is removed after the helper exits.
 * Standard error is drained and discarded, so a native diagnostic (which can contain a folder name) is never exposed.
 * Used only when no launcher is injected; tests use a fake and never open a window.
 */
export function createHelperLauncher(options: HelperLauncherOptions = {}): FolderHelperLauncher {
  const spawn = options.spawn ?? nodeSpawn;
  const env = options.env ?? process.env;
  const script = options.script ?? FOLDER_PICKER_SCRIPT;
  const tempRoot = options.tempRoot ?? tmpdir();
  const makeTempDir = options.makeTempDir ?? mkdtempSync;
  const removeDir = options.removeDir ?? ((path: string) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  let swept = false;
  return (request, events) => {
    // Once per service run, off the critical path: clear folders an earlier, force-killed service could not remove.
    if (!swept) { swept = true; void (options.sweep ?? sweepStaleHelperFolders)(tempRoot).catch(noop); }
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('The Windows folder is not available.');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    if (encoded.length > MAX_ENCODED_COMMAND_CHARS) throw new Error('The folder helper is too large to start.');

    const directory = makeTempDir(join(tempRoot, TEMP_PREFIX));
    let resolveDone: () => void = noop;
    const done = new Promise<void>(release => { resolveDone = release; });
    const cleanup = () => {
      // Recursive delete: only ever a folder this launcher made, directly under the temporary root.
      const target = resolve(directory);
      if (!target.startsWith(resolve(tempRoot) + sep) || !basename(target).startsWith(TEMP_PREFIX)) return resolveDone();
      void removeDir(target).catch(noop).finally(resolveDone);
    };

    let child: ChildProcess;
    try {
      child = spawn(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
        {
          // Not the service's own folder (the repository agents write to): the helper's private one.
          cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            SystemRoot: systemRoot, WINDIR: env.WINDIR ?? systemRoot,
            ...(env.LOCALAPPDATA ? { LOCALAPPDATA: env.LOCALAPPDATA } : {}),
            TEMP: directory, TMP: directory,
            AGENT_TOWN_PARENT_PID: String(options.parentPid ?? process.pid),
            AGENT_TOWN_WINDOW_MS: String(request.windowMs),
          },
        });
    } catch (error) { cleanup(); throw error; }

    let exited = false, killed = false, finished = false;
    child.stdout?.on('data', (chunk: Buffer | string) => events.onOutput(chunk));
    child.stdout?.on('error', noop);
    child.stderr?.on('data', noop);
    child.stderr?.on('error', noop);
    const finish = (code?: number | null) => {
      if (finished) return;
      finished = true; exited = true;
      events.onExit(code);
      cleanup();
    };
    child.on('exit', () => { exited = true; });
    // 'close' comes after the output streams end, so a result printed just before exit is read first.
    child.on('close', code => finish(code));
    // Only a failure to start ends the helper here; "could not be killed" errors must not pretend it is gone.
    child.on('error', () => { if (child.pid === undefined) finish(); });

    const kill = () => {
      if (killed || exited || (child.exitCode !== null && child.exitCode !== undefined)) return;
      killed = true;
      const direct = () => { try { child.kill(); } catch { /* Already gone. */ } };
      const pid = child.pid;
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return direct();
      try {
        // End the whole tree by absolute path and numeric pid; fall back to the direct kill if taskkill cannot.
        const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { cwd: join(systemRoot, 'System32'), windowsHide: true, stdio: 'ignore' });
        killer.on('error', direct);
        killer.on('exit', code => { if (code !== 0) direct(); });
      } catch { direct(); }
    };
    return { kill, done };
  };
}
