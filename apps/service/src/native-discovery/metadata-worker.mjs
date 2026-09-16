// Isolated, short-lived SDK metadata extraction. Only the explicitly requested
// native title/name field joins identity metadata; prompts and summaries stay excluded.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = process.stdout.write.bind(process.stdout);
for (const name of ['log', 'warn', 'error', 'info', 'debug']) console[name] = () => {};
process.stdout.write = () => true;
process.stderr.write = () => true;
let refusedOperation = false;
const fail = () => { refusedOperation = true; throw new Error('Metadata-only operation refused'); };
const originalSpawn = childProcess.spawn;
let runtimeChild;
let input = '';
for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 16384) process.exit(1); }
const request = JSON.parse(input);
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
function normalized(value) {
  if (typeof value !== 'string' || /[\x00-\x1f]/.test(value)) return null;
  if (/^\\\\\?\\[a-z]:[\\/]/i.test(value)) value = value.slice(4);
  if (/^[\\/]{2}/.test(value) || !isAbsolute(value)) return null;
  if (/^[a-z]:/i.test(value) && value.slice(2).includes(':')) return null;
  if (value.split(/[\\/]/).some(part => part === '.' || part === '..' || /[. ]$/.test(part))) return null;
  return resolve(value);
}
const same = value => { const path = normalized(value); return path !== null && pathKey(path) === pathKey(request.repoPath); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
// Bound title transfer before the parent process sanitizes it for persistence.
const named = value => typeof value === 'string' && value.trim() ? { title: value.slice(0, 512) } : {};
const date = value => {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === 'string') value = Date.parse(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? new Date(value).toISOString() : null;
};
const packageRoots = [];
for (let current = dirname(fileURLToPath(import.meta.url));;) {
  const candidate = join(current, 'node_modules');
  if (fs.existsSync(candidate)) packageRoots.push(candidate);
  const parent = dirname(current);
  if (parent === current) break;
  current = parent;
}
const inside = (root, path) => { const part = relative(pathKey(root), pathKey(path)); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const original = { lstatSync: fs.lstatSync, realpathSync: fs.realpathSync };
function checkedRead(raw) {
  if (typeof raw === 'number') return;
  const path = normalized(raw instanceof URL ? fileURLToPath(raw) : Buffer.isBuffer(raw) ? raw.toString() : raw);
  if (!path || ![...packageRoots, request.homePath, request.repoPath].some(root => inside(root, path))) fail();
  const parts = path.split(/[\\/]/);
  if (parts.some(part => /^(?:\.env(?:\..*)?|auth\.json|\.credentials\.json|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(part))) fail();
  // Reject linked sources. Missing metadata stays a normal ENOENT result from the underlying API.
  let current = process.platform === 'win32' ? win32.parse(path).root : '/';
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if (original.lstatSync(current).isSymbolicLink()) fail(); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
}
function guardReads(target, names) {
  for (const name of names) {
    const operation = target[name];
    if (typeof operation === 'function') {
      const wrapped = function(path, ...args) { checkedRead(path); return operation.call(this, path, ...args); };
      if (operation.native) wrapped.native = function(path, ...args) { checkedRead(path); return operation.native.call(this, path, ...args); };
      target[name] = wrapped;
    }
  }
}
guardReads(fs, ['readFile', 'readFileSync', 'readdir', 'readdirSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'realpath', 'realpathSync', 'createReadStream']);
guardReads(fsp, ['readFile', 'readdir', 'stat', 'lstat', 'access', 'realpath']);
for (const target of [fs, fsp]) {
  for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync', 'truncate', 'truncateSync', 'link', 'linkSync', 'symlink', 'symlinkSync', 'createWriteStream']) if (name in target) target[name] = fail;
  for (const name of ['open', 'openSync']) if (typeof target[name] === 'function') {
    const operation = target[name];
    target[name] = function(path, flags, ...args) { checkedRead(path); if (flags !== 'r' && flags !== 'rs' && flags !== fs.constants.O_RDONLY) fail(); return operation.call(this, path, flags, ...args); };
  }
}
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = http.request = http.get = https.request = https.get = fail;
globalThis.fetch = fail; globalThis.WebSocket = class { constructor() { fail(); } };
for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'spawnSync']) childProcess[name] = fail;
childProcess.spawn = function(executable, args, options) {
  if (request.provider !== 'copilot-cli' || runtimeChild || typeof executable !== 'string' || !packageRoots.some(root => inside(root, resolve(executable)))
    || !Array.isArray(args) || !args.includes('--headless') || !args.includes('--no-auto-update') || !args.includes('--no-auto-login')) fail();
  runtimeChild = originalSpawn(executable, args, { ...options, windowsHide: true });
  return runtimeChild;
};
syncBuiltinESMExports();

/** Optional UI names only; the SQL result remains authoritative for scope and identity. */
function codexIndexedTitles(selectedIds) {
  const titles = new Map();
  if (!selectedIds.size) return titles;
  let descriptor;
  try {
    const path = join(request.homePath, 'session_index.jsonl');
    // Inspect this known optional entry before guarded open; never follow a link.
    const info = original.lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) return titles;
    descriptor = fs.openSync(path, 'r');
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== info.size || opened.ino !== info.ino || opened.dev !== info.dev) return titles;
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(descriptor, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fs.fstatSync(descriptor);
    if (length !== info.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return titles;
    const lines = bytes.subarray(0, length).toString('utf8').replace(/^\uFEFF/u, '').split(/\r?\n/u);
    if (lines.at(-1) === '') lines.pop();
    if (lines.length > 10000) return titles;
    for (const line of lines) {
      if (!line.trim() || Buffer.byteLength(line) > 8192) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !id(entry.id) || !selectedIds.has(entry.id)) continue;
      if (Object.keys(entry).length !== 3 || !['id', 'thread_name', 'updated_at'].every(key => Object.hasOwn(entry, key))
        || typeof entry.thread_name !== 'string' || !entry.thread_name.trim() || entry.thread_name.length > 512
        || !entry.thread_name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim()
        || typeof entry.updated_at !== 'string' || entry.updated_at.length > 40
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(entry.updated_at)) continue;
      const updated = Date.parse(entry.updated_at);
      if (!Number.isFinite(updated) || updated < 0 || updated > Date.now() + 300000) continue;
      const [year, month, day] = entry.updated_at.slice(0, 10).split('-').map(Number);
      if (day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(entry.updated_at.slice(11, 13)) > 23) continue;
      const previous = titles.get(entry.id);
      if (!previous || updated >= previous.updated) titles.set(entry.id, { title: entry.thread_name, updated });
    }
    return titles;
  } catch { return new Map(); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

let result = { sessions: [], nextCursor: null, status: 'unavailable', message: null };
let client;
try {
  let rows;
  if (request.provider === 'codex') {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(request.homePath, 'state_5.sqlite'), { readonly: true, fileMustExist: true, timeout: 100 });
    try {
      db.pragma('query_only = ON'); db.pragma('trusted_schema = OFF');
      const table = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = 'threads'").get();
      if (table?.type !== 'table' || /VIRTUAL\s+TABLE/i.test(table.sql ?? '')) throw new Error('Unknown metadata schema');
      const columns = new Map(db.pragma('table_info(threads)').map(column => [column.name, column.type?.toUpperCase()]));
      if (!['id', 'cwd', 'created_at', 'updated_at', 'archived', 'cli_version'].every(value => columns.has(value))
        || !['id', 'cwd', 'cli_version'].every(value => columns.get(value) === 'TEXT')
        || !['created_at', 'updated_at', 'archived', ...['created_at_ms', 'updated_at_ms'].filter(value => columns.has(value))]
          .every(value => ['INT', 'INTEGER', 'BIGINT'].includes(columns.get(value)))) throw new Error('Unknown metadata schema');
      const created = columns.has('created_at_ms') ? 'COALESCE(created_at_ms, created_at * 1000)' : 'created_at * 1000';
      const updated = columns.has('updated_at_ms') ? 'COALESCE(updated_at_ms, updated_at * 1000)' : 'updated_at * 1000';
      db.function('agent_town_project_matches', { deterministic: true }, candidate => same(candidate) ? 1 : 0);
      // Only explicit display metadata: conversation title and Codex nickname.
      // Never substitute roles, paths, first_user_message, preview or transcript text.
      const title = columns.get('title') === 'TEXT' ? 'substr(title, 1, 512)' : 'NULL';
      const nickname = columns.get('agent_nickname') === 'TEXT' ? 'substr(agent_nickname, 1, 512)' : 'NULL';
      const metadata = db.prepare(`SELECT id, ${created} AS created_ms, ${updated} AS updated_ms, ${title} AS title, ${nickname} AS nativeAgentName FROM threads
        WHERE agent_town_project_matches(cwd) = 1 AND ${updated} >= ? ORDER BY updated_ms DESC, id ASC LIMIT ? OFFSET ?`)
        .all(request.cutoff, request.limit, request.offset);
      const indexedTitles = codexIndexedTitles(new Set(metadata.map(row => row.id)));
      const edgeTable = db.prepare("SELECT type FROM sqlite_master WHERE name = 'thread_spawn_edges'").get();
      let parent;
      if (edgeTable) {
        const edgeColumns = new Set(db.pragma('table_info(thread_spawn_edges)').map(column => column.name));
        if (edgeTable.type !== 'table' || !['parent_thread_id', 'child_thread_id', 'status'].every(value => edgeColumns.has(value))) throw new Error('Unknown child metadata schema');
        parent = db.prepare(`SELECT DISTINCT e.parent_thread_id AS id FROM thread_spawn_edges e JOIN threads t ON t.id = e.parent_thread_id
          WHERE e.child_thread_id = ? AND agent_town_project_matches(t.cwd) = 1 LIMIT 2`);
      }
      rows = metadata.map(row => {
        if (!id(row.id)) throw new Error('Invalid metadata identifier');
        const parents = parent?.all(row.id);
        return { nativeSessionId: row.id, projectPath: request.repoPath, createdAt: date(row.created_ms), updatedAt: date(row.updated_ms),
          ...named(row.title),
          ...(indexedTitles.has(row.id) ? { indexedTitle: indexedTitles.get(row.id).title } : {}),
          ...(typeof row.nativeAgentName === 'string' && row.nativeAgentName.trim() ? { nativeAgentName: row.nativeAgentName } : {}),
          ...(parents?.length === 1 && id(parents[0].id) && parents[0].id !== row.id ? { parentNativeSessionId: parents[0].id } : {}) };
      });
    } finally { db.close(); }
  } else if (request.provider === 'claude') {
    const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
    // Explicit directory and no worktree expansion prevent whole-profile history import.
    rows = (await listSessions({ dir: request.repoPath, limit: request.offset + request.limit, offset: 0, includeWorktrees: false, includeProgrammatic: true }))
      .map(row => ({ nativeSessionId: row.sessionId, projectPath: row.cwd, createdAt: date(row.createdAt), updatedAt: date(row.lastModified), ...named(row.customTitle) }));
  } else if (request.provider === 'cursor') {
    const { Agent, JsonlLocalAgentStore } = await import('@cursor/sdk');
    // This is an explicitly selected SDK JSONL store, never an undocumented editor database.
    checkedRead(join(request.homePath, 'agents.ndjson'));
    if (!fs.existsSync(join(request.homePath, 'agents.ndjson'))) throw new Error('A compatible SDK store was not selected');
    const store = new JsonlLocalAgentStore(request.homePath);
    rows = []; let cursor;
    do {
      const page = await Agent.list({ runtime: 'local', cwd: request.repoPath, store, limit: Math.min(100, request.offset + request.limit), ...(cursor ? { cursor } : {}) });
      rows.push(...page.items.map(row => ({ nativeSessionId: row.agentId, projectPath: row.cwd, createdAt: date(row.createdAt), updatedAt: date(row.lastModified), ...named(row.name === row.agentId ? undefined : row.name) })));
      cursor = page.nextCursor;
    } while (cursor && rows.length < request.offset + request.limit);
  } else if (request.provider === 'copilot-cli') {
    const { CopilotClient, RuntimeConnection, CopilotRequestHandler } = await import('@github/copilot-sdk');
    class NoModelRequests extends CopilotRequestHandler { sendRequest() { refusedOperation = true; return Promise.reject(new Error('Model requests are disabled')); } openWebSocket() { fail(); } }
    client = new CopilotClient({ mode: 'empty', baseDirectory: request.homePath, workingDirectory: dirname(fileURLToPath(import.meta.url)),
      connection: RuntimeConnection.forStdio(), useLoggedInUser: false, enableRemoteSessions: false, logLevel: 'none',
      env: { ...process.env, COPILOT_DISABLE_KEYTAR: '1', COPILOT_TELEMETRY_ENABLED: 'false', COPILOT_OTEL_ENABLED: 'false', DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true' }, requestHandler: new NoModelRequests() });
    await client.start();
    rows = (await client.listSessions({ workingDirectory: request.repoPath })).filter(row => !row.isRemote)
      .map(row => ({ nativeSessionId: row.sessionId, projectPath: row.context?.workingDirectory, createdAt: date(row.startTime), updatedAt: date(row.modifiedTime) }));
  } else throw new Error('Unsupported metadata provider');
  if (refusedOperation) throw new Error('Metadata access was refused');
  const accepted = rows.filter(row => id(row.nativeSessionId) && same(row.projectPath) && (request.cutoff === 0 || row.updatedAt !== null && Date.parse(row.updatedAt) >= request.cutoff));
  const unique = new Map(accepted.map(row => [row.nativeSessionId, { ...row, projectPath: request.repoPath }]));
  const offset = request.provider === 'codex' ? 0 : request.offset;
  result = { sessions: [...unique.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.nativeSessionId.localeCompare(b.nativeSessionId)).slice(offset, offset + request.limit), nextCursor: null, status: 'available', message: null };
} catch { /* Native errors may include prompts, paths or credentials: never serialize them. */ }
finally { if (client) await client.stop().catch(() => undefined); runtimeChild?.kill(); }
output(JSON.stringify(result));
process.exit(0);
