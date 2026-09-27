import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Most tests here copy a fixture repository and spawn a dozen git processes; on a busy machine the shared 10 s limit is too tight.
vi.setConfig({ testTimeout: 60_000 });

/**
 * FD-01: the dated safety copy. Every test runs against throw-away git repositories under the system temp folder;
 * nothing here reads or writes the real repository, the owner's data folder or the real AgentTownBackups folder.
 */
interface CopyResult {
  destination: string; head: string; branch: string; changedPaths: number;
  patch: { included: number; leftOut: number; bytes: number };
  files: { path: string; sha256: string; size: number }[];
  leftOut: { rule: string; path: string }[];
  scan: { scanned: number; notScanned: number; total: number; byFile: Map<string, Map<string, number>>; byPattern: Map<string, { matches: number; files: number }> };
  warnings: string[]; manifest: string;
}
interface VerifyResult { ok: boolean; checked: number; changed: string[]; missing: string[]; extra: string[]; problems: string[] }
interface SafetyCopyModule {
  createSafetyCopy(options: { label: string; sourceRoot?: string; destRoot?: string; now?: Date; env?: Record<string, string | undefined> }): Promise<CopyResult>;
  verifySafetyCopy(folder: string): VerifyResult;
  classify(relPath: string, isDirectory?: boolean): { copy: boolean; rule?: string };
  denyRule(relPath: string, isDirectory?: boolean): string | null;
  localDate(date: Date): string;
  isEntryPoint(entry: string | undefined, self?: string): boolean;
}

const SCRIPT = fileURLToPath(new URL('../../scripts/safety-copy.mjs', import.meta.url));
const base = mkdtempSync(join(tmpdir(), 'agent-town-safety-'));
const emptyGitConfig = join(base, 'empty.gitconfig');
const links: string[] = [];
/** Creating a file symlink needs a privilege on Windows (EPERM without Developer Mode); folder junctions do not. */
const canLinkFiles = (() => {
  try {
    const target = join(base, 'probe-target.txt'), link = join(base, 'probe-link.txt');
    writeFileSync(target, 'x');
    symlinkSync(target, link, 'file');
    unlinkSync(link);
    return true;
  } catch { return false; }
})();
const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
const DENIED_MARK = 'SENTINEL-DENIED';
// Built at run time so this file never contains a key-shaped string of its own.
const FAKE_KEY = `sk-ant-${'Qx7'.repeat(14)}`;
const FAKE_PRIVATE_KEY_LINE = `-----BEGIN ${'RSA'} PRIVATE KEY-----`;

let mod: SafetyCopyModule;
let repo: string;
let backups: string;
let counter = 0;

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const nextLabel = (prefix: string) => `${prefix}-${++counter}`;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['--no-optional-locks', '-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', windowsHide: true });
}
function put(root: string, rel: string, content: string | Buffer) {
  const target = join(root, ...rel.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
/** A fresh repository with one commit. The guard makes sure no git command can land in any other repository. */
function makeRepo(name: string, committed: Record<string, string | Buffer>) {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '--quiet');
  expect(realpathSync.native(git(root, 'rev-parse', '--show-toplevel').trim())).toBe(realpathSync.native(root));
  for (const [rel, content] of Object.entries(committed)) put(root, rel, content);
  git(root, 'add', '--force', '--all');
  git(root, 'commit', '--quiet', '-m', 'baseline');
  return root;
}
function allFiles(folder: string) {
  const found: string[] = [];
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(directory, entry.name), `${prefix}${entry.name}/`);
      else found.push(`${prefix}${entry.name}`);
    }
  };
  visit(folder, '');
  return found.sort();
}
/** Every file outside .git with its size and mtime, plus the git index mtime: proves the tree was not touched. */
function snapshot(root: string) {
  const files: string[] = [];
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === '.git') continue;
      const info = lstatSync(join(directory, entry.name));
      if (entry.isDirectory()) visit(join(directory, entry.name), `${prefix}${entry.name}/`);
      else files.push(`${prefix}${entry.name}|${info.size}|${info.mtimeMs}`);
    }
  };
  visit(root, '');
  return { files: files.sort(), index: statSync(join(root, '.git', 'index')).mtimeMs, status: git(root, 'status', '--short') };
}
const copy = (label: string, overrides: Partial<Parameters<SafetyCopyModule['createSafetyCopy']>[0]> = {}) =>
  mod.createSafetyCopy({ label, sourceRoot: repo, destRoot: backups, env: {}, ...overrides });
/** Runs a script file as `node FILE ...ARGS`. */
function runNode(script: string, args: string[], cwd?: string) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, ...(cwd ? { cwd } : {}) });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const cli = (...args: string[]) => runNode(SCRIPT, args);
function tamper(destination: string, rel: string, change: (bytes: Buffer) => Buffer) {
  const target = join(destination, ...rel.split('/'));
  writeFileSync(target, change(readFileSync(target)));
}

/**
 * What a copy of the fixture must contain: source, unsaved work, and gitignored docs and instruction files. It includes
 * ordinary source that merely shares a name with something secret (settings.json, hooks.json, env.ts, secrets.ts).
 */
const WANTED = [
  'AGENTS.md', 'CLAUDE.md', 'README.md', 'agent-town.config.example.json', 'package.json', '.gitignore',
  '.claude/agents/helper.md', '.claude/skills/one/SKILL.md', '.github/workflows/ci.yml',
  'apps/service/src/new.ts', 'apps/web/.en[v]', 'apps/web/public/key.svg', 'apps/web/public/pixel.bin', 'apps/web/src/[id].ts', 'apps/web/src/café.ts', 'apps/web/src/dist.ts', 'apps/web/src/env.ts',
  'apps/web/src/hooks.json', 'apps/web/src/main.ts', 'apps/web/src/secrets.ts', 'apps/web/src/settings.json', 'apps/web/src/tokens.json',
  'docs/credentials.md', 'docs/env/guide.md', 'docs/environment.md', 'docs/leak-note.md', 'docs/notes/tmp-plan.md', 'docs/plan.md', 'docs/settings.local.json', 'docs/token-usage.json', 'docs/vault-notes.md',
  'scripts/tool.mjs', 'tests/unit/a.test.ts', 'tests/unit/vault.test.ts',
].sort();
/** Planted files that must never reach a copy. Each holds the sentinel so a leak is found by content as well as name. */
const NEVER = [
  '.data/private/app.sqlite', '.env', '.env.local', '.env.example', 'apps/service/.env.production', 'apps/web/.env', 'agent-town.config.json',
  'AgentTownCredentials/vault.bin', 'docs/credentials/token.txt', 'docs/secrets/notes.md',
  'apps/web/node_modules/pkg/index.js', 'node_modules/left-pad/index.js', 'apps/service/dist/index.js', 'test-results/out.txt', 'playwright-report/index.html', 'tmp/scratch.txt',
  '.claude/settings.local.json', '.claude/settings.json', '.claude/projects/p/log.jsonl', '.claude/skills/one/settings.local.json', '.claude/skills/one/hooks.json', 'tests/fixtures/.claude/settings.local.json',
  '.codex/hooks.json', '.codex/config.toml', '.github/copilot/settings.local.json', '.github/hooks/h.json',
  'docs/server.pem', 'docs/keys/id_rsa', 'docs/db/cache.sqlite', '.npmrc', 'unlisted-folder/file.txt',
  // Look-alikes: other spellings of the same kinds of file.
  'prod.env', 'apps/web/config.env', 'apps/web/production.env', 'docs/notes.env.bak', 'agent-town.config.json.bak', 'docs/server.pem.bak',
  'docs/client_secret_123.json', 'docs/service-account.json', 'docs/secrets.txt', 'docs/keys.json', 'docs/token.json',
  'docs/terraform.tfstate', 'docs/prod.tfvars', 'apps/infra/.terraform/providers.bin',
  '.pgpass', '.vault-token', 'apps/foo/.yarnrc.yml',
];

beforeAll(async () => {
  writeFileSync(emptyGitConfig, '');
  process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  mod = (await import(pathToFileURL(SCRIPT).href)) as SafetyCopyModule;
  backups = join(base, 'backups');

  repo = makeRepo('town repo', {
    '.gitignore': 'node_modules/\ndist/\n.data/\n.codex/\n.claude/\nAGENTS.md\nCLAUDE.md\n/docs/\nagent-town.config.json\n.env\n.env.*\n!.env.example\ntest-results/\ntmp/\n',
    'package.json': '{ "name": "fixture" }\n',
    'README.md': 'v1\n',
    '.env.example': 'EXAMPLE=1\n',
    '.npmrc': 'save-exact=true\n',
    'apps/web/src/main.ts': 'export const v = 1;\n',
    'apps/web/src/café.ts': 'export const c = 1;\n',
    'apps/web/src/[id].ts': 'export const id = 1;\n',
    // Tracked, and a glob that would match the tracked never-copy file next to it if paths were read as patterns.
    'apps/web/.en[v]': 'B=1\n',
    'apps/web/.env': 'A=1\n',
    'apps/web/config.env': 'C=1\n', // tracked look-alike env file, edited below
    'apps/web/src/settings.json': '{ "a": 1 }\n', // tracked source that shares its name with an agent tool's file, edited below
    'apps/web/public/pixel.bin': Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9]),
    'tests/unit/a.test.ts': 'export {};\n',
  });
  // Unsaved work: edits to tracked files (including a binary, a non-ASCII name, glob characters and a never-copy name) ...
  put(repo, 'apps/web/src/main.ts', 'export const v = 2;\n');
  put(repo, 'apps/web/src/café.ts', 'export const c = 2;\n');
  put(repo, 'apps/web/src/[id].ts', 'export const id = 2;\n');
  put(repo, 'apps/web/.en[v]', 'B=2\n');
  put(repo, 'apps/web/public/pixel.bin', Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 10, 11]));
  put(repo, 'apps/web/src/settings.json', '{ "a": 2 }\n');
  put(repo, 'README.md', 'v2\n');
  // ... untracked source, the gitignored docs and instruction files, and look-alike names that are fine to copy.
  for (const rel of ['apps/service/src/new.ts', 'apps/web/src/dist.ts', 'apps/web/src/env.ts', 'apps/web/src/hooks.json', 'apps/web/src/secrets.ts', 'apps/web/src/tokens.json', 'apps/web/public/key.svg', 'scripts/tool.mjs', 'tests/unit/vault.test.ts', 'docs/plan.md', 'docs/environment.md', 'docs/env/guide.md', 'docs/credentials.md', 'docs/settings.local.json', 'docs/token-usage.json', 'docs/vault-notes.md', 'docs/notes/tmp-plan.md', 'agent-town.config.example.json', '.claude/agents/helper.md', '.claude/skills/one/SKILL.md', '.github/workflows/ci.yml']) put(repo, rel, `content of ${rel}\n`);
  put(repo, 'AGENTS.md', 'instructions\n');
  put(repo, 'CLAUDE.md', 'instructions for Claude\n');
  put(repo, 'docs/leak-note.md', `A pasted key ${FAKE_KEY} and\n${FAKE_PRIVATE_KEY_LINE}\n`);
  // The never-copy files. .env.example, .npmrc and apps/web/config.env are tracked, so writing them here also edits
  // them: their changes are in `git diff` and must still stay out of wip.patch.
  for (const rel of NEVER) put(repo, rel, `${DENIED_MARK} ${rel}\n`);
});

afterAll(() => {
  for (const link of links) { try { rmdirSync(link); } catch { try { unlinkSync(link); } catch { /* already gone */ } } }
  const target = realpathSync.native(base), root = realpathSync.native(tmpdir()), rest = relative(root, target);
  if (!rest || rest.startsWith('..') || isAbsolute(rest) || !target.includes('agent-town-safety-')) throw new Error('Unsafe fixture cleanup');
  rmSync(target, { recursive: true, force: true });
  for (const [name, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

describe('what a copy contains', () => {
  it('copies source, unsaved work and the gitignored docs and instruction files, and nothing on the never-copy list', async () => {
    const result = await copy('pre-v0');
    const onDisk = allFiles(result.destination);
    expect(onDisk).toContain('MANIFEST.txt');
    expect(result.files.map(file => file.path).sort()).toEqual([...WANTED.map(rel => `tree/${rel}`), 'status.txt', 'wip.patch'].sort());
    expect(onDisk.filter(path => path !== 'MANIFEST.txt')).toEqual(result.files.map(file => file.path).sort());
    // Nothing on the never-copy list is present by name ...
    const lowered = onDisk.map(path => path.toLowerCase());
    for (const rel of NEVER) expect(lowered, rel).not.toContain(`tree/${rel}`.toLowerCase());
    expect(lowered.filter(path => /(^|\/)(\.data|node_modules|dist|test-results|playwright-report|tmp|\.codex|\.env[^/]*|[^/]*\.env(?:\.[^/]*)?|agent-town\.config\.json[^/]*|\.npmrc)(\/|$)/.test(path))).toEqual([]);
    // settings.json and hooks.json are dropped inside .claude and .codex only; apps/web/src/settings.json is source and is copied.
    expect(lowered.filter(path => /^tree\/\.(?:claude|codex)\/.*(?:settings|hooks)[^/]*\.json$/.test(path))).toEqual([]);
    expect(lowered).toEqual(expect.arrayContaining(['tree/apps/web/src/settings.json', 'tree/apps/web/src/hooks.json', 'tree/docs/settings.local.json']));
    // ... or by content, in the tree, the patch, the status list or the manifest.
    for (const path of onDisk) expect(readFileSync(join(result.destination, ...path.split('/')), 'utf8'), path).not.toContain(DENIED_MARK);
    // What was left out is named, with the rule that removed it.
    const rules = new Map(result.leftOut.map(item => [item.path, item.rule]));
    for (const [path, rule] of [['.data/', 'data-folder'], ['.git/', 'git-metadata'], ['node_modules/', 'dependencies'], ['apps/web/node_modules/', 'dependencies'], ['apps/service/dist/', 'build-output'], ['test-results/', 'build-output'], ['tmp/', 'scratch-folder'], ['.codex/', 'agent-tool-state'], ['.env', 'env-file'], ['.env.local', 'env-file'], ['agent-town.config.json', 'app-config'], ['AgentTownCredentials/', 'credential-folder'], ['docs/credentials/', 'credential-folder'], ['docs/server.pem', 'credential-file'], ['docs/db/cache.sqlite', 'database-file'], ['.npmrc', 'credential-file'], ['unlisted-folder/', 'outside-allowlist'],
      ['prod.env', 'env-file'], ['apps/web/config.env', 'env-file'], ['apps/web/production.env', 'env-file'], ['docs/notes.env.bak', 'env-file'], ['agent-town.config.json.bak', 'app-config'], ['docs/server.pem.bak', 'credential-file'],
      ['docs/client_secret_123.json', 'credential-file'], ['docs/service-account.json', 'credential-file'], ['docs/secrets.txt', 'credential-file'], ['docs/keys.json', 'credential-file'], ['docs/token.json', 'credential-file'],
      ['docs/terraform.tfstate', 'infrastructure-state'], ['docs/prod.tfvars', 'infrastructure-state'], ['apps/infra/.terraform/', 'infrastructure-state'],
      ['.pgpass', 'credential-file'], ['.vault-token', 'credential-file'], ['apps/foo/.yarnrc.yml', 'credential-file']]) {
      expect(rules.get(path), path).toBe(rule);
    }
    // .claude and .github are never listed (their other files are the owner's live settings and hooks); only the copied subfolders are read.
    expect(result.leftOut).toContainEqual({ rule: 'outside-allowlist', path: '.claude/ (all but skills, agents)' });
    expect(result.leftOut).toContainEqual({ rule: 'outside-allowlist', path: '.github/ (all but workflows)' });
    expect(result.leftOut).toContainEqual({ rule: 'agent-tool-state', path: '.claude/skills/one/settings.local.json' });
    expect(result.leftOut).toContainEqual({ rule: 'agent-tool-state', path: '.claude/skills/one/hooks.json' });
    expect(result.leftOut).toContainEqual({ rule: 'agent-tool-state', path: 'tests/fixtures/.claude/' });
    expect(result.leftOut.filter(item => /^\.(claude|github)\//.test(item.path)).map(item => item.path).sort()).toEqual(['.claude/ (all but skills, agents)', '.claude/skills/one/hooks.json', '.claude/skills/one/settings.local.json', '.github/ (all but workflows)']);
    // Nothing that was copied appears in the left-out list, and nothing ordinary is left out for a name it merely shares.
    const leftOutPaths = new Set(result.leftOut.map(item => item.path));
    for (const rel of WANTED) expect(leftOutPaths.has(rel), rel).toBe(false);
  });

  it('records HEAD, the changed-path count and a matching SHA-256 for every file in MANIFEST.txt', async () => {
    const result = await copy(nextLabel('manifest'));
    const text = readFileSync(join(result.destination, 'MANIFEST.txt'), 'utf8');
    expect(text).toContain(`head: ${git(repo, 'rev-parse', 'HEAD').trim()}`);
    const changed = git(repo, 'status', '--short').split('\n').filter(Boolean).length;
    expect(result.changedPaths).toBe(changed);
    expect(text).toContain(`changed-paths: ${changed} `);
    const listed = text.slice(text.indexOf('[files]')).split('\n').slice(1).filter(Boolean).map(line => /^([0-9a-f]{64}) {2}(.+)$/.exec(line)!);
    expect(listed.length).toBe(result.files.length);
    expect(text).toContain(`files: ${listed.length}\n`);
    for (const [, hash, path] of listed) expect(sha256(join(result.destination, ...path.split('/'))), path).toBe(hash);
    expect(text).toMatch(/^label: manifest-\d+$/m);
  });

  it('names the folder LABEL-YYYY-MM-DD with the local date, under the chosen destination root', async () => {
    const now = new Date(2026, 8, 24, 12, 0, 0), label = nextLabel('dated');
    const result = await copy(label, { now });
    expect(result.destination).toBe(join(backups, `${label}-2026-09-24`));
    expect(mod.localDate(now)).toBe('2026-09-24');
    expect(readFileSync(join(result.destination, 'MANIFEST.txt'), 'utf8')).toContain('date: 2026-09-24 (local date used in the folder name)');
    expect(existsSync(`${result.destination}.partial`)).toBe(false);
  });

  it('keeps tracked edits in wip.patch (binary, non-ASCII and glob-character names included) and leaves never-copy names out of it', async () => {
    const result = await copy(nextLabel('patch'));
    const patch = readFileSync(join(result.destination, 'wip.patch'), 'utf8');
    // apps/web/src/settings.json is tracked source that shares a name with an agent tool's file: its edit belongs in the patch.
    for (const rel of ['README.md', 'apps/web/src/main.ts', 'apps/web/src/café.ts', 'apps/web/src/[id].ts', 'apps/web/.en[v]', 'apps/web/public/pixel.bin', 'apps/web/src/settings.json']) expect(patch, rel).toContain(`diff --git a/${rel} b/${rel}`);
    expect(patch).toContain('GIT binary patch');
    expect(patch).not.toContain('.env.example');
    expect(patch).not.toContain('.npmrc');
    expect(patch).not.toContain('apps/web/.env ');
    expect(patch).not.toContain('config.env');
    expect(patch).not.toContain(DENIED_MARK); // also catches a never-copy file pulled in by a pattern such as .en[v]
    expect(result.patch.leftOut).toBe(4); // .env.example, .npmrc, apps/web/.env, apps/web/config.env
    // The patch applies to a clean clone of HEAD, so it can rebuild the unsaved edits.
    const clone = join(base, nextLabel('clone'));
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', repo, clone], { windowsHide: true });
    expect(() => git(clone, 'apply', '--check', join(result.destination, 'wip.patch'))).not.toThrow();
    // status.txt is git status --short without the never-copy names.
    const status = readFileSync(join(result.destination, 'status.txt'), 'utf8');
    expect(status).toContain(' M apps/web/src/main.ts');
    expect(status).toContain('?? apps/service/'); // an untracked folder is one entry, as in git status --short
    expect(status).toContain(' M apps/web/src/settings.json');
    expect(status).not.toContain('config.env');
    expect(status).not.toContain('.npmrc');
    expect(status).not.toContain('tmp/');
  });

  it('leaves the repository exactly as it found it: same files, same mtimes, same git status, same git index', async () => {
    const before = snapshot(repo);
    await copy(nextLabel('readonly'));
    expect(snapshot(repo)).toEqual(before);
  });

  it('does not follow a link out of the repository', async () => {
    const linky = makeRepo('linky repo', { 'docs/a.md': 'a\n' });
    const outside = join(base, 'outside');
    put(outside, 'outside.txt', `${DENIED_MARK} outside\n`);
    const link = join(linky, 'docs', 'linked');
    symlinkSync(outside, link, 'junction');
    links.push(link);
    const result = await copy(nextLabel('links'), { sourceRoot: linky });
    expect(result.leftOut).toContainEqual({ rule: 'link', path: 'docs/linked' });
    expect(result.files.map(file => file.path)).toContain('tree/docs/a.md');
    for (const path of allFiles(result.destination)) expect(path).not.toContain('outside');
  });
});

describe('the never-copy policy', () => {
  it.each([
    ['.data', true, 'data-folder'], ['.data/impl/run.log', false, 'data-folder'], ['.DATA/x', false, 'data-folder'],
    ['.env', false, 'env-file'], ['.env.local', false, 'env-file'], ['.ENV', false, 'env-file'], ['apps/service/.env.production', false, 'env-file'], ['.envrc', false, 'env-file'], ['.env.example', false, 'env-file'],
    ['agent-town.config.json', false, 'app-config'], ['Agent-Town.Config.JSON', false, 'app-config'],
    ['node_modules', true, 'dependencies'], ['apps/web/Node_Modules/x.js', false, 'dependencies'],
    ['apps/web/dist/index.js', false, 'build-output'], ['test-results', true, 'build-output'], ['playwright-report/index.html', false, 'build-output'], ['tests/smoke/__pycache__/a.pyc', false, 'build-output'], ['coverage/lcov.info', false, 'build-output'],
    ['tmp/x', false, 'scratch-folder'], ['.git', true, 'git-metadata'], ['.git', false, 'git-metadata'],
    ['.codex/hooks.json', false, 'agent-tool-state'], ['.claude/settings.local.json', false, 'agent-tool-state'], ['.claude/settings.json', false, 'agent-tool-state'], ['.claude/skills/x/settings.local.json', false, 'agent-tool-state'], ['tests/fixtures/.claude/x.md', false, 'agent-tool-state'],
    ['.claude/skills/x/hooks.json', false, 'agent-tool-state'], ['.claude/agents/settings.json', false, 'agent-tool-state'], ['.CLAUDE/Settings.Local.JSON', false, 'agent-tool-state'], ['.claude/settings.local.json.bak', false, 'agent-tool-state'], ['.cursor/rules.md', false, 'agent-tool-state'],
    ['AgentTownCredentials', true, 'credential-folder'], ['docs/Secrets/x.md', false, 'credential-folder'], ['.ssh/config', false, 'credential-folder'],
    ['.npmrc', false, 'credential-file'], ['docs/server.pem', false, 'credential-file'], ['docs/a.KEY', false, 'credential-file'], ['id_ed25519', false, 'credential-file'], ['credentials.json', false, 'credential-file'], ['.aws/credentials', false, 'credential-folder'], ['credentials', false, 'credential-file'], ['credentials', true, 'credential-folder'],
    ['docs/db/cache.sqlite', false, 'database-file'], ['x.db-wal', false, 'database-file'], ['identity.SQLITE3', false, 'database-file'],
    ['docs/a\nb.md', false, 'unsafe-name'],
  ] as [string, boolean, string][])('never copies %s (%s): %s', (path, isDirectory, rule) => {
    expect(mod.denyRule(path, isDirectory)).toBe(rule);
    expect(mod.classify(path, isDirectory)).toEqual({ copy: false, rule });
  });

  // Look-alikes: the same kinds of file under other spellings. Each row is one of the rules added after review FD-01.
  it.each([
    // env files: prefix, suffix, or in the middle of the name; a file called just "env"; a folder ending in .env
    ['prod.env', false], ['apps/web/config.env', false], ['apps/web/production.env', false], ['docs/notes.env.bak', false], ['apps/x/prod.env.local', false], ['apps/x/Staging.ENV', false],
    ['apps/web/.env.production.old', false], ['docs/nested.env/x.md', false], ['env', false], ['apps/x/env', false], ['env.bak', false], ['docs/env~', false], ['.env', true],
  ] as [string, boolean][])('never copies the env file %s', (path, isDirectory) => {
    expect(mod.denyRule(path, isDirectory)).toBe('env-file');
    expect(mod.classify(path, isDirectory)).toEqual({ copy: false, rule: 'env-file' });
  });

  it.each([
    // a backup copy of a never-copy file is as private as the file
    ['agent-town.config.json.bak', 'app-config'], ['agent-town.config.json~', 'app-config'], ['docs/agent-town.config.json.old', 'app-config'],
    ['docs/server.pem.old', 'credential-file'], ['docs/server.pem.bak.old', 'credential-file'], ['credentials.json~', 'credential-file'], ['.npmrc.orig', 'credential-file'], ['id_rsa.bak', 'credential-file'],
    ['docs/db/cache.sqlite.bak', 'database-file'], ['docs/terraform.tfstate.backup', 'infrastructure-state'], ['docs/secrets.txt.bak', 'credential-file'], ['docs/notes.env.copy', 'env-file'],
  ])('never copies the backup copy %s', (path, rule) => {
    expect(mod.denyRule(path)).toBe(rule);
    expect(mod.classify(path, false)).toEqual({ copy: false, rule });
  });

  it.each([
    // data files named for a secret, in any letter case, with any prefix or suffix on the stem that a tool adds
    'docs/client_secret_123.json', 'docs/client_secret_123.apps.googleusercontent.com.json', 'docs/client-secret.json', 'docs/client_secret.txt',
    'docs/service-account.json', 'docs/service_account_prod.json', 'docs/serviceAccountKey.json', 'docs/serviceaccount.yaml', 'docs/proj-1-firebase-adminsdk-x1-abc.json',
    'docs/secrets.txt', 'docs/Secrets.YAML', 'docs/secret.toml', 'docs/credentials.yml', 'docs/credential.ini', 'docs/credentials.xml',
    'docs/keys.json', 'docs/key.txt', 'docs/api-keys.json', 'docs/api_key.conf', 'docs/apikey.properties',
    'docs/token.json', 'docs/github-token.txt', 'docs/npm_token.yaml', 'docs/Access-Token.json',
    'secrets', 'docs/.secrets', 'docs/.credentials', 'docs/secret',
  ])('never copies the secret file %s', path => {
    expect(mod.denyRule(path, false)).toBe('credential-file');
    expect(mod.classify(path, false)).toEqual({ copy: false, rule: 'credential-file' });
  });

  it.each([
    'docs/apple.p8', 'docs/store.pkcs12', 'docs/backup.gpg', 'docs/site.PFX', 'docs/release.keystore', 'docs/release.jks', 'docs/vault.kdbx', 'docs/putty.ppk', 'docs/id_rsa.pub',
    '.pgpass', 'apps/foo/.vault-token', 'apps/foo/.yarnrc.yml', '.yarnrc', 'apps/foo/.dockercfg', '.s3cfg', 'apps/foo/.my.cnf',
  ])('never copies the credential file %s', path => {
    expect(mod.denyRule(path, false)).toBe('credential-file');
  });

  it.each([
    ['docs/terraform.tfstate', false], ['docs/terraform.tfstate.backup', false], ['docs/terraform.tfstate.1234.backup', false], ['docs/prod.tfvars', false], ['docs/prod.auto.tfvars', false], ['docs/prod.tfvars.json', false], ['docs/terraform.tfvars.example', false], ['docs/prod.tfvars~', false],
    ['infra/.terraform', true], ['infra/.terraform/providers/x.bin', false], ['.TERRAFORM', true],
  ] as [string, boolean][])('never copies the infrastructure state %s', (path, isDirectory) => {
    expect(mod.denyRule(path, isDirectory)).toBe('infrastructure-state');
  });

  it.each([
    'README.md', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'run.ps1', 'agent-town.config.example.json', 'scripts/safety-copy.mjs',
    'apps/web/src/dist.ts', 'apps/service/src/identity/vault.ts', 'tests/unit/vault.test.ts', 'tests/unit/identity-vault.test.ts', 'docs/environment.md', 'docs/notes/tmp-plan.md',
    'docs/assets/audit/2026-09-15-credential-restart-validation.json', 'docs/plan-v5/FD.md', 'tests/smoke/folder-picker/a.ps1',
    '.claude/skills/x/SKILL.md', '.claude/agents/a.md', '.github/workflows/ci.yml',
  ])('copies %s', path => {
    expect(mod.classify(path, false)).toEqual({ copy: true });
  });

  // Ordinary source and documents that merely share a name or a word with something secret are copied.
  it.each([
    // settings.json and hooks.json are the agent tools' live files only inside .claude and .codex
    'apps/web/src/settings.json', 'apps/web/src/hooks.json', 'docs/settings.json', 'docs/settings.local.json', 'scripts/hooks.json', 'tests/fixtures/settings.json', 'apps/web/src/hooks.ts', 'apps/web/src/useSettings.ts',
    // env
    'apps/web/src/env.ts', 'apps/web/src/vite-env.d.ts', 'docs/env/guide.md', 'docs/dev.environment.md', 'apps/web/src/envelope.ts', 'docs/environment-setup.md',
    // secret words in source, documents, media and design tokens
    'apps/web/src/secrets.ts', 'apps/service/src/credentials.ts', 'apps/service/src/client_secret.ts', 'apps/service/src/service-account.ts', 'apps/web/src/keys.ts', 'apps/web/src/keys.d.ts', 'apps/web/public/key.svg', 'apps/web/public/keys.png',
    'docs/credentials.md', 'docs/secrets.md', 'docs/client-secret-handling.md', 'docs/api-key-policy.md', 'tests/helpers/secret-canary.ts', 'scripts/keys.mjs', 'scripts/credentials.ps1',
    'apps/web/src/tokens.json', 'apps/web/src/tokens.css', 'docs/token-usage.json', 'docs/keyboard-keys.json', 'docs/service-accounts.md', 'docs/secretary.txt',
    // backup-like and infrastructure-like words that are not backups or state
    'docs/backup.md', 'docs/notes.bak.md', 'apps/web/src/old.ts', 'docs/terraform-notes.md', 'docs/tfvars-guide.md', 'docs/.terraform.lock.hcl', 'docs/passphrase.md',
  ])('copies the look-alike source file %s', path => {
    expect(mod.denyRule(path, false)).toBeNull();
    expect(mod.classify(path, false)).toEqual({ copy: true });
  });

  it('descends into .claude and .github only towards the allowed subfolders', () => {
    expect(mod.classify('.claude', true)).toEqual({ copy: true });
    expect(mod.classify('.claude/skills', true)).toEqual({ copy: true });
    expect(mod.classify('.github', true)).toEqual({ copy: true });
    expect(mod.classify('.claude/projects/p/log.jsonl', false)).toEqual({ copy: false, rule: 'outside-allowlist' });
    expect(mod.classify('.claude/commands/x.md', false)).toEqual({ copy: false, rule: 'outside-allowlist' });
    expect(mod.classify('.github/hooks/h.json', false)).toEqual({ copy: false, rule: 'outside-allowlist' });
    // Outside .claude and .codex the name settings.local.json is no longer a rule of its own: the allowlist decides.
    expect(mod.classify('.github/copilot/settings.local.json', false)).toEqual({ copy: false, rule: 'outside-allowlist' });
    expect(mod.classify('unknown-folder', true)).toEqual({ copy: false, rule: 'outside-allowlist' });
    expect(mod.classify('unknown-folder/file.txt', false)).toEqual({ copy: false, rule: 'outside-allowlist' });
  });

  it('treats a folder called env, or with a secret word, differently from a file of that name', () => {
    expect(mod.denyRule('docs/env', true)).toBeNull();
    expect(mod.denyRule('docs/keys', true)).toBeNull(); // a folder called keys is not a key file; the rules on its files decide
    expect(mod.denyRule('docs/keys/note.txt', false)).toBeNull();
    expect(mod.denyRule('docs/secrets', true)).toBe('credential-folder');
    expect(mod.denyRule('docs/credentials', true)).toBe('credential-folder');
  });
});

describe('--verify', () => {
  it('passes on a fresh copy', async () => {
    const result = await copy(nextLabel('verify-ok'));
    expect(mod.verifySafetyCopy(result.destination)).toMatchObject({ ok: true, checked: result.files.length, changed: [], missing: [], extra: [], problems: [] });
  });

  it('catches one flipped byte', async () => {
    const result = await copy(nextLabel('verify-flip'));
    tamper(result.destination, 'tree/apps/web/src/main.ts', bytes => { const next = Buffer.from(bytes); next[0] ^= 1; return next; });
    expect(mod.verifySafetyCopy(result.destination)).toMatchObject({ ok: false, changed: ['tree/apps/web/src/main.ts'], missing: [], extra: [] });
  });

  it('catches a same-length replacement and a truncation', async () => {
    const result = await copy(nextLabel('verify-edit'));
    tamper(result.destination, 'tree/README.md', () => Buffer.from('v9\n'));
    tamper(result.destination, 'wip.patch', bytes => bytes.subarray(0, bytes.length - 1));
    expect(mod.verifySafetyCopy(result.destination).changed).toEqual(['tree/README.md', 'wip.patch']);
  });

  it('catches a missing file', async () => {
    const result = await copy(nextLabel('verify-missing'));
    rmSync(join(result.destination, 'tree', 'scripts', 'tool.mjs'));
    expect(mod.verifySafetyCopy(result.destination)).toMatchObject({ ok: false, missing: ['tree/scripts/tool.mjs'], changed: [], extra: [] });
  });

  it('catches an extra file', async () => {
    const result = await copy(nextLabel('verify-extra'));
    put(result.destination, 'tree/docs/added-later.md', 'not in the manifest\n');
    put(result.destination, 'notes.txt', 'not in the manifest\n');
    expect(mod.verifySafetyCopy(result.destination)).toMatchObject({ ok: false, extra: ['notes.txt', 'tree/docs/added-later.md'], changed: [], missing: [] });
  });

  it('catches a folder, or a link to a folder, standing where a listed file should be', async () => {
    const result = await copy(nextLabel('verify-substitute'));
    const outside = join(base, nextLabel('link-target'));
    put(outside, 'x.txt', 'not the listed file\n');
    const folder = join(result.destination, 'tree', 'scripts', 'tool.mjs'), link = join(result.destination, 'tree', 'README.md');
    rmSync(folder); mkdirSync(folder);
    rmSync(link); symlinkSync(outside, link, 'junction'); links.push(link);
    expect(mod.verifySafetyCopy(result.destination)).toMatchObject({ ok: false, changed: ['tree/README.md', 'tree/scripts/tool.mjs'], missing: [], extra: [] });
  });

  it('reports a link added to the copy as an extra entry and does not follow it', async () => {
    const result = await copy(nextLabel('verify-extra-link'));
    const outside = join(base, nextLabel('link-target'));
    put(outside, 'x.txt', 'reachable only through the link\n');
    const link = join(result.destination, 'tree', 'docs', 'linked');
    symlinkSync(outside, link, 'junction'); links.push(link);
    expect(mod.verifySafetyCopy(result.destination)).toMatchObject({ ok: false, extra: ['tree/docs/linked'], changed: [], missing: [] });
  });

  // A file link needs a privilege on Windows; where it cannot be made this test is skipped, and the two above still cover the branch.
  it.skipIf(!canLinkFiles)('catches a link to a file with identical bytes standing where a listed file should be', async () => {
    const result = await copy(nextLabel('verify-file-link'));
    const same = join(base, nextLabel('same-bytes'));
    writeFileSync(same, readFileSync(join(result.destination, 'tree', 'README.md')));
    const file = join(result.destination, 'tree', 'README.md');
    rmSync(file); symlinkSync(same, file, 'file'); links.push(file);
    expect(mod.verifySafetyCopy(result.destination)).toMatchObject({ ok: false, changed: ['tree/README.md'], missing: [], extra: [] });
  });

  it('fails when MANIFEST.txt is missing, cut short, or points outside the folder', async () => {
    const missing = await copy(nextLabel('verify-nomanifest'));
    rmSync(join(missing.destination, 'MANIFEST.txt'));
    expect(mod.verifySafetyCopy(missing.destination).ok).toBe(false);

    const cut = await copy(nextLabel('verify-cut'));
    tamper(cut.destination, 'MANIFEST.txt', bytes => Buffer.from(bytes.toString('utf8').split('\n').slice(0, -6).join('\n') + '\n'));
    const cutResult = mod.verifySafetyCopy(cut.destination);
    expect(cutResult.ok).toBe(false);
    expect(cutResult.problems.join(' ')).toContain('header says');

    const unsafe = await copy(nextLabel('verify-unsafe'));
    tamper(unsafe.destination, 'MANIFEST.txt', bytes => Buffer.from(`${bytes.toString('utf8')}${'0'.repeat(64)}  ../outside.txt\n`));
    expect(mod.verifySafetyCopy(unsafe.destination).problems.join(' ')).toContain('Unsafe path');
  });

  it('exits 0 for a good copy and 1 for a changed one when run as a command', async () => {
    const result = await copy(nextLabel('verify-cli'));
    const good = cli('--verify', result.destination);
    expect(good.code).toBe(0);
    expect(good.out).toContain('OK: every file matches its SHA-256');
    tamper(result.destination, 'tree/README.md', () => Buffer.from('changed\n'));
    const bad = cli('--verify', result.destination);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('FAILED: 1 changed, 0 missing, 0 extra');
    expect(bad.out).toContain('tree/README.md');
    expect(cli('--verify', join(base, 'no such folder')).code).toBe(1);
  });
});

describe('refusals', () => {
  it('refuses a destination inside the repository and writes nothing there', async () => {
    const before = snapshot(repo);
    await expect(copy(nextLabel('inside'), { destRoot: join(repo, 'backups') })).rejects.toThrow(/inside the repository/);
    await expect(copy(nextLabel('inside'), { destRoot: join(repo, 'docs', '..', 'out') })).rejects.toThrow(/inside the repository/);
    await expect(copy(nextLabel('inside'), { destRoot: repo })).rejects.toThrow(/inside the repository/);
    expect(existsSync(join(repo, 'backups'))).toBe(false);
    expect(existsSync(join(repo, 'out'))).toBe(false);
    expect(snapshot(repo)).toEqual(before);
  });

  it('refuses a destination that reaches the repository through a link', async () => {
    const link = join(base, 'alias-of-repo');
    symlinkSync(repo, link, 'junction');
    links.push(link);
    await expect(copy(nextLabel('alias'), { destRoot: join(link, 'sub') })).rejects.toThrow(/inside the repository/);
    expect(existsSync(join(repo, 'sub'))).toBe(false);
  });

  it('refuses a destination that already exists, leaving its contents alone', async () => {
    const now = new Date(2026, 8, 24, 9, 0, 0);
    const existing = join(backups, 'taken-2026-09-24');
    put(existing, 'precious.txt', 'keep me\n');
    await expect(copy('taken', { now })).rejects.toThrow(/already exists/);
    expect(readdirSync(existing)).toEqual(['precious.txt']);
    expect(readFileSync(join(existing, 'precious.txt'), 'utf8')).toBe('keep me\n');
    expect(existsSync(`${existing}.partial`)).toBe(false);
  });

  it('refuses to reuse a label on the same day and keeps the first copy intact', async () => {
    const label = nextLabel('twice');
    const first = await copy(label);
    await expect(copy(label)).rejects.toThrow(/already exists/);
    expect(mod.verifySafetyCopy(first.destination).ok).toBe(true);
  });

  it('never deletes or rotates older copies', async () => {
    const dates = [new Date(2026, 0, 1), new Date(2026, 0, 2), new Date(2026, 0, 3)];
    const made: CopyResult[] = [];
    for (const [index, now] of dates.entries()) made.push(await copy(nextLabel(`series${index}`), { now }));
    const listing = readdirSync(backups).sort();
    for (const item of made) {
      expect(listing).toContain(item.destination.split(/[\\/]/).pop());
      expect(mod.verifySafetyCopy(item.destination).ok).toBe(true);
    }
    await copy(nextLabel('series-latest'), { now: new Date(2026, 0, 4) });
    expect(readdirSync(backups)).toEqual(expect.arrayContaining(listing));
    for (const item of made) expect(mod.verifySafetyCopy(item.destination).ok).toBe(true);
  });

  it('refuses when an interrupted run left its .partial folder, and does not touch it', async () => {
    const now = new Date(2026, 8, 24, 9, 0, 0);
    const partial = join(backups, 'interrupted-2026-09-24.partial');
    put(partial, 'half.txt', 'half a copy\n');
    await expect(copy('interrupted', { now })).rejects.toThrow(/left over from an interrupted run/);
    expect(readdirSync(partial)).toEqual(['half.txt']);
  });

  it('refuses a cloud-synced destination', async () => {
    await expect(copy(nextLabel('sync'), { destRoot: join(base, 'OneDrive - Company', 'backups') })).rejects.toThrow(/not synced/);
    await expect(copy(nextLabel('sync'), { destRoot: join(base, 'Dropbox', 'backups') })).rejects.toThrow(/not synced/);
    const synced = join(base, 'somewhere');
    mkdirSync(synced, { recursive: true });
    await expect(copy(nextLabel('sync'), { destRoot: join(synced, 'backups'), env: { OneDrive: synced } })).rejects.toThrow(/inside the OneDrive folder/);
    expect(existsSync(join(base, 'OneDrive - Company'))).toBe(false);
    expect(existsSync(join(base, 'Dropbox'))).toBe(false);
  });

  it.each(['', '.hidden', '../up', 'a/b', 'a\\b', 'with space', 'x'.repeat(49), 'ünï'])('refuses the label %j', async label => {
    await expect(copy(label)).rejects.toThrow(/--label/);
  });

  it('refuses a folder that is not a git repository, or has no commits', async () => {
    const plain = join(base, 'plain folder');
    mkdirSync(plain, { recursive: true });
    await expect(copy(nextLabel('plain'), { sourceRoot: plain })).rejects.toThrow(/git repository/);
    const empty = join(base, 'empty repo');
    mkdirSync(empty, { recursive: true });
    git(empty, 'init', '--quiet');
    await expect(copy(nextLabel('empty'), { sourceRoot: empty })).rejects.toThrow(/no commits/);
    await expect(copy(nextLabel('sub'), { sourceRoot: join(repo, 'apps') })).rejects.toThrow(/top folder/);
  });
});

describe('the secret-shape scan', () => {
  it('reports counts and file names, and never the matched text', async () => {
    const label = nextLabel('scan');
    const run = cli('--label', label, '--source', repo, '--dest-root', backups);
    expect(run.code).toBe(0);
    const destination = /Safety copy written: (.+)/.exec(run.out)![1].trim();
    expect(run.out).toContain('secret-shape scan: 2 match(es) in 1 of');
    expect(run.out).toContain('anthropic-api-key: 1 in 1 file(s)');
    expect(run.out).toContain('private-key-block: 1 in 1 file(s)');
    expect(run.out).toContain('tree/docs/leak-note.md  anthropic-api-key=1, private-key-block=1');
    const manifest = readFileSync(join(destination, 'MANIFEST.txt'), 'utf8');
    expect(manifest).toContain('file tree/docs/leak-note.md: anthropic-api-key=1, private-key-block=1');
    for (const text of [run.out, run.err, manifest, readFileSync(join(destination, 'status.txt'), 'utf8'), readFileSync(join(destination, 'wip.patch'), 'utf8')]) {
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain(FAKE_PRIVATE_KEY_LINE);
      expect(text).not.toContain('Qx7Qx7');
    }
  });

  it('does not scan binary files, and counts them', async () => {
    const result = await copy(nextLabel('scan-binary'));
    expect(result.scan.notScanned).toBeGreaterThanOrEqual(1);
    expect(result.scan.byFile.has('tree/apps/web/public/pixel.bin')).toBe(false);
  });
});

describe('running it as a command', () => {
  it('writes a dated copy, prints where and how to check it, and the copy verifies', () => {
    const run = cli('--label', 'pre-v0', '--source', repo, '--dest-root', join(base, 'cli backups'));
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/Safety copy written: .+pre-v0-\d{4}-\d{2}-\d{2}/);
    expect(run.out).toContain('changed paths (git status --short):');
    expect(run.out).toContain('--verify');
    const destination = /Safety copy written: (.+)/.exec(run.out)![1].trim();
    expect(cli('--verify', destination).code).toBe(0);
    const again = cli('--label', 'pre-v0', '--source', repo, '--dest-root', join(base, 'cli backups'));
    expect(again.code).toBe(2);
    expect(again.err).toContain('already exists');
    expect(cli('--verify', destination).code).toBe(0);
  });

  it('exits 2 with usage for a missing or unknown argument, and 0 for --help', () => {
    for (const args of [[], ['--lable', 'x'], ['--label'], ['--label', 'a', '--verify', 'b'], ['--dest-root', 'somewhere']]) {
      const run = cli(...args);
      expect(run.code, args.join(' ')).toBe(2);
    }
    expect(cli('--help').code).toBe(0);
    expect(cli('--help').out).toContain('--verify FOLDER');
  });

  it('refuses a destination inside the repository from the command line without creating it', () => {
    const run = cli('--label', 'inner', '--source', repo, '--dest-root', join(repo, 'safety'));
    expect(run.code).toBe(2);
    expect(run.err).toContain('inside the repository');
    expect(existsSync(join(repo, 'safety'))).toBe(false);
  });
});

/**
 * The guard that tells "started as a command" from "imported" once compared only one side after normalising it, so a
 * lower-case drive letter (the project context shows `c:\projects\Agent`) made the command do nothing and exit 0.
 */
describe('being started by any spelling of its path', () => {
  const missing = join(base, 'no such copy');
  const drive = (path: string) => (path[0] === path[0].toLowerCase() ? path[0].toUpperCase() : path[0].toLowerCase()) + path.slice(1);
  // The file name keeps its case: Node only treats ".mjs" (not ".MJS") as a module.
  const spellings = () => [['the drive letter in the other case', drive(SCRIPT)], ['all lower case', SCRIPT.toLowerCase()], ['folders in upper case', `${dirname(SCRIPT).toUpperCase()}${sep}${basename(SCRIPT)}`], ['forward slashes', drive(SCRIPT).replace(/\\/g, '/')]] as const;

  it.skipIf(process.platform !== 'win32')('fails loudly on a missing copy and prints help, whatever the letter case of the path', () => {
    for (const [what, script] of spellings()) {
      const verify = runNode(script, ['--verify', missing]);
      expect(verify.code, what).toBe(1);
      expect(verify.out, what).toContain('Verify:');
      const help = runNode(script, ['--help']);
      expect(help.code, what).toBe(0);
      expect(help.out, what).toContain('Usage:');
      expect(runNode(script, []).code, what).toBe(2);
    }
  });

  it.skipIf(process.platform !== 'win32')('still makes the copy when started with a lower-case path', () => {
    const destRoot = join(base, 'lower case backups');
    const run = runNode(SCRIPT.toLowerCase(), ['--label', 'via-lower', '--source', repo, '--dest-root', destRoot]);
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    expect(run.out).toContain('Safety copy written:');
    const destination = /Safety copy written: (.+)/.exec(run.out)![1].trim();
    expect(mod.verifySafetyCopy(destination).ok).toBe(true);
  });

  it('runs when started with a relative path from another folder', () => {
    const run = runNode(relative(base, SCRIPT), ['--verify', missing], base);
    expect(run.code).toBe(1);
    expect(run.out).toContain('Verify:');
  });

  it('recognises its own file by real path, and nothing else', () => {
    expect(mod.isEntryPoint(SCRIPT)).toBe(true);
    expect(mod.isEntryPoint(`${dirname(SCRIPT)}${sep}..${sep}scripts${sep}${basename(SCRIPT)}`)).toBe(true); // a detour through .., not normalised here
    if (process.platform === 'win32') for (const [what, script] of spellings()) expect(mod.isEntryPoint(script), what).toBe(true);
    expect(mod.isEntryPoint(fileURLToPath(import.meta.url))).toBe(false); // another file that exists
    expect(mod.isEntryPoint(join(base, 'no-such-script.mjs'))).toBe(false);
    expect(mod.isEntryPoint('')).toBe(false);
    expect(mod.isEntryPoint(undefined)).toBe(false);
  });

  it('is not fooled by another file that has the same name and the same bytes', () => {
    const original = join(base, 'files', 'safety-copy.mjs'), namesake = join(base, 'other files', 'safety-copy.mjs');
    mkdirSync(dirname(original), { recursive: true });
    mkdirSync(dirname(namesake), { recursive: true });
    copyFileSync(SCRIPT, original);
    copyFileSync(SCRIPT, namesake);
    expect(mod.isEntryPoint(original, original)).toBe(true);
    expect(mod.isEntryPoint(namesake, original)).toBe(false);
  });

  it('sees a hard link as the same file, by its file id', ctx => {
    const original = join(base, 'hard files', 'safety-copy.mjs'), linked = join(base, 'hard files', 'linked.mjs');
    mkdirSync(dirname(original), { recursive: true });
    copyFileSync(SCRIPT, original);
    try { linkSync(original, linked); } catch { ctx.skip(); }
    expect(mod.isEntryPoint(linked, original)).toBe(true);
  });

  it('does nothing, and prints nothing, when another script only imports it', () => {
    put(base, 'importer/importer.mjs', `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});\n`);
    const destRoot = join(base, 'importer backups');
    const run = runNode(join(base, 'importer', 'importer.mjs'), ['--label', 'never-made', '--dest-root', destRoot]);
    expect(run).toEqual({ code: 0, out: '', err: '' });
    expect(existsSync(destRoot)).toBe(false);
  });

  it('never exits 0 silently when it is started under its own file name but cannot be matched to itself', () => {
    put(base, 'namesake/safety-copy.mjs', `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});\n`);
    const destRoot = join(base, 'namesake backups');
    const run = runNode(join(base, 'namesake', 'safety-copy.mjs'), ['--label', 'never-made', '--dest-root', destRoot]);
    expect(run.code).toBe(1);
    expect(run.err).toContain('could not be matched to this script');
    expect(run.out).toBe('');
    expect(existsSync(destRoot)).toBe(false);
  });
});
