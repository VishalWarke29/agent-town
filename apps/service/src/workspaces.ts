import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { reconcileAgentHomes, RETAINED_AGENT_LIMIT, type TownState, type WorkspaceSummary } from '@agent-town/contracts';
import { Store } from './store.js';
import { initialWorkflow } from './workflow/budget.js';
import { markLocalAttemptIncomplete } from './repository-state.js';

export function privateState(workspace: WorkspaceSummary): TownState {
  return {
    schemaVersion: 1,
    workspace: { id: workspace.id, name: workspace.name, mode: 'private' },
    simulation: { running: false, step: 0 },
    repositories: [], agents: [], handoffs: [], activity: [],
    discovery: { roots: [], candidates: [], operation: null },
    workflow: initialWorkflow(),
    manager: { version: 0, brief: 'No reports have been processed. Connect a repository and observation source to begin.', updatedAt: null },
  };
}

/** Ownership is checked before opening a private database, including cache hits. */
export class WorkspaceStores {
  private stores = new Map<string, Store>();
  constructor(private directory: string, private owned: (ownerId: string, id: string) => WorkspaceSummary) {}

  get(ownerId: string, id: string): Store {
    const workspace = this.owned(ownerId, id);
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(workspace.id)) throw new Error('Invalid registered workspace identifier.');
    let store = this.stores.get(id);
    if (!store) {
      store = new Store(join(this.directory, 'workspaces', id, 'town.sqlite'), privateState(workspace));
      const saved = store.snapshot().state;
      // A workspace created before workflow setup was persisted must still
      // expose account and Economy controls. Never replace existing settings.
      if (saved.workflow === undefined) store.commit('private-workflow-initialized:v1', state => {
        state.workflow ??= initialWorkflow();
        return 'workflow.initialized';
      });
      // Repair legacy overlapping homes once, through the same durable event path.
      // Older histories above today's limit remain readable and are not deleted.
      if (saved.agents.length > 0 && saved.agents.length <= RETAINED_AGENT_LIMIT) {
        const placed = reconcileAgentHomes(saved.repositories, saved.agents);
        if (placed.some((agent, index) => agent.home[0] !== saved.agents[index]!.home[0] || agent.home[1] !== saved.agents[index]!.home[1])) {
          store.commit(`placement-recovery:${randomUUID()}`, state => { state.agents = reconcileAgentHomes(state.repositories, state.agents); return 'agents.homes-reconciled'; });
        }
      }
      const operation = store.snapshot().state.discovery?.operation;
      if (operation?.status === 'running') store.commit(`scan-recovery:${randomUUID()}`, (state, now) => {
        Object.assign(state.discovery!.operation!, { status: 'interrupted', coverage: 'partial', finishedAt: now, message: 'The service stopped during discovery. Run a new scan to refresh the saved inventory.' });
        markLocalAttemptIncomplete(state, now, ['scan-interrupted']);
        return 'discovery.interrupted';
      });
      if (store.snapshot().state.telemetry?.inventoryOperation?.status === 'running') store.commit(`inventory-recovery:${randomUUID()}`, (state, now) => {
        Object.assign(state.telemetry!.inventoryOperation!, { status: 'interrupted', finishedAt: now, message: 'The service stopped during API discovery. Scan again to refresh the saved routes.' });
        return 'inventory.interrupted';
      });
      this.stores.set(id, store);
    }
    return store;
  }

  close() { for (const store of this.stores.values()) store.close(); this.stores.clear(); }
}
