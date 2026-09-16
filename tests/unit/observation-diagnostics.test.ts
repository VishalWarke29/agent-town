import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store, projectRoot } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { normalizeHook } from '../../apps/service/src/observation/normalize';
import { sourceDiagnosticCodes } from '../../apps/service/src/observation/source-binding';
import { drainObservationSpool } from '../../apps/service/src/observation/spool';
import type { RegisteredObservation } from '../../apps/service/src/observation/registry';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = realpathSync(directory), rest = relative(realpathSync(tmpdir()), target);
    if (!rest || rest.startsWith('..') || isAbsolute(rest) || !target.includes('agent-town-diagnostic-')) throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture(version: 1 | 2) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-diagnostic-')); directories.push(directory);
  const repo = join(directory, 'project'), home = join(directory, 'home'), spool = join(directory, 'spool');
  [repo, home, spool].forEach(path => mkdirSync(path));
  const record: RegisteredObservation = { ownerId: 'owner', workspaceId: 'workspace', repoPath: repo, nativeHome: home,
    connection: { id: randomUUID(), provider: 'codex', repoId: 'repo', label: 'Fixture', status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', binding: 'resolved', droppedEvents: 0 } };
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ version, connectionId: record.connection.id, provider: 'codex', repoPath: repo, spoolPath: spool,
    ...(version === 2 ? { nativeSourceId: randomUUID(), nativeHome: home, sourceRevision: 1 } : {}) }));
  return { directory, repo, home, spool, record, config };
}
function invoke(f: ReturnType<typeof fixture>, input: string, event = 'Stop') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(projectRoot, 'apps/service/src/observation/bridge.ts'), '--config', f.config, '--event', event],
      { cwd: projectRoot, env: { ...process.env, CODEX_HOME: f.home }, windowsHide: true, stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += String(value); }); child.stderr.on('data', value => { stderr += String(value); });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}

describe('actionable and private observation rejection diagnostics', () => {
  it.each([1, 2] as const)('coalesces rejected project paths in V%s without leaking input or changing source identity', async version => {
    const f = fixture(version), raw = JSON.stringify({ cwd: join(f.directory, 'PRIVATE_OUTSIDE'), session_id: 'session', last_assistant_message: 'sk-PRIVATE_DIAGNOSTIC_SECRET' });
    expect(await invoke(f, raw)).toEqual({ code: 0, stdout: '{}', stderr: '' });
    expect(await invoke(f, raw)).toEqual({ code: 0, stdout: '{}', stderr: '' });
    expect(readdirSync(f.spool)).toEqual(['source-diagnostic-project-path-rejected']);
    expect(readFileSync(join(f.spool, 'source-diagnostic-project-path-rejected'), 'utf8')).toBe('1');
    const state = privateState({ id: 'workspace', name: 'Fixture', kind: 'personal' }); state.observation = { connections: [f.record.connection] };
    const database = join(f.directory, 'town.sqlite'); let store = new Store(database, state);
    try {
      await drainObservationSpool({ directory: f.directory, spool: f.spool, record: f.record, store, receive: () => { throw new Error('Rejected input must not be received'); }, closing: () => false });
      store.close(); store = new Store(database, state);
      const saved = store.snapshot().state;
      expect(saved.observation!.connections[0]).toMatchObject({ binding: 'resolved', droppedEvents: 1, droppedEventsExact: false,
        diagnostics: [expect.objectContaining({ code: 'project-path-rejected', message: expect.stringContaining('selected project'), lastSeenAt: expect.any(String) })] });
      expect(saved.activity.some(item => item.message.includes('Observation input rejected'))).toBe(true);
      expect(JSON.stringify(saved)).not.toMatch(/PRIVATE_OUTSIDE|sk-PRIVATE_DIAGNOSTIC_SECRET/);
      expect(readdirSync(f.spool)).toEqual([]);
    } finally { store.close(); }
  });

  it('identifies missing session/child IDs and unsupported events during the same normalization pass', () => {
    const f = fixture(2), cases = [
      ['Stop', { cwd: f.repo }, 'missing-session-id'],
      ['SubagentStart', { cwd: f.repo, session_id: 'parent' }, 'missing-child-id'],
      ['UnknownEvent', { cwd: f.repo, session_id: 'session' }, 'unsupported-event'],
      ['Stop', [], 'malformed-payload'],
    ] as const;
    for (const [event, input, code] of cases) {
      const reasons: string[] = [];
      expect(normalizeHook('codex', event, input, f.repo, undefined, reason => reasons.push(reason))).toBeNull();
      expect(reasons).toEqual([code]);
    }
  });

  it('records malformed JSON and unusable native IDs without saving their contents', async () => {
    const f = fixture(2);
    expect(await invoke(f, '{"PRIVATE_BAD_JSON":')).toEqual({ code: 0, stdout: '{}', stderr: '' });
    expect(await invoke(f, JSON.stringify({ cwd: f.repo, session_id: 'PRIVATE INVALID ID', response: 'PRIVATE RESPONSE' }))).toEqual({ code: 0, stdout: '{}', stderr: '' });
    expect(readdirSync(f.spool).sort()).toEqual(['source-diagnostic-malformed-payload', 'source-diagnostic-missing-session-id']);
  });

  it('recovers claimed notices and bounds persisted diagnostics while preserving binding for payload failures', async () => {
    const f = fixture(2), state = privateState({ id: 'workspace', name: 'Fixture', kind: 'personal' }); state.observation = { connections: [f.record.connection] };
    const store = new Store(join(f.directory, 'town.sqlite'), state);
    try {
      for (const code of sourceDiagnosticCodes) writeFileSync(join(f.spool, `source-diagnostic-${code}-${randomUUID()}.pending`), '1');
      await drainObservationSpool({ directory: f.directory, spool: f.spool, record: f.record, store, receive: () => {}, closing: () => false });
      const source = store.snapshot().state.observation!.connections[0]!;
      expect(source.diagnostics).toHaveLength(8);
      expect(new Set(source.diagnostics!.map(item => item.code)).size).toBe(8);
      expect(source.binding).toBe('ambiguous');
      expect(readdirSync(f.spool)).toEqual([]);
    } finally { store.close(); }
  });
});
