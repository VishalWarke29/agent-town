import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftStore, PrivateStateRegistry, clearsDrafts, createPrivateStateRegistry, draftId, draftStore, keepsConnectionsDrawer, looksLikeCredential, privateResetCause, type DraftKey, type PrivateResetCause } from '../../apps/web/src/draftStore';

// CH-02 and UX-03 (plan v5, milestone V0): the ONE draft store and the ONE list of private screen state.
// D72: drafts are kept in this tab's memory only. Sign-out, an account change and a workspace change clear them;
// an expired session keeps them hidden for the same owner and workspace.

const alice: DraftKey = { owner: 'owner-alice', workspace: 'workspace-one', scope: 'task:new' };
const bob: DraftKey = { ...alice, owner: 'owner-bob' };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the draft store keeps drafts apart by owner, workspace and scope', () => {
  it('never shows one owner\'s text to another owner, another workspace or another scope', () => {
    const store = new DraftStore();
    expect(store.write(alice, 'objective', 'A-PRIVATE rotate the production credentials')).toBe(true);
    expect(store.read(alice, 'objective')).toBe('A-PRIVATE rotate the production credentials');
    expect(store.read(bob, 'objective')).toBeUndefined();
    expect(store.read({ ...alice, workspace: 'workspace-two' }, 'objective')).toBeUndefined();
    expect(store.read({ ...alice, scope: 'task:proposal:p1' }, 'objective')).toBeUndefined();
    expect(store.read(alice, 'criteria')).toBeUndefined();
  });

  it('separates the parts of a key even when a value contains the separator or another key', () => {
    const store = new DraftStore();
    store.write({ owner: 'a', workspace: 'b:c', scope: 'd' }, 'objective', 'first');
    store.write({ owner: 'a:b', workspace: 'c', scope: 'd' }, 'objective', 'second');
    expect(store.read({ owner: 'a', workspace: 'b:c', scope: 'd' }, 'objective')).toBe('first');
    expect(store.read({ owner: 'a:b', workspace: 'c', scope: 'd' }, 'objective')).toBe('second');
    expect(draftId({ owner: 'a', workspace: 'b:c', scope: 'd' })).not.toBe(draftId({ owner: 'a:b', workspace: 'c', scope: 'd' }));
  });

  it('distinguishes text that was never typed from text the person deliberately emptied', () => {
    const store = new DraftStore();
    store.write(alice, 'objective', 'something');
    store.write(alice, 'objective', '');
    expect(store.read(alice, 'objective')).toBe('');
    expect(store.read(alice, 'criteria')).toBeUndefined();
  });

  it.each([
    ['no owner', { owner: null, workspace: 'workspace-one', scope: 'task:new' }],
    ['no workspace', { owner: 'owner-alice', workspace: undefined, scope: 'task:new' }],
    ['an empty owner', { owner: '', workspace: 'workspace-one', scope: 'task:new' }],
    ['no scope', { owner: 'owner-alice', workspace: 'workspace-one', scope: '' }],
  ] satisfies [string, DraftKey][])('refuses to keep anything for a key with %s, so text can never be filed under a blank owner', (_name, key) => {
    const store = new DraftStore();
    expect(draftId(key)).toBeNull();
    expect(store.write(key, 'objective', 'text')).toBe(false);
    expect(store.read(key, 'objective')).toBeUndefined();
    expect(store.saveState(key)).toBe('not-saved');
    expect(store.refusal(key)).toBe('no-owner');
    expect(store.size).toBe(0);
  });
});

describe('save state: Saved, Saving and Not saved', () => {
  it('reads Saving after a keystroke, and Saved after the pause, on flush, and never before', async () => {
    const store = new DraftStore({ autosaveMs: 1000 });
    expect(store.saveState(alice)).toBe('saved');
    store.write(alice, 'objective', 'a');
    expect(store.saveState(alice)).toBe('saving');
    vi.advanceTimersByTime(999);
    expect(store.saveState(alice)).toBe('saving');
    vi.advanceTimersByTime(1);
    expect(store.saveState(alice)).toBe('saved');
    store.write(alice, 'objective', 'ab');
    expect(store.saveState(alice)).toBe('saving');
    await store.flush(alice); // blur, tab hidden or panel closed
    expect(store.saveState(alice)).toBe('saved');
  });

  it('restarts the pause on every keystroke, so a burst of typing is one save', () => {
    const store = new DraftStore({ autosaveMs: 1000 });
    store.write(alice, 'objective', 'a'); vi.advanceTimersByTime(600);
    store.write(alice, 'objective', 'ab'); vi.advanceTimersByTime(600);
    expect(store.saveState(alice)).toBe('saving');
    vi.advanceTimersByTime(400);
    expect(store.saveState(alice)).toBe('saved');
  });

  it('flushes every pending draft when asked without a key (tab hidden)', async () => {
    const store = new DraftStore();
    store.write(alice, 'objective', 'one'); store.write(bob, 'objective', 'two');
    await store.flush();
    expect([store.saveState(alice), store.saveState(bob)]).toEqual(['saved', 'saved']);
  });

  it('a failed server copy reads Not saved, keeps the text, and the next keystroke tries again', async () => {
    let fail = true;
    const copies: string[] = [];
    const store = new DraftStore({ persist: async draft => { copies.push(draft.fields.get('objective') ?? ''); if (fail) throw new Error('offline'); } });
    store.write(alice, 'objective', 'keep me');
    await store.flush(alice);
    expect(store.saveState(alice)).toBe('not-saved');
    expect(store.refusal(alice)).toBe('save-failed');
    expect(store.read(alice, 'objective')).toBe('keep me');
    fail = false;
    store.write(alice, 'objective', 'keep me still');
    expect(store.saveState(alice)).toBe('saving');
    await store.flush(alice);
    expect(store.saveState(alice)).toBe('saved');
    expect(store.refusal(alice)).toBeNull();
    expect(copies).toEqual(['keep me', 'keep me still']);
  });

  it('text typed while a copy is being made is copied next and is not reported as saved early', async () => {
    let release!: () => void;
    const copies: string[] = [];
    const store = new DraftStore({ persist: draft => new Promise<void>(resolve => { copies.push(draft.fields.get('objective') ?? ''); release = resolve; }) });
    store.write(alice, 'objective', 'first');
    const pending = store.flush(alice);
    store.write(alice, 'objective', 'first and more');
    release(); await pending;
    await vi.waitFor(() => expect(copies).toEqual(['first', 'first and more']));
    expect(store.saveState(alice)).toBe('saving');
    release();
    await vi.waitFor(() => expect(store.saveState(alice)).toBe('saved'));
  });

  it('does not touch the draft again when the same text is written twice', () => {
    const store = new DraftStore();
    store.write(alice, 'objective', 'same');
    const before = store.version(alice);
    store.write(alice, 'objective', 'same');
    expect(store.version(alice)).toBe(before);
  });
});

describe('a draft never holds a key or a token', () => {
  it.each([
    ['an OpenAI or Anthropic key', 'use sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 for this'],
    ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0abcdefghijklmnop'],
    ['a Slack token', 'xoxb-123456789012-abcdefghijkl'],
    ['an AWS access key id', 'AKIAABCDEFGHIJKLMNOP'],
    ['a private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIB'],
    ['a bearer credential', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.0123456789'],
  ])('refuses %s, reads Not saved, and never returns it', (_name, text) => {
    const store = new DraftStore();
    expect(looksLikeCredential(text)).toBe(true);
    store.write(alice, 'objective', 'a safe start');
    expect(store.write(alice, 'objective', text)).toBe(false);
    expect(store.saveState(alice)).toBe('not-saved');
    expect(store.refusal(alice)).toBe('looks-like-a-key');
    expect(store.read(alice, 'objective')).toBe('a safe start');
    expect(store.write(alice, 'criteria', text)).toBe(false);
    expect(store.read(alice, 'criteria')).toBeUndefined(); // a field that never held a safe value holds nothing at all
    // removing the secret from the text makes the next write keep normally
    expect(store.write(alice, 'objective', 'a safe start, edited')).toBe(true);
    expect(store.saveState(alice)).toBe('saving');
    expect(store.refusal(alice)).toBeNull();
  });

  it('keeps ordinary sentences that only resemble a key', () => {
    for (const text of ['Fix the task-management flow', 'Reduce risk-adjusted disk-usage reporting', 'Add a sk- prefix note to the docs', 'Read the Bearer token section of the guide']) {
      expect(looksLikeCredential(text)).toBe(false);
    }
  });
});

describe('what leaves the store: discard, clear, and keeping only the signed-in owner\'s drafts', () => {
  it('discard forgets one draft only', () => {
    const store = new DraftStore();
    store.write(alice, 'objective', 'a'); store.write({ ...alice, scope: 'task:proposal:p1' }, 'objective', 'b');
    store.discard(alice);
    expect(store.read(alice, 'objective')).toBeUndefined();
    expect(store.read({ ...alice, scope: 'task:proposal:p1' }, 'objective')).toBe('b');
  });

  it('clear forgets every owner\'s drafts and cancels their timers', () => {
    const store = new DraftStore({ persist: vi.fn(async () => undefined) });
    store.write(alice, 'objective', 'a'); store.write(bob, 'objective', 'b');
    store.clear();
    expect(store.size).toBe(0);
    expect(store.read(alice, 'objective')).toBeUndefined();
    expect(store.read(bob, 'objective')).toBeUndefined();
    vi.advanceTimersByTime(5000); // a cancelled pause must not bring a draft back or copy it
    expect(store.size).toBe(0);
  });

  it('retainOnly keeps the signed-in owner\'s drafts in this workspace and removes everything else', () => {
    const store = new DraftStore();
    store.write(alice, 'objective', 'mine');
    store.write({ ...alice, scope: 'task:proposal:p1' }, 'objective', 'mine too');
    store.write(bob, 'objective', 'someone else, expired earlier');
    store.write({ ...alice, workspace: 'workspace-two' }, 'objective', 'my other workspace');
    store.retainOnly('owner-alice', 'workspace-one');
    expect(store.size).toBe(2);
    expect(store.read(alice, 'objective')).toBe('mine');
    expect(store.read(bob, 'objective')).toBeUndefined();
    expect(store.read({ ...alice, workspace: 'workspace-two' }, 'objective')).toBeUndefined();
  });
});

describe('subscriptions: a keystroke redraws only its own draft', () => {
  it('changes only the written draft\'s version and tells listeners, until they unsubscribe', () => {
    const store = new DraftStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const other: DraftKey = { ...alice, scope: 'chat:house-1' };
    const otherBefore = store.version(other), aliceBefore = store.version(alice);
    store.write(alice, 'objective', 'x');
    expect(store.version(alice)).not.toBe(aliceBefore);
    expect(store.version(other)).toBe(otherBefore);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    store.write(alice, 'objective', 'xy');
    expect(listener).not.toHaveBeenCalled();
  });

  it('never repeats a version, so a cleared draft that is typed again redraws its consumer', () => {
    const store = new DraftStore();
    store.write(alice, 'objective', 'one');
    const seen = new Set([store.version(alice)]);
    store.clear();
    seen.add(store.version(alice));
    store.write(alice, 'objective', 'two');
    seen.add(store.version(alice));
    expect(seen.size).toBe(3);
  });
});

describe('resetPrivateState: one reset for an owner change, a workspace change and a sign-out', () => {
  const causes: PrivateResetCause[] = ['signed-out', 'session-expired', 'account-changed', 'workspace-changed'];

  it.each(causes)('%s: the draft store is registered, and it is cleared unless the session simply expired (D72)', cause => {
    const store = new DraftStore();
    const registry = createPrivateStateRegistry(store);
    store.write(alice, 'objective', 'unsent'); store.write(alice, 'criteria', 'one\ntwo');
    registry.resetPrivateState(cause);
    if (cause === 'session-expired') {
      expect(store.read(alice, 'objective')).toBe('unsent'); // hidden in memory for the same owner and workspace
      expect(store.read(alice, 'criteria')).toBe('one\ntwo');
      expect(store.read(bob, 'objective')).toBeUndefined(); // and never shown to anyone else
    } else {
      expect(store.size).toBe(0);
      expect(store.read(alice, 'objective')).toBeUndefined();
    }
    expect(clearsDrafts(cause)).toBe(cause !== 'session-expired');
  });

  it('runs every registered reset with the cause, and stops running one that unregistered', () => {
    const registry = new PrivateStateRegistry();
    const seen: string[] = [];
    const off = registry.register(cause => seen.push(`a:${cause}`));
    registry.register(cause => seen.push(`b:${cause}`));
    registry.resetPrivateState('signed-out');
    off();
    registry.resetPrivateState('account-changed');
    expect(seen).toEqual(['a:signed-out', 'b:signed-out', 'b:account-changed']);
  });

  it('keeps an open Connections drawer for sign-out, expiry and an account change, and closes it for a workspace change', () => {
    expect(causes.filter(keepsConnectionsDrawer)).toEqual(['signed-out', 'session-expired', 'account-changed']);
  });
});

describe('privateResetCause: which identity changes reset what', () => {
  const a = { userId: 'owner-a', workspaceId: 'ws-a' }, b = { userId: 'owner-b', workspaceId: 'ws-b' };
  const signedOut = { userId: null, workspaceId: null };

  it('treats a lost user id as a sign-out when the person asked for it, and as an expired session otherwise', () => {
    expect(privateResetCause(a, signedOut, true)).toBe('signed-out');
    expect(privateResetCause(a, signedOut, false)).toBe('session-expired');
    expect(privateResetCause(a, { userId: undefined, workspaceId: undefined }, false)).toBe('session-expired');
  });

  it('treats a changed user id as an account change, even when the workspace changes with it and even when the person signed out first', () => {
    expect(privateResetCause(a, b, false)).toBe('account-changed');
    expect(privateResetCause(a, { userId: 'owner-b', workspaceId: 'ws-a' }, false)).toBe('account-changed');
    expect(privateResetCause(a, b, true)).toBe('account-changed');
  });

  it('treats a changed workspace for the same user as a workspace change', () => {
    expect(privateResetCause(a, { userId: 'owner-a', workspaceId: 'ws-c' }, false)).toBe('workspace-changed');
    expect(privateResetCause(a, { userId: 'owner-a', workspaceId: 'ws-c' }, true)).toBe('workspace-changed'); // the sign-out intent only matters when the user id is lost
  });

  it('resets nothing for signed-out to signed-in, for no workspace to the first workspace, or for no change (WS1-02, WS1-08)', () => {
    expect(privateResetCause(signedOut, a, false)).toBeNull();
    expect(privateResetCause({ userId: undefined, workspaceId: undefined }, a, false)).toBeNull();
    expect(privateResetCause({ userId: 'owner-a', workspaceId: null }, a, false)).toBeNull();
    expect(privateResetCause(a, a, false)).toBeNull();
    expect(privateResetCause(a, { userId: 'owner-a', workspaceId: null }, false)).toBeNull(); // no workspace after the first one is not a switch
  });
});

// The next three groups read the source. They are tripwires for the rules in the plan, in the style of the copy registry:
// a change that breaks one has to say so on purpose.
const webSource = join(process.cwd(), 'apps', 'web', 'src');
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => { const path = join(directory, name); return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : []; });
}
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([;{}),])\s*\/\/.*$/gm, '$1');

describe('there is exactly one draft store, and it stays in this tab', () => {
  it('is made once, in draftStore.ts, and nowhere else under apps/web', () => {
    const makers = sourceFiles(webSource).filter(file => /\bnew DraftStore\(/.test(stripComments(readFileSync(file, 'utf8'))));
    expect(makers.map(file => relative(webSource, file).replaceAll('\\', '/'))).toEqual(['draftStore.ts']);
    expect((stripComments(readFileSync(join(webSource, 'draftStore.ts'), 'utf8')).match(/\bnew DraftStore\(/g) ?? [])).toHaveLength(1);
    expect(draftStore).toBeInstanceOf(DraftStore);
  });

  it('never reaches browser storage or the network (D72: memory only, never on disk, never sent)', () => {
    const code = stripComments(readFileSync(join(webSource, 'draftStore.ts'), 'utf8'));
    expect(code.match(/\b(localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|BroadcastChannel|WebSocket|EventSource|sendBeacon|caches)\b/)?.[0] ?? null).toBeNull();
  });

  it('is the only place app code keeps draft text: the Tasks form reads and writes its text through useDraft, not through useState', () => {
    const runner = stripComments(readFileSync(join(webSource, 'RunnerPanel.tsx'), 'utf8'));
    expect(/\buseDraft\(/.test(runner), 'RunnerPanel keeps the Tasks text in the draft store').toBe(true);
    expect(/\[\s*(objective|criteria)\s*,\s*set\w+\s*\]\s*=\s*useState/.test(runner), 'the Tasks text must not be plain component state').toBe(false);
    const app = stripComments(readFileSync(join(webSource, 'App.tsx'), 'utf8'));
    expect(/\[\s*(objective|criteria|draftText|taskDraft)\w*\s*,/.test(app), 'App must not hold draft text in its own state').toBe(false);
  });
});

describe('a new private field in App cannot be added without being reset', () => {
  // Every state field App declares is either private (declared through usePrivateState, so resetPrivateState()
  // reaches it) or on this list with the reason it is safe to keep across accounts. A new plain useState fails
  // here until somebody decides which it is.
  const notPrivate: Record<string, string> = {
    activityNow: 'a clock tick', listRequested: 'the person\'s view choice, no account data', webglUnavailable: 'a browser capability',
    billing: 'a setup preview toggle, no account data', localNotice: 'a fullscreen or browser message, no account data', returningVisitor: 'a per-browser first-run flag',
  };
  const privateFields = ['showChildAgents', 'section', 'selection', 'archiveMode', 'rosterOpen', 'trackingRepoId', 'pendingRepoId', 'trackingHint', 'cameraMenu', 'follow', 'query', 'draftProposal', 'cameraAction'];
  const app = (() => { const text = stripComments(readFileSync(join(webSource, 'App.tsx'), 'utf8')); return text.slice(text.indexOf('export function App()')); })();
  const declared = (hook: string) => [...app.matchAll(new RegExp(`const \\[(\\w+),\\s*\\w+\\]\\s*=\\s*${hook}\\b`, 'g'))].map(match => match[1]!);

  it('declares every account-owned field through usePrivateState', () => {
    expect(declared('usePrivateState').sort()).toEqual([...privateFields].sort());
  });

  it('declares no other plain useState field without a written reason', () => {
    const plain = declared('useState');
    const unclassified = plain.filter(name => !(name in notPrivate));
    expect(unclassified, `Classify ${unclassified.join(', ')}: declare it with usePrivateState (reset on sign-out, account change and workspace change), or add it to notPrivate with the reason it is safe to keep.`).toEqual([]);
    expect(plain.filter(name => privateFields.includes(name)), 'a private field must not be a plain useState').toEqual([]);
  });

  it('resets private state from one place: the identity effect calls resetPrivateState with the cause', () => {
    expect(/privateResetCause\(/.test(app), 'App asks privateResetCause which reset an identity change needs').toBe(true);
    expect((app.match(/\.resetPrivateState\(/g) ?? []).length, 'exactly one call site clears private state').toBe(1);
  });
});
