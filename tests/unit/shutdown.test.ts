import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../../apps/service/src/shutdown.js';

const harness = (close: () => Promise<unknown>) => {
  const calls: string[] = [];
  const shutdown = createShutdown({ close, release: () => calls.push('release'), exit: code => calls.push(`exit:${code}`), log: message => calls.push(`log:${message.split('.')[0]}`) });
  return { calls, shutdown };
};
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('service shutdown', () => {
  it('releases the lock and exits cleanly once the graceful close finishes, without ever logging a forced stop', async () => {
    const { calls, shutdown } = harness(async () => undefined);
    shutdown('SIGINT');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['release', 'exit:0']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['release', 'exit:0']);
  });

  it('exits with a failure code when the graceful close throws', async () => {
    const { calls, shutdown } = harness(() => Promise.reject(new Error('close failed')));
    shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['release', 'exit:1']);
  });

  it('gives up on a close that never finishes after the deadline, releasing the lock first', async () => {
    const { calls, shutdown } = harness(() => new Promise(() => undefined));
    shutdown('SIGINT');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['log:Shutdown took longer than 20 seconds, so it is being ended', 'release', 'exit:1']);
  });

  it('lets a second signal stop immediately instead of being ignored', async () => {
    const { calls, shutdown } = harness(() => new Promise(() => undefined));
    shutdown('SIGINT');
    shutdown('SIGINT');
    expect(calls).toEqual(['log:Stopping now without waiting', 'release', 'exit:1']);
  });

  it('uses a shorter deadline when the console window is closed, because Windows ends the process shortly after', async () => {
    const { calls, shutdown } = harness(() => new Promise(() => undefined));
    shutdown('SIGHUP');
    await vi.advanceTimersByTimeAsync(5_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.at(-2)).toBe('release');
    expect(calls.at(-1)).toBe('exit:1');
  });
});
