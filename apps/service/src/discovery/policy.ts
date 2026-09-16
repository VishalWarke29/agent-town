import type { InstructionMetadata } from './types';

export const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', 'bin', 'obj',
  '__pycache__', 'venv', '.venv', 'env', '.env', '.git', '.data', '.cache', '.next', '.nuxt',
  '.turbo', '.parcel-cache', '.pytest_cache', '.mypy_cache', '.tox', '.idea', '.vscode',
  '.ssh', '.aws', '.azure', '.gnupg', '.npm', '.yarn', '.pnpm-store', '.gradle', '.terraform',
]);
const TOOL_DIRECTORIES = new Set(['.claude', '.codex', '.cursor', '.github']);

export function isExcludedDirectory(name: string): boolean {
  const lower = name.toLowerCase();
  return EXCLUDED_DIRECTORIES.has(lower) || lower.startsWith('.') && !TOOL_DIRECTORIES.has(lower);
}

export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')
    || /(?:^|[._-])(auth|credentials?|secrets?|tokens?|sessions?|history|transcripts?|cookies?)(?:[._-]|$)/u.test(lower)
    || /\.(pem|key|p12|pfx|jks|keystore)$/u.test(lower) || /^id_(rsa|dsa|ecdsa|ed25519)/u.test(lower);
}

type InstructionKind = Pick<InstructionMetadata, 'tool' | 'kind' | 'scope'>;

/** This is a metadata allowlist, not a provider precedence or instruction execution engine. */
export function classifyInstruction(relativePath: string): InstructionKind | null {
  const parts = relativePath.replaceAll('\\', '/').split('/');
  if (parts.some(isSecretName)) return null;
  const filename = parts.at(-1)!;
  const lower = filename.toLowerCase();
  const scope = parts.slice(0, -1).join('/') || '.';
  if (filename === 'AGENTS.md' || filename === 'AGENTS.override.md') return { tool: 'shared', kind: 'instructions', scope };
  if (filename === 'CLAUDE.md' || filename === 'CLAUDE.local.md') return { tool: 'claude', kind: 'instructions', scope };
  const toolIndex = parts.findIndex(part => TOOL_DIRECTORIES.has(part));
  if (toolIndex < 0) return null;
  const toolDir = parts[toolIndex];
  const tail = parts.slice(toolIndex + 1);
  const toolScope = parts.slice(0, toolIndex).join('/') || '.';
  const toolNames: Record<string, InstructionMetadata['tool']> = { '.claude': 'claude', '.codex': 'codex', '.cursor': 'cursor', '.github': 'copilot' };
  const tool = toolNames[toolDir];
  if (tail.length === 1 && (
    tool === 'claude' && ['settings.json', 'settings.local.json'].includes(lower)
    || tool === 'codex' && lower === 'config.toml'
  )) return { tool, kind: 'settings', scope: toolScope };
  if (tail.length === 1 && lower === 'hooks.json' && ['claude', 'cursor'].includes(tool)) return { tool, kind: 'hooks', scope: toolScope };
  if (tool === 'copilot' && tail.length === 1 && lower === 'copilot-instructions.md') return { tool, kind: 'instructions', scope: toolScope };
  if (tail[0] === 'agents' && /\.(md|toml)$/u.test(lower)) return { tool, kind: 'agent', scope: toolScope };
  if (tail[0] === 'skills' && lower === 'skill.md') return { tool, kind: 'skill', scope: toolScope };
  if (['claude', 'cursor'].includes(tool) && tail[0] === 'rules' && /\.(md|mdc)$/u.test(lower)) return { tool, kind: 'rules', scope: toolScope };
  if (tool === 'codex' && tail[0] === 'rules' && lower.endsWith('.rules')) return { tool, kind: 'rules', scope: toolScope };
  if (tool === 'copilot' && tail[0] === 'instructions' && lower.endsWith('.instructions.md')) return { tool, kind: 'instructions', scope: toolScope };
  if (tool === 'copilot' && tail[0] === 'hooks' && lower.endsWith('.json')) return { tool, kind: 'hooks', scope: toolScope };
  return null;
}
