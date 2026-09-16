import ts from 'typescript';
import { httpMethodSchema, type ApiEndpoint } from '../../../../packages/contracts/src/telemetry';
import { safeRouteTemplate } from './otlp';

export interface ParsedRoute { method: ApiEndpoint['method']; route: string | null; framework: ApiEndpoint['framework']; line: number; reason: string | null }
export interface ParsedRoutes { routes: ParsedRoute[]; issues: string[] }
interface Instance { framework: 'express' | 'fastify'; paths: string[]; router: boolean; mounts: { parent: Instance; prefix: string }[] }
const literal = (node: ts.Node | undefined): string | null => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
const routeJoin = (prefix: string, route: string) => safeRouteTemplate(`${prefix.replace(/\/$/u, '')}/${route.replace(/^\//u, '')}`);

export function parseJavaScriptRoutes(path: string, text: string): ParsedRoutes {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const routes: ParsedRoute[] = [], issues: string[] = [];
  const factories = new Map<string, 'express' | 'fastify'>();
  const routerFactories = new Set<string>();
  const instances = new Map<string, Instance>();
  const functions = new Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>();
  const pending: { instance: Instance; method: ApiEndpoint['method']; route: string | null; line: number; reason: string | null }[] = [];
  const lineAt = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const parseErrors = (file as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (parseErrors?.length) return { routes, issues: ['javascript-syntax-error'] };
  const frameworkFor = (value: string | null) => value === 'express' ? 'express' : value === 'fastify' ? 'fastify' : null;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const framework = frameworkFor(literal(statement.moduleSpecifier));
      if (framework && statement.importClause) {
        if (statement.importClause.name) factories.set(statement.importClause.name.text, framework);
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
          if (framework === 'express' && (binding.propertyName?.text ?? binding.name.text) === 'Router') routerFactories.add(binding.name.text);
          else if (framework === 'fastify' && ['fastify', 'default'].includes(binding.propertyName?.text ?? binding.name.text)) factories.set(binding.name.text, framework);
        }
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
  }
  const property = (node: ts.Expression, name: string) => ts.isObjectLiteralExpression(node)
    ? node.properties.find(item => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) ? item.name.text : literal(item.name)) === name) as ts.PropertyAssignment | undefined : undefined;
  const methods = (node: ts.Node | undefined): ApiEndpoint['method'][] => {
    const values = node && ts.isArrayLiteralExpression(node) ? node.elements.map(literal) : [literal(node)];
    return values.flatMap(value => { const parsed = httpMethodSchema.safeParse(value?.toUpperCase()); return parsed.success ? [parsed.data] : []; });
  };
  const add = (instance: Instance, method: ApiEndpoint['method'], node: ts.Node, value: string | null) => pending.push({
    instance, method, route: safeRouteTemplate(value), line: lineAt(node), reason: safeRouteTemplate(value) ? null : 'dynamic-or-unsafe-route',
  });
  const walk = (node: ts.Node, bindings: Map<string, Instance>, depth = 0): void => {
    if (depth > 10) { issues.push('plugin-depth-limit'); return; }
    if (ts.isFunctionLike(node)) return; // Handler bodies do not register top-level endpoints.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text, init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) functions.set(name, init);
      if (ts.isCallExpression(init)) {
        const called = init.expression;
        if (ts.isIdentifier(called) && called.text === 'require') {
          const framework = frameworkFor(literal(init.arguments[0]));
          if (framework) factories.set(name, framework);
        }
        let framework: 'express' | 'fastify' | undefined;
        let router = false;
        if (ts.isIdentifier(called)) { framework = factories.get(called.text); if (routerFactories.has(called.text)) { framework = 'express'; router = true; } }
        else if (ts.isPropertyAccessExpression(called) && called.name.text === 'Router' && ts.isIdentifier(called.expression) && factories.get(called.expression.text) === 'express') { framework = 'express'; router = true; }
        else if (ts.isCallExpression(called) && ts.isIdentifier(called.expression) && called.expression.text === 'require') framework = frameworkFor(literal(called.arguments[0])) ?? undefined;
        if (framework) {
          if (bindings.has(name)) { bindings.delete(name); issues.push('ambiguous-router-binding'); }
          else bindings.set(name, { framework, router, paths: router ? [] : [''], mounts: [] });
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const called = node.expression, method = called.name.text;
      const instance = ts.isIdentifier(called.expression) ? bindings.get(called.expression.text) : undefined;
      const parsedMethod = httpMethodSchema.safeParse(method.toUpperCase());
      if (instance && parsedMethod.success) add(instance, parsedMethod.data, node, literal(node.arguments[0]));
      else if (instance && method === 'all') add(instance, 'ANY', node, literal(node.arguments[0]));
      else if (instance && method === 'route' && instance.framework === 'fastify' && node.arguments[0]) {
        const options = node.arguments[0];
        const declared = methods(property(options, 'method')?.initializer);
        for (const verb of declared.length ? declared : ['ANY' as const]) add(instance, verb, node, literal(property(options, 'url')?.initializer));
      } else if (instance && method === 'use' && instance.framework === 'express') {
        const hasPrefix = literal(node.arguments[0]) !== null;
        const prefix = hasPrefix ? literal(node.arguments[0])! : '';
        for (const argument of node.arguments.slice(hasPrefix ? 1 : 0)) {
          const child = ts.isIdentifier(argument) ? bindings.get(argument.text) : undefined;
          if (child && (prefix === '' || safeRouteTemplate(prefix))) child.mounts.push({ parent: instance, prefix });
          else if (ts.isIdentifier(argument)) issues.push('cross-file-or-dynamic-router-mount');
        }
      } else if (instance && method === 'register' && instance.framework === 'fastify') {
        const plugin = node.arguments[0];
        const callback = plugin && (ts.isArrowFunction(plugin) || ts.isFunctionExpression(plugin)) ? plugin : plugin && ts.isIdentifier(plugin) ? functions.get(plugin.text) : undefined;
        const prefixNode = node.arguments[1] ? property(node.arguments[1], 'prefix')?.initializer : undefined;
        const prefix = prefixNode ? literal(prefixNode) : '';
        if (callback?.body && callback.parameters[0] && ts.isIdentifier(callback.parameters[0].name) && prefix !== null && (prefix === '' || safeRouteTemplate(prefix))) {
          const child: Instance = { framework: 'fastify', router: true, paths: [], mounts: [{ parent: instance, prefix }] };
          const nested = new Map(bindings); nested.set(callback.parameters[0].name.text, child); walk(callback.body, nested, depth + 1);
        } else issues.push('cross-file-or-dynamic-plugin-prefix');
      } else if (parsedMethod.success && ts.isCallExpression(called.expression) && ts.isPropertyAccessExpression(called.expression.expression)) {
        let current: ts.Expression = called.expression;
        let anchoredRoute: string | null = null, anchored = false;
        for (let count = 0; count < 12 && ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression); count++) {
          const access: ts.PropertyAccessExpression = current.expression;
          if (access.name.text === 'route') { anchoredRoute = literal(current.arguments[0]); anchored = true; }
          else if (!httpMethodSchema.safeParse(access.name.text.toUpperCase()).success && access.name.text !== 'all') break;
          const owner = ts.isIdentifier(access.expression) ? bindings.get(access.expression.text) : undefined;
          if (owner) {
            add(owner, parsedMethod.data, node, anchored && owner.framework === 'express' ? anchoredRoute : literal(node.arguments[0]));
            break;
          }
          current = access.expression;
        }
      }
    }
    ts.forEachChild(node, child => walk(child, bindings, depth));
  };
  walk(file, instances);
  const prefixes = (instance: Instance, visited = new Set<Instance>()): string[] => {
    if (visited.has(instance)) return [];
    const seen = new Set(visited); seen.add(instance);
    return [...instance.paths, ...instance.mounts.flatMap(mount => prefixes(mount.parent, seen).flatMap(prefix => {
      const joined = `${prefix.replace(/\/$/u, '')}${mount.prefix}`; return joined === '' || safeRouteTemplate(joined) ? [joined] : [];
    }))];
  };
  for (const item of pending) {
    const mounted = prefixes(item.instance);
    for (const prefix of mounted.length ? mounted : [null]) routes.push({ method: item.method,
      route: prefix !== null && item.route !== null ? routeJoin(prefix, item.route) : null,
      framework: item.instance.framework, line: item.line, reason: item.reason ?? (prefix === null ? 'router-mount-unresolved' : null) });
  }
  const normalized = path.replaceAll('\\', '/');
  const app = /(?:^|\/)app\/(.*)\/route\.[cm]?[jt]sx?$/u.exec(normalized) ?? /(?:^|\/)app\/(route\.[cm]?[jt]sx?)$/u.exec(normalized);
  const pages = /(?:^|\/)pages\/api\/(.+)\.[cm]?[jt]sx?$/u.exec(normalized);
  const nextPath = (value: string, pages = false) => {
    const parts = value.split('/').filter(part => part && (pages || !/^\([^)]*\)$/u.test(part)));
    if (pages && parts.at(-1) === 'index') parts.pop();
    return `/${parts.join('/')}`;
  };
  if (app) {
    const route = nextPath(app[1].startsWith('route.') ? '' : app[1]);
    for (const statement of file.statements) {
      if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const names = ts.isFunctionDeclaration(statement) && statement.name ? [statement.name.text]
        : ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap(item => ts.isIdentifier(item.name) ? [item.name.text] : []) : [];
      for (const name of names) {
        const method = httpMethodSchema.safeParse(name);
        if (method.success) routes.push({ method: method.data, route: safeRouteTemplate(route), framework: 'next', line: lineAt(statement), reason: route.includes('@') || route.includes('(') ? 'next-intercepting-route-unresolved' : null });
      }
    }
  } else if (pages && file.statements.some(statement => ts.isExportAssignment(statement)
    || ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword))) {
    routes.push({ method: 'ANY', route: safeRouteTemplate(`/api${nextPath(pages[1], true)}`.replace(/\/$/u, '')), framework: 'next', line: 1, reason: 'pages-handler-methods-not-resolved' });
  }
  return { routes, issues: [...new Set(issues)] };
}
