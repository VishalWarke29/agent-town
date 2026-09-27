import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { httpMethodSchema, type ApiEndpoint, type ApiInventory } from '../../../../packages/contracts/src/telemetry';
import { canonicalizeRoot, checkedPath, isWithin, readMetadataFile } from '../discovery/paths';
import { isExcludedDirectory, isSecretName } from '../discovery/policy';
import { parseJavaScriptRoutes, type ParsedRoutes } from './javascript';
import { parsePythonRoutes } from './python';
import { safeRouteTemplate } from './otlp';

export interface InventoryScanOptions {
  repoId: string;
  rootPath: string;
  openApiFiles?: string[];
  signal?: AbortSignal;
  limits?: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number; maxEntries?: number; maxDurationMs?: number };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceCache = new Map<string, ParsedRoutes>();
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class ApiInventoryError extends Error {
  constructor(public readonly code: 'invalid-selection' | 'invalid-limits') {
    super(code === 'invalid-selection' ? 'Choose at most ten JSON API documents inside the selected repository.' : 'Inventory limits must be positive integers within the supported bounds.');
    this.name = 'ApiInventoryError';
  }
}

function parseOpenApi(path: string, content: string): ParsedRoutes {
  const routes: ParsedRoutes['routes'] = [], issues: string[] = [];
  let document: Record<string, unknown>;
  try { document = asObject(JSON.parse(content)); } catch { return { routes, issues: ['invalid-openapi-json'] }; }
  if (typeof document.openapi !== 'string' || !/^3\.[01]\.\d+$/u.test(document.openapi)
    || typeof asObject(document.info).title !== 'string' || typeof asObject(document.info).version !== 'string'
    || !document.paths || typeof document.paths !== 'object' || Array.isArray(document.paths)) {
    return { routes, issues: ['unsupported-openapi-document'] };
  }
  for (const [route, rawItem] of Object.entries(asObject(document.paths)).slice(0, 1000)) {
    const item = asObject(rawItem), safe = safeRouteTemplate(route);
    if (item.$ref) { issues.push('openapi-reference-not-resolved'); continue; }
    for (const [key, value] of Object.entries(item)) {
      const method = httpMethodSchema.safeParse(key.toUpperCase());
      if (!method.success || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const at = content.indexOf(JSON.stringify(route));
      const line = at < 0 ? 1 : content.slice(0, at).split('\n').length;
      routes.push({ method: method.data, route: safe, framework: 'openapi', line, reason: safe ? null : 'unsafe-openapi-route' });
    }
  }
  if (Object.keys(asObject(document.paths)).length > 1000) issues.push('endpoint-limit');
  if (Array.isArray(document.servers) && document.servers.length) issues.push('openapi-server-prefix-not-resolved');
  void path;
  return { routes, issues };
}

export async function scanApiInventory(options: InventoryScanOptions): Promise<ApiInventory> {
  const root = await canonicalizeRoot(options.rootPath);
  const bounds = { maxFiles: 300, maxFileBytes: 256_000, maxTotalBytes: 8_000_000, maxEntries: 20_000, maxDurationMs: 20_000 };
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    const name = key as keyof typeof bounds;
    // REV-22: Object.hasOwn instead of `in`, so an inherited name (constructor, toString, ...) can
    // never be mistaken for a real bound, even though `options.limits` is internal-only today.
    if (!Number.isInteger(value) || value < 1 || !Object.hasOwn(bounds, name) || value > bounds[name]) throw new ApiInventoryError('invalid-limits');
    bounds[name] = value;
  }
  const inventory: ApiInventory = { repoId: options.repoId, endpoints: [], scannedAt: new Date().toISOString(), filesScanned: 0, coverage: 'complete', issues: [] };
  const issues = new Set<string>();
  const deadline = Date.now() + bounds.maxDurationMs;
  const files: { path: string; content: string; hash: string }[] = [];
  const selectedJson = new Set<string>();
  for (const path of options.openApiFiles ?? []) {
    const candidate = resolve(root, path);
    if (isAbsolute(path) || !isWithin(root, candidate) || extname(candidate).toLowerCase() !== '.json' || path.split(/[\\/]/u).some(isSecretName)) throw new ApiInventoryError('invalid-selection');
    selectedJson.add(relative(root, candidate).replaceAll('\\', '/'));
  }
  if (selectedJson.size > 10) throw new ApiInventoryError('invalid-selection');
  let entries = 0, totalBytes = 0;
  const queue: { path: string; depth: number; rules: { base: string; matcher: Ignore }[] }[] = [{ path: root, depth: 0, rules: [] }];
  while (queue.length) {
    if (options.signal?.aborted) { issues.add('cancelled'); break; }
    if (Date.now() >= deadline) { issues.add('time-limit'); break; }
    if (entries >= bounds.maxEntries || files.length >= bounds.maxFiles || totalBytes >= bounds.maxTotalBytes) { issues.add('scan-limit'); break; }
    const item = queue.shift()!;
    try {
      await checkedPath(item.path, [root]);
      if (item.path !== root) {
        try { await lstat(join(item.path, '.git')); issues.add('nested-repository-excluded'); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const rules = [...item.rules];
      try {
        const content = await readMetadataFile(join(item.path, '.gitignore'), [root], 32_000);
        if (content.split('\n').length > 1000 || content.split('\n').some(line => line.length > 1024)) { issues.add('ignore-rule-limit'); continue; }
        rules.push({ base: item.path, matcher: ignore().add(content) });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { issues.add('unreadable-ignore-rules'); continue; } }
      const directory = await opendir(item.path);
      try {
        for await (const entry of directory) {
          if (++entries > bounds.maxEntries || files.length >= bounds.maxFiles || options.signal?.aborted || Date.now() >= deadline) { issues.add(options.signal?.aborted ? 'cancelled' : Date.now() >= deadline ? 'time-limit' : 'scan-limit'); break; }
          const path = join(item.path, entry.name), relativePath = relative(root, path).replaceAll('\\', '/');
          if (entry.isSymbolicLink()) { issues.add('linked-path-excluded'); continue; }
          if (isSecretName(entry.name) || entry.name.startsWith('.') || isExcludedDirectory(entry.name)) continue;
          let ignored = false;
          for (const rule of rules) {
            const result = rule.matcher.test(`${relative(rule.base, path).replaceAll('\\', '/')}${entry.isDirectory() ? '/' : ''}`);
            if (result.ignored) ignored = true; else if (result.unignored) ignored = false;
          }
          if (ignored) continue;
          if (entry.isDirectory()) {
            if (item.depth >= 12) issues.add('depth-limit'); else queue.push({ path, depth: item.depth + 1, rules });
          } else if (entry.isFile() && (/\.[cm]?[jt]sx?$/u.test(entry.name) || entry.name.endsWith('.py') || selectedJson.has(relativePath))) {
            try {
              const content = await readMetadataFile(path, [root], bounds.maxFileBytes);
              if (content.includes('\u0000')) { issues.add('binary-source-excluded'); continue; }
              totalBytes += Buffer.byteLength(content);
              if (totalBytes > bounds.maxTotalBytes) { issues.add('scan-limit'); break; }
              files.push({ path: relativePath, content, hash: hash(content) });
            } catch { issues.add('unreadable-or-large-source'); }
          }
        }
      } finally { await directory.close().catch(() => undefined); }
    } catch { issues.add('unreadable-directory'); }
  }
  const pythonFiles = files.filter(file => file.path.endsWith('.py'));
  const python = options.signal?.aborted ? null : await parsePythonRoutes(root, pythonFiles, options.signal);
  if (python === null && pythonFiles.length) issues.add('python-parser-unavailable');
  for (const file of files) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (options.signal?.aborted) { issues.add('cancelled'); break; }
    let parsed: ParsedRoutes;
    if (file.path.endsWith('.py')) parsed = python?.[file.path] ?? { routes: [], issues: [] };
    else if (selectedJson.has(file.path)) parsed = parseOpenApi(file.path, file.content);
    else {
      const key = hash(`${root}\0${file.path}\0${file.hash}`);
      parsed = sourceCache.get(key) ?? parseJavaScriptRoutes(file.path, file.content);
      if (!sourceCache.has(key)) { sourceCache.set(key, parsed); if (sourceCache.size > 500) sourceCache.delete(sourceCache.keys().next().value!); }
    }
    for (const issue of parsed.issues) issues.add(issue);
    for (const route of parsed.routes) {
      if (inventory.endpoints.length >= 2000) { issues.add('endpoint-limit'); break; }
      if (route.reason) issues.add(route.reason);
      const endpoint: ApiEndpoint = { ...route, id: hash([options.repoId, file.path, route.line, route.method, route.route].join('\0')).slice(0, 32), repoId: options.repoId,
        source: { path: file.path, line: route.line, hash: file.hash }, confidence: route.reason ? 'partial' : 'declared' };
      if (!inventory.endpoints.some(existing => existing.id === endpoint.id)) inventory.endpoints.push(endpoint);
    }
  }
  for (const selected of selectedJson) if (!files.some(file => file.path === selected)) issues.add('selected-openapi-file-unavailable');
  inventory.filesScanned = files.length; inventory.issues = [...issues].sort(); inventory.coverage = issues.size ? 'partial' : 'complete';
  return inventory;
}
