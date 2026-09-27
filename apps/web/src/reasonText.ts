/**
 * Plain-English text for internal reason and error codes shown anywhere in the UI.
 *
 * Every discovery coverage issue, GitHub listing reason, repository freshness reason, and Git
 * availability reason the local service can emit must have an entry here so no raw internal code
 * (for example `git-metadata-not-scanned`) ever reaches the screen. WS1-03 introduced this module;
 * WS2-05 consumes it for Repository details. Later work (WS3-08's producer-attribution codes, WS4 and
 * WS5's own reason codes) should extend this same table rather than create a second one — an unknown
 * code still falls back to a generic sentence, never the raw code, but it stays generic until it is
 * added below.
 *
 * tests/unit/reason-text.test.ts fails when a code this codebase is known to emit has no entry.
 */
import { FOLDER_PICK_LIMITS, type FolderPickUnavailableReason } from '@agent-town/contracts';

const explanations: Record<string, string> = {
  // GitHub repository listing
  'no-installations': 'No installation is available to this account. Install your configured GitHub App on the personal account or organization that owns the repositories, select repositories, then check again.',
  'no-repositories': 'The accessible installations returned no repositories. Review the App’s repository selection and your own access. Organization owners may need to approve installation or repository access.',
  'suspended-installation': 'An installation is suspended. Ask its account or organization owner to restore access, then check again.',
  'installation-limit': 'Only the first 100 installations were checked. This inventory is incomplete.',
  'page-limit': 'The GitHub page limit was reached. Some permitted repositories were not returned.',
  'listing-limit': 'The GitHub page limit was reached. Some permitted repositories were not returned.',
  'deadline': 'The shared 12-second limit was reached. The repositories already received are available below; retry to check missing results.',
  'candidate-limit': 'The 200-record review limit was reached. Selected repositories are preserved; some new results were not retained.',
  'github_unauthorized': 'GitHub authorization expired or was revoked. Open Connections and sign in again.',
  'github_not_connected': 'Connect GitHub in Connections, then check repository access again.',
  'github_access_limited': 'GitHub denied or rate-limited this check. Review App installation, organization approval and your account access, then retry later.',
  'github_permissions_too_broad': 'The configured GitHub App has write permissions. Change its repository permissions to read-only before discovery.',
  'github_listing_timeout': 'GitHub did not respond within the 12-second limit. Check the connection and retry.',
  'github_listing_cancelled': 'The GitHub check was cancelled. Retry when ready.',
  'github_unavailable': 'GitHub could not be reached. Previous records are stale; check your connection and retry.',
  'github_response_invalid': 'GitHub returned an unexpected response. Previous records are stale; retry later.',
  'github-repository-unavailable': 'Not returned by the latest complete GitHub check. It may have moved or access may have changed; saved history is preserved.',
  // Local discovery and repository freshness
  'repository-unavailable': 'Not found by the latest complete local scan. Check that the checkout still exists inside an allowed folder.',
  'project-folder-unavailable': 'This project folder could not be read. Check that it still exists at the saved path, then scan again.',
  'git-metadata-not-scanned': 'This folder has Git metadata that has not been verified. Scan selected folders to check it.',
  'not-a-git-repository': 'Git is not set up for this project folder. Connect it as a folder project without Git, or point discovery at an actual Git checkout.',
  'entry-limit': 'The entry limit was reached. Choose a smaller parent folder to check omitted paths.',
  'depth-limit': 'Some folders were too deeply nested. Add a closer parent folder to check them.',
  'repository-limit': 'The 100-repository scan limit was reached. Choose smaller parent folders.',
  'instruction-limit': 'Some instruction metadata exceeded the per-repository limit.',
  'time-limit': 'The scan time limit was reached. Choose a smaller parent folder and retry.',
  'unreadable-entry': 'Some selected paths could not be read. Check their existence and local permissions.',
  'unsafe-path': 'Links or unsafe paths were skipped. Select the actual checkout folder; discovery does not follow links.',
  'git-unavailable': 'Git metadata could not be verified. Check the Git installation and checkout access.',
  'git-output-limit': 'Git output exceeded the safe read limit; Git measurements are unavailable.',
  'git-timeout': 'Git did not respond in time; Git measurements are unavailable.',
  'unsafe-git-config': 'Git settings require unsupported or executable behavior. This checkout was not executed.',
  'unsupported-git-layout': 'The Git layout cannot be safely read by this scanner.',
  'external-git-directory': 'A worktree’s Git directory is outside the allowed folders. Add its actual parent folder only if you intend to allow it.',
  'cancelled': 'This scan was cancelled. Scan again to verify the saved inventory.',
  'scan-failed': 'The scan failed. Check folder access and retry.',
  'scan-interrupted': 'The service stopped during the scan. Scan again to verify saved inventory.',
};

/** Every code this module can currently translate. Exported so a test can assert coverage against
 * the codebase's own known-code lists without duplicating this table. */
export const knownReasonCodes: readonly string[] = Object.freeze(Object.keys(explanations));

export function reasonText(code: string): string {
  // Own keys only: a code such as "constructor" must never resolve to something on Object.prototype.
  return Object.hasOwn(explanations, code) ? explanations[code]! : 'Some metadata could not be verified. Review the selected scope and retry.';
}

/**
 * The "Browse..." folder window (WS1-07): every sentence the person can see for it.
 *
 * The local service opens a real Windows folder window on this computer and reports back only the chosen
 * path text, so most of these describe something happening on the desktop, outside the browser. Keep them
 * plain: never mention how the window is opened, and always leave the typed path as the way forward.
 */
const folderWindowMinutes = Math.max(1, Math.round(FOLDER_PICK_LIMITS.windowMs / 60_000));
const folderWindowIdleSeconds = Math.round(FOLDER_PICK_LIMITS.idleKillMs / 1_000);

export const folderWindowText = {
  browse: 'Browse...',
  hint: 'Opens a folder window on this computer. You can also type or paste a path.',
  opening: 'Opening the folder window…',
  waiting: 'A folder window opened on your computer. It may be behind this window. Press Alt+Tab if you cannot see it.',
  cancel: 'Cancel',
  typeInstead: "Can't see it? Type a path",
  typeHint: 'Still no window? You can close it and type the path instead.',
  alreadyOpen: 'A folder window is already open on your computer.',
  chosen: 'Folder chosen. Check the path, then choose Add this project.',
  closed: 'Folder window closed. Nothing was added.',
  closeUnconfirmed: `The folder window did not confirm it closed. It will close by itself within about ${folderWindowIdleSeconds} seconds. Nothing was added.`,
  lostContact: 'Lost contact with the local service. Try Browse... again or type the path.',
  timedOut: `The folder window was open for ${folderWindowMinutes} ${folderWindowMinutes === 1 ? 'minute' : 'minutes'} and was closed. Choose Browse... to try again, or type the path.`,
} as const;

/** One plain sentence per reason a folder window could not be used. Typed against the shared contract, so a
 * reason added there without text here fails type checking; tests/unit/reason-text.test.ts also checks it. */
const folderPickUnavailable: Record<FolderPickUnavailableReason, string> = {
  'unsupported-platform': 'Folder windows are only available on Windows. Type or paste the folder path instead.',
  'no-desktop': "Agent Town could not open a window on this computer's desktop. Type or paste the folder path instead.",
  'helper-failed': 'The folder window could not open. Type or paste the folder path instead.',
};

/** Shown for a reason this page does not know yet (a newer service). Deliberately different from every
 * known reason's text so a missing entry is detectable, and never the raw code. */
export const folderPickUnknownReasonText = 'The folder window could not be used. Type or paste the folder path instead.';

/** Every reason code with its own sentence. Exported so a test can compare it with the contract's list. */
export const knownFolderPickReasons: readonly string[] = Object.freeze(Object.keys(folderPickUnavailable));

export function folderPickUnavailableText(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(folderPickUnavailable, reason)
    ? folderPickUnavailable[reason as FolderPickUnavailableReason]
    : folderPickUnknownReasonText;
}
