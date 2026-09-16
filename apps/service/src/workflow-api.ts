import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiConnectionInput, EconomyPolicy, ManagerConfig, WorkflowUsage } from '@agent-town/contracts';
import type { Store } from './store.js';
import { IdentityError, type CredentialVault } from './identity/index.js';
import { WorkflowService } from './workflow/service.js';
import type { WorkflowProvider } from './workflow/provider.js';
import { WorkflowError } from './workflow/budget.js';
import { buildCoordinationPlan } from './workflow/coordination.js';

interface Dependencies { scoped(request: FastifyRequest): Store; stores(): Store[]; vault: CredentialVault; provider?: WorkflowProvider }

export function registerWorkflowApi(app: FastifyInstance, dependencies: Dependencies) {
  const services = new Map<Store, WorkflowService>();
  const active = new Set<Promise<unknown>>();
  let closing = false;
  const service = (store: Store) => {
    if (closing) throw new WorkflowError('SERVICE_STOPPING', 'The service is shutting down.', 503);
    let instance = services.get(store);
    if (!instance) {
      instance = new WorkflowService({ store, vault: dependencies.vault, provider: dependencies.provider });
      instance.recoverInterrupted(); services.set(store, instance);
    }
    return instance;
  };
  const scoped = (request: FastifyRequest) => service(dependencies.scoped(request));
  const source = (request: FastifyRequest) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(key)) throw new IdentityError('IDEMPOTENCY_REQUIRED', 'Provide a unique action identifier.');
    return `workflow:${key}`;
  };
  const track = <T>(promise: Promise<T>): Promise<T> => { active.add(promise); void promise.then(() => active.delete(promise), () => active.delete(promise)); return promise; };
  const id = (request: FastifyRequest, key: string) => String((request.params as Record<string, string>)[key]);
  const prefix = '/api/v1/workspaces/:id';

  app.get(`${prefix}/connections`, async request => ({ connections: scoped(request).state().connections }));
  app.post(`${prefix}/connections`, request => track(scoped(request).connectApi(request.body as ApiConnectionInput, source(request))));
  app.post(`${prefix}/connections/:connectionId/disconnect`, request => track(scoped(request).disconnect(id(request, 'connectionId'), source(request))));
  app.post(`${prefix}/connections/:connectionId/default`, async request => scoped(request).setDefault(id(request, 'connectionId'), source(request)));
  app.get(`${prefix}/cost-policy`, async request => ({ policy: scoped(request).state().policy }));
  app.patch(`${prefix}/cost-policy`, async request => scoped(request).configurePolicy(request.body as EconomyPolicy, source(request)));
  app.patch(`${prefix}/manager/config`, async request => scoped(request).configureManager(request.body as ManagerConfig, source(request)));
  app.post(`${prefix}/manager/process`, request => track(scoped(request).processManager(source(request))));
  app.get(`${prefix}/manager/status`, async request => scoped(request).queueStatus());
  app.get(`${prefix}/usage`, async request => ({ reservations: scoped(request).state().reservations }));
  app.post(`${prefix}/usage/:reservationId/reconcile`, async request => scoped(request).reconcile(id(request, 'reservationId'), request.body as WorkflowUsage, source(request)));
  app.get(`${prefix}/context`, async request => scoped(request).contextHistory());
  app.post(`${prefix}/context/memory`, async request => scoped(request).updateMemory(request.body, source(request)));
  app.get(`${prefix}/handoffs`, async request => ({ handoffs: dependencies.scoped(request).snapshot().state.handoffs }));
  app.get(`${prefix}/coordination`, async request => buildCoordinationPlan(dependencies.scoped(request).snapshot().state));

  // Background processing depends on saved enablement, queue age and budget gates, never panel visibility.
  const timer = setInterval(() => {
    if (closing) return;
    try { for (const store of dependencies.stores()) {
      try {
        const manager = service(store);
        manager.refreshQueueStatus();
        if (!manager.state().manager.config.enabled) continue;
        void track(manager.processManager(`manager-auto:${randomUUID()}`, { automatic: true })).catch(error => {
          if (!(error instanceof WorkflowError)) app.log.error('Manager processing stopped; inspect its saved operation state.');
        });
      } catch { app.log.error('Manager scheduling could not read this workspace. Saved jobs remain available.'); }
    } } catch { app.log.error('Manager scheduling could not read the local registry.'); }
  }, 30000); timer.unref();

  return { service, close: async () => { closing = true; clearInterval(timer); for (const instance of services.values()) instance.close(); await Promise.allSettled([...active]); } };
}
