import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { privateState, WorkspaceStores } from '../../apps/service/src/workspaces';
import { Store } from '../../apps/service/src/store';
import type { WorkspaceSummary } from '@agent-town/contracts';

const workspace: WorkspaceSummary = { id: 'workspace-initialization', name: 'Private workshop', kind: 'personal' };
const directories: string[] = [];
const stores: { close(): void }[] = [];
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'agent-town-workspace-init-')); directories.push(value); return value; };
const owned = (owner: string, id: string) => { if (owner !== 'owner-one' || id !== workspace.id) throw new Error('Not owned'); return workspace; };
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const value of directories.splice(0)) {
    const full = resolve(value);
    if (!full.startsWith(resolve(tmpdir()) + sep) || !full.includes('agent-town-workspace-init-')) throw new Error('Unsafe test cleanup');
    rmSync(full, { recursive: true, force: true });
  }
});

describe('private workspace initialization', () => {
  it('creates usable disabled workflow state with no accounts or paid work', () => {
    const state = privateState(workspace);
    expect(state.workflow).toMatchObject({ schemaVersion: 1, connections: [], defaults: {}, reservations: [], policy: { paidEnabled: false, dailyBudgetMicroUsd: 0, workerConcurrency: 1 }, manager: { config: { enabled: false, connectionId: null, model: null }, jobs: [], queueReportIds: [] } });
    expect(state.repositories).toEqual([]);
    expect(state.agents).toEqual([]);
    state.workflow!.policy.workerConcurrency = 2;
    expect(privateState(workspace).workflow!.policy.workerConcurrency).toBe(1);
  });

  it('durably repairs a legacy empty workspace once without altering its existing records', () => {
    const path = directory();
    const legacy = privateState(workspace); delete legacy.workflow;
    legacy.manager.brief = 'Existing saved brief';
    const old = new Store(join(path, 'workspaces', workspace.id, 'town.sqlite'), legacy); old.close();
    const first = new WorkspaceStores(path, owned);
    const migrated = first.get('owner-one', workspace.id).snapshot();
    expect(migrated.state.workflow!.policy.paidEnabled).toBe(false);
    expect(migrated.state.manager.brief).toBe('Existing saved brief');
    expect(migrated.cursor).toBe(1);
    first.close();
    const reopened = new WorkspaceStores(path, owned); stores.push(reopened);
    expect(reopened.get('owner-one', workspace.id).snapshot()).toEqual(migrated);
    expect(() => reopened.get('another-owner', workspace.id)).toThrow('Not owned');
  });

  it('preserves existing workflow settings and creates no initialization event', () => {
    const path = directory(); const seed = privateState(workspace);
    seed.workflow!.policy.dailyBudgetMicroUsd = 5_000_000;
    seed.workflow!.policy.workerConcurrency = 2;
    seed.workflow!.manager.config.maxOutputTokens = 1000;
    const old = new Store(join(path, 'workspaces', workspace.id, 'town.sqlite'), seed); old.close();
    const opened = new WorkspaceStores(path, owned); stores.push(opened);
    const current = opened.get('owner-one', workspace.id).snapshot();
    expect(current.cursor).toBe(0);
    expect(current.state.workflow).toEqual(seed.workflow);
  });
});
