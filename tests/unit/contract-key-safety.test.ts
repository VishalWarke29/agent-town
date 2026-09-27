import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { projectRoot } from '../../apps/service/src/store';

/** REV-22: external repo/tool/skill text (a dependency name, a file path, a tool name) must be
 * stored as an array entry, never as an object key — a key equal to __proto__, prototype or
 * constructor throws inside apps/service/src/ops/patches.ts's createStatePatch and is rejected by
 * ops/backup.ts's validateJsonTree, so a persisted `Record<string, ...>`/`z.record(...)` keyed by
 * anything external risks breaking a commit or making a backup unrestorable.
 *
 * This is a static contract-shape guard, not a proof that today's shapes are unsafe (an audit run
 * 2026-09-23 found no CURRENT persisted state keyed by external text — dependency/skill scanning
 * doesn't exist yet). Every keyed-record shape in the CODE of packages/contracts/src (any subfolder)
 * must be covered by an entry in ALLOWED below with a reason a human confirmed is a closed,
 * internally-defined key set — adding a new one without adding it here fails this test, forcing a
 * deliberate decision instead of a silent new key-by-external-text shape. What counts as a keyed
 * record is KEYED_BY_TEXT: `Record<string`, and zod's record functions however zod was imported
 * (`z.record(`, `zod.record(` through any alias, a bare `record(` from a named import, `record as rec`,
 * `z['record']`, and the zod 4 `partialRecord` / `looseRecord`).
 *
 * FD-07: each allowance is matched by the CODE TEXT it names (`code`), never by a line number, so
 * lines added or removed elsewhere in observation.ts, workflow.ts or any other contract file cannot
 * make this fail for an unrelated reason. `code` is an exact snippet of source that contains the
 * allowed keyed-record token; the allowance covers exactly one such token (the "exactly one" rule is
 * what catches a copy-pasted duplicate of an allowed line), and the snippet must start and end on a
 * whole identifier, so `xdefaults: ...` does not stand in for `defaults: ...`. Comments are blanked
 * out before matching (with the TypeScript parser, so `//` inside a string or a regular expression
 * is not mistaken for one): a comment that mentions `Record<string` is not a shape, and a comment
 * that still holds an allowed snippet cannot keep a dead allowance alive. When a snippet is
 * reworded or removed, this fails as "stale" and names the entry; when a new keyed record appears
 * anywhere, it fails as "unlisted" and names the file. The mutation checks at the bottom prove both
 * directions on mutated copies of the real sources held in memory, driven by ALLOWED itself (not by
 * fixed lines of the sources), so a legitimate edit near an allowed line cannot break them. Only the
 * folder-discovery check writes files, and only inside its own temporary folder.
 *
 * Known limits of a text guard, deliberately not covered: `.catchall(...)` and mapped types such as
 * `{ [K in string]: X }`, and a zod record function assigned to a variable before it is called. */
interface Allowance { file: string; code: string; because: string }

const ALLOWED: Allowance[] = [
  { file: 'observation.ts', code: 'readonly kinds: Readonly<Record<string, number>>', because: 'eventFormatRequirements.kinds is keyed by event kind NAMES the app itself defines in this same file (observationEventSchema\'s own enum), never by anything read from a repository or a native tool payload.' },
  { file: 'observation.ts', code: 'readonly fields: Readonly<Record<string, number>>', because: 'eventFormatRequirements.fields is keyed by optional field NAMES the app itself defines in this same file (observationEventSchema\'s own optional fields), never by anything read from a repository or a native tool payload.' },
  { file: 'observation.ts', code: 'requirements: Readonly<Record<string, number>> = eventFormatRequirements.kinds', because: 'eventKindSupported\'s default `requirements` parameter is the same code-defined eventFormatRequirements.kinds table referenced above.' },
  { file: 'observation.ts', code: 'requirements: Readonly<Record<string, number>> = eventFormatRequirements.fields', because: 'eventFieldSupported\'s default `requirements` parameter is the same code-defined eventFormatRequirements.fields table referenced above.' },
  { file: 'workflow.ts', code: 'defaults: Record<string, string>', because: '`defaults: Record<string, string>` is keyed only by `${provider}:${mode}` (apps/service/src/workflow/service.ts), and both provider (\'openai\'|\'anthropic\') and mode (\'api\'|\'subscription\') are closed enums defined in this same file — never external text.' },
  { file: 'vault.ts', code: 'repositories: Record<string, { lastBackupAt: string | null; lastRestoreAt: string | null; fileCount: number | null; totalBytes: number | null }>;', because: 'VaultState.repositories is keyed by repoId, which is always a server-generated id (localRepositoryId() in discovery/local-project.ts: `local-` plus a sha256 hex slice for a local project, or a GitHub numeric repository id as a string) — never a raw path, file, or any other externally-supplied text, and structurally cannot equal __proto__, constructor, or prototype.' },
  { file: 'vault.ts', code: 'restoreOperations?: Record<string, VaultRestoreOperationRecord>;', because: 'Keyed by a server-generated sha256-hex digest of the request Idempotency-Key header (see VaultService.restorePreview), never raw client text — a 64-character lowercase-hex string cannot equal __proto__, constructor or prototype.' },
];

/** A keyed-record shape, tolerant of spacing and of how zod was imported. The zod names are the ones zod 4
 * has: record, partialRecord and looseRecord. A call is `name(`, which covers `z.record(` and `zod.record(`
 * through any alias of the import and a bare `record(` from `import { record } from 'zod'`; the rename
 * `{ record as rec }` is flagged where it is written, because a later `rec(...)` cannot be traced by text. */
const ZOD_RECORD_NAMES = 'record|partialRecord|looseRecord';
const KEYED_BY_TEXT = new RegExp(String.raw`\bRecord\s*<\s*string\b|(?<![\w$])(?:${ZOD_RECORD_NAMES})\s*\(|[{,]\s*(?:${ZOD_RECORD_NAMES})\s+as\s+[\w$]+\s*[,}]|\[\s*(['"\`])(?:${ZOD_RECORD_NAMES})\1\s*\]`, 'g');

interface ContractSource { file: string; text: string }
interface Audit { unlisted: string[]; ambiguous: string[]; stale: string[] }

/** `text` with every comment blanked to spaces (same length, line breaks kept), found with the TypeScript
 * parser. Everything between two tokens is whitespace or a comment, so blanking what is not whitespace
 * there removes exactly the comments. Memoised: the mutation checks audit the same real files many times. */
const maskCache = new Map<string, string>();
function maskComments(file: string, text: string): string {
  const key = `${file}\0${text}`;
  const cached = maskCache.get(key);
  if (cached !== undefined) return cached;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, /\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const chars = text.split(''); // UTF-16 units, like the parser's positions (spreading the string would count an emoji once)
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JSDoc) return; // its text lies in the trivia before the next token
    const children = node.getChildren(source);
    if (children.length > 0) { children.forEach(visit); return; }
    const end = node.getStart(source);
    for (let index = node.pos; index < end; index++) if (!/\s/.test(chars[index]!)) chars[index] = ' ';
  };
  visit(source);
  const masked = chars.join('');
  maskCache.set(key, masked);
  return masked;
}

const IDENTIFIER_CHAR = /[\w$]/;
/** Every place `code` occurs in `text` on whole-identifier boundaries, as [start, end) character ranges. */
function occurrencesOf(text: string, code: string): [number, number][] {
  const spans: [number, number][] = [];
  const startsInWord = IDENTIFIER_CHAR.test(code[0] ?? ''), endsInWord = IDENTIFIER_CHAR.test(code[code.length - 1] ?? '');
  for (let at = text.indexOf(code); at !== -1; at = text.indexOf(code, at + 1)) {
    const end = at + code.length;
    if (startsInWord && at > 0 && IDENTIFIER_CHAR.test(text[at - 1]!)) continue;
    if (endsInWord && end < text.length && IDENTIFIER_CHAR.test(text[end]!)) continue;
    spans.push([at, end]);
  }
  return spans;
}

/** File name, line number and trimmed line text for a character offset. Diagnostics only: nothing is matched by them. */
function describeHit(file: string, text: string, index: number): string {
  const line = text.slice(0, index).split('\n').length;
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return `${file} (line ${line}): ${text.slice(start, end === -1 ? undefined : end).trim().slice(0, 160)}`;
}

function auditContractSources(sources: readonly ContractSource[], allowed: readonly Allowance[] = ALLOWED): Audit {
  const unlisted: string[] = [], ambiguous: string[] = [];
  const covered = new Map<Allowance, number>(allowed.map(entry => [entry, 0]));
  for (const { file, text: original } of sources) {
    const text = maskComments(file, original);
    const mine = allowed.filter(entry => entry.file === file).map(entry => ({ entry, spans: occurrencesOf(text, entry.code) }));
    for (const hit of text.matchAll(KEYED_BY_TEXT)) {
      const at = hit.index;
      const owners = mine.filter(({ spans }) => spans.some(([start, end]) => at >= start && at < end)).map(({ entry }) => entry);
      if (owners.length === 0) unlisted.push(describeHit(file, original, at));
      else if (owners.length > 1) ambiguous.push(describeHit(file, original, at));
      else covered.set(owners[0]!, covered.get(owners[0]!)! + 1);
    }
  }
  const stale = allowed.filter(entry => covered.get(entry) !== 1)
    .map(entry => `${entry.file}: the allowance for \`${entry.code}\` covers ${covered.get(entry)} keyed-record token(s) but must cover exactly 1`);
  return { unlisted, ambiguous, stale };
}

/** Line-based scan kept for the index-signature rule, whose output only ever needs to be empty. */
function findOccurrences(source: string, pattern: RegExp): number[] {
  const lines = source.split('\n');
  const hits: number[] = [];
  lines.forEach((line, index) => { if (pattern.test(line)) hits.push(index + 1); });
  return hits;
}

const contractsDir = join(projectRoot, 'packages/contracts/src');
const INDEX_SIGNATURE = /\[\s*\w+\s*:\s*string\s*\]\s*:/;
const CONTRACT_SOURCE = /\.(?:ts|tsx|mts|cts)$/;

/** Every TypeScript source under `directory`, at any depth, as sorted paths relative to it with `/` separators. */
function listContractFiles(directory: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') found.push(...listContractFiles(directory, relative)); }
    else if (CONTRACT_SOURCE.test(entry.name)) found.push(relative);
  }
  return found;
}
function readContracts(directory: string = contractsDir): ContractSource[] {
  return listContractFiles(directory).map(file => ({ file, text: readFileSync(join(directory, file), 'utf8') }));
}

describe('REV-22: contract-shape guard against keying persisted records by external text', () => {
  const files = listContractFiles(contractsDir);

  it('every Record<string,…> or z.record(...) in packages/contracts/src is an explicitly reviewed, closed-key-set allowance', () => {
    const { unlisted, ambiguous, stale } = auditContractSources(readContracts());
    expect(unlisted, 'A new Record<string,…>/z.record(...) shape was added to a contract without adding it to ALLOWED in this test — confirm the key set is closed and internally defined (never a repo/tool/skill name) before allowlisting it here.').toEqual([]);
    expect(ambiguous, 'Two ALLOWED entries claim the same Record/z.record token — make each `code` snippet name exactly one.').toEqual([]);
    // Also catch the opposite drift: an allowlisted snippet whose code was reworded, deleted or duplicated.
    expect(stale, 'An ALLOWED entry no longer matches real source exactly once — the code it names was reworded, removed or copied. Update this test\'s ALLOWED list to match.').toEqual([]);
  });

  it('has no index signature (`[key: string]:`) on a contract type either — same rule, different TypeScript spelling', () => {
    const found: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      const source = readFileSync(join(contractsDir, file), 'utf8');
      findOccurrences(source, INDEX_SIGNATURE).forEach(line => found.push({ file, line, text: source.split('\n')[line - 1].trim() }));
    }
    expect(found).toEqual([]);
  });
});

/** FD-07 mutation checks. Each case changes an in-memory copy of the real contract sources and looks only
 * at what its own change adds, comparing against the unmutated audit, so a genuine violation elsewhere in
 * the tree fails the two REV-22 tests above and does not cascade into every case here. The cases are driven
 * by ALLOWED (each allowance's own `code`), never by fixed text of the real sources. */
describe('FD-07 mutation checks: the guard follows code text, not line numbers, and is not vacuous', () => {
  const real = readContracts();
  const counts = (audit: Audit) => ({ unlisted: audit.unlisted.length, ambiguous: audit.ambiguous.length, stale: audit.stale.length });
  const baseline = auditContractSources(real);
  const before = counts(baseline);
  const label = (entry: Allowance) => `${entry.file}: ${entry.code}`;
  const staleFor = (audit: Audit, entry: Allowance) => audit.stale.filter(message => message.startsWith(`${entry.file}: `) && message.includes(`\`${entry.code}\``));
  /** The allowances that still match the real source exactly once. One that does not is named by the REV-22 test above; leaving it out here keeps that single problem from failing every case below. */
  const usable = ALLOWED.filter(entry => staleFor(baseline, entry).length === 0);
  const allowedFiles = [...new Set(usable.map(entry => entry.file))];

  /** A copy of the real sources with one file's text changed. The change must really change it. */
  function mutated(file: string, change: (text: string) => string): ContractSource[] {
    let changed = false;
    const sources = real.map(source => {
      if (source.file !== file) return source;
      const text = change(source.text);
      changed = text !== source.text;
      return { file, text };
    });
    expect(changed, `the mutation of ${file} did not change its text, so it would prove nothing`).toBe(true);
    return sources;
  }
  /** Change the real code of one allowance (its first occurrence outside comments): `change` gets the text and the [start, end) of the snippet. */
  function mutatedAllowance(entry: Allowance, change: (text: string, start: number, end: number) => string): ContractSource[] {
    return mutated(entry.file, text => {
      const [span] = occurrencesOf(maskComments(entry.file, text), entry.code);
      expect(span, `the code of this allowance is no longer in ${entry.file} (the REV-22 test above names it): ${entry.code}`).toBeDefined();
      return change(text, span![0], span![1]);
    });
  }
  const unlistedIn = (audit: Audit, file: string) => audit.unlisted.filter(message => message.startsWith(`${file} (line`));

  it('has at least one allowance that still matches the real source, so the cases below exercise something', () => {
    expect(usable.length, 'no ALLOWED entry matches the real source exactly once (the REV-22 test above names each stale one)').toBeGreaterThan(0);
  });

  it('lines and comments added at the top of a file, or directly above an allowed line, change nothing', () => {
    for (const file of allowedFiles) {
      expect(counts(auditContractSources(mutated(file, text => `\n\n// an unrelated line added at the top\n\n${text}`))), `${file}: lines at the top`).toEqual(before);
    }
    for (const entry of usable) {
      const audit = auditContractSources(mutatedAllowance(entry, (text, start) => `${text.slice(0, start)}\n\n// inserted just above the allowed code\n${text.slice(start)}`));
      expect(counts(audit), `${label(entry)}: lines just above the allowed code`).toEqual(before);
    }
  });

  it('a new Record<string,x> in an existing contract file turns it red and names that file', () => {
    const file = usable[0]!.file;
    const after = auditContractSources(mutated(file, text => `${text}\nexport type InjectedByFd07Mutation = Record<string, number>;\n`));
    expect(after.unlisted.filter(message => message.includes('InjectedByFd07Mutation'))).toEqual([expect.stringContaining(file)]);
    expect(after.unlisted).toHaveLength(before.unlisted + 1);
    expect(counts(after).stale).toBe(before.stale);
    expect(counts(after).ambiguous).toBe(before.ambiguous);
  });

  it('a z.record(...) in a brand-new contract file turns it red and names the new file', () => {
    const audit = auditContractSources([...real, { file: 'skillsMutation.ts', text: 'import { z } from \'zod\';\nexport const skillIndex = z.record(z.string(), z.number());\n' }]);
    expect(unlistedIn(audit, 'skillsMutation.ts')).toHaveLength(1);
  });

  it('extra spacing cannot hide a keyed record', () => {
    for (const spelled of ['Record < string, number >', 'Record<\n  string, number>', 'z . record (z.string(), z.number())']) {
      const audit = auditContractSources([...real, { file: 'spacedMutation.ts', text: `export const x: ${spelled};\n` }]);
      expect(unlistedIn(audit, 'spacedMutation.ts'), spelled).toHaveLength(1);
    }
  });

  it('a zod record reached through an aliased or renamed import still counts, whichever zod record function it is', () => {
    const spellings = [
      "import * as zod from 'zod';\nexport const a = zod.record(zod.string(), zod.number());",
      "import { z as validator } from 'zod';\nexport const a = validator.record(validator.string(), validator.number());",
      "import { record } from 'zod';\nexport const a = record(z.string(), z.number());",
      "import {\n  z,\n  record as keyed,\n} from 'zod';\nexport const a = keyed(z.string(), z.number());",
      "import { z } from 'zod';\nexport const a = z['record'](z.string(), z.number());",
      "import { z } from 'zod';\nexport const a = z.partialRecord(z.string(), z.number());",
      "import { z } from 'zod';\nexport const a = z.looseRecord(z.string(), z.number());",
    ];
    for (const text of spellings) {
      const audit = auditContractSources([...real, { file: 'aliasMutation.ts', text }]);
      expect(unlistedIn(audit, 'aliasMutation.ts'), text).toHaveLength(1);
    }
  });

  it('shapes that are not keyed by text, and words that only contain "record", are not flagged', () => {
    const text = [
      "import { z } from 'zod';",
      'export type Kinds = Record<ToolSurface, string>;',
      'export type Some = Partial<Record<ToolSurface, readonly ToolSurface[]>>;',
      'export const recordCount = 3; export function recorded(x: number) { return x; } export const myrecord = (x: number) => x;',
      'export const rows = z.array(z.object({ record: z.string(), records: z.number() }));',
      'export const label = "saved as a record"; export const records = [1].map(item => item);',
    ].join('\n');
    expect(unlistedIn(auditContractSources([...real, { file: 'fineMutation.ts', text }]), 'fineMutation.ts')).toEqual([]);
  });

  it('a keyed record written only inside a comment is not a shape, and the guard does not confuse a string or regular expression for a comment', () => {
    const comments = "// Record<string, number> and z.record(z.string(), z.number()) were considered.\n/** `z.partialRecord(` too: Record<string, x> */\nexport const fine = 1; /* record(a, b) */\n";
    expect(unlistedIn(auditContractSources([...real, { file: 'commentMutation.ts', text: comments }]), 'commentMutation.ts')).toEqual([]);
    const notComments = "export const link = 'http://example.test//x'; export type A = Record<string, number>;\nexport const pattern = /https?:\\/\\//; export type B = Record<string, string>;\n";
    expect(unlistedIn(auditContractSources([...real, { file: 'notCommentMutation.ts', text: notComments }]), 'notCommentMutation.ts')).toHaveLength(2);
  });

  it('a character outside the basic plane before a comment does not shift which text is blanked', () => {
    const text = "export const house = '🏠🏠'; // Record<string, number> in a comment\nexport type Real = Record<string, number>;\n/* 🏠 z.record(a, b) */ export type Also = Record<string, string>;\n";
    const audit = auditContractSources([...real, { file: 'emojiMutation.ts', text }]);
    expect(unlistedIn(audit, 'emojiMutation.ts').map(message => message.replace(/^.*?: /, ''))).toEqual(['export type Real = Record<string, number>;', '/* 🏠 z.record(a, b) */ export type Also = Record<string, string>;']);
  });

  it('a second keyed record added beside an allowed one is not covered by that allowance', () => {
    for (const entry of usable) {
      const after = auditContractSources(mutatedAllowance(entry, (text, _start, end) => `${text.slice(0, end)} ; extraByFd07: Record<string, number>${text.slice(end)}`));
      // Not matched by the record's name: describeHit trims a long line, and the new token sits at its end.
      expect(unlistedIn(after, entry.file), label(entry)).toHaveLength(unlistedIn(baseline, entry.file).length + 1);
      expect(counts(after).unlisted, `${label(entry)}: exactly one new unlisted record`).toBe(before.unlisted + 1);
      expect(counts(after).stale, `${label(entry)}: the neighbouring allowance must still cover exactly its own token`).toBe(before.stale);
    }
  });

  it('an allowed line copied elsewhere in the same file is caught, because an allowance covers exactly one token', () => {
    for (const entry of usable) {
      const after = auditContractSources(mutated(entry.file, text => `${text}\nexport type CopiedByFd07 = { ${entry.code} };\n`));
      expect(staleFor(after, entry), label(entry)).toEqual([expect.stringMatching(/covers 2 keyed-record/)]);
    }
  });

  it('rewording or removing an allowed shape is reported as stale so ALLOWED cannot rot', () => {
    for (const entry of usable) {
      const after = auditContractSources(mutatedAllowance(entry, (text, start, end) => `${text.slice(0, start)}string[]${text.slice(end)}`));
      expect(staleFor(after, entry), label(entry)).toEqual([expect.stringMatching(/covers 0 keyed-record/)]);
      expect(counts(after).unlisted, `${label(entry)}: removing a shape must not add an unlisted one`).toBe(before.unlisted);
    }
  });

  it('renaming what an allowed line is about is not covered: the snippet must start on a whole identifier', () => {
    for (const entry of usable) {
      const after = auditContractSources(mutatedAllowance(entry, (text, start) => `${text.slice(0, start)}x${text.slice(start)}`));
      expect(staleFor(after, entry), label(entry)).toEqual([expect.stringMatching(/covers 0 keyed-record/)]);
      expect(counts(after).unlisted, `${label(entry)}: the renamed record is unlisted`).toBe(before.unlisted + 1);
    }
  });

  it('a comment that still holds an allowed snippet does not keep a dead allowance alive', () => {
    for (const entry of usable) {
      const after = auditContractSources(mutatedAllowance(entry, (text, start, end) => `${text.slice(0, start)}string[] /* was ${text.slice(start, end)} */${text.slice(end)}`));
      expect(staleFor(after, entry), label(entry)).toEqual([expect.stringMatching(/covers 0 keyed-record/)]);
      expect(counts(after).unlisted, `${label(entry)}: a keyed record inside a comment is not a shape`).toBe(before.unlisted);
    }
    const first = usable[0]!;
    const lineComment = auditContractSources(mutatedAllowance(first, (text, start, end) => `${text.slice(0, start)}string[]; // ${text.slice(start, end)}\n${text.slice(end)}`));
    expect(staleFor(lineComment, first), 'a line comment holding the snippet').toEqual([expect.stringMatching(/covers 0 keyed-record/)]);
  });

  it('two allowances claiming the same token are reported as ambiguous instead of being double counted', () => {
    const first = usable[0]!;
    const audit = auditContractSources(real, [...ALLOWED, { ...first, because: 'a second entry naming the same code' }]);
    expect(audit.ambiguous.length).toBe(before.ambiguous + 1);
    expect(audit.ambiguous.filter(message => message.startsWith(`${first.file} (line`))).toHaveLength(1);
  });

  it('finds contract files in subfolders at any depth, so a keyed record cannot hide in one', () => {
    for (const entry of ALLOWED) expect(real.map(source => source.file), `${entry.file} is where ALLOWED expects it`).toContain(entry.file);
    const root = mkdtempSync(join(tmpdir(), 'contract-key-safety-'));
    try {
      mkdirSync(join(root, 'areas', 'deep'), { recursive: true });
      writeFileSync(join(root, 'top.ts'), 'export const a = 1;\n');
      writeFileSync(join(root, 'areas', 'deep', 'keyed.ts'), 'export type ByName = Record<string, number>;\n');
      writeFileSync(join(root, 'areas', 'view.tsx'), 'export const b = z.record(z.string(), z.number());\n');
      writeFileSync(join(root, 'areas', 'notes.md'), 'Record<string, number> is discussed here.\n');
      expect(listContractFiles(root)).toEqual(['areas/deep/keyed.ts', 'areas/view.tsx', 'top.ts']);
      const audit = auditContractSources(readContracts(root), []);
      expect(audit.unlisted).toEqual([expect.stringContaining('areas/deep/keyed.ts (line 1)'), expect.stringContaining('areas/view.tsx (line 1)')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the index-signature rule also sees an injected `[key: string]:` member in a mutated copy', () => {
    const observation = real.find(source => source.file === usable[0]!.file)!;
    const count = findOccurrences(observation.text, INDEX_SIGNATURE).length;
    expect(findOccurrences(`${observation.text}\nexport interface Bag { [key: string]: number }\n`, INDEX_SIGNATURE)).toHaveLength(count + 1);
  });
});
