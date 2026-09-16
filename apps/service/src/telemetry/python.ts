import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { isWithin } from '../discovery/paths';
import type { ParsedRoutes } from './javascript';
import { safeRouteTemplate } from './otlp';

// Fixed application-owned program. ast.parse creates syntax trees; no repository module is imported or executed.
const SCRIPT = String.raw`
import ast, json, sys
result = {}
for entry in json.load(sys.stdin):
    routes, issues, factories, objects = [], [], {}, {}
    try:
        tree = ast.parse(entry['content'], filename='<selected-source>')
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module in ('fastapi', 'flask'):
                for item in node.names:
                    factories[item.asname or item.name] = (node.module, item.name)
            elif isinstance(node, ast.Import):
                for item in node.names:
                    if item.name in ('fastapi', 'flask'):
                        factories[item.asname or item.name] = (item.name, '*')
        def string(node):
            return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None
        def keyword(node, name, default=None):
            for item in node.keywords:
                if item.arg == name: return item.value
            return default
        for node in ast.walk(tree):
            if isinstance(node, (ast.Assign, ast.AnnAssign)) and isinstance(node.value, ast.Call):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                called = node.value.func
                factory = factories.get(called.id) if isinstance(called, ast.Name) else None
                if isinstance(called, ast.Attribute) and isinstance(called.value, ast.Name) and called.value.id in factories:
                    factory = (factories[called.value.id][0], called.attr)
                if factory and factory[1] in ('FastAPI', 'APIRouter', 'Flask', 'Blueprint'):
                    for target in targets:
                        if not isinstance(target, ast.Name): continue
                        if target.id in objects:
                            objects[target.id] = None
                            issues.append('ambiguous-router-binding')
                            continue
                        router = factory[1] in ('APIRouter', 'Blueprint')
                        prefix_node = keyword(node.value, 'prefix' if factory[0] == 'fastapi' else 'url_prefix')
                        prefix = string(prefix_node) if prefix_node else ''
                        objects[target.id] = dict(framework=factory[0], router=router, prefix=prefix, mounts=[])
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                parent = objects.get(node.func.value.id)
                if parent and node.func.attr in ('include_router', 'register_blueprint'):
                    child = objects.get(node.args[0].id) if node.args and isinstance(node.args[0], ast.Name) else None
                    prefix_node = keyword(node, 'prefix' if node.func.attr == 'include_router' else 'url_prefix')
                    prefix = string(prefix_node) if prefix_node else ''
                    if child and prefix is not None: child['mounts'].append((node.func.value.id, prefix, node.func.attr == 'register_blueprint' and prefix_node is not None))
                    else: issues.append('cross-file-or-dynamic-router-mount')
        def prefixes(name, seen=None):
            seen = set() if seen is None else set(seen)
            if name in seen: return []
            seen.add(name)
            item = objects.get(name)
            if not item or item['prefix'] is None: return []
            if not item['router']: return [item['prefix']]
            return [base.rstrip('/') + extra + ('' if override else item['prefix']) for parent, extra, override in item['mounts'] for base in prefixes(parent, seen)]
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)): continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute) or not isinstance(decorator.func.value, ast.Name): continue
                name, method = decorator.func.value.id, decorator.func.attr
                owner = objects.get(name)
                if not owner or method not in ('get','post','put','patch','delete','head','options','trace','route','api_route'): continue
                value = string(decorator.args[0]) if decorator.args else string(keyword(decorator, 'path') or keyword(decorator, 'rule'))
                verbs = [method.upper()]
                if method in ('route', 'api_route'):
                    method_nodes = keyword(decorator, 'methods')
                    verbs = [string(item) for item in method_nodes.elts] if isinstance(method_nodes, (ast.List, ast.Tuple)) else ['GET'] if method_nodes is None else ['ANY']
                bases = prefixes(name)
                for base in bases or [None]:
                    for verb in verbs:
                        if verb not in ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','TRACE','CONNECT','ANY'): verb = 'ANY'
                        route = base.rstrip('/') + '/' + value.lstrip('/') if base is not None and value is not None else None
                        reason = 'dynamic-route' if value is None else 'router-mount-unresolved' if base is None else 'dynamic-method' if verb == 'ANY' else None
                        routes.append(dict(method=verb, route=route, framework=owner['framework'], line=decorator.lineno, reason=reason))
    except (SyntaxError, ValueError, RecursionError):
        issues.append('python-syntax-error')
    result[entry['path']] = dict(routes=routes, issues=list(set(issues)))
json.dump(result, sys.stdout)
`;

async function pythonExecutable(root: string): Promise<string | null> {
  const pathValue = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory) || isWithin(root, resolve(directory))) continue;
    for (const name of process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']) {
      try {
        const candidate = await realpath(join(directory, name));
        if (!isWithin(root, candidate) && (await lstat(candidate)).isFile()) return candidate;
      } catch { /* No executable at this PATH location. */ }
    }
  }
  return null;
}

export async function parsePythonRoutes(root: string, files: { path: string; content: string }[], signal?: AbortSignal): Promise<Record<string, ParsedRoutes> | null> {
  if (!files.length) return {};
  const executable = await pythonExecutable(root);
  if (!executable) return null;
  const env: NodeJS.ProcessEnv = { PATH: dirname(executable), PYTHONUTF8: '1' };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  return new Promise(resolve => {
    const child = spawn(executable, ['-I', '-S', '-c', SCRIPT], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let output = '', overflow = false;
    const timer = setTimeout(() => child.kill(), 5_000);
    child.stdout.setEncoding('utf8'); child.stderr.resume();
    child.stdout.on('data', (chunk: string) => { output += chunk; if (Buffer.byteLength(output) > 1_000_000) { overflow = true; child.kill(); } });
    child.stdin.on('error', () => undefined);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || overflow) { resolve(null); return; }
      try {
        const decoded = JSON.parse(output) as Record<string, ParsedRoutes>;
        for (const result of Object.values(decoded)) for (const route of result.routes) {
          const safe = safeRouteTemplate(route.route);
          if (!safe) route.reason ??= 'dynamic-or-unsafe-route';
          route.route = safe;
        }
        resolve(decoded);
      } catch { resolve(null); }
    });
    child.stdin.end(JSON.stringify(files));
  });
}
