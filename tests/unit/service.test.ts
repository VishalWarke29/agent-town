import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/service/src/app';

const origin = 'http://127.0.0.1:4310';
const base = '/api/v1/workspaces/demo-town';
let instance: Awaited<ReturnType<typeof createApp>>;
let cookie: string;
let csrf: string;
const host = { host: '127.0.0.1:4310' };
beforeEach(async () => {
  instance = await createApp({ database: ':memory:', simulationInterval: 600000 });
  const session = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: { ...host, origin } });
  expect(session.statusCode).toBe(200);
  cookie = session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  csrf = session.json().csrf;
});
afterEach(async () => { await instance.app.close(); });
const headers = () => ({ ...host, origin, cookie, 'x-csrf-token': csrf, 'idempotency-key': 'test-command-0001' });

describe('local service boundaries', () => {
  it('trusts exactly the configured development origin and never enables it in production', async () => {
    const webOrigin = 'http://127.0.0.1:5417';
    for (const mode of ['development', 'production'] as const) {
      const custom = await createApp({ database: ':memory:', development: true, developmentWebPort: 5417, mode });
      try {
        const result = await custom.app.inject({ method: 'POST', url: '/api/v1/session', headers: { ...host, origin: webOrigin } });
        expect(result.statusCode).toBe(mode === 'development' ? 200 : 403);
        for (const denied of ['http://127.0.0.1:5173', 'http://localhost:5417', 'http://127.0.0.1:5418']) {
          expect((await custom.app.inject({ method: 'POST', url: '/api/v1/session', headers: { ...host, origin: denied } })).statusCode).toBe(403);
        }
        if (mode === 'development') {
          const sessionCookie = result.cookies.map(c => `${c.name}=${c.value}`).join('; ');
          const write = await custom.app.inject({ method: 'POST', url: `${base}/demo/commands`, headers: { ...host, origin: webOrigin, cookie: sessionCookie }, payload: { action: 'play' } });
          expect(write.statusCode).toBe(403); expect(custom.store.snapshot().cursor).toBe(0);
        }
      } finally { await custom.app.close(); }
    }
    await expect(createApp({ database: ':memory:', developmentWebPort: 80 })).rejects.toThrow('development web port');
  });

  it('requires a preview session and rejects unknown workspaces', async () => {
    expect((await instance.app.inject({ url: `${base}/snapshot`, headers: host })).statusCode).toBe(401);
    expect((await instance.app.inject({ url: '/api/v1/workspaces/private-id/snapshot', headers: { ...host, cookie } })).statusCode).toBe(404);
  });

  it.each([
    { origin: 'https://malicious.example' },
    { host: 'malicious.example:4310' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: undefined },
    { 'x-csrf-token': 'invalid' },
  ])('blocks untrusted browser writes: %j', async override => {
    const requestHeaders = Object.fromEntries(Object.entries({ ...headers(), ...override }).filter(([, value]) => value !== undefined));
    const response = await instance.app.inject({ method: 'POST', url: `${base}/demo/commands`, headers: requestHeaders, payload: { action: 'play' } });
    expect(response.statusCode).toBe(403);
    expect(instance.store.snapshot().cursor).toBe(0);
  });

  it('uses HttpOnly, SameSite cookies with a bounded lifetime', async () => {
    const response = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: { ...host, origin } });
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Strict');
    expect(response.headers['set-cookie']).toContain('Max-Age=28800');
  });

  it('validates input and refuses duplicate report actions with a different key', async () => {
    const invalid = await instance.app.inject({ method: 'POST', url: `${base}/demo/commands`, headers: headers(), payload: { action: 'launch', apiKey: 'not-a-credential' } });
    expect(invalid.statusCode).toBe(400);
    const first = await instance.app.inject({ method: 'POST', url: `${base}/demo/commands`, headers: headers(), payload: { action: 'handoff', agentId: 'milo' } });
    expect(first.statusCode).toBe(200);
    const duplicate = await instance.app.inject({ method: 'POST', url: `${base}/demo/commands`, headers: headers(), payload: { action: 'handoff', agentId: 'milo' } });
    expect(duplicate.json().duplicate).toBe(true);
    const conflict = await instance.app.inject({ method: 'POST', url: `${base}/demo/commands`, headers: { ...headers(), 'idempotency-key': 'different-key-0001' }, payload: { action: 'handoff', agentId: 'milo' } });
    expect(conflict.statusCode).toBe(409);
    expect(instance.store.snapshot().state.handoffs).toHaveLength(1);
  });

  it('rejects invalid stream cursors and oversized bodies without mutating state', async () => {
    const bad = await instance.app.inject({ url: `${base}/events?after=-1`, headers: headers() });
    expect(bad.statusCode).toBe(400);
    const large = await instance.app.inject({ method: 'POST', url: `${base}/demo/commands`, headers: headers(), payload: { action: 'play', garbage: 'a'.repeat(17000) } });
    expect(large.statusCode).toBe(413);
    expect(instance.store.snapshot().cursor).toBe(0);
  });
  it('reports unsupported form bodies as a useful 415 without saving or exposing their contents', async () => {
    const result = await instance.app.inject({ method: 'POST', url: `${base}/demo/commands`, headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded' }, payload: 'private=fixture-private-value' });
    expect(result.statusCode).toBe(415); expect(result.json().code).toBe('UNSUPPORTED_CONTENT_TYPE');
    expect(result.body).not.toContain('fixture-private-value'); expect(instance.store.snapshot().cursor).toBe(0);
  });

  it('replays committed events and continues with live SSE updates', async () => {
    instance.store.commit('before-connect', state => { state.simulation.running = true; return 'demo.play'; });
    await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const address = instance.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const received = await new Promise<string>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: address.port, path: `${base}/events?after=0`, headers: { ...host, cookie } }, response => {
        let body = '';
        let emitted = false;
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
          if (!emitted && body.includes('id: 1\n')) { emitted = true; instance.store.commit('after-connect', () => 'demo.pause'); }
          if (body.includes('id: 2\n')) { request.destroy(); resolve(body); }
        });
      });
      request.on('error', reject); request.setTimeout(3000, () => { request.destroy(); reject(new Error('SSE timeout')); }); request.end();
    });
    expect(received).toContain('event: state');
    expect(received.indexOf('id: 1')).toBeLessThan(received.indexOf('id: 2'));
  });
});
