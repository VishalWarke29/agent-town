import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import Fastify from 'fastify';
import type { ObservationEvent } from '@agent-town/contracts';
import { privateState } from '../../apps/service/src/workspaces';
import { Store, projectRoot } from '../../apps/service/src/store';
import { ObservationRegistry, type RegisteredObservation } from '../../apps/service/src/observation/registry';
import { applyObservation } from '../../apps/service/src/observation/reducer';
import { drainObservationSpool } from '../../apps/service/src/observation/spool';
import { SPOOL_BATCH_LIMIT, SPOOL_EVENT_BYTES, SPOOL_EVENT_LIMIT } from '../../apps/service/src/observation/spool-limits';
import { bridgeConfigPath, spoolPath, writeBridgeConfig } from '../../apps/service/src/observation/setup';
import { registerObservationApi } from '../../apps/service/src/observation/service';
import { IdentityError } from '../../apps/service/src/identity';

const fixtures: { directory: string; close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
    const base = realpathSync(tmpdir()), target = realpathSync(fixture.directory), inside = relative(base, target);
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !target.includes('agent-town-spool-')) throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-spool-')), root = join(directory, 'repo'); mkdirSync(root);
  const state = privateState({ id: 'workspace-one', name: 'Fixture', kind: 'personal' });
  state.repositories = [{ id: 'repo-one', name: 'Repo', branch: 'main', description: '', language: 'TypeScript', color: '#abc', position: [0, 0], source: 'local', localPath: root }];
  state.discovery!.roots = [root];
  const record: RegisteredObservation = { ownerId: '101', workspaceId: 'workspace-one', repoPath: root,
    connection: { id: randomUUID(), provider: 'claude', repoId: 'repo-one', label: 'Fixture', status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true } };
  state.observation = { connections: [record.connection] };
  const database = join(directory, 'town.sqlite'); let store = new Store(database, state);
  const registry = new ObservationRegistry(join(directory, 'observation.sqlite')); registry.register(record, 'a'.repeat(64)); registry.close();
  await writeBridgeConfig(record, directory); const spool = spoolPath(directory, record.connection.id);
  let api: ReturnType<typeof registerObservationApi> | undefined;
  let app: ReturnType<typeof Fastify> | undefined;
  const receive = (events: ObservationEvent[]) => {
    for (const event of events) store.commit(`observe:${record.connection.id}:${event.id}`, (current, now) => applyObservation(current, record.connection, event, now), JSON.stringify(event));
  };
  const close = async () => { await api?.close(); await app?.close(); api = undefined; app = undefined; store.close(); };
  const restart = async () => {
    await close(); store = new Store(database, state); app = Fastify();
    api = registerObservationApi(app, { directory, vault: { available: true, get: async () => null, put: async () => {}, delete: async () => {} },
      scoped: () => ({ ownerId: '101', store }), workspace: (owner, workspace) => { if (owner !== '101' || workspace !== 'workspace-one') throw new Error('Scope violation'); return store; } });
  };
  fixtures.push({ directory, close });
  const write = (event: ObservationEvent, name = `${randomUUID()}.json`) => { const path = join(spool, name); writeFileSync(path, JSON.stringify(event)); return path; };
  const drain = (deliver = receive) => drainObservationSpool({ directory, spool, record, store, receive: deliver, closing: () => false });
  const observed = (kind: ObservationEvent['kind'], id: string, age = 0, summary?: string): ObservationEvent => ({ id, sessionId: 'one', kind, occurredAt: new Date(Date.now() - age).toISOString(), ...(summary ? { summary } : {}) });
  return { directory, root, spool, record, write, drain, receive, observed, restart, close, store: () => store };
}

describe('durable local observation spool', () => {
  it('replays real offline files in source order despite reverse filenames and saves one report across restart', async () => {
    const fixture = await setup();
    const report = fixture.observed('turn.end', 'report', 2000, 'Earlier final response.'), end = fixture.observed('session.end', 'end', 1000);
    fixture.write(end, '00000000-0000-4000-8000-000000000001.json');
    fixture.write(report, 'ffffffff-ffff-4fff-8fff-ffffffffffff.json');
    await fixture.restart();
    await vi.waitFor(() => {
      expect(fixture.store().snapshot().state.handoffs).toHaveLength(1);
      expect(fixture.store().snapshot().state.agents[0].activity).toBe('offline');
      expect(readdirSync(fixture.spool)).toEqual([]);
    });
    const first = fixture.store().snapshot().state;
    expect(first.workflow!.manager.queueReportIds).toEqual([first.handoffs[0].id]);
    expect(first.observation!.connections[0]).toMatchObject({ droppedEvents: 0, delivery: { status: 'idle', pendingEvents: 0 } });
    expect(first.activity.filter(item => item.kind === 'work' || item.kind === 'report').map(item => item.kind)).toEqual(['work', 'report']);
    await fixture.close(); fixture.write(report); await fixture.restart();
    await vi.waitFor(() => expect(readdirSync(fixture.spool)).toEqual([]));
    expect(fixture.store().snapshot().state.handoffs).toHaveLength(1);
    expect(fixture.store().snapshot().state.agents[0].activity).toBe('offline');
  });

  it('recovers a late report when the newer terminal event was persisted before shutdown', async () => {
    const fixture = await setup();
    const end = fixture.observed('session.end', 'end', 1000); fixture.receive([end]);
    const previous = fixture.store().snapshot().state.agents[0];
    await fixture.close(); fixture.write(fixture.observed('report', 'late', 2000, 'Saved after the service stopped.')); await fixture.restart();
    await vi.waitFor(() => expect(fixture.store().snapshot().state.handoffs).toHaveLength(1));
    expect(fixture.store().snapshot().state.agents[0]).toEqual(previous);
    expect(fixture.store().snapshot().state.manager.version).toBe(0);
  });

  it('keeps committed evidence idempotent if delivery is interrupted before its file is deleted', async () => {
    const fixture = await setup(), saved = fixture.observed('report', 'committed', 0, 'Commit before deletion.');
    const path = fixture.write(saved);
    await fixture.drain(events => { fixture.receive(events); throw new Error('Simulated interruption after durable commit'); });
    expect(existsSync(path)).toBe(true); expect(fixture.store().snapshot().state.handoffs).toHaveLength(1);
    expect(fixture.store().snapshot().state.observation!.connections[0]).toMatchObject({ droppedEvents: 0, delivery: { status: 'blocked', pendingEvents: 1 } });
    await fixture.restart(); await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    expect(fixture.store().snapshot().state.handoffs).toHaveLength(1);
  });

  it.each(['database', 'capacity'] as const)('retains valid files on a %s failure and accepts them after recovery', async mode => {
    const fixture = await setup(); const path = fixture.write(fixture.observed('report', 'retry', 0, 'Retained evidence.'));
    await fixture.drain(() => { if (mode === 'capacity') throw new IdentityError('SOURCE_RATE_LIMIT', 'Fixture limit', 429); throw new Error('Transient SQLite failure'); });
    expect(existsSync(path)).toBe(true); expect(fixture.store().snapshot().state.handoffs).toHaveLength(0);
    expect(fixture.store().snapshot().state.observation!.connections[0]).toMatchObject({ droppedEvents: 0, delivery: { status: 'blocked', pendingEvents: 1 } });
    await fixture.drain(); expect(existsSync(path)).toBe(false); expect(fixture.store().snapshot().state.handoffs).toHaveLength(1);
  });

  it('bounds each replay batch and reports the remaining observed backlog', async () => {
    const fixture = await setup();
    for (let index = 0; index < SPOOL_BATCH_LIMIT + 5; index++) fixture.write(fixture.observed('tool.finish', `tool-${index}`));
    await fixture.drain();
    expect(readdirSync(fixture.spool)).toHaveLength(5);
    expect(fixture.store().snapshot().state.observation!.connections[0].delivery).toMatchObject({ status: 'pending', pendingEvents: 5 });
    await fixture.drain(); expect(readdirSync(fixture.spool)).toHaveLength(0);
  });

  it('durably counts rejected records and labels coalesced overflow as an unknown lower bound', async () => {
    const fixture = await setup();
    writeFileSync(join(fixture.spool, `${randomUUID()}.json`), 'INVALID secret=never-display');
    writeFileSync(join(fixture.spool, `${randomUUID()}.json`), JSON.stringify({ unsupported: 'never-display' }));
    writeFileSync(join(fixture.spool, `${randomUUID()}.json`), 'x'.repeat(SPOOL_EVENT_BYTES + 1));
    writeFileSync(join(fixture.spool, 'coverage-gap'), '1');
    await fixture.drain();
    const state = fixture.store().snapshot().state;
    expect(state.observation!.connections[0]).toMatchObject({ droppedEvents: 4, droppedEventsExact: false, delivery: { status: 'idle', pendingEvents: 0 } });
    expect(state.activity.filter(item => item.message.startsWith('Observation coverage gap:'))).toHaveLength(4);
    expect(JSON.stringify(state)).not.toContain('never-display'); expect(readdirSync(fixture.spool)).toHaveLength(0);
  });

  it('retains unfinished write evidence and never labels an unreadable pending count as zero', async () => {
    const fixture = await setup(), temporary = `${randomUUID()}.tmp`;
    writeFileSync(join(fixture.spool, temporary), '{unfinished');
    fixture.write(fixture.observed('report', 'completed', 1000, 'Completed event.'));
    await fixture.drain();
    expect(fixture.store().snapshot().state.handoffs).toHaveLength(1);
    expect(fixture.store().snapshot().state.observation!.connections[0]).toMatchObject({ droppedEvents: 0, delivery: { status: 'blocked', pendingEvents: null } });
    expect(readdirSync(fixture.spool)).toEqual([temporary]);
  });

  it('retains a loss claim across replay without counting its acknowledged loss twice', async () => {
    const fixture = await setup(); const name = `coverage-gap-${randomUUID()}.pending`;
    writeFileSync(join(fixture.spool, name), '1'); await fixture.drain();
    expect(fixture.store().snapshot().state.observation!.connections[0].droppedEvents).toBe(1);
    writeFileSync(join(fixture.spool, name), '1'); await fixture.drain();
    expect(fixture.store().snapshot().state.observation!.connections[0].droppedEvents).toBe(1);
    expect(readdirSync(fixture.spool)).toEqual([]);
  });

  it('rejects out-of-window events with an explicit durable coverage gap', async () => {
    const fixture = await setup(); fixture.write(fixture.observed('report', 'expired', 31 * 86400000, 'Expired evidence.'));
    await fixture.drain(); expect(fixture.store().snapshot().state.handoffs).toHaveLength(0);
    expect(fixture.store().snapshot().state.observation!.connections[0]).toMatchObject({ droppedEvents: 1, droppedEventsExact: true });
    expect(fixture.store().snapshot().state.activity[0].message).toContain('source-time window');
  });

  it('never follows a spool junction or a hard-linked event into other data', async () => {
    const fixture = await setup(); const outside = join(fixture.directory, 'other-data'); mkdirSync(outside);
    const protectedFile = join(outside, 'protected.json'); writeFileSync(protectedFile, 'PRIVATE_SENTINEL');
    const linkedName = `${randomUUID()}.json`; linkSync(protectedFile, join(fixture.spool, linkedName));
    await fixture.drain(); expect(existsSync(join(fixture.spool, linkedName))).toBe(false);
    expect(readFileSync(protectedFile, 'utf8')).toBe('PRIVATE_SENTINEL');
    rmdirSync(fixture.spool); symlinkSync(outside, fixture.spool, process.platform === 'win32' ? 'junction' : 'dir');
    await fixture.drain();
    expect(fixture.store().snapshot().state.observation!.connections[0].delivery).toMatchObject({ status: 'blocked', pendingEvents: null });
    expect(JSON.stringify(fixture.store().snapshot())).not.toContain('PRIVATE_SENTINEL');
    expect(readFileSync(protectedFile, 'utf8')).toBe('PRIVATE_SENTINEL');
  });
});

function invokeBridge(config: string, input: object) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(projectRoot, 'apps/service/src/observation/bridge.ts'), '--config', config, '--event', 'Stop'], { cwd: projectRoot, windowsHide: true, stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input));
  });
}
describe('local hook bridge fixtures without native tools', () => {
  it('writes a bounded native-shaped event and returns promptly without printing event content', async () => {
    const fixture = await setup();
    const result = await invokeBridge(bridgeConfigPath(fixture.directory, fixture.record.connection.id), { cwd: fixture.root, session_id: 'fixture-native', hook_event_name: 'Stop', last_assistant_message: 'Check completed. api_key=fixture-private' });
    expect(result).toEqual({ code: 0, stdout: '{}', stderr: '' });
    expect(readdirSync(fixture.spool)).toHaveLength(1); await fixture.drain();
    expect(fixture.store().snapshot().state.handoffs).toHaveLength(1); expect(JSON.stringify(fixture.store().snapshot())).not.toContain('fixture-private');
  });

  it('records unsupported payload and full-spool loss without creating unbounded marker files', async () => {
    const fixture = await setup(), config = bridgeConfigPath(fixture.directory, fixture.record.connection.id);
    const unsupported = await invokeBridge(config, { cwd: fixture.root, missing_session_id: true });
    expect(unsupported).toEqual({ code: 0, stdout: '{}', stderr: '' }); expect(existsSync(join(fixture.spool, 'source-diagnostic-missing-session-id'))).toBe(true);
    for (let index = 0; index < SPOOL_EVENT_LIMIT; index++) writeFileSync(join(fixture.spool, `${randomUUID()}.json`), '{}');
    const full = await invokeBridge(config, { cwd: fixture.root, session_id: 'fixture-native', hook_event_name: 'Stop', last_assistant_message: 'Must report the missing event.' });
    expect(full).toEqual({ code: 0, stdout: '{}', stderr: '' });
    expect(readdirSync(fixture.spool).filter(name => name.startsWith('coverage-gap'))).toEqual(['coverage-gap']);
    expect(readdirSync(fixture.spool).filter(name => name.endsWith('.json'))).toHaveLength(SPOOL_EVENT_LIMIT);
  });
});
