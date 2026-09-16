import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/service/src/app';
import type { IdentityService } from '../../apps/service/src/identity';

const origin = 'http://127.0.0.1:4310';
const headers = { host: '127.0.0.1:4310', origin };

describe('application mode boundaries', () => {
  it('keeps browser sessions distinct between local environments and ports', async () => {
    const dev = await createApp({ database: ':memory:', mode: 'development', port: 4310 });
    const demo = await createApp({ database: ':memory:', mode: 'demo', port: 4312 });
    try {
      const first = await dev.app.inject({ method: 'POST', url: '/api/v1/session', headers });
      const second = await demo.app.inject({ method: 'POST', url: '/api/v1/session', headers: { host: '127.0.0.1:4312', origin: 'http://127.0.0.1:4312' } });
      expect(first.cookies[0]!.name).not.toBe(second.cookies[0]!.name);
      const cookie = [...first.cookies, ...second.cookies].map(c => `${c.name}=${c.value}`).join('; ');
      const resumed = await dev.app.inject({ method: 'POST', url: '/api/v1/session', headers: { ...headers, cookie } });
      expect(resumed.json().csrf).toBe(first.json().csrf);
    } finally { await dev.app.close(); await demo.app.close(); }
  });

  it('opens sample data in demo and blocks identity, real sources and paid work before touching private services', async () => {
    const identity = new Proxy({} as IdentityService, { get() { throw new Error('Demo accessed private identity'); } });
    const { app, store } = await createApp({ database: ':memory:', mode: 'demo', identity, privateDirectory: 'unused-demo-private', simulationInterval: 600000 });
    try {
      const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/session', headers });
      expect(bootstrap.json()).toMatchObject({ applicationMode: 'demo', user: null, workspaces: [], identity: { configured: false } });
      const authorized = { ...headers, cookie: bootstrap.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': bootstrap.json().csrf, 'idempotency-key': 'demo-mode-command' };
      const snapshot = await app.inject({ url: '/api/v1/workspaces/demo-town/snapshot', headers: authorized });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json().state.agents.length).toBeGreaterThan(0);
      const command = await app.inject({ method: 'POST', url: '/api/v1/workspaces/demo-town/demo/commands', headers: authorized, payload: { action: 'handoff', agentId: 'milo' } });
      expect(command.statusCode).toBe(200);
      expect(store.snapshot().state.handoffs).toHaveLength(1);
      for (const url of ['/api/v1/auth/github/device/start', '/api/v1/workspaces', '/api/v1/workspaces/private-fixture/tasks', '/api/v1/workspaces/private-fixture/manager/process', '/api/v1/workspaces/private-fixture/repositories/roots', '/ingest/v1/events', '/ingest/otlp/v1/traces']) {
        const response = await app.inject({ method: 'POST', url, headers: authorized, payload: {} });
        expect(response.statusCode, url).toBe(403);
        expect(response.json().code).toBe('DEMO_ONLY');
      }
      expect(store.snapshot().state.workflow).toBeUndefined();
    } finally { await app.close(); }
  });

  it('keeps production local, rejects sample access including encoded IDs, and exposes its mode', async () => {
    const { app } = await createApp({ database: ':memory:', mode: 'production', development: true });
    try {
      const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/session', headers });
      expect(bootstrap.json().applicationMode).toBe('production');
      const authorized = { ...headers, cookie: bootstrap.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': bootstrap.json().csrf };
      for (const id of ['demo-town', 'demo%2Dtown']) {
        const result = await app.inject({ url: `/api/v1/workspaces/${id}/snapshot`, headers: authorized });
        expect(result.statusCode).toBe(403);
        expect(result.json().code).toBe('PREVIEW_DISABLED');
      }
      expect((await app.inject({ method: 'POST', url: '/api/v1/session', headers: { ...headers, origin: 'http://127.0.0.1:5173' } })).statusCode).toBe(403);
      const health = await app.inject({ url: '/api/v1/health', headers });
      expect(health.json()).toMatchObject({ mode: 'local', applicationMode: 'production', hostedDeploymentReady: false, paidWorkEnabledByDefault: false });
    } finally { await app.close(); }
  });
});
