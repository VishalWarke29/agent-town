import { z } from 'zod';

/** The "Browse…" folder window (plan items WS1-05 / WS1-07). A web page can never learn the absolute path of a
 * folder it picks, so the local service opens a Windows folder window on the owner's desktop and hands only the
 * chosen path back. The path is text for the person to review; adding it still goes through the normal add-folder
 * routes, which re-validate it (canonicalizeRoot + assertSafeProjectRoot). One window at a time, service-wide. */
export const folderPickStates = ['waiting', 'selected', 'cancelled', 'unavailable', 'timed-out'] as const;
export type FolderPickState = typeof folderPickStates[number];

/** Why a window could not be used. Each needs its own plain sentence in the web reason-text module. */
export const folderPickUnavailableReasons = ['unsupported-platform', 'no-desktop', 'helper-failed'] as const;
export type FolderPickUnavailableReason = typeof folderPickUnavailableReasons[number];

export interface FolderPick {
  id: string;
  state: FolderPickState;
  startedAt: string;
  /** When the helper's own time limit ends the window (ISO). Only meaningful while `waiting`. */
  expiresAt: string;
  /** Present only when `state` is `selected`. Never logged. */
  path?: string;
  /** Present only when `state` is `unavailable`. */
  reason?: FolderPickUnavailableReason;
  /** Present only on the start response: a window from an earlier click was still open, so none was added. */
  alreadyOpen?: boolean;
}

/** One number per rule so the service, the helper and the page agree. */
export const FOLDER_PICK_LIMITS = {
  /** The helper must report its window is up within this long, or the desktop is treated as unavailable. */
  handshakeMs: 8_000,
  /** The helper's own limit for how long a window may stay open. */
  windowMs: 5 * 60_000,
  /** No status poll for this long (tab closed, page gone) ends the helper and its window. */
  idleKillMs: 30_000,
  /** How often the page asks for status. */
  pollMs: 1_000,
  /** After this long the page offers "Can't see it? Type a path". */
  typePathHintMs: 10_000,
  /** The add routes accept at most 1,024 characters (`addRootSchema`), so a longer path could never be added. */
  pathMaxLength: 1_024,
} as const;

export const folderPickIdSchema = z.string().uuid();

/** The single JSON lines the helper may print. Parsed strictly; anything else is a failed helper. */
export const folderPickHelperLineSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open') }).strict(),
  z.object({ state: z.literal('selected'), path: z.string().min(1).max(FOLDER_PICK_LIMITS.pathMaxLength) }).strict(),
  z.object({ state: z.literal('cancelled') }).strict(),
]);
export type FolderPickHelperLine = z.infer<typeof folderPickHelperLineSchema>;
