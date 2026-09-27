import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { RETAINED_AGENT_LIMIT, SERVICE_CAPABILITIES_FILE, STOP_SYNCING_CONNECTION_CAP, stopSyncingSteps, type ObservationEvent, type StopSyncingStep } from '@agent-town/contracts';
import { IdentityError, type CredentialVault } from '../../apps/service/src/identity/index';
import { MAX_PROTECTED_VALUE_BYTES, WindowsDpapiVault } from '../../apps/service/src/identity/vault';
import { HOOK_BACKUPS_KEPT_PER_FILE, bridgeConfigPath, changeHooks, cleanupConnectionFiles, neutralizeConnection, observationSetup, spoolPath, writeBridgeConfig, __setHookBridgePathForTests, __setRenameForTests, __setUnlinkForTests } from '../../apps/service/src/observation/setup';
import { SPOOL_BATCH_LIMIT } from '../../apps/service/src/observation/spool-limits';
import { drainMutex, finalDrainConnection, __setFinalDrainBudgetForTests } from '../../apps/service/src/observation/spool';
import { applyObservation } from '../../apps/service/src/observation/reducer';
import type { RegisteredObservation } from '../../apps/service/src/observation/registry';
import { registerObservationApi, __setStopSyncingStepHookForTests } from '../../apps/service/src/observation/service';
import { Store, projectRoot } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { initialWorkflow } from '../../apps/service/src/workflow/budget';
import { modelSpy } from '../helpers';
import { runShutdown, stepsJob } from '../helpers/shutdown-deadline';

// H0-10: removing Agent Town's tracking entries is safe and honest (Stop watching builds on it in H0-13). Every test
// here uses a temporary project, a temporary data folder and a fake vault with the real vault's 16,000-byte cap. Nothing
// touches the owner's tool files, data folder or credential vault, and the hook bridge is a stand-in file.

const directories: string[] = [];
afterEach(() => {
  __setRenameForTests(null); __setUnlinkForTests(null); __setHookBridgePathForTests(null); __setFinalDrainBudgetForTests(null); __setStopSyncingStepHookForTests(null); vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const target = realpathSync(directory), base = realpathSync(tmpdir()), remainder = relative(base, target);
    if (!remainder || remainder.startsWith('..') || isAbsolute(remainder) || !target.includes('agent-town-stop-syncing-')) throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});

type Provider = RegisteredObservation['connection']['provider'];
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-stop-syncing-')); directories.push(directory);
  const root = join(directory, 'project'), data = join(directory, 'data'), bridge = join(directory, 'bridge', 'hook-bridge.cjs');
  mkdirSync(root); mkdirSync(data); mkdirSync(dirname(bridge)); writeFileSync(bridge, '// stand-in for the built hook bridge\n');
  __setHookBridgePathForTests(bridge);
  const connect = (provider: Provider, id: string = randomUUID()): RegisteredObservation => ({ ownerId: 'owner', workspaceId: 'workspace', repoPath: root,
    connection: { id, provider, repoId: 'repo-one', label: 'Fixture', status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0 } });
  const pathOf = (record: RegisteredObservation) => observationSetup(record, data).configPath;
  return { directory, root, data, connect, pathOf };
}
type Workspace = ReturnType<typeof workspace>;

/** A fake vault that refuses what the real one refuses (empty, or over 16,000 bytes) and records every put. */
function cappedVault() {
  const stored = new Map<string, string>(), puts: string[] = [];
  const vault: CredentialVault = { available: true,
    put: async (reference, value) => { puts.push(reference); if (!value || Buffer.byteLength(value) > 16_000) throw new IdentityError('credential_invalid', 'Invalid protected credential value.'); stored.set(reference, value); },
    get: async reference => stored.get(reference) ?? null,
    delete: async reference => { stored.delete(reference); } };
  return { vault, stored, puts };
}

const userHook = (label: string) => ({ hooks: [{ type: 'command', command: `echo ${label}` }] });
const settingsText = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function writeHookFile(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
/** Every path below a folder, sorted, folders marked with a slash: what "created nothing" is checked against. */
function listTree(folder: string, base = folder): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const full = join(folder, entry.name), name = relative(base, full).replaceAll('\\', '/');
    return entry.isDirectory() ? [`${name}/`, ...listTree(full, base)] : [name];
  }).sort();
}
const backupPointers = (data: string) => { const folder = join(data, 'observation', 'backups'); return existsSync(folder) ? readdirSync(folder).map(name => ({ name, ...JSON.parse(readFileSync(join(folder, name), 'utf8')) as { at: string; reference: string; action: string; connectionId: string; file?: string } })) : []; };
const installedRecord = (data: string, id: string) => { const path = join(data, 'observation', 'installed', `${id}.json`); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { createdFile?: boolean; configurations: unknown[] } : null; };
const ownEntryCount = (w: Workspace, record: RegisteredObservation) => Object.keys((JSON.parse(observationSetup(record, w.data).config) as { hooks: object }).hooks).length;
const oldTime = new Date('2020-01-02T03:04:05Z');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('removal creates nothing and rewrites nothing it did not change', () => {
  it.each([
    ['a missing settings file in an existing folder', 'codex', (w: Workspace) => mkdirSync(join(w.root, '.codex'))],
    ['a missing tool folder', 'codex', () => undefined],
    ['a missing project folder', 'codex', (w: Workspace) => rmSync(w.root, { recursive: true })],
    ['a missing shared hook folder for Copilot', 'copilot-cli', () => undefined],
    ['a missing Claude Code folder', 'claude', () => undefined],
  ] as const)('%s: nothing is created, no backup is written', async (_name, provider, arrange) => {
    const w = workspace(), { vault, puts } = cappedVault(), record = w.connect(provider);
    arrange(w);
    const before = listTree(w.directory);
    const result = await changeHooks(record, w.data, vault, true);
    expect(result).toEqual({ changed: false, path: w.pathOf(record), removed: false, removedEntries: 0, residualEntries: 0, file: 'missing' });
    expect(listTree(w.directory)).toEqual(before);
    expect(puts).toEqual([]);
  });

  it('a second identical removal changes no bytes and no modified time and makes no new backup', async () => {
    const w = workspace(), { vault, stored, puts } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record);
    writeHookFile(path, settingsText({ permissions: { allow: ['Read'] }, hooks: { Stop: [userHook('keep-me')] } }));
    await changeHooks(record, w.data, vault);
    const first = await changeHooks(record, w.data, vault, true);
    expect(first).toMatchObject({ changed: true, removed: true, removedEntries: ownEntryCount(w, record), residualEntries: 0, file: 'edited' });
    const afterFirst = { pointers: backupPointers(w.data).length, vaultEntries: stored.size, puts: puts.length };
    utimesSync(path, oldTime, oldTime);
    const bytes = readFileSync(path), modified = statSync(path).mtimeMs;
    const second = await changeHooks(record, w.data, vault, true);
    expect(second).toEqual({ changed: false, path, removed: false, removedEntries: 0, residualEntries: 0, file: 'unchanged' });
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(modified);
    expect({ pointers: backupPointers(w.data).length, vaultEntries: stored.size, puts: puts.length }).toEqual(afterFirst);
  });

  it('a file with no entry of Agent Town\'s is left alone, however big or odd it is', async () => {
    const w = workspace(), { vault, puts } = cappedVault(), record = w.connect('codex'), path = w.pathOf(record);
    const big = settingsText({ pad: 'x'.repeat(20_000), hooks: { Stop: [userHook('mine')] } });
    for (const text of [big, '', '  \n', settingsText({}), settingsText({ hooks: { Stop: 'not a list' } }), settingsText({ hooks: [] })]) {
      writeHookFile(path, text); utimesSync(path, oldTime, oldTime);
      const modified = statSync(path).mtimeMs;
      expect(await changeHooks(record, w.data, vault, true)).toMatchObject({ changed: false, removed: false, removedEntries: 0, file: 'unchanged' });
      expect(readFileSync(path, 'utf8')).toBe(text); expect(statSync(path).mtimeMs).toBe(modified);
    }
    expect(puts).toEqual([]); expect(existsSync(join(w.data, 'observation', 'backups'))).toBe(false);
  });
});

describe('what survives a removal, and what is reported', () => {
  it('with Claude Code and Codex both connected, removing one leaves the other tool and every unrelated setting alone, and drops only the events it emptied', async () => {
    const w = workspace(), { vault } = cappedVault(), claude = w.connect('claude'), codex = w.connect('codex');
    const claudeOriginal = { env: { KEEP: 'yes' }, permissions: { allow: ['Read'] }, hooks: { Stop: [userHook('claude-stop')], Notification: [] } };
    const codexOriginal = { model: 'keep-me', hooks: { Stop: [userHook('codex-stop')] } };
    writeHookFile(w.pathOf(claude), settingsText(claudeOriginal)); writeHookFile(w.pathOf(codex), settingsText(codexOriginal));
    await changeHooks(claude, w.data, vault); await changeHooks(codex, w.data, vault);
    utimesSync(w.pathOf(codex), oldTime, oldTime);
    const codexBytes = readFileSync(w.pathOf(codex)), codexModified = statSync(w.pathOf(codex)).mtimeMs;

    const result = await changeHooks(claude, w.data, vault, true);
    expect(result).toMatchObject({ removed: true, removedEntries: ownEntryCount(w, claude), residualEntries: 0, file: 'edited' });
    const parsed = JSON.parse(readFileSync(w.pathOf(claude), 'utf8')) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(parsed)).toEqual(['env', 'permissions', 'hooks']);
    expect(Object.keys(parsed.hooks)).toEqual(['Stop', 'Notification']);   // events Agent Town emptied are gone; the person's empty one stays
    expect(readFileSync(w.pathOf(claude), 'utf8')).toBe(settingsText(claudeOriginal));
    expect(readFileSync(w.pathOf(codex)).equals(codexBytes)).toBe(true); expect(statSync(w.pathOf(codex)).mtimeMs).toBe(codexModified);

    expect(await changeHooks(codex, w.data, vault, true)).toMatchObject({ removed: true, removedEntries: ownEntryCount(w, codex), file: 'edited' });
    expect(readFileSync(w.pathOf(codex), 'utf8')).toBe(settingsText(codexOriginal));
  });

  it('two connections of one tool in one file: each removal takes only its own entries and counts the other connection\'s as residual, without command text', async () => {
    const w = workspace(), { vault } = cappedVault(), first = w.connect('claude'), second = w.connect('claude'), path = w.pathOf(first);
    expect(w.pathOf(second)).toBe(path);
    const original = { permissions: { allow: ['Read'] }, hooks: { Stop: [userHook('keep-me')] } };
    writeHookFile(path, settingsText(original));
    await changeHooks(first, w.data, vault); await changeHooks(second, w.data, vault);
    const count = ownEntryCount(w, first);

    const removedSecond = await changeHooks(second, w.data, vault, true);
    expect(removedSecond).toMatchObject({ removed: true, removedEntries: count, residualEntries: count, file: 'edited' });
    expect(JSON.stringify(removedSecond)).not.toMatch(/hook-bridge|--config|--event|echo|node/);
    const left = JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, unknown[]> };
    const firstEntries = (JSON.parse(observationSetup(first, w.data).config) as { hooks: Record<string, unknown[]> }).hooks;
    for (const [event, entries] of Object.entries(firstEntries)) expect(left.hooks[event]).toEqual([...(event === 'Stop' ? [userHook('keep-me')] : []), ...entries]);

    expect(await changeHooks(first, w.data, vault, true)).toMatchObject({ removed: true, removedEntries: count, residualEntries: 0 });
    expect(readFileSync(path, 'utf8')).toBe(settingsText(original));
  });

  it('entries it does not recognise are counted, never removed, and never printed', async () => {
    const w = workspace(), { vault } = cappedVault(), mine = w.connect('claude'), other = w.connect('claude'), path = w.pathOf(mine);
    writeHookFile(path, settingsText({ hooks: {} }));
    await changeHooks(mine, w.data, vault); await changeHooks(other, w.data, vault);
    const otherStop = (JSON.parse(observationSetup(other, w.data).config) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks.Stop![0]!;
    const mineStop = (JSON.parse(observationSetup(mine, w.data).config) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks.Stop![0]!;
    const edited = { hooks: [{ type: 'command', command: `${mineStop.hooks[0]!.command} --user-change` }] };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, unknown[]> };
    parsed.hooks.Stop!.push(edited, userHook('keep-me')); writeHookFile(path, settingsText(parsed));

    const result = await changeHooks(mine, w.data, vault, true);
    const count = ownEntryCount(w, mine);
    // The other connection's ten entries plus the one edited lookalike are all still there, and all counted.
    expect(result).toMatchObject({ removed: true, removedEntries: count, residualEntries: count + 1, file: 'edited' });
    const after = JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, unknown[]> };
    expect(after.hooks.Stop).toEqual([otherStop, edited, userHook('keep-me')]);
    for (const text of [JSON.stringify(result), JSON.stringify(Object.keys(result))]) { expect(text).not.toContain('hook-bridge'); expect(text).not.toContain('--user-change'); }
  });

  it('an unreadable install record no longer blocks a removal: it removes what it recognises, counts the rest, and never deletes the file', async () => {
    const w = workspace(), { vault } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record);
    await changeHooks(record, w.data, vault);   // Agent Town creates the file
    const older = JSON.parse(observationSetup(record, w.data).config) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const current = readFileSync(path, 'utf8');
    for (const entries of Object.values(older.hooks)) for (const entry of entries) for (const hook of entry.hooks) hook.command = hook.command.replace(/^"[^"]+"/, '"C:/previous-runtime/node.exe"');
    const merged = JSON.parse(current) as { hooks: Record<string, unknown[]> };
    for (const [event, entries] of Object.entries(older.hooks)) merged.hooks[event]!.push(...entries);
    writeHookFile(path, settingsText(merged));
    writeFileSync(join(w.data, 'observation', 'installed', `${record.connection.id}.json`), '{ this record is damaged');

    await expect(changeHooks(record, w.data, vault)).rejects.toMatchObject({ code: 'HOOK_MANIFEST_UNSAFE' });   // an apply still refuses
    const result = await changeHooks(record, w.data, vault, true);
    const count = ownEntryCount(w, record);
    expect(result).toMatchObject({ removed: true, removedEntries: count, residualEntries: count, file: 'edited' });   // the older-runtime entries stay, and are counted
    expect(existsSync(path)).toBe(true);
    expect(JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))).toContain('previous-runtime');
  });

  it('removal does not refuse over a version, or a hook event that is not a list, that is not about its own entries', async () => {
    const w = workspace(), { vault } = cappedVault(), cursor = w.connect('cursor');
    const applied = JSON.parse(observationSetup(cursor, w.data).config) as { version: number; hooks: Record<string, unknown[]> };
    writeHookFile(w.pathOf(cursor), settingsText({ ...applied, version: 2, hooks: { ...applied.hooks, sessionEnd: 'not a list' } }));
    await expect(changeHooks(cursor, w.data, vault)).rejects.toMatchObject({ code: 'HOOK_CONFIG_INVALID' });   // an apply still refuses
    writeHookFile(w.pathOf(cursor), settingsText({ ...applied, version: 2 }));
    await expect(changeHooks(cursor, w.data, vault)).rejects.toMatchObject({ code: 'HOOK_VERSION_UNSUPPORTED' });   // and so does a version it does not write
    writeHookFile(w.pathOf(cursor), settingsText({ ...applied, version: 2, hooks: { ...applied.hooks, sessionEnd: 'not a list' } }));
    const result = await changeHooks(cursor, w.data, vault, true);
    // Six of the seven events held an entry of ours; the seventh is not a list, so it holds nothing Agent Town could have written.
    expect(result).toMatchObject({ removed: true, removedEntries: ownEntryCount(w, cursor) - 1, residualEntries: 0, file: 'edited' });
    expect(JSON.parse(readFileSync(w.pathOf(cursor), 'utf8'))).toEqual({ version: 2, hooks: { sessionEnd: 'not a list' } });
  });

  it('a file that is not valid JSON stops the removal in words about removing, and changes nothing', async () => {
    const w = workspace(), { vault, puts } = cappedVault(), record = w.connect('codex'), path = w.pathOf(record);
    writeHookFile(path, '{ "hooks": '); const before = listTree(w.directory);
    const error = await changeHooks(record, w.data, vault, true).catch((caught: unknown) => caught) as IdentityError;
    expect(error).toMatchObject({ code: 'HOOK_CONFIG_INVALID', statusCode: 409 });
    expect(error.message).not.toContain('applying');
    expect(readFileSync(path, 'utf8')).toBe('{ "hooks": '); expect(listTree(w.directory)).toEqual(before); expect(puts).toEqual([]);
  });
});

describe('a file too big to back up is refused before anything is written', () => {
  const padded = (base: unknown, size: number) => {
    const empty = settingsText({ ...(base as object), pad: '' });
    return settingsText({ ...(base as object), pad: 'x'.repeat(size - Buffer.byteLength(empty)) });
  };

  it('an apply refuses a settings file over the limit with a typed, plain answer and writes nothing', async () => {
    const w = workspace(), { vault, puts } = cappedVault(), record = w.connect('codex'), path = w.pathOf(record);
    const text = padded({ hooks: { Stop: [userHook('mine')] } }, 16_001);
    expect(Buffer.byteLength(text)).toBe(16_001);
    writeHookFile(path, text); const before = listTree(w.directory);
    const error = await changeHooks(record, w.data, vault).catch((caught: unknown) => caught) as IdentityError;
    expect(error).toMatchObject({ code: 'HOOK_BACKUP_TOO_LARGE', statusCode: 409 });
    expect(error.message).toMatch(/too big/); expect(error.message).toContain('16,000'); expect(error.message).not.toMatch(/credential|vault|protected|DPAPI/i);
    expect(readFileSync(path, 'utf8')).toBe(text); expect(listTree(w.directory)).toEqual(before); expect(puts).toEqual([]);
    expect(existsSync(join(w.data, 'observation'))).toBe(false);
  });

  it('a removal refuses it too, offers to stop without editing the file, and leaves the file, the record and the backups as they were', async () => {
    const w = workspace(), { vault, puts, stored } = cappedVault(), record = w.connect('codex'), path = w.pathOf(record);
    await changeHooks(record, w.data, vault);
    const applied = JSON.parse(readFileSync(path, 'utf8')) as object, text = padded(applied, 16_001);
    writeHookFile(path, text);
    const before = listTree(w.directory), recordBefore = readFileSync(join(w.data, 'observation', 'installed', `${record.connection.id}.json`), 'utf8'), putsBefore = puts.length, pointers = backupPointers(w.data).length;
    const error = await changeHooks(record, w.data, vault, true).catch((caught: unknown) => caught) as IdentityError;
    expect(error).toMatchObject({ code: 'HOOK_BACKUP_TOO_LARGE', statusCode: 409 });
    expect(error.message).toContain('stop watching without editing this file'); expect(error.message).not.toMatch(/credential|vault|protected|DPAPI/i);
    expect(readFileSync(path, 'utf8')).toBe(text); expect(listTree(w.directory)).toEqual(before);
    expect(readFileSync(join(w.data, 'observation', 'installed', `${record.connection.id}.json`), 'utf8')).toBe(recordBefore);
    expect(puts.length).toBe(putsBefore); expect(backupPointers(w.data).length).toBe(pointers); expect(stored.size).toBe(pointers);
  });

  it('the limit is exact: 16,000 bytes is backed up and removed, 16,001 is refused', async () => {
    for (const [size, refused] of [[16_000, false], [16_001, true]] as const) {
      const w = workspace(), { vault, stored } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record);
      await changeHooks(record, w.data, vault);
      const text = padded(JSON.parse(readFileSync(path, 'utf8')), size);
      expect(Buffer.byteLength(text)).toBe(size); writeHookFile(path, text);
      const attempt = changeHooks(record, w.data, vault, true);
      if (refused) { await expect(attempt).rejects.toMatchObject({ code: 'HOOK_BACKUP_TOO_LARGE' }); expect(readFileSync(path, 'utf8')).toBe(text); }
      else { await expect(attempt).resolves.toMatchObject({ removed: true, file: 'edited' }); expect([...stored.values()]).toContain(text); }
    }
  });

  it('an apply that would leave a file too big to back up is refused before anything is written, so Agent Town never puts entries where it could not take them out again', async () => {
    const w = workspace(), { vault, puts } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record);
    // Agent Town's own entries add a fixed number of bytes to any file. Measure them, then find the biggest padding whose
    // file is exactly 16,000 bytes after an apply. Its own size before the apply is far below the limit.
    writeHookFile(path, settingsText({ pad: '' }));
    await changeHooks(record, w.data, vault);
    const withoutPadding = Buffer.byteLength(readFileSync(path, 'utf8')), fits = MAX_PROTECTED_VALUE_BYTES - withoutPadding;
    expect(fits).toBeGreaterThan(5_000);

    writeHookFile(path, settingsText({ pad: 'x'.repeat(fits) }));
    expect(Buffer.byteLength(readFileSync(path, 'utf8'))).toBeLessThan(MAX_PROTECTED_VALUE_BYTES - 4_000);
    await expect(changeHooks(record, w.data, vault)).resolves.toMatchObject({ file: 'edited' });
    expect(Buffer.byteLength(readFileSync(path, 'utf8'))).toBe(16_000);
    await expect(changeHooks(record, w.data, vault, true)).resolves.toMatchObject({ removed: true, file: 'edited' });   // and it can be taken out again

    const text = settingsText({ pad: 'x'.repeat(fits + 1) });
    writeHookFile(path, text); const before = listTree(w.directory), putsBefore = puts.length;
    const recordBefore = readFileSync(join(w.data, 'observation', 'installed', `${record.connection.id}.json`), 'utf8');
    const error = await changeHooks(record, w.data, vault).catch((caught: unknown) => caught) as IdentityError;
    expect(error).toMatchObject({ code: 'HOOK_BACKUP_TOO_LARGE', statusCode: 409 });
    expect(error.message).toContain('too big'); expect(error.message).toContain('16,000'); expect(error.message).toContain('stop watching'); expect(error.message).not.toMatch(/credential|vault|protected|DPAPI/i);
    expect(readFileSync(path, 'utf8')).toBe(text); expect(listTree(w.directory)).toEqual(before); expect(puts.length).toBe(putsBefore);
    expect(readFileSync(join(w.data, 'observation', 'installed', `${record.connection.id}.json`), 'utf8')).toBe(recordBefore);
  });

  it('a file too big even to read is also refused as too big, for an apply and for a removal', async () => {
    const w = workspace(), { vault, puts } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record);
    const text = settingsText({ pad: 'x'.repeat(130_000), hooks: { Stop: [userHook('mine')] } });
    writeHookFile(path, text);
    await expect(changeHooks(record, w.data, vault)).rejects.toMatchObject({ code: 'HOOK_BACKUP_TOO_LARGE' });
    await expect(changeHooks(record, w.data, vault, true)).rejects.toMatchObject({ code: 'HOOK_BACKUP_TOO_LARGE' });
    expect(readFileSync(path, 'utf8')).toBe(text); expect(puts).toEqual([]);
  });

  it('is the vault\'s own limit: one number, enforced by the real vault before it touches anything', async () => {
    expect(MAX_PROTECTED_VALUE_BYTES).toBe(16_000);
    const w = workspace(), real = new WindowsDpapiVault(join(w.directory, 'unused-vault'));
    await expect(real.put(`hook-backup-${randomUUID()}`, 'x'.repeat(MAX_PROTECTED_VALUE_BYTES + 1))).rejects.toMatchObject({ code: 'credential_invalid' });
    expect(existsSync(join(w.directory, 'unused-vault'))).toBe(false);   // it refused before creating its folder or starting any process
  });
});

describe('a file is deleted only when Agent Town created it and nothing else is in it', () => {
  it('an apply that finds no file records that it created one; an apply that finds a file does not, and a later apply never withdraws it', async () => {
    const w = workspace(), { vault } = cappedVault(), created = w.connect('codex'), existing = w.connect('claude');
    await changeHooks(created, w.data, vault);
    expect(installedRecord(w.data, created.connection.id)).toMatchObject({ createdFile: true });
    writeHookFile(w.pathOf(existing), settingsText({}));
    await changeHooks(existing, w.data, vault);
    expect(installedRecord(w.data, existing.connection.id)?.createdFile).toBeUndefined();
    await changeHooks(created, w.data, vault);   // the file exists now, and still counts as created by Agent Town
    expect(installedRecord(w.data, created.connection.id)).toMatchObject({ createdFile: true });
  });

  it('deletes a file Agent Town created once its entries are out, after backing it up, and forgets the flag', async () => {
    const w = workspace(), { vault, stored } = cappedVault(), record = w.connect('codex'), path = w.pathOf(record);
    const applied = await changeHooks(record, w.data, vault);
    expect(applied).toMatchObject({ file: 'created', removed: false });
    const text = readFileSync(path, 'utf8');
    const result = await changeHooks(record, w.data, vault, true);
    expect(result).toEqual({ changed: true, path, removed: true, removedEntries: ownEntryCount(w, record), residualEntries: 0, file: 'deleted' });
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dirname(path)).filter(name => name.endsWith('.tmp'))).toEqual([]);   // no leftover moved-aside copy
    expect([...stored.values()]).toEqual([text]);   // what was deleted is in the backup
    expect(installedRecord(w.data, record.connection.id)?.createdFile).toBeUndefined();
    expect(await changeHooks(record, w.data, vault, true)).toMatchObject({ changed: false, removed: false, file: 'missing' });
  });

  it('keeps a file that was there before Agent Town, even one that held nothing, with only its own entries out', async () => {
    for (const before of [settingsText({}), settingsText({ hooks: {} }), '', '{}']) {
      const w = workspace(), { vault } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record);
      writeHookFile(path, before);
      await changeHooks(record, w.data, vault);
      const result = await changeHooks(record, w.data, vault, true);
      expect(result).toMatchObject({ removed: true, file: 'edited', changed: true });
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ hooks: {} });
      expect(installedRecord(w.data, record.connection.id)?.createdFile).toBeUndefined();
    }
  });

  it('keeps a file Agent Town created once the person has put anything else in it', async () => {
    const w = workspace(), { vault } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record);
    await changeHooks(record, w.data, vault);
    const withSetting = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; withSetting.permissions = { allow: ['Read'] };
    writeHookFile(path, settingsText(withSetting));
    expect(await changeHooks(record, w.data, vault, true)).toMatchObject({ file: 'edited' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ permissions: { allow: ['Read'] }, hooks: {} });

    const other = workspace(), otherVault = cappedVault(), second = other.connect('codex');
    await changeHooks(second, other.data, otherVault.vault);
    const withHook = JSON.parse(readFileSync(other.pathOf(second), 'utf8')) as { hooks: Record<string, unknown[]> }; withHook.hooks.Stop!.push(userHook('mine'));
    writeHookFile(other.pathOf(second), settingsText(withHook));
    expect(await changeHooks(second, other.data, otherVault.vault, true)).toMatchObject({ file: 'edited' });
    expect(JSON.parse(readFileSync(other.pathOf(second), 'utf8'))).toEqual({ hooks: { Stop: [userHook('mine')] } });
  });

  it('never deletes when the record is missing, since nothing then says Agent Town created it', async () => {
    const w = workspace(), { vault } = cappedVault(), record = w.connect('codex'), path = w.pathOf(record);
    await changeHooks(record, w.data, vault);
    rmSync(join(w.data, 'observation', 'installed', `${record.connection.id}.json`));
    expect(await changeHooks(record, w.data, vault, true)).toMatchObject({ removed: true, file: 'edited' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ hooks: {} });
  });

  it('deletes the dedicated Copilot file when it is left empty, and keeps it when anything else is in it', async () => {
    for (const foreign of [false, true]) {
      const w = workspace(), { vault } = cappedVault(), record = w.connect('copilot-cli'), path = w.pathOf(record);
      expect(path).toContain(`agent-town-${record.connection.id}.json`);
      await changeHooks(record, w.data, vault);
      rmSync(join(w.data, 'observation', 'installed', `${record.connection.id}.json`));   // an install from before the flag existed: the file's own name is the proof
      if (foreign) { const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; value.note = 'mine'; writeHookFile(path, settingsText(value)); }
      const result = await changeHooks(record, w.data, vault, true);
      if (foreign) { expect(result.file).toBe('edited'); expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, note: 'mine', hooks: {} }); }
      else { expect(result).toMatchObject({ removed: true, file: 'deleted' }); expect(existsSync(path)).toBe(false); }
    }
  });

  it('a Windows lock on the file leaves it, and no backup, behind (edit and delete alike)', async () => {
    for (const created of [true, false]) {
      const w = workspace(), { vault, stored } = cappedVault(), record = w.connect('codex'), path = w.pathOf(record);
      if (!created) writeHookFile(path, settingsText({ model: 'mine' }));
      await changeHooks(record, w.data, vault);
      const pointers = backupPointers(w.data).length, entries = stored.size, text = readFileSync(path, 'utf8');
      __setRenameForTests(async () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); });
      await expect(changeHooks(record, w.data, vault, true)).rejects.toMatchObject({ code: 'HOOK_FILE_LOCKED', statusCode: 409 });
      __setRenameForTests(null);
      expect(readFileSync(path, 'utf8')).toBe(text);
      expect(readdirSync(dirname(path)).filter(name => name.endsWith('.tmp'))).toEqual([]);
      expect(backupPointers(w.data).length).toBe(pointers); expect(stored.size).toBe(entries);
    }
  }, 20000);

  it('a change the tool makes while the delete is being prepared stops the delete: the file, and the edit in it, survive', async () => {
    const w = workspace(), { vault: base, stored } = cappedVault(), record = w.connect('codex'), path = w.pathOf(record);
    await changeHooks(record, w.data, base);   // Agent Town creates the file, so this removal will delete it
    const entries = stored.size, pointers = backupPointers(w.data).length;
    const concurrent = JSON.stringify({ model: 'edited-by-the-tool', hooks: {} });
    // The vault is slow (DPAPI can take seconds): the tool rewrites the file while the safety copy is being made.
    const racing: CredentialVault = { ...base, put: async (reference, value) => { await base.put(reference, value); writeFileSync(path, concurrent); } };
    const error = await changeHooks(record, w.data, racing, true).catch((caught: unknown) => caught) as IdentityError;
    expect(error).toMatchObject({ code: 'HOOK_CONFIG_CHANGED', statusCode: 409 });
    expect(error.message).toContain('removing'); expect(error.message).toContain('nothing was changed');
    expect(existsSync(path)).toBe(true); expect(readFileSync(path, 'utf8')).toBe(concurrent);   // the edit was not deleted with the file
    expect(readdirSync(dirname(path)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(stored.size).toBe(entries); expect(backupPointers(w.data).length).toBe(pointers);   // the safety copy it made was taken back
  });

  it('a failed apply never vouches for a file someone else creates afterwards', async () => {
    const w = workspace(), { vault } = cappedVault(), record = w.connect('codex'), path = w.pathOf(record);
    __setRenameForTests(async () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); });
    await expect(changeHooks(record, w.data, vault)).rejects.toMatchObject({ code: 'HOOK_FILE_LOCKED' });
    __setRenameForTests(null);
    expect(existsSync(path)).toBe(false);   // Agent Town did not create it
    expect(installedRecord(w.data, record.connection.id)).not.toBeNull();   // the record exists (it is written before the file)...
    expect(installedRecord(w.data, record.connection.id)?.createdFile).toBeUndefined();   // ...but does not claim a file that was never made
    writeHookFile(path, settingsText({}));   // the person makes their own, empty file
    expect(await changeHooks(record, w.data, vault)).toMatchObject({ file: 'edited' });
    expect(installedRecord(w.data, record.connection.id)?.createdFile).toBeUndefined();
    expect(await changeHooks(record, w.data, vault, true)).toMatchObject({ removed: true, file: 'edited' });
    expect(existsSync(path)).toBe(true); expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ hooks: {} });
  }, 20000);

  it('never deletes when the record is damaged, since nothing then vouches that Agent Town created the file', async () => {
    const w = workspace(), { vault } = cappedVault(), record = w.connect('codex'), path = w.pathOf(record);
    await changeHooks(record, w.data, vault);   // Agent Town creates the file
    writeFileSync(join(w.data, 'observation', 'installed', `${record.connection.id}.json`), '{ this record is damaged');
    const result = await changeHooks(record, w.data, vault, true);
    expect(result).toMatchObject({ removed: true, removedEntries: ownEntryCount(w, record), residualEntries: 0, file: 'edited' });
    expect(existsSync(path)).toBe(true); expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ hooks: {} });
  });

  it('a moved-aside copy that will not delete right away is retried; one that never deletes is reported, not hidden', async () => {
    const w = workspace(), { vault } = cappedVault(), record = w.connect('codex'), path = w.pathOf(record);
    await changeHooks(record, w.data, vault);
    let calls = 0;
    __setUnlinkForTests(async target => { if (++calls < 3) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); await unlink(target); });
    const result = await changeHooks(record, w.data, vault, true);   // an antivirus scan lets go on the third try
    expect(result).toMatchObject({ file: 'deleted', removed: true }); expect(result.leftoverCopy).toBeUndefined(); expect(calls).toBe(3);
    expect(existsSync(path)).toBe(false); expect(readdirSync(dirname(path)).filter(name => name.endsWith('.tmp'))).toEqual([]);

    const other = workspace(), otherVault = cappedVault(), second = other.connect('codex');
    await changeHooks(second, other.data, otherVault.vault);
    __setUnlinkForTests(async () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); });
    const stuck = await changeHooks(second, other.data, otherVault.vault, true);
    expect(stuck).toMatchObject({ file: 'deleted', removed: true, leftoverCopy: true });   // the removal itself happened; the leftover is said out loud
    expect(existsSync(other.pathOf(second))).toBe(false);
    expect(readdirSync(dirname(other.pathOf(second))).filter(name => /^\.agent-town-.*\.tmp$/.test(name))).toHaveLength(1);
    expect(JSON.stringify(stuck)).not.toMatch(/hook-bridge|--config/);
  }, 20000);
});

describe('backups: three per file, and only ever ones Agent Town made', () => {
  it('keeps the newest three backups of a file across applies and removals, and deletes the older ones from the vault too', async () => {
    const w = workspace(), { vault, stored, puts } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record);
    writeHookFile(path, settingsText({ permissions: { allow: ['Read'] } }));
    for (let round = 0; round < 3; round++) { await changeHooks(record, w.data, vault); await changeHooks(record, w.data, vault, true); }
    expect(puts).toHaveLength(6);
    const pointers = backupPointers(w.data);
    expect(pointers).toHaveLength(HOOK_BACKUPS_KEPT_PER_FILE); expect(HOOK_BACKUPS_KEPT_PER_FILE).toBe(3);
    expect(stored.size).toBe(3);
    expect(pointers.map(pointer => pointer.reference).sort()).toEqual(puts.slice(-3).sort());   // the newest three
    for (const pointer of pointers) expect(stored.has(pointer.reference)).toBe(true);
  });

  it('counts per hook file, not per connection: another tool\'s backups are not touched', async () => {
    const w = workspace(), { vault, stored } = cappedVault(), claude = w.connect('claude'), codex = w.connect('codex');
    writeHookFile(w.pathOf(claude), settingsText({ permissions: {} })); writeHookFile(w.pathOf(codex), settingsText({ model: 'mine' }));
    await changeHooks(codex, w.data, vault);
    const codexBackup = backupPointers(w.data).find(pointer => pointer.connectionId === codex.connection.id)!;
    for (let round = 0; round < 4; round++) { await changeHooks(claude, w.data, vault); await changeHooks(claude, w.data, vault, true); }
    const pointers = backupPointers(w.data);
    expect(pointers.filter(pointer => pointer.connectionId === claude.connection.id)).toHaveLength(3);
    expect(pointers.filter(pointer => pointer.connectionId === codex.connection.id)).toEqual([codexBackup]);
    expect(stored.size).toBe(4);
  });

  it('counts a shared file\'s backups together, whichever connection made them', async () => {
    const w = workspace(), { vault } = cappedVault(), first = w.connect('claude'), second = w.connect('claude');
    writeHookFile(w.pathOf(first), settingsText({ permissions: {} }));
    for (let round = 0; round < 3; round++) for (const record of [first, second]) { await changeHooks(record, w.data, vault); await changeHooks(record, w.data, vault, true); }
    expect(backupPointers(w.data)).toHaveLength(3);
  });

  it('counts a backup from before the file key existed toward its own connection, and never deletes what is not a hook backup', async () => {
    const w = workspace(), { vault, stored } = cappedVault(), record = w.connect('claude');
    writeHookFile(w.pathOf(record), settingsText({ permissions: {} }));
    const folder = join(w.data, 'observation', 'backups'); mkdirSync(folder, { recursive: true });
    const legacy = (day: number) => { const reference = `hook-backup-${randomUUID()}`, at = `2020-01-0${day}T00:00:00.000Z`; stored.set(reference, `old ${day}`); writeFileSync(join(folder, `${record.connection.id}-${randomUUID()}.json`), JSON.stringify({ at, action: 'apply', connectionId: record.connection.id, reference })); return reference; };
    const [oldest, middle, newest] = [legacy(1), legacy(2), legacy(3)] as [string, string, string];
    // Things that must never be deleted: a pointer aimed at something else in the vault, an unreadable pointer, another connection's.
    stored.set('observation-not-a-hook-backup', 'a token');
    writeFileSync(join(folder, `${record.connection.id}-${randomUUID()}.json`), JSON.stringify({ at: '2020-01-01T00:00:00.000Z', action: 'apply', connectionId: record.connection.id, reference: 'observation-not-a-hook-backup' }));
    writeFileSync(join(folder, `${record.connection.id}-${randomUUID()}.json`), 'not json');
    const strangerReference = `hook-backup-${randomUUID()}`; stored.set(strangerReference, 'someone else\'s');
    writeFileSync(join(folder, `${randomUUID()}-${randomUUID()}.json`), JSON.stringify({ at: '2020-01-01T00:00:00.000Z', action: 'apply', connectionId: randomUUID(), reference: strangerReference }));

    await changeHooks(record, w.data, vault);   // a fourth backup of this file: the oldest of its own connection goes
    expect(stored.has(oldest)).toBe(false); expect(stored.has(middle)).toBe(true); expect(stored.has(newest)).toBe(true);
    expect(stored.get('observation-not-a-hook-backup')).toBe('a token'); expect(stored.get(strangerReference)).toBe('someone else\'s');
    expect(readdirSync(folder).some(name => readFileSync(join(folder, name), 'utf8') === 'not json')).toBe(true);
    expect(readdirSync(folder)).toHaveLength(6);
  });

  it('a change that fails takes back the backup it made, and says so in words about removing', async () => {
    const w = workspace(), { vault: base, stored } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record);
    writeHookFile(path, settingsText({ permissions: {} }));
    await changeHooks(record, w.data, base);
    const entries = stored.size, pointers = backupPointers(w.data).length;
    const concurrent = JSON.stringify({ permissions: {}, hooks: {}, editedByTheTool: true });
    const racing: CredentialVault = { ...base, put: async (reference, value) => { await base.put(reference, value); writeFileSync(path, concurrent); } };
    const error = await changeHooks(record, w.data, racing, true).catch((caught: unknown) => caught) as IdentityError;
    expect(error).toMatchObject({ code: 'HOOK_CONFIG_CHANGED', statusCode: 409 });
    expect(error.message).toContain('removing'); expect(error.message).toContain('nothing was changed'); expect(error.message).not.toContain('apply');
    expect(readFileSync(path, 'utf8')).toBe(concurrent);   // the other program's edit survived
    expect(stored.size).toBe(entries); expect(backupPointers(w.data).length).toBe(pointers);
    expect(readdirSync(dirname(path)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('the rest of the file keeps the layout it had', () => {
  const pristine = { permissions: { allow: ['Read'] }, hooks: { Stop: [userHook('keep-me')] } };
  it.each([
    ['four-space indent and no final newline', (value: unknown) => JSON.stringify(value, null, 4)],
    ['tab indent and a final newline', (value: unknown) => JSON.stringify(value, null, '\t') + '\n'],
    ['Windows line ends', (value: unknown) => JSON.stringify(value, null, 2).replaceAll('\n', '\r\n') + '\r\n'],
    ['one compact line', (value: unknown) => JSON.stringify(value)],
    ['Agent Town\'s own two-space form', (value: unknown) => JSON.stringify(value, null, 2) + '\n'],
  ])('%s', async (_name, layout) => {
    const w = workspace(), { vault } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record);
    writeHookFile(path, settingsText(pristine));
    await changeHooks(record, w.data, vault);
    writeHookFile(path, layout(JSON.parse(readFileSync(path, 'utf8'))));   // the tool (or the person) saves the file in its own layout
    await changeHooks(record, w.data, vault, true);
    expect(readFileSync(path, 'utf8')).toBe(layout(pristine));
  });
});

describe('files that are awkward to rewrite', () => {
  it('a file with a byte-order mark is read past on removal and keeps its mark, byte for byte', async () => {
    const w = workspace(), { vault } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record), mark = String.fromCharCode(0xfeff);
    const pristine = { permissions: { allow: ['Read'] }, hooks: { Stop: [userHook('keep-me')] } };
    writeHookFile(path, settingsText(pristine));
    await changeHooks(record, w.data, vault);
    writeHookFile(path, mark + readFileSync(path, 'utf8'));   // an editor saves it with a byte-order mark
    await expect(changeHooks(record, w.data, vault)).rejects.toMatchObject({ code: 'HOOK_CONFIG_INVALID' });   // an apply still refuses it
    const result = await changeHooks(record, w.data, vault, true);
    expect(result).toMatchObject({ removed: true, removedEntries: ownEntryCount(w, record), file: 'edited' });
    expect(readFileSync(path).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(mark + settingsText(pristine));
  });

  it('a read-only file is called read-only at once (not "briefly in use"), and nothing is changed or backed up', async () => {
    const w = workspace(), { vault, stored } = cappedVault(), record = w.connect('claude'), path = w.pathOf(record);
    writeHookFile(path, settingsText({ permissions: { allow: ['Read'] } }));
    await changeHooks(record, w.data, vault);
    const text = readFileSync(path, 'utf8'), entries = stored.size, pointers = backupPointers(w.data).length;
    let attempts = 0;
    __setRenameForTests(async (from, to) => { attempts++; await rename(from, to); });
    chmodSync(path, 0o444);
    try {
      const error = await changeHooks(record, w.data, vault, true).catch((caught: unknown) => caught) as IdentityError;
      expect(error).toMatchObject({ code: 'HOOK_FILE_READ_ONLY', statusCode: 409 });
      expect(error.message).toContain('read-only'); expect(error.message).not.toContain('briefly in use');
      expect(attempts).toBe(1);   // waiting cannot help, so it did not retry
      expect(readFileSync(path, 'utf8')).toBe(text); expect(stored.size).toBe(entries); expect(backupPointers(w.data).length).toBe(pointers);
      expect(readdirSync(dirname(path)).filter(name => name.endsWith('.tmp'))).toEqual([]);
      // An apply that has something to add says the same.
      chmodSync(path, 0o666); writeHookFile(path, settingsText({ permissions: { allow: ['Read'] } })); chmodSync(path, 0o444); attempts = 0;
      await expect(changeHooks(record, w.data, vault)).rejects.toMatchObject({ code: 'HOOK_FILE_READ_ONLY' });
      expect(attempts).toBe(1);
    } finally { chmodSync(path, 0o666); }
  });
});

describe('the remove-hooks route', () => {
  const state = (root: string) => {
    const initial = privateState({ id: 'workspace-one', name: 'Fixture workspace', kind: 'personal' });
    initial.discovery!.roots = [root];
    initial.repositories = [{ id: 'repo-one', name: 'Repo', branch: 'main', description: '', language: 'Unavailable', color: '#859b87', position: [-6, -3], source: 'local', localPath: root }];
    return initial;
  };
  /** The service checks each connection's delivery on a 500 ms timer and saves its own, unrelated event the first time, at
   * whatever moment that falls. So what a removal did is read from the hooks_removed events alone, never from "no events". */
  const removedEvents = (store: Store, cursor: Parameters<Store['replay']>[0]) => store.replay(cursor).map(event => event.type).filter(type => type === 'observation.hooks_removed');
  /** `owner` answers who is asking, each time the service asks (a test can change it mid-request); `logLines` collects log output. */
  async function service(w: Workspace, vault: CredentialVault, options: { owner?: () => string; logLines?: string[] } = {}) {
    const store = new Store(':memory:', state(w.root)), app = Fastify(options.logLines ? { logger: { level: 'warn', stream: { write: (line: string) => { options.logLines!.push(line); } } } } : {});
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ code: error instanceof IdentityError ? error.code : 'INTERNAL', message: error instanceof Error ? error.message : 'Request failed' }));
    const api = registerObservationApi(app, { directory: w.data, vault, scoped: () => ({ ownerId: options.owner?.() ?? '101', store }), workspace: () => store });
    const base = '/api/v1/workspaces/workspace-one/observation/connections';
    const create = async (provider: string) => (await app.inject({ method: 'POST', url: base, payload: { provider, repoId: 'repo-one', label: provider } })).json().connection.id as string;
    return { store, app, base, create, close: async () => { await api.close(); await app.close(); store.close(); } };
  }

  it('reports what it did, commits one observation.hooks_removed record for a real removal, and nothing for a repeat', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await service(w, vault);
    try {
      const id = await s.create('codex');
      expect((await s.app.inject({ method: 'POST', url: `${s.base}/${id}/apply` })).statusCode).toBe(200);
      const before = s.store.snapshot().cursor;
      const removed = await s.app.inject({ method: 'POST', url: `${s.base}/${id}/remove-hooks` });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ changed: true, removed: true, removedEntries: 8, residualEntries: 0, file: 'deleted' });
      expect(removedEvents(s.store, before)).toEqual(['observation.hooks_removed']);
      const note = s.store.snapshot().state.activity[0]!.message;
      expect(note).toContain('removed for codex'); expect(note).toContain('8 entries'); expect(note).not.toContain(w.root); expect(note).not.toContain('hook-bridge');
      const after = s.store.snapshot().cursor;
      const repeat = await s.app.inject({ method: 'POST', url: `${s.base}/${id}/remove-hooks` });
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json()).toMatchObject({ changed: false, removed: false, removedEntries: 0, file: 'missing' });
      expect(removedEvents(s.store, after)).toEqual([]);
    } finally { await s.close(); }
  });

  it('answers a file too big to back up with the typed code and a plain message, and writes nothing', async () => {
    const w = workspace(), { vault, puts } = cappedVault(), s = await service(w, vault);
    try {
      const id = await s.create('claude');
      await s.app.inject({ method: 'POST', url: `${s.base}/${id}/apply` });
      const path = join(w.root, '.claude', 'settings.local.json');
      const big = settingsText({ ...JSON.parse(readFileSync(path, 'utf8')), pad: 'x'.repeat(17_000) });
      writeFileSync(path, big); const putsBefore = puts.length, cursor = s.store.snapshot().cursor;
      const response = await s.app.inject({ method: 'POST', url: `${s.base}/${id}/remove-hooks` });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'HOOK_BACKUP_TOO_LARGE' });
      expect(response.json().message).toContain('too big');
      expect(readFileSync(path, 'utf8')).toBe(big); expect(puts.length).toBe(putsBefore); expect(removedEvents(s.store, cursor)).toEqual([]);
    } finally { await s.close(); }
  });

  it('runs under the same per-project lock as apply: a removal waits for an apply that is still working on the file', async () => {
    const w = workspace(), { vault: base, puts } = cappedVault();
    let armed = false, release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const vault: CredentialVault = { ...base, put: async (reference, value) => { if (armed) { puts.push('waiting'); await gate; } await base.put(reference, value); } };
    const s = await service(w, vault);
    try {
      const id = await s.create('codex');
      await s.app.inject({ method: 'POST', url: `${s.base}/${id}/apply` });
      armed = true;
      const apply = s.app.inject({ method: 'POST', url: `${s.base}/${id}/apply` });
      while (!puts.includes('waiting')) await sleep(10);   // the apply is now inside the lock, blocked on its backup
      const removal = s.app.inject({ method: 'POST', url: `${s.base}/${id}/remove-hooks` });
      await sleep(400);
      expect(puts.filter(entry => entry === 'waiting')).toHaveLength(1);   // the removal has not started its own backup
      release();
      const [applied, removed] = await Promise.all([apply, removal]);
      expect(applied.statusCode).toBe(200); expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ removed: true, file: 'deleted' });
      expect(existsSync(join(w.root, '.codex', 'hooks.json'))).toBe(false);
    } finally { release(); await s.close(); }
  });

  it('asks again who is calling once it holds the project lock: a removal that waited behind an apply is refused if the caller has changed', async () => {
    const w = workspace(), { vault: base, puts } = cappedVault();
    let armed = false, release: () => void = () => undefined, owner = '101';
    const gate = new Promise<void>(resolve => { release = resolve; });
    const vault: CredentialVault = { ...base, put: async (reference, value) => { if (armed) { puts.push('waiting'); await gate; } await base.put(reference, value); } };
    const s = await service(w, vault, { owner: () => owner });
    try {
      const id = await s.create('codex');
      await s.app.inject({ method: 'POST', url: `${s.base}/${id}/apply` });
      const path = join(w.root, '.codex', 'hooks.json'), applied = readFileSync(path, 'utf8'), cursor = s.store.snapshot().cursor;
      armed = true;
      const apply = s.app.inject({ method: 'POST', url: `${s.base}/${id}/apply` });
      while (!puts.includes('waiting')) await sleep(10);
      const removal = s.app.inject({ method: 'POST', url: `${s.base}/${id}/remove-hooks` });
      await sleep(400);   // the removal has passed its first check and is queued behind the apply
      owner = '202'; release();
      const [, removed] = await Promise.all([apply, removal]);
      expect(removed.statusCode).toBe(404);
      expect(removed.json()).toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
      expect(readFileSync(path, 'utf8')).toBe(applied);   // nothing was removed for a caller who no longer owns it
      expect(removedEvents(s.store, cursor)).toEqual([]);
    } finally { release(); await s.close(); }
  });

  it('a removal that worked is not turned into an error when its activity note cannot be saved, and only a fixed line is logged', async () => {
    const w = workspace(), { vault } = cappedVault(), logLines: string[] = [], s = await service(w, vault, { logLines });
    try {
      const id = await s.create('codex');
      await s.app.inject({ method: 'POST', url: `${s.base}/${id}/apply` });
      const real = s.store.commit.bind(s.store), cursor = s.store.snapshot().cursor;
      vi.spyOn(s.store, 'commit').mockImplementation((sourceId, change, fingerprint) => {
        if (sourceId.startsWith('hooks-removed:')) throw new Error(`disk full while writing ${w.root}`);
        return real(sourceId, change, fingerprint);
      });
      const removed = await s.app.inject({ method: 'POST', url: `${s.base}/${id}/remove-hooks` });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ changed: true, removed: true, removedEntries: 8, file: 'deleted' });
      expect(existsSync(join(w.root, '.codex', 'hooks.json'))).toBe(false);   // the removal itself happened
      expect(removedEvents(s.store, cursor)).toEqual([]);   // and no half-written note
      const warnings = logLines.map(line => JSON.parse(line) as { msg?: string });
      expect(warnings.map(line => line.msg)).toContain('The hooks were removed but the activity note could not be saved.');
      expect(logLines.join('')).not.toContain('disk full'); expect(logLines.join('')).not.toContain(w.root.replaceAll('\\', '\\\\'));
    } finally { await s.close(); }
  });

  it('says in its activity note, and in its answer, when a leftover copy of the deleted file could not be deleted', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await service(w, vault);
    try {
      const id = await s.create('codex');
      await s.app.inject({ method: 'POST', url: `${s.base}/${id}/apply` });
      __setUnlinkForTests(async () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); });
      const removed = await s.app.inject({ method: 'POST', url: `${s.base}/${id}/remove-hooks` });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ removed: true, file: 'deleted', leftoverCopy: true });
      const note = s.store.snapshot().state.activity[0]!.message;
      expect(note).toContain('leftover copy'); expect(note).toContain('could not be deleted'); expect(note).not.toContain(w.root); expect(note).not.toContain('hook-bridge');
    } finally { await s.close(); }
  }, 20000);
});

// H0-11: the helpers Stop watching (H0-13, built next) will orchestrate — neutralize, the bounded final
// drain, and safe local clean-up. Built on top of H0-10's changeHooks above; nothing in this section
// touches the hook file at all. Every test uses its own temporary project and data folder.
function finalDrainState(root: string) {
  const initial = privateState({ id: 'workspace-one', name: 'Fixture workspace', kind: 'personal' });
  initial.discovery!.roots = [root];
  initial.repositories = [{ id: 'repo-one', name: 'Repo', branch: 'main', description: '', language: 'Unavailable', color: '#859b87', position: [-6, -3], source: 'local', localPath: root }];
  return initial;
}
function invokeBridge(config: string, input: object) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(projectRoot, 'apps/service/src/observation/bridge.ts'), '--config', config, '--event', 'Stop'], { cwd: projectRoot, windowsHide: true, stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input));
  });
}

describe('neutralize: a hook that fires afterward is a quiet no-op', () => {
  it('deletes only the bridge config; a real hook invocation then writes nothing to the spool and still exits 0 with no event content', async () => {
    const w = workspace(), record = w.connect('claude');
    await writeBridgeConfig(record, w.data);
    const spool = spoolPath(w.data, record.connection.id), config = bridgeConfigPath(w.data, record.connection.id);
    const before = readdirSync(spool).sort();
    expect(existsSync(config)).toBe(true);

    await neutralizeConnection(w.data, record.connection.id);
    expect(existsSync(config)).toBe(false);
    expect(readdirSync(spool).sort()).toEqual(before);   // the spool itself is untouched by neutralize

    const result = await invokeBridge(config, { cwd: w.root, session_id: 'fixture-native', hook_event_name: 'Stop', last_assistant_message: 'Should never be written; the connection was neutralized.' });
    expect(result).toEqual({ code: 0, stdout: '{}', stderr: '' });
    expect(readdirSync(spool).sort()).toEqual(before);   // still nothing new: no event, no coverage-gap marker

    await expect(neutralizeConnection(w.data, record.connection.id)).resolves.toBeUndefined();   // idempotent
  });
});

describe('clean-up: only this connection\'s own top-level spool files, never newer/, never outside its folder', () => {
  it('leaves spool/newer/ untouched and reports its count; deletes other top-level files, including service-capabilities.json, which the pending count never includes', async () => {
    const w = workspace(), record = w.connect('claude');
    await writeBridgeConfig(record, w.data);
    const spool = spoolPath(w.data, record.connection.id);
    mkdirSync(join(spool, 'newer'), { recursive: true });
    writeFileSync(join(spool, 'newer', `${randomUUID()}.json`), '{}');
    writeFileSync(join(spool, 'newer', `${randomUUID()}.json`), '{}');
    writeFileSync(join(spool, 'coverage-gap'), '1');
    expect(existsSync(join(spool, SERVICE_CAPABILITIES_FILE))).toBe(true);
    const newerBefore = readdirSync(join(spool, 'newer')).sort();

    const result = await cleanupConnectionFiles(w.data, record.connection.id, { discard: false, residualEntries: 0 });
    expect(result).toEqual({ cleaned: true, pendingEvents: 0, newerEventCount: 2, discardedEvents: 0, manifestDeleted: false, folderRemoved: false });
    expect(readdirSync(join(spool, 'newer')).sort()).toEqual(newerBefore);   // byte-identical: never touched
    expect(existsSync(join(spool, SERVICE_CAPABILITIES_FILE))).toBe(false);   // an ordinary top-level file, deleted once clean-up proceeds
    expect(existsSync(join(spool, 'coverage-gap'))).toBe(false);
    expect(existsSync(spool)).toBe(true);   // not removed: spool/newer/ is still inside it
  });

  it('leaves the spool exactly as it was when events are pending and Discard was not chosen; Discard removes and counts them', async () => {
    const w = workspace(), record = w.connect('claude');
    await writeBridgeConfig(record, w.data);
    const spool = spoolPath(w.data, record.connection.id);
    writeFileSync(join(spool, `${randomUUID()}.json`), '{}');
    writeFileSync(join(spool, `${randomUUID()}.json`), '{}');
    writeFileSync(join(spool, 'coverage-gap'), '1');
    const before = readdirSync(spool).sort();

    const kept = await cleanupConnectionFiles(w.data, record.connection.id, { discard: false, residualEntries: 0 });
    expect(kept).toEqual({ cleaned: false, pendingEvents: 2, newerEventCount: 0, discardedEvents: 0, manifestDeleted: false, folderRemoved: false });
    expect(readdirSync(spool).sort()).toEqual(before);   // exactly as it was: a repeat can still drain it

    const discarded = await cleanupConnectionFiles(w.data, record.connection.id, { discard: true, residualEntries: 0 });
    expect(discarded).toEqual({ cleaned: true, pendingEvents: 2, newerEventCount: 0, discardedEvents: 2, manifestDeleted: false, folderRemoved: true });
    expect(existsSync(spool)).toBe(false);   // now empty, so the folder itself is removed
  });

  it('deletes the installed manifest only when no residual entry remains', async () => {
    const w = workspace(), record = w.connect('claude');
    await writeBridgeConfig(record, w.data);
    const manifestDirectory = join(w.data, 'observation', 'installed'); mkdirSync(manifestDirectory, { recursive: true });
    const manifestPath = join(manifestDirectory, `${record.connection.id}.json`);
    writeFileSync(manifestPath, JSON.stringify({ version: 1, connectionId: record.connection.id, configurations: [] }));

    const withResidual = await cleanupConnectionFiles(w.data, record.connection.id, { discard: false, residualEntries: 1 });
    expect(withResidual.manifestDeleted).toBe(false);
    expect(existsSync(manifestPath)).toBe(true);

    const clean = await cleanupConnectionFiles(w.data, record.connection.id, { discard: false, residualEntries: 0 });
    expect(clean.manifestDeleted).toBe(true);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('never removes the spool folder while spool/newer/ is still inside it, even once every top-level file is gone', async () => {
    const w = workspace(), record = w.connect('claude');
    await writeBridgeConfig(record, w.data);
    const spool = spoolPath(w.data, record.connection.id);
    mkdirSync(join(spool, 'newer'), { recursive: true });
    const result = await cleanupConnectionFiles(w.data, record.connection.id, { discard: false, residualEntries: 0 });
    expect(result).toMatchObject({ cleaned: true, folderRemoved: false });
    expect(existsSync(join(spool, 'newer'))).toBe(true);
  });
});

describe('the bounded final drain: mutex, capacity, and cancellation', () => {
  it('a blocked 200-agent drain leaves the spool untouched, and a repeat (once the town has room) drains it', async () => {
    const w = workspace(), record = w.connect('claude');
    await writeBridgeConfig(record, w.data);
    const spool = spoolPath(w.data, record.connection.id);
    const state = finalDrainState(w.root);
    state.observation = { connections: [record.connection] };
    for (let index = 0; index < RETAINED_AGENT_LIMIT; index++) {
      state.agents.push({ id: `filler-${index}`, name: `Filler ${index}`, provider: 'Codex', role: 'Filler', repoId: 'repo-one', task: 'Filler agent', activity: 'idle', color: '#859b87', home: [index, 0], updatedAt: new Date().toISOString(), files: [], evidence: 'Unavailable', contextVersion: null });
    }
    const store = new Store(':memory:', state);
    const receive = (events: ObservationEvent[]) => { for (const event of events) store.commit(`observe:${record.connection.id}:${event.id}`, (current, now) => applyObservation(current, record.connection, event, now), JSON.stringify(event)); };
    const eventFile = join(spool, `${randomUUID()}.json`);
    writeFileSync(eventFile, JSON.stringify({ id: 'brand-new-report', sessionId: 'brand-new-session', kind: 'session.start', occurredAt: new Date().toISOString() }));

    const blocked = await finalDrainConnection({ directory: w.data, spool, record, store, receive, cancelled: () => false });
    expect(blocked.outcome).toBe('blocked');
    expect(existsSync(eventFile)).toBe(true);   // the town was full for the very first record: nothing was removed
    expect(store.snapshot().state.agents).toHaveLength(RETAINED_AGENT_LIMIT);   // no new agent was created either

    store.commit('free-a-slot-for-the-test', state => { state.agents.pop(); return 'test.freed_a_slot'; });
    const drained = await finalDrainConnection({ directory: w.data, spool, record, store, receive, cancelled: () => false });
    expect(drained.outcome).toBe('drained');
    expect(existsSync(eventFile)).toBe(false);
    expect(store.snapshot().state.agents.some(agent => agent.observation?.sessionId === 'brand-new-session')).toBe(true);
  });

  it('a drain cut short by cancel or shutdown stops at the next record and releases the shared mutex', async () => {
    const w = workspace(), record = w.connect('claude');
    await writeBridgeConfig(record, w.data);
    const spool = spoolPath(w.data, record.connection.id);
    const state = finalDrainState(w.root);
    state.observation = { connections: [record.connection] };
    const store = new Store(':memory:', state);
    let receivedCount = 0, cancelled = false;
    const receive = (events: ObservationEvent[]) => {
      receivedCount += events.length;
      for (const event of events) store.commit(`observe:${record.connection.id}:${event.id}`, (current, now) => applyObservation(current, record.connection, event, now), JSON.stringify(event));
      cancelled = true;   // the caller's Cancel (or the shutdown deadline) fires right after the first record is delivered
    };
    const first = join(spool, '00000000-0000-4000-8000-000000000001.json'), second = join(spool, '00000000-0000-4000-8000-000000000002.json');
    writeFileSync(first, JSON.stringify({ id: 'first', sessionId: 'session-one', kind: 'session.start', occurredAt: new Date(Date.now() - 5000).toISOString() }));
    writeFileSync(second, JSON.stringify({ id: 'second', sessionId: 'session-two', kind: 'session.start', occurredAt: new Date().toISOString() }));

    const result = await finalDrainConnection({ directory: w.data, spool, record, store, receive, cancelled: () => cancelled });
    expect(result.outcome).toBe('cancelled');
    expect(receivedCount).toBe(1);
    expect(existsSync(first)).toBe(false);   // the record already delivered was removed and is not replayed again
    expect(existsSync(second)).toBe(true);   // the next record was left exactly where it was

    // The mutex was released on the way out: acquiring it again must resolve promptly, not hang behind the cancelled drain.
    const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('the drain mutex is still held')), 2000));
    const release = await Promise.race([drainMutex.acquire(), timeout]);
    release();
  });

  it('a drain that still has more than one batch queued when its budget elapses is reported as timed out, with counts, and is not retried in a loop', async () => {
    const w = workspace(), record = w.connect('claude');
    await writeBridgeConfig(record, w.data);
    const spool = spoolPath(w.data, record.connection.id);
    const state = finalDrainState(w.root);
    state.observation = { connections: [record.connection] };
    const store = new Store(':memory:', state);
    const receive = (events: ObservationEvent[]) => { for (const event of events) store.commit(`observe:${record.connection.id}:${event.id}`, (current, now) => applyObservation(current, record.connection, event, now), JSON.stringify(event)); };
    // More files than one bounded replay batch, so one drainObservationSpool call cannot finish them all
    // and delivery status stays 'pending' (never 'idle', never 'blocked') after that single call.
    for (let index = 0; index < SPOOL_BATCH_LIMIT + 1; index++) {
      writeFileSync(join(spool, `${randomUUID()}.json`), JSON.stringify({ id: `event-${index}`, sessionId: `session-${index}`, kind: 'session.start', occurredAt: new Date().toISOString() }));
    }
    // The budget has already elapsed before the first check, so the loop must stop after its first
    // drainObservationSpool call instead of looping to drain every remaining batch.
    __setFinalDrainBudgetForTests(-1);

    const result = await finalDrainConnection({ directory: w.data, spool, record, store, receive, cancelled: () => false });
    expect(result.outcome).toBe('timed-out');
    expect(result.pendingEvents).toBe(1);   // one bounded batch (SPOOL_BATCH_LIMIT files) was delivered; one file is still queued
    expect(readdirSync(spool).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))).toHaveLength(1);   // nothing was deleted or reverted by the timeout itself (service-capabilities.json is not an event file)
    expect(store.snapshot().state.agents).toHaveLength(SPOOL_BATCH_LIMIT);   // exactly the delivered batch, not the last file, and not a second pass

    // The mutex was released on the way out, same as a blocked or cancelled drain: a caller waiting for the next connection must not hang.
    const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('the drain mutex is still held')), 2000));
    const release = await Promise.race([drainMutex.acquire(), timeout]);
    release();
  });

  it('the shared mutex serializes: a second acquire waits for the first release, and tryAcquire refuses while it is held', async () => {
    const first = await drainMutex.acquire();
    expect(drainMutex.tryAcquire()).toBeNull();
    let secondHeld = false;
    const second = drainMutex.acquire().then(release => { secondHeld = true; return release; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(secondHeld).toBe(false);   // still waiting behind the first
    first();
    const releaseSecond = await second;
    expect(secondHeld).toBe(true);
    expect(drainMutex.tryAcquire()).toBeNull();   // the second holder still has it
    releaseSecond();
    const release = drainMutex.tryAcquire();
    expect(release).not.toBeNull();
    release!();
  });
});

// H0-13: "Stop watching" orchestrates H0-10 (hook removal), H0-11 (neutralize, bounded final drain,
// clean-up) and H0-12 (hide-all) into one resumable job under the project lock. Every test below uses its
// own temporary project and data folder (through workspace()/cappedVault() above); nothing touches the
// owner's real files, the real vault, or port 4310/4311. No provider or model call is made anywhere here.
function stopSyncingState(root: string) {
  const initial = privateState({ id: 'workspace-one', name: 'Fixture workspace', kind: 'personal' });
  initial.discovery!.roots = [root];
  initial.repositories = [{ id: 'repo-one', name: 'Repo', branch: 'main', description: '', language: 'Unavailable', color: '#859b87', position: [-6, -3], source: 'local', localPath: root }];
  return initial;
}
/** A registry row built directly (bypassing the HTTP create flow's own dedup rules), for tests that need
 * more connections than the six distinct providers would otherwise allow for one project (the 32-connection
 * cap test). Matches stopSyncingState's own workspace and repo. */
function stopSyncingRecord(root: string, provider: Provider, options: { ownerId?: string; nativeSourceId?: string } = {}): RegisteredObservation {
  return { ownerId: options.ownerId ?? '101', workspaceId: 'workspace-one', repoPath: root,
    connection: { id: randomUUID(), provider, repoId: 'repo-one', label: 'Fixture', status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0, ...(options.nativeSourceId ? { nativeSourceId: options.nativeSourceId } : {}) } };
}
async function stopSyncingService(w: Workspace, vault: CredentialVault, options: { owner?: () => string; logLines?: string[]; dbPath?: string; state?: ReturnType<typeof stopSyncingState> } = {}) {
  const store = new Store(options.dbPath ?? ':memory:', options.state ?? stopSyncingState(w.root));
  const app = Fastify(options.logLines ? { logger: { level: 'warn', stream: { write: (line: string) => { options.logLines!.push(line); } } } } : {});
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ code: error instanceof IdentityError ? error.code : 'INTERNAL', message: error instanceof Error ? error.message : 'Request failed' }));
  const api = registerObservationApi(app, { directory: w.data, vault, scoped: () => ({ ownerId: options.owner?.() ?? '101', store }), workspace: () => store });
  const base = '/api/v1/workspaces/workspace-one/observation/connections', stopBase = '/api/v1/workspaces/workspace-one/observation/stop-syncing';
  const create = async (provider: string) => (await app.inject({ method: 'POST', url: base, payload: { provider, repoId: 'repo-one', label: provider } })).json().connection.id as string;
  const applyHooks = async (id: string) => app.inject({ method: 'POST', url: `${base}/${id}/apply` });
  const preview = async () => (await app.inject({ method: 'GET', url: `${stopBase}?repoId=repo-one` })).json();
  const start = async (body: { reviewToken: string; editFiles?: boolean; discard?: boolean }) => app.inject({ method: 'POST', url: stopBase, payload: { repoId: 'repo-one', editFiles: true, discard: false, ...body } });
  const poll = async (operationId: string) => (await app.inject({ method: 'GET', url: `${stopBase}/${operationId}` })).json();
  const cancel = async (operationId: string) => app.inject({ method: 'POST', url: `${stopBase}/${operationId}/cancel` });
  const waitDone = async (operationId: string) => {
    let status = await poll(operationId);
    for (let tries = 0; status.status === 'running' && tries < 400; tries++) { await sleep(15); status = await poll(operationId); }
    return status;
  };
  const runToCompletion = async (body: { editFiles?: boolean; discard?: boolean } = {}) => {
    const review = await preview();
    const started = await start({ reviewToken: review.reviewToken, ...body });
    const operationId = started.json().operationId as string;
    return { review, started, operationId, status: await waitDone(operationId) };
  };
  return { store, app, api, base, stopBase, create, applyHooks, preview, start, poll, cancel, waitDone, runToCompletion, close: async () => { await api.close(); await app.close(); store.close(); } };
}

describe('Stop watching (H0-13): preview', () => {
  it('is read-only, lists entries by hook event name and count, and a stale review token is refused with 409', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault);
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      const before = listTree(w.data);
      const review = await s.preview();
      expect(review.connections).toHaveLength(1);
      const connection = review.connections[0];
      expect(connection.hooks).toBe('removed');
      expect(connection.removedEntries).toBe(8);
      expect(connection.entries).toHaveLength(8);
      expect(connection.entries.every((entry: { count: number }) => entry.count === 1)).toBe(true);
      expect(connection.entries.map((entry: { event: string }) => entry.event)).toContain('SessionEnd');
      expect(connection.step).toBeNull();
      expect(connection.result).toBeNull();
      expect(review.automaticManagerProcessing).toBe(false);
      expect(listTree(w.data)).toEqual(before);   // the preview changed nothing at all

      await s.create('claude');   // the target set just grew: the earlier token is now stale
      const beforeStalePost = listTree(w.data);
      const stale = await s.start({ reviewToken: review.reviewToken });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'STOP_SYNCING_REVIEW_CHANGED' });
      expect(listTree(w.data)).toEqual(beforeStalePost);   // a refused POST changed nothing either
    } finally { await s.close(); }
  });

  it('answers a malformed request with a plain 400, never a stack trace', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault);
    try {
      const response = await s.app.inject({ method: 'GET', url: `${s.stopBase}` });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_STOP_SYNCING' });
    } finally { await s.close(); }
  });
});

describe('Stop watching (H0-13): order — entries removed, then neutralized, then drained, then revoked and hidden, then cleaned', () => {
  it('runs the whole sequence for one connection, in one resumable job, and reports "stopped"', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault);
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      const configPath = join(w.root, '.codex', 'hooks.json'), bridgeConfig = bridgeConfigPath(w.data, id), spool = spoolPath(w.data, id);
      expect(existsSync(configPath)).toBe(true);
      expect(existsSync(bridgeConfig)).toBe(true);
      writeFileSync(join(spool, `${randomUUID()}.json`), JSON.stringify({ id: 'ev-report', sessionId: 'session-a', kind: 'report', occurredAt: new Date().toISOString(), summary: 'Final response text.' }));

      const { status } = await s.runToCompletion();
      expect(status.status).toBe('stopped');
      expect(status.connections).toHaveLength(1);
      expect(status.connections[0]).toMatchObject({ hooks: 'removed', removedEntries: 8, drain: 'drained', eventsDelivered: 1, revoked: true, cleaned: true, step: 'cleaned', result: 'stopped' });

      // Entries removed: the file Agent Town created (codex had none before apply) is now gone entirely.
      expect(existsSync(configPath)).toBe(false);
      // Neutralized: the bridge config for this connection is gone.
      expect(existsSync(bridgeConfig)).toBe(false);
      // Cleaned: the whole spool folder for this connection is gone.
      expect(existsSync(spool)).toBe(false);

      const snapshot = s.store.snapshot().state;
      expect(snapshot.observation!.connections.find(c => c.id === id)!.status).toBe('revoked');
      expect(snapshot.handoffs).toHaveLength(1);
      expect(snapshot.handoffs[0]!.status).toBe('saved');   // saved and fully readable
      // This connection was never bound to a native profile, so its agent has no native session row and is
      // exactly H0-12's "skippedLegacy" case: hide-all leaves it in town (a later real Stop watching test below
      // proves the native-bound case actually gets hidden).
      expect(snapshot.agents.find(a => a.observation?.connectionId === id)).toBeDefined();
      const note = snapshot.activity.find(item => item.message.includes('Stopped watching codex'))!;
      expect(note.message).toContain('removed'); expect(note.message).toContain('1 queued event');
      expect(note.message).not.toContain(w.root); expect(note.message).not.toContain('hook-bridge');
    } finally { await s.close(); }
  });

  it('hides the connection\'s native-backed sessions from town as part of the same revoke transaction (H0-12)', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault);
    try {
      const homePath = join(w.directory, 'native-home'); mkdirSync(homePath, { recursive: true });
      let sourceId = '';
      s.store.commit('seed-native-source', () => { sourceId = s.store.native.register('codex', homePath, 'Fixture native profile').id; return 'observation.native_source_registered'; });
      const id = await s.create('codex');
      const bound = await s.app.inject({ method: 'POST', url: `${s.base}/${id}/source`, payload: { nativeSourceId: sourceId } });
      expect(bound.statusCode).toBe(200);
      await s.applyHooks(id);
      writeFileSync(join(spoolPath(w.data, id), `${randomUUID()}.json`), JSON.stringify({ id: 'ev-native', sessionId: 'ignored', kind: 'report', occurredAt: new Date().toISOString(), summary: 'Native response.', nativeSourceId: sourceId, sourceRevision: 1, nativeSessionId: 'native-session-1' }));

      const { status } = await s.runToCompletion();
      expect(status.status).toBe('stopped');
      const snapshot = s.store.snapshot().state;
      expect(snapshot.agents.find(a => a.observation?.connectionId === id)).toBeUndefined();   // hidden from town
    } finally { await s.close(); }
  });

  it('after a full stop, a new detection review and apply for the same tool succeed again with no HOOK_OVERLAP', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault);
    const codexHome = join(w.directory, 'codex-home-detect'); mkdirSync(codexHome, { recursive: true });
    const savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      await s.runToCompletion();
      expect(existsSync(join(w.root, '.codex', 'hooks.json'))).toBe(false);   // nothing left behind that could overlap

      const detectionBase = s.base.replace('/connections', '/tool-detection');
      const review = await s.app.inject({ method: 'POST', url: `${detectionBase}/review`, payload: { repoId: 'repo-one', providers: ['codex'] } });
      expect(review.statusCode).toBe(200);
      const reviewed = review.json() as { items: { provider: string; connectionId: string }[]; conflicts?: unknown[] };
      expect(reviewed.conflicts ?? []).toEqual([]);
      expect(reviewed.items).toHaveLength(1);

      const applied = await s.app.inject({ method: 'POST', url: `${detectionBase}/apply`, payload: { repoId: 'repo-one', items: reviewed.items.map(item => ({ provider: item.provider, connectionId: item.connectionId })) } });
      expect(applied.statusCode).toBe(200);
      const results = (applied.json() as { results: { applied: boolean; error?: string }[] }).results;
      expect(results[0]).toMatchObject({ applied: true });
      expect(results[0]!.error).toBeUndefined();
    } finally {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome;
      await s.close();
    }
  });

  it('a custom connector skips hook removal (it never had one) but is still neutralized, drained and revoked', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault);
    try {
      const id = await s.create('custom');
      const spool = spoolPath(w.data, id);
      writeFileSync(join(spool, `${randomUUID()}.json`), JSON.stringify({ id: 'ev-custom', sessionId: 'session-custom', kind: 'report', occurredAt: new Date().toISOString(), summary: 'Custom response.' }));
      const { status } = await s.runToCompletion();
      expect(status.connections[0]).toMatchObject({ hooks: 'unsupported', hooksPath: null, drain: 'drained', revoked: true, cleaned: true, step: 'cleaned', result: 'stopped' });
      expect(existsSync(spool)).toBe(false);
    } finally { await s.close(); }
  });

  it('a hook file too large to back up is left in place for manual review, but the rest of the stop still finishes', async () => {
    const w = workspace(), { vault, puts } = cappedVault(), s = await stopSyncingService(w, vault);
    try {
      const id = await s.create('claude');
      await s.applyHooks(id);
      const path = join(w.root, '.claude', 'settings.local.json');
      const big = settingsText({ ...JSON.parse(readFileSync(path, 'utf8')), pad: 'x'.repeat(17_000) });
      writeFileSync(path, big);
      const putsBefore = puts.length;

      const { status } = await s.runToCompletion();
      expect(status.connections[0]).toMatchObject({ hooks: 'left', hooksPath: path, revoked: true, cleaned: true, step: 'cleaned', result: 'stopped' });
      expect(readFileSync(path, 'utf8')).toBe(big);   // the oversize file itself was never touched
      expect(puts.length).toBe(putsBefore);           // no backup was attempted for it either
    } finally { await s.close(); }
  });

  it('running it again after a full stop finds nothing left to do and changes nothing', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault);
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      await s.runToCompletion();
      const beforeTree = listTree(w.data), beforeCursor = s.store.snapshot().cursor;

      const again = await s.runToCompletion();
      expect(again.status.connections).toHaveLength(0);
      expect(again.status.status).toBe('stopped');
      expect(listTree(w.data)).toEqual(beforeTree);
      expect(s.store.snapshot().cursor).toBe(beforeCursor);
    } finally { await s.close(); }
  });
});

describe('Stop watching (H0-13): the safety rule — revoke and clean-up run only when the drain left nothing pending, or Discard was chosen', () => {
  it('a drain blocked by a full town ends the connection "partial", registered, neutralized and untouched on disk; a repeat once the town has room finishes it', async () => {
    const w = workspace(), { vault } = cappedVault();
    const state = stopSyncingState(w.root);
    for (let index = 0; index < RETAINED_AGENT_LIMIT; index++) {
      state.agents.push({ id: `filler-${index}`, name: `Filler ${index}`, provider: 'Codex', role: 'Filler', repoId: 'repo-one', task: 'Filler agent', activity: 'idle', color: '#859b87', home: [index, 0], updatedAt: new Date().toISOString(), files: [], evidence: 'Unavailable', contextVersion: null });
    }
    const s = await stopSyncingService(w, vault, { state });
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      const spool = spoolPath(w.data, id), bridgeConfig = bridgeConfigPath(w.data, id);
      const eventFile = join(spool, `${randomUUID()}.json`);
      writeFileSync(eventFile, JSON.stringify({ id: 'ev-blocked', sessionId: 'session-blocked', kind: 'session.start', occurredAt: new Date().toISOString() }));

      const { status } = await s.runToCompletion();
      expect(status.status).toBe('partial');
      expect(status.connections[0]).toMatchObject({ drain: 'blocked', revoked: false, cleaned: false, step: 'drained', result: 'partial' });
      expect(existsSync(bridgeConfig)).toBe(false);   // still neutralized
      expect(existsSync(eventFile)).toBe(true);        // the spool itself is untouched — nothing discarded
      const snapshot = s.store.snapshot().state;
      expect(snapshot.observation!.connections.find(c => c.id === id)!.status).not.toBe('revoked');   // still registered

      s.store.commit('free-a-slot-for-the-test', current => { current.agents.pop(); return 'test.freed_a_slot'; });
      const repeat = await s.runToCompletion();
      expect(repeat.status.status).toBe('stopped');
      expect(repeat.status.connections[0]).toMatchObject({ drain: 'drained', revoked: true, cleaned: true, step: 'cleaned', result: 'stopped' });
      expect(existsSync(eventFile)).toBe(false);
    } finally { await s.close(); }
  }, 20000);

  it('Discard removes the connection even though events were still pending, and counts them as discarded', async () => {
    const w = workspace(), { vault } = cappedVault();
    const state = stopSyncingState(w.root);
    for (let index = 0; index < RETAINED_AGENT_LIMIT; index++) {
      state.agents.push({ id: `filler-${index}`, name: `Filler ${index}`, provider: 'Codex', role: 'Filler', repoId: 'repo-one', task: 'Filler agent', activity: 'idle', color: '#859b87', home: [index, 0], updatedAt: new Date().toISOString(), files: [], evidence: 'Unavailable', contextVersion: null });
    }
    const s = await stopSyncingService(w, vault, { state });
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      const spool = spoolPath(w.data, id);
      const eventFile = join(spool, `${randomUUID()}.json`);
      writeFileSync(eventFile, JSON.stringify({ id: 'ev-discard', sessionId: 'session-discard', kind: 'session.start', occurredAt: new Date().toISOString() }));

      const { status } = await s.runToCompletion({ discard: true });
      expect(status.status).toBe('stopped');
      expect(status.connections[0]).toMatchObject({ revoked: true, cleaned: true, step: 'cleaned', result: 'stopped', eventsDiscarded: 1 });
      expect(existsSync(eventFile)).toBe(false);
      expect(existsSync(spool)).toBe(false);
    } finally { await s.close(); }
  }, 20000);
});

describe('Stop watching (H0-13): D47 default — while automatic manager processing is on, the final drain holds the reports it saves', () => {
  const automaticState = (root: string) => {
    const state = stopSyncingState(root);
    state.workflow = { ...initialWorkflow(), manager: { ...initialWorkflow().manager, config: { ...initialWorkflow().manager.config, enabled: true, automatic: true } } };
    return state;
  };

  it('records held report IDs when automatic is on; nothing is held when it is off', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault, { state: automaticState(w.root) });
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      writeFileSync(join(spoolPath(w.data, id), `${randomUUID()}.json`), JSON.stringify({ id: 'ev-held', sessionId: 'session-held', kind: 'report', occurredAt: new Date().toISOString(), summary: 'Held response.' }));
      const preview = await s.preview();
      expect(preview.automaticManagerProcessing).toBe(true);
      const { status } = await s.runToCompletion();
      expect(status.connections[0]!.heldFromManager).toBe(true);
      const snapshot = s.store.snapshot().state;
      expect(snapshot.handoffs).toHaveLength(1);
      expect(snapshot.handoffs[0]!.status).toBe('saved');   // held, but still saved and fully readable
      expect(snapshot.observation!.heldFromManagerReportIds).toEqual([snapshot.handoffs[0]!.id]);
    } finally { await s.close(); }
  });

  it('automatic off: unchanged — nothing is held', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault);
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      writeFileSync(join(spoolPath(w.data, id), `${randomUUID()}.json`), JSON.stringify({ id: 'ev-not-held', sessionId: 'session-not-held', kind: 'report', occurredAt: new Date().toISOString(), summary: 'Not held.' }));
      const preview = await s.preview();
      expect(preview.automaticManagerProcessing).toBe(false);
      const { status } = await s.runToCompletion();
      expect(status.connections[0]!.heldFromManager).toBe(false);
      expect(s.store.snapshot().state.observation!.heldFromManagerReportIds ?? []).toEqual([]);
    } finally { await s.close(); }
  });

  it('Stop watching\'s own flow calls no model provider, whether automatic is on or off (FD-06 modelSpy)', async () => {
    // modelSpy sees a WorkflowProvider call; Stop watching's own code here never constructs or calls one, so
    // this proves the action itself starts no paid pass. It does not by itself prove a held report can never
    // later reach an ordinary automatic manager tick — see this item's evidence note for the exact, still-open
    // integration point (eligibleForManager, apps/service/src/workflow/budget.ts, not owned by this item).
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault, { state: automaticState(w.root) });
    const spy = modelSpy();
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      writeFileSync(join(spoolPath(w.data, id), `${randomUUID()}.json`), JSON.stringify({ id: 'ev-spy', sessionId: 'session-spy', kind: 'report', occurredAt: new Date().toISOString(), summary: 'Spy check.' }));
      await s.runToCompletion();
      spy.expectNone();
    } finally { await s.close(); }
  });
});

describe('Stop watching (H0-13): isolation and bounds', () => {
  it('never touches another owner\'s connection for the same project', async () => {
    const w = workspace(), { vault } = cappedVault();
    let owner = '101';
    const s = await stopSyncingService(w, vault, { owner: () => owner });
    try {
      const mine = await s.create('codex');
      await s.applyHooks(mine);
      owner = '202';
      const theirs = await s.create('claude');
      await s.applyHooks(theirs);
      owner = '101';

      const review = await s.preview();
      expect(review.connections.map((c: { connectionId: string }) => c.connectionId)).toEqual([mine]);
      const { status } = await s.runToCompletion();
      expect(status.connections.map((c: { connectionId: string }) => c.connectionId)).toEqual([mine]);
      expect(status.connections[0]!.result).toBe('stopped');

      const snapshot = s.store.snapshot().state;
      expect(snapshot.observation!.connections.find(c => c.id === theirs)!.status).not.toBe('revoked');
      expect(existsSync(join(w.root, '.claude', 'settings.local.json'))).toBe(true);
    } finally { await s.close(); }
  });

  it('refuses a project with more than the connection cap still needing it, without touching any of them', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault);
    try {
      for (let index = 0; index < STOP_SYNCING_CONNECTION_CAP + 1; index++) s.api.registry.register(stopSyncingRecord(w.root, 'codex', { nativeSourceId: randomUUID() }), randomUUID());
      const preview = await s.app.inject({ method: 'GET', url: `${s.stopBase}?repoId=repo-one` });
      expect(preview.statusCode).toBe(429);
      expect(preview.json()).toMatchObject({ code: 'STOP_SYNCING_CONNECTION_CAP' });
      const started = await s.start({ reviewToken: 'whatever-it-is-refused-first' });
      expect(started.statusCode).toBe(429);
      expect(started.json()).toMatchObject({ code: 'STOP_SYNCING_CONNECTION_CAP' });
    } finally { await s.close(); }
  });

  it('cancel between two connections finishes the first and leaves the second completely untouched', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault);
    try {
      const first = await s.create('codex'); await s.applyHooks(first);
      const second = await s.create('claude'); await s.applyHooks(second);

      const review = await s.preview();
      expect(review.connections).toHaveLength(2);
      const started = await s.start({ reviewToken: review.reviewToken });
      const operationId = started.json().operationId as string;
      const cancelled = await s.cancel(operationId);
      expect(cancelled.json()).toEqual({ cancellationRequested: true });
      const status = await s.waitDone(operationId);

      expect(status.status).toBe('cancelled');
      expect(status.connections[0]).toMatchObject({ connectionId: first, step: 'cleaned', result: 'stopped' });
      expect(status.connections[1]).toMatchObject({ connectionId: second, step: null, result: null });
      const snapshot = s.store.snapshot().state;
      expect(snapshot.observation!.connections.find(c => c.id === second)!.status).not.toBe('revoked');
      expect(existsSync(join(w.root, '.claude', 'settings.local.json'))).toBe(true);
      expect(existsSync(bridgeConfigPath(w.data, second))).toBe(true);
    } finally { await s.close(); }
  });
});

describe.each(stopSyncingSteps)('Stop watching (H0-13): a job that ends right after "%s" is durable and resumable', (step: StopSyncingStep) => {
  it('the step shows after a reload; a repeat finishes the work; a second repeat is a no-op', async () => {
    const w = workspace(), { vault } = cappedVault();
    const dbPath = join(w.data, 'town.sqlite');
    let killed = false;
    __setStopSyncingStepHookForTests((_connectionId, reached) => { if (!killed && reached === step) { killed = true; throw new Error(`TEST KILL at ${step}`); } });
    const s1 = await stopSyncingService(w, vault, { dbPath });
    try {
      const id = await s1.create('codex');
      await s1.applyHooks(id);
      writeFileSync(join(spoolPath(w.data, id), `${randomUUID()}.json`), JSON.stringify({ id: 'ev-kill', sessionId: 'session-kill', kind: 'report', occurredAt: new Date().toISOString(), summary: 'Kill test response.' }));
      const review = await s1.preview();
      const started = await s1.start({ reviewToken: review.reviewToken });
      expect(started.statusCode).toBe(202);
      await s1.waitDone(started.json().operationId as string);
      expect(killed).toBe(true);
    } finally { await s1.close(); }
    __setStopSyncingStepHookForTests(null);

    // "Reload": a brand-new service instance reading the same on-disk data and the same database file —
    // nothing about resuming depends on the process (or the in-memory job map) that started the work.
    const s2 = await stopSyncingService(w, vault, { dbPath });
    try {
      const reloaded = await s2.preview();
      if (step === 'cleaned') {
        // A kill right after the very last marker is already fully done: nothing is left to show or resume.
        expect(reloaded.connections).toHaveLength(0);
        const noop = await s2.runToCompletion();
        expect(noop.status.connections).toHaveLength(0);
        expect(noop.status.status).toBe('stopped');
        return;
      }
      expect(reloaded.connections).toHaveLength(1);
      expect(reloaded.connections[0]!.step).toBe(step);
      expect(['partial', null]).toContain(reloaded.connections[0]!.result);

      const finished = await s2.runToCompletion();
      expect(finished.status.status).toBe('stopped');
      expect(finished.status.connections[0]).toMatchObject({ step: 'cleaned', result: 'stopped', revoked: true, cleaned: true });

      const again = await s2.preview();
      expect(again.connections).toHaveLength(0);
      const secondRepeat = await s2.runToCompletion();
      expect(secondRepeat.status.connections).toHaveLength(0);
      expect(secondRepeat.status.status).toBe('stopped');
    } finally { await s2.close(); }
  }, 20000);
});

// H0-32: the durable per-connection stopSyncingProgress record now carries the FULL outcome (hooks, drain,
// held-report count, hide outcome), not just {connectionId, step, result} — this is what lets a preview or a
// resumed job honestly reconstruct a connection's status once the in-memory job that produced it is gone (a
// restart, or simply a later preview), instead of fabricating fresh zeros/false/'skipped' defaults for it.
describe('Stop watching (H0-32): the durable record carries the full outcome, not just step/result', () => {
  const automaticState = (root: string) => {
    const initial = stopSyncingState(root);
    initial.workflow = { ...initialWorkflow(), manager: { ...initialWorkflow().manager, config: { ...initialWorkflow().manager.config, enabled: true, automatic: true } } };
    return initial;
  };
  /** One agent already tied to `connectionId`/`sessionId` (so an event for it can be delivered even once the
   * town is otherwise completely full — the `if (!agent)` capacity check in reducer.ts is skipped entirely
   * for an existing agent), plus enough filler agents to fill the rest of the town to RETAINED_AGENT_LIMIT. */
  const fullTownWithExistingSession = (connectionId: string, sessionId: string) => {
    const agents = [{ id: 'agent-existing-session', name: 'Codex 1', provider: 'Codex' as const, role: 'Observed session', repoId: 'repo-one', task: 'External session · task not linked', activity: 'idle' as const, color: '#859b87', home: [0, 0] as [number, number], updatedAt: new Date().toISOString(), files: [], evidence: 'No verification evidence has been collected.', contextVersion: null,
      observation: { connectionId, sessionId, parentSessionId: null, lastSequence: null, sourceTime: '1970-01-01T00:00:00.000Z', freshness: 'current' as const, billing: 'unavailable' as const } }];
    for (let index = 0; index < RETAINED_AGENT_LIMIT - 1; index++) {
      agents.push({ id: `filler-${index}`, name: `Filler ${index}`, provider: 'Codex' as const, role: 'Filler', repoId: 'repo-one', task: 'Filler agent', activity: 'idle' as const, color: '#859b87', home: [index + 1, 0] as [number, number], updatedAt: new Date().toISOString(), files: [], evidence: 'Unavailable', contextVersion: null } as typeof agents[number]);
    }
    return agents;
  };

  it('a blocked drain that already held a real report keeps its true drain/eventsDelivered/heldFromManager/heldReportCount in the durable record, and a fresh preview rebuilds the same real values, not fabricated defaults', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault, { state: automaticState(w.root) });
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      s.store.commit('seed-full-town', current => { current.agents.push(...fullTownWithExistingSession(id, 'session-existing')); return 'test.seeded_full_town'; });
      const spool = spoolPath(w.data, id);
      // Sorted (occurredAt) before the blocked one, so it is delivered first, in the same batch, before the
      // second one's brand-new session hits AGENT_CAPACITY and the whole batch reports 'blocked'.
      writeFileSync(join(spool, '00000000-0000-4000-8000-00000000a001.json'), JSON.stringify({ id: 'ev-held', sessionId: 'session-existing', kind: 'report', occurredAt: new Date(Date.now() - 5000).toISOString(), summary: 'Held response text.' }));
      writeFileSync(join(spool, '00000000-0000-4000-8000-00000000a002.json'), JSON.stringify({ id: 'ev-blocked', sessionId: 'session-blocked', kind: 'session.start', occurredAt: new Date().toISOString() }));

      const { status } = await s.runToCompletion();
      expect(status.status).toBe('partial');
      expect(status.connections[0]).toMatchObject({ drain: 'blocked', eventsDelivered: 1, heldFromManager: true, heldReportCount: 1, hidden: false, revoked: false, cleaned: false, step: 'drained', result: 'partial' });
      const snapshot = s.store.snapshot().state;
      expect(snapshot.handoffs).toHaveLength(1);
      expect(snapshot.observation!.heldFromManagerReportIds).toEqual([snapshot.handoffs[0]!.id]);

      const progress = snapshot.observation!.stopSyncingProgress!.find(item => item.connectionId === id)!;
      expect(progress).toMatchObject({ step: 'drained', result: 'partial', drain: 'blocked', eventsDelivered: 1, heldFromManager: true, heldReportCount: 1, hidden: false, retryable: true });

      // A fresh preview — the same route a page reload or a later look reads, entirely independent of the
      // finished job object above — must rebuild these same real values from the durable record alone.
      const preview = await s.preview();
      expect(preview.connections).toHaveLength(1);
      expect(preview.connections[0]).toMatchObject({ drain: 'blocked', eventsDelivered: 1, heldFromManager: true, heldReportCount: 1, hidden: false, step: 'drained', result: 'partial' });
    } finally { await s.close(); }
  }, 20000);

  it('resuming a connection already revoked but not cleaned carries forward its real drain/held facts instead of re-zeroing them', async () => {
    const w = workspace(), { vault } = cappedVault();
    const dbPath = join(w.data, 'town.sqlite');
    let killed = false;
    __setStopSyncingStepHookForTests((_connectionId, reached) => { if (!killed && reached === 'revoked') { killed = true; throw new Error('TEST KILL at revoked'); } });
    const s1 = await stopSyncingService(w, vault, { dbPath, state: automaticState(w.root) });
    let id = '';
    try {
      id = await s1.create('codex');
      await s1.applyHooks(id);
      writeFileSync(join(spoolPath(w.data, id), `${randomUUID()}.json`), JSON.stringify({ id: 'ev-resume-held', sessionId: 'session-resume', kind: 'report', occurredAt: new Date().toISOString(), summary: 'Resume test response.' }));
      const review = await s1.preview();
      const started = await s1.start({ reviewToken: review.reviewToken });
      expect(started.statusCode).toBe(202);
      await s1.waitDone(started.json().operationId as string);
      expect(killed).toBe(true);

      // Revoked (and hidden) already happened before the kill; clean-up never ran.
      const midway = s1.store.snapshot().state;
      expect(midway.observation!.connections.find(c => c.id === id)!.status).toBe('revoked');
      const midProgress = midway.observation!.stopSyncingProgress!.find(item => item.connectionId === id)!;
      expect(midProgress).toMatchObject({ step: 'revoked', result: null, drain: 'drained', eventsDelivered: 1, heldFromManager: true, heldReportCount: 1, hidden: true });
    } finally { __setStopSyncingStepHookForTests(null); await s1.close(); }

    // Resume, under a brand-new service instance reading the same on-disk data: the "already revoked" branch
    // never re-runs the drain, so it must carry the real facts above forward rather than resetting them.
    const s2 = await stopSyncingService(w, vault, { dbPath });
    try {
      const resumed = await s2.runToCompletion();
      expect(resumed.status.status).toBe('stopped');
      expect(resumed.status.connections[0]).toMatchObject({ step: 'cleaned', result: 'stopped', revoked: true, cleaned: true, drain: 'drained', eventsDelivered: 1, heldFromManager: true, heldReportCount: 1, hidden: true });

      const finalProgress = s2.store.snapshot().state.observation!.stopSyncingProgress!.find(item => item.connectionId === id)!;
      expect(finalProgress).toMatchObject({ step: 'cleaned', result: 'stopped', drain: 'drained', eventsDelivered: 1, heldFromManager: true, heldReportCount: 1, hidden: true, retryable: false });
    } finally { await s2.close(); }
  }, 20000);

  it('hidden reads false while the durable record is still at "drained", and flips true only once "revoked" is recorded (the revoke commit is what actually hides the project)', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault);
    const seenHidden: Partial<Record<StopSyncingStep, boolean>> = {};
    __setStopSyncingStepHookForTests((connectionId, reached) => {
      const entry = s.store.snapshot().state.observation!.stopSyncingProgress!.find(item => item.connectionId === connectionId);
      seenHidden[reached] = entry?.hidden ?? false;
    });
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      const { status } = await s.runToCompletion();
      expect(status.connections[0]).toMatchObject({ hidden: true, revoked: true, cleaned: true, step: 'cleaned', result: 'stopped' });
      expect(seenHidden['entries-removed']).toBe(false);
      expect(seenHidden['neutralized']).toBe(false);
      expect(seenHidden['drained']).toBe(false);
      expect(seenHidden['revoked']).toBe(true);
      expect(seenHidden['cleaned']).toBe(true);
    } finally { __setStopSyncingStepHookForTests(null); await s.close(); }
  });

  it('records heldReportCount as the exact number of newly held reports, not just whether any were held', async () => {
    const w = workspace(), { vault } = cappedVault(), s = await stopSyncingService(w, vault, { state: automaticState(w.root) });
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      const spool = spoolPath(w.data, id);
      writeFileSync(join(spool, `${randomUUID()}.json`), JSON.stringify({ id: 'ev-held-a', sessionId: 'session-held-a', kind: 'report', occurredAt: new Date(Date.now() - 2000).toISOString(), summary: 'First held response.' }));
      writeFileSync(join(spool, `${randomUUID()}.json`), JSON.stringify({ id: 'ev-held-b', sessionId: 'session-held-b', kind: 'report', occurredAt: new Date().toISOString(), summary: 'Second held response.' }));

      const { status } = await s.runToCompletion();
      expect(status.status).toBe('stopped');
      expect(status.connections[0]).toMatchObject({ heldFromManager: true, heldReportCount: 2, hidden: true, revoked: true, cleaned: true, step: 'cleaned', result: 'stopped' });
      const snapshot = s.store.snapshot().state;
      expect(snapshot.handoffs).toHaveLength(2);
      expect(new Set(snapshot.observation!.heldFromManagerReportIds)).toEqual(new Set(snapshot.handoffs.map(report => report.id)));
      const progress = snapshot.observation!.stopSyncingProgress!.find(item => item.connectionId === id)!;
      expect(progress).toMatchObject({ heldReportCount: 2, hidden: true });
    } finally { await s.close(); }
  });

  // Audit note: the existing "a job that ends right after '%s' is durable and resumable" cases above always
  // seed and kill a fresh, still-active job themselves — none of them starts from a connection that was
  // ALREADY fully revoked but not cleaned before the very first look this test takes at it (no in-memory job
  // was ever created in THIS process at all). This sibling proves the durable record alone reconstructs an
  // honest, non-fabricated preview for exactly that case.
  it('a connection left revoked-but-not-cleaned by an earlier process is read honestly by a preview in a brand-new one, with no in-memory job at all', async () => {
    const w = workspace(), { vault } = cappedVault();
    const dbPath = join(w.data, 'town.sqlite');
    let killed = false;
    __setStopSyncingStepHookForTests((_connectionId, reached) => { if (!killed && reached === 'revoked') { killed = true; throw new Error('TEST KILL at revoked'); } });
    const s1 = await stopSyncingService(w, vault, { dbPath, state: automaticState(w.root) });
    let id = '';
    try {
      id = await s1.create('codex');
      await s1.applyHooks(id);
      writeFileSync(join(spoolPath(w.data, id), `${randomUUID()}.json`), JSON.stringify({ id: 'ev-reload-held', sessionId: 'session-reload', kind: 'report', occurredAt: new Date().toISOString(), summary: 'Reload test response.' }));
      const review = await s1.preview();
      const started = await s1.start({ reviewToken: review.reviewToken });
      await s1.waitDone(started.json().operationId as string);
      expect(killed).toBe(true);
    } finally { __setStopSyncingStepHookForTests(null); await s1.close(); }

    // A brand-new service instance, its own empty in-memory job map, reading the same on-disk data: nothing
    // about this preview depends on the process (or the job object) that ran the work above.
    const s2 = await stopSyncingService(w, vault, { dbPath });
    try {
      const preview = await s2.preview();
      expect(preview.connections).toHaveLength(1);
      expect(preview.connections[0]).toMatchObject({ connectionId: id, step: 'revoked', result: null, drain: 'drained', eventsDelivered: 1, heldFromManager: true, heldReportCount: 1, hidden: true, revoked: true, cleaned: false });

      // And it can still be finished from here, with those same real facts intact at the end.
      const finished = await s2.runToCompletion();
      expect(finished.status.status).toBe('stopped');
      expect(finished.status.connections[0]).toMatchObject({ step: 'cleaned', result: 'stopped', drain: 'drained', eventsDelivered: 1, heldFromManager: true, heldReportCount: 1, hidden: true });
    } finally { await s2.close(); }
  }, 20000);
});

describe('Stop watching (H0-13): the real shutdown deadlines (FD-06\'s runShutdown/stepsJob helper)', () => {
  const STOP_SYNCING_STEP_NAMES = [...stopSyncingSteps];

  it('finishes well inside the 20 s limit after Ctrl+C or a terminate signal when the connection\'s own steps are quick', async () => {
    const job = stepsJob(STOP_SYNCING_STEP_NAMES.map(name => ({ name, ms: 500 })), 'fit-before-deadline');
    const report = await runShutdown({ job, signal: 'SIGINT' });
    expect(report.outcome).toBe('finished');
    expect(report.completedSteps).toEqual(STOP_SYNCING_STEP_NAMES);
    expect(report.lockReleasedBeforeExit).toBe(true);
  });

  it('stops at the next step boundary under the 6 s limit used when the console window closes, and a repeat finishes the rest', async () => {
    const job = stepsJob(STOP_SYNCING_STEP_NAMES.map(name => ({ name, ms: 2500 })), 'fit-before-deadline');
    const report = await runShutdown({ job, signal: 'SIGHUP' });
    expect(report.outcome).toBe('stopped');
    expect(report.lockReleasedBeforeExit).toBe(true);
    expect(report.completedSteps.length).toBeGreaterThan(0);
    expect(report.completedSteps.length).toBeLessThan(STOP_SYNCING_STEP_NAMES.length);
    const remaining = STOP_SYNCING_STEP_NAMES.filter(name => !report.completedSteps.includes(name));
    expect(remaining).toEqual(report.skippedSteps);

    const repeat = await runShutdown({ job: stepsJob(remaining.map(name => ({ name, ms: 500 })), 'fit-before-deadline'), signal: 'SIGHUP' });
    expect(repeat.outcome).toBe('finished');
    expect(repeat.completedSteps).toEqual(remaining);
  });
});

describe('Stop watching (H0-13): close() itself awaits a genuinely in-flight job', () => {
  it('close() stays pending while a job is still blocked inside its own step, and only resolves once the job reaches a terminal status', async () => {
    // Same gate pattern as "runs under the same per-project lock as apply" above, but applied to Stop
    // watching's own step 1 (hook removal) rather than to a plain apply: proves close()'s own
    // `await Promise.allSettled([...stopSyncingJobs.values()].map(job => job.promise))` line is load-bearing,
    // not just that a fast job happens to finish before close() is ever called (every other test in this file
    // always awaits a job to a terminal status before calling close()).
    const w = workspace(), { vault: base, puts } = cappedVault();
    let armed = false, release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const vault: CredentialVault = { ...base, put: async (reference, value) => { if (armed) { puts.push('waiting'); await gate; } await base.put(reference, value); } };
    const s = await stopSyncingService(w, vault);
    try {
      const id = await s.create('codex');
      await s.applyHooks(id);
      armed = true;   // only the stop job's own backup (below) gates now, not the apply above
      const review = await s.preview();
      const started = await s.start({ reviewToken: review.reviewToken });
      expect(started.statusCode).toBe(202);
      const operationId = started.json().operationId as string;
      while (!puts.includes('waiting')) await sleep(10);   // the job is now blocked mid-backup inside its own step 1

      let closed = false;
      const closePromise = s.api.close().then(() => { closed = true; });
      await sleep(300);
      expect(closed).toBe(false);   // close() must not resolve while the job is genuinely still in flight

      release();
      await closePromise;
      expect(closed).toBe(true);

      const status = await s.poll(operationId);
      expect(status.status).not.toBe('running');           // reached a terminal status, never left dangling
      expect(['stopped', 'partial']).toContain(status.status);
    } finally { release(); await s.app.close(); s.store.close(); }
  }, 20000);
});
