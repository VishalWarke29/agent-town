/**
 * SK-01: plain wording for the skill-file group on the instruction-files screen
 * (InstructionFiles.tsx, rendered from App.tsx's RepositoryDetails for both the 3D world drawer and the
 * List view — the same component, so both show the same words with no extra work here).
 *
 * A plain module (no React), so a unit test can import it directly without rendering anything, and so
 * SK-14 and CH-20 can extend it later with more skills wording.
 *
 * The old copy claimed the rows were "managed in Skills section" — no such section exists (audit
 * finding, D44). This module replaces it with an honest sentence: skill files are listed (path, size,
 * date) and never read, run or managed by this build; a Skills section is planned, not built.
 *
 * FD-07: this module is also registered with tests/unit/copy-registry.test.ts (COPY_REGISTRATION
 * below), which scans every exported string here with the shared honesty phrases too.
 */

export const SKILLS_GROUP_HEADING = 'Skill files';

export const SKILLS_GROUP_NOTE = 'Skill files found in this folder. Listed by path, size and date only; Agent Town does not read, run or manage them. A Skills section is planned.';

/** This module's own banned words (case-insensitive substring match): the old, false claim that a
 * Skills section already exists to manage these files from. Not shared with other modules — see the
 * header of tests/unit/copy-registry.test.ts. */
const BANNED_SKILLS_WORDS: readonly string[] = ['managed in skills section'];

export const COPY_REGISTRATION = {
  bannedWords: BANNED_SKILLS_WORDS,
  textFunctions: {},
  nonTextFunctions: [],
} as const;
