import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as firstRunCopy from '../../apps/web/src/firstRunCopy';
import { BANNED_FIRST_RUN_WORDS, GITHUB_NOT_CONFIGURED_STATUS, PRIVACY_COPY, SIGN_IN_CODE_WARNING, WELCOME_PRIVACY_NOTE, managerScheduleWord, managerStatusLine, welcomeBody, welcomeHeading } from '../../apps/web/src/firstRunCopy';

/** Every combination of the manager config shape the pure helpers below read (UX-02). */
const MANAGER_CONFIGS = [{ enabled: false }, { enabled: false, automatic: true }, { enabled: true }, { enabled: true, automatic: false }, { enabled: true, automatic: true }] as const;

/** UX-02: the unqualified "sends no ... to any AI provider" claim removed from PRIVACY_COPY (SP-3,
 * SH-1). "sends"/"send" and "no" must be adjacent (that is the actual claim being banned), but nothing
 * between "no" and "any AI provider" is required to be literally "to": the removed sentence itself put
 * "to GitHub or" in between. "[^.]*" keeps the match inside one sentence so it cannot span two unrelated
 * ones in a multi-sentence export. */
const UNQUALIFIED_AI_PROVIDER_CLAIM = /\bsends?\s+no\b[^.]*\bany\s+AI\s+provider\b/i;

/** Every plain string this module exports, plus every string its text-producing functions can return,
 * gathered generically so a new export is checked automatically rather than only when someone
 * remembers to add it to a hand-written list. */
function allCopyStrings(): string[] {
  const strings: string[] = [];
  for (const [key, value] of Object.entries(firstRunCopy)) {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value) && key !== 'BANNED_FIRST_RUN_WORDS') for (const item of value) if (typeof item === 'string') strings.push(item);
  }
  // Function exports take booleans; exercise every combination.
  for (const hasUser of [true, false]) for (const returning of [true, false]) strings.push(welcomeHeading(hasUser, returning));
  for (const hasUser of [true, false]) strings.push(welcomeBody(hasUser));
  for (const config of MANAGER_CONFIGS) { strings.push(managerScheduleWord(config)); strings.push(managerStatusLine(config)); }
  return strings;
}

describe('first-run copy', () => {
  it('never makes a promise this build cannot back up', () => {
    for (const text of allCopyStrings()) {
      const lower = text.toLowerCase();
      for (const banned of BANNED_FIRST_RUN_WORDS) {
        expect(lower, `"${banned}" appears in first-run copy: "${text}"`).not.toContain(banned.toLowerCase());
      }
    }
  });

  it('never says "Your work stays local" (removed: it is not the whole truth)', () => {
    for (const text of allCopyStrings()) expect(text).not.toContain('Your work stays local');
  });

  // H0-29 (D40, follow-up to done WS5-02): two leftover phrases described the pre-D38 model, where a
  // tracking helper was needed to connect any tool at all. TL-05's glossary makes Watch sessions an
  // explicit, separate opt-in, so neither phrase is true any more. This scans the copy modules above
  // (firstRunCopy.ts) plus every other place the phrases were found: InstructionFiles.tsx's hook-file
  // label and Skills group, the two setup panels' wording, and scripts/doctor.mjs's own message.
  it('never says "live tracking" or "before connecting a tool" (H0-29): the leftover pre-D38 wording', () => {
    for (const text of allCopyStrings()) {
      expect(text.toLowerCase(), text).not.toContain('live tracking');
      expect(text.toLowerCase(), text).not.toContain('before connecting a tool');
    }
    const project = resolve(__dirname, '../..');
    const files = [
      'apps/web/src/InstructionFiles.tsx',
      'apps/web/src/NativeTrackingPanel.tsx',
      'apps/web/src/ObservationPanel.tsx',
      'scripts/doctor.mjs',
      // H0-05: RepositoriesPanel.tsx (the last remaining occurrence H0-29's evidence handed off, "set up
      // live tracking" in its post-connect notice) and RepositoryAgents.tsx (the other file this item
      // owns) close the gap H0-29 could not, since both were outside that item's owned files.
      'apps/web/src/RepositoriesPanel.tsx',
      'apps/web/src/RepositoryAgents.tsx',
    ];
    for (const file of files) {
      const source = readFileSync(resolve(project, file), 'utf8').toLowerCase();
      expect(source, file).not.toContain('live tracking');
      expect(source, file).not.toContain('before connecting a tool');
    }
  });

  // TL-01 (D40, D42): a folder is never "installed" (only checked), and Agent Town never "chooses who
  // pays" (each tool decides through its own sign-in; Agent Town's own accounts pay only for its own
  // manager and managed-task calls). This scans the raw source of every .tsx file under apps/web/src
  // (recursively, following the same listSourceFiles/sourceFiles convention as skills-copy.test.ts and
  // draft-store.test.ts, rather than a hand-picked list of the screens TL-01 happened to touch) for the
  // two literal regressions named in its acceptance criteria, plus the "Verified subscription account"
  // label TL-01 also retires. Scanning the whole tree, not just the five files this item edited, means a
  // stray reintroduction anywhere (App.tsx, WorkspaceSetup.tsx, a future screen under world/, ...) is also
  // caught, not only a regression in the files TL-01 itself changed (review finding TL-01#1). The
  // folder-only "Installed" pattern matches the removed status-label shape ("Installed — ...", "Installed
  // - ...") without flagging legitimate uses of the word: instructing the owner to install real software
  // ("Install one and choose Recheck tools"), or describing a hook file that Agent Town itself actually
  // wrote to disk ("Its hook may still be installed").
  it('never says a folder is "Installed" or that Agent Town "chooses who pays", anywhere under apps/web/src (TL-01: D40, D42)', () => {
    const FOLDER_ONLY_INSTALLED = /\bInstalled\s*[—-]/;
    const project = resolve(__dirname, '../..');
    const src = resolve(project, 'apps/web/src');
    function listSourceFiles(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) listSourceFiles(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
      }
      return out;
    }
    for (const file of listSourceFiles(src)) {
      const relativePath = file.slice(project.length + 1).replaceAll('\\', '/');
      const source = readFileSync(file, 'utf8');
      expect(source, relativePath).not.toContain('Choose who pays');
      expect(source, relativePath).not.toContain('Verified subscription account');
      expect(source, `${relativePath} (folder-only "Installed" label)`).not.toMatch(FOLDER_ONLY_INSTALLED);
    }

    // Regression fixtures: prove the pattern above actually catches the two removed status labels
    // (not merely vacuous), and that it leaves the legitimate "install" uses named above alone.
    expect('Installed — no activity for this project yet').toMatch(FOLDER_ONLY_INSTALLED);
    expect('Installed — GitHub Copilot CLI was not found on this machine.').toMatch(FOLDER_ONLY_INSTALLED);
    expect('Install one and choose Recheck tools, or use manual setup for other tools.').not.toMatch(FOLDER_ONLY_INSTALLED);
    expect('This connection was revoked. Its hook may still be installed: remove it in manual setup.').not.toMatch(FOLDER_ONLY_INSTALLED);
  });

  it('states the true default: GitHub sign-in and an opt-in repository list', () => {
    expect(PRIVACY_COPY).toContain('only if you turn on the GitHub repository list');
    expect(PRIVACY_COPY).not.toContain('upload');
  });

  // UX-02 (flips the pinned assertion recorded in docs/records/pinned-tests.md, citing SP-3 and SH-1): the old,
  // unqualified "Agent Town sends no project files or agent activity to GitHub or any AI provider" is false once
  // the manager processes a saved report or a managed task reads files, and it never mentioned automatic mode.
  // Every sentence about data leaving this computer now names its own trigger and what is sent.
  it('names the exact trigger and what is sent for every way data can leave this computer (UX-02: SP-3, SH-1)', () => {
    expect(PRIVACY_COPY).toContain('Report text reaches an AI provider only when you press Process, or automatically every 30 seconds if you turn that on.');
    expect(PRIVACY_COPY).toContain('A managed task sends its files and output to an AI provider only once you approve that task.');
    expect(PRIVACY_COPY).toContain('Agent Town does not send it to a provider.');
    expect(PRIVACY_COPY).toContain('AI credits are used only if you turn on the manager and allow paid work, then either press Process or turn on automatic processing.');
  });

  it('never makes the unqualified claim that nothing is sent to any AI provider (UX-02: the copy test rejects it)', () => {
    // "[^.]*" stops the match at the end of its own sentence, so an unrelated "sends no ..." in one
    // sentence of a multi-sentence export can never combine with an unrelated "any AI provider" later
    // in the string. It does NOT require "to" to sit directly before "any AI provider": the real removed
    // sentence below has other words ("GitHub or") between them, and a regex that demanded adjacency
    // would silently let that exact phrasing back in (see the regression fixture below).
    for (const text of allCopyStrings()) expect(text, text).not.toMatch(UNQUALIFIED_AI_PROVIDER_CLAIM);

    // Regression fixture (UX-02, flips docs/records/pinned-tests.md's row for this test, D42/D43): the
    // literal sentence removed from PRIVACY_COPY, not a simplified stand-in, because that exact wording
    // is what a careless future edit is most likely to reproduce. Assert it directly (rather than only
    // via allCopyStrings, since it is no longer part of the shipped copy) so the check above is proven
    // non-vacuous: this line fails if UNQUALIFIED_AI_PROVIDER_CLAIM stops catching this sentence.
    const REMOVED_UNQUALIFIED_SENTENCE = 'Agent Town sends no project files or agent activity to GitHub or any AI provider.';
    expect(REMOVED_UNQUALIFIED_SENTENCE).toMatch(UNQUALIFIED_AI_PROVIDER_CLAIM);
  });

  it('has a plain-English GitHub-not-configured status sentence', () => {
    expect(GITHUB_NOT_CONFIGURED_STATUS.length).toBeGreaterThan(10);
  });

  it('keeps a short, honest privacy note for the welcome card', () => {
    expect(WELCOME_PRIVACY_NOTE).toContain('no agents or paid work');
  });

  // UX-33: the sign-in code warning is one constant so the copy test (and FD-07's registry) cover it; a change
  // that removes or weakens it must fail here.
  it('warns, once, to enter a sign-in code only if you started sign-in here just now, and never claims the flow is safe', () => {
    expect(SIGN_IN_CODE_WARNING).toBe('Only enter this code if you started sign-in here just now. Never enter a code someone else sent you.');
    expect(SIGN_IN_CODE_WARNING.toLowerCase()).not.toContain('safe');
    expect(SIGN_IN_CODE_WARNING.toLowerCase()).not.toContain('phishing-proof');
  });

  it('is registered with the copy registry (FD-07) using the very banned list enforced above, and its registered text functions cover every function-built sentence checked above', () => {
    const { bannedWords, textFunctions } = firstRunCopy.COPY_REGISTRATION;
    expect(bannedWords).toBe(BANNED_FIRST_RUN_WORDS);
    const registered = Object.values(textFunctions).flatMap(produce => produce());
    for (const hasUser of [true, false]) for (const returning of [true, false]) expect(registered).toContain(welcomeHeading(hasUser, returning));
    for (const hasUser of [true, false]) expect(registered).toContain(welcomeBody(hasUser));
    for (const config of MANAGER_CONFIGS) { expect(registered).toContain(managerScheduleWord(config)); expect(registered).toContain(managerStatusLine(config)); }
  });
});

// UX-02: the pure helper the Manager status line (WorkflowPanel.tsx) uses, shared later by the Watch review line
// (H0-06), so both screens describe the same saved setting with the same words instead of drifting apart.
describe('manager schedule status (UX-02): a pure helper read straight from the saved config', () => {
  it('reads off, explicit only, or automatic every 30 s, straight from enabled and automatic', () => {
    expect(managerScheduleWord({ enabled: false })).toBe('off');
    expect(managerScheduleWord({ enabled: false, automatic: true })).toBe('off');
    expect(managerScheduleWord({ enabled: true })).toBe('explicit only');
    expect(managerScheduleWord({ enabled: true, automatic: false })).toBe('explicit only');
    expect(managerScheduleWord({ enabled: true, automatic: undefined })).toBe('explicit only');
    // A config saved before "automatic" existed, or holding any other truthy value, must still read as
    // explicit-only: only a strict === true counts (legacyImplicitExplicit in WorkflowPanel.tsx relies on this).
    expect(managerScheduleWord({ enabled: true, automatic: 1 as unknown as boolean })).toBe('explicit only');
    expect(managerScheduleWord({ enabled: true, automatic: true })).toBe('automatic every 30 s');
  });

  it('the Manager status line carries both literal phrases the acceptance criteria name, for both "on" variants', () => {
    expect(managerStatusLine({ enabled: true, automatic: false })).toContain('explicit only');
    expect(managerStatusLine({ enabled: true, automatic: true })).toContain('automatic every 30 s, spends without another click');
    expect(managerStatusLine({ enabled: false })).not.toContain('explicit only');
    expect(managerStatusLine({ enabled: false })).not.toContain('automatic every 30 s');
  });
});
