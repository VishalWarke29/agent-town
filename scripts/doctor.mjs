import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRuntimeConfig, runtimeDataPaths } from './runtime-config.mjs';

const execute = promisify(execFile), require = createRequire(import.meta.url);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const add = (name, status, message) => checks.push({ name, status, message });
let configuration, privateDirectory = null;
try {
  configuration = readRuntimeConfig();
  privateDirectory = runtimeDataPaths(configuration.mode).privateDirectory;
  const detail = configuration.mode === 'demo' ? 'Sample data only; real connections and paid work are disabled.'
    : configuration.mode === 'production' ? 'Separate production data; loopback only, not hosted deployment.' : 'Real local workspaces; sample town is optional.';
  add('Application mode', 'ok', `${configuration.mode} (${configuration.modeSource}). ${detail}`);
} catch { add('Application mode', 'error', 'The application mode or local data configuration is invalid. Use the fields in the example file. Values were not printed.'); }
const inside = (root, path) => { const part = relative(root.toLowerCase(), path.toLowerCase()); return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };
function executable(names) {
  const path = Object.entries(process.env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory) || inside(project, directory) || privateDirectory && inside(privateDirectory, directory)) continue;
    for (const name of names) {
      try { const candidate = realpathSync(join(directory, name)); if (statSync(candidate).isFile() && !inside(project, candidate)) return candidate; } catch { /* Not installed here. */ }
    }
  }
  return null;
}
async function versionCheck(name, candidates, pattern) {
  const path = executable(candidates);
  if (!path) { add(name, 'unavailable', `${name} was not found on a trusted executable path.`); return; }
  try {
    const result = await execute(path, ['--version'], { windowsHide: true, timeout: 2000, maxBuffer: 4000,
      env: { PATH: dirname(path), SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });
    const version = pattern.exec(`${result.stdout}\n${result.stderr}`)?.[1];
    add(name, version ? 'ok' : 'unverified', version ? `Version ${version}` : 'Installed; version output was not recognized.');
  } catch { add(name, 'unverified', 'Installed; version check could not finish.'); }
}

const nodeVersion = process.versions.node.split('.').map(Number);
add('Node', nodeVersion[0] === 24 && nodeVersion[1] >= 14 ? 'ok' : 'error', `Version ${process.versions.node}; requires Node 24.14 or later in the 24.x series.`);
try {
  const lock = readFileSync(join(project, 'package-lock.json'));
  const expected = createHash('sha256').update(lock).digest('hex');
  const stamp = readFileSync(join(project, 'node_modules/.agent-town-lock'), 'utf8').trim().toLowerCase();
  add('Dependencies', stamp === expected ? 'ok' : 'attention', stamp === expected ? 'Installed dependencies match the lockfile stamp.' : 'The startup script will refresh dependencies for the changed lockfile.');
} catch { add('Dependencies', 'attention', 'Dependencies or their lockfile stamp are missing. Normal startup can install the locked packages.'); }
let SQLite;
try { SQLite = require('better-sqlite3'); const memory = new SQLite(':memory:'); memory.prepare('SELECT 1').get(); memory.close(); add('SQLite runtime', 'ok', 'The native SQLite module loads.'); }
catch { add('SQLite runtime', 'error', 'The native SQLite module could not load. Run npm exec --yes --package=npm@12.0.2 -- npm ci using the required Node version.'); }
if (configuration?.mode === 'demo') add('GitHub configuration', 'disabled', 'GitHub sign-in is disabled in demo mode; configured IDs are not used.');
else if (configuration) add('GitHub configuration', configuration.githubClientId ? 'ok' : 'attention', configuration.githubClientId ? 'A public GitHub client ID is configured. Account authentication was not requested.' : 'Add the public GitHub client ID to the local configuration to enable sign-in.');
await Promise.all([
  versionCheck('Git', process.platform === 'win32' ? ['git.exe'] : ['git'], /git version ([0-9]+(?:\.[0-9]+){1,3}(?:\.windows\.\d+)?)/u),
  versionCheck('Python', process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'], /Python ([0-9.]+)/u),
]);
for (const [name, names] of [['Codex', ['codex.cmd', 'codex.exe']], ['Claude', ['claude.cmd', 'claude.exe']], ['Cursor', ['cursor.cmd', 'cursor.exe']], ['Copilot', ['copilot.cmd', 'copilot.exe']], ['WSL', ['wsl.exe']]]) {
  const found = executable(process.platform === 'win32' ? names : [name.toLowerCase()]);
  add(name, found ? 'unverified' : 'unavailable', found ? 'Executable found. Provider authentication and sandbox enforcement are checked separately before use.' : 'Optional tool was not found.');
}
if (configuration?.mode === 'demo') add('Private data', 'disabled', 'Demo mode does not open private identity registries.');
else if (privateDirectory && SQLite && existsSync(join(privateDirectory, 'app.sqlite'))) {
  let database;
  try {
    const path = join(privateDirectory, 'app.sqlite'), info = lstatSync(path);
    if (info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('Unsupported diagnostic file');
    if (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0) {
      add('Private data', 'unverified', 'The identity registry has a write-ahead log. Use the running service or an offline backup for a consistent integrity check.');
    } else {
    // Deserialize into memory so diagnostics never create SQLite sidecar files.
    database = new SQLite(readFileSync(path), { readonly: true });
    database.pragma('trusted_schema = OFF');
    const integrity = database.pragma('quick_check', { simple: true });
    const count = database.prepare('SELECT count(*) AS count FROM private_workspaces').get().count;
    add('Private data', integrity === 'ok' ? 'ok' : 'error', integrity === 'ok' ? `Identity registry passes SQLite quick_check; ${count} registered workspaces. Paths and account identifiers were omitted.` : 'Identity registry integrity check failed. Preserve the files and validate a backup.');
    }
  } catch { add('Private data', 'error', 'The identity registry could not be checked. No data was modified.'); }
  finally { database?.close(); }
} else add('Private data', 'unavailable', 'No existing private identity registry was found, or SQLite is unavailable.');
const port = Number(process.env.AGENT_TOWN_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) add('Local service', 'error', 'The configured service port is invalid.');
else {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > 16_384) throw new Error('Unrecognized health response'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const matchingMode = configuration && body.applicationMode === configuration.mode;
    add('Local service', response.ok && body.ok === true && matchingMode ? 'ok' : 'attention', response.ok && body.ok === true ? `Agent Town is responding on loopback port ${port}.${matchingMode ? ' Its application mode matches.' : ' Its mode is different or unavailable; restart the intended instance.'}` : `Port ${port} answered but did not return Agent Town health.`);
  } catch { add('Local service', 'attention', `Agent Town did not answer on loopback port ${port}. Doctor does not start or stop it.`); }
}
const report = { version: 1, checkedAt: new Date().toISOString(), platform: process.platform, applicationMode: configuration?.mode ?? null, paidRequests: 0, checks };
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report)}\n`);
else { process.stdout.write('Agent Town doctor — read-only checks\n'); for (const check of checks) process.stdout.write(`[${check.status}] ${check.name}: ${check.message}\n`); }
if (checks.some(check => check.status === 'error')) process.exitCode = 1;
