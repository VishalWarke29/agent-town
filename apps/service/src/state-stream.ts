import type { ServerResponse } from 'node:http';
import type { StateEvent } from '@agent-town/contracts';

interface StreamOptions { authorized(): boolean; close(): void; stallTimeoutMs?: number }

/** A false write means accepted-but-buffered, not failed. Keep one newer snapshot
 * while Node drains the accepted frame; the Store remains the durable history. */
export function createStateStream(response: ServerResponse, options: StreamOptions) {
  let blocked = false, disposed = false;
  let pending: StateEvent | null = null;
  let lastCursor = -1;
  let stalled: ReturnType<typeof setTimeout> | undefined;
  const writable = () => {
    if (disposed) return false;
    if (response.destroyed || response.writableEnded || !options.authorized()) { options.close(); return false; }
    return true;
  };
  const write = (frame: string) => {
    if (!writable()) return;
    try {
      if (!response.write(frame)) {
        blocked = true;
        // Pending events never extend a stalled connection's deadline.
        stalled ??= setTimeout(options.close, options.stallTimeoutMs ?? 30000);
        stalled.unref();
      }
    } catch { options.close(); }
  };
  const emit = (event: StateEvent) => {
    if (!writable() || event.cursor <= lastCursor) return;
    lastCursor = event.cursor;
    if (blocked) { pending = event; return; }
    write(`id: ${event.cursor}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const drain = () => {
    if (!writable()) return;
    blocked = false; clearTimeout(stalled); stalled = undefined;
    const event = pending; pending = null;
    if (event) {
      // This cursor was already offered; write it directly after the prior frame.
      write(`id: ${event.cursor}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`);
    }
  };
  const error = () => options.close();
  response.on('drain', drain); response.on('error', error);
  return {
    emit,
    start: () => write('retry: 2000\n\n'),
    heartbeat: () => { if (!blocked) write(': heartbeat\n\n'); },
    backpressured: () => blocked,
    dispose: () => { disposed = true; pending = null; clearTimeout(stalled); response.off('drain', drain); response.off('error', error); },
  };
}
