import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Pins the managed-run boundary from docs/23-managed-execution.md ("Native Claude SDK
// foundation"): a managed worker never loads skills, plugins, MCP servers, or ambient
// settings, and it can never read a tool's own configuration/rules directory, because those
// are outside the pinned instructions the run was approved against and can execute scripts a
// person never reviewed. This test reads the worker's own source text; it never starts a
// worker, spawns a process, or calls a model, so it stays fast and needs no WSL/SDK setup.
const source = readFileSync(join(__dirname, '..', '..', 'apps', 'service', 'src', 'runner', 'claude-worker.mjs'), 'utf8');

describe('managed Claude worker: no approved way to load skills', () => {
  it('starts the query with no setting sources, plugins, or MCP servers', () => {
    expect(source).toMatch(/settingSources:\s*\[\]/);
    expect(source).toMatch(/plugins:\s*\[\]/);
    expect(source).toMatch(/mcpServers:\s*\{\}/);
  });

  it('disallows the Skill tool explicitly', () => {
    const match = /disallowedTools:\s*\[([^\]]*)\]/.exec(source);
    expect(match, 'expected a disallowedTools array literal in the worker source').not.toBeNull();
    const entries = (match![1].match(/'[^']*'|"[^"]*"/g) ?? []).map(entry => entry.slice(1, -1));
    expect(entries).toContain('Skill');
  });

  it('refuses to read or write inside a tool configuration directory (.claude, .codex, .cursor)', () => {
    // allowPath's own denial pattern, not a re-implementation of it: this fails if that
    // pattern is edited to drop any of these directories. Bounded to just before the try
    // block so it captures the denial line and nothing from later in the function.
    const match = /allowPath\s*=[\s\S]*?try \{/.exec(source);
    expect(match, 'expected an allowPath denial check in the worker source').not.toBeNull();
    const guard = match![0];
    for (const tool of ['claude', 'codex', 'cursor']) expect(guard).toContain(tool);
  });

  it('fails if any of these protections is removed (verified against a mutated copy)', () => {
    // Each mutation below removes exactly one of the settings this file pins. Re-running the
    // same assertions against the mutated text must fail, proving these checks are not
    // vacuous. This does not touch the real file; it only mutates an in-memory copy of its text.
    const mutations: { label: string; mutate: (text: string) => string }[] = [
      { label: 'settingSources', mutate: text => text.replace('settingSources: []', 'settingSources: ["user"]') },
      { label: 'plugins', mutate: text => text.replace('plugins: []', 'plugins: ["example"]') },
      { label: 'mcpServers', mutate: text => text.replace('mcpServers: {}', 'mcpServers: { example: {} }') },
      { label: 'Skill in disallowedTools', mutate: text => text.replace("'Skill', ", '') },
      { label: 'allowPath .claude/.codex/.cursor', mutate: text => text.replace('claude|codex|cursor|env', 'env') },
    ];
    for (const { label, mutate } of mutations) {
      const mutated = mutate(source);
      expect(mutated, `mutation "${label}" did not change the source; the assertion below would not be a real check`).not.toBe(source);
      const stillProtected = /settingSources:\s*\[\]/.test(mutated) && /plugins:\s*\[\]/.test(mutated) && /mcpServers:\s*\{\}/.test(mutated)
        && (() => { const disallowed = /disallowedTools:\s*\[([^\]]*)\]/.exec(mutated); return !!disallowed && disallowed[1].includes('Skill'); })()
        && (() => { const guard = /allowPath\s*=[\s\S]*?try \{/.exec(mutated); return !!guard && ['claude', 'codex', 'cursor'].every(tool => guard[0].includes(tool)); })();
      expect(stillProtected, `mutation "${label}" should have broken at least one protection`).toBe(false);
    }
  });

  it('never starts a worker or calls a model', () => {
    // This suite only reads a local file's text; nothing here can spawn the worker (which
    // requires a WSL distribution, a Linux SDK path, and stdin configuration) or reach a model.
    expect(source.length).toBeGreaterThan(0);
  });
});
