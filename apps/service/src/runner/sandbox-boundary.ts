import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isWithin, checkedPath } from '../discovery/paths.js';
import { WorkflowError } from '../workflow/index.js';
import { minimalEnvironment, resolveExecutable } from './rpc.js';

const execute = promisify(execFile);
const capabilityCache = new Map<string, Promise<boolean>>();

export function runtimeReadableRoots(): string[] {
  return [...new Set([dirname(process.execPath), ...(process.env.SystemRoot ? [join(process.env.SystemRoot, 'System32')] : [])])];
}

export function requireRuntimeSeparation(path: string): void {
  if (runtimeReadableRoots().some(root => isWithin(root, resolve(path)) || isWithin(resolve(path), root))) throw new WorkflowError('runtime_scope_overlap', 'Repositories and private execution data must stay separate from the permitted system runtime folders.', 503);
}

/** Unknown JSON fields are not evidence that the native process enforces them. */
export function supportsRestrictedReads(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const definitions = (schema as { definitions?: Record<string, unknown> }).definitions;
  const policy = definitions?.SandboxPolicy as { anyOf?: unknown[] } | undefined;
  const workspace = policy?.anyOf?.find(item => {
    const properties = (item as { properties?: Record<string, { enum?: unknown[] }> })?.properties;
    return properties?.type?.enum?.includes('workspaceWrite');
  }) as { properties?: Record<string, unknown> } | undefined;
  if (!workspace?.properties?.readOnlyAccess) return false;
  const serialized = JSON.stringify(schema);
  return serialized.includes('"readableRoots"') && serialized.includes('"restricted"') && serialized.includes('"includePlatformDefaults"');
}

export async function requireRestrictedReadProtocol(dataDirectory: string): Promise<void> {
  const executable = await resolveExecutable('codex');
  if (!executable) throw new WorkflowError('codex_missing', 'Install Codex or set AGENT_TOWN_CODEX_EXECUTABLE to its absolute executable path.', 503);
  const info = await lstat(executable), key = `${executable}:${info.size}:${info.mtimeMs}`;
  let check = capabilityCache.get(key);
  if (!check) {
    check = (async () => {
      const root = resolve(dataDirectory);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await checkedPath(root, [root]);
      const temporary = await mkdtemp(join(root, 'sandbox-protocol-'));
      try {
        const home = join(temporary, 'home'), schemas = join(temporary, 'schemas');
        await mkdir(home, { mode: 0o700 });
        await execute(executable, ['app-server', 'generate-json-schema', '--out', schemas], { cwd: home, windowsHide: true, timeout: 15000, maxBuffer: 64000, env: minimalEnvironment({ CODEX_HOME: home }) });
        const path = await checkedPath(join(schemas, 'v2', 'CommandExecParams.json'), [temporary]);
        const schemaInfo = await lstat(path);
        if (!schemaInfo.isFile() || schemaInfo.nlink !== 1 || schemaInfo.size > 2_000_000) return false;
        return supportsRestrictedReads(JSON.parse(await readFile(path, 'utf8')));
      } finally {
        const target = resolve(temporary);
        if (target !== root && isWithin(root, target)) { await checkedPath(target, [root]); await rm(target, { recursive: true, force: true }); }
      }
    })();
    capabilityCache.set(key, check);
    // A transient schema-generation failure may be retried. A known unsupported
    // executable stays blocked until its file identity changes.
    void check.catch(() => { capabilityCache.delete(key); });
  }
  let supported = false;
  try { supported = await check; }
  catch { throw new WorkflowError('codex_protocol_unavailable', 'The installed Codex filesystem policy could not be verified. No worker was started.', 503); }
  if (!supported) throw new WorkflowError('codex_read_policy_unsupported', 'This installed Codex protocol cannot express restricted reads. Managed execution remains blocked; a compatible sandbox runtime is required.', 503);
}
