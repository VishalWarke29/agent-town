import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createFolderPicker, createHelperLauncher, type FolderPicker } from '../../apps/service/src/folder-picker';
import { realToolSuite, type RealToolGate } from '../helpers/real-tool-test';

/**
 * Opt-in checks with the real helper: they open real folder windows on this desktop and close them again, so they only
 * run when asked for and need a signed-in Windows desktop that nobody is using for the next half minute:
 *
 *   $env:AGENT_TOWN_REAL_FOLDER_PICKER = '1'; npx vitest run tests/unit/folder-picker-real.test.ts
 *
 * What a person does inside the window (choosing a folder, typing a path, keyboard-only use) is covered by
 * tests/smoke/folder-picker-smoke.mjs, which drives the window through UI Automation.
 */
// Not switched on, these show in the report as skipped WITH the written reason (FD-06), not as a bare skip.
const realWindow: RealToolGate = { enabledBy: 'AGENT_TOWN_REAL_FOLDER_PICKER', needs: 'a real Windows folder window on a signed-in desktop that nobody is using', platform: 'win32' };

const windowsPowerShells = (): Set<number> => {
  const output = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq powershell.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
  return new Set([...output.matchAll(/^"powershell\.exe","(\d+)"/gim)].map(match => Number(match[1])));
};

async function untilNoneAdded(before: Set<number>, withinMs: number): Promise<number[]> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const added = [...windowsPowerShells()].filter(pid => !before.has(pid));
    if (!added.length || Date.now() > deadline) return added;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

describe('folder window helper (real windows)', () => {
  realToolSuite(realWindow);
  let picker: FolderPicker | undefined;
  afterEach(async () => { await picker?.close(); picker = undefined; });

  it('opens a real window, and cancelling it ends the helper', async () => {
    const before = windowsPowerShells();
    picker = createFolderPicker();
    const began = Date.now();
    const started = picker.start('workspace-1');
    const opened = await picker.whenOpened('workspace-1', started.id);
    expect(opened.state, 'the window must be up before the handshake ends').toBe('waiting');
    expect(Date.now() - began).toBeLessThan(8_000);
    // A second click while it is open starts nothing new.
    expect(picker.start('workspace-1')).toMatchObject({ id: started.id, alreadyOpen: true });
    expect(picker.cancel('workspace-1', started.id)).toMatchObject({ state: 'cancelled' });
    expect(await untilNoneAdded(before, 5_000)).toEqual([]);
  }, 30_000);

  it('closes the window at the service window limit, so an abandoned window never stays open', async () => {
    const before = windowsPowerShells();
    picker = createFolderPicker({ limits: { windowMs: 4_000 } });
    const started = picker.start('workspace-1');
    expect((await picker.whenOpened('workspace-1', started.id)).state).toBe('waiting');
    await new Promise(resolve => setTimeout(resolve, 4_500));
    expect(picker.status('workspace-1', started.id)).toMatchObject({ state: 'timed-out' });
    expect(await untilNoneAdded(before, 5_000)).toEqual([]);
  }, 30_000);

  it('closes the window by itself at its own limit when the service never asks (the helper clock, not the service clock)', async () => {
    const before = windowsPowerShells();
    const launch = createHelperLauncher();
    // The service keeps its normal 5-minute limit; only the helper is told to stop after 4 seconds.
    picker = createFolderPicker({ launcher: (request, events) => launch({ ...request, windowMs: 4_000 }, events) });
    const started = picker.start('workspace-1');
    expect((await picker.whenOpened('workspace-1', started.id)).state).toBe('waiting');
    const deadline = Date.now() + 8_000;
    while (picker.status('workspace-1', started.id).state === 'waiting' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    expect(picker.status('workspace-1', started.id)).toMatchObject({ state: 'cancelled' });
    expect(await untilNoneAdded(before, 5_000)).toEqual([]);
  }, 30_000);

  it('leaves no helper behind when the service shuts down with a window open', async () => {
    const before = windowsPowerShells();
    picker = createFolderPicker();
    const started = picker.start('workspace-1');
    expect((await picker.whenOpened('workspace-1', started.id)).state).toBe('waiting');
    await picker.close();
    expect(await untilNoneAdded(before, 5_000)).toEqual([]);
  }, 30_000);
});
