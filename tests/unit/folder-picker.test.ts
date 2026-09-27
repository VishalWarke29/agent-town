import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLDER_PICK_LIMITS, type FolderPick } from '@agent-town/contracts';
import {
  MAX_ENCODED_COMMAND_CHARS, createFolderPicker, createHelperLauncher, isAcceptableHelperPath, sweepStaleHelperFolders,
  type FolderHelperEvents, type FolderHelperHandle, type FolderHelperLauncher, type FolderHelperRequest, type FolderPicker, type FolderPickerOptions,
} from '../../apps/service/src/folder-picker';
import { FOLDER_PICKER_SCRIPT } from '../../apps/service/src/folder-picker-script';

const WORKSPACE = 'workspace-aaaaaaaa';
const OTHER = 'workspace-bbbbbbbb';
const PATH = 'C:\\Projects\\Demo';
const line = (value: object) => `${JSON.stringify(value)}\n`;
const open = line({ state: 'open' });
const cancelled = line({ state: 'cancelled' });
const selected = (path: string) => line({ state: 'selected', path });
const char = (code: number) => String.fromCodePoint(code);
const caught = (run: () => unknown) => { try { run(); } catch (error) { return error as { code?: string; statusCode?: number; message: string }; } throw new Error('Expected the call to throw.'); };

/** A stand-in for one helper process. Nothing here starts a process or opens a window. */
class FakeHelper {
  kills = 0;
  exited = false;
  readonly done: Promise<void>;
  readonly handle: FolderHelperHandle;
  private finish: () => void = () => undefined;
  constructor(readonly request: FolderHelperRequest, readonly events: FolderHelperEvents, exitOnKill: boolean, hangOnKill: boolean) {
    this.done = hangOnKill ? new Promise<void>(() => undefined) : new Promise<void>(resolve => { this.finish = resolve; });
    this.handle = { done: this.done, kill: () => { this.kills++; if (exitOnKill) void Promise.resolve().then(() => this.exit()); } };
  }
  out(chunk: Buffer | string) { this.events.onOutput(chunk); }
  exit(code?: number | null) { if (this.exited) return; this.exited = true; this.events.onExit(code); this.finish(); }
}

interface Setup extends Partial<Pick<FolderPickerOptions, 'platform' | 'env' | 'limits' | 'retainFinishedMs' | 'maxOutputBytes' | 'maxLineChars'>> {
  exitOnKill?: boolean; hangOnKill?: boolean; launchError?: Error; exitDuringLaunch?: boolean;
}
function setup(options: Setup = {}) {
  const { exitOnKill = true, hangOnKill = false, launchError, exitDuringLaunch, ...picking } = options;
  const helpers: FakeHelper[] = [];
  const launcher: FolderHelperLauncher = (request, events) => {
    if (launchError) throw launchError;
    const helper = new FakeHelper(request, events, exitOnKill, hangOnKill);
    helpers.push(helper);
    if (exitDuringLaunch) helper.exit();
    return helper.handle;
  };
  const picker: FolderPicker = createFolderPicker({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, launcher, ...picking });
  return { picker, helpers, latest: () => helpers.at(-1)! };
}
/** Poll like the page does so the idle limit never ends the helper, then stop `ms` after the start. */
async function pollFor(picker: FolderPicker, id: string, ms: number, step = 10_000) {
  for (let elapsed = 0; elapsed + step <= ms; elapsed += step) { await vi.advanceTimersByTimeAsync(step); picker.status(WORKSPACE, id); }
}

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-09-24T10:00:00.000Z') }); });
afterEach(() => { vi.useRealTimers(); });

describe('folder picker state machine', () => {
  it('starts waiting, then hands back the chosen path and lets the helper go', () => {
    const { picker, helpers, latest } = setup();
    const pick = picker.start(WORKSPACE);
    expect(pick).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), state: 'waiting', startedAt: '2026-09-24T10:00:00.000Z', expiresAt: '2026-09-24T10:05:00.000Z' });
    expect(helpers).toHaveLength(1);
    expect(latest().request).toEqual({ windowMs: FOLDER_PICK_LIMITS.windowMs });
    latest().out(open);
    const waiting = picker.status(WORKSPACE, pick.id);
    expect(waiting).toEqual(pick);
    expect(waiting).not.toHaveProperty('path');
    latest().out(selected(PATH));
    expect(picker.status(WORKSPACE, pick.id)).toEqual({ ...pick, state: 'selected', path: PATH });
    expect(latest().kills).toBe(1);
  });

  it('reports a closed window as cancelled, with no path', () => {
    const { picker, latest } = setup();
    const pick = picker.start(WORKSPACE);
    latest().out(open); latest().out(cancelled);
    const after = picker.status(WORKSPACE, pick.id);
    expect(after).toEqual({ ...pick, state: 'cancelled' });
    expect(after).not.toHaveProperty('path');
  });

  it('ends the helper when the page cancels, and ignores a result that arrives afterwards', async () => {
    const { picker, latest } = setup();
    const pick = picker.start(WORKSPACE);
    latest().out(open);
    expect(picker.cancel(WORKSPACE, pick.id)).toEqual({ ...pick, state: 'cancelled' });
    expect(latest().kills).toBe(1);
    latest().out(selected(PATH));
    await vi.advanceTimersByTimeAsync(0);
    const after = picker.status(WORKSPACE, pick.id);
    expect(after.state).toBe('cancelled');
    expect(after).not.toHaveProperty('path');
    // Cancelling again, or after any other ending, changes nothing and does not kill twice.
    expect(picker.cancel(WORKSPACE, pick.id).state).toBe('cancelled');
    expect(latest().kills).toBe(1);
  });

  it('leaves a finished selection as it was when the page cancels late', () => {
    const { picker, latest } = setup();
    const pick = picker.start(WORKSPACE);
    latest().out(open); latest().out(selected(PATH));
    expect(picker.cancel(WORKSPACE, pick.id)).toMatchObject({ state: 'selected', path: PATH });
  });

  it('times a window out after the window limit and kills the helper', async () => {
    const { picker, latest } = setup();
    const pick = picker.start(WORKSPACE);
    latest().out(open);
    await pollFor(picker, pick.id, FOLDER_PICK_LIMITS.windowMs - 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(picker.status(WORKSPACE, pick.id).state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(picker.status(WORKSPACE, pick.id)).toEqual({ ...pick, state: 'timed-out' });
    expect(latest().kills).toBe(1);
  });

  it('ends a helper nobody polls for 30 seconds as cancelled, and counts every status call as a heartbeat', async () => {
    const { picker, latest } = setup();
    const pick = picker.start(WORKSPACE);
    latest().out(open);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(latest().kills).toBe(0);
    picker.status(WORKSPACE, pick.id);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(latest().kills).toBe(0);
    picker.status(WORKSPACE, pick.id);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(latest().kills).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(latest().kills).toBe(1);
    expect(picker.status(WORKSPACE, pick.id)).toEqual({ ...pick, state: 'cancelled' });
  });

  it('treats a helper that never reports its window as an unavailable desktop', async () => {
    const { picker, latest } = setup();
    const pick = picker.start(WORKSPACE);
    await vi.advanceTimersByTimeAsync(7_000); picker.status(WORKSPACE, pick.id);
    await vi.advanceTimersByTimeAsync(999);
    expect(picker.status(WORKSPACE, pick.id).state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(picker.status(WORKSPACE, pick.id)).toEqual({ ...pick, state: 'unavailable', reason: 'no-desktop' });
    expect(latest().kills).toBe(1);
  });

  it('does not treat a window that reported in time as an unavailable desktop', async () => {
    const { picker, latest } = setup();
    const pick = picker.start(WORKSPACE);
    latest().out(open);
    await vi.advanceTimersByTimeAsync(8_000); picker.status(WORKSPACE, pick.id);
    await vi.advanceTimersByTimeAsync(8_000); picker.status(WORKSPACE, pick.id);
    expect(picker.status(WORKSPACE, pick.id).state).toBe('waiting');
  });

  describe('whenOpened (the start route waits for the window to be really up)', () => {
    it('resolves as soon as the helper reports its window, still waiting, without touching the idle clock', async () => {
      const { picker, latest } = setup();
      const pick = picker.start(WORKSPACE);
      let result: FolderPick | undefined;
      void picker.whenOpened(WORKSPACE, pick.id).then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(result).toBeUndefined();
      latest().out(open);
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toEqual(pick);
    });

    it('resolves with an unavailable desktop when nothing reports in within the handshake', async () => {
      const { picker } = setup();
      const pick = picker.start(WORKSPACE);
      const answer = picker.whenOpened(WORKSPACE, pick.id);
      await vi.advanceTimersByTimeAsync(FOLDER_PICK_LIMITS.handshakeMs);
      expect(await answer).toEqual({ ...pick, state: 'unavailable', reason: 'no-desktop' });
    });

    it('resolves at once for a window that is already up and for a pick that already ended', async () => {
      const { picker, latest } = setup();
      const pick = picker.start(WORKSPACE);
      latest().out(open);
      expect(await picker.whenOpened(WORKSPACE, pick.id)).toEqual(pick);
      latest().out(cancelled);
      expect(await picker.whenOpened(WORKSPACE, pick.id)).toEqual({ ...pick, state: 'cancelled' });
    });

    it('releases every waiter when the pick ends some other way, including a service shutdown', async () => {
      const { picker } = setup();
      const pick = picker.start(WORKSPACE);
      const first = picker.whenOpened(WORKSPACE, pick.id), second = picker.whenOpened(WORKSPACE, pick.id);
      picker.cancel(WORKSPACE, pick.id);
      expect(await first).toEqual({ ...pick, state: 'cancelled' });
      expect(await second).toEqual({ ...pick, state: 'cancelled' });
      const next = picker.start(WORKSPACE);
      const pending = picker.whenOpened(WORKSPACE, next.id);
      await picker.close();
      expect((await pending).state).toBe('cancelled');
    });

    it("never reveals another workspace's pick, and an unknown id is the same not-found answer", () => {
      const { picker } = setup();
      const pick = picker.start(WORKSPACE);
      expect(caught(() => { void picker.whenOpened(OTHER, pick.id); }).code).toBe('FOLDER_PICK_NOT_FOUND');
      expect(caught(() => { void picker.whenOpened(WORKSPACE, '00000000-0000-4000-8000-000000000000'); }).statusCode).toBe(404);
    });
  });

  it('reports a helper that exits without printing anything as failed', () => {
    const { picker, latest } = setup();
    const pick = picker.start(WORKSPACE);
    latest().exit();
    expect(picker.status(WORKSPACE, pick.id)).toEqual({ ...pick, state: 'unavailable', reason: 'helper-failed' });
  });

  it('reports a helper that says the session has no desktop (exit code 3) as an unavailable desktop, any other code as failed', () => {
    for (const [code, reason] of [[3, 'no-desktop'], [2, 'helper-failed'], [1, 'helper-failed'], [null, 'helper-failed'], [undefined, 'helper-failed']] as const) {
      const { picker, latest } = setup();
      const pick = picker.start(WORKSPACE);
      latest().exit(code);
      expect(picker.status(WORKSPACE, pick.id), String(code)).toEqual({ ...pick, state: 'unavailable', reason });
    }
  });

  it('reports a helper that exits after opening but before a result as failed', () => {
    const { picker, latest } = setup();
    const pick = picker.start(WORKSPACE);
    latest().out(open); latest().exit();
    expect(picker.status(WORKSPACE, pick.id)).toMatchObject({ state: 'unavailable', reason: 'helper-failed' });
  });

  it('reports a launcher that cannot start the helper as failed and does not keep the window slot', () => {
    const { picker } = setup({ launchError: new Error('spawn powershell.exe ENOENT') });
    const pick = picker.start(WORKSPACE);
    expect(pick).toMatchObject({ state: 'unavailable', reason: 'helper-failed' });
    expect(picker.status(WORKSPACE, pick.id)).toEqual(pick);
    expect(picker.start(OTHER).state).toBe('unavailable');
  });

  it('handles a helper that finishes before the launcher returns', () => {
    const { picker, latest } = setup({ exitDuringLaunch: true });
    const pick = picker.start(WORKSPACE);
    expect(pick).toMatchObject({ state: 'unavailable', reason: 'helper-failed' });
    expect(latest().kills).toBe(1);
  });

  describe('helper output that is not the protocol', () => {
    const bad: Array<[string, Array<Buffer | string>]> = [
      ['text that is not JSON', [open, 'hello\n']],
      ['a JSON value that is not an object', [open, '[]\n']],
      ['an unknown state', [open, line({ state: 'weird' })]],
      ['extra keys on open', [line({ state: 'open', extra: 1 })]],
      ['extra keys on a result', [open, line({ state: 'selected', path: PATH, extra: true })]],
      ['a cancelled line that carries a path', [open, line({ state: 'cancelled', path: PATH })]],
      ['a path that is not text', [open, line({ state: 'selected', path: 12 })]],
      ['a second open', [open, open]],
      ['a selection before the window opened', [selected(PATH)]],
      ['a cancellation before the window opened', [cancelled]],
      ['an empty path', [open, selected('')]],
      ['a relative path', [open, selected('projects\\demo')]],
      ['a dot path', [open, selected('.')]],
      ['a drive-relative path', [open, selected('C:demo')]],
      ['a rooted path with no drive', [open, selected('\\Users\\demo')]],
      ['a POSIX path', [open, selected('/home/demo')]],
      ['a UNC path with no share', [open, selected('\\\\server')]],
      ['a path with a control character', [open, selected(`C:\\demo${char(7)}x`)]],
      ['a path with a NUL', [open, selected(`C:\\demo${char(0)}`)]],
      ['a path with a line break', [open, selected('C:\\demo\nother')]],
      ['a path with a C1 control character', [open, selected(`C:\\demo${char(0x85)}`)]],
      ['a path with a right-to-left override', [open, selected(`C:\\demo${char(0x202e)}gpj.exe`)]],
      ['a path with a line separator', [open, selected(`C:\\demo${char(0x2028)}x`)]],
      ['a path longer than the limit', [open, selected(`C:\\${'a'.repeat(FOLDER_PICK_LIMITS.pathMaxLength)}`)]],
      ['a single line over the size limit', [open, 'x'.repeat(40 * 1024)]],
      ['a huge line split across chunks', [open, ...Array.from({ length: 40 }, () => 'x'.repeat(1024))]],
      ['more output in total than allowed, even as empty lines', [open, ...Array.from({ length: 66 }, () => '\n'.repeat(1024))]],
    ];
    it.each(bad)('fails and kills the helper on %s', async (_name, chunks) => {
      const { picker, latest } = setup();
      const pick = picker.start(WORKSPACE);
      for (const chunk of chunks) latest().out(chunk);
      const after = picker.status(WORKSPACE, pick.id);
      expect(after).toEqual({ ...pick, state: 'unavailable', reason: 'helper-failed' });
      expect(after).not.toHaveProperty('path');
      expect(latest().kills).toBe(1);
      // A later valid-looking line cannot revive it.
      latest().out(selected(PATH));
      await vi.advanceTimersByTimeAsync(0);
      expect(picker.status(WORKSPACE, pick.id).state).toBe('unavailable');
    });

    it('applies smaller caps when they are configured', () => {
      const lines = setup({ maxLineChars: 64 });
      const one = lines.picker.start(WORKSPACE);
      lines.latest().out(open); lines.latest().out('y'.repeat(65));
      expect(lines.picker.status(WORKSPACE, one.id)).toMatchObject({ reason: 'helper-failed' });
      const total = setup({ maxOutputBytes: 40 });
      const two = total.picker.start(WORKSPACE);
      total.latest().out(open); total.latest().out('\n'.repeat(30));
      expect(total.picker.status(WORKSPACE, two.id)).toMatchObject({ reason: 'helper-failed' });
    });
  });

  describe('helper output that is the protocol', () => {
    it('assembles a result that arrives in pieces', () => {
      const { picker, latest } = setup();
      const pick = picker.start(WORKSPACE);
      const text = open + selected(PATH);
      for (let index = 0; index < text.length; index += 3) latest().out(text.slice(index, index + 3));
      expect(picker.status(WORKSPACE, pick.id)).toMatchObject({ state: 'selected', path: PATH });
    });

    it('decodes a folder name whose bytes are split between chunks', () => {
      const { picker, latest } = setup();
      const pick = picker.start(WORKSPACE);
      const name = `C:\\Projects\\Uebung-${char(0xdc)}${char(0x4e2d)}${char(0x1f600)}`;
      const bytes = Buffer.from(open + selected(name), 'utf8');
      const split = bytes.indexOf(Buffer.from(char(0xdc), 'utf8')) + 1; // between the two bytes of one character
      latest().out(bytes.subarray(0, split)); latest().out(bytes.subarray(split, split + 4)); latest().out(bytes.subarray(split + 4));
      expect(picker.status(WORKSPACE, pick.id)).toMatchObject({ state: 'selected', path: name });
    });

    it('accepts Windows line endings, a byte order mark, blank lines and other absolute shapes', () => {
      for (const path of ['C:/Projects/Demo', '\\\\server\\share\\Demo', 'd:\\x']) {
        const { picker, latest } = setup();
        const pick = picker.start(WORKSPACE);
        latest().out(`${char(0xfeff)}{"state":"open"}\r\n\r\n   \r\n`);
        latest().out(`{"state":"selected","path":${JSON.stringify(path)}}\r\n`);
        expect(picker.status(WORKSPACE, pick.id)).toMatchObject({ state: 'selected', path });
      }
    });

    it('delivers a final line that has no newline once the helper exits', () => {
      const { picker, latest } = setup();
      const pick = picker.start(WORKSPACE);
      latest().out(open); latest().out(selected(PATH).trimEnd());
      expect(picker.status(WORKSPACE, pick.id).state).toBe('waiting');
      latest().exit();
      expect(picker.status(WORKSPACE, pick.id)).toMatchObject({ state: 'selected', path: PATH });
    });

    it('does not let the helper exiting after its result change the result', async () => {
      const { picker, latest } = setup();
      const pick = picker.start(WORKSPACE);
      latest().out(open); latest().out(selected(PATH)); latest().exit();
      await vi.advanceTimersByTimeAsync(0);
      expect(picker.status(WORKSPACE, pick.id)).toMatchObject({ state: 'selected', path: PATH });
    });

    it('ignores extra lines after the first result', () => {
      const { picker, latest } = setup();
      const pick = picker.start(WORKSPACE);
      latest().out(open + selected(PATH) + selected('C:\\Other') + cancelled + 'garbage\n');
      expect(picker.status(WORKSPACE, pick.id)).toMatchObject({ state: 'selected', path: PATH });
    });
  });

  it('exposes a path only when the pick is selected, and a reason only when it is unavailable', () => {
    const shape = (pick: FolderPick) => Object.keys(pick).sort();
    const waiting = setup(), done = setup(), closed = setup(), broken = setup();
    const a = waiting.picker.start(WORKSPACE);
    const b = done.picker.start(WORKSPACE); done.latest().out(open + selected(PATH));
    const c = closed.picker.start(WORKSPACE); closed.latest().out(open + cancelled);
    const d = broken.picker.start(WORKSPACE); broken.latest().exit();
    expect(shape(waiting.picker.status(WORKSPACE, a.id))).toEqual(['expiresAt', 'id', 'startedAt', 'state']);
    expect(shape(done.picker.status(WORKSPACE, b.id))).toEqual(['expiresAt', 'id', 'path', 'startedAt', 'state']);
    expect(shape(closed.picker.status(WORKSPACE, c.id))).toEqual(['expiresAt', 'id', 'startedAt', 'state']);
    expect(shape(broken.picker.status(WORKSPACE, d.id))).toEqual(['expiresAt', 'id', 'reason', 'startedAt', 'state']);
    // A returned object is a copy: changing it cannot change the stored pick.
    const copy = done.picker.status(WORKSPACE, b.id); copy.path = 'C:\\Changed';
    expect(done.picker.status(WORKSPACE, b.id).path).toBe(PATH);
  });

  describe('one window at a time', () => {
    it('returns the open window with alreadyOpen for the same workspace and launches nothing more', async () => {
      const { picker, helpers } = setup();
      const first = picker.start(WORKSPACE);
      helpers[0]!.out(open);
      expect(first).not.toHaveProperty('alreadyOpen');
      const again = picker.start(WORKSPACE);
      expect(again).toEqual({ ...first, alreadyOpen: true });
      expect(helpers).toHaveLength(1);
      // Asking again is also a heartbeat.
      await vi.advanceTimersByTimeAsync(29_000); picker.start(WORKSPACE);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(helpers[0]!.kills).toBe(0);
    });

    it('refuses another workspace with a plain 409 while a window is open', () => {
      const { picker, helpers } = setup();
      picker.start(WORKSPACE);
      const error = caught(() => picker.start(OTHER));
      expect(error).toMatchObject({ code: 'FOLDER_PICK_BUSY', statusCode: 409 });
      expect(error.message).toMatch(/already open/i);
      expect(helpers).toHaveLength(1);
    });

    it('frees the slot when the window finishes, however it finishes', async () => {
      const { picker, helpers, latest } = setup();
      const first = picker.start(WORKSPACE);
      latest().out(open + selected(PATH));
      const second = picker.start(OTHER);
      expect(second.id).not.toBe(first.id);
      expect(second).not.toHaveProperty('alreadyOpen');
      expect(helpers).toHaveLength(2);
      picker.cancel(OTHER, second.id);
      const third = picker.start(WORKSPACE);
      expect(third.state).toBe('waiting');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(picker.start(OTHER).state).toBe('waiting');
    });
  });

  it('refuses to start on a platform that cannot show the window, and starts no helper', () => {
    for (const options of [{ platform: 'linux' as const }, { platform: 'darwin' as const }, { env: {} }]) {
      const { picker, helpers } = setup(options);
      const pick = picker.start(WORKSPACE);
      expect(pick).toEqual({ id: expect.any(String), state: 'unavailable', reason: 'unsupported-platform', startedAt: '2026-09-24T10:00:00.000Z', expiresAt: '2026-09-24T10:05:00.000Z' });
      expect(helpers).toHaveLength(0);
      expect(picker.status(WORKSPACE, pick.id)).toEqual(pick);
      // An unusable picker never holds the one window slot.
      expect(picker.start(OTHER).reason).toBe('unsupported-platform');
    }
  });

  it('answers an unknown id, an expired id and another workspace\'s id with the same 404', async () => {
    const { picker, latest } = setup();
    const pick = picker.start(WORKSPACE);
    latest().out(open + selected(PATH));
    const reads = [
      caught(() => picker.status(WORKSPACE, '00000000-0000-4000-8000-000000000000')),
      caught(() => picker.status(OTHER, pick.id)),
      caught(() => picker.cancel(OTHER, pick.id)),
      caught(() => picker.cancel(WORKSPACE, '00000000-0000-4000-8000-000000000000')),
    ];
    for (const error of reads) expect(error).toMatchObject({ code: 'FOLDER_PICK_NOT_FOUND', statusCode: 404, message: reads[0]!.message });
    // Another workspace probing did not disturb the real pick.
    expect(picker.status(WORKSPACE, pick.id)).toMatchObject({ state: 'selected', path: PATH });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(caught(() => picker.status(WORKSPACE, pick.id))).toMatchObject({ code: 'FOLDER_PICK_NOT_FOUND', message: reads[0]!.message });
  });

  it('keeps a finished pick readable for two minutes, then forgets it and the path with it', async () => {
    const { picker, latest } = setup();
    const pick = picker.start(WORKSPACE);
    latest().out(open + selected(PATH));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(picker.status(WORKSPACE, pick.id)).toMatchObject({ state: 'selected', path: PATH });
    await vi.advanceTimersByTimeAsync(1);
    expect(caught(() => picker.status(WORKSPACE, pick.id))).toMatchObject({ code: 'FOLDER_PICK_NOT_FOUND' });
    const later = setup({ retainFinishedMs: 500 });
    const cancelledPick = later.picker.start(WORKSPACE); later.picker.cancel(WORKSPACE, cancelledPick.id);
    await vi.advanceTimersByTimeAsync(500);
    expect(caught(() => later.picker.status(WORKSPACE, cancelledPick.id))).toMatchObject({ statusCode: 404 });
  });

  it('keeps only a bounded number of finished picks', () => {
    const { picker } = setup();
    const ids: string[] = [];
    for (let index = 0; index < 12; index++) { const pick = picker.start(WORKSPACE); ids.push(pick.id); picker.cancel(WORKSPACE, pick.id); }
    expect(caught(() => picker.status(WORKSPACE, ids[0]!))).toMatchObject({ statusCode: 404 });
    expect(picker.status(WORKSPACE, ids[11]!).state).toBe('cancelled');
    expect(ids.filter(id => { try { picker.status(WORKSPACE, id); return true; } catch { return false; } }).length).toBe(8);
  });

  describe('shutdown', () => {
    it('kills a live helper on close, forgets every pick and refuses new ones', async () => {
      const { picker, latest, helpers } = setup();
      const pick = picker.start(WORKSPACE);
      latest().out(open);
      await picker.close();
      expect(latest().kills).toBe(1);
      expect(latest().exited).toBe(true);
      expect(caught(() => picker.status(WORKSPACE, pick.id))).toMatchObject({ code: 'FOLDER_PICK_NOT_FOUND' });
      expect(caught(() => picker.start(WORKSPACE))).toMatchObject({ code: 'SHUTTING_DOWN', statusCode: 503 });
      expect(helpers).toHaveLength(1);
      await picker.close(); // Closing twice is harmless.
      expect(latest().kills).toBe(1);
    });

    it('also waits for a helper that was cancelled a moment ago and is still going away (its folder is removed after it exits)', async () => {
      const { picker, latest } = setup({ exitOnKill: false });
      const pick = picker.start(WORKSPACE);
      latest().out(open);
      picker.cancel(WORKSPACE, pick.id); // The pick is over, but the helper has not exited yet.
      let closed = false;
      const closing = picker.close().then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(closed).toBe(false);
      latest().exit();
      await closing;
      expect(closed).toBe(true);
    });

    it('does not wait forever for a helper that will not go away', async () => {
      const { picker } = setup({ exitOnKill: false, hangOnKill: true });
      picker.start(WORKSPACE);
      let closed = false;
      const closing = picker.close().then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(closed).toBe(true);
    });

    it('closes cleanly with nothing running, and drops a finished selection', async () => {
      await expect(setup().picker.close()).resolves.toBeUndefined();
      const { picker, latest } = setup();
      const pick = picker.start(WORKSPACE);
      latest().out(open + selected(PATH));
      await picker.close();
      expect(caught(() => picker.status(WORKSPACE, pick.id))).toMatchObject({ statusCode: 404 });
      // The helper was already ended by its own result, and closing did not end it a second time.
      expect(latest().kills).toBe(1);
    });
  });
});

describe('stale helper folders', () => {
  const day = 24 * 60 * 60_000;
  let root = '';
  beforeEach(() => { vi.useRealTimers(); root = mkdtempSync(join(tmpdir(), 'agent-town-sweep-test-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const make = (name: string, ageMs: number, kind: 'dir' | 'file' = 'dir') => {
    const path = join(root, name);
    if (kind === 'dir') { mkdirSync(path); writeFileSync(join(path, 'compile.tmp'), 'x'); } else writeFileSync(path, 'x');
    const then = new Date(Date.now() - ageMs);
    utimesSync(path, then, then);
    return path;
  };

  it('removes only the folders this feature makes, and only when they are more than a day old', async () => {
    const old = make('agent-town-folder-old1', 2 * day);
    const fresh = make('agent-town-folder-fresh', 60_000);
    const otherOld = make('agent-town-something-else', 3 * day);
    const plainOld = make('projects', 3 * day);
    const fileOld = make('agent-town-folder-a-file', 3 * day, 'file');
    expect(await sweepStaleHelperFolders(root)).toBe(1);
    expect(existsSync(old)).toBe(false);
    for (const kept of [fresh, otherOld, plainOld, fileOld]) expect(existsSync(kept), kept).toBe(true);
    expect(await sweepStaleHelperFolders(root)).toBe(0);
  });

  it('says nothing and removes nothing when there is no folder to look in', async () => {
    expect(await sweepStaleHelperFolders(join(root, 'missing'))).toBe(0);
  });
});

describe('helper path check', () => {
  it('accepts drive and UNC shapes and refuses everything else', () => {
    for (const ok of ['C:\\a', 'c:/a/b', 'Z:\\a b\\c', '\\\\server\\share', '\\\\server\\share\\x']) expect(isAcceptableHelperPath(ok), ok).toBe(true);
    for (const bad of ['', 'a', 'C:', 'C:a', '\\a', '/a', '\\\\', '\\\\server', '\\\\server\\', 'C:\\a\tb', `C:\\${char(0x2066)}x`]) expect(isAcceptableHelperPath(bad), bad).toBe(false);
    // Zero-width and other invisible marks could hide part of a path in the field the person reviews.
    for (const code of [0x200b, 0x200d, 0x200e, 0x2060, 0x061c, 0xfeff, 0x202e, 0x2028]) expect(isAcceptableHelperPath(`C:\\a${char(code)}b`), code.toString(16)).toBe(false);
    // The limit is the add routes' own (1,024): a path that could never be added is not offered.
    expect(FOLDER_PICK_LIMITS.pathMaxLength).toBe(1024);
    expect(isAcceptableHelperPath(`C:\\${'a'.repeat(FOLDER_PICK_LIMITS.pathMaxLength - 3)}`)).toBe(true);
    expect(isAcceptableHelperPath(`C:\\${'a'.repeat(FOLDER_PICK_LIMITS.pathMaxLength - 2)}`)).toBe(false);
    expect(isAcceptableHelperPath('C:\\abcdef', 9)).toBe(true);
    expect(isAcceptableHelperPath('C:\\abcdefg', 9)).toBe(false);
  });

  it('keeps the helper script small enough for one Windows command line', () => {
    expect(Buffer.from(FOLDER_PICKER_SCRIPT, 'utf16le').toString('base64').length).toBeLessThanOrEqual(MAX_ENCODED_COMMAND_CHARS);
  });
});

// The real launcher is exercised with an injected spawn: no process is started and no window can open.
describe.skipIf(process.platform !== 'win32')('real helper launcher', () => {
  const winEnv = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', PATH: 'C:\\evil', GITHUB_TOKEN: 'secret-token', OPENAI_API_KEY: 'secret-key', USERPROFILE: 'C:\\Users\\tester' };
  const tempRoot = tmpdir();

  class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    readonly kill = vi.fn(() => true);
    constructor(public pid: number | undefined) { super(); }
  }
  function fakeSpawn(first: { pid: number | undefined } = { pid: 4242 }) {
    const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
    const children: FakeChild[] = [];
    let next = 4243;
    const spawn = (command: string, args: string[], options: SpawnOptions) => {
      calls.push({ command, args, options });
      const child = new FakeChild(children.length === 0 ? first.pid : next++);
      children.push(child);
      return child as unknown as ChildProcess;
    };
    return { spawn, calls, children };
  }
  const events = () => ({ onOutput: vi.fn(), onExit: vi.fn() });
  let counter = 0;
  const fakeDir = (prefix: string) => `${prefix}run${++counter}`;
  const launcherWith = (extra: Parameters<typeof createHelperLauncher>[0] = {}, first?: { pid: number | undefined }) => {
    const spawned = fakeSpawn(first);
    const removed: string[] = [];
    const swept: string[] = [];
    const launch = createHelperLauncher({ spawn: spawned.spawn, env: winEnv, parentPid: 777, script: 'Write-Output 1', tempRoot, makeTempDir: fakeDir, removeDir: async path => { removed.push(path); }, sweep: async root => { swept.push(root); }, ...extra });
    return { ...spawned, removed, swept, launch };
  };

  it('runs Windows PowerShell 5.1 by absolute path, hidden and single-threaded-apartment, with the script encoded', () => {
    const { launch, calls } = launcherWith();
    launch({ windowMs: 300_000 }, events());
    expect(calls).toHaveLength(1);
    const { command, args, options } = calls[0]!;
    expect(command).toBe(join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(isAbsolute(command)).toBe(true);
    expect(args.slice(0, 5)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
    expect(args).toHaveLength(6);
    expect(Buffer.from(args[5]!, 'base64').toString('utf16le')).toBe('Write-Output 1');
    expect(options.windowsHide).toBe(true);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(options.shell).toBeUndefined();
    // Started in its own private folder, never in the service's working folder (the repository agents write to).
    expect(options.cwd).toBe(options.env!.TEMP);
  });

  it('passes a minimal environment: no secrets, no PATH, a private per-run TEMP, the parent pid and the window limit', () => {
    const first = launcherWith(), second = launcherWith();
    first.launch({ windowMs: 300_000 }, events()); second.launch({ windowMs: 1_234 }, events());
    const env = first.calls[0]!.options.env!;
    const run = env.TEMP!;
    expect(env).toEqual({
      SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      TEMP: run, TMP: run, AGENT_TOWN_PARENT_PID: '777', AGENT_TOWN_WINDOW_MS: '300000',
    });
    expect(run.startsWith(join(tempRoot, 'agent-town-folder-'))).toBe(true);
    expect(second.calls[0]!.options.env!.TEMP).not.toBe(run);
    expect(second.calls[0]!.options.env!.AGENT_TOWN_WINDOW_MS).toBe('1234');
    expect(JSON.stringify(env)).not.toContain('secret');
  });

  it('leaves out LOCALAPPDATA when the service has none, and defaults WINDIR to the Windows folder', () => {
    const { launch, calls } = launcherWith({ env: { SystemRoot: 'C:\\Windows' } });
    launch({ windowMs: 1 }, events());
    expect(Object.keys(calls[0]!.options.env!).sort()).toEqual(['AGENT_TOWN_PARENT_PID', 'AGENT_TOWN_WINDOW_MS', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR']);
    expect(calls[0]!.options.env!.WINDIR).toBe('C:\\Windows');
  });

  it('refuses to start without an absolute Windows folder, or with a script too large for a command line, and starts nothing', () => {
    for (const env of [{}, { SystemRoot: 'Windows' }]) {
      const { launch, calls, removed } = launcherWith({ env });
      expect(() => launch({ windowMs: 1 }, events())).toThrow();
      expect(calls).toHaveLength(0); expect(removed).toHaveLength(0);
    }
    const { launch, calls } = launcherWith({ script: 'x'.repeat(MAX_ENCODED_COMMAND_CHARS) });
    expect(() => launch({ windowMs: 1 }, events())).toThrow(/too large/);
    expect(calls).toHaveLength(0);
  });

  it('feeds standard output to the picker, drains standard error, and reports the exit once after the output', async () => {
    const { launch, children, removed } = launcherWith();
    const seen = events();
    const handle = launch({ windowMs: 1 }, seen);
    children[0]!.stdout.emit('data', Buffer.from(open));
    children[0]!.stderr.emit('data', Buffer.from(`native diagnostic mentioning ${PATH}`));
    expect(seen.onOutput).toHaveBeenCalledTimes(1);
    expect(seen.onOutput.mock.calls[0]![0].toString()).toBe(open);
    expect(seen.onExit).not.toHaveBeenCalled();
    children[0]!.stdout.emit('data', Buffer.from(cancelled));
    children[0]!.emit('exit', 0, null); children[0]!.emit('close', 0, null); children[0]!.emit('close', 0, null);
    expect(seen.onExit).toHaveBeenCalledTimes(1);
    await handle.done;
    expect(removed).toEqual([join(tempRoot, 'agent-town-folder-run' + counter)]);
    // Stream errors are absorbed instead of becoming uncaught exceptions.
    expect(() => { children[0]!.stdout.emit('error', new Error('EPIPE')); children[0]!.stderr.emit('error', new Error('EPIPE')); }).not.toThrow();
  });

  it('treats a helper that could not be started as exited', async () => {
    const { launch, children, removed } = launcherWith({}, { pid: undefined });
    const seen = events();
    const handle = launch({ windowMs: 1 }, seen);
    children[0]!.emit('error', new Error('spawn powershell.exe ENOENT'));
    expect(seen.onExit).toHaveBeenCalledTimes(1);
    await handle.done;
    expect(removed).toHaveLength(1);
    // Killing what never started does not run taskkill.
    handle.kill();
  });

  it('does not treat a kill error on a running helper as the helper being gone', () => {
    const { launch, children } = launcherWith();
    const seen = events();
    launch({ windowMs: 1 }, seen);
    children[0]!.emit('error', new Error('kill EPERM'));
    expect(seen.onExit).not.toHaveBeenCalled();
  });

  it('removes its private folder if spawn throws, and lets the error out', async () => {
    const removed: string[] = [];
    const launch = createHelperLauncher({ spawn: () => { throw new Error('EACCES'); }, env: winEnv, script: 'x', tempRoot, makeTempDir: fakeDir, removeDir: async path => { removed.push(path); } });
    expect(() => launch({ windowMs: 1 }, events())).toThrow('EACCES');
    await Promise.resolve(); await Promise.resolve();
    expect(removed).toHaveLength(1);
  });

  it('never deletes a folder outside the temporary root or without its own prefix', async () => {
    for (const make of [() => 'C:\\Windows', () => join(tempRoot, 'not-ours'), () => dirname(tempRoot)]) {
      const { launch, children, removed } = launcherWith({ makeTempDir: make });
      const handle = launch({ windowMs: 1 }, events());
      children[0]!.emit('close', 0, null);
      await handle.done;
      expect(removed).toEqual([]);
    }
  });

  it('creates a real private folder for the run and removes it once the helper has exited', async () => {
    const spawned = fakeSpawn();
    const launch = createHelperLauncher({ spawn: spawned.spawn, env: winEnv, script: 'x' });
    const handle = launch({ windowMs: 1 }, events());
    const run = spawned.calls[0]!.options.env!.TEMP!;
    expect(existsSync(run)).toBe(true);
    expect(dirname(run).toLowerCase()).toBe(tempRoot.toLowerCase());
    spawned.children[0]!.emit('close', 0, null);
    await handle.done;
    expect(existsSync(run)).toBe(false);
  });

  it('clears stale helper folders once per service run, on the first launch only', async () => {
    const { launch, swept } = launcherWith();
    launch({ windowMs: 1 }, events()); launch({ windowMs: 1 }, events());
    await Promise.resolve();
    expect(swept).toEqual([tempRoot]);
  });

  it('never lets a failing sweep stop a helper from starting', () => {
    const { launch, calls } = launcherWith({ sweep: async () => { throw new Error('temporary folder is locked'); } });
    expect(() => launch({ windowMs: 1 }, events())).not.toThrow();
    expect(calls).toHaveLength(1);
  });

  describe('killing', () => {
    it('ends the whole tree with taskkill by absolute path and numeric pid, once', () => {
      const { launch, calls, children } = launcherWith();
      const handle = launch({ windowMs: 1 }, events());
      handle.kill(); handle.kill();
      expect(calls).toHaveLength(2);
      expect(calls[1]!.command).toBe(join('C:\\Windows', 'System32', 'taskkill.exe'));
      expect(isAbsolute(calls[1]!.command)).toBe(true);
      expect(calls[1]!.args).toEqual(['/PID', '4242', '/T', '/F']);
      expect(calls[1]!.options).toMatchObject({ windowsHide: true, stdio: 'ignore', cwd: join('C:\\Windows', 'System32') });
      expect(calls[1]!.options.shell).toBeUndefined();
      children[1]!.emit('exit', 0, null);
      expect(children[0]!.kill).not.toHaveBeenCalled();
    });

    it('falls back to a direct kill when taskkill fails or cannot run', () => {
      for (const failure of [(child: FakeChild) => child.emit('exit', 1, null), (child: FakeChild) => child.emit('error', new Error('ENOENT'))]) {
        const { launch, children } = launcherWith();
        launch({ windowMs: 1 }, events()).kill();
        failure(children[1]!);
        expect(children[0]!.kill).toHaveBeenCalledTimes(1);
      }
      const thrown = launcherWith();
      const spawnOnce = thrown.spawn;
      let calls = 0;
      const launch = createHelperLauncher({ spawn: (...args) => { if (++calls === 2) throw new Error('EACCES'); return spawnOnce(...args); }, env: winEnv, script: 'x', tempRoot, makeTempDir: fakeDir, removeDir: async () => undefined });
      launch({ windowMs: 1 }, events()).kill();
      expect(thrown.children[0]!.kill).toHaveBeenCalledTimes(1);
    });

    it('does nothing once the helper has exited, so a reused pid is never targeted', () => {
      const { launch, calls, children } = launcherWith();
      const handle = launch({ windowMs: 1 }, events());
      children[0]!.exitCode = 0;
      children[0]!.emit('exit', 0, null);
      handle.kill();
      expect(calls).toHaveLength(1);
      const other = launcherWith();
      const second = other.launch({ windowMs: 1 }, events());
      other.children[0]!.exitCode = 0; // Node sets this before it emits 'exit'.
      second.kill();
      expect(other.calls).toHaveLength(1);
    });

    it('never runs taskkill for a pid that is not a positive integer', () => {
      for (const pid of [undefined, 0, -5, Number.NaN, 1.5]) {
        const { launch, calls, children } = launcherWith({}, { pid });
        launch({ windowMs: 1 }, events()).kill();
        expect(calls).toHaveLength(1);
        expect(children[0]!.kill).toHaveBeenCalledTimes(1);
      }
    });
  });

  it('drives the picker end to end through the real launcher, and kills the tree when the picker ends it', async () => {
    const { launch, calls, children, removed } = launcherWith();
    const picker = createFolderPicker({ platform: 'win32', env: winEnv, launcher: launch });
    const pick = picker.start(WORKSPACE);
    expect(calls).toHaveLength(1);
    const bytes = Buffer.from(open + selected(PATH));
    children[0]!.stdout.emit('data', bytes.subarray(0, 10)); children[0]!.stdout.emit('data', bytes.subarray(10));
    expect(picker.status(WORKSPACE, pick.id)).toMatchObject({ state: 'selected', path: PATH });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(['/PID', '4242', '/T', '/F']);
    children[1]!.emit('exit', 0, null);
    children[0]!.emit('exit', 0, null); children[0]!.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.status(WORKSPACE, pick.id)).toMatchObject({ state: 'selected', path: PATH });
    await picker.close();
    expect(removed).toHaveLength(1);
  });
});
