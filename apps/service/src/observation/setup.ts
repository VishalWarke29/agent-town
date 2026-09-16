import { dirname, join } from 'node:path';
import { mkdir, writeFile, rename, lstat, unlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ObservationSetup } from '@agent-town/contracts';
import { projectRoot } from '../store.js';
import { checkedPath, readMetadataFile } from '../discovery/paths.js';
import { IdentityError, type CredentialVault } from '../identity/index.js';
import type { RegisteredObservation } from './registry.js';

export function bridgeConfigPath(directory: string, id: string) { return join(directory, 'observation', 'connections', `${id}.json`); }
export function spoolPath(directory: string, id: string) { return join(directory, 'observation', 'spool', id); }
const installedPath = (directory: string, id: string) => join(directory, 'observation', 'installed', `${id}.json`);
type HookConfiguration = { hooks: Record<string, unknown[]>; version?: number };
function quote(path: string) {
  if (/["%\r\n!^&|<>`$]/.test(path)) throw new IdentityError('HOOK_PATH_UNSUPPORTED', 'The installation path contains shell-special characters. Use a simple local installation path.');
  return `"${path.replaceAll('\\', '/')}"`;
}

function hookConfiguration(record: RegisteredObservation, directory: string, legacy = false): { config: HookConfiguration; bridgeCommand: string } {
  const provider = record.connection.provider;
  const bridgeCommand = `${legacy ? 'node' : quote(process.execPath)} ${quote(join(projectRoot, 'apps/service/dist/hook-bridge.cjs'))} --config ${quote(bridgeConfigPath(directory, record.connection.id))}`;
  const events = provider === 'cursor' ? ['sessionStart', 'sessionEnd', 'preToolUse', 'postToolUse', 'stop', 'subagentStart', 'subagentStop']
    : provider === 'copilot-cli' ? ['sessionStart', 'sessionEnd', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'agentStop', 'subagentStart', 'subagentStop']
    : provider === 'copilot-vscode' && !legacy ? ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']
    : ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', ...(provider === 'claude' ? ['PostToolUseFailure', 'StopFailure'] : [])];
  const hooks = Object.fromEntries(events.map(event => {
    const command = `${bridgeCommand} --event ${event}`;
    if (!legacy && provider === 'copilot-vscode') return [event, [{ type: 'command', command, windows: command, timeout: 5 }]];
    if (!legacy && provider === 'copilot-cli') return [event, [{ type: 'command', exec: process.execPath, args: [join(projectRoot, 'apps/service/dist/hook-bridge.cjs'), '--config', bridgeConfigPath(directory, record.connection.id), '--event', event], timeoutSec: 5 }]];
    return [event, provider === 'cursor' ? [{ command, timeout: 5 }] : provider.startsWith('copilot') ? [{ type: 'command', command, powershell: command, bash: command, timeoutSec: 5 }] : [{ hooks: [{ type: 'command', command, timeout: !legacy && provider === 'codex' && event === 'SessionEnd' ? 2 : 5 }] }]];
  }));
  return { config: { ...(provider === 'cursor' || provider === 'copilot-cli' || legacy && provider === 'copilot-vscode' ? { version: 1 } : {}), hooks }, bridgeCommand };
}

export function observationSetup(record: RegisteredObservation, directory: string): ObservationSetup {
  const provider = record.connection.provider;
  if (provider === 'custom') return { connection: record.connection, configPath: '', config: JSON.stringify({ id: 'unique-event-id', sessionId: 'stable-session-id', kind: 'session.start', occurredAt: new Date().toISOString() }, null, 2),
    bridgeCommand: `${quote(process.execPath)} ${quote(join(projectRoot, 'apps/service/dist/hook-bridge.cjs'))} --config ${quote(bridgeConfigPath(directory, record.connection.id))} --normalized`,
    instructions: ['This source receives normalized events from your own integration. It has no automatic native hook or session discovery.', 'Pass one JSON event on standard input to the local bridge command. Use a stable session ID, a unique event ID, and the actual event time; retries keep the same event ID.', 'The bridge captures the registered source and queues delivery while Agent Town is closed. It requires no credential in your command or repository.', 'Summary and file evidence are optional. Exclude prompts, secrets, and raw transcripts from your event.'],
    diagnostics: record.connection.nativeSourceId ? [] : [{ code: 'CUSTOM_SOURCE_REQUIRED', message: 'Select a registered custom source before sending events through this bridge.' }],
    readiness: { configured: !!record.connection.nativeSourceId, nativeTrustRequired: false, sourceBinding: record.connection.binding ?? 'declared', overlappingHooks: false } };
  const { config, bridgeCommand } = hookConfiguration(record, directory);
  const configPath = join(record.repoPath, provider === 'claude' ? '.claude/settings.local.json' : provider === 'codex' ? '.codex/hooks.json' : provider === 'cursor' ? '.cursor/hooks.json' : `.github/hooks/agent-town-${record.connection.id}.json`);
  return { connection: record.connection, configPath, config: JSON.stringify(config, null, 2), bridgeCommand,
    diagnostics: [], readiness: { configured: false, nativeTrustRequired: true, sourceBinding: record.connection.binding ?? 'unavailable', overlappingHooks: false },
    instructions: ['Review these observation-only hook additions before applying them.', 'Existing hooks are preserved. The bridge records metadata and supplied final responses; it does not read transcripts or prompts.', 'Reload the native tool and review its hook trust before relying on future events. Existing session discovery is a separate capability.',
      ...(provider === 'codex' ? ['In Codex CLI, open /hooks to review and trust these exact command definitions. A changed definition needs new native trust. Resume existing sessions normally to load the hooks.'] : []),
      ...(provider === 'copilot-vscode' ? ['The VS Code hook format is available, but this adapter cannot yet verify its producing tool. New callbacks with ambiguous attribution are rejected. Use an explicit custom connector for declared activity until native attribution is verified.'] : []),
      ...(provider === 'claude' || provider.startsWith('copilot') ? ['Other compatible tools can also load this hook location. Review overlapping Agent Town callbacks; a configuration filename does not verify the producing tool.'] : []),
      'An event receipt confirms delivery only. Native coverage and usage remain partial; this connection cannot launch or stop external work.', 'Keep machine-specific hook paths out of shared commits. No credential is included in this configuration.'] };
}

export async function writeBridgeConfig(record: RegisteredObservation, directory: string) {
  const config = bridgeConfigPath(directory, record.connection.id), spool = spoolPath(directory, record.connection.id);
  await mkdir(dirname(config), { recursive: true, mode: 0o700 }); await mkdir(spool, { recursive: true, mode: 0o700 });
  await writeFile(config, JSON.stringify({ version: 2, connectionId: record.connection.id, provider: record.connection.provider, repoPath: record.repoPath, spoolPath: spool,
    ...(record.connection.nativeSourceId ? { nativeSourceId: record.connection.nativeSourceId, sourceRevision: record.connection.sourceRevision ?? 1, binding: record.connection.binding ?? 'declared' } : {}),
    ...(record.nativeHome ? { nativeHome: record.nativeHome } : {}) }), { mode: 0o600 });
}

function parseHooks(text: string): HookConfiguration {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hook configuration');
  const hooks = (value as { hooks?: unknown }).hooks ?? {};
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks) || Object.values(hooks).some(entries => !Array.isArray(entries))) throw new Error('Invalid hooks');
  return { hooks: hooks as Record<string, unknown[]> };
}

/** Reads only bounded hook configuration, and returns no unrelated command contents. */
export async function inspectObservationSetup(record: RegisteredObservation, directory: string): Promise<ObservationSetup> {
  const setup = observationSetup(record, directory), expected = hookConfiguration(record, directory).config;
  if (record.connection.provider === 'custom') return setup;
  const files = new Set([setup.configPath, ...['.codex/hooks.json', '.claude/settings.local.json', '.claude/settings.json', '.cursor/hooks.json'].map(path => join(record.repoPath, path))]);
  try {
    const folder = join(record.repoPath, '.github/hooks'); await checkedPath(folder, [record.repoPath]);
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries.slice(0, 100)) if (entry.isFile() && entry.name.endsWith('.json')) files.add(join(folder, entry.name));
    if (entries.length > 100) setup.diagnostics!.push({ code: 'HOOK_SCAN_LIMIT', message: 'Hook inspection reached its bounded file limit. Review additional hook files manually.' });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') setup.diagnostics!.push({ code: 'HOOK_DIRECTORY_UNREADABLE', message: 'The shared hook directory could not be checked safely.' }); }
  const connectionIds = new Set<string>();
  for (const file of files) {
    try {
      const hooks = parseHooks(await readMetadataFile(file, [record.repoPath], 128000)).hooks;
      if (file === setup.configPath) setup.readiness!.configured = Object.entries(expected.hooks).every(([event, entries]) => entries.every(entry => (hooks[event] ?? []).some(installed => JSON.stringify(installed) === JSON.stringify(entry))));
      for (const entries of Object.values(hooks)) for (const entry of entries) {
        const serialized = JSON.stringify(entry);
        if (!serialized.includes('hook-bridge.cjs') || !serialized.includes('--config')) continue;
        for (const match of serialized.matchAll(/([a-f0-9-]{36})\.json\b/gi)) connectionIds.add(match[1]!.toLowerCase());
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') setup.diagnostics!.push({ code: 'HOOK_CONFIG_UNREADABLE', message: 'A project hook configuration needs manual review before coverage can be verified.' });
    }
  }
  setup.readiness!.overlappingHooks = [...connectionIds].some(id => id !== record.connection.id.toLowerCase());
  if (setup.readiness!.overlappingHooks) setup.diagnostics!.push({ code: 'HOOK_OVERLAP', message: 'Other Agent Town callbacks are installed in this project. Compatible tools may invoke more than one; review native hook loading before relying on attribution.' });
  if (!record.connection.nativeSourceId || record.connection.binding !== 'resolved') setup.diagnostics!.push({ code: 'SOURCE_BINDING_UNVERIFIED', message: 'The native home or profile is not verified for this callback. Events retain their existing scope until source identity can be resolved.' });
  return setup;
}

async function installedConfigurations(record: RegisteredObservation, directory: string): Promise<HookConfiguration[]> {
  const known = [hookConfiguration(record, directory).config, hookConfiguration(record, directory, true).config];
  try {
    const value = JSON.parse(await readMetadataFile(installedPath(directory, record.connection.id), [directory], 128000)) as { version?: number; connectionId?: string; configurations?: unknown[] };
    if (value.version !== 1 || value.connectionId !== record.connection.id || !Array.isArray(value.configurations) || value.configurations.length > 20) throw new Error('Invalid installed manifest');
    for (const config of value.configurations) {
      const parsed = parseHooks(JSON.stringify(config));
      for (const entries of Object.values(parsed.hooks)) for (const entry of entries) {
        const text = JSON.stringify(entry);
        if (!text.includes('hook-bridge.cjs') || !text.includes('--config') || !text.includes(`${record.connection.id}.json`)) throw new Error('Invalid installed entry');
      }
      known.push(parsed);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IdentityError('HOOK_MANIFEST_UNSAFE', 'The saved hook installation record needs review before changing hooks.', 409);
  }
  return known;
}

async function saveInstalledConfigurations(record: RegisteredObservation, directory: string, configurations: HookConfiguration[]) {
  const path = installedPath(directory, record.connection.id), parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 }); await checkedPath(parent, [directory]);
  const unique = [...new Map(configurations.map(config => [JSON.stringify(config), config])).values()];
  if (unique.length > 20) throw new IdentityError('HOOK_MANIFEST_CAPACITY', 'Review previous hook installations before adding another command version.', 409);
  const data = JSON.stringify({ version: 1, connectionId: record.connection.id, configurations: unique });
  if (Buffer.byteLength(data) > 128000) throw new IdentityError('HOOK_MANIFEST_CAPACITY', 'The hook installation record reached its size limit.', 409);
  const temporary = join(parent, `${record.connection.id}-${randomUUID()}.tmp`);
  try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await checkedPath(parent, [directory]); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => undefined); }
}

/** Only known app-owned hook entries change; a concurrent file edit prevents replacement. */
export async function changeHooks(record: RegisteredObservation, directory: string, vault: CredentialVault, remove = false) {
  if (record.connection.provider === 'custom') throw new IdentityError('CUSTOM_HOOK_UNSUPPORTED', 'Custom integrations use normalized local events and have no automatically installed native hook.', 409);
  const setup = observationSetup(record, directory), path = setup.configPath;
  await checkedPath(record.repoPath, [record.repoPath]);
  const parent = dirname(path);
  // Create missing directories one component at a time, rejecting reparse points at every step.
  const relative = parent.slice(record.repoPath.length).split(/[\\/]/).filter(Boolean);
  let current = record.repoPath;
  for (const part of relative) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await checkedPath(current, [record.repoPath]);
  }
  let original = '';
  try { original = await readMetadataFile(path, [record.repoPath], 128000); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IdentityError('HOOK_CONFIG_UNSAFE', 'The hook file is not safely readable. Review it manually.', 409); }
  let existing: Record<string, unknown>;
  try { existing = original ? JSON.parse(original) as Record<string, unknown> : {}; }
  catch { throw new IdentityError('HOOK_CONFIG_INVALID', 'Existing hook JSON is invalid. Fix it before applying this connection.', 409); }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new IdentityError('HOOK_CONFIG_INVALID', 'Existing hook configuration must be a JSON object.', 409);
  const additions = JSON.parse(setup.config) as HookConfiguration;
  const known = await installedConfigurations(record, directory);
  const originalHooks = existing.hooks ?? {};
  if (!originalHooks || typeof originalHooks !== 'object' || Array.isArray(originalHooks)) throw new IdentityError('HOOK_CONFIG_INVALID', 'Existing hooks must be an object.', 409);
  const hooks = { ...(originalHooks as Record<string, unknown>) };
  for (const name of new Set(known.flatMap(config => Object.keys(config.hooks)))) {
    const entries = additions.hooks[name] ?? [];
    const prior = hooks[name] ?? [];
    if (!Array.isArray(prior)) throw new IdentityError('HOOK_CONFIG_INVALID', 'An existing hook event is not a list.', 409);
    const owned = new Set(known.flatMap(config => config.hooks[name] ?? []).map(entry => JSON.stringify(entry)));
    // Exact equality avoids removing a user's edited or unrelated hook commands.
    hooks[name] = [...prior.filter(entry => !owned.has(JSON.stringify(entry))), ...(remove ? [] : entries)];
  }
  if (additions.version !== undefined && existing.version !== undefined && existing.version !== additions.version) throw new IdentityError('HOOK_VERSION_UNSUPPORTED', 'The hook configuration version needs manual review.', 409);
  const output = JSON.stringify({ ...existing, ...(additions.version !== undefined ? { version: additions.version } : {}), hooks }, null, 2) + '\n';
  let latest = '';
  try { latest = await readMetadataFile(path, [record.repoPath], 128000); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (latest !== original) throw new IdentityError('HOOK_CONFIG_CHANGED', 'The hook file changed during setup. Review and apply again.', 409);
  if (original) {
    const backup = join(directory, 'observation', 'backups', `${record.connection.id}-${randomUUID()}.json`);
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    const reference = `hook-backup-${randomUUID()}`;
    await vault.put(reference, original);
    await writeFile(backup, JSON.stringify({ at: new Date().toISOString(), action: remove ? 'remove' : 'apply', connectionId: record.connection.id, reference }), { mode: 0o600 });
  }
  const temporary = join(parent, `.agent-town-${randomUUID()}.tmp`);
  await checkedPath(parent, [record.repoPath]);
  // Save ownership before replacement so recovery/removal also handles a crash
  // immediately after the hook file is successfully replaced.
  await saveInstalledConfigurations(record, directory, known);
  try {
    await writeFile(temporary, output, { flag: 'wx', mode: 0o600 });
    const info = await lstat(temporary);
    if (!info.isFile() || info.isSymbolicLink()) throw new IdentityError('HOOK_CONFIG_UNSAFE', 'The hook configuration could not be saved.', 409);
    // DPAPI may take seconds: recheck after backup encryption, immediately before replacement.
    await checkedPath(parent, [record.repoPath]);
    latest = '';
    try { latest = await readMetadataFile(path, [record.repoPath], 128000); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (latest !== original) throw new IdentityError('HOOK_CONFIG_CHANGED', 'The hook file changed during setup. Review and apply again.', 409);
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
  return { changed: output !== original, path, removed: remove };
}
