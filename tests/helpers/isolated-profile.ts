/**
 * isolatedProfile(): gives a test a private, empty "user profile" and refuses every access to the real one.
 *
 * It points HOME, USERPROFILE, APPDATA, LOCALAPPDATA, CODEX_HOME, CLAUDE_CONFIG_DIR, CURSOR_CONFIG_DIR, COPILOT_HOME and
 * XDG_CONFIG_HOME at a fresh temp folder (so os.homedir(), the tool-profile defaults and the default data and credential
 * folders all resolve inside it), clears AGENT_TOWN_DATA_DIR and AGENT_TOWN_VAULT_DIR, and installs a file-system guard: a
 * path-taking node:fs call on the REAL home's tool folders (.codex, .claude, .claude.json, .cursor, .copilot), the real editor
 * profiles under AppData (Code/User, Cursor, Claude), Agent Town's real data folder and its real credential vault is recorded
 * and refused, so a test that reaches past the isolated profile fails instead of reading or writing the owner's real files.
 * The refusal happens before the file system is touched.
 *
 * Covered, in the callback and sync forms and in fs.promises: access, appendFile, chmod, chown, copyFile, cp, exists, glob,
 * link, lchmod, lchown, lstat, lutimes, mkdir, mkdtemp, mkdtempDisposable, open, openAsBlob, opendir, readdir, readFile,
 * readlink, realpath (and realpath.native), rename, rm, rmdir, stat, statfs, symlink, truncate, unlink, utimes, watch,
 * watchFile, writeFile, createReadStream and createWriteStream. Paths may be strings, Buffers or file: URLs, in any spelling
 * (forward slashes, upper case, \\?\ prefix, dot-dot, relative to the current folder). For the two-path calls (copyFile, cp,
 * link, rename, symlink) either end counts. A glob is refused when its search root, or the literal start of its pattern, is
 * inside a real folder, or when it starts above one and can reach it (a ** or a pattern with enough parts).
 *
 * NOT covered: calls on a descriptor or handle that is already open (fs.read, write, fstat, fchmod, fchown, fsync, futimes,
 * ftruncate and their promise forms; the open() that produced it is guarded, so a real file cannot be opened in the first
 * place), fs.unwatchFile, loading code with require() or import (Node's module loader reads files below the patched
 * functions), process.binding and other internal bindings, and anything native code opens on its own: better-sqlite3 opens
 * its database file natively and is only stopped by the fs.existsSync call its JavaScript wrapper makes first.
 *
 * restore() puts every variable back, removes the guard and deletes the temp folder, and throws if a refused access was
 * never acknowledged with take() (code may swallow the refusal, so the record is what counts). Only one profile can be
 * active at a time.
 *
 * Limits are the ones in ./index.ts: the guard covers this test process's node:fs, not worker threads, child processes
 * (a launched tool reads its own profile through its own environment) or the e2e service.
 */
import fs from 'node:fs'; // the mutable CommonJS export object; a namespace import (import * as) is frozen and cannot be patched
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export interface RealProfileAccess { operation: string; path: string }

export class RealProfileAccessError extends Error {
  readonly operation: string;
  readonly path: string;
  constructor(access: RealProfileAccess) {
    super(`isolatedProfile() refused ${access.operation} on ${access.path}: it is inside the real user profile or Agent Town's real data. Use the isolated profile's own folders instead.`);
    this.name = 'RealProfileAccessError';
    this.operation = access.operation; this.path = access.path;
  }
}

export interface IsolatedProfile {
  readonly root: string;
  readonly home: string;
  readonly appData: string;
  readonly localAppData: string;
  readonly codexHome: string;
  readonly claudeConfigDir: string;
  readonly cursorConfigDir: string;
  readonly copilotHome: string;
  /** The real folders and files this profile refuses to touch. */
  readonly realFolders: readonly string[];
  /** Refused accesses not yet acknowledged with take(). */
  readonly blockedAccesses: readonly RealProfileAccess[];
  /** Returns the refused accesses and clears them: the way a test says "this refusal was expected". */
  take(): RealProfileAccess[];
  expectNoRealAccess(): void;
  restore(): void;
}

export interface IsolatedProfileOptions {
  /** Treat these as the real profile instead of the machine's (self-tests use this so they never touch the owner's real folders). */
  real?: { home: string; appData?: string; localAppData?: string; extra?: readonly string[] };
}

const ENVIRONMENT = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'COPILOT_HOME', 'XDG_CONFIG_HOME'] as const;
const CLEARED = ['AGENT_TOWN_DATA_DIR', 'AGENT_TOWN_VAULT_DIR'] as const;

// Captured once per process, before any profile is active, so later calls never mistake an isolated folder for the real one.
const REAL = Symbol.for('agent-town.tests.realProfile');
const ACTIVE = Symbol.for('agent-town.tests.isolatedProfile.active');
interface RealCapture { home: string; appData: string; localAppData: string; extra: string[] }
function machineProfile(): RealCapture {
  const holder = globalThis as unknown as Record<symbol, RealCapture | undefined>;
  if (holder[REAL]) return holder[REAL];
  const home = homedir();
  const extra = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'COPILOT_HOME', 'AGENT_TOWN_DATA_DIR', 'AGENT_TOWN_VAULT_DIR']
    .map(name => process.env[name]).filter((value): value is string => !!value && isAbsolute(value));
  return (holder[REAL] = { home, appData: process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), localAppData: process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), extra });
}
machineProfile();

function realFoldersOf(real: RealCapture): string[] {
  return [
    join(real.home, '.codex'), join(real.home, '.claude'), join(real.home, '.claude.json'), join(real.home, '.cursor'), join(real.home, '.copilot'),
    join(real.home, '.config', 'Code', 'User'),
    join(real.appData, 'Code', 'User'), join(real.appData, 'Cursor'), join(real.appData, 'Claude'),
    join(real.localAppData, 'AgentTown'), join(real.localAppData, 'AgentTownCredentials'),
    ...real.extra,
  ].map(path => resolve(path));
}

const stripExtendedPrefix = (path: string) => path.replace(/^\\\\\?\\(?=[A-Za-z]:)/, '');
function inside(root: string, candidate: string): boolean {
  const step = relative(root, candidate);
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
}
function pathOf(value: unknown): string | null {
  try {
    if (typeof value === 'string') return stripExtendedPrefix(resolve(value));
    if (Buffer.isBuffer(value)) return stripExtendedPrefix(resolve(value.toString()));
    if (value instanceof URL && value.protocol === 'file:') return stripExtendedPrefix(resolve(fileURLToPath(value)));
  } catch { /* not a usable path: leave it to fs to reject */ }
  return null;
}

type AnyFunction = (...args: unknown[]) => unknown;
const TWO_PATHS = new Set(['copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync', 'link', 'linkSync', 'symlink', 'symlinkSync']);
// Every path-taking function of node:fs (checked against the installed Node's own list of exports; the ones taking a descriptor are in the header). A name this Node does not have (lchmod outside macOS) is skipped.
const CALLBACK_AND_SYNC = ['access', 'accessSync', 'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'createReadStream', 'createWriteStream',
  'exists', 'existsSync', 'glob', 'globSync', 'lchmod', 'lchmodSync', 'lchown', 'lchownSync', 'link', 'linkSync', 'lstat', 'lstatSync', 'lutimes', 'lutimesSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
  'mkdtempDisposableSync', 'open', 'openSync', 'opendir', 'opendirSync', 'readdir', 'readdirSync', 'readFile', 'readFileSync', 'readlink', 'readlinkSync', 'realpath', 'realpathSync', 'rename', 'renameSync',
  'rm', 'rmSync', 'rmdir', 'rmdirSync', 'stat', 'statSync', 'statfs', 'statfsSync', 'symlink', 'symlinkSync', 'truncate', 'truncateSync', 'unlink', 'unlinkSync', 'utimes', 'utimesSync', 'watch', 'watchFile',
  'writeFile', 'writeFileSync'];
const PROMISES = ['access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'glob', 'lchmod', 'lchown', 'link', 'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'mkdtempDisposable', 'open', 'opendir', 'readdir', 'readFile',
  'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs', 'symlink', 'truncate', 'unlink', 'utimes', 'watch', 'writeFile'];
// fs.openAsBlob lives on fs but returns a promise.
const PROMISE_RETURNING_ON_FS = ['openAsBlob'];
// fs.promises.glob and fs.promises.watch return async iterators, so a refusal must arrive as an iterator that throws when it is read, not as a rejected promise.
const ITERATORS = new Set(['glob', 'watch']);
/**
 * The function exports of node:fs and node:fs/promises that the guard deliberately does NOT wrap, with the reason (the same list
 * as the header's "NOT covered"). Every other function export is in the wrapped lists above. tests/unit/test-helpers.test.ts
 * compares both lists with what the installed Node really exports, so a Node that adds a path-taking call fails that test until
 * someone wraps it or writes it down here.
 */
export const UNGUARDED_FS_EXPORTS: Readonly<Record<'fs' | 'promises', readonly string[]>> = {
  fs: [
    // take an already-open descriptor, so the open() that produced it is where the guard stops a real file
    'close', 'closeSync', 'fchmod', 'fchmodSync', 'fchown', 'fchownSync', 'fdatasync', 'fdatasyncSync', 'fstat', 'fstatSync', 'fsync', 'fsyncSync', 'ftruncate', 'ftruncateSync',
    'futimes', 'futimesSync', 'read', 'readSync', 'readv', 'readvSync', 'write', 'writeSync', 'writev', 'writevSync',
    // stops a watcher that watchFile (wrapped) started
    'unwatchFile',
    // classes and helpers, not calls: the streams and Utf8Stream open their file through the wrapped fs.open/openSync (checked with Utf8Stream on Node 24.19)
    'Dir', 'Dirent', 'Stats', 'ReadStream', 'WriteStream', 'FileReadStream', 'FileWriteStream', 'Utf8Stream', '_toUnixTimestamp',
  ],
  promises: [],
};
/** The wrapped names, per module (fs.openAsBlob is on fs but returns a promise). Names this Node lacks, such as lchmod outside macOS, are skipped when patching. */
export const GUARDED_FS_EXPORTS: Readonly<Record<'fs' | 'promises', readonly string[]>> = { fs: [...CALLBACK_AND_SYNC, ...PROMISE_RETURNING_ON_FS], promises: PROMISES };

// A pattern part with these is a glob, not a folder name (a plain ( or ! in a path, as in "Program Files (x86)", is not).
const GLOB_SYNTAX = /[*?[\]{}]|[?*+@!]\(/;
// fs.exists(path, callback) reports through a boolean, so a refusal there is thrown like existsSync's.
const REFUSE_BY_THROWING = new Set(['exists', 'watch', 'watchFile', 'createReadStream', 'createWriteStream']);

class Profile implements IsolatedProfile {
  readonly blocked: RealProfileAccess[] = [];
  private restored = false;
  private readonly previous = new Map<string, string | undefined>();
  private readonly patched: { target: Record<string, unknown>; name: string; original: unknown }[] = [];
  readonly root: string; readonly home: string; readonly appData: string; readonly localAppData: string;
  readonly codexHome: string; readonly claudeConfigDir: string; readonly cursorConfigDir: string; readonly copilotHome: string;
  readonly realFolders: readonly string[];

  constructor(options: IsolatedProfileOptions) {
    const real = options.real ? { home: options.real.home, appData: options.real.appData ?? join(options.real.home, 'AppData', 'Roaming'),
      localAppData: options.real.localAppData ?? join(options.real.home, 'AppData', 'Local'), extra: [...(options.real.extra ?? [])] } : machineProfile();
    this.realFolders = realFoldersOf(real);
    this.root = fs.mkdtempSync(join(tmpdir(), 'agent-town-profile-'));
    this.home = join(this.root, 'home');
    this.appData = join(this.root, 'AppData', 'Roaming');
    this.localAppData = join(this.root, 'AppData', 'Local');
    this.codexHome = join(this.home, '.codex'); this.claudeConfigDir = join(this.home, '.claude');
    this.cursorConfigDir = join(this.home, '.cursor'); this.copilotHome = join(this.home, '.copilot');
    for (const folder of [this.home, this.appData, this.localAppData]) fs.mkdirSync(folder, { recursive: true });
    const values: Record<(typeof ENVIRONMENT)[number], string> = { HOME: this.home, USERPROFILE: this.home, APPDATA: this.appData, LOCALAPPDATA: this.localAppData,
      CODEX_HOME: this.codexHome, CLAUDE_CONFIG_DIR: this.claudeConfigDir, CURSOR_CONFIG_DIR: this.cursorConfigDir, COPILOT_HOME: this.copilotHome, XDG_CONFIG_HOME: join(this.home, '.config') };
    for (const name of [...ENVIRONMENT, ...CLEARED]) this.previous.set(name, process.env[name]);
    for (const name of ENVIRONMENT) process.env[name] = values[name];
    for (const name of CLEARED) delete process.env[name];
    try { this.installFileGuard(); } catch (error) {
      // A half-installed profile must not outlive its failure: nobody holds a handle to call restore() on, so the variables, the patches and the temp folder are put back here.
      try { this.restore(); } catch { /* the failure to install is the error that matters */ }
      throw error;
    }
  }

  get blockedAccesses(): readonly RealProfileAccess[] { return [...this.blocked]; }
  take(): RealProfileAccess[] { return this.blocked.splice(0); }
  expectNoRealAccess(): void {
    if (this.blocked.length) throw new Error(`Expected no access to the real profile, but ${this.blocked.length} were refused: ${this.blocked.map(item => `${item.operation} ${item.path}`).join('; ')}`);
  }

  /** glob(pattern | patterns, options?, callback?): the search root is options.cwd (or the current folder) plus the literal start of each pattern. */
  private refuseGlob(operation: string, args: readonly unknown[]): RealProfileAccess | null {
    const options = args[1] !== null && typeof args[1] === 'object' ? args[1] as { cwd?: unknown } : {};
    const cwd = pathOf(options.cwd) ?? stripExtendedPrefix(resolve());
    for (const pattern of (Array.isArray(args[0]) ? args[0] : [args[0]]).filter((item): item is string => typeof item === 'string')) {
      const parts = pattern.split(/[\\/]/), firstGlob = parts.findIndex(part => GLOB_SYNTAX.test(part));
      const fixed = firstGlob < 0 ? parts : parts.slice(0, firstGlob), rest = firstGlob < 0 ? [] : parts.slice(firstGlob);
      const root = fixed.length ? stripExtendedPrefix(resolve(cwd, fixed.join('/') || '/')) : cwd;
      for (const folder of this.realFolders) {
        if (inside(folder, root)) return { operation, path: root };
        // A search that starts above a real folder walks into it with any ** or with more pattern parts than the folder is deep.
        if (inside(root, folder) && (rest.some(part => part.includes('**')) || rest.length > relative(root, folder).split(sep).length)) return { operation, path: root };
      }
    }
    return null;
  }

  private refuse(operation: string, args: readonly unknown[]): RealProfileAccess | null {
    if (operation === 'glob' || operation === 'globSync') return this.refuseGlob(operation, args);
    const checked = TWO_PATHS.has(operation) ? [args[0], args[1]] : [args[0]];
    for (const value of checked) {
      const path = pathOf(value);
      if (path && this.realFolders.some(folder => inside(folder, path))) return { operation, path };
    }
    return null;
  }

  private installFileGuard(): void {
    const wrap = (name: string, original: AnyFunction, promise: boolean, hooks = true): AnyFunction => {
      const profile = this;
      const guarded = function guardedFs(this: unknown, ...args: unknown[]) {
        const access = profile.refuse(name, args);
        if (!access) return original.apply(this, args);
        profile.blocked.push(access);
        const error = new RealProfileAccessError(access);
        if (promise) return ITERATORS.has(name) ? (async function* refusedIterator(): AsyncGenerator<never> { throw error; })() : Promise.reject(error);
        const callback = args.at(-1);
        if (typeof callback === 'function' && !name.endsWith('Sync') && !REFUSE_BY_THROWING.has(name)) {
          process.nextTick(callback as AnyFunction, error);
          return undefined;
        }
        throw error;
      };
      const native = (original as unknown as { native?: AnyFunction }).native;
      if (typeof native === 'function') (guarded as unknown as { native: AnyFunction }).native = wrap(name, native, promise, false);
      // util.promisify(fs.exists) resolves a boolean through a custom hook (its callback has no error argument); without it the wrapper would be promisified the ordinary way.
      // (The hook points at itself, so the copy is not wrapped again.)
      const custom = hooks ? (original as unknown as Record<symbol, AnyFunction | undefined>)[promisify.custom] : undefined;
      if (typeof custom === 'function') Object.defineProperty(guarded, promisify.custom, { value: wrap(name, custom, true, false), configurable: true });
      return guarded;
    };
    const patch = (target: Record<string, unknown>, names: readonly string[], promise: boolean) => {
      for (const name of names) {
        const original = target[name];
        if (typeof original !== 'function') continue;
        this.patched.push({ target, name, original });
        target[name] = wrap(name, original as AnyFunction, promise);
      }
    };
    patch(fs as unknown as Record<string, unknown>, CALLBACK_AND_SYNC, false);
    patch(fs as unknown as Record<string, unknown>, PROMISE_RETURNING_ON_FS, true);
    patch(fs.promises as unknown as Record<string, unknown>, PROMISES, true);
    syncBuiltinESMExports();
  }

  restore(): void {
    if (this.restored) return;
    this.restored = true;
    // Undo every patch that can be undone even if one cannot, so the variables and the temp folder below are always put right; the first failure is thrown at the end.
    let failure: unknown;
    for (const { target, name, original } of this.patched.reverse()) { try { target[name] = original; } catch (error) { failure ??= error; } }
    try { syncBuiltinESMExports(); } catch (error) { failure ??= error; }
    for (const [name, value] of this.previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    (globalThis as unknown as Record<symbol, unknown>)[ACTIVE] = undefined;
    if (fs.existsSync(this.root)) {
      const tempBase = fs.realpathSync(tmpdir()), target = fs.realpathSync(this.root);
      if (!basename(target).startsWith('agent-town-profile-') || !inside(tempBase, target) || target === tempBase) throw new Error(`Refusing to delete ${target}: it is not an isolatedProfile() folder.`);
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    if (failure) throw failure;
    if (this.blocked.length) throw new Error(`A test reached the real user profile through isolatedProfile()'s guard and nobody acknowledged it: ${this.blocked.map(item => `${item.operation} ${item.path}`).join('; ')}. Call take() if the refusal was expected.`);
  }
}

export function isolatedProfile(options: IsolatedProfileOptions = {}): IsolatedProfile {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  if (holder[ACTIVE]) throw new Error('isolatedProfile() is already active in this test file. Call restore() on the first one before creating another.');
  const profile = new Profile(options);
  holder[ACTIVE] = profile;
  return profile;
}
