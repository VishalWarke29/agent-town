import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nativeVisibilitySchema, registerNativeSourceSchema, scanNativeSourceSchema, surfaceSchema, type NativeSetupSnapshot, type NativeToolStatus } from '@agent-town/contracts';
import type { Store } from '../store.js';
import { IdentityError } from '../identity/types.js';
import { canonicalizeRoot, checkedPath } from '../discovery/paths.js';
import { discoverNativeSessions } from '../native-discovery/index.js';

/** Codex records its own CLI version per session in its local sqlite store (see
 * metadata-worker.mjs's `cli_version` column); reading the most recent one is a
 * read-only, file-based signal, never a shelled-out `--version` check. No other
 * surface here has a known, reliable colocated version marker file, so their
 * version stays null/Unavailable rather than a guessed or invented signal. */
function codexVersion(homePath: string): string | null {
  try {
    const db = new Database(join(homePath, 'state_5.sqlite'), { readonly: true, fileMustExist: true, timeout: 100 });
    try {
      const row = db.prepare('SELECT cli_version FROM threads WHERE cli_version IS NOT NULL ORDER BY rowid DESC LIMIT 1').get() as { cli_version: unknown } | undefined;
      return typeof row?.cli_version === 'string' && row.cli_version.trim() ? row.cli_version.trim().slice(0, 40) : null;
    } finally { db.close(); }
  } catch { return null; }
}

function detectedTools(): NativeToolStatus[] {
  const defaults = { codex: process.env.CODEX_HOME ?? join(homedir(), '.codex'), claude: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), cursor: process.env.CURSOR_CONFIG_DIR ?? join(homedir(), '.cursor'), 'copilot-cli': process.env.COPILOT_HOME ?? join(homedir(), '.copilot'), 'copilot-vscode': process.env.APPDATA ? join(process.env.APPDATA, 'Code', 'User') : join(homedir(), '.config', 'Code', 'User'), custom: null };
  const labels = { codex: 'Codex desktop, CLI and editor', claude: 'Claude Code', cursor: 'Cursor local SDK store', 'copilot-cli': 'Copilot CLI', 'copilot-vscode': 'Copilot in VS Code', custom: 'Other local tool' };
  return surfaceSchema.options.map(provider => {
    const home = defaults[provider];
    // Cursor's actual requirement is the SDK's JSONL store file, not just the parent
    // config folder; the folder alone overstates readiness for a scan (metadata-worker.mjs).
    const detected = !!home && existsSync(provider === 'cursor' ? join(home!, 'agents.ndjson') : home!);
    return { provider, label: labels[provider], detected, defaultHomePath: home, version: provider === 'codex' && detected ? codexVersion(home!) : null,
      discovery: provider === 'copilot-vscode' || provider === 'custom' ? 'unsupported' : 'available',
      message: provider === 'cursor' ? 'Discovery covers the selected local SDK store. Existing editor and CLI chats require a supported live hook; their history is not enumerated.' : provider === 'copilot-vscode' ? 'Profile directory detection does not verify the Copilot extension. Existing chat discovery is unavailable; configure VS Code hooks for future events.' : provider === 'custom' ? 'Register a local profile and use the normalized event bridge. Automatic history discovery is unavailable.' : 'Local profile detection does not verify authentication or live activity. Select and scan a profile to check its metadata interface.' };
  });
}

export function registerNativeApi(app: FastifyInstance, scoped: (request: FastifyRequest) => { ownerId: string; store: Store }) {
  const prefix = '/api/v1/workspaces/:id/observation';
  const scans = new Map<string, AbortController>();
  function sourceFor(request: FastifyRequest) {
    const context = scoped(request), sourceId = (request.params as { sourceId: string }).sourceId;
    const stored = context.store.native.source(sourceId);
    if (!stored) throw new IdentityError('NATIVE_SOURCE_NOT_FOUND', 'Select an approved native profile.', 404);
    return { ...context, ...stored };
  }
  app.get(`${prefix}/native-setup`, async request => {
    const { store } = scoped(request);
    return { sources: store.native.sources(), tools: detectedTools() } satisfies NativeSetupSnapshot;
  });
  app.post(`${prefix}/native-sources`, async request => {
    const parsed = registerNativeSourceSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_NATIVE_SOURCE', 'Choose a tool, profile name and absolute local profile folder.');
    const homePath = await canonicalizeRoot(parsed.data.homePath);
    const { store } = scoped(request);
    let result!: ReturnType<Store['native']['register']>;
    store.commit(`native-source:${randomUUID()}`, () => { result = store.native.register(parsed.data.provider, homePath, parsed.data.label); return 'observation.native_source_registered'; });
    return result;
  });
  app.post(`${prefix}/native-sources/:sourceId/verify`, async request => {
    const { source, homePath } = sourceFor(request);
    await checkedPath(homePath, [homePath]);
    const { store } = scoped(request), current = store.native.source(source.id)!;
    // Restore already advances the revision and revokes old connections. A
    // routine folder check must not invalidate an otherwise valid live hook.
    const verified = { ...current.source, status: 'ready' as const, message: current.source.status === 'needs-review' ? 'Local profile verified. Review and reapply tracking before receiving events.' : 'Local profile folder verified. Activity is verified separately when a native event arrives.' };
    store.commit(`native-source-verify:${randomUUID()}`, () => { store.native.saveSource(verified); return 'observation.native_source_verified'; });
    return verified;
  });
  app.post(`${prefix}/native-sources/:sourceId/scan`, async (request, reply) => {
    const parsed = scanNativeSourceSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_NATIVE_SCAN', 'Choose a connected local project.');
    const { store, source, homePath } = sourceFor(request);
    if (source.status === 'needs-review') throw new IdentityError('NATIVE_SOURCE_REVIEW', 'Verify this restored profile before scanning.', 409);
    const state = store.snapshot().state;
    const repo = state.repositories.find(repo => repo.id === parsed.data.repoId && repo.source === 'local');
    if (!repo?.localPath) throw new IdentityError('LOCAL_REPOSITORY_REQUIRED', 'Select a connected local project.');
    await checkedPath(homePath, [homePath]);
    const repoPath = await checkedPath(repo.localPath, state.discovery?.roots ?? []);
    const key = `${state.workspace.id}:${source.id}`;
    if (scans.has(key)) throw new IdentityError('NATIVE_SCAN_RUNNING', 'Wait for this profile scan or cancel it first.', 409);
    const controller = new AbortController(); scans.set(key, controller);
    const timer = setTimeout(() => controller.abort(), 25000);
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.once('close', abort);
    try {
      const result = await discoverNativeSessions({ provider: source.provider, homePath, repoPath, includeOlder: parsed.data.includeOlder, cursor: parsed.data.cursor, signal: controller.signal });
      if (controller.signal.aborted) throw new IdentityError('NATIVE_SCAN_CANCELLED', 'The session scan was cancelled. Existing sessions were preserved.', 409);
      scoped(request);
      await checkedPath(homePath, [homePath]); await checkedPath(repoPath, store.snapshot().state.discovery?.roots ?? []);
      store.commit(`native-scan:${randomUUID()}`, (current, now) => {
        const latest = store.native.source(source.id);
        if (!latest || latest.source.revision !== source.revision || !current.repositories.some(item => item.id === repo.id && item.localPath === repo.localPath)) throw new IdentityError('NATIVE_SCAN_CHANGED', 'The selected profile or project changed. Scan again.', 409);
        // History support and permission to receive live events are independent.
        // An unavailable metadata adapter must not disable an approved hook.
        store.native.saveSource({ ...latest.source, status: 'ready', discovery: result.status, lastScanAt: now, message: result.message, nextScanCursor: result.nextCursor, lastScanRepoId: repo.id, lastScanIncludeOlder: parsed.data.includeOlder ?? false });
        if (result.status === 'available') store.native.discover(latest.source, repo.id, result.sessions, current, now);
        return 'observation.native_sessions_discovered';
      });
      if (result.status !== 'available') throw new IdentityError(result.status === 'unsupported' ? 'NATIVE_DISCOVERY_UNSUPPORTED' : 'NATIVE_DISCOVERY_UNAVAILABLE', result.message ?? 'Local session discovery is unavailable for this profile.', result.status === 'unsupported' ? 422 : 503);
      return store.native.page(store.snapshot().state, { repoId: repo.id, sourceId: source.id, includeOlder: parsed.data.includeOlder });
    } finally { clearTimeout(timer); reply.raw.off('close', abort); scans.delete(key); }
  });
  app.post(`${prefix}/native-sources/:sourceId/cancel`, async request => {
    const { store, source } = sourceFor(request); scans.get(`${store.snapshot().state.workspace.id}:${source.id}`)?.abort(); return { cancelled: true };
  });
  app.get(`${prefix}/native-sessions`, async request => {
    const { store } = scoped(request), query = request.query as Record<string, string | undefined>;
    return store.native.page(store.snapshot().state, { repoId: query.repoId, sourceId: query.sourceId, cursor: query.cursor, includeOlder: query.includeOlder === 'true' });
  });
  app.get(`${prefix}/native-sessions/:sessionId/detail`, async request => {
    const { store } = scoped(request); return store.native.detail((request.params as { sessionId: string }).sessionId, store.snapshot().state);
  });
  app.post(`${prefix}/native-sessions/:sessionId/visibility`, async request => {
    const { store } = scoped(request), parsed = nativeVisibilitySchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_NATIVE_VISIBILITY', 'Choose whether to show this session.');
    return store.commit(`native-visibility:${randomUUID()}`, state => { store.native.visibility((request.params as { sessionId: string }).sessionId, parsed.data.visible, state); return 'observation.native_visibility'; }).snapshot;
  });
  return { close() { for (const scan of scans.values()) scan.abort(); scans.clear(); } };
}
