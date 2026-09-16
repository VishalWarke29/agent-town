import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ObservationEvent } from '@agent-town/contracts';
import { normalizeHook } from '../../apps/service/src/observation/normalize';
import { normalizeObservationPath, observationPathWithin, safeHookProjectPath, sameObservationPath } from '../../apps/service/src/observation/paths';
import { bridgeConfigPath, changeHooks, inspectObservationSetup, observationSetup, spoolPath, writeBridgeConfig } from '../../apps/service/src/observation/setup';
import { bridgeConfigSchema, parseSpoolEvent, resolveHookSource, type BridgeConfig } from '../../apps/service/src/observation/source-binding';
import type { RegisteredObservation } from '../../apps/service/src/observation/registry';
import { drainObservationSpool } from '../../apps/service/src/observation/spool';
import { privateState } from '../../apps/service/src/workspaces';
import { projectRoot, type Store } from '../../apps/service/src/store';

const directories: string[] = [];
const sourceId = '00000000-0000-4000-8000-000000000001';
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = realpathSync(directory), base = realpathSync(tmpdir()), remainder = relative(base, target);
    if (!remainder || remainder.startsWith('..') || isAbsolute(remainder) || !target.includes('agent-town-observation-v2-')) throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});

function fixture(provider: RegisteredObservation['connection']['provider'] = 'codex') {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-observation-v2-')); directories.push(directory);
  const root = join(directory, 'project'), home = join(directory, 'native-home'); mkdirSync(root); mkdirSync(home);
  const record: RegisteredObservation = { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace', repoPath: root, nativeHome: home,
    connection: { id: randomUUID(), provider, repoId: 'fixture-repo', label: 'Fixture', status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0, nativeSourceId: sourceId, sourceRevision: 3, binding: 'resolved' } };
  const vault = { available: true, get: async () => null, put: async () => {}, delete: async () => {} };
  const config = (): Extract<BridgeConfig, { version: 2 }> => ({ version: 2, connectionId: record.connection.id, provider, repoPath: root, spoolPath: spoolPath(directory, record.connection.id), nativeSourceId: sourceId, sourceRevision: 3, binding: 'resolved', nativeHome: home });
  return { directory, root, home, record, vault, config };
}

function writeConfiguration(path: string, value: unknown) {
  mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value));
}

function invokeBridge(path: string, input: object, environment: NodeJS.ProcessEnv, normalized = false) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(projectRoot, 'apps/service/src/observation/bridge.ts'), '--config', path, ...(normalized ? ['--normalized'] : ['--event', 'Stop'])], { cwd: projectRoot, env: { ...process.env, ...environment }, windowsHide: true, stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject); child.once('close', code => done({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input));
  });
}

describe('Windows hook project paths', () => {
  it('matches extended drive paths and drive casing without widening project scope', () => {
    expect(normalizeObservationPath(String.raw`\\?\C:\projects\Agent`)).toBe(String.raw`C:\projects\Agent`);
    expect(sameObservationPath(String.raw`\\?\C:\PROJECTS\Agent`, 'c:/projects/Agent')).toBe(true);
    expect(observationPathWithin('C:/projects/Agent', String.raw`\\?\C:\projects\Agent\src`)).toBe(true);
    expect(observationPathWithin('C:/projects/Agent', 'C:/projects/Agent-other')).toBe(false);
    expect(normalizeHook('codex', 'SessionStart', { cwd: String.raw`\\?\C:\fixture\Agent`, session_id: 'native-session' }, 'c:/fixture/Agent')?.sessionId).toBe('native-session');
  });

  it.each([String.raw`\\server\share\project`, String.raw`\\?\UNC\server\share`, String.raw`\\.\C:\project`, String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1`, 'C:relative', 'C:/project/../outside', 'C:/project/file:stream', 'C:/project/dir.', 'C:/project/NUL', '//server/share'])('rejects unsafe path %s', path => {
    expect(normalizeObservationPath(path)).toBeNull();
    expect(normalizeHook('codex', 'SessionStart', { cwd: path, session_id: 'native-session' }, 'C:/project')).toBeNull();
  });

  it('rejects a real junction escape, including an absent child below it', () => {
    const f = fixture(), outside = join(f.directory, 'outside'); mkdirSync(outside);
    const link = join(f.root, 'linked'); symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(safeHookProjectPath(f.root, link)).toBe(false);
    expect(safeHookProjectPath(f.root, join(link, 'not-created'))).toBe(false);
    expect(normalizeHook('codex', 'SessionStart', { cwd: link, session_id: 'native-session' }, f.root)).toBeNull();
  });
});

describe('versioned setup and exact entry ownership', () => {
  it('uses the installed Node executable and distinct VS Code and CLI schemas', () => {
    const codex = fixture('codex');
    expect(JSON.parse(observationSetup(codex.record, codex.directory).config).hooks.SessionEnd[0].hooks[0].timeout).toBe(2);
    const vscode = fixture('copilot-vscode'), cli = fixture('copilot-cli');
    const a = JSON.parse(observationSetup(vscode.record, vscode.directory).config), b = JSON.parse(observationSetup(cli.record, cli.directory).config);
    expect(a.version).toBeUndefined(); expect(a.hooks.SessionEnd).toBeUndefined();
    expect(a.hooks.SessionStart[0]).toMatchObject({ type: 'command', timeout: 5 });
    expect(a.hooks.SessionStart[0].timeoutSec).toBeUndefined(); expect(a.hooks.SessionStart[0].command.startsWith(`"${process.execPath.replaceAll('\\', '/')}" `)).toBe(true);
    expect(b.version).toBe(1); expect(b.hooks.sessionStart[0]).toMatchObject({ type: 'command', exec: process.execPath, timeoutSec: 5 });
    expect(b.hooks.sessionStart[0].args).toContain('--event'); expect(b.hooks.sessionStart[0].command).toBeUndefined(); expect(b.hooks.sessionStart[0].powershell).toBeUndefined();
  });

  it('migrates old bare-node entries and removes only exact app entries', async () => {
    const f = fixture('claude'), setup = observationSetup(f.record, f.directory), legacy = JSON.parse(setup.config);
    for (const entries of Object.values(legacy.hooks) as { hooks: { command: string }[] }[][]) for (const entry of entries) for (const hook of entry.hooks) hook.command = hook.command.replace(/^"[^"]+"/, 'node');
    const unrelated = { hooks: [{ type: 'command', command: 'echo preserve-user-hook' }] };
    const edited = { hooks: [{ type: 'command', command: `${legacy.hooks.Stop[0].hooks[0].command} --user-change` }] };
    legacy.hooks.Stop.push(unrelated, edited); writeConfiguration(setup.configPath, { env: { PRIVATE_FIXTURE: 'do-not-project' }, ...legacy });
    await changeHooks(f.record, f.directory, f.vault);
    const installed = JSON.parse(readFileSync(setup.configPath, 'utf8'));
    expect(installed.hooks.Stop).toHaveLength(3); expect(installed.hooks.Stop).toContainEqual(unrelated); expect(installed.hooks.Stop).toContainEqual(edited);
    expect((await inspectObservationSetup(f.record, f.directory)).readiness?.configured).toBe(true);
    await changeHooks(f.record, f.directory, f.vault, true);
    const removed = JSON.parse(readFileSync(setup.configPath, 'utf8'));
    expect(removed.hooks.Stop).toEqual([unrelated, edited]); expect(removed.env.PRIVATE_FIXTURE).toBe('do-not-project');
    expect(JSON.stringify(await inspectObservationSetup(f.record, f.directory))).not.toContain('do-not-project');
  });

  it('removes an exact previously recorded runtime path during upgrade', async () => {
    const f = fixture('claude'), setup = observationSetup(f.record, f.directory), previous = JSON.parse(setup.config);
    for (const entries of Object.values(previous.hooks) as { hooks: { command: string }[] }[][]) for (const entry of entries) for (const hook of entry.hooks) hook.command = hook.command.replace(/^"[^"]+"/, '"C:/previous-runtime/node.exe"');
    writeConfiguration(setup.configPath, previous);
    writeConfiguration(join(f.directory, 'observation/installed', `${f.record.connection.id}.json`), { version: 1, connectionId: f.record.connection.id, configurations: [previous] });
    await changeHooks(f.record, f.directory, f.vault);
    expect(readFileSync(setup.configPath, 'utf8')).not.toContain('previous-runtime');
    expect(JSON.parse(readFileSync(setup.configPath, 'utf8')).hooks.Stop).toHaveLength(1);
  });

  it('blocks the ambiguous compatible route while keeping the native Cursor route usable', async () => {
    const f = fixture('claude'), cursorRecord = { ...f.record, connection: { ...f.record.connection, id: randomUUID(), provider: 'cursor' as const } };
    writeConfiguration(observationSetup(f.record, f.directory).configPath, JSON.parse(observationSetup(f.record, f.directory).config));
    writeConfiguration(observationSetup(cursorRecord, f.directory).configPath, JSON.parse(observationSetup(cursorRecord, f.directory).config));
    expect((await inspectObservationSetup(f.record, f.directory)).diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_OVERLAP' }));
    expect(resolveHookSource(f.config(), { cwd: f.root, session_id: 'same-session' }, { CLAUDE_CONFIG_DIR: f.home })).toMatchObject({ blocked: true, diagnostic: 'hook-overlap' });
    expect(resolveHookSource({ ...f.config(), provider: 'cursor', connectionId: cursorRecord.connection.id }, { conversation_id: 'same-session', cursor_version: 'fixture', workspace_roots: [f.root] }, {})).toMatchObject({ blocked: false, fields: { producer: 'cursor' } });
  });
});

describe('native source identity and backwards-compatible replay', () => {
  it('keeps parent context and child aliases without replacing the legacy character key', () => {
    const f = fixture('claude');
    const event = normalizeHook('claude', 'SubagentStart', { cwd: f.root, session_id: 'parent:a', agent_id: 'child:b' }, f.root)!;
    expect(event.sessionId).toMatch(/^child-/); expect(event).toMatchObject({ nativeSessionId: 'parent:a', nativeParentSessionId: 'parent:a', nativeChildId: 'child:b', parentSessionId: 'parent:a' });
  });

  it('captures only a matching approved home and rejects a known wrong producer', () => {
    const f = fixture();
    expect(resolveHookSource(f.config(), {}, { CODEX_HOME: f.home })).toMatchObject({ blocked: false, fields: { nativeSourceId: sourceId, sourceRevision: 3 } });
    const mismatch = resolveHookSource(f.config(), {}, { CODEX_HOME: join(f.directory, 'different-home') });
    expect(mismatch).toMatchObject({ blocked: true, diagnostic: 'source-home-mismatch' }); expect(mismatch.fields.nativeSourceId).toBeUndefined();
    expect(JSON.stringify(mismatch)).not.toContain(f.home);
    expect(resolveHookSource(f.config(), { cursor_version: 'fixture', conversation_id: 'same-id', workspace_roots: [f.root] })).toMatchObject({ blocked: true, diagnostic: 'producer-mismatch' });
    expect(bridgeConfigSchema.safeParse({ ...f.config(), sourceRevision: 0 }).success).toBe(false);
  });

  it('runs the v2 bridge without exposing home, prompt, or secrets in its event or stdout', async () => {
    const f = fixture(); await writeBridgeConfig(f.record, f.directory);
    const result = await invokeBridge(bridgeConfigPath(f.directory, f.record.connection.id), { cwd: f.root, session_id: 'native-one', hook_event_name: 'Stop', prompt: 'PRIVATE_PROMPT', last_assistant_message: 'Done. api_key=PRIVATE_KEY' }, { CODEX_HOME: f.home });
    expect(result).toEqual({ code: 0, stdout: '{}', stderr: '' });
    const files = readdirSync(spoolPath(f.directory, f.record.connection.id)); expect(files).toHaveLength(1);
    const serialized = readFileSync(join(spoolPath(f.directory, f.record.connection.id), files[0]!), 'utf8'), envelope = JSON.parse(serialized);
    expect(envelope.version).toBe(2); expect(parseSpoolEvent(envelope)).toMatchObject({ nativeSourceId: sourceId, sourceRevision: 3, nativeSessionId: 'native-one', kind: 'turn.end' });
    expect(serialized).not.toContain('PRIVATE_PROMPT'); expect(serialized).not.toContain('PRIVATE_KEY'); expect(serialized).not.toContain('native-home');
  });

  it('accepts a declared source after its real runtime home matches and isolates another home', () => {
    const f = fixture(), declared = { ...f.config(), binding: 'declared' as const };
    expect(resolveHookSource(declared, {}, { CODEX_HOME: f.home }).fields.nativeSourceId).toBe(sourceId);
    expect(resolveHookSource({ ...declared, nativeHome: join(f.directory, 'another-home') }, {}, { CODEX_HOME: f.home })).toMatchObject({ blocked: true, diagnostic: 'source-home-mismatch' });
  });

  it.each(['bound', 'unbound'])('blocks a %s v2 VS Code compatible receipt when its invoking tool is unidentified', async scope => {
    const f = fixture('copilot-vscode');
    if (scope === 'unbound') { delete f.record.connection.nativeSourceId; delete f.record.connection.sourceRevision; delete f.record.connection.binding; delete f.record.nativeHome; }
    await writeBridgeConfig(f.record, f.directory);
    expect(await invokeBridge(bridgeConfigPath(f.directory, f.record.connection.id), { cwd: f.root, session_id: 'compatible-session', hook_event_name: 'Stop', last_assistant_message: 'PRIVATE_UNATTRIBUTED_REPORT' }, {})).toEqual({ code: 0, stdout: '{}', stderr: '' });
    const spool = spoolPath(f.directory, f.record.connection.id);
    expect(readdirSync(spool)).toEqual(['source-diagnostic-source-ambiguous']);
    const state = privateState({ id: 'fixture-workspace', name: 'Fixture', kind: 'personal' }); state.observation = { connections: [f.record.connection] };
    const store = { snapshot: () => ({ cursor: 0, state }), commit: (_id: string, mutate: (current: typeof state, now: string) => unknown) => { mutate(state, new Date().toISOString()); return {}; } } as unknown as Store;
    const received: ObservationEvent[] = [];
    await drainObservationSpool({ directory: f.directory, spool, record: f.record, store, receive: events => received.push(...events), closing: () => false });
    expect(received).toEqual([]); expect(state.observation.connections[0]?.binding).toBe('ambiguous');
    expect(state.observation.connections[0]?.diagnostics).toContainEqual(expect.objectContaining({ code: 'source-ambiguous', message: expect.stringContaining('receipts without an identified tool are not accepted') }));
    expect(JSON.stringify(state)).not.toContain('PRIVATE_UNATTRIBUTED_REPORT');
  });

  it('keeps a v2 native Cursor receipt connection-scoped without inventing its profile', async () => {
    const f = fixture('cursor'); await writeBridgeConfig(f.record, f.directory);
    expect(await invokeBridge(bridgeConfigPath(f.directory, f.record.connection.id), { conversation_id: 'cursor-session', cursor_version: 'fixture', workspace_roots: [f.root], hook_event_name: 'stop' }, {})).toEqual({ code: 0, stdout: '{}', stderr: '' });
    const spool = spoolPath(f.directory, f.record.connection.id), files = readdirSync(spool);
    expect(files).toContain('source-diagnostic-source-ambiguous');
    const events = files.filter(name => name.endsWith('.json')); expect(events).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(join(spool, events[0]!), 'utf8')), saved = parseSpoolEvent(envelope);
    expect(envelope.version).toBe(2); expect(saved).toMatchObject({ producer: 'cursor', sessionId: 'cursor-session', nativeSessionId: 'cursor-session', kind: 'turn.end' });
    expect(saved?.nativeSourceId).toBeUndefined(); expect(saved?.sourceRevision).toBeUndefined();
  });

  it.each(['codex', 'copilot-vscode'] as const)('keeps an existing v1 %s bridge configuration and its bare spool event readable', async provider => {
    const f = fixture(provider); await writeBridgeConfig(f.record, f.directory);
    const config = bridgeConfigPath(f.directory, f.record.connection.id);
    writeFileSync(config, JSON.stringify({ version: 1, connectionId: f.record.connection.id, provider, repoPath: f.root, spoolPath: spoolPath(f.directory, f.record.connection.id) }));
    expect(await invokeBridge(config, { cwd: f.root, session_id: 'legacy-native', hook_event_name: 'Stop' }, {})).toEqual({ code: 0, stdout: '{}', stderr: '' });
    const files = readdirSync(spoolPath(f.directory, f.record.connection.id)); expect(files).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(spoolPath(f.directory, f.record.connection.id), files[0]!), 'utf8'));
    expect(saved.version).toBeUndefined(); expect(parseSpoolEvent(saved)).toMatchObject({ sessionId: 'legacy-native', kind: 'turn.end' }); expect(saved.nativeSourceId).toBeUndefined();
  });

  it('persists an overlap diagnostic without accepting or printing a misleading report', async () => {
    const f = fixture('claude'); await writeBridgeConfig(f.record, f.directory);
    const cursor = { ...f.record, connection: { ...f.record.connection, provider: 'cursor' as const, id: randomUUID() } };
    writeConfiguration(observationSetup(cursor, f.directory).configPath, JSON.parse(observationSetup(cursor, f.directory).config));
    expect(await invokeBridge(bridgeConfigPath(f.directory, f.record.connection.id), { cwd: f.root, session_id: 'ambiguous-native', hook_event_name: 'Stop', last_assistant_message: 'PRIVATE_AMBIGUOUS_REPORT' }, { CLAUDE_CONFIG_DIR: f.home })).toEqual({ code: 0, stdout: '{}', stderr: '' });
    const spool = spoolPath(f.directory, f.record.connection.id); expect(readdirSync(spool)).toEqual(['source-diagnostic-hook-overlap']);
    const state = privateState({ id: 'fixture-workspace', name: 'Fixture', kind: 'personal' }); state.observation = { connections: [f.record.connection] };
    const store = { snapshot: () => ({ cursor: 0, state }), commit: (_id: string, mutate: (current: typeof state, now: string) => unknown) => { mutate(state, new Date().toISOString()); return {}; } } as unknown as Store;
    const received: ObservationEvent[] = [];
    await drainObservationSpool({ directory: f.directory, spool, record: f.record, store, receive: events => received.push(...events), closing: () => false });
    expect(received).toEqual([]); expect(state.observation.connections[0]).toMatchObject({ binding: 'ambiguous', droppedEvents: 1, droppedEventsExact: false });
    expect(state.activity.some(item => item.message.includes('Overlapping Agent Town callbacks'))).toBe(true); expect(JSON.stringify(state)).not.toContain('PRIVATE_AMBIGUOUS_REPORT');
  });

  it('publishes custom normalized events using registered scope without a credential in the command', async () => {
    const f = fixture('custom'); await writeBridgeConfig(f.record, f.directory);
    const setup = observationSetup(f.record, f.directory);
    expect(setup.bridgeCommand).toContain('--normalized'); expect(setup.configPath).toBe('');
    await expect(changeHooks(f.record, f.directory, f.vault)).rejects.toMatchObject({ code: 'CUSTOM_HOOK_UNSUPPORTED' });
    const event = { id: 'custom-retry-stable', sessionId: 'custom-session', kind: 'report', occurredAt: new Date().toISOString(), nativeSourceId: '00000000-0000-4000-8000-000000000099', sourceRevision: 99, producer: 'codex', summary: 'api_key=PRIVATE_CUSTOM', files: ['src/check.ts', '../outside', '.env'] };
    expect(await invokeBridge(bridgeConfigPath(f.directory, f.record.connection.id), event, {}, true)).toEqual({ code: 0, stdout: '{}', stderr: '' });
    const files = readdirSync(spoolPath(f.directory, f.record.connection.id)); expect(files).toHaveLength(1);
    const saved = parseSpoolEvent(JSON.parse(readFileSync(join(spoolPath(f.directory, f.record.connection.id), files[0]!), 'utf8')));
    expect(saved).toMatchObject({ id: 'custom-retry-stable', nativeSessionId: 'custom-session', nativeSourceId: sourceId, sourceRevision: 3, producer: 'custom', files: ['src/check.ts'] });
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_CUSTOM');
  });

  it('replays old events and v2 captured source metadata without rebinding at replay time', async () => {
    const f = fixture(); await writeBridgeConfig(f.record, f.directory);
    const spool = spoolPath(f.directory, f.record.connection.id), now = new Date().toISOString();
    const legacy: ObservationEvent = { id: 'legacy-event', sessionId: 'legacy-session', kind: 'session.start', occurredAt: now };
    const captured: ObservationEvent = { id: 'v2-event', sessionId: 'new-session', kind: 'turn.end', occurredAt: now, nativeSourceId: '00000000-0000-4000-8000-000000000002', sourceRevision: 1, nativeSessionId: 'native-new' };
    writeFileSync(join(spool, `${randomUUID()}.json`), JSON.stringify(legacy)); writeFileSync(join(spool, `${randomUUID()}.json`), JSON.stringify({ version: 2, event: captured }));
    const state = privateState({ id: 'fixture-workspace', name: 'Fixture', kind: 'personal' }); state.observation = { connections: [f.record.connection] };
    const store = { snapshot: () => ({ cursor: 0, state }), commit: (_id: string, mutate: (current: typeof state, now: string) => unknown) => { mutate(state, now); return {}; } } as unknown as Store;
    const received: ObservationEvent[] = [];
    await drainObservationSpool({ directory: f.directory, spool, record: f.record, store, receive: events => received.push(...events), closing: () => false });
    expect(received).toContainEqual(legacy); expect(received).toContainEqual(captured); expect(readdirSync(spool)).toEqual([]);
    expect(parseSpoolEvent({ version: 3, event: captured })).toBeNull();
  });
});
