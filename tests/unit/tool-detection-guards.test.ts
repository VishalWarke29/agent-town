import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { hookOverlapConflicts, hookOverlapMessage, recommendToolSet, surfaceSchema, type AutoDetectSurface, type ToolDetectionApplyResponse, type ToolDetectionReview, type ToolDetectionSnapshot, type ToolSurface } from '@agent-town/contracts';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { registerObservationApi } from '../../apps/service/src/observation/service';
import { activationStep, observationSetup, __setHookBridgePathForTests } from '../../apps/service/src/observation/setup';
import { bridgeConfigSchema, hasAmbiguousHookOverlap, resolveHookSource, type BridgeConfig } from '../../apps/service/src/observation/source-binding';
import type { RegisteredObservation } from '../../apps/service/src/observation/registry';
import { IdentityError } from '../../apps/service/src/identity/types';

const profileVariables = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'COPILOT_HOME'] as const;
const saved = Object.fromEntries(profileVariables.map(name => [name, process.env[name]]));
afterEach(() => { for (const name of profileVariables) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

/** A real service around an in-memory store, with each tool's profile folder present or absent as requested. */
async function harness(workspace: string, present: Partial<Record<'codex' | 'claude' | 'cursor' | 'copilot', boolean>>) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-tool-detection-'));
  const repo = join(directory, 'repo'); mkdirSync(repo);
  const home = (name: keyof typeof present) => { const path = join(directory, `${name}-profile`); if (present[name]) mkdirSync(path); return path; };
  process.env.CODEX_HOME = home('codex'); process.env.CLAUDE_CONFIG_DIR = home('claude'); process.env.COPILOT_HOME = home('copilot');
  process.env.CURSOR_CONFIG_DIR = home('cursor');
  if (present.cursor) writeFileSync(join(process.env.CURSOR_CONFIG_DIR, 'agents.ndjson'), '');
  const state = privateState({ id: workspace, name: 'Fixture', kind: 'personal' });
  state.discovery!.roots = [repo];
  state.repositories = [{ id: 'project-one', name: 'Project', source: 'local', localPath: repo, description: '', branch: 'Unavailable', language: '', color: '#888888', position: [0, 0] }];
  const store = new Store(':memory:', state), app = Fastify(), secrets = new Map<string, string>();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : (error as { statusCode?: number }).statusCode === 400 ? 400 : 500).send({ code: error instanceof IdentityError ? error.code : 'INTERNAL', message: error instanceof Error ? error.message : 'Request failed' }));
  const api = registerObservationApi(app, { directory, vault: { available: true, async put(id, value) { secrets.set(id, value); }, async get(id) { return secrets.get(id) ?? null; }, async delete(id) { secrets.delete(id); } },
    scoped: () => ({ ownerId: 'owner', store }), workspace: () => store });
  const base = `/api/v1/workspaces/${workspace}/observation`, prefix = `${base}/tool-detection`;
  const review = async (providers: string[]) => app.inject({ method: 'POST', url: `${prefix}/review`, payload: { repoId: 'project-one', providers } });
  const apply = async (items: { provider: string; connectionId: string }[]) => app.inject({ method: 'POST', url: `${prefix}/apply`, payload: { repoId: 'project-one', items } });
  const detect = async () => app.inject({ method: 'GET', url: `${prefix}?repoId=project-one` });
  const post = async (path: string, payload?: unknown) => app.inject({ method: 'POST', url: `${base}/${path}`, ...(payload ? { payload } : {}) });
  /** Reviews then applies the given tools, returning the reviewed ids. */
  const connect = async (providers: string[]) => {
    const items = ((await review(providers)).json() as ToolDetectionReview).items;
    const response = await apply(items.map(item => ({ provider: item.provider, connectionId: item.connectionId })));
    return { items, response };
  };
  const close = async () => {
    await api.close(); await app.close(); store.close();
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-tool-detection-`)) throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  };
  return { directory, repo, store, api, secrets, review, apply, detect, post, connect, close };
}
const id = (seed: number) => `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
const claudePayload = (repo: string) => ({ session_id: 's-1', transcript_path: 'C:\\t.jsonl', cwd: repo, hook_event_name: 'SessionStart' });

describe('combined onboarding refuses hook combinations that would go silent', () => {
  it('refuses Claude Code with Cursor or Copilot CLI before writing anything, and still connects Codex with Claude Code', async () => {
    const h = await harness('guard-overlap', { codex: true, claude: true, cursor: true, copilot: true });
    try {
      for (const pair of [['claude', 'cursor'], ['claude', 'copilot-cli']]) {
        const refused = await h.apply(pair.map((provider, index) => ({ provider, connectionId: id(index + 1) })));
        expect(refused.statusCode).toBe(409);
        expect(refused.json().code).toBe('HOOK_OVERLAP');
        expect(refused.json().message).toContain('Claude Code would not be able to report if');
      }
      // Nothing was created by either refused request.
      expect(h.store.snapshot().state.observation?.connections ?? []).toEqual([]);
      expect(h.api.registry.all()).toEqual([]);
      expect(existsSync(join(h.repo, '.claude'))).toBe(false); expect(existsSync(join(h.repo, '.cursor'))).toBe(false);

      const { items, response } = await h.connect(['codex', 'claude']);
      expect(response.statusCode).toBe(200);
      expect((response.json() as ToolDetectionApplyResponse).results).toMatchObject([{ provider: 'codex', applied: true }, { provider: 'claude', applied: true }]);

      // The point of connecting is that events arrive: the bridge accepts genuine payloads for what was written.
      for (const item of items) {
        const config = bridgeConfigSchema.parse(JSON.parse(readFileSync(join(h.directory, 'observation', 'connections', `${item.connectionId}.json`), 'utf8')));
        expect(hasAmbiguousHookOverlap(config), `${item.provider} overlap`).toBe(false);
        expect(resolveHookSource(config, claudePayload(h.repo)).blocked, `${item.provider} events`).toBe(false);
      }

      // With Claude Code connected, Cursor would now silence it: apply refuses, and review reports why.
      const cursorLater = await h.apply([{ provider: 'cursor', connectionId: id(9) }]);
      expect(cursorLater.statusCode).toBe(409);
      expect(cursorLater.json().message).toContain('Claude Code would not be able to report if Cursor is connected too');
      const preview = await h.review(['cursor']);
      expect(preview.statusCode).toBe(200);
      expect((preview.json() as ToolDetectionReview).activeProviders).toEqual(expect.arrayContaining(['codex', 'claude']));
    } finally { await h.close(); }
  });

  it('refuses adding Claude Code when Cursor is already connected (the other direction)', async () => {
    const h = await harness('guard-cursor-first', { claude: true, cursor: true });
    try {
      expect((await h.connect(['cursor'])).response.statusCode).toBe(200);
      const claudeLater = await h.apply([{ provider: 'claude', connectionId: id(21) }]);
      expect(claudeLater.statusCode).toBe(409);
      expect(claudeLater.json().message).toContain('Claude Code would not be able to report if Cursor is connected too');
      expect(existsSync(join(h.repo, '.claude'))).toBe(false);
    } finally { await h.close(); }
  });

  it('treats the hook files on disk as authoritative: a revoked connection\'s leftover hook still blocks a new one until it is removed', async () => {
    const h = await harness('guard-disk', { claude: true, codex: true });
    try {
      const { items: [first] } = await h.connect(['claude']);
      expect((await h.post(`connections/${first.connectionId}/revoke`)).statusCode).toBe(200);
      expect(h.api.registry.all()).toEqual([]);          // the registry no longer lists it…
      expect(existsSync(join(h.repo, '.claude', 'settings.local.json'))).toBe(true);   // …but its hook is still installed
      const refusedReview = await h.review(['claude']);
      expect(refusedReview.statusCode).toBe(409); expect(refusedReview.json().code).toBe('HOOK_OVERLAP');
      const refusedApply = await h.apply([{ provider: 'claude', connectionId: id(31) }]);
      expect(refusedApply.statusCode).toBe(409); expect(refusedApply.json().code).toBe('HOOK_OVERLAP');
      expect(h.api.registry.get(id(31))).toBeNull();
      // Codex has no shared hook file, so it is unaffected.
      expect((await h.connect(['codex'])).response.statusCode).toBe(200);

      expect((await h.post(`connections/${first.connectionId}/remove-hooks`)).statusCode).toBe(200);
      const again = await h.connect(['claude']);
      expect((again.response.json() as ToolDetectionApplyResponse).results).toMatchObject([{ provider: 'claude', applied: true }]);
    } finally { await h.close(); }
  });

  it('refuses a foreign Agent Town entry already present in a shared hook file', async () => {
    const h = await harness('guard-foreign', { claude: true, copilot: true, cursor: true });
    try {
      mkdirSync(join(h.repo, '.claude'));
      writeFileSync(join(h.repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node hook-bridge.cjs --config C:/elsewhere/${id(99)}.json --event SessionStart` }] }] } }));
      for (const provider of ['claude', 'copilot-cli']) expect((await h.review([provider])).statusCode, provider).toBe(409);
      expect((await h.review(['cursor'])).statusCode).toBe(200);
    } finally { await h.close(); }
  });

  it('keeps the shared overlap table identical to what the bridge actually rejects', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-hook-overlap-'));
    try {
      const providers = surfaceSchema.options.filter(provider => provider !== 'custom');
      for (const target of providers) for (const other of providers) {
        if (target === other) continue;
        const repo = join(directory, `${target}-with-${other}`); mkdirSync(repo, { recursive: true });
        // Install `other`'s real hook file, then ask the bridge whether `target`'s callback would be rejected.
        const otherId = id(1), targetId = id(2);
        const otherRecord: RegisteredObservation = { connection: { id: otherId, provider: other, repoId: 'r', label: 'x', status: 'unverified', createdAt: '2026-09-18T00:00:00.000Z', lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0 }, workspaceId: 'w', ownerId: 'o', repoPath: repo };
        const setup = observationSetup(otherRecord, join(directory, 'data'));
        mkdirSync(join(setup.configPath, '..'), { recursive: true }); writeFileSync(setup.configPath, setup.config);
        const config: BridgeConfig = { version: 2, connectionId: targetId, provider: target, repoPath: repo, spoolPath: join(directory, 'spool') };
        const rejectedByBridge = hasAmbiguousHookOverlap(config);
        const predicted = hookOverlapConflicts([target, other]).some(conflict => conflict.provider === target);
        expect(predicted, `${target} with ${other}`).toBe(rejectedByBridge);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('describes a conflict in plain words', () => {
    const conflicts = hookOverlapConflicts(['claude', 'cursor', 'codex'] as ToolSurface[]);
    expect(conflicts).toEqual([{ provider: 'claude', blockedBy: ['cursor'] }]);
    expect(hookOverlapMessage(conflicts)).toContain('Claude Code would not be able to report if Cursor is connected too');
    expect(hookOverlapMessage(conflicts)).not.toMatch(/manual setup|blocked by/);
    expect(hookOverlapConflicts(['codex', 'cursor'] as ToolSurface[])).toEqual([]);
  });

  it('applies only one of two conflicting requests that arrive at the same time', async () => {
    const h = await harness('guard-concurrent', { claude: true, cursor: true });
    try {
      const statuses = (await Promise.all([h.apply([{ provider: 'claude', connectionId: id(41) }]), h.apply([{ provider: 'cursor', connectionId: id(42) }])])).map(response => response.statusCode).sort();
      expect(statuses).toEqual([200, 409]);
      expect(h.api.registry.all()).toHaveLength(1);
    } finally { await h.close(); }
  });
});

describe('an id, a tool or a folder that is not new is never reused', () => {
  it('rejects an upper-case id at the boundary and refuses an id that already belongs to another connection', async () => {
    const h = await harness('guard-ids', { codex: true, claude: true });
    try {
      const { items: [codex] } = await h.connect(['codex']);
      const bridgeFile = join(h.directory, 'observation', 'connections', `${codex.connectionId}.json`);
      expect(existsSync(bridgeFile)).toBe(true);
      const upper = await h.apply([{ provider: 'claude', connectionId: codex.connectionId.toUpperCase() }]);
      expect(upper.statusCode).toBe(400);
      const reused = await h.apply([{ provider: 'claude', connectionId: codex.connectionId }]);
      expect((reused.json() as ToolDetectionApplyResponse).results).toMatchObject([{ provider: 'claude', applied: false }]);
      // Codex's own files, credential and state entry are untouched.
      expect(existsSync(bridgeFile)).toBe(true);
      expect(h.secrets.has(`observation-${codex.connectionId}`)).toBe(true);
      expect(h.store.snapshot().state.observation?.connections).toMatchObject([{ id: codex.connectionId, provider: 'codex' }]);
      expect(existsSync(join(h.repo, '.claude'))).toBe(false);
    } finally { await h.close(); }
  });

  it('does not add a second connection for a tool that is already connected another way', async () => {
    const h = await harness('guard-manual', { claude: true });
    try {
      const manual = await h.post('connections', { provider: 'claude', repoId: 'project-one', label: 'Set up by hand' });
      expect(manual.statusCode).toBe(200);
      const combined = await h.apply([{ provider: 'claude', connectionId: id(51) }]);
      expect(combined.statusCode).toBe(200);
      const [result] = (combined.json() as ToolDetectionApplyResponse).results;
      expect(result.applied).toBe(false); expect(result.error).toContain('already has an active connection');
      expect(existsSync(join(h.repo, '.claude', 'settings.local.json'))).toBe(false);
      expect(h.api.registry.all()).toHaveLength(1);
    } finally { await h.close(); }
  });
});

describe('a failed apply leaves nothing half-connected', () => {
  it('rolls back state, registry, credential and files when the hook file cannot be written, and the same review can be retried', async () => {
    const h = await harness('guard-rollback', { codex: true });
    try {
      const [item] = ((await h.review(['codex'])).json() as ToolDetectionReview).items;
      mkdirSync(join(h.repo, '.codex'));
      writeFileSync(join(h.repo, '.codex', 'hooks.json'), '{');
      const failed = await h.apply([{ provider: 'codex', connectionId: item.connectionId }]);
      expect(failed.statusCode).toBe(200);
      const [result] = (failed.json() as ToolDetectionApplyResponse).results;
      expect(result).toMatchObject({ provider: 'codex', applied: false });
      expect(result.error).toMatch(/invalid/i);
      // No ghost: not in saved state, not in the registry, no credential, no bridge config or spool left behind.
      expect(h.store.snapshot().state.observation?.connections ?? []).toEqual([]);
      expect(h.api.registry.get(item.connectionId)).toBeNull();
      expect(h.secrets.has(`observation-${item.connectionId}`)).toBe(false);
      expect(existsSync(join(h.directory, 'observation', 'connections', `${item.connectionId}.json`))).toBe(false);
      expect(existsSync(join(h.directory, 'observation', 'spool', item.connectionId))).toBe(false);
      expect(existsSync(join(h.directory, 'observation', 'installed', `${item.connectionId}.json`))).toBe(false);
      const status = ((await h.detect()).json() as ToolDetectionSnapshot).tools.find(tool => tool.provider === 'codex');
      expect(status?.state).not.toBe('connected');

      // Once the file is fixed, the very same reviewed id can be applied.
      writeFileSync(join(h.repo, '.codex', 'hooks.json'), '{}');
      const retried = await h.apply([{ provider: 'codex', connectionId: item.connectionId }]);
      expect((retried.json() as ToolDetectionApplyResponse).results).toMatchObject([{ provider: 'codex', applied: true }]);
      expect(JSON.parse(readFileSync(join(h.repo, '.codex', 'hooks.json'), 'utf8')).hooks).toBeDefined();
      expect(h.store.snapshot().state.observation?.connections).toMatchObject([{ id: item.connectionId, provider: 'codex' }]);
      expect(h.api.registry.all()).toHaveLength(1);
    } finally { await h.close(); }
  });

  it('rolls back only the failing tool of a batch and keeps the one that succeeded', async () => {
    const h = await harness('guard-partial', { codex: true, claude: true });
    try {
      const items = ((await h.review(['codex', 'claude'])).json() as ToolDetectionReview).items;
      mkdirSync(join(h.repo, '.codex')); writeFileSync(join(h.repo, '.codex', 'hooks.json'), '{');
      const response = await h.apply(items.map(item => ({ provider: item.provider, connectionId: item.connectionId })));
      const results = (response.json() as ToolDetectionApplyResponse).results;
      expect(results).toMatchObject([{ provider: 'codex', applied: false }, { provider: 'claude', applied: true }]);
      const [codex, claude] = items;
      expect(h.store.snapshot().state.observation?.connections).toMatchObject([{ id: claude.connectionId, provider: 'claude' }]);
      expect(h.api.registry.all().map(record => record.connection.id)).toEqual([claude.connectionId]);
      expect(h.secrets.has(`observation-${claude.connectionId}`)).toBe(true);
      expect(h.secrets.has(`observation-${codex.connectionId}`)).toBe(false);
      expect(existsSync(join(h.directory, 'observation', 'connections', `${claude.connectionId}.json`))).toBe(true);
      expect(existsSync(join(h.directory, 'observation', 'connections', `${codex.connectionId}.json`))).toBe(false);
      // The profile record made along the way is a reusable approval of that folder, not part of a connection.
      expect(h.store.native.sources().map(source => source.provider).sort()).toEqual(['claude', 'codex']);
    } finally { await h.close(); }
  });
});

describe('review explains a conflict with a live connection instead of refusing it (WS2-01)', () => {
  it('returns 200 with a conflict naming the live connection and a working recommended set, never the leftover-hook wording', async () => {
    const h = await harness('review-conflict', { claude: true, copilot: true, codex: true });
    try {
      expect((await h.connect(['claude'])).response.statusCode).toBe(200);
      const reviewed = await h.review(['copilot-cli']);
      expect(reviewed.statusCode).toBe(200);
      const body = reviewed.json() as ToolDetectionReview;
      expect(body.activeProviders).toContain('claude');
      expect(body.items).toEqual([]);
      expect(body.conflicts?.some(conflict => conflict.tool === 'claude' || conflict.blockedBy.includes('claude'))).toBe(true);
      const text = JSON.stringify(body.conflicts);
      expect(text).not.toContain('revoked'); expect(text).not.toContain('remove the hook'); expect(text).not.toContain('HOOK_OVERLAP');
      expect(body.recommendedTools).toBeDefined();
      expect(hookOverlapConflicts(body.recommendedTools!)).toEqual([]);
      // Nothing about Claude Code's own, already-working connection was touched.
      expect(existsSync(join(h.repo, '.claude'))).toBe(true);
    } finally { await h.close(); }
  });

  it('still explains the other direction: reviewing Cursor while Codex and Claude Code are already connected', async () => {
    const h = await harness('review-conflict-reverse', { codex: true, claude: true, cursor: true });
    try {
      expect((await h.connect(['codex', 'claude'])).response.statusCode).toBe(200);
      const preview = await h.review(['cursor']);
      expect(preview.statusCode).toBe(200);
      const body = preview.json() as ToolDetectionReview;
      expect(body.activeProviders).toEqual(expect.arrayContaining(['codex', 'claude']));
      expect(body.items).toEqual([]);
      expect(body.conflicts?.length).toBeGreaterThan(0);
    } finally { await h.close(); }
  });

  it('recommendToolSet never returns a conflicting pair, always keeps the active tools, and is deterministic', () => {
    const all: AutoDetectSurface[] = ['codex', 'claude', 'cursor', 'copilot-cli'];
    const subsets = (list: readonly AutoDetectSurface[]): AutoDetectSurface[][] => list.reduce<AutoDetectSurface[][]>((acc, item) => [...acc, ...acc.map(set => [...set, item])], [[]]);
    for (const installed of subsets(all)) {
      // A real active set is itself conflict-free: every route that could register a connection
      // already refuses a combination that would go silent (WS2-01/WS2-02).
      for (const active of subsets(installed).filter(set => hookOverlapConflicts(set).length === 0)) {
        for (const found of subsets(installed)) {
          const recommended = recommendToolSet(installed, found, active);
          const label = `installed=${installed} active=${active} found=${found}`;
          expect(hookOverlapConflicts(recommended), label).toEqual([]);
          expect(active.every(provider => recommended.includes(provider)), label).toBe(true);
          expect(recommendToolSet(installed, found, active), label).toEqual(recommended);
        }
      }
    }
  });
});

describe('the manual routes never write a hook that would go silent (WS2-02)', () => {
  it('refuses a manual create of Claude Code while Cursor is connected, and writes nothing', async () => {
    const h = await harness('manual-guard-create', { claude: true, cursor: true });
    try {
      expect((await h.connect(['cursor'])).response.statusCode).toBe(200);
      const created = await h.post('connections', { provider: 'claude', repoId: 'project-one', label: 'By hand' });
      expect(created.statusCode).toBe(409);
      expect(created.json().code).toBe('HOOK_OVERLAP');
      expect(created.json().message).toContain('Claude Code would not be able to report if Cursor is connected too');
      expect(h.api.registry.all().map(record => record.connection.provider)).toEqual(['cursor']);
      expect(existsSync(join(h.repo, '.claude'))).toBe(false);
    } finally { await h.close(); }
  });

  it('refuses a manual apply of a connection registered before this guard existed, while a conflicting tool is connected', async () => {
    const h = await harness('manual-guard-apply', { claude: true, cursor: true });
    try {
      expect((await h.connect(['cursor'])).response.statusCode).toBe(200);
      // Simulates a Claude Code connection registered directly (before this guard existed, or by a
      // race the create-time check above closes) — the manual apply route must still catch it.
      const claudeId = id(61);
      h.api.registry.register({ connection: { id: claudeId, provider: 'claude', repoId: 'project-one', label: 'Pre-existing', status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0 }, ownerId: 'owner', workspaceId: 'manual-guard-apply', repoPath: h.repo }, 'a'.repeat(64));
      const applied = await h.post(`connections/${claudeId}/apply`);
      expect(applied.statusCode).toBe(409);
      expect(applied.json().code).toBe('HOOK_OVERLAP');
      expect(existsSync(join(h.repo, '.claude'))).toBe(false);
    } finally { await h.close(); }
  });

  it('a manual create for Claude and a combined apply for Cursor sent together: exactly one succeeds', async () => {
    const h = await harness('manual-guard-race', { claude: true, cursor: true });
    try {
      const [cursorItem] = (await h.review(['cursor'])).json().items as { provider: string; connectionId: string }[];
      const statuses = (await Promise.all([
        h.post('connections', { provider: 'claude', repoId: 'project-one', label: 'By hand' }),
        h.apply([{ provider: cursorItem!.provider, connectionId: cursorItem!.connectionId }]),
      ])).map(response => response.statusCode).sort();
      expect(statuses).toEqual([200, 409]);
      expect(h.api.registry.all()).toHaveLength(1);
    } finally { await h.close(); }
  });
});

describe('review and apply refuse when the tracking helper is not built (WS2-03)', () => {
  afterEach(() => { __setHookBridgePathForTests(null); });

  it('returns 409 BRIDGE_MISSING for review and apply, reports bridge.available in detection, and writes nothing', async () => {
    const h = await harness('bridge-missing', { codex: true });
    try {
      __setHookBridgePathForTests(join(h.directory, 'does-not-exist', 'hook-bridge.cjs'));
      const snapshot = (await h.detect()).json() as ToolDetectionSnapshot;
      expect(snapshot.bridge).toEqual({ available: false });
      const reviewed = await h.review(['codex']);
      expect(reviewed.statusCode).toBe(409); expect(reviewed.json().code).toBe('BRIDGE_MISSING');
      const applied = await h.apply([{ provider: 'codex', connectionId: id(71) }]);
      expect(applied.statusCode).toBe(409); expect(applied.json().code).toBe('BRIDGE_MISSING');
      expect(h.store.snapshot().state.observation?.connections ?? []).toEqual([]);
      expect(h.api.registry.all()).toEqual([]);
      expect(existsSync(join(h.repo, '.codex'))).toBe(false);
    } finally { await h.close(); }
  });

  it('the manual apply route also refuses BRIDGE_MISSING and leaves no hook file', async () => {
    const h = await harness('bridge-missing-manual', { codex: true });
    try {
      const created = await h.post('connections', { provider: 'codex', repoId: 'project-one', label: 'Manual' });
      expect(created.statusCode).toBe(200);
      const connectionId = (created.json() as { connection: { id: string } }).connection.id;
      __setHookBridgePathForTests(join(h.directory, 'missing', 'hook-bridge.cjs'));
      const applied = await h.post(`connections/${connectionId}/apply`);
      expect(applied.statusCode).toBe(409);
      expect(applied.json().code).toBe('BRIDGE_MISSING');
      expect(existsSync(join(h.repo, '.codex'))).toBe(false);
    } finally { await h.close(); }
  });
});

describe('tool detection reports honestly and cheaply', () => {
  it('reports unavailable history as unknown, not zero', async () => {
    const h = await harness('guard-detect', { codex: true });
    try {
      const codex = ((await h.detect()).json() as ToolDetectionSnapshot).tools.find(tool => tool.provider === 'codex')!;
      // The profile folder exists but has no readable session database: unknown count, with the reason.
      expect(codex).toMatchObject({ state: 'no-activity', sessionCount: null, sessionCountExact: false });
      expect(codex.message).toBeTruthy();
    } finally { await h.close(); }
  });

  it('answers a deleted project folder with a clear conflict instead of an internal error', async () => {
    const h = await harness('guard-folder', { codex: true });
    try {
      rmSync(h.repo, { recursive: true, force: true });
      const response = await h.detect();
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('PROJECT_FOLDER_UNAVAILABLE');
    } finally { await h.close(); }
  });
});

describe('what a person does after the hook is written', () => {
  it('names a tool-specific step, and only Codex asks to trust the commands', () => {
    expect(activationStep('codex')).toContain('trust the Agent Town commands');
    for (const provider of ['claude', 'cursor', 'copilot-cli'] as const) expect(activationStep(provider), provider).not.toContain('trust the Agent Town commands');
    expect(activationStep('copilot-cli')).toContain('restart');
    const record = (provider: ToolSurface): RegisteredObservation => ({ connection: { id: id(3), provider, repoId: 'r', label: 'x', status: 'unverified', createdAt: '2026-09-18T00:00:00.000Z', lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0 }, workspaceId: 'w', ownerId: 'o', repoPath: 'C:\\synthetic\\project' });
    const claude = observationSetup(record('claude'), 'C:\\synthetic\\data').instructions.join(' ');
    expect(claude).not.toContain('Reload the native tool and review its hook trust');
    expect(claude).not.toContain('trust the Agent Town commands');
    expect(claude).toContain(activationStep('claude'));
    expect(observationSetup(record('codex'), 'C:\\synthetic\\data').instructions.join(' ')).toContain('trust the Agent Town commands');
  });
});

describe('Copilot callbacks that reuse the Claude hook file are not attributed to Claude Code', () => {
  const config: BridgeConfig = { version: 2, connectionId: id(4), provider: 'claude', repoPath: 'C:\\synthetic\\absent-project', spoolPath: 'C:\\synthetic\\spool' };
  const payload = claudePayload('C:\\synthetic\\absent-project');
  it('blocks the snake_case payload with an ISO timestamp that Copilot CLI and VS Code send', () => {
    expect(resolveHookSource(config, { ...payload, timestamp: '2026-09-18T12:00:00.000Z' })).toMatchObject({ blocked: true, diagnostic: 'producer-mismatch' });
  });
  it('still accepts Claude Code payloads, with or without permission_mode', () => {
    expect(resolveHookSource(config, payload).blocked).toBe(false);
    expect(resolveHookSource(config, { ...payload, permission_mode: 'default' }).blocked).toBe(false);
    expect(resolveHookSource(config, { ...payload, permission_mode: 'default', timestamp: '2026-09-18T12:00:00.000Z' }).blocked).toBe(false);
  });
  it('does not change how other tools are judged', () => {
    const codex: BridgeConfig = { ...config, provider: 'codex', connectionId: id(5) };
    expect(resolveHookSource(codex, { ...payload, timestamp: '2026-09-18T12:00:00.000Z' }).blocked).toBe(false);
  });
  it('tripwire: the fingerprint assumes Claude Code\'s own hook input never carries a timestamp', () => {
    const types = readFileSync(join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.d.ts'), 'utf8');
    const start = types.indexOf('export declare type BaseHookInput = {');
    expect(start).toBeGreaterThan(-1);
    const block = types.slice(start, types.indexOf('\n};', start));
    // If an SDK upgrade adds a timestamp here, looksLikeCopilotClaudeImport in source-binding.ts would start
    // dropping real Claude Code events and must be revisited before upgrading.
    expect(block).toContain('session_id: string');
    expect(block).not.toMatch(/\btimestamp\b/);
  });
});
