// Private IPC wrapper for the development supervisor. The ordinary service owns
// shutdown, committed state and its lock; this wrapper never removes a lock.
if (!process.connected) {
  process.stderr.write('Start the development service through run.ps1 -Dev or npm run dev.\n');
  process.exit(1);
}
let ready = false, requested = false, stopping = false;
function requestStop() {
  requested = true;
  if (!ready || stopping) return;
  stopping = true;
  process.emit('SIGINT');
}
process.on('message', message => {
  if (message && typeof message === 'object' && message.type === 'agent-town-development-stop') requestStop();
});
process.on('disconnect', requestStop);
try {
  await import('../apps/service/src/index.ts');
  ready = true;
  if (requested) requestStop();
} catch {
  process.stderr.write('The development service could not initialize. Check the preceding sanitized service diagnostics.\n');
  process.exitCode = 1;
  process.disconnect?.();
}
