import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Agent, ArchivedAgent, NativeHideAllCounts, NativeSession, NativeSessionPage, NativeSource, ObservationConnection, ObservationEvent, TownState } from '@agent-town/contracts';
import { allocateAgentHome, nativeSessionTitleSchema, RETAINED_AGENT_LIMIT } from '@agent-town/contracts';
import { IdentityError } from '../identity/types.js';
import { applyObservation, observationProviders } from './reducer.js';
import { redactEvidence, safeReportedFiles } from './normalize.js';
import { sameObservationPath } from './paths.js';

interface SourceRow { id: string; provider: NativeSource['provider']; home_key: string; home_path: string; data: string }
interface SessionRow { id: string; source_id: string; native_id: string; repo_id: string; agent_id: string; data: string; agent_data: string | null; ordinal: number }
export interface StoredNativeSource { source: NativeSource; homePath: string }
export interface DiscoveredNativeMetadata { nativeSessionId: string; parentNativeSessionId?: string; title?: string; nativeAgentName?: string; projectPath: string; createdAt: string | null; updatedAt: string | null }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const legacyAlias = (connection: string, session: string, parent: string | null) => JSON.stringify(['legacy', connection, session, parent]);
const childAlias = (source: string, parent: string, child: string) => JSON.stringify(['child', source, parent, child]);
const receiptAlias = (source: string, event: string) => JSON.stringify(['receipt', source, event]);
const scopedLegacyAlias = (source: string, connection: string, session: string, parent: string | null) => JSON.stringify(['scoped-legacy', source, connection, session, parent]);
const actorAlias = (id: string) => JSON.stringify(['actor', id]);
const sessionData = (row: SessionRow) => JSON.parse(row.data) as NativeSession;
const laterTime = (left: string | null, right: string | null) => !left ? right : !right ? left : Date.parse(left) >= Date.parse(right) ? left : right;
const legacyChildSession = (parent: string, child: string) => parent.includes(':') || child.includes(':')
  ? `child-${createHash('sha256').update(JSON.stringify([parent, child])).digest('hex')}`
  : `${parent}:${child}`.length <= 160 ? `${parent}:${child}` : createHash('sha256').update(`${parent}:${child}`).digest('hex');

/** All writes participate in Store.commit's transaction; inventory never replays native work. */
export class NativeInventory {
  constructor(private db: Database.Database, private workspaceId: string) {}
  private writing() { if (!this.db.inTransaction) throw new Error('Native inventory writes require a state transaction.'); }

  sources(): NativeSource[] { return (this.db.prepare('SELECT data FROM native_sources ORDER BY id').all() as { data: string }[]).map(row => JSON.parse(row.data) as NativeSource); }
  source(id: string): StoredNativeSource | undefined {
    const row = this.db.prepare('SELECT * FROM native_sources WHERE id=?').get(id) as SourceRow | undefined;
    return row ? { source: JSON.parse(row.data) as NativeSource, homePath: row.home_path } : undefined;
  }
  register(provider: NativeSource['provider'], homePath: string, label: string): NativeSource {
    this.writing();
    const homeKey = process.platform === 'win32' ? homePath.toLowerCase() : homePath;
    const found = this.db.prepare('SELECT * FROM native_sources WHERE provider=? AND home_key=?').get(provider, homeKey) as SourceRow | undefined;
    if (found) return JSON.parse(found.data) as NativeSource;
    if (this.sources().length >= 32) throw new IdentityError('NATIVE_SOURCE_LIMIT', 'Use up to 32 approved native profiles.', 429);
    const source: NativeSource = { id: randomUUID(), provider, label, status: 'ready', discovery: ['copilot-vscode', 'custom'].includes(provider) ? 'unsupported' : 'available', lastScanAt: null, message: null, revision: 1 };
    this.db.prepare('INSERT INTO native_sources(id,provider,home_key,home_path,data) VALUES(?,?,?,?,?)').run(source.id, provider, homeKey, homePath, JSON.stringify(source));
    return source;
  }
  saveSource(source: NativeSource) {
    this.writing();
    if (!this.source(source.id)) throw new IdentityError('NATIVE_SOURCE_NOT_FOUND', 'Select an approved native profile.', 404);
    this.db.prepare('UPDATE native_sources SET data=? WHERE id=?').run(JSON.stringify(source), source.id);
  }
  private row(id: string) { return this.db.prepare('SELECT *,rowid AS ordinal FROM native_sessions WHERE id=?').get(id) as SessionRow | undefined; }
  private nativeRow(source: string, id: string) { return this.db.prepare('SELECT *,rowid AS ordinal FROM native_sessions WHERE source_id=? AND native_id=?').get(source, id) as SessionRow | undefined; }
  private alias(key: string): string | undefined { return (this.db.prepare('SELECT session_id FROM native_session_aliases WHERE alias_key=?').get(key) as { session_id: string } | undefined)?.session_id; }
  private saveAlias(key: string, id: string) {
    const current = this.alias(key);
    if (current && current !== id) throw new IdentityError('NATIVE_IDENTITY_CONFLICT', 'Conflicting native session identities require review.', 409);
    this.db.prepare('INSERT OR IGNORE INTO native_session_aliases(alias_key,session_id) VALUES(?,?)').run(key, id);
  }
  private legacyId(connection: ObservationConnection, event: ObservationEvent, state: TownState): string | undefined {
    const parent = event.parentSessionId ?? null;
    const id = event.nativeSourceId && this.alias(scopedLegacyAlias(event.nativeSourceId, connection.id, event.sessionId, parent))
      || this.alias(legacyAlias(connection.id, event.sessionId, parent))
      || state.agents.find(agent => agent.observation?.connectionId === connection.id && agent.observation.sessionId === event.sessionId && agent.observation.parentSessionId === parent)?.id
      || (this.db.prepare('SELECT id FROM agent_archive WHERE connection_id=? AND session_id=? AND parent_session_id IS ?').get(connection.id, event.sessionId, parent) as { id: string } | undefined)?.id;
    if (!id) return undefined;
    const row = this.row(id);
    // Rebinding a connection to another home must not adopt the former home's actor.
    return row && row.source_id !== event.nativeSourceId ? undefined : id;
  }
  private resolveEvent(connection: ObservationConnection, event: ObservationEvent, state: TownState) {
    const source = event.nativeSourceId!, parent = event.nativeParentSessionId, child = event.nativeChildId;
    const nativeId = child && parent && event.nativeSessionId === parent ? `child-${hash([parent, child])}` : event.nativeSessionId!;
    let row = this.nativeRow(source, nativeId);
    if (!row && child && parent) {
      const aliased = this.alias(childAlias(source, parent, child));
      if (aliased) row = this.row(aliased);
      // A native discovery parent relationship proves that the child alias is
      // the same session as a direct child-thread event.
      const direct = this.nativeRow(source, child);
      if (!row && direct && sessionData(direct).parentNativeSessionId === parent) row = direct;
    }
    const legacyId = this.legacyId(connection, event, state);
    const legacyRow = legacyId && this.row(legacyId);
    // A transport alias can adopt unbound legacy history, but cannot rename an
    // already bound native session. Only native identity or a verified child
    // alias above may resolve a different wire identity to that same actor.
    if (legacyRow && legacyRow.id !== row?.id) throw new IdentityError('NATIVE_IDENTITY_CONFLICT', 'This transport identity already belongs to another session. Review native session metadata before retrying.', 409);
    return { row, nativeId, legacyId, id: row?.id ?? legacyId ?? `agent-${hash([this.workspaceId, source, nativeId])}` };
  }

  /** Call before Store.commit, whose duplicate branch deliberately skips mutation. */
  validateReceipt(connection: ObservationConnection, event: ObservationEvent, state: TownState): void {
    if (state.workspace.mode !== 'private' || state.workspace.id !== this.workspaceId || connection.status === 'revoked' || !state.repositories.some(repo => repo.id === connection.repoId)) throw new IdentityError('SOURCE_REVOKED', 'This observation connection is unavailable.', 403);
    if (!event.nativeSourceId) return;
    const stored = this.source(event.nativeSourceId);
    if (!stored || stored.source.status !== 'ready' || connection.nativeSourceId !== stored.source.id || event.sourceRevision !== stored.source.revision || connection.sourceRevision !== stored.source.revision
      || stored.source.provider !== connection.provider || event.producer && event.producer !== connection.provider || !event.nativeSessionId) throw new IdentityError('NATIVE_SOURCE_MISMATCH', 'This event does not match an approved native profile. Review tracking setup.', 403);
    const resolved = this.resolveEvent(connection, event, state);
    const actor = this.actor(resolved.id, state);
    if (resolved.row && resolved.row.repo_id !== connection.repoId || actor && actor.repoId !== connection.repoId) throw new IdentityError('NATIVE_PROJECT_CONFLICT', 'This session belongs to a different selected project.', 409);
    const previous = this.alias(receiptAlias(event.nativeSourceId, event.id));
    if (previous && previous !== resolved.id) throw new IdentityError('NATIVE_EVENT_ID_CONFLICT', 'This native event ID already belongs to another session. Refresh metadata or use unique event IDs.', 409);
  }

  /** Transport aliases and connection revisions do not change event semantics. */
  receiptFingerprint(connection: ObservationConnection, event: ObservationEvent, state: TownState): string {
    this.validateReceipt(connection, event, state);
    if (!event.nativeSourceId) return JSON.stringify(event);
    return JSON.stringify({ id: event.id, kind: event.kind, occurredAt: event.occurredAt, sequence: event.sequence ?? null, summary: event.summary === undefined ? null : redactEvidence(event.summary), tool: event.tool === undefined ? null : redactEvidence(event.tool).slice(0, 100), files: event.files === undefined ? null : safeReportedFiles(event.files) });
  }
  preserveLegacyAliases(state: TownState) {
    this.writing();
    const agents = [...state.agents, ...(this.db.prepare('SELECT data FROM agent_archive').all() as { data: string }[]).map(row => (JSON.parse(row.data) as ArchivedAgent).agent)];
    for (const agent of agents) if (agent.observation) this.saveAlias(legacyAlias(agent.observation.connectionId, agent.observation.sessionId, agent.observation.parentSessionId), agent.id);
  }
  private archive(id: string): ArchivedAgent | undefined {
    const row = this.db.prepare('SELECT data FROM agent_archive WHERE id=?').get(id) as { data: string } | undefined;
    return row && JSON.parse(row.data) as ArchivedAgent;
  }
  private actor(id: string, state: TownState): Agent | undefined {
    return state.agents.find(agent => agent.id === id) ?? this.archive(id)?.agent ?? (() => { const data = this.row(id)?.agent_data; return data ? JSON.parse(data) as Agent : undefined; })();
  }
  private save(session: NativeSession, agent: Agent | undefined) {
    this.writing();
    if (!this.row(session.id) && (this.db.prepare('SELECT count(*) AS count FROM native_sessions').get() as { count: number }).count >= 10_000) throw new IdentityError('NATIVE_SESSION_LIMIT', 'The local session inventory has reached its 10,000-session limit. Existing records are preserved.', 429);
    this.db.prepare('INSERT INTO native_sessions(id,source_id,native_id,repo_id,agent_id,data,agent_data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET native_id=excluded.native_id,repo_id=excluded.repo_id,data=excluded.data,agent_data=excluded.agent_data')
      .run(session.id, session.sourceId, session.nativeSessionId, session.repoId, session.agentId, JSON.stringify(session), agent ? JSON.stringify(agent) : null);
  }
  private saveArchiveAgent(agent: Agent) {
    const archived = this.archive(agent.id);
    if (!archived) return;
    archived.agent = agent;
    this.db.prepare('UPDATE agent_archive SET connection_id=?,session_id=?,parent_session_id=?,data=? WHERE id=?')
      .run(agent.observation?.connectionId ?? null, agent.observation?.sessionId ?? null, agent.observation?.parentSessionId ?? null, JSON.stringify(archived), agent.id);
  }
  /** Only called after native metadata proves the parent/child relationship. */
  private mergeVerified(rows: SessionRow[], state: TownState, preservedLegacyId?: string): SessionRow {
    const unique = [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => Number(b.id === preservedLegacyId) - Number(a.id === preservedLegacyId) || a.ordinal - b.ordinal);
    const winner = unique[0]!;
    if (unique.length === 1) return winner;
    if (unique.some(row => row.source_id !== winner.source_id || row.repo_id !== winner.repo_id || state.runner?.runs.some(run => run.id === row.agent_id))) throw new IdentityError('NATIVE_IDENTITY_CONFLICT', 'Only proven external sessions in the same native profile and project can be reconciled.', 409);
    const ids = new Set(unique.map(row => row.id)), sessions = unique.map(sessionData);
    const original = this.actor(winner.id, state)!;
    const candidates = unique.map(row => this.actor(row.id, state)).filter((agent): agent is Agent => !!agent);
    const latest = candidates.filter(agent => agent.observation).sort((a, b) => Date.parse(b.observation!.sourceTime) - Date.parse(a.observation!.sourceTime)
      || Number(['offline', 'failed', 'cancelled'].includes(b.activity)) - Number(['offline', 'failed', 'cancelled'].includes(a.activity)))[0];
    const agent: Agent = { ...original, ...(latest ? { activity: latest.activity, observation: structuredClone(latest.observation!), updatedAt: latest.updatedAt, evidence: latest.evidence } : {}),
      files: [...new Set(candidates.flatMap(candidate => candidate.files))].slice(0, 100) };
    const visibility = sessions.some(session => session.visibility === 'hidden') ? 'hidden' : sessions.some(session => session.visibility === 'shown') ? 'shown' : 'auto';
    const live = state.agents.find(candidate => candidate.id === winner.id) ?? state.agents.find(candidate => ids.has(candidate.id));
    const archived = unique.map(row => this.archive(row.id)).find((record): record is ArchivedAgent => !!record);
    state.agents = state.agents.filter(candidate => !ids.has(candidate.id));
    if (live && visibility !== 'hidden') { agent.home = [...live.home]; state.agents.push(agent); }
    for (const report of state.handoffs) if (ids.has(report.agentId)) report.agentId = winner.id;
    for (const row of unique) {
      this.db.prepare('DELETE FROM agent_archive WHERE id=?').run(row.id);
      if (row.id === winner.id) continue;
      this.db.prepare('UPDATE native_session_aliases SET session_id=? WHERE session_id=?').run(winner.id, row.id);
      this.saveAlias(actorAlias(row.id), winner.id);
      this.db.prepare('DELETE FROM native_sessions WHERE id=?').run(row.id);
    }
    if (archived && !state.agents.some(candidate => candidate.id === winner.id)) {
      archived.agent = agent;
      this.db.prepare('INSERT INTO agent_archive(id,repo_id,connection_id,session_id,parent_session_id,archived_at,data) VALUES(?,?,?,?,?,?,?)')
        .run(agent.id, agent.repoId, agent.observation?.connectionId ?? null, agent.observation?.sessionId ?? null, agent.observation?.parentSessionId ?? null, archived.archivedAt, JSON.stringify(archived));
    }
    const title = sessions.filter(session => session.title).sort((left, right) => Date.parse(right.nativeUpdatedAt ?? right.discoveredAt) - Date.parse(left.nativeUpdatedAt ?? left.discoveredAt))[0]?.title;
    const nativeAgentName = sessions.filter(session => session.nativeAgentName).sort((left, right) => Date.parse(right.nativeUpdatedAt ?? right.discoveredAt) - Date.parse(left.nativeUpdatedAt ?? left.discoveredAt))[0]?.nativeAgentName;
    const session: NativeSession = { ...sessions[0]!, ...(title ? { title } : {}), ...(nativeAgentName ? { nativeAgentName } : {}), visibility, visible: visibility === 'hidden' ? false : sessions.some(value => value.visible), sceneVisible: state.agents.some(candidate => candidate.id === winner.id),
      activity: agent.activity, observedAt: sessions.reduce<string | null>((time, value) => laterTime(time, value.observedAt), null), nativeUpdatedAt: sessions.reduce<string | null>((time, value) => laterTime(time, value.nativeUpdatedAt), null) };
    this.save(session, agent);
    state.history = { archivedAgents: (this.db.prepare('SELECT count(*) AS count FROM agent_archive').get() as { count: number }).count, updatedAt: new Date().toISOString() };
    return this.row(winner.id)!;
  }
  private makeAgent(session: NativeSession, state: TownState): Agent {
    const repo = state.repositories.find(repo => repo.id === session.repoId);
    if (!repo) throw new IdentityError('LOCAL_REPOSITORY_REQUIRED', 'Connect this local project before tracking its sessions.', 409);
    return { id: session.agentId, provider: observationProviders[session.provider], name: `${observationProviders[session.provider]} · ${session.nativeSessionId.slice(0, 8)}`, role: session.parentNativeSessionId ? 'Discovered child session' : 'Discovered session', repoId: session.repoId,
      task: 'External session · task not linked', activity: 'unknown', color: repo.color, home: [0, 0], updatedAt: session.discoveredAt, files: [], evidence: 'Found in local metadata. Activity and verification evidence are unavailable until received.', contextVersion: null,
      discovery: { sourceId: session.sourceId, nativeSessionId: session.nativeSessionId, ...(session.parentNativeSessionId ? { parentNativeSessionId: session.parentNativeSessionId } : {}), ...(session.title ? { title: session.title } : {}), ...(session.nativeAgentName ? { nativeAgentName: session.nativeAgentName } : {}), discoveredAt: session.discoveredAt, nativeUpdatedAt: session.nativeUpdatedAt } };
  }
  discover(source: NativeSource, repoId: string, items: DiscoveredNativeMetadata[], state: TownState, now: string): void {
    this.writing();
    const stored = this.source(source.id), repo = state.repositories.find(candidate => candidate.id === repoId);
    if (state.workspace.id !== this.workspaceId || !stored || stored.source.status !== 'ready' || stored.source.revision !== source.revision || stored.source.provider !== source.provider) throw new IdentityError('NATIVE_SOURCE_MISMATCH', 'Select an approved current native profile before discovery.', 403);
    if (!repo?.localPath) throw new IdentityError('LOCAL_REPOSITORY_REQUIRED', 'Connect this local project before discovering its sessions.', 409);
    for (const item of items) {
      if (!sameObservationPath(repo.localPath, item.projectPath)) throw new IdentityError('NATIVE_PROJECT_CONFLICT', 'Discovered metadata belongs to a different selected project.', 409);
      let row = this.nativeRow(source.id, item.nativeSessionId);
      if (item.parentNativeSessionId) {
        const id = this.alias(childAlias(source.id, item.parentNativeSessionId, item.nativeSessionId));
        const child = id && this.row(id);
        if (child) row = row ? this.mergeVerified([row, child], state) : child;
      }
      // Explicit source binding permits the verified native ID to adopt legacy history.
      let legacyId: string | undefined;
      for (const connection of state.observation?.connections ?? []) {
        if (connection.nativeSourceId !== source.id || connection.repoId !== repoId) continue;
        const candidates = [{ sessionId: item.nativeSessionId, parentSessionId: undefined as string | undefined },
          ...(item.parentNativeSessionId ? [{ sessionId: legacyChildSession(item.parentNativeSessionId, item.nativeSessionId), parentSessionId: item.parentNativeSessionId }] : [])];
        for (const candidate of candidates) {
          const found = this.legacyId(connection, { id: 'discovery-association', ...candidate, nativeSourceId: source.id, kind: 'session.start', occurredAt: now }, state);
          if (!found || found === row?.id) continue;
          const existingRow = this.row(found), actor = this.actor(found, state);
          if (!actor || actor.repoId !== repoId || state.runner?.runs.some(run => run.id === found)) continue;
          if (!row && legacyId && legacyId !== found) {
            const previousActor = this.actor(legacyId, state)!;
            this.save({ id: legacyId, agentId: legacyId, sourceId: source.id, provider: source.provider, nativeSessionId: `legacy-${hash(legacyId)}`, repoId,
              createdAt: null, nativeUpdatedAt: null, discoveredAt: now, observedAt: previousActor.observation ? previousActor.updatedAt : null, visible: state.agents.some(agent => agent.id === legacyId), visibility: 'auto', sceneVisible: state.agents.some(agent => agent.id === legacyId), activity: previousActor.activity }, previousActor);
            row = this.row(legacyId);
          }
          if (!row) { legacyId = found; row = existingRow; continue; }
          if (!existingRow) {
            const adopted: NativeSession = { id: found, agentId: found, sourceId: source.id, provider: source.provider, nativeSessionId: `legacy-${hash(found)}`, repoId,
              createdAt: null, nativeUpdatedAt: null, discoveredAt: now, observedAt: actor.observation ? actor.updatedAt : null, visible: state.agents.some(agent => agent.id === found), visibility: 'auto', sceneVisible: state.agents.some(agent => agent.id === found), activity: actor.activity };
            this.save(adopted, actor);
          }
          row = this.mergeVerified([row, this.row(found)!], state, existingRow ? undefined : row.native_id.startsWith('legacy-') ? row.id : found);
          legacyId = row.id;
        }
      }
      const id = row?.id ?? legacyId ?? `agent-${hash([this.workspaceId, source.id, item.nativeSessionId])}`;
      const previous = row && sessionData(row);
      if (previous && previous.repoId !== repoId) throw new IdentityError('NATIVE_PROJECT_CONFLICT', 'This session is already associated with another selected project. Review its project mapping.', 409);
      if (previous?.parentNativeSessionId && item.parentNativeSessionId && previous.parentNativeSessionId !== item.parentNativeSessionId) throw new IdentityError('NATIVE_IDENTITY_CONFLICT', 'Conflicting native parent identities require review.', 409);
      const parent = item.parentNativeSessionId ?? previous?.parentNativeSessionId;
      const parsedTitle = nativeSessionTitleSchema.safeParse(item.title);
      const title = parsedTitle.success ? parsedTitle.data : previous?.title;
      const parsedAgentName = nativeSessionTitleSchema.safeParse(source.provider === 'codex' ? item.nativeAgentName : undefined);
      const nativeAgentName = parsedAgentName.success ? parsedAgentName.data : previous?.nativeAgentName;
      const session: NativeSession = { id, agentId: id, sourceId: source.id, provider: source.provider, nativeSessionId: item.nativeSessionId,
        ...(parent ? { parentNativeSessionId: parent } : {}), ...(title ? { title } : {}), ...(nativeAgentName ? { nativeAgentName } : {}), repoId, createdAt: previous?.createdAt ?? item.createdAt, nativeUpdatedAt: laterTime(previous?.nativeUpdatedAt ?? null, item.updatedAt),
        discoveredAt: previous?.discoveredAt ?? now, observedAt: previous?.observedAt ?? null, visible: previous?.visible ?? !!state.agents.find(agent => agent.id === id), visibility: previous?.visibility ?? 'auto', sceneVisible: state.agents.some(agent => agent.id === id), activity: previous?.activity ?? 'unknown' };
      const agent = this.actor(id, state) ?? this.makeAgent(session, state);
      session.observedAt ??= agent.observation ? agent.updatedAt : null;
      session.title ??= agent.discovery?.title;
      session.nativeAgentName ??= agent.discovery?.nativeAgentName;
      agent.discovery = { sourceId: source.id, nativeSessionId: item.nativeSessionId, ...(parent ? { parentNativeSessionId: parent } : {}), ...(session.title ? { title: session.title } : {}), ...(session.nativeAgentName ? { nativeAgentName: session.nativeAgentName } : {}), discoveredAt: session.discoveredAt, nativeUpdatedAt: session.nativeUpdatedAt };
      session.activity = agent.activity;
      this.save(session, agent);
      this.saveArchiveAgent(agent);
      if (item.parentNativeSessionId) this.saveAlias(childAlias(source.id, item.parentNativeSessionId, item.nativeSessionId), id);
    }
  }
  page(state: TownState, options: { repoId?: string; sourceId?: string; cursor?: string; includeOlder?: boolean; visibility?: 'hidden' } = {}): NativeSessionPage {
    const offset = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new IdentityError('INVALID_CURSOR', 'Refresh the session list and try again.');
    const rows = this.db.prepare('SELECT data FROM native_sessions WHERE (? IS NULL OR repo_id=?) AND (? IS NULL OR source_id=?) ORDER BY id').all(options.repoId ?? null, options.repoId ?? null, options.sourceId ?? null, options.sourceId ?? null) as { data: string }[];
    const all = rows.map(row => JSON.parse(row.data) as NativeSession);
    // H0-15: hiddenTotal is scoped the same way as the query above (repoId/sourceId) but, unlike `items`
    // below, is never windowed by the 30-day cutoff — a session hidden 6 months ago is still hidden today,
    // even on a page that would not otherwise list it without includeOlder.
    const hiddenTotal = all.filter(item => item.visibility === 'hidden').length;
    const cutoff = Date.now() - 30 * 86400000;
    const items = all.filter(item => (options.includeOlder || Date.parse(item.observedAt ?? item.nativeUpdatedAt ?? item.discoveredAt) >= cutoff) && (!options.visibility || item.visibility === options.visibility))
      .sort((a, b) => (b.observedAt ?? b.nativeUpdatedAt ?? b.discoveredAt).localeCompare(a.observedAt ?? a.nativeUpdatedAt ?? a.discoveredAt) || a.id.localeCompare(b.id));
    return { items: items.slice(offset, offset + 25).map(item => { const live = state.agents.find(agent => agent.id === item.agentId); return { ...item, sceneVisible: !!live, activity: live?.activity ?? item.activity }; }), total: items.length, nextCursor: offset + 25 < items.length ? String(offset + 25) : null, hiddenTotal };
  }
  detail(id: string, state: TownState): Agent {
    id = this.alias(actorAlias(id)) ?? id;
    if (!this.row(id)) throw new IdentityError('NATIVE_SESSION_NOT_FOUND', 'This native session is unavailable.', 404);
    const agent = this.actor(id, state);
    if (!agent) throw new IdentityError('NATIVE_SESSION_NOT_FOUND', 'This native session is unavailable.', 404);
    return agent;
  }
  /** `onLimit: 'refuse'` (H0-15) is opt-in so every existing caller that omits it — including test fixtures
   * that show many sessions in a loop to seed overflow state past RETAINED_AGENT_LIMIT — keeps today's exact
   * behaviour: it marks the session shown without ever placing it in town if the town is already full.
   * The real "Show in town" HTTP route passes 'refuse' instead, so a session actually stays 'hidden' (findable
   * and reversible) rather than silently losing both its town slot and its place on the hidden list. */
  visibility(id: string, visible: boolean, state: TownState, options: { onLimit?: 'silent' | 'refuse' } = {}): void {
    this.writing();
    id = this.alias(actorAlias(id)) ?? id;
    const row = this.row(id);
    if (!row) throw new IdentityError('NATIVE_SESSION_NOT_FOUND', 'This native session is unavailable.', 404);
    const session = JSON.parse(row.data) as NativeSession, agent = this.actor(id, state) ?? this.makeAgent(session, state);
    if (visible && !state.repositories.some(repo => repo.id === session.repoId)) throw new IdentityError('LOCAL_REPOSITORY_REQUIRED', 'Reconnect this project before showing its session in town.', 409);
    if (visible && options.onLimit === 'refuse' && !state.agents.some(actor => actor.id === id) && state.agents.length >= RETAINED_AGENT_LIMIT) throw new IdentityError('NATIVE_RESIDENT_LIMIT', 'Town is full at 200 residents. Hide one to show this.', 429);
    session.visible = visible; session.visibility = visible ? 'shown' : 'hidden';
    if (!visible) state.agents = state.agents.filter(actor => actor.id !== id);
    else if (!state.agents.some(actor => actor.id === id) && state.agents.length < RETAINED_AGENT_LIMIT) {
      agent.home = allocateAgentHome(agent.repoId, state.repositories, state.agents); state.agents.push(agent);
      this.db.prepare('DELETE FROM agent_archive WHERE id=?').run(id);
    }
    session.sceneVisible = state.agents.some(actor => actor.id === id); this.save(session, agent);
    state.history = { archivedAgents: (this.db.prepare('SELECT count(*) AS count FROM agent_archive').get() as { count: number }).count, updatedAt: new Date().toISOString() };
  }
  /** H0-12. Read-only decision of what "hide every watched session of this project" does right now; previewHideProject and
   * hideProject both read it, so the count the owner is told is the count that is applied.
   *  - hide: native-backed external residents of the house (an actor with a saved native session row AND a native identity,
   *    observation.nativeSourceId or discovery.sourceId), plus shown sessions still waiting for a free slot, which would
   *    otherwise pop into the town the moment hiding freed one;
   *  - skippedLegacy: external residents without a native identity (every Cursor hook session). A later hook event without
   *    nativeSourceId would create the character again, so they are counted and left in town, to be archived from History after
   *    their connection is revoked;
   *  - managed runs are never touched: the runner owns those characters;
   *  - archived sessions are History, not town: they are neither hidden nor counted (hide is not archive). */
  private hidePlan(repoId: string, state: TownState): { rows: SessionRow[]; counts: NativeHideAllCounts } {
    if (state.workspace.id !== this.workspaceId || !state.repositories.some(repo => repo.id === repoId)) throw new IdentityError('NATIVE_PROJECT_NOT_FOUND', 'Select a connected project.', 404);
    const managed = new Set((state.runner?.runs ?? []).map(run => run.id));
    const rows = new Map((this.db.prepare('SELECT *,rowid AS ordinal FROM native_sessions WHERE repo_id=? ORDER BY rowid').all(repoId) as SessionRow[])
      .filter(row => !managed.has(row.id) && !managed.has(row.agent_id)).map(row => [row.id, row] as const));
    const live = new Set(state.agents.map(agent => agent.id));
    const archived = new Set((this.db.prepare('SELECT id FROM agent_archive WHERE repo_id=?').all(repoId) as { id: string }[]).map(row => row.id));
    const hide = new Map<string, SessionRow>();
    let skippedLegacy = 0, alreadyHidden = 0;
    for (const agent of state.agents) {
      if (agent.repoId !== repoId || managed.has(agent.id)) continue;
      const row = rows.get(agent.id);
      if (row && (agent.observation?.nativeSourceId || agent.discovery?.sourceId)) hide.set(row.id, row);
      else if (agent.observation || agent.discovery) skippedLegacy++;
    }
    for (const row of rows.values()) {
      if (live.has(row.id) || archived.has(row.id)) continue;
      const session = sessionData(row);
      if (session.visibility === 'hidden') alreadyHidden++;
      else if (session.visible) hide.set(row.id, row);
    }
    return { rows: [...hide.values()], counts: { hidden: hide.size, alreadyHidden, skippedLegacy } };
  }
  /** What hideProject would do now, without writing. A caller uses it to skip its commit when nothing would change. */
  previewHideProject(repoId: string, state: TownState): NativeHideAllCounts { return this.hidePlan(repoId, state).counts; }
  /** H0-12: hides every native-backed external resident of one project inside the caller's ONE state transaction, so a failure
   * on any row leaves state, inventory and archive as they were. Each session ends exactly as visibility(id, false) leaves it:
   * its actor and reports stay inspectable, nothing is archived or deleted. Hide is a snapshot: a session this inventory has not
   * seen still appears when its tool reports. There is deliberately no bulk "show all"; undo is per session. Writes one audit
   * note of counts only (no session name, id or path). */
  hideProject(repoId: string, state: TownState, now: string): NativeHideAllCounts {
    this.writing();
    const { rows, counts } = this.hidePlan(repoId, state);
    if (!rows.length) return counts;
    for (const row of rows) {
      const session = sessionData(row), agent = this.actor(row.id, state) ?? this.makeAgent(session, state);
      session.visible = false; session.visibility = 'hidden'; session.sceneVisible = false;
      this.save(session, agent);
    }
    const hidden = new Set(rows.map(row => row.id));
    state.agents = state.agents.filter(agent => !hidden.has(agent.id));
    const sessions = (count: number) => `${count} session${count === 1 ? '' : 's'}`;
    state.activity.unshift({ id: randomUUID(), kind: 'system', createdAt: now, message: `Hid ${sessions(counts.hidden)} from town; saved reports are kept and nothing was deleted. New sessions from a tool that is still connected can still appear.${counts.skippedLegacy ? ` ${sessions(counts.skippedLegacy)} without a native identity stayed in town.` : ''}` });
    state.activity = state.activity.slice(0, 500);
    return counts;
  }
  /** Returns null for legacy receipts whose native profile is not established. */
  receive(state: TownState, connection: ObservationConnection, event: ObservationEvent, now: string): string | null {
    this.writing();
    if (!event.nativeSourceId) return null;
    this.validateReceipt(connection, event, state);
    const source = this.source(event.nativeSourceId)!.source;
    const child = event.nativeChildId;
    const { row, nativeId, id } = this.resolveEvent(connection, event, state);
    const legacy = legacyAlias(connection.id, event.sessionId, event.parentSessionId ?? null);
    const existing = row && sessionData(row);
    const parent = event.nativeParentSessionId ?? existing?.parentNativeSessionId;
    if (existing && existing.repoId !== connection.repoId) throw new IdentityError('NATIVE_PROJECT_CONFLICT', 'This session belongs to a different selected project.', 409);
    const session: NativeSession = existing ?? { id, agentId: id, sourceId: source.id, provider: source.provider, nativeSessionId: nativeId,
      ...(parent ? { parentNativeSessionId: parent } : {}), repoId: connection.repoId, createdAt: null, nativeUpdatedAt: null, discoveredAt: now, observedAt: null, visible: true, visibility: 'auto', sceneVisible: false, activity: 'unknown' };
    if (session.visibility !== 'hidden') session.visible = true;
    const agent = this.actor(id, state) ?? this.makeAgent(session, state);
    const previousObservation = agent.observation && structuredClone(agent.observation);
    const changedStream = previousObservation?.connectionId !== connection.id || previousObservation.sessionId !== event.sessionId || previousObservation.parentSessionId !== (event.parentSessionId ?? null);
    const previousSequence = changedStream ? null : previousObservation?.lastSequence ?? null;
    const older = !!previousObservation && ((event.sequence !== undefined && previousSequence !== null && event.sequence <= previousSequence)
      || Date.parse(event.occurredAt) < Date.parse(previousObservation.sourceTime)
      || ['offline', 'failed', 'cancelled'].includes(agent.activity) && event.occurredAt === previousObservation.sourceTime && (event.sequence === undefined || previousSequence === null || event.sequence <= previousSequence));
    agent.observation = { connectionId: connection.id, sessionId: event.sessionId, parentSessionId: event.parentSessionId ?? null, nativeSourceId: source.id,
      lastSequence: previousSequence, sourceTime: previousObservation?.sourceTime ?? '1970-01-01T00:00:00.000Z', freshness: previousObservation?.freshness ?? 'stale', billing: 'unavailable' };
    agent.role = parent ? 'Observed child session' : 'Observed session';
    const archived = this.archive(id);
    const oldReport = state.handoffs.find(report => report.agentId === id && report.details?.sourceEventId === event.id);
    if (oldReport && (oldReport.summary !== redactEvidence(event.summary ?? '').trim() || oldReport.details?.occurredAt && Date.parse(oldReport.details.occurredAt) !== Date.parse(event.occurredAt)
      || JSON.stringify(oldReport.details?.files.paths ?? []) !== JSON.stringify(safeReportedFiles(event.files)))) throw new IdentityError('NATIVE_EVENT_ID_CONFLICT', 'This event identifier was already used for different saved evidence.', 409);
    const type = oldReport ? 'observation.duplicate' : applyObservation(state, connection, event, now, undefined, { agent, suppressPlacement: true });
    if (oldReport && previousObservation) agent.observation = previousObservation;
    if (older && previousObservation) agent.observation = previousObservation;
    // Placement happens only after the reducer accepts current activity. A late
    // start/tool receipt cannot unarchive a terminal session before ordering runs.
    const resumed = !older && type === `observation.${event.kind}` && ['session.start', 'turn.start', 'tool.start', 'tool.finish'].includes(event.kind);
    if (session.visible && !state.agents.some(a => a.id === id) && state.agents.length < RETAINED_AGENT_LIMIT && (!archived || resumed)) {
      agent.home = allocateAgentHome(agent.repoId, state.repositories, state.agents); state.agents.push(agent);
    }
    session.observedAt = now; session.activity = agent.activity; session.sceneVisible = state.agents.some(a => a.id === id);
    this.save(session, agent);
    if (!this.alias(legacy) || this.alias(legacy) === id) this.saveAlias(legacy, id);
    this.saveAlias(scopedLegacyAlias(source.id, connection.id, event.sessionId, event.parentSessionId ?? null), id);
    this.saveAlias(receiptAlias(source.id, event.id), id);
    if (child && parent) this.saveAlias(childAlias(source.id, parent, child), id);
    if (archived) {
      if (session.sceneVisible) this.db.prepare('DELETE FROM agent_archive WHERE id=?').run(id);
      else this.saveArchiveAgent(agent);
      state.history = { archivedAgents: (this.db.prepare('SELECT count(*) AS count FROM agent_archive').get() as { count: number }).count, updatedAt: now };
    }
    return type;
  }
}
