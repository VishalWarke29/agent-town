import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { mkdir, writeFile, readFile, rename, lstat, stat, unlink, readdir, rm, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { CURRENT_EVENT_FORMAT, SERVICE_CAPABILITIES_FILE, currentEventKinds, type ObservationSetup, type ServiceCapabilities, type ToolSurface } from '@agent-town/contracts';
import { projectRoot } from '../store.js';
import { buildInfo } from '../build-info.js';
import { checkedPath, pathKey, readMetadataFile } from '../discovery/paths.js';
import { IdentityError, type CredentialVault } from '../identity/index.js';
import { MAX_PROTECTED_VALUE_BYTES } from '../identity/vault.js';
import { hasAmbiguousHookOverlap } from './source-binding.js';
import { eventName as spoolEventFileName } from './spool.js';
import type { RegisteredObservation } from './registry.js';

export function bridgeConfigPath(directory: string, id: string) { return join(directory, 'observation', 'connections', `${id}.json`); }
export function spoolPath(directory: string, id: string) { return join(directory, 'observation', 'spool', id); }
const installedPath = (directory: string, id: string) => join(directory, 'observation', 'installed', `${id}.json`);
const CONNECTION_ID_PATTERN = /^[a-f0-9-]{36}$/;
type HookConfiguration = { hooks: Record<string, unknown[]>; version?: number };
function quote(path: string) {
  if (/["%\r\n!^&|<>`$]/.test(path)) throw new IdentityError('HOOK_PATH_UNSUPPORTED', 'The installation path contains shell-special characters. Use a simple local installation path.');
  return `"${path.replaceAll('\\', '/')}"`;
}

let hookBridgePathOverride: string | null = null;
/** Test-only seam: points every hook-bridge existence/command check at a different (or missing) path,
 * so BRIDGE_MISSING (WS2-03) can be exercised without deleting the real build output that other tests
 * and the running dev service depend on. Never used outside tests. */
export function __setHookBridgePathForTests(path: string | null) { hookBridgePathOverride = path; }
/** The one place that knows where the built hook bridge lives, so the command written into a hook
 * file and the availability check below can never drift apart (WS2-03). */
export function hookBridgePath(): string { return hookBridgePathOverride ?? join(projectRoot, 'apps/service/dist/hook-bridge.cjs'); }
/** True only when the built helper the hook command invokes actually exists as a regular file. A
 * fresh clone or a dev-only checkout without a build would otherwise write hooks that call a missing
 * file: the tool would report "hook applied" and then wait forever with no event ever arriving. */
export async function hookBridgeAvailable(): Promise<boolean> {
  try { return (await stat(hookBridgePath())).isFile(); } catch { return false; }
}

let renameForTests: ((from: string, to: string) => Promise<void>) | null = null;
/** Test-only seam: replaces the final atomic rename so a test can simulate a Windows lock
 * (EPERM/EBUSY/EACCES) deterministically, without depending on this OS's actual file-sharing
 * semantics for an open handle. Never used outside tests. */
export function __setRenameForTests(fn: ((from: string, to: string) => Promise<void>) | null) { renameForTests = fn; }
const LOCK_RETRY_DELAYS_MS = [200, 300, 500];
const isWindowsLockError = (error: unknown) => ['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code ?? '');
/** An editor, antivirus scan, or the tool itself can briefly hold a hook file open; Windows then
 * refuses to replace it. Retries the rename a few times over about a second before giving up with a
 * typed, readable error — never a raw OS error, and never a change partially applied (WS3-25). */
export async function renameWithLockRetry(from: string, to: string): Promise<void> {
  const attempt = renameForTests ?? rename;
  await retryWhileLocked(async () => {
    try { await attempt(from, to); }
    catch (error) {
      // Windows answers a read-only destination with the same error as a locked one; waiting never helps the first, so
      // it is told apart at once and named for what it is (H0-10 review).
      if (isWindowsLockError(error) && await isReadOnlyFile(to)) throw new IdentityError('HOOK_FILE_READ_ONLY', 'This settings file is marked read-only, so Agent Town left it alone. Clear the read-only setting on the file (its Properties in File Explorer), then try again.', 409);
      throw error;
    }
  });
}
async function isReadOnlyFile(path: string): Promise<boolean> {
  try { return ((await lstat(path)).mode & 0o200) === 0; } catch { return false; }
}
let unlinkForTests: ((path: string) => Promise<void>) | null = null;
/** Test-only seam, like the rename one: makes deleting the moved-aside copy of a removed hook file fail on demand. */
export function __setUnlinkForTests(fn: ((path: string) => Promise<void>) | null) { unlinkForTests = fn; }
/** Deletes a file, retrying the short-lived locks Windows gives a file that was just moved (an antivirus scan, the search
 * indexer). Only a file that is already gone counts as deleted; anything else still failing after the retries throws. */
async function unlinkWithLockRetry(path: string): Promise<void> {
  const attempt = unlinkForTests ?? unlink;
  try { await retryWhileLocked(() => attempt(path)); }
  catch (error) { if (!isMissingPath(error)) throw error; }
}
async function retryWhileLocked(operation: () => Promise<void>): Promise<void> {
  for (let index = 0; ; index++) {
    try { await operation(); return; }
    catch (error) {
      if (!isWindowsLockError(error) || index >= LOCK_RETRY_DELAYS_MS.length) {
        if (isWindowsLockError(error)) throw new IdentityError('HOOK_FILE_LOCKED', 'This file is briefly in use by another program (an editor, an antivirus scan, or the tool itself). Wait a moment, then try again.', 409);
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAYS_MS[index]));
    }
  }
}

function hookConfiguration(record: RegisteredObservation, directory: string, legacy = false): { config: HookConfiguration; bridgeCommand: string } {
  const provider = record.connection.provider;
  const bridgeCommand = `${legacy ? 'node' : quote(process.execPath)} ${quote(hookBridgePath())} --config ${quote(bridgeConfigPath(directory, record.connection.id))}`;
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

/** What a person must still do in the tool after its hook file is written. A pure lookup, so it can
 * never fail a detection or apply. Only Codex requires per-hook trust; the others reload on their own
 * or at start-up (checked against each tool's current hook documentation, 17 September 2026). */
export function activationStep(provider: ToolSurface): string {
  switch (provider) {
    case 'codex': return 'In Codex, run /hooks in this project and trust the Agent Town commands. A changed command needs new trust. Resume existing sessions normally so they load the hooks.';
    case 'claude': return 'Claude Code normally reloads this settings file on its own. If nothing arrives, start a new session in this folder, or run /hooks to review the new settings.';
    case 'cursor': return 'Cursor normally reloads hooks on its own in a trusted workspace. If nothing arrives, reopen the project.';
    case 'copilot-cli': return 'Copilot CLI loads hooks when it starts: restart it in this project and accept its folder trust prompt.';
    default: return 'Reload the native tool and review its hook trust before relying on future events.';
  }
}

/** Removes the local files created for one connection that never became active. */
export async function removeConnectionFiles(directory: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new IdentityError('INVALID_CONNECTION', 'Use a valid connection identifier.');
  await Promise.all([
    rm(bridgeConfigPath(directory, id), { force: true }),
    rm(spoolPath(directory, id), { recursive: true, force: true }),
    rm(installedPath(directory, id), { force: true }),
  ]);
}

/** Helper for Stop watching (H0-11; H0-13 orchestrates the order). Deletes only this connection's bridge
 * config file, so a hook that fires afterward finds it missing: bridge.ts reads it before anything else,
 * catches the missing file the same as every other unsafe input, writes nothing to the spool, and still
 * answers `{}` with exit code 0 — never a blocked or hanging Claude Code or Codex. Idempotent; leaves the
 * spool itself untouched, since the final drain still needs to read what is already queued there. */
export async function neutralizeConnection(directory: string, id: string): Promise<void> {
  if (!CONNECTION_ID_PATTERN.test(id)) throw new IdentityError('INVALID_CONNECTION', 'Use a valid connection identifier.');
  await rm(bridgeConfigPath(directory, id), { force: true });
}

export interface CleanupConnectionOptions {
  /** True only when the owner explicitly chose "Discard N unread events and finish" (H0-13's own, asked-once
   * choice). False leaves pending event files exactly as they were, so a repeat can still drain them —
   * nothing else could ever deliver them once this connection is revoked. */
  discard: boolean;
  /** The residualEntries this connection's own hook removal reported (H0-10's changeHooks, run earlier in
   * the same Stop watching step, not by this function): entries that still look like Agent Town's but were
   * not recognised as this connection's own. Nonzero keeps the installed manifest, since it may still be
   * needed to recognise them on a later attempt. */
  residualEntries: number;
}
export interface CleanupConnectionResult {
  /** False when clean-up left the spool folder exactly as it found it (pending events remained and the
   * owner did not choose Discard): nothing below this line was touched. */
  cleaned: boolean;
  /** Top-level spool files matching the drain's own event-file pattern (spool.ts's eventName), counted
   * before anything is deleted; service-capabilities.json and any marker or temp file are never counted
   * here, even though they are ordinary top-level files that clean-up does delete once it proceeds. */
  pendingEvents: number;
  /** Files under spool/newer/ matching the same pattern; that folder is never deleted from or removed. */
  newerEventCount: number;
  /** Pending event files actually deleted because the owner chose Discard (0 unless cleaned && discard). */
  discardedEvents: number;
  manifestDeleted: boolean;
  folderRemoved: boolean;
}

/** Helper for Stop watching (H0-11; H0-13 orchestrates the order and the safety rule below). Deletes only
 * top-level REGULAR files directly inside this connection's spool folder — never spool/newer/ (the read-past
 * quarantine folder for events a future build understands: reported, never touched here), never anything
 * outside this connection's own folder, and never by reusing removeConnectionFiles (which deletes the whole
 * folder unconditionally and is for a connection that never became active). The spool folder itself is
 * removed only once it is completely empty (a plain `rmdir`, which refuses on its own if anything — even an
 * empty newer/ — is still inside it). The installed manifest is deleted only when `residualEntries` is 0.
 *
 * Safety rule (the H0-11 item's "revoke and clean-up run only when it left 0 pending or the owner chose
 * Discard"): if pending event files remain and `discard` is false, nothing is deleted — not even an unrelated
 * marker file — and `cleaned` is false, so a caller must not revoke or otherwise assume anything here changed. */
export async function cleanupConnectionFiles(directory: string, id: string, options: CleanupConnectionOptions): Promise<CleanupConnectionResult> {
  if (!CONNECTION_ID_PATTERN.test(id)) throw new IdentityError('INVALID_CONNECTION', 'Use a valid connection identifier.');
  const folder = spoolPath(directory, id);
  let entries: string[];
  try { await checkedPath(folder, [directory]); entries = await readdir(folder); }
  catch (error) {
    if (!isMissingPath(error)) throw error;
    return { cleaned: true, pendingEvents: 0, newerEventCount: 0, discardedEvents: 0, manifestDeleted: await deleteInstalledManifestIfSafe(directory, id, options.residualEntries), folderRemoved: false };
  }
  let newerEventCount = 0;
  const topLevel: { name: string; pending: boolean }[] = [];
  for (const name of entries) {
    if (name === 'newer') {
      try { newerEventCount = (await readdir(join(folder, 'newer'))).filter(item => spoolEventFileName.test(item)).length; }
      catch (error) { if (!isMissingPath(error)) throw error; }
      continue;
    }
    let info;
    try { info = await lstat(join(folder, name)); } catch (error) { if (isMissingPath(error)) continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) continue; // top-level regular files only — never a directory, never a link
    topLevel.push({ name, pending: spoolEventFileName.test(name) });
  }
  const pendingEvents = topLevel.filter(item => item.pending).length;
  if (pendingEvents > 0 && !options.discard) return { cleaned: false, pendingEvents, newerEventCount, discardedEvents: 0, manifestDeleted: false, folderRemoved: false };
  let discardedEvents = 0;
  for (const item of topLevel) {
    if (item.pending) discardedEvents++;
    await unlink(join(folder, item.name)).catch(error => { if (!isMissingPath(error)) throw error; });
  }
  let folderRemoved = false;
  try {
    await checkedPath(folder, [directory]);
    if ((await readdir(folder)).length === 0) { await rmdir(folder); folderRemoved = true; }
  } catch (error) { if (!isMissingPath(error)) throw error; }
  return { cleaned: true, pendingEvents, newerEventCount, discardedEvents, manifestDeleted: await deleteInstalledManifestIfSafe(directory, id, options.residualEntries), folderRemoved };
}

/** Only ever called after clean-up has decided it may proceed (see cleanupConnectionFiles). A nonzero
 * residualEntries count keeps the manifest, since a later attempt may still need it to recognise those
 * entries; a missing manifest is not an error (an older install, or an already-clean repeat). */
async function deleteInstalledManifestIfSafe(directory: string, id: string, residualEntries: number): Promise<boolean> {
  if (residualEntries > 0) return false;
  const path = installedPath(directory, id);
  try { await checkedPath(dirname(path), [directory]); await unlink(path); return true; }
  catch (error) { if (isMissingPath(error)) return false; throw error; }
}

export function observationSetup(record: RegisteredObservation, directory: string): ObservationSetup {
  const provider = record.connection.provider;
  if (provider === 'custom') return { connection: record.connection, configPath: '', config: JSON.stringify({ id: 'unique-event-id', sessionId: 'stable-session-id', kind: 'session.start', occurredAt: new Date().toISOString() }, null, 2),
    bridgeCommand: `${quote(process.execPath)} ${quote(hookBridgePath())} --config ${quote(bridgeConfigPath(directory, record.connection.id))} --normalized`,
    instructions: ['This source receives normalized events from your own integration. It has no automatic native hook or session discovery.', 'Pass one JSON event on standard input to the local bridge command. Use a stable session ID, a unique event ID, and the actual event time; retries keep the same event ID.', 'The bridge captures the registered source and queues delivery while Agent Town is closed. It requires no credential in your command or repository.', 'Summary and file evidence are optional. Exclude prompts, secrets, and raw transcripts from your event.'],
    diagnostics: record.connection.nativeSourceId ? [] : [{ code: 'CUSTOM_SOURCE_REQUIRED', message: 'Select a registered custom source before sending events through this bridge.' }],
    readiness: { configured: !!record.connection.nativeSourceId, nativeTrustRequired: false, sourceBinding: record.connection.binding ?? 'declared', overlappingHooks: false } };
  const { config, bridgeCommand } = hookConfiguration(record, directory);
  const configPath = join(record.repoPath, provider === 'claude' ? '.claude/settings.local.json' : provider === 'codex' ? '.codex/hooks.json' : provider === 'cursor' ? '.cursor/hooks.json' : `.github/hooks/agent-town-${record.connection.id}.json`);
  return { connection: record.connection, configPath, config: JSON.stringify(config, null, 2), bridgeCommand,
    diagnostics: [], readiness: { configured: false, nativeTrustRequired: true, sourceBinding: record.connection.binding ?? 'unavailable', overlappingHooks: false },
    instructions: ['Review these observation-only hook additions before applying them.', 'Existing hooks are preserved. The bridge records metadata and supplied final responses; it does not read transcripts or prompts.', `${activationStep(provider)} Existing session discovery is a separate capability.`,
      ...(provider === 'copilot-vscode' ? ['The VS Code hook format is available, but this adapter cannot yet verify its producing tool. New callbacks with ambiguous attribution are rejected. Use an explicit custom connector for declared activity until native attribution is verified.'] : []),
      ...(provider === 'claude' || provider.startsWith('copilot') ? ['Other compatible tools can also load this hook location. Review overlapping Agent Town callbacks; a configuration filename does not verify the producing tool.'] : []),
      'An event receipt confirms delivery only. Native coverage and usage remain partial; this connection cannot launch or stop external work.', 'Keep machine-specific hook paths out of shared commits. No credential is included in this configuration.'] };
}

/** Lets the bridge (a short-lived process spawned per hook event, with no memory between runs) tell
 * whether the service that will read its spool actually understands a gated kind or field before
 * emitting it — see eventFormatRequirements. Written once per connection, atomically (temp file plus
 * rename), whenever that connection's bridge config is (re)written; also refreshed for every already-
 * registered connection each time the service starts, since a restart may be a newer build. */
export async function writeServiceCapabilities(directory: string, connectionId: string) {
  const spool = spoolPath(directory, connectionId);
  await mkdir(spool, { recursive: true, mode: 0o700 });
  const capabilities: ServiceCapabilities = { eventFormat: CURRENT_EVENT_FORMAT, kinds: [...currentEventKinds], buildId: buildInfo.id, startedAt: new Date().toISOString() };
  const target = join(spool, SERVICE_CAPABILITIES_FILE), temporary = join(spool, `.${SERVICE_CAPABILITIES_FILE}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(capabilities), { mode: 0o600 });
  await rename(temporary, target);
}

export async function writeBridgeConfig(record: RegisteredObservation, directory: string) {
  const config = bridgeConfigPath(directory, record.connection.id), spool = spoolPath(directory, record.connection.id);
  await mkdir(dirname(config), { recursive: true, mode: 0o700 }); await mkdir(spool, { recursive: true, mode: 0o700 });
  await writeFile(config, JSON.stringify({ version: 2, connectionId: record.connection.id, provider: record.connection.provider, repoPath: record.repoPath, spoolPath: spool,
    ...(record.connection.nativeSourceId ? { nativeSourceId: record.connection.nativeSourceId, sourceRevision: record.connection.sourceRevision ?? 1, binding: record.connection.binding ?? 'declared' } : {}),
    ...(record.nativeHome ? { nativeHome: record.nativeHome } : {}) }), { mode: 0o600 });
  await writeServiceCapabilities(directory, record.connection.id);
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
  // The wider scan above stays only to find files that cannot be read safely, and to tell whether
  // THIS connection's own configuration already matches what would be applied. Whether another Agent
  // Town callback actually overlaps is answered by the exact same function the bridge asks at event
  // time (WS2-02): a loose "any other id anywhere nearby" scan previously disagreed with the bridge
  // and warned about combinations that work fine (Claude+Codex, Cursor+Copilot CLI, Cursor+Codex).
  for (const file of files) {
    try {
      const hooks = parseHooks(await readMetadataFile(file, [record.repoPath], 128000)).hooks;
      if (file === setup.configPath) setup.readiness!.configured = Object.entries(expected.hooks).every(([event, entries]) => entries.every(entry => (hooks[event] ?? []).some(installed => JSON.stringify(installed) === JSON.stringify(entry))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') setup.diagnostics!.push({ code: 'HOOK_CONFIG_UNREADABLE', message: 'A project hook configuration needs manual review before coverage can be verified.' });
    }
  }
  setup.readiness!.overlappingHooks = hasAmbiguousHookOverlap({ version: 2, connectionId: record.connection.id, provider: record.connection.provider, repoPath: record.repoPath, spoolPath: spoolPath(directory, record.connection.id) });
  if (setup.readiness!.overlappingHooks) setup.diagnostics!.push({ code: 'HOOK_OVERLAP', message: 'Other Agent Town callbacks are installed in this project. Compatible tools may invoke more than one; review native hook loading before relying on attribution.' });
  if (!record.connection.nativeSourceId || record.connection.binding !== 'resolved') setup.diagnostics!.push({ code: 'SOURCE_BINDING_UNVERIFIED', message: 'The native home or profile is not verified for this callback. Events retain their existing scope until source identity can be resolved.' });
  return setup;
}

/** What Agent Town wrote for one connection: every command version it may have put in a hook file, and (H0-10) whether
 * its own apply created that file. createdFile is only ever set by an apply that found no file, never inferred later. */
interface InstalledRecord { known: HookConfiguration[]; createdFile: boolean }

/** strict (apply): a record that cannot be trusted stops the change, since entries from an older install would then be
 * duplicated. A removal only takes out entries it recognises exactly, so it may go on without the record: whatever an
 * older install left is then counted as residual, and the file is never deleted (no record, no created-by proof). */
async function readInstalledRecord(record: RegisteredObservation, directory: string, strict: boolean): Promise<InstalledRecord> {
  const generated = [hookConfiguration(record, directory).config, hookConfiguration(record, directory, true).config];
  try {
    const value = JSON.parse(await readMetadataFile(installedPath(directory, record.connection.id), [directory], 128000)) as { version?: number; connectionId?: string; configurations?: unknown[]; createdFile?: unknown };
    if (value.version !== 1 || value.connectionId !== record.connection.id || !Array.isArray(value.configurations) || value.configurations.length > 20) throw new Error('Invalid installed manifest');
    const recorded: HookConfiguration[] = [];
    for (const config of value.configurations) {
      const parsed = parseHooks(JSON.stringify(config));
      for (const entries of Object.values(parsed.hooks)) for (const entry of entries) {
        const text = JSON.stringify(entry);
        if (!text.includes('hook-bridge.cjs') || !text.includes('--config') || !text.includes(`${record.connection.id}.json`)) throw new Error('Invalid installed entry');
      }
      recorded.push(parsed);
    }
    return { known: [...generated, ...recorded], createdFile: value.createdFile === true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { known: generated, createdFile: false };
    if (strict) throw new IdentityError('HOOK_MANIFEST_UNSAFE', 'The saved hook installation record needs review before changing hooks.', 409);
    return { known: generated, createdFile: false };
  }
}

async function saveInstalledConfigurations(record: RegisteredObservation, directory: string, configurations: HookConfiguration[], createdFile: boolean) {
  const path = installedPath(directory, record.connection.id), parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 }); await checkedPath(parent, [directory]);
  const unique = [...new Map(configurations.map(config => [JSON.stringify(config), config])).values()];
  if (unique.length > 20) throw new IdentityError('HOOK_MANIFEST_CAPACITY', 'Review previous hook installations before adding another command version.', 409);
  const data = JSON.stringify({ version: 1, connectionId: record.connection.id, configurations: unique, ...(createdFile ? { createdFile: true } : {}) });
  if (Buffer.byteLength(data) > 128000) throw new IdentityError('HOOK_MANIFEST_CAPACITY', 'The hook installation record reached its size limit.', 409);
  const temporary = join(parent, `${record.connection.id}-${randomUUID()}.tmp`);
  try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await checkedPath(parent, [directory]); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => undefined); }
}

/** What one hook change did. removed is true only when at least one of Agent Town's own entries was actually taken out
 * (a removal that found none says false, however it was asked). The counts never carry command text. file is created,
 * edited or unchanged for an apply, and missing, unchanged, edited or deleted for a removal. */
export type HookFileState = 'created' | 'edited' | 'unchanged' | 'missing' | 'deleted';
export interface HookChangeResult { changed: boolean; path: string; removed: boolean; removedEntries: number; residualEntries: number; file: HookFileState;
  /** Set only when a deleted file's moved-aside copy (a `.agent-town-*.tmp` file next to it) could not be deleted. The hook
   * file itself is gone and no tool loads that name; the caller says so plainly. */
  leftoverCopy?: true }

const HOOK_READ_LIMIT_BYTES = 128000;
/** Hook backups kept for one hook file (across apply and removal); older ones are deleted after a successful change. */
export const HOOK_BACKUPS_KEPT_PER_FILE = 3;
const isMissingPath = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');

/** The vault refuses to protect more than MAX_PROTECTED_VALUE_BYTES, so a larger hook file can never get its safety
 * copy. Asked before anything is written, so the answer is typed and plain instead of the vault's late "invalid value". */
const limitText = MAX_PROTECTED_VALUE_BYTES.toLocaleString('en-US');
/** apply: the file is already over the limit. remove: same, when a removal would have to back it up. grow: the file is
 * within the limit now, but adding Agent Town's own entries would push it over, so the later removal could never back it up. */
type TooLargeFor = 'apply' | 'remove' | 'grow';
const backupTooLarge = (when: TooLargeFor) => new IdentityError('HOOK_BACKUP_TOO_LARGE', when === 'grow'
  ? `Adding Agent Town's tracking would make this tool's settings file too big (over ${limitText} bytes) for Agent Town to keep a safe copy of it when you later stop watching, so Agent Town left it alone. Tracking was not set up. Make the file smaller and try again.`
  : `This tool's settings file is too big for Agent Town to keep a safe copy of it first (the limit is ${limitText} bytes), so Agent Town left it alone. ${when === 'remove' ? 'You can stop watching without editing this file, or make the file smaller and try again.' : 'Tracking was not set up. Make the file smaller and try again.'}`, 409);
/** A file too big to read at all (over the read limit) is also too big to back up; anything else unreadable stays "unsafe". */
async function unreadableHookFile(path: string, remove: boolean): Promise<IdentityError> {
  const info = await lstat(path).catch(() => null);
  return info?.isFile() && info.size > HOOK_READ_LIMIT_BYTES ? backupTooLarge(remove ? 'remove' : 'apply') : new IdentityError('HOOK_CONFIG_UNSAFE', 'The hook file is not safely readable. Review it manually.', 409);
}
const changedWhileWorking = (remove: boolean) => new IdentityError('HOOK_CONFIG_CHANGED', remove
  ? 'The hook file changed while Agent Town was removing its entries, so nothing was changed. Try again.'
  : 'The hook file changed during setup. Review and apply again.', 409);
/** The file as it is now ('' when it does not exist), for the compare-before-replace checks. */
async function currentHookText(path: string, root: string, remove: boolean): Promise<string> {
  try { return await readMetadataFile(path, [root], HOOK_READ_LIMIT_BYTES); }
  catch (error) { if (isMissingPath(error)) return ''; throw await unreadableHookFile(path, remove); }
}

/** An entry that looks like one Agent Town wrote (its helper, with a connection file), whoever's connection it is. */
function looksLikeAgentTown(entry: unknown): boolean {
  const text = JSON.stringify(entry);
  return text.includes('hook-bridge.cjs') && text.includes('--config');
}
/** Counts entries that look like Agent Town's, skipping the exact ones in `own`. A count only: never the command text. */
function countAgentTownLookalikes(hooks: Record<string, unknown> | null, own = new Set<string>()): number {
  let count = 0;
  for (const entries of Object.values(hooks ?? {})) if (Array.isArray(entries)) for (const entry of entries) if (looksLikeAgentTown(entry) && !own.has(JSON.stringify(entry))) count++;
  return count;
}

/** Writes the JSON back the way the file was laid out (indent width or tab, Windows or Unix line ends, trailing newline),
 * so removing Agent Town's entries does not re-indent the rest of a person's settings. A one-line file stays one line. */
function serializeLike(original: string, value: unknown): string {
  const lineEnd = original.includes('\r\n') ? '\r\n' : '\n';
  const lead = /^([ \t]+)"/m.exec(original)?.[1];
  const indent: string | number = lead ? (lead.startsWith('\t') ? '\t' : Math.min(lead.length, 10)) : original.trim().includes('\n') ? 2 : 0;
  let text = JSON.stringify(value, null, indent);
  if (lineEnd !== '\n') text = text.replaceAll('\n', lineEnd);
  return original.endsWith('\n') ? text + lineEnd : text;
}
/** True when nothing is left that Agent Town's own apply would not have written: no setting of the person's and no event. */
const leftEmpty = (config: Record<string, unknown>) => Object.keys(config).every(key => key === 'hooks' || key === 'version') && Object.keys((config.hooks ?? {}) as object).length === 0;

const backupFolder = (directory: string) => join(directory, 'observation', 'backups');
/** Backups are grouped by the hook file they copy (a hash of its path: no path is stored), not by connection, because
 * two connections of one tool share one file. */
const hookFileKey = (path: string) => createHash('sha256').update(pathKey(resolvePath(path))).digest('hex');
const HOOK_BACKUP_REFERENCE = /^hook-backup-[a-f0-9-]{36}$/;
interface HookBackup { reference: string; pointer: string }

async function saveHookBackup(record: RegisteredObservation, directory: string, vault: CredentialVault, path: string, original: string, action: 'apply' | 'remove'): Promise<HookBackup> {
  const pointer = join(backupFolder(directory), `${record.connection.id}-${randomUUID()}.json`);
  await mkdir(dirname(pointer), { recursive: true, mode: 0o700 });
  const reference = `hook-backup-${randomUUID()}`;
  await vault.put(reference, original);
  try { await writeFile(pointer, JSON.stringify({ at: new Date().toISOString(), action, connectionId: record.connection.id, file: hookFileKey(path), reference }), { mode: 0o600 }); }
  catch (error) { await vault.delete(reference).catch(() => undefined); throw error; }
  return { reference, pointer };
}
/** Takes back a backup made for a change that then failed. The pointer stays if the vault entry cannot be deleted, so
 * the prune after the next successful change still finds it. */
async function discardHookBackup(vault: CredentialVault, backup: HookBackup): Promise<void> {
  try { await vault.delete(backup.reference); } catch { return; }
  await unlink(backup.pointer).catch(() => undefined);
}
/** After a successful change: keeps the newest HOOK_BACKUPS_KEPT_PER_FILE backups of this hook file (the one just made
 * always among them) and deletes the rest, vault entry first. Best effort: it never fails the change that already
 * happened, only pointers it fully understands are touched, and a reference that is not a hook backup is never deleted. */
async function pruneHookBackups(record: RegisteredObservation, directory: string, vault: CredentialVault, path: string, keep: HookBackup): Promise<void> {
  const folder = backupFolder(directory), key = hookFileKey(path);
  const found: { file: string; at: number; reference: string; fresh: boolean }[] = [];
  let names: string[];
  try { names = await readdir(folder); } catch { return; }
  for (const name of names.slice(0, 1000)) {
    if (!name.endsWith('.json')) continue;
    const file = join(folder, name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) continue;
      const value = JSON.parse(await readFile(file, 'utf8')) as { at?: unknown; reference?: unknown; file?: unknown; connectionId?: unknown };
      if (typeof value.reference !== 'string' || !HOOK_BACKUP_REFERENCE.test(value.reference) || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) continue;
      // Pointers written before the file key existed belong to the file of their own connection.
      if (value.file === key || (value.file === undefined && value.connectionId === record.connection.id)) found.push({ file, at: Date.parse(value.at), reference: value.reference, fresh: file === keep.pointer });
    } catch { continue; } // A pointer that cannot be read or understood is left exactly as it is.
  }
  found.sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.at - a.at || a.file.localeCompare(b.file));
  for (const old of found.slice(HOOK_BACKUPS_KEPT_PER_FILE)) {
    try { await vault.delete(old.reference); } catch { continue; }
    await unlink(old.file).catch(() => undefined);
  }
}

/** Only known app-owned hook entries change; a concurrent file edit prevents replacement. */
export async function changeHooks(record: RegisteredObservation, directory: string, vault: CredentialVault, remove = false): Promise<HookChangeResult> {
  if (record.connection.provider === 'custom') throw new IdentityError('CUSTOM_HOOK_UNSUPPORTED', 'Custom integrations use normalized local events and have no automatically installed native hook.', 409);
  // Writing a hook that calls a helper which does not exist would look like it worked (the tool
  // reloads its settings) and then never deliver a single event. Removing a hook needs no helper.
  if (!remove && !(await hookBridgeAvailable())) throw new IdentityError('BRIDGE_MISSING', 'Agent Town\'s tracking helper is not built on this computer, so tracking cannot start yet. Build the service (npm run build) or start it with npm start, then try again.', 409);
  const setup = observationSetup(record, directory), path = setup.configPath;
  if (remove) return removeAgentTownEntries(record, directory, vault, path);
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
  let original = '', existed = false;
  try { original = await readMetadataFile(path, [record.repoPath], HOOK_READ_LIMIT_BYTES); existed = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw await unreadableHookFile(path, false); }
  // Checked before anything is written (the folders above exist only when there was no file to back up).
  if (Buffer.byteLength(original) > MAX_PROTECTED_VALUE_BYTES) throw backupTooLarge('apply');
  let existing: Record<string, unknown>;
  try { existing = original ? JSON.parse(original) as Record<string, unknown> : {}; }
  catch { throw new IdentityError('HOOK_CONFIG_INVALID', 'Existing hook JSON is invalid. Fix it before applying this connection.', 409); }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new IdentityError('HOOK_CONFIG_INVALID', 'Existing hook configuration must be a JSON object.', 409);
  const additions = JSON.parse(setup.config) as HookConfiguration;
  const installed = await readInstalledRecord(record, directory, true), known = installed.known;
  const originalHooks = existing.hooks ?? {};
  if (!originalHooks || typeof originalHooks !== 'object' || Array.isArray(originalHooks)) throw new IdentityError('HOOK_CONFIG_INVALID', 'Existing hooks must be an object.', 409);
  const hooks = { ...(originalHooks as Record<string, unknown>) };
  for (const name of new Set(known.flatMap(config => Object.keys(config.hooks)))) {
    const entries = additions.hooks[name] ?? [];
    const prior = hooks[name] ?? [];
    if (!Array.isArray(prior)) throw new IdentityError('HOOK_CONFIG_INVALID', 'An existing hook event is not a list.', 409);
    const owned = new Set(known.flatMap(config => config.hooks[name] ?? []).map(entry => JSON.stringify(entry)));
    // Exact equality avoids removing a user's edited or unrelated hook commands.
    hooks[name] = [...prior.filter(entry => !owned.has(JSON.stringify(entry))), ...entries];
  }
  if (additions.version !== undefined && existing.version !== undefined && existing.version !== additions.version) throw new IdentityError('HOOK_VERSION_UNSUPPORTED', 'The hook configuration version needs manual review.', 409);
  const output = JSON.stringify({ ...existing, ...(additions.version !== undefined ? { version: additions.version } : {}), hooks }, null, 2) + '\n';
  // The file this apply would leave is the one a later removal has to back up, so it must fit too: otherwise Agent Town
  // would put its entries where it could never take them out again. Still before anything is written.
  if (Buffer.byteLength(output) > MAX_PROTECTED_VALUE_BYTES) throw backupTooLarge('grow');
  if (await currentHookText(path, record.repoPath, false) !== original) throw changedWhileWorking(false);
  const backup = original ? await saveHookBackup(record, directory, vault, path, original, 'apply') : null;
  try {
    const temporary = join(parent, `.agent-town-${randomUUID()}.tmp`);
    await checkedPath(parent, [record.repoPath]);
    // Save ownership before replacement so recovery/removal also handles a crash immediately after the hook file is
    // successfully replaced. The flag saved here is the one already on record: "Agent Town created this file" is only
    // written below, once the file really exists, so a failed apply can never vouch for a file someone else makes later.
    await saveInstalledConfigurations(record, directory, known, installed.createdFile);
    try {
      await writeFile(temporary, output, { flag: 'wx', mode: 0o600 });
      const info = await lstat(temporary);
      if (!info.isFile() || info.isSymbolicLink()) throw new IdentityError('HOOK_CONFIG_UNSAFE', 'The hook configuration could not be saved.', 409);
      // DPAPI may take seconds: recheck after backup encryption, immediately before replacement.
      await checkedPath(parent, [record.repoPath]);
      if (await currentHookText(path, record.repoPath, false) !== original) throw changedWhileWorking(false);
      await renameWithLockRetry(temporary, path);
    } finally { await unlink(temporary).catch(() => undefined); }
  } catch (error) { if (backup) await discardHookBackup(vault, backup); throw error; }
  // The only thing that ever records "Agent Town created this file": an apply that found no file and has now written it.
  // A later apply never withdraws it. If this save fails the flag is simply absent, which keeps the file on removal.
  if (!existed && !installed.createdFile) await saveInstalledConfigurations(record, directory, known, true).catch(() => undefined);
  if (backup) await pruneHookBackups(record, directory, vault, path, backup);
  const own = new Set([...known.flatMap(config => Object.values(config.hooks).flat()), ...Object.values(additions.hooks).flat()].map(entry => JSON.stringify(entry)));
  return { changed: output !== original, path, removed: false, removedEntries: 0, residualEntries: countAgentTownLookalikes(hooks, own), file: !existed ? 'created' : output !== original ? 'edited' : 'unchanged' };
}

/** Takes this connection's own entries out of its hook file and nothing else. It never creates a folder or file, never
 * rewrites or backs up when it found nothing of its own to take out, and leaves entries it does not recognise exactly as
 * they are (counting them as residual). The file is deleted only when the install record says an apply created it and
 * nothing else is left in it; otherwise it stays, with only the events this call emptied dropped. */
async function removeAgentTownEntries(record: RegisteredObservation, directory: string, vault: CredentialVault, path: string): Promise<HookChangeResult> {
  const outcome = (file: HookFileState, removedEntries = 0, residualEntries = 0): HookChangeResult => ({ changed: file === 'edited' || file === 'deleted', path, removed: removedEntries > 0, removedEntries, residualEntries, file });
  let original: string;
  try {
    await checkedPath(record.repoPath, [record.repoPath]);
    original = await readMetadataFile(path, [record.repoPath], HOOK_READ_LIMIT_BYTES);
  } catch (error) {
    if (isMissingPath(error)) return outcome('missing');
    throw await unreadableHookFile(path, true);
  }
  // A byte-order mark (some editors add one) is not part of the JSON: it is read past and written back exactly as it was.
  const bom = original.charCodeAt(0) === 0xfeff ? String.fromCharCode(0xfeff) : '', body = bom ? original.slice(1) : original;
  let parsed: unknown;
  try { parsed = body.trim() ? JSON.parse(body) : {}; }
  catch { throw new IdentityError('HOOK_CONFIG_INVALID', 'This settings file is not valid JSON, so Agent Town left it alone. Fix the file, then try again.', 409); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new IdentityError('HOOK_CONFIG_INVALID', 'This settings file is not a JSON object, so Agent Town left it alone. Fix the file, then try again.', 409);
  const existing = parsed as Record<string, unknown>;
  const installed = await readInstalledRecord(record, directory, false);
  const source = existing.hooks;
  const hooks = source && typeof source === 'object' && !Array.isArray(source) ? { ...(source as Record<string, unknown>) } : null;
  let removedEntries = 0;
  if (hooks) for (const name of new Set(installed.known.flatMap(config => Object.keys(config.hooks)))) {
    const prior = hooks[name];
    // An event that is not a list holds nothing Agent Town could have written: it is left alone, not a reason to refuse.
    if (!Array.isArray(prior)) continue;
    const owned = new Set(installed.known.flatMap(config => config.hooks[name] ?? []).map(entry => JSON.stringify(entry)));
    // Exact equality avoids removing a user's edited or unrelated hook commands.
    const kept = prior.filter(entry => !owned.has(JSON.stringify(entry)));
    if (kept.length === prior.length) continue;
    removedEntries += prior.length - kept.length;
    // Only an event this call emptied is dropped; an event that was already an empty list is the person's own.
    if (kept.length) hooks[name] = kept; else delete hooks[name];
  }
  const residualEntries = countAgentTownLookalikes(hooks);
  if (!hooks || removedEntries === 0) return outcome('unchanged', 0, residualEntries);
  // Only now is a backup needed, so a big file with none of our entries is simply left alone. Nothing is written yet.
  if (Buffer.byteLength(original) > MAX_PROTECTED_VALUE_BYTES) throw backupTooLarge('remove');
  const next = { ...existing, hooks };
  const deleting = (installed.createdFile || basename(path).toLowerCase() === `agent-town-${record.connection.id}.json`) && leftEmpty(next);
  if (await currentHookText(path, record.repoPath, true) !== original) throw changedWhileWorking(true);
  const backup = await saveHookBackup(record, directory, vault, path, original, 'remove');
  const parent = dirname(path);
  let leftoverCopy = false;
  try {
    await checkedPath(parent, [record.repoPath]);
    if (deleting) {
      // DPAPI may take seconds: recheck after backup encryption, immediately before deleting.
      if (await currentHookText(path, record.repoPath, true) !== original) throw changedWhileWorking(true);
      // Moved aside first, then deleted: the move is one atomic step that meets the same short-lived Windows locks as
      // replacing the file (same retry, same typed error), and nothing can fail after it that would leave the file half gone.
      const tombstone = join(parent, `.agent-town-${randomUUID()}.tmp`);
      await renameWithLockRetry(path, tombstone);
      // The hook file is already gone, so a copy that will not delete does not undo the removal; it is reported instead.
      try { await unlinkWithLockRetry(tombstone); } catch { leftoverCopy = true; }
    } else {
      const temporary = join(parent, `.agent-town-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bom + serializeLike(body, next), { flag: 'wx', mode: 0o600 });
        const info = await lstat(temporary);
        if (!info.isFile() || info.isSymbolicLink()) throw new IdentityError('HOOK_CONFIG_UNSAFE', 'The hook configuration could not be saved.', 409);
        await checkedPath(parent, [record.repoPath]);
        if (await currentHookText(path, record.repoPath, true) !== original) throw changedWhileWorking(true);
        await renameWithLockRetry(temporary, path);
      } finally { await unlink(temporary).catch(() => undefined); }
    }
  } catch (error) { await discardHookBackup(vault, backup); throw error; }
  // The file Agent Town created is gone, so the record must not vouch for a file someone creates there later. If this
  // write fails the flag only stays stale, and a stale flag can delete nothing but a file left completely empty.
  if (deleting && installed.createdFile) await saveInstalledConfigurations(record, directory, installed.known, false).catch(() => undefined);
  await pruneHookBackups(record, directory, vault, path, backup);
  return { ...outcome(deleting ? 'deleted' : 'edited', removedEntries, residualEntries), ...(leftoverCopy ? { leftoverCopy: true as const } : {}) };
}

/** Read-only preview for Stop watching (H0-13): what removeAgentTownEntries would take out and leave, computed
 * the same way (the same installed record, the same exact-equality ownership test), without writing, backing
 * up, or renaming anything — so the preview the owner reviews is always what a real removal would do, and
 * calling this can never itself change a byte on disk. `entries` names the tool's own hook event names (for
 * example "PreToolUse") with how many of that event's entries would be removed, never command text.
 * `tooLargeToBackUp` mirrors changeHooks's own before-any-write check, so the preview can offer "stop without
 * editing files" before the owner ever hits the same refusal. */
export interface HookRemovalPreview { path: string; file: 'missing' | 'unchanged' | 'edited' | 'unsupported'; removedEntries: number; residualEntries: number; entries: { event: string; count: number }[]; tooLargeToBackUp: boolean }
export async function planHookRemoval(record: RegisteredObservation, directory: string): Promise<HookRemovalPreview> {
  if (record.connection.provider === 'custom') return { path: '', file: 'unsupported', removedEntries: 0, residualEntries: 0, entries: [], tooLargeToBackUp: false };
  const path = observationSetup(record, directory).configPath;
  let original: string;
  try { await checkedPath(record.repoPath, [record.repoPath]); original = await readMetadataFile(path, [record.repoPath], HOOK_READ_LIMIT_BYTES); }
  catch (error) {
    if (isMissingPath(error)) return { path, file: 'missing', removedEntries: 0, residualEntries: 0, entries: [], tooLargeToBackUp: false };
    // Unreadable for a reason other than "missing" (too big to read, unsafe path, a permission error): the
    // preview cannot say more than that removal would need review; the real attempt reports the exact code.
    return { path, file: 'unchanged', removedEntries: 0, residualEntries: 0, entries: [], tooLargeToBackUp: true };
  }
  const body = original.charCodeAt(0) === 0xfeff ? original.slice(1) : original;
  let parsed: unknown;
  try { parsed = body.trim() ? JSON.parse(body) : {}; } catch { return { path, file: 'unchanged', removedEntries: 0, residualEntries: 0, entries: [], tooLargeToBackUp: false }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { path, file: 'unchanged', removedEntries: 0, residualEntries: 0, entries: [], tooLargeToBackUp: false };
  const existing = parsed as Record<string, unknown>;
  const installed = await readInstalledRecord(record, directory, false);
  const source = existing.hooks;
  const hooks = source && typeof source === 'object' && !Array.isArray(source) ? (source as Record<string, unknown>) : null;
  let removedEntries = 0;
  const entries: { event: string; count: number }[] = [];
  if (hooks) for (const name of new Set(installed.known.flatMap(config => Object.keys(config.hooks)))) {
    const prior = hooks[name];
    if (!Array.isArray(prior)) continue;
    const owned = new Set(installed.known.flatMap(config => config.hooks[name] ?? []).map(entry => JSON.stringify(entry)));
    const removedHere = prior.filter(entry => owned.has(JSON.stringify(entry))).length;
    if (removedHere) { removedEntries += removedHere; entries.push({ event: name, count: removedHere }); }
  }
  const residualEntries = countAgentTownLookalikes(hooks);
  return { path, file: removedEntries > 0 ? 'edited' : 'unchanged', removedEntries, residualEntries, entries: entries.sort((a, b) => a.event.localeCompare(b.event)), tooLargeToBackUp: Buffer.byteLength(original) > MAX_PROTECTED_VALUE_BYTES };
}
