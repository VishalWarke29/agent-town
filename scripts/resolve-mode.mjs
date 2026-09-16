import { readRuntimeConfig } from './runtime-config.mjs';

try {
  if (process.env.AGENT_TOWN_GITHUB_CLIENT_ID === '') {
    throw new Error('AGENT_TOWN_GITHUB_CLIENT_ID is set but empty and overrides agent-town.config.json. Remove the environment variable to use the saved public Client ID, or set a nonempty public Client ID.');
  }
  const { mode, modeSource, githubClientId } = readRuntimeConfig();
  const githubSource = process.env.AGENT_TOWN_GITHUB_CLIENT_ID !== undefined ? 'environment' : githubClientId ? 'configuration' : 'none';
  // The launcher needs readiness and provenance, never the identifier itself.
  process.stdout.write(JSON.stringify({ mode, modeSource, githubConfigured: /^[A-Za-z0-9_.-]{8,100}$/u.test(githubClientId), githubSource }));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
