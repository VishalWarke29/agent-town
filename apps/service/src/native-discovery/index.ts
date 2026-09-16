import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolSurface } from '@agent-town/contracts';
import { checkedPath } from '../discovery/paths.js';
import { normalizeObservationPath, sameObservationPath } from '../observation/paths.js';
import { safeSessionTitle } from '../observation/normalize.js';

export interface DiscoveredNativeSession {
  nativeSessionId: string;
  title?: string;
  nativeAgentName?: string;
  parentNativeSessionId?: string;
  projectPath: string;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface NativeDiscoveryResult {
  sessions: DiscoveredNativeSession[];
  nextCursor: string | null;
  status: 'available' | 'unavailable' | 'unsupported';
  message: string | null;
}
export interface NativeDiscoveryInput {
  provider: ToolSurface;
  homePath: string;
  repoPath: string;
  includeOlder?: boolean;
  cursor?: string;
  signal?: AbortSignal;
}
const PAGE_SIZE = 25, MAX_OFFSET = 5000;
const unavailable = (message: string): NativeDiscoveryResult => ({ sessions: [], nextCursor: null, status: 'unavailable', message });
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
function paging(input: NativeDiscoveryInput) {
  const scope = createHash('sha256').update(JSON.stringify([input.provider, input.homePath, input.repoPath, !!input.includeOlder])).digest('hex');
  let offset = 0, cutoff = input.includeOlder ? 0 : Date.now() - 30 * 86400000;
  if (input.cursor) {
    if (input.cursor.length > 512) throw new Error('Invalid cursor');
    const parsed = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { scope?: unknown; offset?: unknown; cutoff?: unknown };
    if (parsed.scope !== scope || typeof parsed.offset !== 'number' || !Number.isInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > MAX_OFFSET
      || typeof parsed.cutoff !== 'number' || !Number.isSafeInteger(parsed.cutoff) || parsed.cutoff < 0 || parsed.cutoff > Date.now()) throw new Error('Invalid cursor');
    offset = parsed.offset; cutoff = parsed.cutoff;
  }
  return { offset, cutoff, next: (count: number) => count > PAGE_SIZE && offset + PAGE_SIZE < MAX_OFFSET
    ? Buffer.from(JSON.stringify({ scope, offset: offset + PAGE_SIZE, cutoff })).toString('base64url') : null };
}
async function safeDirectory(value: string) {
  const normalized = normalizeObservationPath(value);
  if (!normalized) throw new Error('Invalid path');
  const path = await checkedPath(normalized, [normalized]);
  if (!(await lstat(path)).isDirectory()) throw new Error('Invalid directory');
  return realpath(path);
}

async function sdkMetadata(input: NativeDiscoveryInput, homePath: string, repoPath: string, offset: number, cutoff: number): Promise<NativeDiscoveryResult> {
  // This helper is copied next to the built service. Development reads the source helper.
  const worker = fileURLToPath(new URL('./metadata-worker.mjs', import.meta.url));
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--max-old-space-size=192', worker], { windowsHide: true, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
        USERPROFILE: process.env.USERPROFILE, HOME: process.env.USERPROFILE ?? process.env.HOME, PATH: process.env.PATH,
        CLAUDE_CONFIG_DIR: homePath, CURSOR_CONFIG_DIR: homePath, COPILOT_HOME: homePath, NODE_NO_WARNINGS: '1' } });
    let output = '', settled = false;
    const finish = (result: NativeDiscoveryResult) => {
      if (settled) return; settled = true; clearTimeout(timer); input.signal?.removeEventListener('abort', abort);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') {
          // Terminate only this task-owned helper and its native runtime descendants.
          execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => resolve(result));
          return;
        }
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
      }
      resolve(result);
    };
    const abort = () => finish(unavailable('Native session discovery was cancelled.'));
    const timer = setTimeout(() => finish(unavailable('Native session discovery did not finish within its time limit.')), 10000);
    child.stdout.setEncoding('utf8'); child.stderr.resume();
    child.stdout.on('data', (chunk: string) => { output += chunk; if (Buffer.byteLength(output) > 128 * 1024) finish(unavailable('The native metadata response exceeded its limit.')); });
    child.on('error', () => finish(unavailable('The native metadata helper could not start.')));
    child.stdin.on('error', () => finish(unavailable('The native metadata helper stopped.')));
    child.on('close', code => {
      if (settled) return;
      try {
        const result = JSON.parse(output) as NativeDiscoveryResult;
        if (code !== 0 || !['available', 'unavailable', 'unsupported'].includes(result.status) || !Array.isArray(result.sessions) || result.sessions.length > PAGE_SIZE + 1) throw new Error();
        // Reconstruct only allowed fields; an SDK can never send extra text into saved discovery results.
        const sessions = result.sessions.map(value => {
          if (!identifier(value.nativeSessionId) || !sameObservationPath(value.projectPath, repoPath)) throw new Error();
          const normalizeDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
          const indexedTitle = input.provider === 'codex' && 'indexedTitle' in value ? safeSessionTitle(value.indexedTitle) : undefined;
          const title = indexedTitle ?? safeSessionTitle(value.title);
          const nativeAgentName = input.provider === 'codex' ? safeSessionTitle(value.nativeAgentName) : undefined;
          return { nativeSessionId: value.nativeSessionId, projectPath: repoPath, createdAt: normalizeDate(value.createdAt), updatedAt: normalizeDate(value.updatedAt),
            ...(title ? { title } : {}),
            ...(nativeAgentName ? { nativeAgentName } : {}),
            ...(identifier(value.parentNativeSessionId) ? { parentNativeSessionId: value.parentNativeSessionId } : {}) };
        });
        const message = input.provider === 'cursor'
          ? 'Select an existing Cursor SDK JSONL store. Cursor editor history and SQLite SDK stores do not have a verified read-only discovery path here; native hooks can track future activity.'
          : input.provider === 'codex' ? 'The Codex metadata database is unavailable or its schema is not supported.'
            : 'The installed native tool does not expose compatible local metadata for this source.';
        finish({ sessions, nextCursor: null, status: result.status, message: result.status === 'available' ? null : message });
      } catch { finish(unavailable('The native metadata helper returned an unsupported response.')); }
    });
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    else child.stdin.end(JSON.stringify({ provider: input.provider, homePath, repoPath, offset, cutoff, limit: PAGE_SIZE + 1 }));
  });
}

export async function discoverNativeSessions(input: NativeDiscoveryInput): Promise<NativeDiscoveryResult> {
  if (input.signal?.aborted) return unavailable('Native session discovery was cancelled.');
  if (!['codex', 'claude', 'cursor', 'copilot-cli'].includes(input.provider)) return { sessions: [], nextCursor: null, status: 'unsupported', message: 'This tool has no verified local history interface. Connect its supported observation events instead.' };
  try {
    const page = paging(input);
    const homePath = await safeDirectory(input.homePath), repoPath = await safeDirectory(input.repoPath);
    if (input.provider === 'codex') {
      const path = await checkedPath(join(homePath, 'state_5.sqlite'), [homePath]);
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.size > 256 * 1024 * 1024) return unavailable('The Codex metadata database is unavailable or exceeds the supported bound.');
      for (const suffix of ['-wal', '-shm']) {
        try { const sidecar = await checkedPath(`${path}${suffix}`, [homePath]); const metadata = await lstat(sidecar); if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 64 * 1024 * 1024) throw new Error(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    const result = await sdkMetadata(input, homePath, repoPath, page.offset, page.cutoff);
    if (input.signal?.aborted) return unavailable('Native session discovery was cancelled.');
    return { ...result, nextCursor: result.status === 'available' ? page.next(result.sessions.length) : null,
      message: result.sessions.length > PAGE_SIZE && page.offset + PAGE_SIZE >= MAX_OFFSET ? 'This source exceeds the 5,000-session discovery bound. Narrow or review its native history before scanning again.' : result.message,
      sessions: result.sessions.slice(0, PAGE_SIZE) };
  } catch { return unavailable('Native metadata is unavailable, its schema is unsupported, or the selected source path needs review.'); }
}
