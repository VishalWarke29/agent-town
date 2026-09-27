import { describe, expect, it } from 'vitest';
import { FOLDER_PICK_LIMITS, folderPickStates, folderPickUnavailableReasons } from '@agent-town/contracts';
import { folderPickUnavailableText, folderPickUnknownReasonText, folderWindowText, knownFolderPickReasons, reasonText } from '../../apps/web/src/reasonText';

const GENERIC_FALLBACK = 'Some metadata could not be verified. Review the selected scope and retry.';

/** Every reason code the current codebase can emit into a reason/reasons field the UI shows through
 * reasonText(): GitHub listing reasons, discovery coverage issues (DiscoveryIssue), repository
 * freshness reasons, and Git availability reasons. Kept here (not imported from the service) so this
 * test independently proves each code the UI can actually receive has real, readable text — the same
 * guarantee tests/unit/discovery.test.ts protects from the service side by construction. */
const knownReasonCodes = [
  'no-installations', 'no-repositories', 'suspended-installation', 'installation-limit', 'page-limit', 'listing-limit',
  'deadline', 'candidate-limit', 'github_unauthorized', 'github_not_connected', 'github_access_limited',
  'github_permissions_too_broad', 'github_listing_timeout', 'github_listing_cancelled', 'github_unavailable',
  'github_response_invalid', 'github-repository-unavailable', 'repository-unavailable', 'project-folder-unavailable',
  'git-metadata-not-scanned', 'not-a-git-repository', 'entry-limit', 'depth-limit', 'repository-limit',
  'instruction-limit', 'time-limit', 'unreadable-entry', 'unsafe-path', 'git-unavailable', 'git-output-limit',
  'git-timeout', 'unsafe-git-config', 'unsupported-git-layout', 'external-git-directory', 'cancelled',
  'scan-failed', 'scan-interrupted',
];

describe('reasonText', () => {
  it('has plain-English text for every known reason or error code', () => {
    for (const code of knownReasonCodes) {
      const text = reasonText(code);
      expect(text, `"${code}" has no specific readable text`).not.toBe(GENERIC_FALLBACK);
      expect(text.length, `"${code}" text is implausibly short`).toBeGreaterThan(10);
      expect(text).not.toBe(code);
    }
  });

  it('falls back to a generic sentence for an unrecognised code, never the raw code itself', () => {
    const text = reasonText('totally-unrecognised-future-code');
    expect(text).toBe(GENERIC_FALLBACK);
    expect(text).not.toContain('totally-unrecognised-future-code');
  });

  it('never resolves a code to something inherited from Object.prototype', () => {
    for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(reasonText(code)).toBe(GENERIC_FALLBACK);
  });
});

/** Words that describe how the window is opened or how Agent Town works inside. The person only ever needs to
 * know a window opened on their computer, so none of these may reach the screen. */
const jargon = /helper|spool|hook|producer|attribution|discovery|device flow|powershell/i;

describe('folder window text (Browse...)', () => {
  it('has its own readable sentence for every reason the contract can report', () => {
    // Fails the moment a reason is added to folderPickUnavailableReasons without text in reasonText.ts.
    for (const reason of folderPickUnavailableReasons) {
      expect(knownFolderPickReasons, `"${reason}" has no entry in the folder window text`).toContain(reason);
      const text = folderPickUnavailableText(reason);
      expect(text, `"${reason}" falls back to the unknown-reason sentence`).not.toBe(folderPickUnknownReasonText);
      expect(text, `"${reason}" text is implausibly short`).toMatch(/^[A-Z].{20,}\.$/);
      expect(text, `"${reason}" shows the raw code`).not.toContain(reason);
    }
    // No stale entries either: every sentence maps back to a real reason.
    expect([...knownFolderPickReasons].sort()).toEqual([...folderPickUnavailableReasons].sort());
  });

  it('gives each reason a distinct sentence that points to typing the path', () => {
    const texts = folderPickUnavailableReasons.map(folderPickUnavailableText);
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text).toMatch(/Type or paste the folder path instead\.$/);
  });

  it('uses the agreed sentence for each known reason', () => {
    expect(folderPickUnavailableText('unsupported-platform')).toBe('Folder windows are only available on Windows. Type or paste the folder path instead.');
    expect(folderPickUnavailableText('no-desktop')).toBe("Agent Town could not open a window on this computer's desktop. Type or paste the folder path instead.");
    expect(folderPickUnavailableText('helper-failed')).toBe('The folder window could not open. Type or paste the folder path instead.');
  });

  it('shows a plain sentence, never a raw code, for a reason this page does not know', () => {
    for (const reason of ['some-future-reason', 'constructor', '__proto__', '', undefined, null, 7, { reason: 'x' }]) {
      const text = folderPickUnavailableText(reason);
      expect(text).toBe(folderPickUnknownReasonText);
      if (typeof reason === 'string' && reason) expect(text).not.toContain(reason);
    }
    expect(folderPickUnknownReasonText).toMatch(/Type or paste the folder path instead\.$/);
  });

  it('keeps every folder window sentence free of internal jargon', () => {
    const everything = [...Object.values(folderWindowText), ...folderPickUnavailableReasons.map(folderPickUnavailableText), folderPickUnknownReasonText];
    for (const text of everything) {
      expect(text.length).toBeGreaterThan(0);
      expect(text, `"${text}" contains jargon`).not.toMatch(jargon);
      for (const code of [...folderPickStates, ...folderPickUnavailableReasons]) expect(text, `"${text}" contains the raw code "${code}"`).not.toContain(code);
    }
  });

  it('states the exact agreed wording and the real time limit', () => {
    expect(folderWindowText.browse).toBe('Browse...');
    expect(folderWindowText.hint).toBe('Opens a folder window on this computer. You can also type or paste a path.');
    expect(folderWindowText.waiting).toBe('A folder window opened on your computer. It may be behind this window. Press Alt+Tab if you cannot see it.');
    expect(folderWindowText.typeInstead).toBe("Can't see it? Type a path");
    expect(folderWindowText.alreadyOpen).toBe('A folder window is already open on your computer.');
    expect(folderWindowText.chosen).toBe('Folder chosen. Check the path, then choose Add this project.');
    expect(folderWindowText.closed).toBe('Folder window closed. Nothing was added.');
    expect(folderWindowText.lostContact).toBe('Lost contact with the local service. Try Browse... again or type the path.');
    expect(folderWindowText.opening).toBe('Opening the folder window…');
    expect(folderWindowText.typeHint).toBe('Still no window? You can close it and type the path instead.');
    // The wait for an unconfirmed Cancel follows the service's own idle limit, not a number copied by hand.
    expect(FOLDER_PICK_LIMITS.idleKillMs).toBe(30_000);
    expect(folderWindowText.closeUnconfirmed).toBe('The folder window did not confirm it closed. It will close by itself within about 30 seconds. Nothing was added.');
    // The sentence must follow the shared limit, not a number copied by hand.
    expect(FOLDER_PICK_LIMITS.windowMs).toBe(5 * 60_000);
    expect(folderWindowText.timedOut).toBe('The folder window was open for 5 minutes and was closed. Choose Browse... to try again, or type the path.');
  });
});
