import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { vaultBackupSchema, vaultEnableSchema, vaultRestorePreviewSchema, vaultRestoreSchema, vaultScanSchema } from '@agent-town/contracts';
import type { Store } from './store.js';
import { IdentityError } from './identity/types.js';
import { VaultService } from './vault/service.js';

interface Dependencies { scoped(request: FastifyRequest): Store }

export function registerVaultApi(app: FastifyInstance, dependencies: Dependencies) {
  const service = new VaultService();
  const source = (request: FastifyRequest) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(key)) throw new IdentityError('IDEMPOTENCY_REQUIRED', 'Provide a unique action identifier.');
    return `vault:${key}`;
  };
  const parsed = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const result = schema.safeParse(body);
    if (!result.success) throw new IdentityError('INVALID_VAULT_REQUEST', 'Check the request and try again.');
    return result.data;
  };
  const id = (request: FastifyRequest, name: string) => (request.params as Record<string, string>)[name]!;
  const prefix = '/api/v1/workspaces/:id';

  app.get(`${prefix}/vault`, request => service.status(dependencies.scoped(request)));
  app.post(`${prefix}/vault/enable`, request => service.enable(dependencies.scoped(request), parsed(vaultEnableSchema, request.body).directory, source(request)));
  app.post(`${prefix}/vault/scan`, request => service.scan(dependencies.scoped(request), parsed(vaultScanSchema, request.body).repoId));
  app.post(`${prefix}/vault/backup`, request => {
    const input = parsed(vaultBackupSchema, request.body);
    return service.backup(dependencies.scoped(request), input.repoId, input.paths, input.passphrase, source(request));
  });
  app.get(`${prefix}/vault/backups`, request => service.listBackups(dependencies.scoped(request)));
  app.post(`${prefix}/vault/backups/:repoId/restore-preview`, request => {
    const input = parsed(vaultRestorePreviewSchema, request.body);
    return service.restorePreview(dependencies.scoped(request), id(request, 'repoId'), input.passphrase, input.destinationDirectory, source(request));
  });
  app.post(`${prefix}/vault/backups/:repoId/restore`, request => {
    const input = parsed(vaultRestoreSchema, request.body);
    return service.restore(dependencies.scoped(request), id(request, 'repoId'), input.operationId, input.passphrase, source(request));
  });
  app.get(`${prefix}/vault/backups/:repoId/restore-operations`, request => service.restoreOperations(dependencies.scoped(request), id(request, 'repoId')));
}
