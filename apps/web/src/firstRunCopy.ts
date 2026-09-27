/**
 * Every first-run, empty-town and returning-visitor string in one place, so each sentence can be
 * checked against something actually built today instead of the product's longer-term vision.
 *
 * Rules for anything added here (WS1-04):
 *  - Never promise a capability this build doesn't have yet: no "context", "skill", "analyse"/
 *    "analyze", "instruction quality", or "all tools work" claims. tests/unit/first-run-copy.test.ts
 *    fails on these words appearing in any exported string.
 *  - Never use the word "upload" — Agent Town does not upload project files or activity anywhere.
 *  - Never say data "never" leaves this computer, or that nothing is sent to any AI provider, without
 *    saying exactly what and when: report text on Process (or every 30 seconds if automatic mode is
 *    on), and a managed task's files and output once you approve that task. See PRIVACY_COPY (UX-02;
 *    decisions D42/D43 changed what is true here, so this sentence is a gate, not a one-time fix).
 *  - State the true default: GitHub sign-in identifies the owner; the GitHub repository list and the
 *    manager's paid work are both off until the person turns them on.
 *
 * docs/14-first-run-walkthrough.md carries the claim-to-evidence mapping for the sentences below.
 *
 * FD-07: this module is also registered with tests/unit/copy-registry.test.ts (COPY_REGISTRATION at
 * the bottom), which scans every string here with the shared honesty phrases as well.
 */

/** Words a first-run/onboarding sentence must never contain, because this build has no matching
 * capability to point to. Kept as an explicit list (not inferred) so the reason a word is banned is
 * visible in the same place it is enforced. */
export const BANNED_FIRST_RUN_WORDS: readonly string[] = [
  'upload', 'context', 'skill', 'analyse', 'analyze', 'instruction quality', 'all tools work',
];

/** The exact privacy sentences for the sign-in / connections step. Every claim here must stay true of
 * the default state: GitHub sign-in only, the GitHub repository list off, and the manager and paid
 * work off, until the person turns each one on. UX-02: each sentence about data leaving this computer
 * names its own trigger and what is sent, instead of one blanket "sends nothing" claim that becomes
 * false the moment the manager or a managed task runs (SP-3, SH-1). */
export const PRIVACY_COPY =
  'GitHub is used to sign you in and, only if you turn on the GitHub repository list, every few minutes to read repository names. ' +
  'Report text reaches an AI provider only when you press Process, or automatically every 30 seconds if you turn that on. ' +
  'A managed task sends its files and output to an AI provider only once you approve that task. ' +
  'A task run through your own tool passes to that tool under your own sign-in; Agent Town does not send it to a provider. ' +
  'AI credits are used only if you turn on the manager and allow paid work, then either press Process or turn on automatic processing.';

/** UX-33: shown directly under the heading and before the code on every screen that displays a
 * one-time device sign-in code (GitHub in WorkspaceSetup.tsx, the frozen Codex subscription sign-in in
 * RunnerPanel.tsx while it exists). Anyone can start a device sign-in and read out the code it shows;
 * this sentence is the one-line defense against talking a person into typing someone else's code. It
 * must never claim the flow is safe or phishing-proof — only say when to enter the code. */
export const SIGN_IN_CODE_WARNING = 'Only enter this code if you started sign-in here just now. Never enter a code someone else sent you.';

/** UX-02: whether the manager sends nothing until you press Process, or spends automatically every 30
 * seconds, as one of three plain words. Reads `automatic` strictly (=== true), so a config saved before
 * that flag existed, or holding any other value, always reads as explicit-only, never automatic. Shared
 * by the Manager status line below (WorkflowPanel.tsx) and, later, the Watch review line (H0-06), so
 * both screens describe the same saved setting with the same three words instead of drifting apart. */
export function managerScheduleWord(config: { enabled: boolean; automatic?: boolean }): 'off' | 'explicit only' | 'automatic every 30 s' {
  if (!config.enabled) return 'off';
  return config.automatic === true ? 'automatic every 30 s' : 'explicit only';
}

/** The Manager status line at WorkflowPanel.tsx: what the saved manager setting actually does with
 * report text, in one sentence, built from managerScheduleWord so the two can never disagree. */
export function managerStatusLine(config: { enabled: boolean; automatic?: boolean }): string {
  const word = managerScheduleWord(config);
  if (word === 'off') return 'Off. No report text is sent to an AI provider.';
  if (word === 'automatic every 30 s') return 'automatic every 30 s, spends without another click: report text is sent to your manager’s AI provider every 30 seconds.';
  return 'explicit only: report text is sent to your manager’s AI provider only when you press Process saved reports.';
}

export const WELCOME_EYEBROW = 'YOUR WORK, YOUR TOWN';

export function welcomeHeading(hasUser: boolean, returning: boolean): string {
  if (hasUser) return 'A place for your projects.';
  return returning ? 'Welcome back to your workshop.' : 'Your private town starts here.';
}

export function welcomeBody(hasUser: boolean): string {
  return hasUser
    ? 'Create your first private workspace to connect projects.'
    : 'Agent Town watches the coding tools you approve, gives each project a house in town, and saves the final reports those tools send. It does not control your agents.';
}

export const WELCOME_PRIVACY_NOTE = 'Connecting starts no agents or paid work.';

export const GITHUB_NOT_CONFIGURED_STATUS = 'GitHub sign-in is not set up on this computer yet.';

export const EMPTY_TOWN_HEADING = 'Make room for your projects.';
export const EMPTY_TOWN_BODY = 'Connect a project to give it a place in town.';
export const EMPTY_TOWN_ACTION = 'Connect a project';

export const EMPTY_LIST_AGENTS = 'No observed agent sessions yet. Project discovery starts no agents.';
export const CONNECT_PROJECT_ACTION = 'Connect a project';

/** Set once the welcome screen has rendered for a signed-out visitor, so a later visit (from the same
 * browser, after service data still shows no session) can greet them as a returning visitor instead of
 * a first-time one. Purely a local, per-browser convenience flag — never read by the service and never
 * required for the app to work correctly if storage is unavailable. */
const RETURNING_VISITOR_KEY = 'agent-town-returning-visitor';

export function isReturningVisitor(): boolean {
  try { return localStorage.getItem(RETURNING_VISITOR_KEY) === 'true'; }
  catch { return false; }
}

export function markVisited(): void {
  try { localStorage.setItem(RETURNING_VISITOR_KEY, 'true'); }
  catch { /* Browser storage is optional; the visitor is simply greeted as first-time next time. */ }
}

/** How this module registers with tests/unit/copy-registry.test.ts (FD-07). Every `*Copy.ts` under
 * apps/web/src (a name ending in Copy.ts or Copy.tsx) must export a COPY_REGISTRATION shaped like this
 * one, or that test fails and names the file. It changes no wording and nothing reads it at run time.
 *  - bannedWords: this module's OWN banned words (case-insensitive substring match). The registry test
 *    also applies its shared honesty phrases to every module, so list only what is specific to the
 *    promises this screen must not make.
 *  - textFunctions: each exported function that returns UI text, mapped to a thunk yielding every
 *    string it can return, so sentences built by a function are scanned too.
 *  - nonTextFunctions: exported functions that return no UI text. An exported function that is in
 *    neither list fails the registry test, so a new text-producing export cannot go unscanned. */
export const COPY_REGISTRATION = {
  bannedWords: BANNED_FIRST_RUN_WORDS,
  textFunctions: {
    welcomeHeading: () => [true, false].flatMap(hasUser => [true, false].map(returning => welcomeHeading(hasUser, returning))),
    welcomeBody: () => [true, false].map(hasUser => welcomeBody(hasUser)),
    managerScheduleWord: () => [{ enabled: false }, { enabled: true, automatic: false }, { enabled: true, automatic: true }, { enabled: true }].map(config => managerScheduleWord(config)),
    managerStatusLine: () => [{ enabled: false }, { enabled: true, automatic: false }, { enabled: true, automatic: true }, { enabled: true }].map(config => managerStatusLine(config)),
  },
  nonTextFunctions: ['isReturningVisitor', 'markVisited'],
} as const;
