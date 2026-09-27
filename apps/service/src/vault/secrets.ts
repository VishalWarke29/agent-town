import type { VaultSecretFinding } from '@agent-town/contracts';

/** Offline pattern rules only — no network call, no third-party "verified" mode that would phone a
 * live provider with the very secret this gate exists to catch (the risk the security review found
 * in TruffleHog's verified mode before any Project Vault code was written). False negatives are
 * accepted; a false positive only costs the owner one extra click to deselect a file. */
interface Rule { id: string; pattern: RegExp }
const RULES: Rule[] = [
  { id: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/g },
  { id: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,48}/g },
  { id: 'stripe-live-key', pattern: /sk_live_[A-Za-z0-9]{24,}/g },
  { id: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { id: 'private-key-block', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: 'jwt-like-token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'assigned-secret-value', pattern: /(?:api[_-]?key|secret|access[_-]?token|password)\s*[:=]\s*['"]?([A-Za-z0-9+/_=-]{20,})['"]?/gi },
];
const PLACEHOLDER = /changeme|your[_-]|xxxx|example|placeholder|<[^>]*>|\$\{|%\{|redacted|dummy|sample/i;

function redact(match: string): string {
  const trimmed = match.trim();
  if (trimmed.length <= 8) return '*'.repeat(trimmed.length);
  return `${trimmed.slice(0, 4)}${'*'.repeat(Math.min(trimmed.length - 6, 24))}${trimmed.slice(-2)}`;
}

/** Bounded to text files under the caller's own size cap; binary/huge files are never passed in. */
export function findSecrets(path: string, content: string): VaultSecretFinding[] {
  if (content.includes('\u0000')) return [];
  const findings: VaultSecretFinding[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && findings.length < 200; i++) {
    const line = lines[i]!;
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(line))) {
        const value = match[1] ?? match[0];
        if (!PLACEHOLDER.test(value)) findings.push({ path, line: i + 1, ruleId: rule.id, redactedSnippet: redact(value) });
        if (rule.pattern.lastIndex === match.index) rule.pattern.lastIndex++;
        if (findings.length >= 200) break;
      }
    }
  }
  return findings;
}
