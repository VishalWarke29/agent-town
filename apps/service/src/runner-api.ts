import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { approveRunSchema, createRunDraftSchema, reviewRunSchema, runToolSchema } from '@agent-town/contracts';
import type { Store } from './store.js';
import { IdentityError, type CredentialVault } from './identity/index.js';
import { WorkflowError } from './workflow/budget.js';
import { RunnerService } from './runner/service.js';
import type { RunExecutor } from './runner/types.js';

interface Dependencies { directory: string; scoped(request: FastifyRequest): Store; stores(): Store[]; vault: CredentialVault; executor?: RunExecutor }

export function registerRunnerApi(app: FastifyInstance, dependencies: Dependencies) {
  const services = new Map<Store, RunnerService>();
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  const service = (store: Store) => {
    if (closing) throw new WorkflowError('SERVICE_STOPPING', 'The service is shutting down.', 503);
    let instance = services.get(store);
    if (!instance) {
      instance = new RunnerService({ store, vault: dependencies.vault, dataDirectory: dependencies.directory, executor: dependencies.executor });
      instance.recoverInterrupted(); services.set(store, instance);
    }
    return instance;
  };
  const scoped = (request: FastifyRequest) => service(dependencies.scoped(request));
  const source = (request: FastifyRequest) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(key)) throw new IdentityError('IDEMPOTENCY_REQUIRED', 'Provide a unique action identifier.');
    return `runner:${key}`;
  };
  const track = <T>(promise: Promise<T>) => { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; };
  const id = (request: FastifyRequest, name: string) => (request.params as Record<string, string>)[name]!;
  const preflight = z.object({ tool: runToolSchema, repoId: z.string().min(1).max(100).optional() }).strict();
  const subscription = z.object({ label: z.string().trim().min(1).max(80) }).strict();
  const parsed = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const result = schema.safeParse(body);
    if (!result.success) throw new IdentityError('INVALID_RUN_REQUEST', 'Check the task, account, model, and execution limits.');
    return result.data;
  };
  const prefix = '/api/v1/workspaces/:id';
  app.get(`${prefix}/runner`, async request => scoped(request).status());
  app.get(`${prefix}/tasks/:taskId/evidence`, request => {
    const query = parsed(z.object({ file: z.string().min(1).max(500) }).strict(), request.query);
    return track(scoped(request).evidence(id(request, 'taskId'), query.file));
  });
  app.post(`${prefix}/runner/preflight`, request => { const input = parsed(preflight, request.body); return track(scoped(request).preflight(input.tool, input.repoId)); });
  app.post(`${prefix}/tasks`, request => track(scoped(request).createDraft(parsed(createRunDraftSchema, request.body), source(request))));
  app.post(`${prefix}/tasks/:taskId/approve`, request => track(scoped(request).approve(id(request, 'taskId'), parsed(approveRunSchema, request.body).approvalHash, source(request))));
  app.post(`${prefix}/runs/:runId/cancel`, request => track(scoped(request).cancel(id(request, 'runId'), source(request))));
  app.post(`${prefix}/tasks/:taskId/review`, async request => scoped(request).review(id(request, 'taskId'), parsed(reviewRunSchema, request.body).decision, source(request)));
  app.post(`${prefix}/tasks/:taskId/archive`, async request => scoped(request).archive(id(request, 'taskId'), source(request)));
  app.post(`${prefix}/tasks/:taskId/integration/verify`, request => track(scoped(request).verifyIntegration(id(request, 'taskId'), source(request))));
  app.post(`${prefix}/subscriptions`, request => track(scoped(request).connectSubscription(parsed(subscription, request.body).label, source(request))));
  app.get(`${prefix}/subscriptions/:connectionId`, request => track(scoped(request).subscriptionStatus(id(request, 'connectionId'))));
  app.post(`${prefix}/subscriptions/:connectionId/disconnect`, request => track(scoped(request).disconnectSubscription(id(request, 'connectionId'), source(request))));
  app.post(`${prefix}/subscriptions/:connectionId/default`, async request => scoped(request).setSubscriptionDefault(id(request, 'connectionId'), source(request)));
  // Restore saved run state before the server accepts requests. Restart never launches work.
  app.addHook('onReady', async () => { for (const store of dependencies.stores()) if (store.snapshot().state.runner) service(store); });
  return { close: async () => { closing = true; await Promise.allSettled([...services.values()].map(instance => instance.close())); await Promise.allSettled([...pending]); } };
}
