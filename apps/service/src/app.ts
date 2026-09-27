import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { DEMO_WORKSPACE, createWorkspaceSchema, deviceFlowSchema, demoCommandSchema, type ApplicationMode, type BrowserSession } from '@agent-town/contracts';
import { applyDemoCommand, advanceDemo, CommandError } from './demo.js';
import { projectRoot, Store } from './store.js';
import { IdentityError, WindowsDpapiVault, type CredentialVault, type IdentityService } from './identity/index.js';
import { WorkspaceStores } from './workspaces.js';
import { registerRepositoryApi } from './repository-api.js';
import { createFolderPicker, type FolderPicker } from './folder-picker.js';
import { registerObservationApi } from './observation/service.js';
import { registerWorkflowApi } from './workflow-api.js';
import { WorkflowError } from './workflow/budget.js';
import type { WorkflowProvider } from './workflow/provider.js';
import { registerTelemetryApi } from './telemetry-api.js';
import { registerRunnerApi } from './runner-api.js';
import type { RunExecutor } from './runner/types.js';
import { registerVaultApi } from './vault-api.js';
import { VaultError } from './vault/errors.js';
import { buildInfo } from './build-info.js';
import { registerHistoryApi } from './history-api.js';
import type { BackupScheduler } from './ops/scheduler.js';
import { createStateStream } from './state-stream.js';
import { servedWebBuild, bridgeBuild, bridgeRebuiltSinceStart } from './served-web.js';
import { introspectReadOnlyFile } from './db-visualizer.js';
import type { DbSchemaSnapshot } from '@agent-town/contracts';

interface Options { database: string; privateDirectory?: string; identity?: IdentityService; vault?: CredentialVault; workflowProvider?: WorkflowProvider; runExecutor?: RunExecutor; folderPicker?: FolderPicker; backups?: BackupScheduler; port?: number; mode?: ApplicationMode; development?: boolean; developmentWebPort?: number; simulationInterval?: number; logger?: boolean }
interface Session { csrf: string; expires: number; created: number; ownerId: string | null }

export async function createApp(options: Options) {
  const mode = options.mode ?? 'development';
  if (!['demo', 'development', 'production'].includes(mode)) throw new Error('Invalid Agent Town application mode.');
  const port = options.port ?? 4310;
  const developmentWebPort = options.developmentWebPort ?? 5173;
  if (!Number.isInteger(developmentWebPort) || developmentWebPort < 1024 || developmentWebPort > 65535) throw new Error('The development web port must be between 1024 and 65535.');
  // Cookies are scoped to a host, not its port. Separate local instances must
  // not overwrite each other's sign-in session when switching environments.
  const COOKIE = `agent-town-${mode}-${port}`;
  const origin = `http://127.0.0.1:${port}`;
  const origins = new Set([origin, ...(options.development && mode !== 'production' ? [`http://127.0.0.1:${developmentWebPort}`] : [])]);
  const hosts = new Set([...origins].map(url => new URL(url).host));
  const sessions = new Map<string, Session>();
  const streams = new Set<() => void>();
  const sessionStreams = new Map<string, Set<() => void>>();
  // Demo must not recover private workspaces or start any paid/source timers,
  // even when an embedding caller accidentally supplies a real identity.
  const identity = mode === 'demo' ? undefined : options.identity;
  const privateStores = new WorkspaceStores(options.privateDirectory ?? join(dirname(options.database), 'private'), (owner, id) => {
    if (!identity) throw new IdentityError('IDENTITY_UNAVAILABLE', 'Configure GitHub sign-in first.', 503);
    return identity.registry.requireWorkspace(owner, id);
  });
  const store = new Store(options.database);
  const app = Fastify({ logger: options.logger ? { level: 'info', redact: ['req.headers', 'res.headers'] } : false, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 1024 * 1024, requestTimeout: 15000 });
  await app.register(cookie);

  const sessionFor = (request: FastifyRequest) => sessions.get(request.cookies[COOKIE] ?? '');
  const invalidate = (id: string) => {
    for (const close of sessionStreams.get(id) ?? []) close();
    sessionStreams.delete(id); identity?.cancelSession(id); sessions.delete(id);
  };
  const describeSession = (session: Session): BrowserSession => {
    const user = session.ownerId ? identity?.registry.getOwner(session.ownerId) ?? null : null;
    const status = identity?.status();
    return { csrf: session.csrf, mode: user ? 'private' : 'demo', applicationMode: mode, user, workspaces: user ? identity!.registry.listWorkspaces(user.id).map(({ id, name, kind }) => ({ id, name, kind })) : [], identity: { configured: status?.configured ?? false, ...(!status?.configured ? { reason: mode === 'demo' ? 'Demo mode uses sample data. Restart in development mode to connect accounts.' : status?.reason ?? 'Add a GitHub App client ID to agent-town.config.json, then restart Agent Town.' } : {}) } };
  };
  const issueSession = (reply: FastifyReply, ownerId: string | null = null) => {
    const token = randomBytes(32).toString('hex');
    const session: Session = { csrf: randomBytes(32).toString('hex'), expires: Date.now() + 8 * 60 * 60 * 1000, created: Date.now(), ownerId };
    sessions.set(token, session);
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/api', maxAge: 8 * 60 * 60, secure: false });
    return describeSession(session);
  };
  const requireOwner = (request: FastifyRequest) => {
    const owner = sessionFor(request)?.ownerId;
    if (!owner || !identity) throw new IdentityError('SIGN_IN_REQUIRED', 'Sign in with GitHub to open private workspaces.', 401);
    return owner;
  };
  const scopedStore = (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    if (id === DEMO_WORKSPACE) {
      if (mode === 'production') throw new IdentityError('PREVIEW_DISABLED', 'Sample data is disabled in production mode.', 403);
      return store;
    }
    if (!sessionFor(request)?.ownerId) throw new IdentityError('WORKSPACE_NOT_FOUND', 'This workspace is not available.', 404);
    return privateStores.get(requireOwner(request), id);
  };

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!hosts.has(request.headers.host ?? '') || request.headers['sec-fetch-site'] === 'cross-site' || (request.headers.origin && !origins.has(request.headers.origin))) {
      return reply.code(403).send({ code: 'UNTRUSTED_ORIGIN', message: 'Open Agent Town using its local 127.0.0.1 address.' });
    }
    const route = request.url.split('?')[0]!;
    const demoRoute = `/api/v1/workspaces/${DEMO_WORKSPACE}`;
    if (mode === 'demo' && (route.startsWith('/api/') || route.startsWith('/ingest/')) &&
        !['/api/v1/health', '/api/v1/session', `${demoRoute}/snapshot`, `${demoRoute}/events`, `${demoRoute}/demo/commands`, `${demoRoute}/db-schema`].includes(route)) {
      return reply.code(403).send({ code: 'DEMO_ONLY', message: 'Demo mode only serves sample data. Restart in development mode to connect real services.' });
    }
    if (mode === 'production' && (route === demoRoute || route.startsWith(`${demoRoute}/`))) {
      return reply.code(403).send({ code: 'PREVIEW_DISABLED', message: 'Sample data is disabled in production mode.' });
    }
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD' && !origins.has(request.headers.origin ?? '')) {
      return reply.code(403).send({ code: 'ORIGIN_REQUIRED', message: 'This action requires the local app origin.' });
    }
    if (route === '/api/v1/health' || route === '/api/v1/session') return;
    const session = sessions.get(request.cookies[COOKIE] ?? '');
    if (!session || session.expires < Date.now()) return reply.code(401).send({ code: 'SESSION_REQUIRED', message: 'Reconnect to Agent Town and sign in again if needed.' });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const supplied = request.headers['x-csrf-token'];
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrf))) {
        return reply.code(403).send({ code: 'CSRF_REQUIRED', message: 'Refresh the page before trying this action again.' });
      }
    }
  });

  app.get('/api/v1/health', async () => {
    const bridge = await bridgeBuild(join(projectRoot, 'apps/service/dist'));
    return { ok: true, version: '0.1.0', mode: 'local', applicationMode: mode, build: buildInfo, servedWeb: await servedWebBuild(join(projectRoot, 'apps/web/dist')), bridge,
      rebuiltPendingRestart: bridgeRebuiltSinceStart(bridge, buildInfo.id, !!options.development),
      sourceHotReload: !!options.development, hostedDeploymentReady: false, paidWorkEnabledByDefault: false };
  });
  app.post('/api/v1/session', async (request, reply) => {
    for (const [key, session] of sessions) if (session.expires < Date.now()) invalidate(key);
    const old = request.cookies[COOKIE];
    if (old && sessions.has(old)) {
      const session = sessions.get(old)!;
      if (session.ownerId || Date.now() - session.created < 5 * 60 * 1000) return describeSession(session);
      invalidate(old);
    }
    if (sessions.size >= 64) return reply.code(429).send({ code: 'CAPACITY', message: 'Too many local preview sessions. Close unused sessions or restart the service.' });
    return issueSession(reply);
  });

  app.post('/api/v1/auth/github/device/start', async request => {
    if (!identity) throw new IdentityError('IDENTITY_UNAVAILABLE', 'Add a GitHub App client ID and restart the service.', 503);
    if (Date.now() - sessionFor(request)!.created > 5 * 60 * 1000) throw new IdentityError('BOOTSTRAP_EXPIRED', 'Refresh Agent Town before starting sign-in.', 403);
    const result = await identity.startDevice(request.cookies[COOKIE]!);
    return { flowId: result.flowId, userCode: result.userCode, verificationUri: result.verificationUri, expiresAt: result.expiresAt, intervalSeconds: result.interval };
  });
  app.post('/api/v1/auth/github/device/poll', async (request, reply) => {
    if (!identity) throw new IdentityError('IDENTITY_UNAVAILABLE', 'Configure GitHub sign-in first.', 503);
    const parsed = deviceFlowSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_FLOW', 'This sign-in request is invalid.');
    const sessionId = request.cookies[COOKIE]!;
    const pendingSession = sessionFor(request)!;
    const result = await identity.pollDevice(sessionId, parsed.data.flowId);
    if (sessions.get(sessionId) !== pendingSession || pendingSession.expires < Date.now()) throw new IdentityError('SESSION_REQUIRED', 'This sign-in session ended. Start again.', 401);
    if (result.status === 'authorized' && result.principal) {
      invalidate(request.cookies[COOKIE]!);
      return { status: 'authorized', session: issueSession(reply, result.principal.id) };
    }
    return { status: result.status, retryAfterSeconds: result.nextPollAt ? Math.max(1, Math.ceil((Date.parse(result.nextPollAt) - Date.now()) / 1000)) : undefined };
  });
  app.post('/api/v1/auth/github/device/cancel', async request => {
    const parsed = deviceFlowSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_FLOW', 'This sign-in request is invalid.');
    identity?.cancelDevice(request.cookies[COOKIE]!, parsed.data.flowId);
    return { ok: true };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    invalidate(request.cookies[COOKIE]!);
    return issueSession(reply);
  });
  // Distinct from logout: this removes the stored GitHub credential itself
  // (the vault entry and its registry reference), not just the browser
  // session. The browser session is left untouched.
  app.post('/api/v1/auth/github/disconnect', async request => {
    const owner = requireOwner(request);
    await identity!.disconnect(owner);
    return { ok: true };
  });
  app.get('/api/v1/workspaces', async request => {
    const owner = requireOwner(request);
    return { workspaces: identity!.registry.listWorkspaces(owner).map(({ id, name, kind }) => ({ id, name, kind })) };
  });
  app.post('/api/v1/workspaces', async request => {
    const owner = requireOwner(request);
    const parsed = createWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) throw new IdentityError('INVALID_WORKSPACE', 'Choose a name and a personal or company workspace.');
    const workspace = identity!.registry.createWorkspace(owner, parsed.data.name, parsed.data.kind);
    privateStores.get(owner, workspace.id);
    return { workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind } };
  });

  const prefix = '/api/v1/workspaces/:id';
  app.addHook('preHandler', async request => {
    const params = request.params as { id?: string };
    if (params.id) scopedStore(request);
  });
  app.get(`${prefix}/snapshot`, async request => scopedStore(request).snapshot());
  app.get(`${prefix}/db-schema`, async request => {
    const workspaceGroup = scopedStore(request).dbSchemaGroup();
    // Identity's app.sqlite lives under the private directory, the same fallback this file already
    // uses for it at line ~50 (options.privateDirectory, or dirname(database)/private for a fixture
    // that only passes database) — not dirname(database) itself, which was this endpoint's original,
    // wrong guess and always missed the real file. Absent entirely in demo mode (no identity service).
    const identityGroup = identity ? introspectReadOnlyFile(join(options.privateDirectory ?? join(dirname(options.database), 'private'), 'app.sqlite'), 'Agent Town sign-in data (shared, not private to this workspace)', 'identity') : null;
    return { scannedAt: new Date().toISOString(), groups: identityGroup ? [workspaceGroup, identityGroup] : [workspaceGroup] } satisfies DbSchemaSnapshot;
  });
  app.get(`${prefix}/events`, async (request, reply) => {
    const store = scopedStore(request);
    const query = request.query as { after?: string };
    const rawCursor = request.headers['last-event-id'] ?? query.after ?? '0';
    if (typeof rawCursor !== 'string' || !/^\d{1,15}$/.test(rawCursor)) return reply.code(400).send({ code: 'INVALID_CURSOR', message: 'Request a fresh snapshot.' });
    const cursor = Number(rawCursor);
    if (streams.size >= 32) return reply.code(429).send({ code: 'CAPACITY', message: 'Too many open event streams.' });
    reply.hijack();
    for (const [key, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(key, value);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const close = (graceful = false) => {
      if (closed) return;
      closed = true;
      channel.dispose(); clearInterval(heartbeat); clearTimeout(expiry); unsubscribe(); streams.delete(close); sessionStreams.get(request.cookies[COOKIE]!)?.delete(close);
      if (graceful) { if (!reply.raw.writableEnded) reply.raw.end(); }
      else reply.raw.destroy();
    };
    const sessionId = request.cookies[COOKIE]!;
    const session = sessions.get(sessionId)!;
    const channel = createStateStream(reply.raw, { close, authorized: () => sessions.get(sessionId) === session && session.expires > Date.now() });
    streams.add(close);
    if (!sessionStreams.has(sessionId)) sessionStreams.set(sessionId, new Set());
    sessionStreams.get(sessionId)!.add(close);
    reply.raw.on('close', close);
    channel.start();
    if (closed) return;
    // Everything through subscription is synchronous: no event can land in a snapshot/replay gap.
    const latest = store.snapshot();
    if (cursor > latest.cursor || !store.canReplay(cursor, 200)) {
      reply.raw.write('event: resync_required\ndata: {}\n\n');
      close(true); return;
    }
    // Hydrate at most one replay event at a time. Once output is buffered, the
    // newest committed full snapshot covers the backlog without retaining an
    // array of up to 200 large historical snapshots in this connection.
    let replayCursor = cursor;
    while (!closed && replayCursor < latest.cursor) {
      const after = channel.backpressured() ? latest.cursor - 1 : replayCursor;
      const event = store.replay(after, 1)[0];
      if (!event) break;
      channel.emit(event); replayCursor = event.cursor;
    }
    if (closed) return;
    unsubscribe = store.subscribe(channel.emit);
    heartbeat = setInterval(channel.heartbeat, 15000);
    heartbeat.unref();
    expiry = setTimeout(() => close(), Math.max(1, session.expires - Date.now()));
    expiry.unref();
  });

  app.post(`${prefix}/demo/commands`, async (request, reply) => {
    if ((request.params as { id: string }).id !== DEMO_WORKSPACE) return reply.code(400).send({ code: 'DEMO_ONLY', message: 'Sample actions cannot change a private workspace.' });
    const parsed = demoCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_COMMAND', message: 'The sample action is not valid.' });
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(key)) return reply.code(400).send({ code: 'IDEMPOTENCY_REQUIRED', message: 'Provide a unique action identifier.' });
    const result = store.commit(`command:${key}`, (state, now) => applyDemoCommand(state, parsed.data, now), JSON.stringify(parsed.data));
    return result;
  });

  // Created here, and closed first at shutdown, so a slow backup stop never keeps a folder window open.
  const folderPicker = options.folderPicker ?? createFolderPicker();
  const stopDiscovery = mode === 'demo' ? async () => {} : registerRepositoryApi(app, { store: request => {
    requireOwner(request);
    const result = scopedStore(request);
    if (result.snapshot().state.workspace.mode !== 'private') throw new IdentityError('PRIVATE_WORKSPACE_REQUIRED', 'Select a private workspace first.', 400);
    return result;
  }, listGitHub: request => identity!.listRepositories(requireOwner(request)),
  listGitHubBackground: store => identity!.listRepositories(identity!.registry.listAllWorkspaces().find(workspace => workspace.id === store.snapshot().state.workspace.id)!.ownerId),
  stores: () => identity?.registry.listAllWorkspaces().map(workspace => privateStores.get(workspace.ownerId, workspace.id)) ?? [],
  // The Browse... folder window. Demo mode registers no repository API, so it never gets a picker or a helper.
  folderPicker });

  const observation = identity && options.privateDirectory ? registerObservationApi(app, {
    directory: options.privateDirectory, vault: options.vault ?? new WindowsDpapiVault(),
    scoped: request => {
      const ownerId = requireOwner(request), selected = scopedStore(request);
      if (selected.snapshot().state.workspace.mode !== 'private') throw new IdentityError('PRIVATE_WORKSPACE_REQUIRED', 'Select a private workspace first.');
      return { ownerId, store: selected };
    },
    workspace: (owner, id) => privateStores.get(owner, id),
  }) : null;
  const workflow = identity ? registerWorkflowApi(app, {
    vault: options.vault ?? new WindowsDpapiVault(), provider: options.workflowProvider,
    scoped: request => {
      requireOwner(request); const selected = scopedStore(request);
      if (selected.snapshot().state.workspace.mode !== 'private') throw new IdentityError('PRIVATE_WORKSPACE_REQUIRED', 'Select a private workspace first.');
      return selected;
    },
    stores: () => identity.registry.listAllWorkspaces().map(workspace => privateStores.get(workspace.ownerId, workspace.id)),
  }) : null;
  const telemetry = identity && options.privateDirectory ? registerTelemetryApi(app, {
    directory: options.privateDirectory, port, vault: options.vault ?? new WindowsDpapiVault(),
    scoped: request => {
      const ownerId = requireOwner(request), selected = scopedStore(request);
      if (selected.snapshot().state.workspace.mode !== 'private') throw new IdentityError('PRIVATE_WORKSPACE_REQUIRED', 'Select a private workspace first.');
      return { ownerId, store: selected };
    },
    workspace: (owner, id) => privateStores.get(owner, id),
  }) : null;
  const runner = identity && options.privateDirectory ? registerRunnerApi(app, {
    directory: options.privateDirectory, vault: options.vault ?? new WindowsDpapiVault(), executor: options.runExecutor,
    scoped: request => {
      requireOwner(request); const selected = scopedStore(request);
      if (selected.snapshot().state.workspace.mode !== 'private') throw new IdentityError('PRIVATE_WORKSPACE_REQUIRED', 'Select a private workspace first.');
      return selected;
    },
    stores: () => identity.registry.listAllWorkspaces().map(workspace => privateStores.get(workspace.ownerId, workspace.id)),
  }) : null;

  // Same scoping as runner/telemetry: a private workspace and a real local data directory. Disabled
  // in demo mode like the repository API, since Vault operates on a connected project's real local
  // files and demo mode's sample repositories have none.
  if (identity && options.privateDirectory) registerVaultApi(app, {
    scoped: request => {
      requireOwner(request); const selected = scopedStore(request);
      if (selected.snapshot().state.workspace.mode !== 'private') throw new IdentityError('PRIVATE_WORKSPACE_REQUIRED', 'Select a private workspace first.');
      return selected;
    },
  });

  if (identity) registerHistoryApi(app, request => {
    requireOwner(request); const selected = scopedStore(request);
    if (selected.snapshot().state.workspace.mode !== 'private') throw new IdentityError('PRIVATE_WORKSPACE_REQUIRED', 'Select a private workspace first.');
    return selected;
  });
  const backups = mode === 'demo' ? undefined : options.backups;
  app.get('/api/v1/operations/backups', request => {
    requireOwner(request);
    if (!backups) throw new IdentityError('BACKUP_UNAVAILABLE', 'Backup scheduling is unavailable in this runtime. Use the local launcher for scheduled backups.', 503);
    return backups.status();
  });
  app.post('/api/v1/operations/backups/run', request => {
    requireOwner(request);
    if (!backups) throw new IdentityError('BACKUP_UNAVAILABLE', 'Backup scheduling is unavailable in this runtime.', 503);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(key)) throw new IdentityError('IDEMPOTENCY_REQUIRED', 'Provide a unique backup action identifier.');
    return backups.runNow(key);
  });
  app.addHook('onReady', async () => { await backups?.start(); });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof IdentityError) return reply.code(error.statusCode).send({ code: error.code, message: error.message, ...(error.restartSignIn ? { restartSignIn: true } : {}) });
    if (error instanceof WorkflowError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error instanceof CommandError) return reply.code(409).send({ code: 'STATE_CONFLICT', message: error.message });
    if (error instanceof VaultError) return reply.code(error.statusCode).send({ code: `VAULT_${error.code.toUpperCase().replaceAll('-', '_')}`, message: error.message, ...(error.findings ? { findings: error.findings } : {}) });
    if ((error as { statusCode?: number }).statusCode === 413) return reply.code(413).send({ code: 'BODY_TOO_LARGE', message: 'This request is too large.' });
    if ((error as { statusCode?: number }).statusCode === 400) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'The request could not be read.' });
    if ((error as { statusCode?: number }).statusCode === 415) return reply.code(415).send({ code: 'UNSUPPORTED_CONTENT_TYPE', message: 'Send this action as JSON or without a body. Form submissions are not supported.' });
    app.log.error({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'The local service could not complete this action.' });
  });

  const webRoot = join(projectRoot, 'apps/web/dist');
  if (existsSync(webRoot)) await app.register(staticFiles, { root: webRoot, index: 'index.html' });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'This page or capability is not available.' }));
  const interval = setInterval(() => {
    try {
      if (mode !== 'production' && store.snapshot().state.simulation.running) store.commit(`tick:${randomUUID()}`, advanceDemo);
    } catch { app.log.error('The sample simulation could not persist an update.'); }
  }, options.simulationInterval ?? 6000);
  interval.unref();
  app.addHook('preClose', async () => { clearInterval(interval); for (const close of streams) close(); const pickerClosed = folderPicker.close(); await backups?.stop(); await stopDiscovery(); await pickerClosed; await observation?.close(); await telemetry?.close(); await runner?.close(); await workflow?.close(); });
  app.addHook('onClose', async () => { store.close(); privateStores.close(); identity?.close(); sessions.clear(); });
  return { app, store };
}
