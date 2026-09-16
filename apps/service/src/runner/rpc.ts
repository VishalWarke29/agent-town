import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { WorkflowError } from '../workflow/index.js';

export interface RpcTransport {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  subscribe(listener: (method: string, params: unknown) => void): () => void;
  close(): Promise<void>;
}
export function minimalEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA']) if (process.env[name]) env[name] = process.env[name];
  env.PATH = [dirname(process.execPath), process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : ''].filter(Boolean).join(delimiter);
  return { ...env, ...extra };
}
export async function resolveExecutable(name: string, excludedRoots: string[] = []): Promise<string | null> {
  const supplied = name === 'codex' ? process.env.AGENT_TOWN_CODEX_EXECUTABLE : undefined;
  const candidates = supplied ? [supplied] : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, process.platform === 'win32' ? `${name}.exe` : name));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try { const path = await realpath(candidate); if (!excludedRoots.some(root => path.toLowerCase().startsWith(root.toLowerCase() + '\\')) && (await lstat(path)).isFile()) return path; } catch { /* Missing executable candidates are normal. */ }
  }
  return null;
}

/** JSON lines over pipes. Native errors and diagnostics are never forwarded verbatim. */
export class CodexRpc implements RpcTransport {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private buffer = '';
  private closed = false;
  private readonly child: ChildProcessWithoutNullStreams;
  constructor(executable: string, home: string, mode: 'subscription' | 'api' | 'sandbox' = 'sandbox') {
    const args = ['app-server', '--stdio', '--strict-config', '-c', `cli_auth_credentials_store="${mode === 'subscription' ? 'keyring' : 'ephemeral'}"`,
      '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-c', 'shell_environment_policy.inherit="none"', '-c', 'allow_login_shell=false',
      '-c', 'analytics.enabled=false', '-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false',
      '-c', 'features.multi_agent=false', '-c', 'features.browser_use=false', '-c', 'features.computer_use=false', '-c', 'web_search="disabled"'];
    if (process.platform === 'win32') args.push('-c', 'windows.sandbox="elevated"');
    if (mode !== 'sandbox') args.push('-c', `forced_login_method="${mode === 'subscription' ? 'chatgpt' : 'api'}"`);
    this.child = spawn(executable, args, { cwd: home, env: minimalEnvironment({ CODEX_HOME: home }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    this.child.stderr.resume();
    this.child.on('error', () => this.fail());
    this.child.on('close', () => this.fail());
    this.child.stdin.on('error', () => this.fail());
  }
  private fail(): void {
    if (!this.closed) for (const listener of this.listeners) listener('agent-town/transport-closed', {});
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new WorkflowError('codex_disconnected', 'The isolated Codex process stopped. Its outcome needs review.', 502)); }
    this.pending.clear();
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 2_000_000) { this.child.kill(); this.fail(); return; }
    for (;;) {
      const split = this.buffer.indexOf('\n');
      if (split < 0) break;
      const line = this.buffer.slice(0, split); this.buffer = this.buffer.slice(split + 1);
      let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
      try { message = JSON.parse(line) as typeof message; } catch { this.child.kill(); this.fail(); return; }
      if (message.method) {
        // Never approve native escalation or arbitrary server requests silently.
        if (message.id !== undefined) this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Agent Town does not authorize this operation.' } }) + '\n');
        else for (const listener of this.listeners) listener(message.method, message.params);
      } else if (typeof message.id === 'number') {
        const waiting = this.pending.get(message.id);
        if (waiting) { clearTimeout(waiting.timer); this.pending.delete(message.id); if (message.error) waiting.reject(new WorkflowError('codex_request_failed', 'Codex rejected the bounded request or required configuration.', 502)); else waiting.resolve(message.result); }
      }
    }
  }
  request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed || this.pending.size >= 32) return Promise.reject(new WorkflowError('codex_unavailable', 'The isolated Codex connection is unavailable.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new WorkflowError('codex_timeout', 'Codex did not acknowledge the request in time. Review its outcome before retrying.', 504)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  notify(method: string, params: unknown): void { if (!this.closed) this.child.stdin.write(JSON.stringify({ method, params }) + '\n'); }
  subscribe(listener: (method: string, params: unknown) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) { this.fail(); this.listeners.clear(); return; }
    const closed = new Promise<void>(resolve => this.child.once('close', () => resolve()));
    this.child.stdin.end();
    const timeout = setTimeout(() => this.child.kill(), 1500);
    await closed;
    clearTimeout(timeout); this.listeners.clear(); this.fail();
  }
}
export async function startCodex(home: string, mode: 'subscription' | 'api' | 'sandbox' = 'sandbox'): Promise<RpcTransport> {
  const executable = await resolveExecutable('codex');
  if (!executable) throw new WorkflowError('codex_missing', 'Install Codex or set AGENT_TOWN_CODEX_EXECUTABLE to its absolute executable path.', 503);
  await mkdir(home, { recursive: true, mode: 0o700 });
  if ((await lstat(home)).isSymbolicLink()) throw new WorkflowError('codex_home_invalid', 'The managed Codex home must not be a link.');
  const rpc = new CodexRpc(executable, home, mode);
  try { await rpc.request('initialize', { clientInfo: { name: 'agent_town', version: '0.2.0' }, capabilities: { experimentalApi: false } }); rpc.notify('initialized', {}); return rpc; }
  catch (error) { await rpc.close(); throw error; }
}
