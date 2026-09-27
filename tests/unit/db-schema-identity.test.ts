import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/service/src/app';
import { IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity';

// Regression for a real path bug: the /db-schema endpoint originally derived identity's database
// location as dirname(options.database)/app.sqlite, but createDefaultIdentity (index.ts) actually
// creates it at join(privateDirectory, 'app.sqlite') — a distinct directory, not database's own
// parent. That guess silently missed the file in every real deployment, not just in demo mode, so
// the endpoint always fell back to workspace-only data. This uses the exact 'app.sqlite' filename
// createDefaultIdentity uses (private-api.test.ts's own fixture deliberately uses a different name,
// 'identity.sqlite', so it would not have caught this).
describe('database visualizer: identity group location', () => {
  let directory: string;
  let instance: Awaited<ReturnType<typeof createApp>>;

  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'agent-town-db-schema-identity-')); });
  afterEach(async () => {
    await instance?.app.close();
    const target = resolve(directory);
    if (target.startsWith(resolve(tmpdir()) + sep)) rmSync(target, { recursive: true });
  });

  it('finds the identity group at privateDirectory/app.sqlite, not dirname(database)/app.sqlite', async () => {
    let now = Date.now();
    const vault: CredentialVault = { available: true, put: async () => {}, get: async () => null, delete: async () => {} };
    const provider: IdentityProvider = {
      begin: async () => ({ deviceCode: 'd', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
      poll: async () => ({ status: 'authorized', accessToken: 'fixture-secret', expiresIn: 3600 }),
      verifyUser: async () => ({ id: '101', login: 'octocat', displayName: 'Fixture Owner', avatarUrl: null }),
      listRepositories: async () => ({ repositories: [], truncated: false, checkedAt: new Date().toISOString() }),
    };
    // Same filename createDefaultIdentity uses ('app.sqlite'), under privateDirectory — the real
    // production layout — while `database` below points at an entirely unrelated in-memory store,
    // so dirname(database) could not possibly resolve to this directory by accident.
    const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'app.sqlite')), vault, provider, clientId: 'fixture-public-client-id-12', now: () => now });
    instance = await createApp({ database: ':memory:', privateDirectory: directory, identity, vault, simulationInterval: 600000 });

    const host = { host: '127.0.0.1:4310' }, origin = 'http://127.0.0.1:4310';
    const session = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: { ...host, origin } });
    const cookie = session.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf = session.json().csrf;
    const headers = { ...host, origin, cookie, 'x-csrf-token': csrf };

    const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers });
    expect(start.statusCode).toBe(200);
    now += 6000;
    const poll = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', headers, payload: { flowId: start.json().flowId } });
    expect(poll.statusCode).toBe(200); expect(poll.json().status).toBe('authorized');
    const signedInHeaders = { ...host, origin, cookie: poll.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': poll.json().session.csrf };

    const created = await instance.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: signedInHeaders, payload: { name: 'Private workshop', kind: 'personal' } });
    expect(created.statusCode).toBe(200);
    const workspaceId = created.json().workspace.id;

    const schema = await instance.app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/db-schema`, headers: signedInHeaders });
    expect(schema.statusCode).toBe(200);
    const body = schema.json() as { groups: { fileKind: string; tables: { name: string }[]; foreignKeys: { fromTable: string; toTable: string }[] }[] };
    const identityGroup = body.groups.find(group => group.fileKind === 'identity');
    expect(identityGroup, 'identity group missing — the path bug this test guards against').toBeDefined();
    expect(identityGroup!.tables.map(t => t.name).sort()).toEqual(['identity_owners', 'private_workspaces']);
    // The real foreign key this whole "moon orbits its dependency" feature exists to show.
    expect(identityGroup!.foreignKeys).toEqual([{ fromTable: 'private_workspaces', fromColumn: 'owner_id', toTable: 'identity_owners', toColumn: 'id' }]);
  });
});
