import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { readRuntimeConfig } from './runtime-config.mjs';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const watchers = [];
let web, worker, stopping = false, reloadTimer, restarting = false, changedAgain = false, stopPromise;

function startWorker() {
  const child = spawn(process.execPath, ['--import', 'tsx', join(project, 'scripts/dev-service.mjs')], {
    cwd: project, env: { ...process.env, NODE_ENV: 'development' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // A Windows console signal must not race the service's asynchronous close.
    // The parent requests shutdown over its own IPC channel instead.
    detached: process.platform === 'win32', windowsHide: true,
  });
  const instance = { child, done: false, expected: false, exited: undefined };
  instance.exited = new Promise(resolve => {
    child.once('error', () => { instance.done = true; resolve(1); });
    child.once('exit', code => { instance.done = true; resolve(code ?? 1); });
  });
  void instance.exited.then(code => {
    if (!instance.expected && !stopping) {
      process.stderr.write(`Development service exited (${code}). Both development servers are stopping.\n`);
      process.exitCode = 1;
      void stop();
    }
  });
  return instance;
}

async function stopWorker(instance) {
  if (!instance || instance.done) return;
  instance.expected = true;
  if (instance.child.connected) instance.child.send({ type: 'agent-town-development-stop' }, () => {});
  let timer;
  const outcome = await Promise.race([
    instance.exited.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 10_000); }),
  ]);
  clearTimeout(timer);
  if (!outcome) {
    // Do not hide an incomplete close, delete locks, or start a competing worker.
    process.exitCode = 1;
    process.stderr.write('The development service is still closing. Waiting for its owned process before any replacement. No forced termination will run.\n');
    await instance.exited;
  }
}

function stop() {
  if (stopPromise) return stopPromise;
  stopping = true;
  clearTimeout(reloadTimer);
  for (const watcher of watchers) watcher.close();
  stopPromise = Promise.allSettled([web?.close(), stopWorker(worker)]).then(results => {
    if (results.some(result => result.status === 'rejected')) {
      process.exitCode = 1;
      process.stderr.write('A development server did not finish closing cleanly. Inspect its owned process before restarting.\n');
    }
  });
  return stopPromise;
}

async function reload() {
  if (stopping) return;
  if (restarting) { changedAgain = true; return; }
  restarting = true;
  try {
    do {
      changedAgain = false;
      process.stdout.write('Service source changed. Closing the previous development service before restart.\n');
      await stopWorker(worker);
      if (!stopping) worker = startWorker();
    } while (changedAgain && !stopping);
  } finally { restarting = false; }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(); });
try {
  if (readRuntimeConfig().mode === 'production') {
    process.stderr.write('Hot reload cannot use production mode. Select development or demo first.\n');
    throw new Error('Production hot reload is disabled');
  }
  web = await createServer({ root: join(project, 'apps/web'), configFile: join(project, 'apps/web/vite.config.ts') });
  await web.listen();
  if (stopping) { await web.close(); throw new Error('Startup interrupted'); }
  web.printUrls();
  worker = startWorker();
  for (const path of ['apps/service/src', 'packages/contracts/src', 'scripts/runtime-config.mjs']) {
    const watcher = watch(join(project, path), { recursive: !path.endsWith('.mjs') }, (_event, name) => {
      if (name && !/\.(?:ts|tsx|mjs|json|sql)$/u.test(String(name))) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { void reload(); }, 150);
    });
    watcher.on('error', () => { process.stderr.write('Development source watching failed. Restart the launcher after fixing local file access.\n'); process.exitCode = 1; void stop(); });
    watchers.push(watcher);
  }
} catch {
  process.stderr.write('Development startup failed. Check the selected ports and public configuration.\n');
  process.exitCode = 1;
  await stop();
}
