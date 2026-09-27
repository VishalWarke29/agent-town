import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { FOLDER_PICK_LIMITS, folderPickStates, type FolderPick } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';
import { folderPickUnavailableText, folderWindowText } from './reasonText';

/**
 * The state machine behind the "Browse..." button (plan items WS1-05 / WS1-07).
 *
 * A web page can never learn the real path of a folder it picks, so the local service opens a real folder
 * window on this computer and hands back only the chosen path text. This hook starts that window, polls for
 * the outcome (the poll is also the service's proof that this page is still here), and turns each outcome
 * into one visible, announced message plus a deliberate focus move. It only ever produces path TEXT for the
 * person to review: adding the folder is still the separate "Add this project" step, which the service
 * validates again. A window reported as open is one the service has confirmed is on the desktop.
 */

/** The service waits for the window to report in (up to `handshakeMs`) before it answers a start. */
const START_TIMEOUT_MS = FOLDER_PICK_LIMITS.handshakeMs + 5_000;
/** Every other call is short: a poll that hangs must not outlast the service's idle limit. */
const CALL_TIMEOUT_MS = 5_000;
/** Failed polls in a row that are ignored silently before the person is told contact was lost. */
const QUIET_POLL_FAILURES = 2;
/** A start slower than this (a slow first PowerShell start) gets a visible "opening" line and a Cancel button. */
const OPENING_TEXT_MS = 1_000;

type Phase = 'idle' | 'starting' | 'waiting';
export type FocusTarget = 'field' | 'browse';
export type FolderBrowseMessage = { id: number; tone: 'info' | 'problem'; text: string };
interface LivePick { id: string; prefix: string }

export interface FolderBrowseFields {
  field: RefObject<HTMLInputElement | null>;
  browse: RefObject<HTMLButtonElement | null>;
}

/** The response is JSON from a local service, but it crosses a boundary: check the parts this page relies on. */
function readPick(value: unknown): FolderPick | null {
  if (!value || typeof value !== 'object') return null;
  const pick = value as Partial<FolderPick>;
  if (typeof pick.id !== 'string' || !(folderPickStates as readonly unknown[]).includes(pick.state)) return null;
  return pick as FolderPick;
}

/** `request` throws an error carrying the HTTP status when the service answered; a network failure or timeout has none. */
function httpStatus(cause: unknown): number | null {
  const status = cause instanceof Error ? (cause as Error & { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : null;
}
/** A definite refusal (the pick is gone, the session ended) will not improve by asking again. */
const definiteRefusal = (cause: unknown) => { const status = httpStatus(cause); return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429; };

export function useFolderBrowse({ prefix, request, onPath, fields }: {
  prefix: string;
  request: IdentityController['request'];
  /** Receives the chosen path so the caller can put it in its field. Never stored or logged here. */
  onPath: (path: string) => void;
  fields: FolderBrowseFields;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [showTypeHint, setShowTypeHint] = useState(false);
  const [showOpening, setShowOpening] = useState(false);
  const [message, setMessage] = useState<FolderBrowseMessage | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ target: FocusTarget; onlyIfLost: boolean; nonce: number } | null>(null);
  // Bumped whenever a pick ends or this hook unmounts, so a late response from an old pick is ignored.
  const generation = useRef(0);
  const live = useRef<LivePick | null>(null);
  const starting = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const openingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The cancel request for a window the person just closed, so a new start cannot reach the service before it.
  const pendingCancel = useRef<Promise<boolean> | null>(null);
  const unmounted = useRef(false);
  const inFlight = useRef<AbortController | null>(null);
  const counter = useRef(0);
  const latest = useRef({ prefix, request, onPath, fields });
  latest.current = { prefix, request, onPath, fields };

  const say = useCallback((tone: FolderBrowseMessage['tone'], text: string) => setMessage({ id: ++counter.current, tone, text }), []);
  const requestFocus = useCallback((target: FocusTarget, onlyIfLost = false) => setFocusRequest({ target, onlyIfLost, nonce: ++counter.current }), []);

  const stopWork = useCallback(() => {
    clearTimeout(pollTimer.current); clearTimeout(hintTimer.current); clearTimeout(openingTimer.current);
    inFlight.current?.abort(); inFlight.current = null;
  }, []);

  /** Ask the service to close a window; resolves to whether the service answered. Best effort by design: if it
   * did not arrive, the service closes the window itself once this page stops polling
   * (FOLDER_PICK_LIMITS.idleKillMs), so nothing is left open. */
  const cancelRemote = useCallback((pick: LivePick): Promise<boolean> =>
    latest.current.request(`${pick.prefix}/folders/pick/${encodeURIComponent(pick.id)}/cancel`, {}, AbortSignal.timeout(CALL_TIMEOUT_MS)).then(() => true, () => false), []);

  /** End the current pick (or start attempt) with one message and, usually, a focus move. */
  const settle = useCallback((outcome: { tone: FolderBrowseMessage['tone']; text: string; focus?: FocusTarget; onlyIfLost?: boolean }) => {
    generation.current++;
    stopWork();
    live.current = null; starting.current = false;
    setPhase('idle'); setShowTypeHint(false); setShowOpening(false);
    say(outcome.tone, outcome.text);
    if (outcome.focus) requestFocus(outcome.focus, outcome.onlyIfLost ?? false);
  }, [say, requestFocus, stopWork]);

  const schedulePoll = useCallback((gen: number, pick: LivePick, failures: number, apply: (next: FolderPick, gen: number) => void) => {
    pollTimer.current = setTimeout(async () => {
      if (gen !== generation.current) return;
      const controller = new AbortController();
      inFlight.current = controller;
      try {
        const raw = await latest.current.request<unknown>(`${pick.prefix}/folders/pick/${encodeURIComponent(pick.id)}`, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]), 'GET');
        if (gen !== generation.current) return;
        const next = readPick(raw);
        if (!next || next.id !== pick.id) throw new Error('Unexpected folder window response.');
        apply(next, gen);
        if (gen === generation.current) schedulePoll(gen, pick, 0, apply);
      } catch (cause) {
        if (gen !== generation.current) return;
        if (definiteRefusal(cause) || failures >= QUIET_POLL_FAILURES) {
          // The window may still be open; ask for it to be closed, then tell the person plainly.
          void cancelRemote(pick);
          settle({ tone: 'problem', text: folderWindowText.lostContact, focus: 'browse', onlyIfLost: true });
          return;
        }
        schedulePoll(gen, pick, failures + 1, apply);
      }
    }, FOLDER_PICK_LIMITS.pollMs);
  }, [cancelRemote, settle]);

  /** Act on a status reported by the service. Returns nothing; every outcome settles or keeps waiting. */
  const apply = useCallback((pick: FolderPick, gen: number) => {
    if (gen !== generation.current) return;
    switch (pick.state) {
      case 'waiting': return;
      case 'selected':
        if (typeof pick.path === 'string' && pick.path.length > 0) {
          latest.current.onPath(pick.path);
          // The field, not Add: a screen reader reads the path there, and Enter still adds it.
          settle({ tone: 'info', text: folderWindowText.chosen, focus: 'field' });
        } else settle({ tone: 'problem', text: folderPickUnavailableText('helper-failed'), focus: 'field' });
        return;
      case 'cancelled': settle({ tone: 'info', text: folderWindowText.closed, focus: 'browse' }); return;
      case 'timed-out': settle({ tone: 'problem', text: folderWindowText.timedOut, focus: 'field' }); return;
      case 'unavailable': settle({ tone: 'problem', text: folderPickUnavailableText(pick.reason), focus: 'field' }); return;
    }
  }, [settle]);

  const browse = useCallback(() => {
    if (starting.current) return; // The window is still opening; the button already shows it is busy.
    if (live.current) { say('info', folderWindowText.alreadyOpen); return; }
    starting.current = true;
    const gen = ++generation.current;
    setMessage(null); setPhase('starting'); setShowOpening(false);
    openingTimer.current = setTimeout(() => { if (gen === generation.current) setShowOpening(true); }, OPENING_TEXT_MS);
    void (async () => {
      try {
        // A window the person just closed may not have heard yet: wait, so this start cannot reach the service first.
        if (pendingCancel.current) await pendingCancel.current;
        if (gen !== generation.current) return;
        const raw = await latest.current.request<unknown>(`${latest.current.prefix}/folders/pick`, {}, AbortSignal.timeout(START_TIMEOUT_MS));
        const pick = readPick(raw);
        if (gen !== generation.current) {
          // The person left before the service answered. Close a window this click opened.
          if (pick?.state === 'waiting' && !pick.alreadyOpen) void cancelRemote({ id: pick.id, prefix: latest.current.prefix });
          return;
        }
        if (!pick) throw new Error('Unexpected folder window response.');
        if (pick.state !== 'waiting') { apply(pick, gen); return; }
        const adopted: LivePick = { id: pick.id, prefix: latest.current.prefix };
        live.current = adopted; starting.current = false;
        clearTimeout(openingTimer.current);
        setPhase('waiting'); setShowTypeHint(false); setShowOpening(false);
        // Another click (or another tab) already has a window open: no second one was made. Keep waiting on it.
        if (pick.alreadyOpen) say('info', folderWindowText.alreadyOpen);
        hintTimer.current = setTimeout(() => { if (gen === generation.current) setShowTypeHint(true); }, FOLDER_PICK_LIMITS.typePathHintMs);
        schedulePoll(gen, adopted, 0, apply);
      } catch (cause) {
        if (gen !== generation.current) return;
        starting.current = false; clearTimeout(openingTimer.current); setPhase('idle'); setShowOpening(false);
        // The service's own sentence is written for people. Anything without a status (network, timeout,
        // a page that could not be read) has no such sentence, so say what happened in plain words.
        say('problem', httpStatus(cause) !== null && cause instanceof Error ? cause.message : folderWindowText.lostContact);
      }
    })();
  }, [say, apply, schedulePoll, cancelRemote]);

  /** Close the window the person no longer wants (or stop waiting for one still opening). `target` is where they continue. */
  const close = useCallback((target: FocusTarget) => {
    const pick = live.current;
    if (pick) {
      const sent = cancelRemote(pick);
      pendingCancel.current = sent;
      void sent.then(delivered => {
        if (pendingCancel.current === sent) pendingCancel.current = null;
        // "Closed" was said at once. If the service never heard, say the window will still go by itself, unless
        // the person has already moved on to something else.
        if (!delivered && !unmounted.current && !starting.current && !live.current) say('info', folderWindowText.closeUnconfirmed);
      });
    } else if (!starting.current) return;
    // A window that opens after this point is closed by browse()'s check of the generation.
    settle({ tone: 'info', text: folderWindowText.closed, focus: target });
  }, [cancelRemote, settle, say]);
  const cancel = useCallback(() => close('browse'), [close]);
  const typeInstead = useCallback(() => close('field'), [close]);
  const clearMessage = useCallback(() => setMessage(null), []);

  /** End the wait without a word or a focus move: the person carried on (for example by adding the typed path). */
  const stop = useCallback(() => {
    if (live.current) void cancelRemote(live.current);
    generation.current++; stopWork();
    live.current = null; starting.current = false;
    setPhase('idle'); setShowTypeHint(false); setShowOpening(false);
  }, [cancelRemote, stopWork]);

  /** Escape closes a pending folder window first, and only then reaches the drawer that would close. */
  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key !== 'Escape' || (!live.current && !starting.current)) return;
    event.preventDefault(); event.stopPropagation();
    close('browse');
  }, [close]);

  // Focus moves after the render that enabled its target.
  useEffect(() => {
    if (!focusRequest) return;
    // Focus that fell to the page (its button was removed) is put back; focus the person chose is left alone.
    if (focusRequest.onlyIfLost && document.activeElement && document.activeElement !== document.body) return;
    const { fields: refs } = latest.current;
    const targets = { field: [refs.field], browse: [refs.browse, refs.field] }[focusRequest.target];
    for (const ref of targets) {
      const element = ref.current;
      if (element && !element.disabled) { element.focus(); return; }
    }
  }, [focusRequest]);

  // Leaving the panel, the workspace or the page must not leave a window open on the desktop.
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      generation.current++;
      stopWork();
      if (live.current) void cancelRemote(live.current);
      live.current = null; starting.current = false;
    };
  }, [stopWork, cancelRemote]);

  return {
    active: phase !== 'idle', waiting: phase === 'waiting', opening: phase === 'starting' && showOpening, showTypeHint, message,
    browse, cancel, typeInstead, stop, clearMessage, onKeyDown,
  };
}
