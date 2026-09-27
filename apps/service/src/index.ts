import { resolve } from 'node:path';
import { createApp } from './app.js';
import { createDefaultIdentity } from './identity/index.js';
import { applicationDataPaths, readLocalConfig } from './config.js';
import { acquireDataDirectoryLock, OperationsError, verifyDataScopeManifest } from './ops/lock.js';
import { buildInfo } from './build-info.js';
import { BackupScheduler } from './ops/scheduler.js';
import { createShutdown } from './shutdown.js';

const port = Number(process.env.AGENT_TOWN_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('AGENT_TOWN_PORT must be between 1024 and 65535.');
const developmentWebPort = Number(process.env.AGENT_TOWN_WEB_PORT ?? 5173);
if (!Number.isInteger(developmentWebPort) || developmentWebPort < 1024 || developmentWebPort > 65535) throw new Error('AGENT_TOWN_WEB_PORT must be between 1024 and 65535.');
const config = readLocalConfig();
const { directory, database, privateDirectory } = applicationDataPaths(config.mode);
// Two different (mode, data base) combinations must never silently resolve to
// the same physical directory (e.g. production with a custom base and
// development pointed at that base's own "production" subfolder).
const dataScope = { mode: config.mode, customBase: process.env.AGENT_TOWN_DATA_DIR ? resolve(process.env.AGENT_TOWN_DATA_DIR) : null };
verifyDataScopeManifest(directory, dataScope);
verifyDataScopeManifest(privateDirectory, dataScope);
let release: () => void;
try { release = acquireDataDirectoryLock(privateDirectory, 'service'); }
catch (error) {
  // A locked or unreadable data directory is an operator problem with instructions attached, not a crash to show a stack for.
  if (!(error instanceof OperationsError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
process.once('exit', release);
const identity = config.mode === 'demo' ? undefined : createDefaultIdentity(privateDirectory, config.githubClientId, () => readLocalConfig().githubClientId);
const backups = config.mode === 'demo' ? undefined : new BackupScheduler({ sourceDirectory: privateDirectory });
// "development" (hot-reload advertising, dev-origin CORS allowance) must reflect
// an actual dev supervisor, not just an unset/non-production NODE_ENV — a plain
// `npm start`/`node dist/index.js` has neither NODE_ENV=production nor a dev
// supervisor, but must still behave like a built, non-dev launch. Only
// scripts/dev-service.mjs imports this module over an IPC-connected child
// process, so process.connected is a reliable, un-spoofable dev-supervisor signal.
const development = config.mode !== 'production' && process.connected === true;
const { app } = await createApp({ database, privateDirectory, identity, backups, port, developmentWebPort, mode: config.mode, development, logger: true });
const shutdown = createShutdown({ close: () => app.close(), release, exit: code => process.exit(code), log: message => process.stderr.write(`${message}\n`) });
// SIGBREAK is Ctrl+Break and SIGHUP is closing the console window on Windows; without them the process is ended with the lock still held.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(signal, () => shutdown(signal));
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
