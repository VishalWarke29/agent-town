import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const identifier = /^[A-Za-z0-9_.-]{0,100}$/u;

export function normalizeApplicationMode(value) {
  if (typeof value !== 'string') throw new Error('Application mode must be demo, development, or production.');
  const mode = value.trim().toLowerCase();
  if (mode === 'prod') return 'production';
  if (mode === 'demo' || mode === 'development' || mode === 'production') return mode;
  throw new Error('Application mode must be demo, development, or production.');
}

/** Only public settings. Never read or return provider keys from this file. */
export function readRuntimeConfig({ projectDirectory = project, env = process.env } = {}) {
  const path = join(projectDirectory, 'agent-town.config.json');
  let data = {};
  if (existsSync(path)) {
    const info = statSync(path);
    if (!info.isFile() || info.size > 4096) throw new Error('agent-town.config.json must be a small public-settings file.');
    const text = readFileSync(path, 'utf8');
    if (text.length > 4096) throw new Error('agent-town.config.json is too large. Use the provided template.');
    try { data = JSON.parse(text.replace(/^\uFEFF/u, '')); }
    catch { throw new Error('agent-town.config.json must contain valid JSON. Check the example file.'); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['githubClientId', 'mode'].includes(key))) {
    throw new Error('agent-town.config.json must match the example. Never add access tokens or API keys to this file.');
  }
  if (data.githubClientId !== undefined && (typeof data.githubClientId !== 'string' || !identifier.test(data.githubClientId))) throw new Error('The GitHub client ID format is invalid.');
  const configuredMode = data.mode === undefined ? 'development' : normalizeApplicationMode(data.mode);
  const mode = env.AGENT_TOWN_MODE === undefined ? configuredMode : normalizeApplicationMode(env.AGENT_TOWN_MODE);
  const githubClientId = env.AGENT_TOWN_GITHUB_CLIENT_ID ?? data.githubClientId ?? '';
  if (typeof githubClientId !== 'string' || !identifier.test(githubClientId)) throw new Error('The GitHub client ID format is invalid.');
  return { mode, modeSource: env.AGENT_TOWN_MODE !== undefined ? 'environment' : data.mode !== undefined ? 'configuration' : 'default', githubClientId };
}

/** Development retains existing data; other modes always get a separate scope. */
export function runtimeDataPaths(mode, { projectDirectory = project, env = process.env, platform = process.platform } = {}) {
  mode = normalizeApplicationMode(mode);
  const custom = env.AGENT_TOWN_DATA_DIR;
  if (custom !== undefined && (typeof custom !== 'string' || !custom.trim())) throw new Error('AGENT_TOWN_DATA_DIR must name a local data directory.');
  const base = custom ? resolve(custom) : join(projectDirectory, '.data');
  const directory = mode === 'development' ? base : join(base, mode);
  let privateDirectory = join(directory, 'private');
  if (!custom && mode !== 'demo') {
    if (platform !== 'win32' || !env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)) throw new Error('Private workspace storage requires a Windows user profile or an explicit local data directory.');
    privateDirectory = join(env.LOCALAPPDATA, 'AgentTown', ...(mode === 'production' ? ['production'] : []));
  }
  return { directory, privateDirectory, database: join(directory, 'preview.sqlite') };
}
