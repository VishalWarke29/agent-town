#!/usr/bin/env node
/**
 * Dated safety copy of the work that exists only on this disk (FD-01).
 *
 *   npm run safety-copy -- --label NAME             write %USERPROFILE%\AgentTownBackups\NAME-YYYY-MM-DD
 *   npm run safety-copy -- --verify FOLDER          re-hash a copy; non-zero on any changed, missing or extra file
 *   options: --dest-root DIR (default %USERPROFILE%\AgentTownBackups), --source DIR (default: this repository)
 *
 * Layout of a copy:  tree/  (the files)   wip.patch  (git diff --binary against HEAD, tracked files only)
 *                    status.txt (git status --short)   MANIFEST.txt (HEAD, counts, SHA-256 of every file, scan)
 *
 * Two lists both have to allow a path before it is copied. The allowlist is only apps, packages, tests, scripts,
 * docs, .claude/skills, .claude/agents, .github/workflows and the files directly in the repository root. The
 * denylist then removes, at any depth and whatever the letter case: .git, .data, node_modules, build output, tmp,
 * env files (.env*, *.env, *.env.*), agent-town.config.json, credential folders, key and certificate-store files,
 * data files named for a secret (secrets.txt, keys.json, client_secret_1.json, service-account.json, token.json),
 * Terraform state and variables, databases, and the agent tools' own state (.codex, .cursor, nested .claude, and
 * settings*.json / hooks.json inside a .claude or .codex folder). A backup copy of any of these (.bak, .old, ~)
 * is denied too. Links are never followed. The script only reads the repository (git runs with --no-optional-locks),
 * writes one new folder outside it, and never deletes or rotates anything.
 *
 * The secret-shape scan counts common key shapes in the copied text files. It prints counts and file names and
 * never keeps or prints the matched text.
 *
 * This file needs ./atomic-write.mjs (and its .d.mts): commit them together.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renameWithRetry } from './atomic-write.mjs';

export const FORMAT = 'agent-town-safety-copy/1';
export const MANIFEST_NAME = 'MANIFEST.txt';
const TREE = 'tree', PATCH_NAME = 'wip.patch', STATUS_NAME = 'status.txt';
const SCAN_LIMIT = 8 * 1024 * 1024;
const LIST_LIMIT = 30;
const SELF = fileURLToPath(import.meta.url);
const SCRIPT_ROOT = resolve(dirname(SELF), '..');

/** Folders copied, relative to the repository root. Root-level files are copied too (subject to the denylist). */
export const SOURCE_ROOTS = ['apps', 'packages', 'tests', 'scripts', 'docs', '.claude/skills', '.claude/agents', '.github/workflows'];

const DENIED_NAMES = new Map([
  ['.git', 'git-metadata'],
  ['.data', 'data-folder'],
  ['node_modules', 'dependencies'],
  ['dist', 'build-output'], ['coverage', 'build-output'], ['test-results', 'build-output'], ['playwright-report', 'build-output'], ['__pycache__', 'build-output'],
  ['tmp', 'scratch-folder'],
  ['.codex', 'agent-tool-state'], ['.cursor', 'agent-tool-state'],
  ['agent-town.config.json', 'app-config'],
  ['.npmrc', 'credential-file'], ['.netrc', 'credential-file'], ['_netrc', 'credential-file'], ['.pypirc', 'credential-file'], ['.git-credentials', 'credential-file'], ['.htpasswd', 'credential-file'],
  ['.pgpass', 'credential-file'], ['.vault-token', 'credential-file'], ['.yarnrc.yml', 'credential-file'], ['.yarnrc', 'credential-file'], ['.dockercfg', 'credential-file'], ['.s3cfg', 'credential-file'], ['.my.cnf', 'credential-file'],
  ['credentials.json', 'credential-file'], ['secrets.json', 'credential-file'],
  ['.ssh', 'credential-folder'], ['.aws', 'credential-folder'], ['.gnupg', 'credential-folder'], ['.azure', 'credential-folder'], ['.kube', 'credential-folder'], ['.docker', 'credential-folder'],
  ['.terraform', 'infrastructure-state'],
]);
const CREDENTIAL_FOLDER = /credential|secret/;
const CREDENTIAL_FILE = /\.(?:pem|key|pfx|p12|p8|pkcs12|jks|keystore|kdbx|ppk|gpg)$|^id_(?:rsa|dsa|ecdsa|ed25519)/;
const DATABASE_FILE = /\.(?:sqlite3?|db)(?:-wal|-shm|-journal)?$/;
const INFRASTRUCTURE_FILE = /\.(?:tfstate|tfvars)(?:\.|$)/; // terraform.tfstate(.backup), prod.tfvars, x.auto.tfvars, x.tfvars.json
// settings.json, settings.local.json and hooks.json are the agent tools' live files only inside their own folders;
// elsewhere they are ordinary source (apps/web/src/settings.json).
const AGENT_TOOL_FOLDERS = new Set(['.claude', '.codex']);
const AGENT_TOOL_FILE = /^(?:settings[^/]*|hooks)\.json$/;
// A backup of a secret is as secret as the original: notes.env.bak, credentials.json~, server.pem.old.
const BACKUP_SUFFIX = /(?:\.(?:bak|backup|old|orig|save|swp|copy)|~)+$/;
// A data file named for a secret. The stem is the name up to its first dot, so client_secret_1.apps.example.com.json counts.
// Plural "tokens" is left out on purpose (design tokens); source code and documents (secrets.ts, credentials.md) are copied.
const SECRET_STEM = /^(?:secrets?|credentials?|(?:api[_-]?)?keys?|(?:(?:api|auth|access|refresh|bearer|github|npm)[_-]?)?token|client[_-]?secrets?(?:[_-].*)?|service[_-]?account(?:[_-]?keys?)?(?:[_-].*)?|.*firebase-adminsdk.*)$/;
const SECRET_DATA_EXTENSIONS = new Set(['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'xml', 'csv', 'tsv', 'txt', 'dat', 'bin', 'enc', 'secret', 'secrets']);
const SYNCED_FOLDER = /^(?:one ?drive.*|dropbox.*|google ?drive.*|icloud.*|box sync|pcloud.*)$/i;

/** Common key shapes. Only counts leave this module; the matched text is never stored or printed. */
const SECRET_SHAPES = [
  ['private-key-block', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
  ['anthropic-api-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-style-key', /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g],
  ['aws-access-key-id', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['stripe-live-key', /\b[sr]k_live_[A-Za-z0-9]{16,}/g],
  ['json-web-token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['bearer-credential', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g],
  ['credential-assignment', /(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*["'][A-Za-z0-9/+_=.-]{20,}["']/gi],
];

/** A refusal that changes nothing (exit code 2). A UsageError is a refusal caused by the command line itself. */
export class Refusal extends Error {}
export class UsageError extends Refusal {}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const toPosix = value => value.split(sep).join('/');
const formatBytes = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`);
const pad2 = value => String(value).padStart(2, '0');
export const localDate = date => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** .env, .env.local, prod.env, notes.env.bak (and a file called just "env"); not environment.md or vite-env.d.ts. */
const isEnvName = (core, isFile) => core.startsWith('.env') || core.endsWith('.env') || core.includes('.env.') || (isFile && core === 'env');

/** secrets.txt, .credentials, keys.json, client_secret_1.json, service-account.json, token.json; not secrets.ts or key.svg. */
function isSecretFile(core) {
  const firstDot = core.indexOf('.');
  if (firstDot < 1) return /^\.?(?:secrets?|credentials?)$/.test(core);
  return SECRET_DATA_EXTENSIONS.has(core.slice(core.lastIndexOf('.') + 1)) && SECRET_STEM.test(core.slice(0, firstDot));
}

/** The denylist. Returns the rule name when the path (relative to the repository root, using "/") must never be copied. */
export function denyRule(relPath, isDirectory = false) {
  if (/[\u0000-\u001f]/.test(relPath)) return 'unsafe-name'; // a line break in a name would corrupt the manifest
  const segments = relPath.split('/').filter(Boolean).map(segment => segment.toLowerCase());
  for (let index = 0; index < segments.length; index++) {
    const name = segments[index], core = name.replace(BACKUP_SUFFIX, '') || name, last = index === segments.length - 1;
    const byName = DENIED_NAMES.get(core);
    if (byName) return byName;
    if (name === '.claude' && index > 0) return 'agent-tool-state';
    if (AGENT_TOOL_FILE.test(core) && segments.slice(0, index).some(parent => AGENT_TOOL_FOLDERS.has(parent))) return 'agent-tool-state';
    if (isEnvName(core, last && !isDirectory)) return 'env-file';
    if ((!last || isDirectory) && CREDENTIAL_FOLDER.test(name)) return 'credential-folder';
    if (last && (CREDENTIAL_FILE.test(core) || isSecretFile(core))) return 'credential-file';
    if (last && INFRASTRUCTURE_FILE.test(core)) return 'infrastructure-state';
    if (last && DATABASE_FILE.test(core)) return 'database-file';
  }
  return null;
}

/** The allowlist. A folder that only leads to an allowed folder (for example ".claude") counts as allowed. */
function allowed(segments, isDirectory) {
  if (segments.length === 1 && !isDirectory) return true;
  const lower = segments.map(segment => segment.toLowerCase());
  return SOURCE_ROOTS.some(root => {
    const parts = root.split('/');
    if (lower.length >= parts.length) return parts.every((part, index) => part === lower[index]);
    return isDirectory && lower.every((part, index) => part === parts[index]);
  });
}

/** Both lists: `{ copy: true }` or `{ copy: false, rule }`. */
export function classify(relPath, isDirectory = false) {
  const rule = denyRule(relPath, isDirectory);
  if (rule) return { copy: false, rule };
  return allowed(relPath.split('/').filter(Boolean), isDirectory) ? { copy: true } : { copy: false, rule: 'outside-allowlist' };
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** realpath for a path whose tail may not exist yet: resolve the nearest existing ancestor, then re-append the rest. */
function realpathLoose(path) {
  const tail = [];
  let current = resolve(path);
  for (;;) {
    try { return join(realpathSync.native(current), ...tail.reverse()); }
    catch (error) {
      const parent = dirname(current);
      if (error?.code !== 'ENOENT' || parent === current) throw error;
      tail.push(basename(current)); current = parent;
    }
  }
}

function syncedFolderReason(realDestination, env) {
  for (const name of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (env[name] && isInside(realDestination, realpathLoose(env[name]))) return `inside the ${name} folder`;
  }
  const hit = realDestination.split(/[\\/]+/).find(segment => SYNCED_FOLDER.test(segment));
  return hit ? `inside a folder named "${hit}"` : null;
}

function git(root, args) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', '-C', root, ...args], { maxBuffer: 1 << 30, windowsHide: true });
  if (result.error) throw new Error(`Could not run git: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.find(value => !value.startsWith('-')) ?? ''} failed: ${result.stderr.toString('utf8').trim()}`);
  return result.stdout;
}
const gitText = (root, args) => git(root, args).toString('utf8').trim();
const splitNul = buffer => buffer.toString('utf8').split('\0').filter(Boolean);

/** Entries of `git status --porcelain=v1 -z` (an untracked folder is one entry, like `git status --short`). */
function statusEntries(root) {
  const tokens = splitNul(git(root, ['status', '--porcelain=v1', '-z']));
  const entries = [];
  for (let index = 0; index < tokens.length; index++) {
    const code = tokens[index].slice(0, 2), path = tokens[index].slice(3);
    const renamed = code[0] === 'R' || code[0] === 'C';
    entries.push({ code, path, from: renamed ? tokens[++index] : null });
  }
  return entries;
}

function buildPatch(root, head) {
  const names = splitNul(git(root, ['diff', '--name-only', '-z', '--no-renames', head]));
  const included = names.filter(name => !denyRule(name, false));
  const groups = [];
  let group = [], length = 0;
  for (const name of included) {
    if (length + name.length > 20000 && group.length) { groups.push(group); group = []; length = 0; }
    group.push(name); length += name.length + 3;
  }
  if (group.length) groups.push(group);
  const parts = groups.map(paths => git(root, ['--literal-pathspecs', 'diff', '--binary', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', head, '--', ...paths]));
  return { bytes: Buffer.concat(parts), included: included.length, leftOut: names.length - included.length };
}

function walk(root, rel, found) {
  const entries = readdirSync(join(root, ...rel.split('/')), { withFileTypes: true }).sort((a, b) => compare(a.name, b.name));
  for (const entry of entries) {
    const childRel = `${rel}/${entry.name}`, decision = classify(childRel, entry.isDirectory());
    if (!decision.copy) found.leftOut.push({ path: entry.isDirectory() ? `${childRel}/` : childRel, rule: decision.rule });
    else if (entry.isSymbolicLink()) found.leftOut.push({ path: childRel, rule: 'link' });
    else if (entry.isDirectory()) walk(root, childRel, found);
    else if (entry.isFile()) found.files.push(childRel);
    else found.leftOut.push({ path: childRel, rule: 'not-a-regular-file' });
  }
}

/** The files to copy and everything deliberately left out. The repository root is listed once; the roots are then walked. */
function collect(root) {
  const found = { files: [], leftOut: [] };
  const roots = new Set(SOURCE_ROOTS.map(value => value.split('/')[0].toLowerCase()));
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    const decision = classify(entry.name, entry.isDirectory());
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (!decision.copy) found.leftOut.push({ path: `${entry.name}/`, rule: decision.rule });
      else if (SOURCE_ROOTS.includes(entry.name.toLowerCase())) walk(root, entry.name, found);
      else if (roots.has(entry.name.toLowerCase())) {
        // Only some subfolders are copied, so the parent is never listed (it holds files such as .claude/settings.local.json).
        const kept = SOURCE_ROOTS.filter(value => value.toLowerCase().startsWith(`${entry.name.toLowerCase()}/`));
        for (const path of kept) if (lstatSafe(join(root, ...path.split('/')))?.isDirectory()) walk(root, path, found);
        found.leftOut.push({ path: `${entry.name}/ (all but ${kept.map(value => value.slice(entry.name.length + 1)).join(', ')})`, rule: 'outside-allowlist' });
      }
    } else if (!decision.copy) found.leftOut.push({ path: entry.name, rule: decision.rule });
    else if (entry.isSymbolicLink()) found.leftOut.push({ path: entry.name, rule: 'link' });
    else if (entry.isFile()) found.files.push(entry.name);
    else found.leftOut.push({ path: entry.name, rule: 'not-a-regular-file' });
  }
  return found;
}

function lstatSafe(path) {
  try { return lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

/** SHA-256 and size of a file. A file up to the scan limit is read once and handed back so it can be scanned too. */
function digest(path) {
  if (statSync(path).size <= SCAN_LIMIT) {
    const bytes = readFileSync(path);
    return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, bytes };
  }
  const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1 << 20), fd = openSync(path, 'r');
  let size = 0;
  try { for (;;) { const read = readSync(fd, chunk, 0, chunk.length, null); if (!read) break; hash.update(chunk.subarray(0, read)); size += read; } }
  finally { closeSync(fd); }
  return { sha256: hash.digest('hex'), size, bytes: null };
}

/** Counts of each key shape in a file, or null when it is not scanned (binary, or over the size limit). */
function scanBytes(bytes) {
  if (!bytes) return null;
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString('utf16le');
  else if (bytes.subarray(0, 8000).includes(0)) return null;
  else text = bytes.toString('utf8');
  const counts = new Map();
  for (const [name, pattern] of SECRET_SHAPES) {
    const count = text.match(pattern)?.length ?? 0;
    if (count) counts.set(name, count);
  }
  return counts;
}

function copyTree(root, stage, files, warnings) {
  const entries = [], failures = [];
  for (const rel of files) {
    const segments = rel.split('/'), source = join(root, ...segments), target = join(stage, TREE, ...segments);
    const before = lstatSafe(source);
    if (!before) { warnings.push(`vanished before it was copied: ${rel}`); continue; }
    if (!before.isFile()) { warnings.push(`no longer a regular file, not copied: ${rel}`); continue; }
    try {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      const after = lstatSafe(source);
      if (!after) warnings.push(`removed while it was being copied: ${rel}`);
      else {
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) warnings.push(`changed while it was being copied: ${rel}`);
        utimesSync(target, after.atime, after.mtime);
      }
      entries.push({ path: `${TREE}/${rel}`, target });
    } catch (error) {
      if (error?.code === 'ENOENT' && !lstatSafe(source)) warnings.push(`vanished while it was being copied: ${rel}`);
      else failures.push(`${rel} (${error?.code ?? error?.message})`);
    }
  }
  if (failures.length) throw new Error(`Could not copy ${failures.length} file(s), so the copy was not completed (left in ${stage}): ${failures.slice(0, 10).join(', ')}. Close whatever holds them open and run again.`);
  return entries;
}

function statusText(entries) {
  const lines = [], hidden = entries.filter(entry => denyRule(entry.path.replace(/\/$/, ''), entry.path.endsWith('/')) || (entry.from && denyRule(entry.from, false)));
  for (const entry of entries) if (!hidden.includes(entry)) lines.push(`${entry.code} ${entry.from ? `${entry.from} -> ` : ''}${entry.path}`);
  if (hidden.length) lines.push(`# ${hidden.length} entr${hidden.length === 1 ? 'y' : 'ies'} not listed (never-copy names such as .env, credentials, tmp)`);
  return `${lines.join('\n')}\n`;
}

const formatCounts = counts => [...counts].sort(([a], [b]) => compare(a, b)).map(([name, count]) => `${name}=${count}`).join(', ');

function manifestText({ label, createdAt, sourceRoot, head, branch, changedPaths, patch, files, bytes, leftOut, warnings, scan }) {
  const lines = [
    'Agent Town safety copy',
    `format: ${FORMAT}`,
    `label: ${label}`,
    `date: ${localDate(createdAt)} (local date used in the folder name)`,
    `created: ${createdAt.toISOString()}`,
    `source: ${sourceRoot}`,
    `head: ${head}`,
    `branch: ${branch}`,
    `changed-paths: ${changedPaths} (entries of git status --short; an untracked folder counts once)`,
    `patch: ${PATCH_NAME} holds ${patch.included} changed tracked path(s), ${patch.leftOut} left out by the never-copy rules; untracked files are in ${TREE}/`,
    `files: ${files.length}`,
    `bytes: ${bytes}`,
    `warnings: ${warnings.length ? warnings.length : 'none'}`,
    ...warnings.map(warning => `  ${warning}`),
    '',
    '[secret-shape scan] counts and file names only; matched text is never recorded',
    `scanned: ${scan.scanned} text file(s); not scanned (binary or over ${formatBytes(SCAN_LIMIT)}): ${scan.notScanned}`,
    `matches: ${scan.total} in ${scan.byFile.size} file(s)`,
    ...[...scan.byPattern].sort(([a], [b]) => compare(a, b)).map(([name, value]) => `  ${name}: ${value.matches} match(es) in ${value.files} file(s)`),
    ...[...scan.byFile].sort(([a], [b]) => compare(a, b)).map(([path, counts]) => `  file ${path}: ${formatCounts(counts)}`),
    '',
    '[left out] rule, path (folders end with /)',
    ...leftOut.map(item => `  ${item.rule}  ${item.path}`),
    '',
    '[files] SHA-256 (same as Get-FileHash -Algorithm SHA256, lower case), path relative to this folder',
    ...files.map(file => `${file.sha256}  ${file.path}`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Writes the copy into a new folder next to any older ones and returns what it did. It refuses (a Refusal, or a
 * UsageError for a bad label) before writing anything when the source is not a git top level with a commit, the
 * destination is inside the repository or a cloud-synced folder, or the destination (or its .partial) already exists.
 */
export async function createSafetyCopy({ label, sourceRoot = SCRIPT_ROOT, destRoot = join(homedir(), 'AgentTownBackups'), now = new Date(), env = process.env } = {}) {
  if (typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(label)) throw new UsageError('--label needs a name of letters, digits, dot, dash or underscore (at most 48, starting with a letter or digit).');
  const root = realpathSync.native(resolve(sourceRoot));
  let topLevel;
  try { topLevel = realpathSync.native(gitText(root, ['rev-parse', '--show-toplevel'])); }
  catch (error) { throw new Refusal(`${root} is not inside a git repository (${error.message}).`); }
  if (relative(root, topLevel) !== '') throw new Refusal(`${root} is not the top folder of its git repository (${topLevel}).`);
  let head;
  try { head = gitText(root, ['rev-parse', '--verify', 'HEAD']); } catch { throw new Refusal('The repository has no commits yet, so there is no HEAD to record.'); }

  const destination = join(resolve(destRoot), `${label}-${localDate(now)}`), stage = `${destination}.partial`;
  const realDestination = realpathLoose(destination);
  if (isInside(realDestination, root)) throw new Refusal(`Refusing to write inside the repository: ${destination}. A copy in the same folder does not survive a mistake in it; use a folder outside it.`);
  const synced = syncedFolderReason(realDestination, env);
  if (synced) throw new Refusal(`Refusing to write ${synced}: ${destination}. The copy holds private text; use a folder that is not synced to a cloud service (--dest-root).`);
  if (lstatSafe(destination)) throw new Refusal(`Refusing to overwrite ${destination}: it already exists. Choose another --label; older copies are never replaced or deleted.`);
  if (lstatSafe(stage)) throw new Refusal(`${stage} is left over from an interrupted run. Inspect it and remove it yourself, then run again; this script deletes nothing.`);

  const branch = gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const before = statusEntries(root), warnings = [];
  const patch = buildPatch(root, head);
  const found = collect(root);
  mkdirSync(resolve(destRoot), { recursive: true });
  mkdirSync(stage);
  const copied = copyTree(root, stage, found.files, warnings);
  const after = statusEntries(root);
  if (JSON.stringify(after) !== JSON.stringify(before)) warnings.push('git status changed while copying (something edited the tree); rerun when it is quiet for an exact copy');
  writeFileSync(join(stage, PATCH_NAME), patch.bytes);
  writeFileSync(join(stage, STATUS_NAME), statusText(before));

  const files = [], scan = { scanned: 0, notScanned: 0, total: 0, byFile: new Map(), byPattern: new Map() };
  let bytes = 0;
  for (const item of [...copied, { path: PATCH_NAME, target: join(stage, PATCH_NAME) }, { path: STATUS_NAME, target: join(stage, STATUS_NAME) }]) {
    const { sha256, size, bytes: content } = digest(item.target);
    files.push({ path: item.path, sha256, size }); bytes += size;
    const counts = scanBytes(content);
    if (!counts) { scan.notScanned++; continue; }
    scan.scanned++;
    if (!counts.size) continue;
    scan.byFile.set(item.path, counts);
    for (const [name, count] of counts) {
      const entry = scan.byPattern.get(name) ?? { matches: 0, files: 0 };
      entry.matches += count; entry.files++; scan.total += count; scan.byPattern.set(name, entry);
    }
  }
  files.sort((a, b) => compare(a.path, b.path));
  const leftOut = found.leftOut.sort((a, b) => compare(a.rule, b.rule) || compare(a.path, b.path));
  const manifest = manifestText({ label, createdAt: now, sourceRoot: root, head, branch, changedPaths: before.length, patch, files, bytes, leftOut, warnings, scan });
  writeFileSync(join(stage, MANIFEST_NAME), manifest);
  if (lstatSafe(destination)) throw new Refusal(`${destination} appeared while copying; the finished copy stays in ${stage}.`);
  try { await renameWithRetry(stage, destination, 8, 4000); }
  catch (error) { throw new Error(`The copy is complete but could not be renamed into place (${error?.code ?? error?.message}); it is in ${stage}. Rename it yourself once nothing has it open.`); }
  return { destination, label, head, branch, changedPaths: before.length, patch: { included: patch.included, leftOut: patch.leftOut, bytes: patch.bytes.length }, files, bytes, leftOut, scan, warnings, manifest };
}

/** Re-hashes every file a copy's MANIFEST.txt lists. `ok` only when nothing is changed, missing or extra. */
export function verifySafetyCopy(folder) {
  const result = { ok: false, folder, checked: 0, changed: [], missing: [], extra: [], problems: [], label: null, head: null, created: null };
  let text;
  try { text = readFileSync(join(folder, MANIFEST_NAME), 'utf8'); }
  catch (error) { result.problems.push(`${MANIFEST_NAME} cannot be read (${error?.code ?? error?.message}); this is not a complete safety copy.`); return result; }
  const lines = text.split(/\r?\n/), marker = lines.findIndex(line => line.startsWith('[files]'));
  if (marker < 0) { result.problems.push(`${MANIFEST_NAME} has no [files] section.`); return result; }
  const header = new Map();
  for (const line of lines.slice(0, marker)) { const match = /^([a-z-]+): (.*)$/.exec(line); if (match && !header.has(match[1])) header.set(match[1], match[2]); }
  if (header.get('format') !== FORMAT) result.problems.push(`Unsupported manifest format "${header.get('format') ?? 'none'}" (expected ${FORMAT}).`);
  result.label = header.get('label') ?? null; result.head = header.get('head') ?? null; result.created = header.get('created') ?? null;

  const listed = new Map();
  for (const line of lines.slice(marker + 1)) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) { result.problems.push(`Unreadable manifest line: ${line.slice(0, 80)}`); continue; }
    const [, sha256, path] = match, segments = path.split('/');
    if (path === MANIFEST_NAME || path.includes('\\') || isAbsolute(path) || segments.some(segment => !segment || segment === '.' || segment === '..')) { result.problems.push(`Unsafe path in the manifest: ${path}`); continue; }
    if (listed.has(path)) { result.problems.push(`Listed twice in the manifest: ${path}`); continue; }
    listed.set(path, sha256);
  }
  if (Number(header.get('files')) !== listed.size) result.problems.push(`The manifest header says ${header.get('files') ?? 'nothing'} file(s) but lists ${listed.size}.`);

  for (const [path, expected] of [...listed].sort(([a], [b]) => compare(a, b))) {
    const file = join(folder, ...path.split('/')), info = lstatSafe(file);
    result.checked++;
    if (!info) result.missing.push(path);
    else if (!info.isFile() || digest(file).sha256 !== expected) result.changed.push(path);
  }
  const present = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(directory, entry.name), `${prefix}${entry.name}/`);
      else present.push(`${prefix}${entry.name}`);
    }
  };
  visit(folder, '');
  result.extra = present.filter(path => path !== MANIFEST_NAME && !listed.has(path)).sort(compare);
  result.ok = !result.changed.length && !result.missing.length && !result.extra.length && !result.problems.length;
  return result;
}

function listLines(title, items) {
  return items.length ? [`  ${title}: ${items.length}`, ...items.slice(0, LIST_LIMIT).map(item => `    ${item}`), ...(items.length > LIST_LIMIT ? [`    ... and ${items.length - LIST_LIMIT} more`] : [])] : [];
}

export function describeCopy(result) {
  const byRule = new Map();
  for (const item of result.leftOut) byRule.set(item.rule, (byRule.get(item.rule) ?? 0) + 1);
  return [
    `Safety copy written: ${result.destination}`,
    `  HEAD ${result.head} on ${result.branch}; changed paths (git status --short): ${result.changedPaths}`,
    `  files copied: ${result.files.length - 2} (${formatBytes(result.bytes)} with wip.patch and status.txt); wip.patch: ${result.patch.included} tracked path(s)${result.patch.leftOut ? `, ${result.patch.leftOut} left out by the never-copy rules` : ''}`,
    `  left out by rule: ${byRule.size ? [...byRule].sort(([a], [b]) => compare(a, b)).map(([rule, count]) => `${rule} ${count}`).join(', ') : 'nothing'} (full list in ${MANIFEST_NAME})`,
    ...listLines('left out', result.leftOut.map(item => `${item.rule}  ${item.path}`)),
    `  secret-shape scan: ${result.scan.total} match(es) in ${result.scan.byFile.size} of ${result.scan.scanned} text file(s); ${result.scan.notScanned} binary or large file(s) not scanned (archives and images are not opened)`,
    ...[...result.scan.byPattern].sort(([a], [b]) => compare(a, b)).map(([name, value]) => `    ${name}: ${value.matches} in ${value.files} file(s)`),
    ...listLines('files with matches (names only)', [...result.scan.byFile].sort(([a], [b]) => compare(a, b)).map(([path, counts]) => `${path}  ${formatCounts(counts)}`)),
    ...listLines('warnings', result.warnings),
    `  Check it with: npm run safety-copy -- --verify "${result.destination}"`,
  ].join('\n');
}

export function describeVerify(result) {
  return [
    `Verify: ${result.folder}`,
    ...(result.label ? [`  label ${result.label}, created ${result.created}, HEAD ${result.head}`] : []),
    `  checked ${result.checked} file(s)`,
    ...listLines('changed', result.changed), ...listLines('missing', result.missing), ...listLines('extra', result.extra), ...listLines('problems', result.problems),
    result.ok ? '  OK: every file matches its SHA-256 and nothing extra is present.' : `  FAILED: ${result.changed.length} changed, ${result.missing.length} missing, ${result.extra.length} extra, ${result.problems.length} manifest problem(s).`,
  ].join('\n');
}

const USAGE = [
  'Usage:',
  '  npm run safety-copy -- --label NAME [--dest-root DIR] [--source DIR]',
  '  npm run safety-copy -- --verify FOLDER',
  '',
  'Writes %USERPROFILE%\\AgentTownBackups\\NAME-YYYY-MM-DD (never inside the repository, never over an existing folder).',
  '--verify re-hashes every file in MANIFEST.txt and exits 1 on any changed, missing or extra file.',
].join('\n');

export function parseArgs(argv) {
  const options = { label: null, verify: null, destRoot: null, source: null, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index], eq = arg.startsWith('--') ? arg.indexOf('=') : -1, name = eq > 0 ? arg.slice(0, eq) : arg;
    const value = () => {
      if (eq > 0) return arg.slice(eq + 1);
      const next = argv[++index];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${name} needs a value.`);
      return next;
    };
    if (name === '--label') options.label = value();
    else if (name === '--verify') options.verify = value();
    else if (name === '--dest-root') options.destRoot = value();
    else if (name === '--source') options.source = value();
    else if (name === '--help' || name === '-h') options.help = true;
    else throw new UsageError(`Unknown option: ${arg}`);
  }
  return options;
}

async function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.help) { process.stdout.write(`${USAGE}\n`); return; }
    if (options.label !== null && options.verify !== null) throw new UsageError('Use --label or --verify, not both.');
    if (options.verify !== null) {
      const result = verifySafetyCopy(resolve(options.verify));
      process.stdout.write(`${describeVerify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
    } else if (options.label !== null) {
      const result = await createSafetyCopy({ label: options.label, ...(options.source ? { sourceRoot: options.source } : {}), ...(options.destRoot ? { destRoot: options.destRoot } : {}) });
      process.stdout.write(`${describeCopy(result)}\n`);
    } else throw new UsageError('Give --label NAME to make a copy or --verify FOLDER to check one.');
  } catch (error) {
    process.stderr.write(`safety-copy: ${error instanceof Error ? error.message : String(error)}\n${error instanceof UsageError ? `\n${USAGE}\n` : ''}`);
    process.exitCode = error instanceof Refusal ? 2 : 1;
  }
}

/**
 * True when `entry` (process.argv[1]) is this very file, however its path was spelled. Real paths are compared on
 * both sides, without regard to letter case on Windows ("c:\projects\..." and "C:\PROJECTS\..." are one file), and a
 * matching file id covers hard links. A backup tool that does nothing and exits 0 is worse than one that fails.
 */
export function isEntryPoint(entry, self = SELF) {
  if (!entry) return false;
  try {
    const first = realpathSync.native(entry), second = realpathSync.native(self);
    if (process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second) return true;
    const one = statSync(first, { bigint: true }), two = statSync(second, { bigint: true });
    return one.ino !== 0n && one.ino === two.ino && one.dev === two.dev;
  } catch { return false; }
}

const entry = process.argv[1];
if (isEntryPoint(entry)) await main(process.argv.slice(2));
else if (entry && basename(entry).toLowerCase() === basename(SELF).toLowerCase()) {
  // Started under this file's own name yet not matched to it: say so instead of exiting 0 having done nothing.
  process.stderr.write(`safety-copy: started as ${entry}, which could not be matched to this script (${SELF}), so nothing was done.\n`);
  process.exitCode = 1;
}
