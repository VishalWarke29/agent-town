import { afterEach, describe, expect, it } from 'vitest';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { renameWithRetry } from '../../scripts/atomic-write.mjs';
import { bridgeBuild, bridgeRebuiltSinceStart } from '../../apps/service/src/served-web';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = realpathSync(directory), base = realpathSync(tmpdir()), remainder = relative(base, target);
    if (!remainder || remainder.startsWith('..') || isAbsolute(remainder) || !target.includes('agent-town-atomic-')) throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
function scratch() { const directory = mkdtempSync(join(tmpdir(), 'agent-town-atomic-')); directories.push(directory); return directory; }

describe('renameWithRetry (WS3-24: atomic bridge build)', () => {
  it('renames in one attempt when nothing is holding the destination', async () => {
    const directory = scratch(), from = join(directory, 'a.tmp'), to = join(directory, 'a.txt');
    writeFileSync(from, 'new content');
    await renameWithRetry(from, to);
    expect(existsSync(from)).toBe(false); expect(readFileSync(to, 'utf8')).toBe('new content');
  });

  it('retries past a transient Windows lock on the destination and still succeeds', async () => {
    const directory = scratch(), from = join(directory, 'a.tmp'), to = join(directory, 'a.txt');
    writeFileSync(from, 'new content'); writeFileSync(to, 'old content');
    // A held handle blocks the rename with a real EPERM/EBUSY on Windows (Node's default share mode
    // excludes FILE_SHARE_DELETE); releasing it partway through the retry window is the same
    // transient condition renameWithRetry exists for — a reader briefly holding the file open.
    const handle = openSync(to, 'r+');
    setTimeout(() => closeSync(handle), 150);
    await renameWithRetry(from, to, 5, 1500);
    expect(existsSync(from)).toBe(false); expect(readFileSync(to, 'utf8')).toBe('new content');
  });

  it('gives up after the last attempt, leaving both files exactly as they were, and reports a plain error', async () => {
    const directory = scratch(), from = join(directory, 'a.tmp'), to = join(directory, 'a.txt');
    writeFileSync(from, 'new content'); writeFileSync(to, 'old content');
    const handle = openSync(to, 'r+');
    try { await expect(renameWithRetry(from, to, 3, 30)).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EBUSY/) }); }
    finally { closeSync(handle); }
    expect(existsSync(from)).toBe(true); expect(readFileSync(to, 'utf8')).toBe('old content');
  });

  it('never lets a concurrent reader see a partial file across many repeated swaps', async () => {
    const directory = scratch(), target = join(directory, 'hook-bridge.cjs');
    const oldContent = 'A'.repeat(5000), newContent = 'B'.repeat(7000);
    writeFileSync(target, oldContent);
    let stop = false, partialReads = 0, sawNew = false;
    const reader = (async () => {
      while (!stop) {
        let content: string;
        try { content = readFileSync(target, 'utf8'); } catch { await new Promise(resolve => setImmediate(resolve)); continue; }
        if (content === newContent) sawNew = true;
        else if (content !== oldContent) partialReads++;
        // A synchronous read loop with no await starves the event loop, so the writer's own awaited
        // rename() never gets a turn to resolve; a short real delay (not just a tick) also keeps this
        // reader from creating far more handle contention than any real hook invocation ever would.
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    })();
    const writer = (async () => {
      for (let round = 0; round < 20; round++) {
        const temporary = join(directory, `hook-bridge.cjs.tmp-${round}`);
        writeFileSync(temporary, round % 2 === 0 ? newContent : oldContent);
        // A generous retry budget here absorbs this test's own artificially heavy read contention
        // (far beyond a real hook's one-time read); scripts/build-service.mjs uses the tighter
        // production default (3 attempts / ~1s), covered by the dedicated retry tests above.
        await renameWithRetry(temporary, target, 20, 2000);
      }
      stop = true;
    })();
    await writer; await reader;
    expect(partialReads).toBe(0); expect(sawNew).toBe(true);
  });
});

describe('bridgeBuild and bridgeRebuiltSinceStart (WS3-24)', () => {
  it('reads a well-formed manifest written beside the bridge', async () => {
    const directory = scratch(), builtAt = new Date().toISOString();
    writeFileSync(join(directory, 'hook-bridge-build.json'), JSON.stringify({ id: 'abcdef012345', builtAt }));
    expect(await bridgeBuild(directory)).toEqual({ buildId: 'abcdef012345', builtAt });
  });

  it('reads as unknown, not mismatched, when the manifest is missing, malformed, or the wrong shape', async () => {
    const missing = scratch();
    expect(await bridgeBuild(missing)).toEqual({ buildId: null, builtAt: null });
    const malformed = scratch(); writeFileSync(join(malformed, 'hook-bridge-build.json'), 'not valid json{{{');
    expect(await bridgeBuild(malformed)).toEqual({ buildId: null, builtAt: null });
    const wrongShape = scratch(); writeFileSync(join(wrongShape, 'hook-bridge-build.json'), JSON.stringify({ id: 'not-hex!!', builtAt: 'not-a-date' }));
    expect(await bridgeBuild(wrongShape)).toEqual({ buildId: null, builtAt: null });
  });

  it('flags a genuine mismatch, never an absent manifest, and never in development', () => {
    expect(bridgeRebuiltSinceStart({ buildId: 'newbuild00001' }, 'oldbuild00001', false)).toBe(true);
    expect(bridgeRebuiltSinceStart({ buildId: 'samebuild0001' }, 'samebuild0001', false)).toBe(false);
    expect(bridgeRebuiltSinceStart({ buildId: null }, 'oldbuild00001', false)).toBe(false);
    expect(bridgeRebuiltSinceStart({ buildId: 'newbuild00001' }, 'oldbuild00001', true)).toBe(false);
  });
});
