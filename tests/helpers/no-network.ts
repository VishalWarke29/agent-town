/**
 * noNetwork(): refuses outbound network connections to anything but loopback, and records every refused attempt.
 *
 * What it covers (this test process only), in three layers: global fetch() (checked by URL), http.request/get and
 * https.request/get (checked by destination, so an HTTP_PROXY on loopback cannot hide where a request is really going),
 * and every TCP/TLS connection opened through node:net, node:tls and undici (they all end in net.Socket.prototype.connect).
 * A refused call is stopped BEFORE any DNS lookup, so not even the host name leaves the machine. Loopback (localhost,
 * 127.0.0.0/8, ::1) and local pipes/sockets are allowed, so a test's own Fastify or http server keeps working.
 *
 * What it does not cover: UDP and DNS, worker threads, child processes (a tool a test starts can use the network on
 * its own), and the e2e service process. A library that opens sockets through a proxy it configures itself (not through
 * fetch or node:http) is only seen at the socket layer, where a loopback proxy looks like loopback. Real-tool proof
 * (CH-21, H0-21) still stands; see ./index.ts.
 *
 * What a record keeps: the host, the port, which layer refused it, the request method, and the scheme://host[:port] the
 * request was aimed at. The URL PATH, the query string and any credentials are never recorded, because a path can carry a
 * secret (a bot token, a webhook id) and guard.attempts may be printed by a failing test.
 *
 * Guards nest. Each noNetwork() call returns a handle; only the newest active handle records attempts, so a test that
 * expects a blocked call can take() it without tripping the file-wide guard that tests/helpers/setup.ts installs.
 * assertNoRefused() below is the check that setup.ts runs after every test.
 */
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

export interface NetworkAttempt {
  /** Host name or IP the code tried to reach, without brackets. */
  host: string;
  port: number | null;
  via: 'fetch' | 'http' | 'socket';
  /** For fetch and http only: the request method in upper case (GET when the caller named none). Never present for a raw socket. */
  method?: string;
  /** For fetch and http only: scheme://host[:port]. The path, the query string and any credentials are never recorded (a path can carry a secret). */
  url?: string;
}

export class NetworkBlockedError extends Error {
  readonly host: string;
  readonly port: number | null;
  readonly via: NetworkAttempt['via'];
  constructor(attempt: NetworkAttempt) {
    super(`Blocked outbound network request to ${attempt.host}${attempt.port === null ? '' : `:${attempt.port}`} (${attempt.via}). `
      + 'Unit tests may only connect to loopback: use a local server or an injected fetch, or call noNetwork() and take() the attempt if it is expected.');
    this.name = 'NetworkBlockedError';
    this.host = attempt.host; this.port = attempt.port; this.via = attempt.via;
  }
}

export interface NoNetwork {
  /** Refused attempts recorded on this handle since it was created (or last take()n), oldest first. */
  readonly attempts: readonly NetworkAttempt[];
  /** Loopback and local-pipe connections this handle let through. */
  readonly allowedCount: number;
  /** Distinct refused hosts, in first-seen order. */
  blockedHosts(): string[];
  /** Returns the recorded attempts and clears them: the way a test says "this refusal was expected". */
  take(): NetworkAttempt[];
  /** Throws NetworkBlockedError-style detail if anything was refused. Use it when the code under test may swallow the error. */
  expectNone(): void;
  /** Stops guarding through this handle. Safe to call more than once. The network patches come off with the last handle. */
  restore(): void;
}

type AnyFunction = (...args: unknown[]) => unknown;
interface Registry {
  stack: HandleImpl[];
  original: { fetch: typeof fetch; connect: AnyFunction; http: { request: AnyFunction; get: AnyFunction }; https: { request: AnyFunction; get: AnyFunction } } | null;
}

const REGISTRY = Symbol.for('agent-town.tests.noNetwork');
function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (holder[REGISTRY] ??= { stack: [], original: null });
}

/** True for localhost, *.localhost, 127.0.0.0/8, ::1 and IPv4-mapped 127.x.x.x (::ffff:7f00:0 to ::ffff:7fff:ffff). Anything else is "outside". */
export function isLoopbackHost(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(':')) {
    try {
      // The URL parser canonicalises every spelling of an IPv6 address, so ::1 == 0:0:0:0:0:0:0:1 == [::1], and
      // ::ffff:127.0.0.1 becomes [::ffff:7f00:1]. The first mapped group must be a full 7fXX (127.x); ::ffff:7f:1 is 0.127.0.1.
      const canonical = new URL(`http://[${host}]/`).hostname;
      return canonical === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(canonical);
    } catch { return false; }
  }
  return false;
}

/** Reads the destination out of the many argument shapes of Socket.prototype.connect. null means a local pipe or socket path. */
export function connectTarget(args: readonly unknown[]): { host: string; port: number | null } | null {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // Node passes already-normalised [options, callback] internally
  if (first !== null && typeof first === 'object') {
    const options = first as { host?: unknown; hostname?: unknown; port?: unknown; path?: unknown };
    if (typeof options.path === 'string' && options.path) return null;
    const host = typeof options.host === 'string' && options.host ? options.host : typeof options.hostname === 'string' && options.hostname ? options.hostname : 'localhost';
    const port = Number(options.port);
    return { host, port: Number.isFinite(port) ? port : null };
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) };
  }
  return null; // a path string: a named pipe or unix socket, which never leaves the machine
}

/** Reads the destination out of http.request(url?, options?, callback?) arguments; options override the URL, as in Node. null means a socketPath. */
export function requestTarget(args: readonly unknown[]): { host: string; port: number | null } | null {
  let host = '', port: number | null = null, socketPath = false;
  const apply = (value: unknown) => {
    let source: { hostname?: unknown; host?: unknown; port?: unknown; socketPath?: unknown } | null = null;
    if (typeof value === 'string') { try { source = new URL(value); } catch { return; } }
    else if (value instanceof URL) source = value;
    else if (value !== null && typeof value === 'object') source = value;
    if (!source) return;
    if (typeof source.socketPath === 'string' && source.socketPath) socketPath = true;
    const named = typeof source.hostname === 'string' && source.hostname ? source.hostname : typeof source.host === 'string' && source.host ? source.host : '';
    if (named) host = named;
    if (source.port !== undefined && source.port !== null && source.port !== '') { const parsed = Number(source.port); if (Number.isFinite(parsed)) port = parsed; }
  };
  apply(args[0]);
  if (typeof args[1] !== 'function') apply(args[1]);
  return socketPath ? null : { host: host || 'localhost', port };
}

function fetchTarget(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof (input as Request).url === 'string') return new URL((input as Request).url);
  } catch { /* an unparsable URL is left for the real fetch to reject in its usual way */ }
  return null;
}

/** The request method a fetch call names, in upper case: init wins over a Request's own method, and a bare URL or string is GET. */
function fetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const own = input !== null && typeof input === 'object' && !(input instanceof URL) ? (input as Request).method : undefined;
  const named = typeof init?.method === 'string' && init.method ? init.method : typeof own === 'string' && own ? own : 'GET';
  return named.toUpperCase();
}

/** The request method http.request/get was given (the options object may come first or second); GET when none is named. */
function requestMethod(args: readonly unknown[]): string {
  for (const candidate of [args[1], args[0]]) {
    if (candidate !== null && typeof candidate === 'object' && !(candidate instanceof URL)) {
      const method = (candidate as { method?: unknown }).method;
      if (typeof method === 'string' && method) return method.toUpperCase();
    }
  }
  return 'GET';
}

function decide(reg: Registry, attempt: NetworkAttempt): NetworkBlockedError | null {
  const top = reg.stack.at(-1);
  if (!top) return null;
  if (isLoopbackHost(attempt.host)) { top.allowed++; return null; }
  top.recorded.push(attempt);
  return new NetworkBlockedError(attempt);
}

function install(reg: Registry): void {
  if (reg.original) return;
  const prototype = net.Socket.prototype as unknown as { connect: AnyFunction };
  const originalFetch = globalThis.fetch;
  const originalConnect = prototype.connect;
  const httpModules = { http: http as unknown as { request: AnyFunction; get: AnyFunction }, https: https as unknown as { request: AnyFunction; get: AnyFunction } };
  reg.original = { fetch: originalFetch, connect: originalConnect, http: { request: httpModules.http.request, get: httpModules.http.get }, https: { request: httpModules.https.request, get: httpModules.https.get } };
  for (const scheme of ['http', 'https'] as const) {
    for (const method of ['request', 'get'] as const) {
      const original = httpModules[scheme][method];
      httpModules[scheme][method] = function guardedRequest(this: unknown, ...args: unknown[]) {
        const target = requestTarget(args);
        if (target) {
          const host = target.host.replace(/^\[|\]$/g, '');
          const error = decide(reg, { host, port: target.port, via: 'http', method: requestMethod(args), url: `${scheme}://${target.host}${target.port === null ? '' : `:${target.port}`}` });
          if (error) throw error; // thrown, not emitted: no request object exists yet, and nothing has left the process
        }
        return original.apply(this, args);
      };
    }
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = fetchTarget(input);
    if (url && /^(?:https?|wss?):$/.test(url.protocol)) {
      // scheme://host[:port] only: url.host has no credentials, and the path and query are left out on purpose (a path can be a secret).
      const error = decide(reg, { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : null, via: 'fetch', method: fetchMethod(input, init), url: `${url.protocol}//${url.host}` });
      if (error) throw error;
    }
    return originalFetch.call(globalThis, input, init);
  }) as typeof fetch;
  prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const target = connectTarget(args);
    if (target) {
      const error = decide(reg, { host: target.host.replace(/^\[|\]$/g, ''), port: target.port, via: 'socket' });
      if (error) {
        // Shows up like any failed connection: an 'error' event, before any lookup. It is delivered on the next tick, never inside
        // connect(): tls.connect() and undici keep using the socket's handle right after connect() returns (tls reads it to call
        // setServername), and destroying the socket first made that a TypeError instead of this refusal.
        process.nextTick(() => this.destroy(error));
        return this;
      }
    } else {
      const top = reg.stack.at(-1);
      if (top) top.allowed++;
    }
    return originalConnect.apply(this, args);
  };
  syncBuiltinESMExports();
}

function uninstall(reg: Registry): void {
  const original = reg.original;
  if (!original) return;
  (net.Socket.prototype as unknown as { connect: unknown }).connect = original.connect;
  globalThis.fetch = original.fetch;
  Object.assign(http, { request: original.http.request, get: original.http.get });
  Object.assign(https, { request: original.https.request, get: original.https.get });
  reg.original = null;
  syncBuiltinESMExports();
}

/** "fetch example.com:8443": what a failure message says about one refused attempt (never a path, query or credential). */
function describeAttempt(attempt: NetworkAttempt): string {
  return `${attempt.via} ${attempt.host}${attempt.port === null ? '' : `:${attempt.port}`}`;
}

/**
 * The check tests/helpers/setup.ts runs after every test and after every file: throws, naming each refused host and port,
 * when `guard` holds a refusal that nobody take()n. This is what fails a test whose code caught and swallowed the
 * NetworkBlockedError, so it lives here where it can be tested on its own; tests/unit/test-helpers.test.ts also runs a real
 * spec through the file-wide setup to prove the hooks that call it are still registered. It empties the guard as it reads it,
 * so one swallowed call fails one test, not every test after it.
 */
export function assertNoRefused(guard: Pick<NoNetwork, 'take'>, when: string): void {
  const refused = guard.take();
  if (!refused.length) return;
  throw new Error(`Outbound network access was attempted ${when}: ${refused.map(describeAttempt).join(', ')}. `
    + 'Unit tests may only connect to loopback. Use a local server or an injected fetch; a test that expects the refusal calls noNetwork() and take()s it.');
}

class HandleImpl implements NoNetwork {
  recorded: NetworkAttempt[] = [];
  allowed = 0;
  constructor(private readonly reg: Registry) {}
  get attempts(): readonly NetworkAttempt[] { return [...this.recorded]; }
  get allowedCount(): number { return this.allowed; }
  blockedHosts(): string[] { return [...new Set(this.recorded.map(attempt => attempt.host))]; }
  take(): NetworkAttempt[] { return this.recorded.splice(0); }
  expectNone(): void {
    if (this.recorded.length) throw new Error(`Expected no outbound network attempt, but ${this.recorded.length} were refused: ${this.recorded.map(describeAttempt).join(', ')}`);
  }
  restore(): void {
    const index = this.reg.stack.indexOf(this);
    if (index >= 0) this.reg.stack.splice(index, 1);
    if (!this.reg.stack.length) uninstall(this.reg);
  }
}

/** Number of active guards in this process (the file-wide one from setup.ts counts). */
export function activeNetworkGuards(): number { return registry().stack.length; }

export function noNetwork(): NoNetwork {
  const reg = registry();
  install(reg);
  const handle = new HandleImpl(reg);
  reg.stack.push(handle);
  return handle;
}
