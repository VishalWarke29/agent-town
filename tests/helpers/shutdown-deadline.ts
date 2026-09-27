/**
 * runShutdown(): runs a job's close step through the service's OWN createShutdown (apps/service/src/shutdown.ts) on a fake
 * clock, under the service's real limits (20 seconds after Ctrl+C or a terminate signal, 6 seconds when the console window
 * closes), and reports what happened to the job:
 *
 *   'finished'  the job ran to the end before the limit; the lock was released and the process exited 0.
 *   'stopped'   the job noticed the shutdown, stopped at its next step boundary before the limit and returned early; exit 0.
 *   'cut-off'   the limit arrived first; createShutdown released the lock and ended the process with exit 1 while a step was
 *               still in flight (interruptedSteps says which).
 *   'failed'    the job's close step threw; exit 1.
 *
 * H0-13's kill-at-each-step tests and AR-15's "shutdown drains in time" check use this instead of writing their own. Nothing
 * here waits in real time: the job's sleeps and createShutdown's deadline timer both run on vitest's fake timers, and the
 * helper installs (and removes) them itself unless the test already did.
 *
 * A job is an async function that spends fake time with ctx.step(name, ms) and may look at ctx.closing / ctx.remainingMs()
 * between steps. stepsJob() builds the usual "list of steps" job in one of three shutdown behaviours. signalAtMs lets the
 * signal arrive part-way through the job, which is how a kill-at-each-step test aims at a particular step.
 *
 * The limits below are the service's defaults; the self-test measures them from the real createShutdown, so a change to
 * shutdown.ts fails a test here instead of silently changing what "in time" means. Limits are the ones in ./index.ts: this
 * models the close step under a fake clock, and does not show that a real process really exits in time.
 */
import { vi } from 'vitest';
import { createShutdown } from '../../apps/service/src/shutdown';

export type ShutdownSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
export type ShutdownOutcome = 'finished' | 'stopped' | 'cut-off' | 'failed';

/** The service's default deadlines, in milliseconds after the signal. Verified against createShutdown by the helper self-test. */
export const SHUTDOWN_LIMITS_MS: Readonly<Record<ShutdownSignal, number>> = { SIGINT: 20_000, SIGTERM: 20_000, SIGHUP: 6_000 };

export interface ShutdownStep { name: string; ms: number }

export interface ShutdownJobContext {
  /** Spends `ms` of fake time on a named step. After a cut-off the promise never settles, like a process that is gone. */
  step(name: string, ms: number): Promise<void>;
  /** True once the shutdown signal has been delivered. */
  readonly closing: boolean;
  /** Fake milliseconds left before the forced exit; Infinity before the signal arrives. */
  remainingMs(): number;
  /** Call when the job returns early at a step boundary because of the shutdown; names the steps it did not run. */
  stoppedAtBoundary(skippedSteps?: readonly string[]): void;
}

export interface ShutdownRun {
  /** The job's close step. Started at time 0 (or, when signalAtMs is 0, when the signal arrives, exactly as createShutdown calls close). */
  job: (context: ShutdownJobContext) => Promise<unknown>;
  signal?: ShutdownSignal;
  /** Fake milliseconds after the job starts at which the signal arrives. Default 0. */
  signalAtMs?: number;
}

export interface ShutdownReport {
  outcome: ShutdownOutcome;
  signal: ShutdownSignal;
  /** The deadline that applied to this signal. */
  limitMs: number;
  /** Fake milliseconds from the signal to the process exit. */
  elapsedMs: number;
  exitCode: number | null;
  completedSteps: string[];
  /** Steps still running when the process was cut off. */
  interruptedSteps: string[];
  /** Steps the job said it did not run when it stopped at a boundary. */
  skippedSteps: string[];
  /** Order of release, exit and log calls, e.g. ['release', 'exit:1']. The lock must always be released before the exit. */
  events: string[];
  logs: string[];
  lockReleasedBeforeExit: boolean;
}

export type StepsJobMode =
  /** Ignores the shutdown and runs every step (what a job with no shutdown awareness does). */
  | 'finish-all'
  /** Finishes the step in flight, then starts no further step. */
  | 'stop-at-boundary'
  /** Starts the next step only if it can still finish before the limit; otherwise stops at the boundary. */
  | 'fit-before-deadline';

export function stepsJob(steps: readonly ShutdownStep[], mode: StepsJobMode = 'finish-all'): ShutdownRun['job'] {
  return async context => {
    for (let index = 0; index < steps.length; index++) {
      const next = steps[index];
      const stop = mode === 'stop-at-boundary' ? context.closing : mode === 'fit-before-deadline' ? context.closing && context.remainingMs() < next.ms : false;
      if (stop) { context.stoppedAtBoundary(steps.slice(index).map(step => step.name)); return; }
      await context.step(next.name, next.ms);
    }
  };
}

const MAX_TIMER_STEPS = 10_000;

export async function runShutdown(run: ShutdownRun): Promise<ShutdownReport> {
  const signal = run.signal ?? 'SIGINT';
  const limitMs = SHUTDOWN_LIMITS_MS[signal];
  const ownsClock = !vi.isFakeTimers();
  if (ownsClock) vi.useFakeTimers();
  const handles = new Set<ReturnType<typeof setTimeout>>();
  try {
    const events: string[] = [], logs: string[] = [];
    const completed: string[] = [], inFlight = new Set<string>();
    // One object, so TypeScript does not narrow these to their first value: the callbacks below are what change them.
    const state: { signalledAt: number | null; exitedAt: number | null; exitCode: number | null; close: 'pending' | 'fulfilled' | 'rejected'; skipped: string[] | null; gone: boolean } =
      { signalledAt: null, exitedAt: null, exitCode: null, close: 'pending', skipped: null, gone: false };

    const context: ShutdownJobContext = {
      step: (name, ms) => new Promise<void>(resolve => {
        if (state.gone) return;
        inFlight.add(name);
        const handle = setTimeout(() => {
          handles.delete(handle);
          if (state.gone) return;
          inFlight.delete(name); completed.push(name); resolve();
        }, ms);
        handles.add(handle);
      }),
      get closing() { return state.signalledAt !== null; },
      remainingMs: () => state.signalledAt === null ? Infinity : Math.max(0, state.signalledAt + limitMs - Date.now()),
      stoppedAtBoundary: skippedSteps => { state.skipped = [...(skippedSteps ?? [])]; },
    };

    let jobPromise: Promise<unknown> | null = null;
    const start = () => jobPromise ??= run.job(context).then(
      value => { state.close = 'fulfilled'; return value; },
      (error: unknown) => { state.close = 'rejected'; throw error; },
    );
    const shutdown = createShutdown({
      close: () => start(),
      release: () => { events.push('release'); },
      exit: code => { events.push(`exit:${code}`); state.exitCode = code; state.exitedAt = Date.now(); state.gone = true; },
      log: message => { events.push('log'); logs.push(message); },
    });

    const signalAt = run.signalAtMs ?? 0;
    if (signalAt > 0) {
      // The job is already running when the signal arrives. A failure before the signal still reaches createShutdown through close(); the catch only prevents an unhandled-rejection report.
      void start().catch(() => undefined);
      await vi.advanceTimersByTimeAsync(signalAt);
    }
    state.signalledAt = Date.now();
    shutdown(signal);

    for (let turns = 0; state.exitCode === null; turns++) {
      if (turns > MAX_TIMER_STEPS) throw new Error('runShutdown: the job kept scheduling timers without ever finishing or being cut off.');
      if (vi.getTimerCount() === 0) { await vi.advanceTimersByTimeAsync(0); break; }
      await vi.advanceTimersToNextTimerAsync();
    }
    const { exitCode, exitedAt, signalledAt } = state;
    if (exitCode === null || exitedAt === null || signalledAt === null) throw new Error('runShutdown: nothing was left to run and the process never exited.');

    const outcome: ShutdownOutcome = state.close === 'pending' ? 'cut-off' : state.close === 'rejected' ? 'failed' : state.skipped !== null ? 'stopped' : 'finished';
    const releaseIndex = events.indexOf('release'), exitIndex = events.findIndex(event => event.startsWith('exit:'));
    return {
      outcome, signal, limitMs, elapsedMs: exitedAt - signalledAt, exitCode,
      completedSteps: completed, interruptedSteps: outcome === 'cut-off' ? [...inFlight] : [], skippedSteps: state.skipped ?? [],
      events, logs, lockReleasedBeforeExit: releaseIndex >= 0 && releaseIndex < exitIndex,
    };
  } finally {
    for (const handle of handles) clearTimeout(handle);
    if (ownsClock) { vi.clearAllTimers(); vi.useRealTimers(); }
  }
}
