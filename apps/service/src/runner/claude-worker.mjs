// This worker runs inside the selected WSL2 distribution. Configuration arrives
// through stdin; no credential is placed in the command line or a script file.
import { realpath, lstat, mkdtemp } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

let encoded = '';
for await (const chunk of process.stdin) { encoded += chunk; if (encoded.length > 300000) process.exit(2); }
let input;
try { input = JSON.parse(encoded); } catch { process.exit(2); }
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
emit({ type: 'ready', pid: process.pid });
const inside = (root, target) => { const value = relative(root, target); return !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`); };
try {
  const { query } = await import(input.sdkPath);
  const root = await realpath(input.worktree);
  const isolatedHome = await mkdtemp('/tmp/agent-town-worker-');
  const abortController = new AbortController();
  process.on('SIGTERM', () => abortController.abort());
  const timer = setTimeout(() => abortController.abort(), input.maxMinutes * 60000);
  const allowPath = async (candidate, writing) => {
    if (typeof candidate !== 'string') return false;
    const path = resolve(root, candidate);
    if (!inside(root, path) || /(?:^|[\\/])\.(?:git|claude|codex|cursor|env)(?:[\\/.]|$)/i.test(path)) return false;
    try { const actual = await realpath(path); const info = await lstat(actual); return inside(root, actual) && !info.isSymbolicLink() && ((!writing && info.isDirectory()) || (info.isFile() && info.nlink === 1 && info.size <= 128000)); }
    catch { if (!writing) return false; return inside(root, await realpath(dirname(path))); }
  };
  let initialized = false;
  const task = query({ prompt: input.prompt, options: {
    cwd: root, model: input.model, maxTurns: input.maxTurns, maxBudgetUsd: input.maxBudgetUsd,
    effort: 'low', thinking: { type: 'disabled' }, abortController,
    settingSources: [], mcpServers: {}, plugins: [], persistSession: false,
    permissionMode: 'default', allowedTools: [], disallowedTools: ['Agent', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch'],
    env: { PATH: '/usr/bin:/bin', HOME: isolatedHome, CLAUDE_CONFIG_DIR: isolatedHome,
      ANTHROPIC_API_KEY: input.apiKey, ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.maxOutputTokens),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'AgentTown/0.2.0',
    },
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false,
      network: { allowedDomains: [], strictAllowlist: true, allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false },
      filesystem: { denyRead: ['/'], allowRead: [root, '/usr', '/bin', '/lib', '/lib64', '/etc/ssl', '/etc/ld.so.cache', '/dev/null', '/dev/urandom'], allowWrite: [root], denyWrite: [resolve(root, '.git'), isolatedHome] },
      credentials: { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }], files: [{ path: homedir(), mode: 'deny' }] },
    },
    canUseTool: async (name, data) => {
      if (name === 'Bash' && data.dangerouslyDisableSandbox !== true) return { behavior: 'allow', updatedInput: data };
      if (['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(name)) {
        const path = data.file_path ?? data.path ?? root;
        if (await allowPath(path, ['Write', 'Edit'].includes(name))) return { behavior: 'allow', updatedInput: data };
      }
      return { behavior: 'deny', message: 'Agent Town permits only approved worktree tools inside the enforced sandbox.' };
    },
  } });
  for await (const message of task) {
    if (message.type === 'assistant' && !initialized) {
      if (message.message?.model !== input.model) { abortController.abort(); throw new Error('Unexpected model'); }
      initialized = true; emit({ type: 'context-delivered', model: message.message.model });
    }
    if (message.type === 'result') {
      const usage = message.usage;
      const result = {
        type: 'result', model: Object.keys(message.modelUsage ?? {}).length === 1 ? Object.keys(message.modelUsage)[0] : '', outcome: message.subtype === 'success' && !message.is_error ? 'review' : 'failed',
        summary: typeof message.result === 'string' ? message.result.slice(0, 8000) : 'Claude stopped before a complete result. Review the retained worktree.',
        providerRequests: message.num_turns ?? 0,
        usage: usage && Number.isInteger(usage.input_tokens) && Number.isInteger(usage.output_tokens) && Number.isInteger(usage.cache_read_input_tokens) && Number.isInteger(usage.cache_creation_input_tokens)
          ? { inputTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens, outputTokens: usage.output_tokens, cachedInputTokens: usage.cache_read_input_tokens, cacheWriteTokens: usage.cache_creation_input_tokens, reasoningTokens: null, source: 'provider-reported' } : null,
      };
      emit(result);
    }
  }
  clearTimeout(timer);
} catch { emit({ type: 'error', message: 'The Claude worker failed or its sandbox was unavailable. Review usage before retrying.' }); process.exitCode = 1; }
