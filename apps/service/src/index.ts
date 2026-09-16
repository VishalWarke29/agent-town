import { createApp } from './app.js';
import { createDefaultIdentity } from './identity/index.js';
import { applicationDataPaths, readLocalConfig } from './config.js';
import { acquireDataDirectoryLock } from './ops/lock.js';
import { buildInfo } from './build-info.js';
import { BackupScheduler } from './ops/scheduler.js';

const port = Number(process.env.AGENT_TOWN_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('AGENT_TOWN_PORT must be between 1024 and 65535.');
const developmentWebPort = Number(process.env.AGENT_TOWN_WEB_PORT ?? 5173);
if (!Number.isInteger(developmentWebPort) || developmentWebPort < 1024 || developmentWebPort > 65535) throw new Error('AGENT_TOWN_WEB_PORT must be between 1024 and 65535.');
const config = readLocalConfig();
const { database, privateDirectory } = applicationDataPaths(config.mode);
const release = acquireDataDirectoryLock(privateDirectory, 'service');
process.once('exit', release);
const identity = config.mode === 'demo' ? undefined : createDefaultIdentity(privateDirectory, config.githubClientId, () => readLocalConfig().githubClientId);
const backups = config.mode === 'demo' ? undefined : new BackupScheduler({ sourceDirectory: privateDirectory });
const { app } = await createApp({ database, privateDirectory, identity, backups, port, developmentWebPort, mode: config.mode, development: config.mode !== 'production' && process.env.NODE_ENV !== 'production', logger: true });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void app.close().then(() => { release(); process.exit(0); }, () => { release(); process.exit(1); });
});
try {
  await app.listen({ host: '127.0.0.1', port });
  process.stdout.write(`Runtime: ${buildInfo.id}${buildInfo.builtAt ? ` | built ${buildInfo.builtAt}` : ' | source hot reload'}\n`);
  const behavior = config.mode === 'demo' ? 'Fictional sample town only. Private connections, repository access, and paid work are disabled.'
    : config.mode === 'production' ? 'Separate production data. Loopback only; this does not enable hosted deployment. Sample data is disabled.'
      : 'Real private workspaces; sample town is optional. Saved Economy limits apply.';
  const setup = config.mode === 'demo' ? 'Start with -Mode development when ready to connect your real accounts.'
    : identity?.status().configured ? 'GitHub sign-in configured.' : 'GitHub setup: add your public client ID to agent-town.config.json. The setup screen detects the saved ID automatically. See docs/24-connect-your-accounts.md.';
  process.stdout.write(`\nAgent Town is ready at http://127.0.0.1:${port}\nApplication mode: ${config.mode}\n${behavior}\n${setup}\nPress Ctrl+C to stop.\n\n`);
} catch (error) {
  app.log.error({ code: (error as NodeJS.ErrnoException).code }, 'Could not start the local service. Check the port and data folder.');
  await app.close();
  release();
  process.exitCode = 1;
}
