/**
 * Every new sentence the houses-first screens need, in one place, so it can be checked against what
 * this build actually reads and against the owner's own words (D38-D41, TL-05's glossary) instead of
 * the product's longer-term vision (H0-05).
 *
 * Source of the wording: docs/records/ui/DES-02-houses-first-v1.md, **Status: proposed** — the owner
 * has not reviewed it yet. If the owner's review changes a sentence, this file changes with it; nothing
 * here is final. The per-tool "what the check reads" sentences are pinned against the real request
 * handling in apps/service/src/native-discovery/metadata-worker.mjs (lines ~144-211 as of 2026-09-25);
 * re-check them whenever that file's Codex/Claude/Cursor/Copilot CLI branches change (see the risk note
 * in docs/plan-v5/H0-houses-first.md's H0-05 entry: a tool's SDK can start reading something new).
 *
 * This module writes the words only. H0-07 (the inspector), H0-08 (the quiet Watch link), H0-14 (the
 * Watching line and Stop watching) and H0-15 (hidden sessions) are what put these sentences on screen;
 * until then most of the exports below are unused by any component, which is expected for a copy file
 * written ahead of the screen it serves.
 *
 * Rules for anything added here (mirrors firstRunCopy.ts's header, TL-05, docs/records/README.md):
 *  - Never say "nothing was scanned" (folders and Git are still checked in the background): say
 *    "No sessions were scanned" and name the background check in the same sentence (D38).
 *  - Never say "sync", "syncing" or "synced". The owner's word is "watch" (D38; "I don't want the
 *    tasks to get synced"). tests/unit/house-copy.test.ts fails on these words appearing anywhere in
 *    this module's strings, or in the raw source of the screens this item rewrites.
 *  - Never say a connection is "installed" for a tool that was only found, or "Hook applied" for a
 *    connection that is only prepared and has not received anything yet (TL-01, D40).
 *  - Never imply Agent Town starts, runs or assigns a task (D41): a hand-off is text the owner copies
 *    into their own tool, never something Agent Town does for them.
 *  - Every first-run capability ban (BANNED_FIRST_RUN_WORDS: upload, context, skill, analyse, ...)
 *    applies here too — this build has no more of those capabilities on a house screen than it does on
 *    the first-run screen.
 *
 * FD-07: this module is registered with tests/unit/copy-registry.test.ts (COPY_REGISTRATION at the
 * bottom), which scans every string here with the shared honesty phrases as well as this module's own
 * banned words.
 */

import { type AutoDetectSurface, toolDisplayName } from '@agent-town/contracts';
import { BANNED_FIRST_RUN_WORDS } from './firstRunCopy';

/** This module's own banned words: every first-run capability ban (this build has no more of those
 * capabilities on a house screen than it does on first run) plus the owner's rejected tracking word in
 * every inflection. Kept as its own constant, not just used inline, so tests/unit/house-copy.test.ts
 * can assert on it directly (see docs/records/README.md's "Words not to use on screen"). */
export const HOUSE_BANNED_WORDS: readonly string[] = [...BANNED_FIRST_RUN_WORDS, 'sync', 'syncing', 'synced'];

/** DES-02 section 3, the status-line vocabulary. "Written once, in houseCopy.ts (H0-05), next to H0-05's
 * state words. No screen invents another phrase." These four are the per-tool words; a resident whose
 * tool was stopped reads the separate RESIDENT_STOPPED_LABEL below, not this table's "Stopped" alone. */
export const TOOL_STATE_WORDS = {
  receiving: 'Receiving',
  waitingForFirstActivity: 'Waiting for first activity',
  needsAttention: 'Needs attention',
  stopped: 'Stopped',
} as const;

/** DES-02 section 3: "Stopped | Per tool | The connection was stopped; residents read 'Stopped
 * watching'." The per-tool word stays "Stopped" (TOOL_STATE_WORDS.stopped); a resident row built from a
 * stopped connection reads this longer phrase instead. */
export const RESIDENT_STOPPED_LABEL = 'Stopped watching';

/** DES-02 WS-1, the "What the check reads" disclosure: one honest sentence per tool, read against
 * apps/service/src/native-discovery/metadata-worker.mjs. Codex opens `state_5.sqlite` with
 * `{ readonly: true }` (better-sqlite3 can still leave `-wal`/`-shm` files next to a WAL-mode database
 * even in read-only mode, so that is named rather than promising "no trace"). Claude Code goes through
 * `@anthropic-ai/claude-agent-sdk`'s `listSessions`, which reads its own saved session files. Cursor
 * goes through `@cursor/sdk`'s `JsonlLocalAgentStore`, which reads its own `agents.ndjson` agents file.
 * Copilot CLI has no such local store to read: metadata-worker.mjs starts a real `CopilotClient` runtime
 * (with model requests refused) to list sessions, so "read-only" would be false for it — it starts its
 * own runtime instead. */
export const TOOL_CHECK_SENTENCES: Readonly<Record<AutoDetectSurface, string>> = {
  codex: 'Codex opens its session database read-only (it may leave -wal and -shm files behind).',
  claude: "Claude Code's SDK reads saved session files.",
  cursor: "Cursor's SDK reads its agents file.",
  'copilot-cli': 'Copilot CLI starts its own runtime.',
};

/** DES-02 PA-1 / IN-1: the short line, honest about what has and has not happened before the first
 * background check ends. Never "nothing was scanned" (D38): folders and Git are still checked in the
 * background, so that would be false. */
export const NO_SESSIONS_SCANNED_LINE = 'No sessions were scanned and no agent has started.';

/** DES-02 IN-1: names the one background check that does run (folder and Git status), in one plain
 * sentence, so "No sessions were scanned" is not read as "nothing happens here". */
export const BACKGROUND_CHECK_SENTENCE = 'Agent Town checks this folder and its Git status in the background; the facts below fill in when the first check ends.';

/** DES-02 IN-1, slot 1's lede before any tool is watched: the two sentences above, combined once so a
 * screen cannot show one without the other. */
export const PROJECT_INSPECTOR_LEDE = `${NO_SESSIONS_SCANNED_LINE} ${BACKGROUND_CHECK_SENTENCE}`;

function joinToolNames(tools: readonly AutoDetectSurface[]): string {
  const names = tools.map(tool => toolDisplayName[tool]);
  if (names.length === 1) return names[0]!;
  return names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** DES-02 IN-3: "The lede is conditional. While no connection exists it stays as IN-1; it never says
 * 'only reads' or 'no agent has started' once a connection exists." Called only once at least one tool
 * is watched for this project; an empty list is a caller error, not a state this lede can describe. */
export function watchingLede(tools: readonly AutoDetectSurface[]): string {
  if (tools.length === 0) throw new Error('watchingLede needs at least one watched tool; use PROJECT_INSPECTOR_LEDE before any connection exists');
  return `Agent Town is watching sessions you start in this folder with ${joinToolNames(tools)}. It does not start, run or assign anything.`;
}

/** DES-02 section 2, the shared AssignSlot's single interim state until V3 (CH-11): "one plain line of
 * text ... and nothing else: no button, no link, no icon, no tooltip, no tabindex, no aria-disabled
 * control, no request." Exactly this string, once per inspector. */
export const ASSIGN_SLOT_INTERIM_LINE = 'Task hand-off: planned, not built yet';

/** DES-02 RS-1: the Residents slot's empty state. "Never 'No one lives here yet' followed by anything
 * about approved tasks (D41)" — that phrasing is EMPTY_HOUSE_LINE_1/2 below, for the room and the List,
 * not this one; the inspector's own Residents block keeps this longer wording. */
export const RESIDENTS_HEADING = 'Residents';
export const RESIDENTS_EMPTY_LINE_1 = 'No sessions are being watched. No sessions were scanned.';
export const RESIDENTS_EMPTY_LINE_2 = 'Only sessions you choose to watch appear here.';

/** DES-02 RH-2 (empty room) and LV-3 (empty Residents cell in the List view): the shorter phrasing for
 * those two places, "reused from RS-1" for its second line so the room, the List and the inspector all
 * say the same thing about who can appear here. Never followed by anything about approved or assigned
 * tasks (D41). */
export const EMPTY_HOUSE_LINE_1 = 'No one lives here yet.';
export const EMPTY_HOUSE_LINE_2 = RESIDENTS_EMPTY_LINE_2;

/** The notice shown in RepositoriesPanel.tsx after connecting a project that is not the workspace's
 * first (the first project opens its own inspector instead, via onConnected). Replaces the old "set up
 * live tracking" wording (H0-29's handoff note) with the owner's word, "watch" (D38, TL-05).
 *
 * Fixer note (H0-05 review finding #1, major): the first version of this line named a specific control,
 * "Watch sessions (optional)", that does not exist in the running app yet — H0-08 (not yet built) is what
 * relabels "Set up tracking" to that link. Naming it here was a second, narrower honesty problem of
 * exactly the kind this item exists to remove. "Repository details" is the fix: it is a real button
 * rendered today (apps/web/src/App.tsx's room-actions row) that opens the inspector, and DES-02's own
 * RH-1 keeps "Repository details" as the way to reach the Watch section once H0-08 ships, so this
 * sentence needs no further edit when that link lands. tests/unit/house-copy.test.ts checks both: the
 * exact string, and that "Repository details" is real rendered text somewhere under apps/web/src. */
export function connectedProjectNotice(repositoryName: string): string {
  return `${repositoryName} is connected and has a house in town. Open it and choose Repository details to set up watching this project.`;
}

/** How this module registers with tests/unit/copy-registry.test.ts (FD-07); see the header of that test
 * and the bottom of apps/web/src/firstRunCopy.ts for the full protocol. Changes no wording and nothing
 * reads it at run time. */
export const COPY_REGISTRATION = {
  bannedWords: HOUSE_BANNED_WORDS,
  textFunctions: {
    watchingLede: () => [watchingLede(['codex']), watchingLede(['claude', 'codex']), watchingLede(['claude', 'codex', 'cursor', 'copilot-cli'])],
    connectedProjectNotice: () => [connectedProjectNotice('payments-api')],
  },
  nonTextFunctions: [],
} as const;
