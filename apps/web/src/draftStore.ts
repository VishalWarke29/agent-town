import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * The ONE draft store of the whole app, and the ONE list of private screen state that goes with it
 * (CH-02 and UX-03, plan v5; decision D72).
 *
 * Why it exists: half-typed text must survive closing a side panel (Escape, Close, a resize) but must never
 * reach another person on the same screen. So drafts live here, outside App's useState (World is not
 * memoized, so draft text in App state would redraw the whole 3D scene on every keystroke), are keyed by
 * owner + workspace + scope, are kept in this tab's memory only (never browser storage, never the service),
 * and are cleared by resetPrivateState() when the person signs out, switches account or switches workspace.
 * When a session simply expires, drafts stay in memory, hidden, for the same owner and workspace (D72).
 *
 * UX-16 (every other form) and CH-10 (the chat) add consumers of this store. Neither builds another one, and
 * neither keeps draft text in App state. tests/unit/draft-store.test.ts fails on a second store.
 *
 * Save state: a write is "Saving" until it is flushed (after a short pause, on blur, when the tab is hidden and
 * when the panel closes), then "Saved". Here "Saved" means kept in this tab; a consumer with a server copy hands
 * the store a persist function, and a failed copy reads "Not saved" while the text stays. A value that looks like
 * a key or a token is never kept: it reads "Not saved".
 */

export type DraftSaveState = 'saved' | 'saving' | 'not-saved';
export type DraftRefusal = 'looks-like-a-key' | 'no-owner' | 'save-failed';

/** A draft belongs to one owner in one workspace and one scope (the Tasks form today; a project, or in the chat a house, later). */
export interface DraftKey { readonly owner: string | null | undefined; readonly workspace: string | null | undefined; readonly scope: string }

/** null when the key cannot be trusted to keep drafts apart: nothing is stored under it. */
export function draftId(key: DraftKey): string | null {
  return key.owner && key.workspace && key.scope ? JSON.stringify([key.owner, key.workspace, key.scope]) : null;
}

// Well-known credential shapes. At least as strict as the service's own redaction (observation/normalize.ts,
// workflow/provider.ts) and a strict superset of the narrower check runner/service.ts uses to refuse a task draft.
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9_]{16,}/, /\bgithub_pat_[A-Za-z0-9_]{16,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
];
export function looksLikeCredential(text: string): boolean { return CREDENTIAL_SHAPES.some(shape => shape.test(text)); }

export interface PersistedDraft { readonly owner: string; readonly workspace: string; readonly scope: string; readonly fields: ReadonlyMap<string, string> }
export interface DraftStoreOptions {
  /** Pause after the last keystroke before a draft counts as saved. */
  readonly autosaveMs?: number;
  /** Optional server copy for a consumer that has one. Without it "Saved" means kept in this tab's memory. */
  readonly persist?: (draft: PersistedDraft) => Promise<void>;
}

interface Draft {
  readonly owner: string; readonly workspace: string; readonly scope: string;
  readonly fields: Map<string, string>;
  save: DraftSaveState; refusal: DraftRefusal | null;
  revision: number; timer: ReturnType<typeof setTimeout> | null; inFlight: Promise<void> | null;
}

export class DraftStore {
  private readonly drafts = new Map<string, Draft>();
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private counter = 0;
  constructor(private readonly options: DraftStoreOptions = {}) {}

  /** For useSyncExternalStore. A change tells every listener; each consumer compares its own draft's version. */
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** Changes whenever this draft changes (a value never repeats), so a keystroke in one draft redraws only its own consumer. */
  version(key: DraftKey): number { const id = draftId(key); return id === null ? 0 : this.versions.get(id) ?? 0; }
  get size(): number { return this.drafts.size; }

  read(key: DraftKey, field: string): string | undefined { const id = draftId(key); return id === null ? undefined : this.drafts.get(id)?.fields.get(field); }
  saveState(key: DraftKey): DraftSaveState { const id = draftId(key); return id === null ? 'not-saved' : this.drafts.get(id)?.save ?? 'saved'; }
  refusal(key: DraftKey): DraftRefusal | null { const id = draftId(key); return id === null ? 'no-owner' : this.drafts.get(id)?.refusal ?? null; }

  /** Keeps a value. Returns false when it was NOT kept (no owner or workspace to keep it apart, or it looks like a key or token). */
  write(key: DraftKey, field: string, value: string): boolean {
    const id = draftId(key);
    if (id === null) return false;
    let draft = this.drafts.get(id);
    if (!draft) { draft = { owner: key.owner!, workspace: key.workspace!, scope: key.scope, fields: new Map(), save: 'saved', refusal: null, revision: 0, timer: null, inFlight: null }; this.drafts.set(id, draft); }
    if (looksLikeCredential(value)) { draft.save = 'not-saved'; draft.refusal = 'looks-like-a-key'; this.touch(id); return false; }
    if (draft.fields.get(field) === value && draft.save !== 'not-saved') return true;
    draft.fields.set(field, value); draft.refusal = null; draft.save = 'saving'; draft.revision++;
    if (draft.timer !== null) clearTimeout(draft.timer);
    draft.timer = setTimeout(() => { void this.settle(id); }, this.options.autosaveMs ?? 1000);
    this.touch(id);
    return true;
  }

  /** Flush on blur, when the tab is hidden and on close: pending drafts count as saved now instead of after the pause. */
  async flush(key?: DraftKey): Promise<void> {
    const ids = key ? [draftId(key)] : [...this.drafts.keys()];
    await Promise.all(ids.map(id => id === null ? undefined : this.settle(id)));
  }

  private settle(id: string): Promise<void> {
    const draft = this.drafts.get(id);
    if (!draft || draft.save !== 'saving') return draft?.inFlight ?? Promise.resolve();
    if (draft.timer !== null) { clearTimeout(draft.timer); draft.timer = null; }
    const persist = this.options.persist;
    if (!persist) { draft.save = 'saved'; this.touch(id); return Promise.resolve(); }
    if (draft.inFlight) return draft.inFlight;
    const revision = draft.revision;
    const finish = (save: DraftSaveState, refusal: DraftRefusal | null) => {
      draft.inFlight = null;
      if (this.drafts.get(id) !== draft) return;
      // Text typed while the copy was being made is not in it: it stays "Saving" and is copied next.
      if (draft.revision !== revision) { void this.settle(id); return; }
      draft.save = save; draft.refusal = refusal; this.touch(id);
    };
    draft.inFlight = persist({ owner: draft.owner, workspace: draft.workspace, scope: draft.scope, fields: new Map(draft.fields) }).then(() => finish('saved', null), () => finish('not-saved', 'save-failed'));
    return draft.inFlight;
  }

  /** Forgets one draft (for example once its text has become a saved task). */
  discard(key: DraftKey): void { const id = draftId(key); if (id !== null) this.remove(id); }
  /** resetPrivateState(): forgets every draft, for every owner. */
  clear(): void { for (const id of [...this.drafts.keys()]) this.remove(id); }
  /** Whoever is signed in now keeps only their own drafts in this workspace: another person's hidden leftovers go. */
  retainOnly(owner: string, workspace: string): void { for (const [id, draft] of [...this.drafts]) if (draft.owner !== owner || draft.workspace !== workspace) this.remove(id); }

  private remove(id: string) {
    const draft = this.drafts.get(id);
    if (draft?.timer != null) clearTimeout(draft.timer);
    this.drafts.delete(id); this.versions.delete(id);
    for (const listener of [...this.listeners]) listener();
  }
  private touch(id: string) {
    this.versions.set(id, ++this.counter);
    for (const listener of [...this.listeners]) listener();
  }
}

/** The one draft store. Only this file makes one. */
export const draftStore = new DraftStore();

export interface DraftHandle {
  /** What is on screen for this field: the kept text, or what was typed if it could not be kept. undefined when nothing was ever typed. */
  readonly get: (field: string) => string | undefined;
  readonly set: (field: string, value: string) => void;
  readonly discard: () => void;
  /** Blur: count what was typed as saved now instead of after the pause. */
  readonly flush: () => void;
  readonly saveState: DraftSaveState;
  readonly refusal: DraftRefusal | null;
}

/**
 * A consumer's view of one draft. It redraws only when this draft changes, keeps typing working when a value
 * cannot be kept (the text stays on screen, marked "Not saved", until the panel closes), and flushes on blur,
 * when the tab is hidden and when the panel closes.
 */
export function useDraft(key: DraftKey, store: DraftStore = draftStore): DraftHandle {
  const id = draftId(key);
  useSyncExternalStore(store.subscribe, () => store.version(key));
  const [held, setHeld] = useState<{ id: string | null; fields: ReadonlyMap<string, string> }>({ id, fields: new Map() });
  const typed = held.id === id ? held.fields : new Map<string, string>();
  useEffect(() => {
    const flush = () => { void store.flush(key); };
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', flush);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', flush); flush(); };
    // The key is fully described by its id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, store]);
  return {
    get: field => typed.get(field) ?? store.read(key, field),
    set: (field, value) => {
      const kept = store.write(key, field, value);
      if (kept && !typed.has(field)) return; // the common keystroke: the store already holds it, and nothing else on screen changes
      setHeld(current => { const fields = new Map(current.id === id ? current.fields : []); if (kept) fields.delete(field); else fields.set(field, value); return { id, fields }; });
    },
    discard: () => { store.discard(key); setHeld({ id, fields: new Map() }); },
    flush: () => { void store.flush(key); },
    saveState: typed.size > 0 ? 'not-saved' : store.saveState(key),
    refusal: typed.size > 0 ? store.refusal(key) ?? 'looks-like-a-key' : store.refusal(key),
  };
}

/** Why the private state is being reset. A session that ends by itself is the only one that keeps drafts (D72). */
export type PrivateResetCause = 'signed-out' | 'session-expired' | 'account-changed' | 'workspace-changed';
/** Sign-out and expiry, and a change of account, keep an open Connections drawer (the sign-in surface, WS1-02). A change of workspace closes it. */
export const keepsConnectionsDrawer = (cause: PrivateResetCause): boolean => cause !== 'workspace-changed';
export const clearsDrafts = (cause: PrivateResetCause): boolean => cause !== 'session-expired';

export interface IdentityView { readonly userId: string | null | undefined; readonly workspaceId: string | null | undefined }
/**
 * What, if anything, the move from one identity to the next must reset. A lost or changed user id is an owner change.
 * Signed-out to signed-in, and no workspace to the first workspace, reset nothing (that is what kept the Connections
 * drawer open through sign-in, WS1-02). explicitSignOut is true only for the person's own Sign out or Disconnect GitHub.
 */
export function privateResetCause(previous: IdentityView, next: IdentityView, explicitSignOut: boolean): PrivateResetCause | null {
  if (previous.userId && !next.userId) return explicitSignOut ? 'signed-out' : 'session-expired';
  if (previous.userId && next.userId && previous.userId !== next.userId) return 'account-changed';
  if (previous.workspaceId && next.workspaceId && previous.workspaceId !== next.workspaceId) return 'workspace-changed';
  return null;
}

/**
 * The ONE list of private screen state. Anything a person's account or workspace owns and another person must not
 * see (a manager proposal, a search, a selection, follow mode, tracking hints, drafts) is declared with
 * usePrivateState, or registered here, so resetPrivateState() reaches it. A plain useState in App is therefore a
 * decision, and tests/unit/draft-store.test.ts makes it a written one.
 */
export class PrivateStateRegistry {
  private readonly resets = new Set<(cause: PrivateResetCause) => void>();
  get size(): number { return this.resets.size; }
  register(reset: (cause: PrivateResetCause) => void): () => void { this.resets.add(reset); return () => { this.resets.delete(reset); }; }
  /** One reset for an owner change, a workspace change and a sign-out. */
  resetPrivateState(cause: PrivateResetCause): void { for (const reset of [...this.resets]) reset(cause); }
}

/** A registry that already holds the draft store: the store registers with resetPrivateState() by construction. */
export function createPrivateStateRegistry(drafts: DraftStore = draftStore): PrivateStateRegistry {
  const registry = new PrivateStateRegistry();
  registry.register(cause => { if (clearsDrafts(cause)) drafts.clear(); });
  return registry;
}

/** useState for private screen state: reset to its first value (or to what `reset` returns) by resetPrivateState(). */
export function usePrivateState<T>(registry: PrivateStateRegistry, initial: T, reset?: (current: T, cause: PrivateResetCause) => T) {
  const [value, setValue] = useState<T>(initial);
  const first = useRef(initial), custom = useRef(reset);
  custom.current = reset;
  useEffect(() => registry.register(cause => setValue(current => custom.current ? custom.current(current, cause) : first.current)), [registry]);
  return [value, setValue] as const;
}
