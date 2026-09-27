export interface ShutdownOptions {
  /** Stops accepting work and waits for in-flight work; may take long when a request, backup or manager call is running. */
  close: () => Promise<unknown>;
  /** Releases the data-directory lock synchronously. Safe to call more than once. */
  release: () => void;
  exit: (code: number) => void;
  log: (message: string) => void;
  /** Time allowed for a graceful close before exiting anyway. */
  deadlineMs?: number;
  /** Windows ends a process about 10 seconds after its console window closes, so leave room to release the lock. */
  hangupDeadlineMs?: number;
}

/**
 * Returns the handler for termination signals. The first signal starts a graceful close under a deadline; a second
 * signal, or the deadline, exits immediately. The lock is always released first, so a slow close never strands it.
 * Saved data does not depend on a graceful close: SQLite recovers its journal on the next start.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => void {
  const { close, release, exit, log, deadlineMs = 20_000, hangupDeadlineMs = 6_000 } = options;
  let stopping = false;
  const finish = (code: number) => { release(); exit(code); };
  return signal => {
    if (stopping) { log('Stopping now without waiting. Saved data recovers automatically on the next start.'); finish(1); return; }
    stopping = true;
    const limit = signal === 'SIGHUP' ? hangupDeadlineMs : deadlineMs;
    const timer = setTimeout(() => { log(`Shutdown took longer than ${Math.round(limit / 1000)} seconds, so it is being ended. Saved data recovers automatically on the next start.`); finish(1); }, limit);
    timer.unref();
    void close().then(() => { clearTimeout(timer); finish(0); }, () => { clearTimeout(timer); finish(1); });
  };
}
