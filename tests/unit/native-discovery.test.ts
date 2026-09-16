import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { discoverNativeSessions } from '../../apps/service/src/native-discovery/index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-town-native-discovery-'));
  const home = join(root, 'native'), repo = join(root, 'project');
  await mkdir(home); await mkdir(repo);
  const db = new Database(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, cli_version TEXT, title TEXT, first_user_message TEXT, preview TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);');
  const add = (id: string, cwd = repo, updated = Date.now(), archived = 0) => db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, cwd, Math.floor(updated / 1000), Math.floor(updated / 1000), archived, 'fixture', 'Fix project navigation', 'sk-secret-prompt-must-not-be-read', 'PRIVATE PREVIEW');
  return { root, home, repo, db, add, async close() { db.close(); const target = resolve(root); if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe fixture cleanup'); await rm(target, { recursive: true, force: true }); } };
}
describe('native session metadata discovery', () => {
  it('reads only selected-project metadata, associates verified parents and preserves source bytes', async () => {
    const f = await fixture();
    try {
      f.add('parent'); f.add('child'); f.add('other-project', join(f.root, 'elsewhere')); f.add('archived', f.repo, Date.now(), 1);
      f.db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run('parent', 'child', 'completed');
      const before = createHash('sha256').update(await readFile(join(f.home, 'state_5.sqlite'))).digest('hex');
      const filesBefore = await readdir(f.home);
      const result = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo });
      expect(result.status).toBe('available'); expect(result.sessions).toHaveLength(3);
      expect(result.sessions.find(value => value.nativeSessionId === 'child')?.parentNativeSessionId).toBe('parent');
      expect(result.sessions.every(value => value.title === 'Fix project navigation')).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|sk-secret|first_user_message|preview|cli_version|other-project/);
      expect(createHash('sha256').update(await readFile(join(f.home, 'state_5.sqlite'))).digest('hex')).toBe(before);
      expect(await readdir(f.home)).toEqual(filesBefore);
    } finally { await f.close(); }
  });
  it('bounds and sanitizes native titles while never substituting conversation fields', async () => {
    const f = await fixture();
    try {
      for (const id of ['named', 'blank', 'long', 'secret']) f.add(id);
      const title = f.db.prepare('UPDATE threads SET title=? WHERE id=?');
      title.run('  Fix\n layout\u202e  ', 'named'); title.run('  ', 'blank');
      title.run('x'.repeat(10000), 'long'); title.run('Repair sk-abcdefghijklmnop123456', 'secret');
      const result = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo });
      expect(result.status).toBe('available');
      expect(result.sessions.find(value => value.nativeSessionId === 'named')?.title).toBe('Fix layout');
      expect(result.sessions.find(value => value.nativeSessionId === 'blank')).not.toHaveProperty('title');
      expect(result.sessions.find(value => value.nativeSessionId === 'long')?.title).toHaveLength(160);
      expect(result.sessions.find(value => value.nativeSessionId === 'secret')?.title).toBe('Repair [credential removed]');
      expect(JSON.stringify(result)).not.toMatch(/sk-|PRIVATE|first_user_message|preview/);
      f.db.exec('ALTER TABLE threads DROP COLUMN title');
      const old = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo });
      expect(old.status).toBe('available'); expect(old.sessions).toHaveLength(4);
      expect(old.sessions.every(value => value.title === undefined)).toBe(true);
    } finally { await f.close(); }
  });
  it('includes valid extended drive paths but excludes sibling prefixes, traversal and devices', async () => {
    const f = await fixture();
    try {
      f.add('plain');
      if (process.platform === 'win32') f.add('extended', `\\\\?\\${f.repo}`);
      f.add('sibling', `${f.repo}-other`); f.add('traversal', `${f.repo}\\..\\project`); f.add('device', `\\\\.\\${f.repo}`);
      const result = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo });
      expect(result.sessions.map(value => value.nativeSessionId).sort()).toEqual(process.platform === 'win32' ? ['extended', 'plain'] : ['plain']);
    } finally { await f.close(); }
  });
  it('reads only explicit Codex nicknames and keeps siblings with the same title distinct', async () => {
    const f = await fixture();
    try {
      for (const id of ['parent', 'child-one', 'child-two', 'long', 'secret']) f.add(id);
      f.db.exec('ALTER TABLE threads ADD COLUMN agent_nickname TEXT; ALTER TABLE threads ADD COLUMN agent_role TEXT; ALTER TABLE threads ADD COLUMN agent_path TEXT;');
      f.db.prepare('UPDATE threads SET agent_role=?, agent_path=?').run('PRIVATE ROLE', 'PRIVATE PATH');
      const nickname = f.db.prepare('UPDATE threads SET agent_nickname=? WHERE id=?');
      nickname.run('  Rowan\n\u202e  ', 'child-one'); nickname.run('Hazel', 'child-two');
      nickname.run('x'.repeat(10000), 'long'); nickname.run('Review sk-abcdefghijklmnop123456', 'secret');
      for (const child of ['child-one', 'child-two']) f.db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run('parent', child, 'completed');
      const before = await readFile(join(f.home, 'state_5.sqlite'));
      const result = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo });
      expect(result.status).toBe('available'); expect(result.sessions).toHaveLength(5);
      expect(new Set(result.sessions.map(value => value.nativeSessionId)).size).toBe(5);
      expect(result.sessions.find(value => value.nativeSessionId === 'parent')).not.toHaveProperty('nativeAgentName');
      expect(result.sessions.find(value => value.nativeSessionId === 'child-one')).toMatchObject({ title: 'Fix project navigation', nativeAgentName: 'Rowan', parentNativeSessionId: 'parent' });
      expect(result.sessions.find(value => value.nativeSessionId === 'child-two')).toMatchObject({ title: 'Fix project navigation', nativeAgentName: 'Hazel', parentNativeSessionId: 'parent' });
      expect(result.sessions.find(value => value.nativeSessionId === 'long')?.nativeAgentName).toHaveLength(160);
      expect(result.sessions.find(value => value.nativeSessionId === 'secret')?.nativeAgentName).toBe('Review [credential removed]');
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|sk-|agent_role|agent_path|first_user_message|preview/);
      expect(await readFile(join(f.home, 'state_5.sqlite'))).toEqual(before);
      f.db.exec('ALTER TABLE threads DROP COLUMN agent_nickname; ALTER TABLE threads ADD COLUMN agent_nickname INTEGER; UPDATE threads SET agent_nickname=42;');
      const incompatible = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo });
      expect(incompatible.status).toBe('available'); expect(incompatible.sessions).toHaveLength(5);
      expect(incompatible.sessions.every(value => value.nativeAgentName === undefined)).toBe(true);
    } finally { await f.close(); }
  });
  it('returns 25-item pages, excludes older metadata by default, and binds cursors to their source', async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 30; index++) f.add(`session-${index.toString().padStart(2, '0')}`, f.repo, Date.now() - index * 1000);
      f.add('old', f.repo, Date.now() - 31 * 86400000);
      const first = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo });
      expect(first.sessions).toHaveLength(25); expect(first.nextCursor).toBeTruthy();
      const second = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo, cursor: first.nextCursor! });
      expect(second.sessions).toHaveLength(5); expect(second.nextCursor).toBeNull();
      expect(new Set([...first.sessions, ...second.sessions].map(value => value.nativeSessionId)).size).toBe(30);
      expect((await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo, includeOlder: true, cursor: first.nextCursor! })).status).toBe('unavailable');
      const all = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo, includeOlder: true });
      const oldPage = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo, includeOlder: true, cursor: all.nextCursor! });
      expect(oldPage.sessions.some(value => value.nativeSessionId === 'old')).toBe(true);
    } finally { await f.close(); }
  });
  it('uses indexed UI titles only for SQL-selected IDs without changing native scope, activity time or nicknames', async () => {
    const f = await fixture();
    try {
      f.add('parent'); f.add('child'); f.add('other-project', join(f.root, 'elsewhere'));
      f.db.exec('ALTER TABLE threads ADD COLUMN agent_nickname TEXT;');
      f.db.prepare('UPDATE threads SET agent_nickname=? WHERE id=?').run('Hazel', 'child');
      f.db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run('parent', 'child', 'open');
      const index = join(f.home, 'session_index.jsonl');
      const indexed = (id: string, thread_name: string, updated_at: string) => ({ id, thread_name, updated_at });
      await writeFile(index, [indexed('parent', 'Current UI name', '2020-01-02T00:00:00Z'),
        indexed('parent', 'Older indexed name', '2020-01-01T00:00:00Z'),
        indexed('other-project', 'PRIVATE OTHER PROJECT', '2020-01-02T00:00:00Z'),
        indexed('not-in-sql', 'PRIVATE UNKNOWN SESSION', '2020-01-02T00:00:00Z')].map(value => JSON.stringify(value)).join('\n') + '\n');
      const paths = [index, join(f.home, 'state_5.sqlite')], before = await Promise.all(paths.map(path => readFile(path)));
      const result = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo });
      expect(result.status).toBe('available'); expect(result.sessions).toHaveLength(2);
      const parent = result.sessions.find(value => value.nativeSessionId === 'parent')!;
      expect(parent.title).toBe('Current UI name'); expect(Date.parse(parent.updatedAt!)).toBeGreaterThan(Date.parse('2020-01-02T00:00:00Z'));
      expect(result.sessions.find(value => value.nativeSessionId === 'child')).toMatchObject({ title: 'Fix project navigation', nativeAgentName: 'Hazel', parentNativeSessionId: 'parent', projectPath: f.repo });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|other-project|not-in-sql|indexedTitle|thread_name|first_user_message|preview/);
      expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before);
    } finally { await f.close(); }
  });
  it('accepts only valid indexed title metadata and sanitizes overrides with a SQL fallback', async () => {
    const f = await fixture();
    try {
      for (const id of ['named', 'blank', 'fallback']) f.add(id);
      const valid = { id: 'named', thread_name: '  Review\n sk-abcdefghijklmnop123456\u202e  ', updated_at: '2020-01-01T00:00:00Z' };
      await writeFile(join(f.home, 'session_index.jsonl'), [JSON.stringify(valid), '{truncated',
        JSON.stringify({ ...valid, thread_name: 'Wrong schema', prompt: 'PRIVATE PROMPT', updated_at: '2021-01-01T00:00:00Z' }),
        JSON.stringify({ ...valid, thread_name: 'Invalid date', updated_at: 'not-a-date' }),
        JSON.stringify({ ...valid, thread_name: 'Invalid calendar day', updated_at: '2021-02-31T00:00:00Z' }),
        JSON.stringify({ ...valid, thread_name: '\u202e', updated_at: '2021-01-01T00:00:00Z' }),
        JSON.stringify({ ...valid, thread_name: 'Future update', updated_at: '2999-01-01T00:00:00Z' }),
        JSON.stringify({ ...valid, thread_name: 'x'.repeat(513), updated_at: '2021-01-01T00:00:00Z' }),
        JSON.stringify({ ...valid, id: 'blank', thread_name: '\u202e' }),
        JSON.stringify({ ...valid, id: 'fallback', thread_name: 42 }),
        JSON.stringify({ ...valid, id: 'fallback', updated_at: 1234 })].join('\n'));
      const result = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo });
      expect(result.status).toBe('available'); expect(result.sessions).toHaveLength(3);
      expect(result.sessions.find(value => value.nativeSessionId === 'named')?.title).toBe('Review [credential removed]');
      expect(result.sessions.filter(value => value.nativeSessionId !== 'named').every(value => value.title === 'Fix project navigation')).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|sk-|Wrong schema|Future update|Invalid date|prompt/);
    } finally { await f.close(); }
  });
  it('falls back to SQL for missing, malformed or over-limit optional title indexes', async () => {
    const f = await fixture();
    try {
      f.add('parent');
      const index = join(f.home, 'session_index.jsonl');
      for (const contents of [undefined, '{', JSON.stringify({ version: 999, sessions: [] }), 'x'.repeat(1024 * 1024 + 1), '\n'.repeat(10002), ' '.repeat(8193)]) {
        if (contents !== undefined) await writeFile(index, contents);
        const result = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo });
        expect(result.status).toBe('available'); expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]).toMatchObject({ nativeSessionId: 'parent', title: 'Fix project navigation', projectPath: f.repo });
      }
    } finally { await f.close(); }
  });
  it('does not report an unknown schema, denied path, or cancelled operation as an empty success', async () => {
    const f = await fixture();
    try {
      f.db.exec('ALTER TABLE threads RENAME TO incompatible_threads');
      expect((await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo })).status).toBe('unavailable');
      expect((await discoverNativeSessions({ provider: 'codex', homePath: join(f.home, 'missing'), repoPath: f.repo })).status).toBe('unavailable');
      expect((await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo, signal: AbortSignal.abort() })).message).toContain('cancelled');
      expect((await discoverNativeSessions({ provider: 'copilot-vscode', homePath: f.home, repoPath: f.repo })).status).toBe('unsupported');
    } finally { await f.close(); }
  });
  it('includes committed WAL metadata without checkpointing or changing the database and WAL', async () => {
    const f = await fixture();
    try {
      f.db.pragma('journal_mode = WAL'); f.add('committed-in-wal');
      const databasePath = join(f.home, 'state_5.sqlite');
      const before = await Promise.all([readFile(databasePath), readFile(`${databasePath}-wal`)]);
      const result = await discoverNativeSessions({ provider: 'codex', homePath: f.home, repoPath: f.repo });
      expect(result.status).toBe('available'); expect(result.sessions.map(value => value.nativeSessionId)).toEqual(['committed-in-wal']);
      expect(await Promise.all([readFile(databasePath), readFile(`${databasePath}-wal`)])).toEqual(before);
    } finally { await f.close(); }
  });
  it('cancels an isolated SDK scan and preserves native fixture files', async () => {
    const f = await fixture();
    try {
      const controller = new AbortController();
      const pending = discoverNativeSessions({ provider: 'copilot-cli', homePath: f.home, repoPath: f.repo, signal: controller.signal });
      const timer = setTimeout(() => controller.abort(), 10);
      try { expect((await pending).message).toContain('cancelled'); }
      finally { clearTimeout(timer); }
      expect(await readdir(f.home)).toEqual(['state_5.sqlite']);
    } finally { await f.close(); }
  });
  it('discards prompt-derived fields from a real Claude SDK metadata listing in its isolated process', async () => {
    const f = await fixture();
    try {
      const projectDirectory = join(f.home, 'projects', f.repo.replace(/[^a-zA-Z0-9]/g, '-'));
      await mkdir(projectDirectory, { recursive: true });
      const sessionId = '12345678-1234-4234-8234-123456789abc';
      const transcript = join(projectDirectory, `${sessionId}.jsonl`);
      await writeFile(transcript, JSON.stringify({ type: 'user', sessionId, cwd: f.repo, timestamp: new Date().toISOString(), message: { role: 'user', content: 'PRIVATE PROMPT sk-secret-never-return-this' } }) + '\n');
      const before = await readFile(transcript);
      const result = await discoverNativeSessions({ provider: 'claude', homePath: f.home, repoPath: f.repo });
      expect(result.status).toBe('available'); expect(result.sessions.map(value => value.nativeSessionId)).toContain(sessionId);
      expect(result.sessions.find(value => value.nativeSessionId === sessionId)).not.toHaveProperty('title');
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|sk-secret|summary|firstPrompt|message.*never/);
      expect(await readFile(transcript)).toEqual(before);
      await writeFile(transcript, before.toString() + JSON.stringify({ type: 'custom-title', sessionId, customTitle: 'Fix the local login flow' }) + '\n');
      const renamedBytes = await readFile(transcript);
      const renamed = await discoverNativeSessions({ provider: 'claude', homePath: f.home, repoPath: f.repo });
      expect(renamed.sessions.find(value => value.nativeSessionId === sessionId)?.title).toBe('Fix the local login flow');
      expect(JSON.stringify(renamed)).not.toMatch(/PRIVATE|sk-secret|summary|firstPrompt/);
      expect(await readFile(transcript)).toEqual(renamedBytes);
    } finally { await f.close(); }
  });
  it('lists an explicitly selected Cursor SDK JSONL store without loading messages or modifying its store', async () => {
    const f = await fixture();
    try {
      const file = join(f.home, 'agents.ndjson');
      await writeFile(file, JSON.stringify({ agentId: 'agent-fixture', cwd: f.repo, createdAt: Date.now(), updatedAt: Date.now(), status: 'finished', name: 'Fix dashboard layout', sdkMetadata: { summary: 'PRIVATE SUMMARY' } }) + '\n');
      const before = await readFile(file);
      const result = await discoverNativeSessions({ provider: 'cursor', homePath: f.home, repoPath: f.repo });
      expect(result.status).toBe('available'); expect(result.sessions.map(value => value.nativeSessionId)).toEqual(['agent-fixture']);
      expect(result.sessions[0]?.title).toBe('Fix dashboard layout');
      expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(await readFile(file)).toEqual(before);
      expect(await readdir(f.home)).toEqual(['agents.ndjson', 'state_5.sqlite']);
    } finally { await f.close(); }
  });
  it('uses the real Copilot metadata interface without creating a conversation', async () => {
    const f = await fixture();
    try {
      const result = await discoverNativeSessions({ provider: 'copilot-cli', homePath: f.home, repoPath: f.repo });
      expect(result.status).toBe('available'); expect(result.sessions).toEqual([]);
      expect(await readdir(f.home)).toEqual(['state_5.sqlite']);
    } finally { await f.close(); }
  }, 15000);
  it('filters Copilot native metadata to the selected project and strips its summary', async () => {
    const f = await fixture();
    try {
      const sessionId = '12345678-1234-4234-8234-123456789def';
      const directory = join(f.home, 'session-state', sessionId);
      await mkdir(directory, { recursive: true });
      const file = join(directory, 'workspace.yaml');
      const value = `id: ${sessionId}\ncwd: ${JSON.stringify(f.repo)}\nsummary: PRIVATE COPILOT SUMMARY\ncreated_at: ${new Date().toISOString()}\nupdated_at: ${new Date().toISOString()}\n`;
      await writeFile(file, value);
      await writeFile(join(directory, 'events.jsonl'), JSON.stringify({ type: 'session.start', id: '12345678-1234-4234-8234-123456789123', parentId: null, timestamp: new Date().toISOString(),
        data: { sessionId, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.83', startTime: new Date().toISOString(), context: { cwd: f.repo } } }) + '\n');
      const result = await discoverNativeSessions({ provider: 'copilot-cli', homePath: f.home, repoPath: f.repo });
      expect(result.status).toBe('available'); expect(result.sessions.map(value => value.nativeSessionId)).toEqual([sessionId]);
      expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(await readFile(file, 'utf8')).toBe(value);
      expect(await readdir(directory)).toEqual(['events.jsonl', 'workspace.yaml']);
    } finally { await f.close(); }
  }, 15000);
});
