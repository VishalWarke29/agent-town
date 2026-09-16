import type { FastifyInstance, FastifyRequest } from 'fastify';
import { archiveAgentSchema, historyQuerySchema } from '@agent-town/contracts';
import { IdentityError } from './identity/types.js';
import { archiveReview } from './history-state.js';
import type { Store } from './store.js';

export function registerHistoryApi(app: FastifyInstance, scoped: (request: FastifyRequest) => Store): void {
  const prefix = '/api/v1/workspaces/:id';
  app.get(`${prefix}/history/agents`, request => {
    const store = scoped(request), query = historyQuerySchema.safeParse(request.query);
    if (!query.success) throw new IdentityError('INVALID_HISTORY_PAGE', 'Choose a valid history page of up to 50 sessions.');
    return store.history(query.data.offset, query.data.limit);
  });
  app.get(`${prefix}/history/agents/:agentId`, request => {
    const store = scoped(request), query = historyQuerySchema.safeParse(request.query);
    if (!query.success) throw new IdentityError('INVALID_HISTORY_PAGE', 'Choose a valid report page of up to 50 reports.');
    return store.historyDetail((request.params as { agentId: string }).agentId, query.data.offset, query.data.limit);
  });
  app.get(`${prefix}/history/repositories/:repoId`, request => scoped(request).repositoryHistory((request.params as { repoId: string }).repoId));
  app.get(`${prefix}/agents/:agentId/reports`, request => {
    const store = scoped(request), query = historyQuerySchema.safeParse(request.query);
    if (!query.success) throw new IdentityError('INVALID_HISTORY_PAGE', 'Choose a valid report page of up to 50 reports.');
    return store.agentReports((request.params as { agentId: string }).agentId, query.data.offset, query.data.limit);
  });
  app.get(`${prefix}/agents/:agentId/archive`, request => {
    const state = scoped(request).snapshot().state;
    const agent = state.agents.find(agent => agent.id === (request.params as { agentId: string }).agentId);
    if (!agent) throw new IdentityError('AGENT_NOT_FOUND', 'This live session is no longer available.', 404);
    return archiveReview(state, agent);
  });
  app.post(`${prefix}/agents/:agentId/archive`, request => {
    const store = scoped(request), body = archiveAgentSchema.safeParse(request.body);
    if (!body.success) throw new IdentityError('ARCHIVE_REVIEW_REQUIRED', 'Review this session before archiving it.');
    return store.archiveAgent((request.params as { agentId: string }).agentId, body.data.reviewToken);
  });
}
