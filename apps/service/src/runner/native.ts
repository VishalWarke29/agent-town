import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CreateRunDraft, RunnerPreflight, RunTool } from '../../../../packages/contracts/src/runner.js';
import { requireModelProfile } from '../workflow/model-compatibility.js';
import { WorkflowError, sanitizeModelText } from '../workflow/index.js';
import { startCodex, minimalEnvironment, type RpcTransport } from './rpc.js';
import { BoundedOpenAIWorker, sandboxPolicy } from './openai-worker.js';
import { BoundedAnthropicWorker } from './anthropic-worker.js';
import type { ExecutionInput, ExecutionResult, RunExecutor } from './types.js';
import { prepareSourceTree, retainSourceChanges, releaseSourceTree } from './source-tree.js';
import { requireRestrictedReadProtocol } from './sandbox-boundary.js';
import { verifySandboxBoundary } from './sandbox-probes.js';

const execute = promisify(execFile);
const wslExecutable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
export const accountFingerprint = (account: unknown): string => createHash('sha256').update(JSON.stringify(account)).digest('hex');
export class NativeRunExecutor implements RunExecutor {
  constructor(private readonly dataDirectory: string) {}
  validateDraft(draft: CreateRunDraft): void { if (draft.mode === 'api') requireModelProfile(draft.tool === 'anthropic-api' || draft.tool === 'claude' ? 'anthropic' : 'openai', draft.model); }
  subscription(home: string): Promise<RpcTransport> { return startCodex(home, 'subscription'); }
  private async distribution(): Promise<string> {
    const selected = process.env.AGENT_TOWN_WSL_DISTRIBUTION;
    if (!selected || !/^[A-Za-z0-9._-]{1,80}$/.test(selected) || selected.toLowerCase().includes('docker-desktop')) throw new WorkflowError('wsl_setup_required', 'Select a dedicated WSL2 Ubuntu distribution with AGENT_TOWN_WSL_DISTRIBUTION. docker-desktop is not a worker environment.', 503);
    const output = await execute(wslExecutable, ['--list', '--verbose'], { windowsHide: true, timeout: 10000, encoding: 'buffer', env: minimalEnvironment() });
    const listing = output.stdout.toString('utf16le');
    const line = listing.split(/\r?\n/).find(value => value.replace(/^\s*\*?\s*/, '').startsWith(`${selected} `));
    if (!line || !/\s2\s*$/.test(line)) throw new WorkflowError('wsl2_required', 'The selected worker distribution must be WSL2.', 503);
    return selected;
  }
  async preflight(tool: RunTool, worktree?: string): Promise<RunnerPreflight> {
    const checks: RunnerPreflight['checks'] = [];
    if (tool === 'claude') {
      try {
        const distribution = await this.distribution();
        const script = 'const fs=require("node:fs"),cp=require("node:child_process");if(process.getuid()===0)process.exit(3);if(fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")&&fs.readFileSync("/proc/sys/fs/binfmt_misc/WSLInterop","utf8").startsWith("enabled"))process.exit(4);for(const c of ["bwrap","socat"])if(cp.spawnSync("/usr/bin/which",[c]).status!==0)process.exit(5);if(cp.spawnSync("bwrap",["--unshare-all","--ro-bind","/usr","/usr","--ro-bind","/lib","/lib","--proc","/proc","--dev","/dev","/usr/bin/true"]).status!==0)process.exit(6);';
        await execute(wslExecutable, ['--distribution', distribution, '--exec', '/usr/bin/node', '-e', script], { windowsHide: true, timeout: 15000, env: minimalEnvironment() });
        const sdkPath = process.env.AGENT_TOWN_CLAUDE_WSL_SDK_PATH;
        if (!sdkPath || !sdkPath.startsWith('/') || /[\r\n\u0000]/.test(sdkPath)) throw new WorkflowError('claude_sdk_setup_required', 'Set AGENT_TOWN_CLAUDE_WSL_SDK_PATH to the installed Linux SDK sdk.mjs file.');
        await execute(wslExecutable, ['--distribution', distribution, '--exec', '/usr/bin/node', '--input-type=module', '-e', 'import fs from "node:fs";import path from "node:path";const sdk=process.argv[1],m=await import(sdk);if(typeof m.query!=="function"||JSON.parse(fs.readFileSync(path.join(path.dirname(sdk),"package.json"),"utf8")).version!=="0.3.270")process.exit(2)', sdkPath], { windowsHide: true, timeout: 15000, env: minimalEnvironment() });
        checks.push({ name: 'WSL2 and sandbox', passed: true, message: 'Dedicated non-root WSL2, disabled Windows interop, sandbox dependencies, and Linux SDK are available.' });
      } catch (error) { checks.push({ name: 'WSL2 and sandbox', passed: false, message: error instanceof WorkflowError ? error.message : 'The WSL2 SDK or sandbox dependency check failed.' }); }
      checks.push({ name: 'SDK budget enforcement', passed: false, message: 'Native Claude SDK launch is blocked: maxBudgetUsd is not a precharge ceiling and internal auxiliary requests lack a per-request budget broker. Use the separately approved Anthropic API worker.' });
    } else {
      let rpc: RpcTransport | undefined;
      const directory = worktree ?? join(this.dataDirectory, 'preflight-worktree');
      try {
        await requireRestrictedReadProtocol(this.dataDirectory);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        rpc = await startCodex(join(this.dataDirectory, 'preflight-codex'), 'sandbox');
        const readiness = z.object({ status: z.literal('ready') }).safeParse(await rpc.request('windowsSandbox/readiness', {}));
        if (!readiness.success) throw new WorkflowError('codex_sandbox_setup_required', 'Complete the native Codex Windows sandbox setup before managed execution.');
        await verifySandboxBoundary(rpc, directory, this.dataDirectory);
        checks.push({ name: 'Codex filesystem and network sandbox', passed: true, message: 'Source writes passed; protected files, Git objects, junctions, hard-link imports, subprocess escapes and local network probes were denied.' });
      } catch (error) { checks.push({ name: 'Codex filesystem sandbox', passed: false, message: error instanceof WorkflowError ? error.message : 'The isolated Codex sandbox could not be verified.' }); }
      finally { await rpc?.close(); }
      checks.push({ name: 'Execution limits', passed: true, message: tool === 'openai-api' || tool === 'anthropic-api' ? 'The API worker bounds each request and reserves its cost.' : 'Subscription mode uses one outer turn and a supervised deadline. Native internal requests and allowance are not a hard dollar budget.' });
      if (tool === 'codex') checks.push({ name: 'Native tool read boundary', passed: false, message: 'Native Codex execution remains blocked until restricted reads are verified across all built-in tools. Command probes alone do not establish that boundary.' });
    }
    return { tool, ready: checks.every(check => check.passed), checkedAt: new Date().toISOString(), checks };
  }
  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    if (input.draft.tool === 'codex') throw new WorkflowError('native_source_boundary_unverified', 'Native Codex execution cannot start until its built-in tools have a verified restricted-read boundary. No native model turn was started.', 503);
    if (input.draft.tool === 'claude') {
      const readiness = await this.preflight('claude');
      if (!readiness.ready) throw new WorkflowError('claude_budget_broker_required', readiness.checks.filter(value => !value.passed).map(value => value.message).join(' '));
      return this.claude(input);
    }
    await requireRestrictedReadProtocol(this.dataDirectory);
    const source = await prepareSourceTree(input.worktree, this.dataDirectory, input.runId);
    try { return await this.executeSource({ ...input, worktree: source.path }); }
    finally {
      try { await retainSourceChanges(source); }
      finally { releaseSourceTree(source); }
    }
  }
  private async executeSource(input: ExecutionInput): Promise<ExecutionResult> {
    const home = join(this.dataDirectory, 'codex', input.draft.connectionId);
    const rpc = await startCodex(home, input.draft.mode === 'subscription' ? 'subscription' : 'sandbox');
    try {
      if (!z.object({ status: z.literal('ready') }).safeParse(await rpc.request('windowsSandbox/readiness', {})).success) throw new WorkflowError('codex_sandbox_setup_required', 'The selected connection home has not completed native Windows sandbox setup. No model request was started.');
      // Verify the actual RPC connection and actual source root before inference.
      await verifySandboxBoundary(rpc, input.worktree, this.dataDirectory);
      if (input.draft.tool === 'openai-api') return await new BoundedOpenAIWorker().execute(input, rpc);
      if (input.draft.tool === 'anthropic-api') return await new BoundedAnthropicWorker().execute(input, rpc);
      if (input.draft.mode !== 'subscription') throw new WorkflowError('native_codex_api_limits_unsupported', 'Native Codex API mode cannot enforce this app\'s request/output budget. Use the separate OpenAI API worker.');
      const account = z.object({ account: z.unknown() }).parse(await rpc.request('account/read', { refreshToken: false })).account;
      if (!account || accountFingerprint(account) !== input.accountFingerprint) throw new WorkflowError('codex_account_changed', 'The isolated Codex account changed. Reconnect and approve a new run.');
      const thread = z.object({ thread: z.object({ id: z.string() }) }).parse(await rpc.request('thread/start', { model: input.draft.model, cwd: input.worktree, sandbox: 'workspace-write', approvalPolicy: 'never', ephemeral: true, serviceTier: 'default', developerInstructions: 'Work only on the approved task. Do not use other accounts, start subagents, push, merge, deploy, or accept the task. Preserve the supplied project context.' }));
      let turnId: string | null = null;
      let summary = '';
      let resolveFinish!: (result: ExecutionResult) => void;
      const finish = new Promise<ExecutionResult>(resolve => { resolveFinish = resolve; });
      const cancel = () => { if (turnId) void rpc.request('turn/interrupt', { threadId: thread.thread.id, turnId }).catch(() => undefined); resolveFinish({ outcome: 'cancelled', summary: 'Cancellation requested. Review retained changes and native allowance.', usage: null, providerRequests: turnId ? null : 0 }); };
      input.signal.addEventListener('abort', cancel, { once: true });
      const unsubscribe = rpc.subscribe((method, raw) => {
          const decoded = z.object({ threadId: z.string().optional(), turn: z.object({ id: z.string(), status: z.string() }).optional(), item: z.object({ type: z.string(), text: z.string().max(200000).optional() }).optional() }).safeParse(raw);
          if (!decoded.success) return;
          const params = decoded.data;
          if (params.threadId && params.threadId !== thread.thread.id) return;
          if (method === 'item/completed' && params.item?.type === 'agentMessage') summary = params.item.text ?? summary;
          if (method === 'turn/completed' && params.turn) resolveFinish({ outcome: params.turn.status === 'completed' ? 'review' : params.turn.status === 'interrupted' ? 'cancelled' : 'failed', summary: summary.slice(0, 8000) || 'The native turn ended. Review the saved worktree.', usage: null, providerRequests: null });
          if (method === 'account/updated' || method === 'model/rerouted' || method === 'agent-town/transport-closed') { if (turnId) void rpc.request('turn/interrupt', { threadId: thread.thread.id, turnId }).catch(() => undefined); resolveFinish({ outcome: 'failed', summary: 'The isolated native connection, model, or account changed. Review the preserved work and allowance.', usage: null, providerRequests: turnId ? null : 0 }); }
      });
      try {
        if (input.signal.aborted) { cancel(); return await finish; }
        const turn = z.object({ turn: z.object({ id: z.string() }) }).parse(await rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: JSON.stringify({ objective: input.draft.objective, acceptanceCriteria: input.draft.acceptanceCriteria, contextVersion: input.contextVersion, contextBrief: input.contextBrief }) }], cwd: input.worktree, model: input.draft.model, approvalPolicy: 'never', sandboxPolicy: sandboxPolicy(input.worktree), effort: 'low', serviceTierForTurn: 'default' }));
        turnId = turn.turn.id; input.onContextDelivered();
        if (input.signal.aborted) cancel();
        return await finish;
      } finally { unsubscribe(); input.signal.removeEventListener('abort', cancel); }
    } finally { await rpc.close(); }
  }
  private async claude(input: ExecutionInput): Promise<ExecutionResult> {
    const distribution = await this.distribution();
    const sdkPath = process.env.AGENT_TOWN_CLAUDE_WSL_SDK_PATH!;
    const mapped = await execute(wslExecutable, ['--distribution', distribution, '--exec', 'wslpath', '-a', input.worktree], { windowsHide: true, timeout: 10000, env: minimalEnvironment() });
    const workerSource = await readFile(fileURLToPath(new URL('./claude-worker.mjs', import.meta.url)), 'utf8');
    const reservationId = input.onRequestStart(input.draft.price!.contextWindowTokens * input.draft.maxTurns, input.draft.maxOutputTokens * input.draft.maxTurns);
    return new Promise<ExecutionResult>((resolve, reject) => {
      const child = spawn(wslExecutable, ['--distribution', distribution, '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/setsid', '/usr/bin/node', '--input-type=module', '-e', workerSource], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: minimalEnvironment() });
      let buffer = '', pid: number | null = null, settled = false, cancelling = false; let result: ExecutionResult | null = null;
      const cancel = () => { cancelling = true; if (pid && !settled) void execute(wslExecutable, ['--distribution', distribution, '--exec', '/bin/kill', '-TERM', '--', `-${pid}`], { windowsHide: true, timeout: 5000, env: minimalEnvironment() }).catch(() => undefined); };
      input.signal.addEventListener('abort', cancel, { once: true });
      const done = () => {
        if (settled) return; settled = true; input.signal.removeEventListener('abort', cancel);
        try { input.onRequestComplete(reservationId, result?.usage ?? null); }
        catch (error) { reject(error); return; }
        if (result) resolve(result); else if (input.signal.aborted) resolve({ outcome: 'cancelled', summary: 'The WSL worker ended after cancellation. Reconcile unknown provider usage.', usage: null, providerRequests: 0 });
        else reject(new WorkflowError('claude_worker_failed', 'The WSL worker ended before a validated final result.'));
      };
      child.stdout.setEncoding('utf8'); child.stderr.resume();
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 200000) { cancel(); return; }
        for (;;) { const index = buffer.indexOf('\n'); if (index < 0) break; const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const count = z.number().int().nonnegative().max(100_000_000);
            const value = z.discriminatedUnion('type', [z.object({ type: z.literal('ready'), pid: z.number().int().min(2).max(4_194_304) }), z.object({ type: z.literal('context-delivered'), model: z.literal(input.draft.model) }), z.object({ type: z.literal('error'), message: z.string().max(1000) }), z.object({ type: z.literal('result'), model: z.literal(input.draft.model), outcome: z.enum(['review', 'failed', 'cancelled']), summary: z.string().max(8000), providerRequests: z.number().int().nonnegative().max(input.draft.maxTurns), usage: z.object({ inputTokens: count, outputTokens: count, cachedInputTokens: count, cacheWriteTokens: count, reasoningTokens: count.nullable(), source: z.literal('provider-reported') }).nullable() })]).parse(JSON.parse(line));
            if (value.type === 'ready') { if (pid !== null) throw new Error(); pid = value.pid; if (cancelling || input.signal.aborted) cancel(); }
            if (value.type === 'context-delivered') input.onContextDelivered();
            if (value.type === 'result') result = value;
          } catch { cancel(); }
        }
      });
      child.stdin.on('error', cancel);
      child.on('error', done);
      child.on('close', done);
      child.stdin.end(JSON.stringify({ sdkPath, worktree: mapped.stdout.trim(), prompt: sanitizeModelText(JSON.stringify({ objective: input.draft.objective, acceptanceCriteria: input.draft.acceptanceCriteria, contextVersion: input.contextVersion, contextBrief: input.contextBrief }), [input.apiKey ?? '']), apiKey: input.apiKey, model: input.draft.model, maxTurns: input.draft.maxTurns, maxOutputTokens: input.draft.maxOutputTokens, maxMinutes: input.draft.maxMinutes, maxBudgetUsd: input.draft.budgetMicroUsd / 1_000_000 }));
    });
  }
}
