import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COPY_REGISTRATION, SKILLS_GROUP_HEADING, SKILLS_GROUP_NOTE } from '../../apps/web/src/skillsCopy';

const SRC = resolve(__dirname, '../../apps/web/src');

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// SK-01: the instruction-files screen used to point at a Skills section that does not exist
// ("Skills (managed in Skills section)"). skillsCopy.ts replaces it with an honest sentence, kept in a
// plain (no-React) module so this test can check the words directly, without rendering anything.
describe('skills copy (SK-01)', () => {
  it('says skill files are listed by path, size and date only, and that a Skills section is planned, not built', () => {
    const lower = SKILLS_GROUP_NOTE.toLowerCase();
    expect(lower).toContain('path, size and date');
    expect(lower).toContain('does not read, run or manage');
    expect(lower).toContain('a skills section is planned');
  });

  it('never says the old, false "managed in Skills section" claim, in the heading or the note', () => {
    for (const text of [SKILLS_GROUP_HEADING, SKILLS_GROUP_NOTE]) expect(text.toLowerCase()).not.toContain('managed in skills section');
  });

  it('registers the old phrase as its own banned word with the FD-07 copy registry', () => {
    expect(COPY_REGISTRATION.bannedWords.map(word => word.toLowerCase())).toContain('managed in skills section');
  });

  // Scans real source text (not just this module's exports), so the old phrase is caught wherever it
  // was written, including InstructionFiles.tsx's aria-label and heading, which are not themselves
  // exported strings from a *Copy.ts module. This is the regression check: it fails on the tree as it
  // stood before SK-01 (InstructionFiles.tsx said "Skills (managed in Skills section)").
  it('the phrase "managed in Skills section" appears nowhere under apps/web/src, outside this module\'s own comments and banned-word list', () => {
    const hits = listSourceFiles(SRC)
      .filter(file => file !== resolve(SRC, 'skillsCopy.ts'))
      .map(file => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => source.toLowerCase().includes('managed in skills section'));
    expect(hits.map(hit => hit.file)).toEqual([]);
  });
});
