import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolDetectionApplyResponse, ToolDetectionReview, ToolDetectionSnapshot } from '@agent-town/contracts';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { registerObservationApi } from '../../apps/service/src/observation/service';
import { IdentityError } from '../../apps/service/src/identity/types';

const scans = vi.hoisted(() => [] as string[]);
// A single shared gate lets a test hold one tool's discovery open indefinitely (simulating a slow
// native session read) so a request can be caught genuinely "in flight" while another route commits
// a connection change; releasing it lets every waiting call resolve at once.
const gate = vi.hoisted(() => ({ promise: null as Promise<void> | null, resolve: null as (() => void) | null }));
vi.mock('../../apps/service/src/native-discovery/index', () => ({
  discoverNativeSessions: async (input: { provider: string }) => {
    scans.push(input.provider);
    if (gate.promise) await gate.promise;
    return { sessions: [], nextCursor: null, status: 'available', message: null };
  },
}));

const profileVariables = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'COPILOT_HOME'] as const;
const saved = Object.fromEntries(profileVariables.map(name => [name, process.env[name]]));
afterEach(() => {
  scans.length = 0; gate.promise = null; gate.resolve = null;
  for (const name of profileVariables) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
});

/** A real service around an in-memory store, with each tool's profile folder present or absent. */
async function harness(workspace: string, present: Partial<Record<'codex' | 'claude' | 'cursor' | 'copilot', boolean>>) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-tool-detection-'));
  const repo = join(directory, 'repo'); mkdirSync(repo);
  const home = (name: keyof typeof present) => { const path = join(directory, `${name}-profile`); if (present[name]) mkdirSync(path); return path; };
  process.env.CODEX_HOME = home('codex'); process.env.CLAUDE_CONFIG_DIR = home('claude'); process.env.COPILOT_HOME = home('copilot'); process.env.CURSOR_CONFIG_DIR = home('cursor');
  const state = privateState({ id: workspace, name: 'Fixture', kind: 'personal' });
  state.discovery!.roots = [repo];
  state.repositories = [{ id: 'project-one', name: 'Project', source: 'local', localPath: repo, description: '', branch: 'Unavailable', language: '', color: '#888888', position: [0, 0] }];
  const store = new Store(':memory:', state), app = Fastify(), secrets = new Map<string, string>();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ code: error instanceof IdentityError ? error.code : 'INTERNAL', message: error instanceof Error ? error.message : 'Request failed' }));
  const api = registerObservationApi(app, { directory, vault: { available: true, async put(id, value) { secrets.set(id, value); }, async get(id) { return secrets.get(id) ?? null; }, async delete(id) { secrets.delete(id); } },
    scoped: () => ({ ownerId: 'owner', store }), workspace: () => store });
  const base = `/api/v1/workspaces/${workspace}/observation`, prefix = `${base}/tool-detection`;
  const detect = () => app.inject({ method: 'GET', url: `${prefix}?repoId=project-one` });
  const review = (providers: string[]) => app.inject({ method: 'POST', url: `${prefix}/review`, payload: { repoId: 'project-one', providers } });
  const apply = (items: { provider: string; connectionId: string }[]) => app.inject({ method: 'POST', url: `${prefix}/apply`, payload: { repoId: 'project-one', items } });
  const connect = async (providers: string[]) => {
    const items = ((await review(providers)).json() as ToolDetectionReview).items;
    return apply(items.map(item => ({ provider: item.provider, connectionId: item.connectionId })));
  };
  const post = (path: string, payload?: unknown) => app.inject({ method: 'POST', url: `${base}/${path}`, ...(payload ? { payload } : {}) });
  const close = async () => {
    await api.close(); await app.close(); store.close();
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-tool-detection-`)) throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  };
  return { directory, repo, store, api, detect, review, apply, connect, post, close };
}
const statusFor = (snapshot: ToolDetectionSnapshot, provider: string) => snapshot.tools.find(tool => tool.provider === provider);

describe('tool detection shares one check per project', () => {
  it('runs each tool\'s discovery once for concurrent requests, and again for a later one', async () => {
    const h = await harness('coalescing-workspace', { codex: true, claude: true });
    try {
      // A real, if short, delay: fast enough for a unit test, slow enough that three requests fired
      // back to back all reach the shared cache before the first discovery resolves.
      gate.promise = new Promise(resolve => setTimeout(resolve, 150));
      const responses = await Promise.all([h.detect(), h.detect(), h.detect()]);
      expect(responses.map(response => response.statusCode)).toEqual([200, 200, 200]);
      expect(responses[1]!.json()).toEqual(responses[0]!.json());
      expect((responses[0]!.json() as ToolDetectionSnapshot).tools.map(tool => tool.state)).toEqual(['no-activity', 'no-activity', 'not-installed', 'not-installed']);
      // Two installed tools, three callers: two discoveries in total, not six.
      expect(scans.slice().sort()).toEqual(['claude', 'codex']);
      // Nothing is cached once the check has finished.
      expect((await h.detect()).statusCode).toBe(200);
      expect(scans).toHaveLength(4);
    } finally { await h.close(); }
  });

  it('a request that starts after an apply completed mid-flight shows the tool as connected (WS2-06)', async () => {
    // Only codex needs discovery here: claude/cursor/copilot are simply "not installed", which never
    // touches the shared cache, so nothing but codex's own discovery can hold a request open.
    const h = await harness('coalescing-apply', { codex: true });
    try {
      gate.promise = new Promise(resolve => { gate.resolve = resolve; });
      const pending = h.detect(); // starts codex's discovery, which now hangs on the gate
      // Fastify's own request dispatch is itself asynchronous: wait until codex's discovery has
      // actually been entered (proving `pending` already decided codex was not yet connected) before
      // letting the apply run, otherwise the two could execute in either order.
      await vi.waitFor(() => { if (!scans.includes('codex')) throw new Error('codex discovery has not started yet'); });
      const connected = await h.connect(['codex']);
      expect(connected.statusCode).toBe(200);
      expect((connected.json() as ToolDetectionApplyResponse).results).toMatchObject([{ provider: 'codex', applied: true }]);
      // A later request, issued after the apply finished, must see the fresh registry — never the
      // still-pending discovery `pending` kicked off before the apply existed.
      const second = (await h.detect()).json() as ToolDetectionSnapshot;
      expect(statusFor(second, 'codex')).toMatchObject({ state: 'connected' });
      gate.resolve?.();
      await pending; // let the original request settle so the harness can close cleanly
    } finally { await h.close(); }
  });

  it('a revoke that finishes mid-flight is reflected by a later request (WS2-06)', async () => {
    const h = await harness('coalescing-revoke', { codex: true, claude: true });
    try {
      const connected = await h.connect(['codex']);
      const [codexItem] = (connected.json() as ToolDetectionApplyResponse).results;
      expect(codexItem!.applied).toBe(true);
      let release = () => {};
      gate.promise = new Promise(resolve => { release = resolve; });
      // claude is installed but never connected, so its discovery is what keeps this request pending;
      // codex's own status is read fresh and does not depend on the gate at all.
      const pending = h.detect();
      // Wait until claude's discovery has actually been entered, proving `pending` already captured
      // its (pre-revoke) view of codex before the revoke below runs.
      await vi.waitFor(() => { if (!scans.includes('claude')) throw new Error('claude discovery has not started yet'); });
      await h.post(`connections/${codexItem!.connectionId}/revoke`);
      const second = h.detect();
      release();
      const [pendingSnapshot, secondSnapshot] = (await Promise.all([pending, second])).map(response => response.json() as ToolDetectionSnapshot);
      // The request that started before the revoke may still show its own early view of codex...
      expect(statusFor(pendingSnapshot, 'codex')).toMatchObject({ state: 'connected' });
      // ...but a request answered after the revoke never claims the connection is still active,
      // regardless of another tool's still-pending, shared discovery in the same moment.
      expect(statusFor(secondSnapshot, 'codex')?.state).not.toBe('connected');
    } finally { await h.close(); }
  });
});
