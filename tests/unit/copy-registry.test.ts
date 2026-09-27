import { describe, expect, it } from 'vitest';

/** FD-07: the copy registry. Every screen's wording lives in an `apps/web/src/*Copy.ts` module so it
 * can be checked against what this build really does (firstRunCopy.ts today; houseCopy.ts from H0-05,
 * the chat and skills copy later). This test discovers every such module (any depth under
 * apps/web/src, file name ending in `Copy.ts` or `Copy.tsx`, any letter case) and fails when one is not
 * registered, so a new module cannot ship its wording unchecked.
 *
 * NAMING RULE. The file name is the contract: a module that ends in Copy.ts / Copy.tsx holds UI wording
 * and must register. A helper that merely happens to end that way (clipboardCopy.ts) would be demanded
 * to register too, so name it differently (clipboard.ts).
 *
 * HOW A MODULE REGISTERS. Export a COPY_REGISTRATION from the module itself, next to the words it
 * guards (see the bottom of apps/web/src/firstRunCopy.ts). Nothing reads it at run time:
 *
 *   export const COPY_REGISTRATION = {
 *     bannedWords: ['upload', 'context'],           // this module's OWN banned words (substring, any case)
 *     textFunctions: { greeting: () => [greeting(true), greeting(false)] }, // each exported function that
 *                                                   // returns UI text -> every string it can return
 *     nonTextFunctions: ['isReturningVisitor'],     // exported functions that return no UI text
 *   } as const;
 *
 * WHAT IS SCANNED. Every string the module exports (plain strings, arrays and plain objects of them,
 * at any depth) plus everything its text functions return. The registration itself and the module's own
 * banned-word list are skipped: they name banned words by definition. The list is recognised by its
 * contents, so exporting the very array that is registered, or a copy of it, both work; any other list
 * of banned words is scanned like copy and fails with a hint. Each module is checked against (1) its
 * own banned words and (2) SHARED_HONESTY_RULES below, which apply to every module. What cannot be
 * scanned reliably is a problem, not a silent skip: an exported function that is in neither
 * `textFunctions` nor `nonTextFunctions`, and a function, Map, Set or class instance inside an exported
 * value. Export plain strings, arrays and plain objects, and list functions in the registration.
 *
 * ADDING A SHARED RULE. Add it to SHARED_HONESTY_RULES with a `why` that cites the decision, give every
 * pattern the `g` flag (matchAll needs it), then add both kinds of example to the rule's self-tests (a
 * sentence it must flag and an honest sentence it must allow). A rule that flags an honest sentence
 * teaches people to loosen it.
 *
 * HOW A NEGATION IS HANDLED. Honest negatives ("No task has started", "Connecting installs nothing")
 * must pass, so a rule with `ignoreNegated` ignores a match when a negation word comes earlier in the
 * SAME CLAUSE. A clause ends at sentence punctuation, a comma, a dash, a bracket, or a word that starts a
 * new clause ("but", "and", "so", "then", ...). So "No task has started" passes, and "No sessions yet,
 * but your task was assigned to Claude Code" does not. These rules are tripwires that lean towards
 * flagging: when an honest sentence is flagged, reword it or change the rule and its self-test together;
 * never loosen a module's wording to slip past.
 *
 * A module with words of its own to ban (for example H0-05 rejecting "sync", "syncing" and "synced")
 * lists them in its own `bannedWords`; they are not shared because another module may legitimately use them. */

interface CopyRegistration {
  bannedWords: readonly string[];
  textFunctions: Readonly<Record<string, () => readonly string[]>>;
  nonTextFunctions: readonly string[];
}
type CopyModule = Record<string, unknown>;
interface LoadedCopy { file: string; module: CopyModule }
interface CopyAudit {
  problems: string[];
  violations: string[];
  /** How many strings were scanned per registered module. */
  scanned: Record<string, number>;
  /** The strings themselves, per registered module, so a test can prove nothing was left out. */
  texts: Record<string, string[]>;
}

const REGISTRATION_EXPORT = 'COPY_REGISTRATION';

/** A sentence-level honesty rule that applies to every registered module. */
interface HonestyRule {
  id: string;
  /** Why the phrase is false or unprovable in this build, citing the decision that says so. */
  why: string;
  patterns: readonly RegExp[];
  /** True when an honest negative ("no task has started", "nothing is assigned") must be allowed: a match
   * is ignored when a negation word appears earlier in the same clause (see NEGATION_EARLIER_IN_CLAUSE). */
  ignoreNegated: boolean;
}

/** The tools a hand-off or a tool state is about, and the words for something Agent Town prepares. */
const TOOL_NAME = String.raw`(?:claude(?:\s+code)?|codex|cursor|copilot(?:\s+cli)?|gemini(?:\s+cli)?)`;
const HANDOFF_NOUN = String.raw`(?:tasks?|hand[\s-]?offs?|packets?|prompts?|briefs?)`;
/** Who could be claimed to have acted: Agent Town itself, "we", "it", or a named tool. The owner ("you") is not on the list on purpose. */
const ACTOR = String.raw`(?:agent\s+town|we|it|the\s+(?:app|manager|coordinator)|${TOOL_NAME})`;
const ACTOR_AUXILIARY = String.raw`(?:(?:has|have|had|is|are|was|were|will|would|been|being|already|just|now|also|successfully|automatically)\s+){0,4}`;
const ACTION = String.raw`(?:assign(?:s|ed|ing)?|start(?:s|ed|ing)?|launch(?:es|ed|ing)?|run(?:s|ning)?|ran)`;
/** Determiners and a few adjectives, never a negation, so "starts no tasks" is not read as a claim. */
const OBJECT_WORDS = String.raw`(?:(?:the|your|this|that|a|an|their|its|our|my|each|every|any|all|both|these|those|\d+|one|two|three|new|first|next|second|same|latest|prepared|drafted|approved|saved|copied|chosen|selected|open|current|follow-up)\s+){0,3}`;
const PASSIVE_AUXILIARY = String.raw`(?:(?:has|have|had|is|are|was|were|been|being|got|gets|now|already|just|also|successfully|automatically)\s+){0,4}`;
const INSTALLED_SUBJECT = String.raw`(?:${TOOL_NAME}|tools?|cli)`;

const SHARED_HONESTY_RULES: readonly HonestyRule[] = [
  {
    id: 'nothing-was-scanned',
    why: 'Folders and Git details are still checked in the background, so "nothing was scanned" is false; say "No sessions were scanned" (H0-05, D38).',
    ignoreNegated: false,
    patterns: [
      // "Nothing was scanned", "Nothing has been scanned yet", "Nothing will be scanned until...", "Nothing's been scanned", "Nothing scanned"
      /\bnothing(?:['’]s)?\s+(?:(?:was|were|is|are|gets|got|has|have|had|will|would|been|being|be|yet|ever|so\s+far)\s+)*scanned\b/gi,
    ],
  },
  {
    id: 'handoff-state-claim',
    why: 'Agent Town prepares a task as text and the owner runs it in their own tool, so it cannot say a hand-off was assigned or started unless the owner marked it (D41, CH-15).',
    ignoreNegated: true,
    patterns: [
      // passive: "Task assigned", "The hand-off was started", "Hand off started", "Your prompt has been assigned", "the packet is now started"
      new RegExp(String.raw`\b${HANDOFF_NOUN}\s+${PASSIVE_AUXILIARY}(?:assigned|started)\b`, 'gi'),
      // active: "Agent Town assigned the task", "We started your task", "Claude Code has started the hand-off", "It will run the prompt"
      new RegExp(String.raw`\b${ACTOR}\s+${ACTOR_AUXILIARY}${ACTION}\s+${OBJECT_WORDS}${HANDOFF_NOUN}\b`, 'gi'),
      // "Assigned to Claude Code", "assigned it to your tool", "assigned the task to Codex"
      new RegExp(String.raw`\bassigned\s+(?:\w+\s+){0,3}?to\s+(?:${TOOL_NAME}|your\s+tool|the\s+tool)\b`, 'gi'),
      // a whole string that is only a status label: "Assigned", "Status: Started", "Started ✓"
      /^\s*(?:(?:status|state)\s*[:\-–—]\s*)?(?:assigned|started)\s*[.!✓✔]*\s*$/gi,
    ],
  },
  {
    id: 'installed-for-found-tool',
    why: 'A settings folder proves that a folder exists, not that a tool is installed; say "Settings folder found" (TL-01, D40).',
    ignoreNegated: true,
    patterns: [
      // a status label: "Installed — no activity for this project yet", "Installed:", "Installed.", "Status: Installed"
      /^\s*(?:(?:status|state)\s*[:\-–—]\s*)?installed\s*(?:[\-–—:]|[.!✓✔]*\s*$)/gi,
      // "Claude Code is installed", "Codex appears to be installed", "Cursor is already installed", "Codex was found and installed"
      new RegExp(String.raw`\b${INSTALLED_SUBJECT}\s+(?:(?:is|are|was|were|looks|seems|appears|already|now|just|has|have|been|to|be|also|found|detected|and)\s+){0,4}installed\b`, 'gi'),
      // a label form: "Codex: installed", "Codex - installed", "Cursor: Installed", "Copilot CLI (installed)", "Codex ✓ installed"
      new RegExp(String.raw`\b${INSTALLED_SUBJECT}\s*[:\-–—(|·•✓✔]\s*installed\b`, 'gi'),
      // "shown as installed", "marked as installed"
      /\bas\s+installed\b/gi,
      // "installed on this computer", "installed tools"
      /\binstalled\s+(?:on\s+this\s+(?:computer|machine|pc)|tools?)\b/gi,
    ],
  },
];

/** A negation word earlier in the same clause: nothing that starts a new clause (sentence punctuation, a comma,
 * a dash, a bracket, a bar, an ellipsis, a spaced hyphen, or a word such as "but" or "and") lies between it and the end of the text. */
const NEGATION_WORD = String.raw`(?:no|not|never|nothing|nobody|none|neither|nor|without|cannot|\w+n['’]t)`;
const NEW_CLAUSE = String.raw`(?:\b(?:but|and|yet|so|then|however|although|though|while|whereas|instead|because|since)\b|\s-+\s)`;
const NEGATION_EARLIER_IN_CLAUSE = new RegExp(String.raw`\b${NEGATION_WORD}\b(?:(?!${NEW_CLAUSE})[^.;:!?,()|\n–—…])*$`, 'i');

function ruleHits(rule: HonestyRule, text: string): boolean {
  return rule.patterns.some(pattern => [...text.matchAll(pattern)].some(hit => !(rule.ignoreNegated && NEGATION_EARLIER_IN_CLAUSE.test(text.slice(0, hit.index)))));
}

/** Everything wrong with one string: its module's own banned words, then the shared honesty rules. */
function violationsIn(text: string, bannedWords: readonly string[]): string[] {
  const lower = text.toLowerCase();
  const found = bannedWords.filter(word => lower.includes(word.toLowerCase())).map(word => `banned word "${word}"`);
  for (const rule of SHARED_HONESTY_RULES) if (ruleHits(rule, text)) found.push(`shared rule ${rule.id} (${rule.why})`);
  return found;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeObject(value: object): string {
  if (value instanceof Map) return 'a Map';
  if (value instanceof Set) return 'a Set';
  const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor?.name;
  return name ? `an instance of ${name}` : 'a non-plain object';
}

/** Gather every string reachable from an exported value. A function, Map, Set or class instance inside one
 * cannot be scanned reliably, so it is a problem rather than text that silently escapes the scan. */
function collectStrings(value: unknown, path: string, out: string[], problems: string[], seen: Set<object> = new Set()): void {
  if (typeof value === 'string') { out.push(value); return; }
  if (typeof value === 'function') {
    problems.push(`${path} is a function inside an exported value: export text-producing functions at the top level and list them in ${REGISTRATION_EXPORT}.textFunctions`);
    return;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, out, problems, seen));
  else if (isPlainObject(value)) for (const [key, item] of Object.entries(value)) collectStrings(item, `${path}.${key}`, out, problems, seen);
  else if (!(value instanceof RegExp || value instanceof Date)) problems.push(`${path} is ${describeObject(value)} inside an exported value, so its text cannot be scanned: export plain strings, arrays and plain objects instead`);
}

const asStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

/** True for the module's own banned-word list, whether it is the registered array itself or a copy of it. */
function holdsSameWords(value: unknown, words: readonly string[]): boolean {
  if (!asStringList(value) || value.length !== words.length) return false;
  const lower = new Set(words.map(word => word.toLowerCase()));
  return value.every(word => lower.has(word.toLowerCase()));
}

const BANNED_LIST_HINT = ` - a string that is exactly a banned word usually means a banned-word list is exported beside ${REGISTRATION_EXPORT}: list the same words in ${REGISTRATION_EXPORT}.bannedWords (an exact copy is skipped), or keep the list out of this module`;

/** Check registration shape, classification of every function export, and every reachable string. */
function auditCopyModules(modules: readonly LoadedCopy[]): CopyAudit {
  const audit: CopyAudit = { problems: [], violations: [], scanned: {}, texts: {} };
  for (const { file, module } of modules) {
    const registration = module[REGISTRATION_EXPORT] as Partial<CopyRegistration> | undefined;
    if (!isPlainObject(registration)) {
      audit.problems.push(`${file}: no ${REGISTRATION_EXPORT} export. Every *Copy.ts / *Copy.tsx must register its own banned words (see the header of tests/unit/copy-registry.test.ts) before its wording can ship. If this file holds no UI wording, rename it: a name ending in Copy.ts or Copy.tsx means UI wording.`);
      continue;
    }
    const before = audit.problems.length;
    const { bannedWords, textFunctions, nonTextFunctions } = registration;
    if (!asStringList(bannedWords) || bannedWords.length === 0) audit.problems.push(`${file}: ${REGISTRATION_EXPORT}.bannedWords must be a non-empty list of strings (this module's own banned words).`);
    else {
      const seen = new Set<string>();
      for (const word of bannedWords) {
        if (word.trim().length < 3) audit.problems.push(`${file}: banned word "${word}" is shorter than 3 characters and would flag ordinary text.`);
        if (seen.has(word.toLowerCase())) audit.problems.push(`${file}: banned word "${word}" is listed twice.`);
        seen.add(word.toLowerCase());
      }
    }
    if (!isPlainObject(textFunctions)) audit.problems.push(`${file}: ${REGISTRATION_EXPORT}.textFunctions must be an object mapping each text-producing function to a thunk (use {} when there are none).`);
    if (!asStringList(nonTextFunctions)) audit.problems.push(`${file}: ${REGISTRATION_EXPORT}.nonTextFunctions must be a list of function names (use [] when there are none).`);
    if (audit.problems.length > before) continue;

    const banned = bannedWords as readonly string[];
    const textNames = Object.keys(textFunctions as object), nonTextNames = nonTextFunctions as readonly string[];
    const functionExports = Object.entries(module).filter(([name, value]) => name !== REGISTRATION_EXPORT && typeof value === 'function').map(([name]) => name);
    for (const name of functionExports) {
      const listed = (textNames.includes(name) ? 1 : 0) + nonTextNames.filter(other => other === name).length;
      if (listed === 0) audit.problems.push(`${file}: exported function ${name} is not classified. List it in ${REGISTRATION_EXPORT}.textFunctions (with a thunk returning every string it can return) or in ${REGISTRATION_EXPORT}.nonTextFunctions.`);
      else if (listed > 1) audit.problems.push(`${file}: exported function ${name} is listed more than once in ${REGISTRATION_EXPORT}.`);
    }
    for (const name of [...textNames, ...nonTextNames]) {
      if (!functionExports.includes(name)) audit.problems.push(`${file}: ${REGISTRATION_EXPORT} names ${name}, which is not an exported function of this module (renamed or removed?).`);
    }

    const texts: string[] = [];
    for (const [name, value] of Object.entries(module)) {
      if (name === REGISTRATION_EXPORT || typeof value === 'function' || holdsSameWords(value, banned)) continue;
      collectStrings(value, name, texts, audit.problems);
    }
    for (const [name, thunk] of Object.entries(textFunctions as Record<string, () => readonly string[]>)) {
      try {
        const produced = thunk();
        if (!asStringList(produced) || produced.length === 0 || produced.some(text => text.trim() === '')) audit.problems.push(`${file}: ${REGISTRATION_EXPORT}.textFunctions.${name} must return a non-empty list of non-empty strings.`);
        else texts.push(...produced);
      } catch (error) {
        audit.problems.push(`${file}: ${REGISTRATION_EXPORT}.textFunctions.${name} threw ${error instanceof Error ? error.message : 'an error'}.`);
      }
    }
    audit.scanned[file] = texts.length;
    audit.texts[file] = texts;
    for (const text of texts) {
      const hint = banned.some(word => word.toLowerCase() === text.trim().toLowerCase()) ? BANNED_LIST_HINT : '';
      for (const violation of violationsIn(text, banned)) audit.violations.push(`${file}: ${violation} in "${text}"${hint}`);
    }
  }
  return audit;
}

/** The real modules, discovered from the file system tree Vite sees, so a new file appears without editing this test. */
const candidates = import.meta.glob('../../apps/web/src/**/*.{ts,tsx}') as Record<string, () => Promise<CopyModule>>;
const COPY_FILE = /(?:^|\/)[^/]*copy\.tsx?$/i;
const isCopyModulePath = (key: string) => COPY_FILE.test(key);
const displayPath = (key: string) => key.replace(/^(?:\.\.\/)+/, '');
async function loadRealCopyModules(): Promise<LoadedCopy[]> {
  const keys = Object.keys(candidates).filter(isCopyModulePath).sort();
  return Promise.all(keys.map(async key => ({ file: displayPath(key), module: await candidates[key]!() })));
}

describe('copy registry (FD-07): every apps/web/src/*Copy.ts registers its own banned words', () => {
  it('discovers firstRunCopy.ts, so the scan below cannot pass by finding nothing', async () => {
    const loaded = await loadRealCopyModules();
    expect(loaded.map(entry => entry.file)).toContain('apps/web/src/firstRunCopy.ts');
  });

  it('looks at .ts and .tsx files, so a *Copy.tsx module cannot be missed', () => {
    const keys = Object.keys(candidates);
    expect(keys.some(key => key.endsWith('.tsx')), 'the discovery glob sees no .tsx file in apps/web/src').toBe(true);
    expect(keys.some(key => key.endsWith('.ts')), 'the discovery glob sees no .ts file in apps/web/src').toBe(true);
  });

  it('every *Copy.ts has a well-formed COPY_REGISTRATION with every function export classified (a new unregistered one fails here)', async () => {
    const { problems } = auditCopyModules(await loadRealCopyModules());
    expect(problems, 'A *Copy.ts module under apps/web/src is not registered correctly. Add or fix its COPY_REGISTRATION as described in the header of tests/unit/copy-registry.test.ts.').toEqual([]);
  });

  it('every registered module is scanned with its own banned words plus the shared honesty phrases, and none contains one', async () => {
    const { violations } = auditCopyModules(await loadRealCopyModules());
    expect(violations, 'A registered copy string breaks its module\'s own banned words or a shared honesty phrase. Reword the sentence; do not remove the ban.').toEqual([]);
  });

  it('scans every string a registered module exports and every string its text functions return, so no text is left out', async () => {
    const loaded = await loadRealCopyModules();
    const { texts } = auditCopyModules(loaded);
    // A module that is not registered (or is malformed) is reported by the registration test above, not here.
    for (const { file, module } of loaded) {
      const scannedTexts = texts[file];
      if (!scannedTexts) continue;
      expect(scannedTexts.length, `${file} is registered but yielded no strings to scan`).toBeGreaterThan(0);
      const { textFunctions } = module[REGISTRATION_EXPORT] as CopyRegistration;
      const expected = [
        ...Object.entries(module).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([name, text]) => ({ where: `the exported string ${name}`, text })),
        ...Object.entries(textFunctions).flatMap(([name, thunk]) => thunk().map(text => ({ where: `a string returned by ${name}()`, text }))),
      ];
      const skipped = expected.filter(({ text }) => !scannedTexts.includes(text)).map(({ where, text }) => `${where}: "${text}"`);
      expect(skipped, `${file}: text that the scan skipped`).toEqual([]);
    }
  });

  it('removing a plain export changes the scan by exactly that string and fails nothing, so a reworded or merged constant does not break this suite', async () => {
    const loaded = await loadRealCopyModules();
    let exercised = 0;
    for (const { file, module } of loaded) {
      const whole = auditCopyModules([{ file, module }]);
      const removable = Object.keys(module).find(name => typeof module[name] === 'string');
      if (!(file in whole.scanned) || removable === undefined) continue;
      const without = Object.fromEntries(Object.entries(module).filter(([name]) => name !== removable));
      const after = auditCopyModules([{ file, module: without }]);
      expect(after.problems, `${file} without ${removable}`).toEqual(whole.problems);
      expect(after.scanned[file], `${file} without ${removable}`).toBe(whole.scanned[file]! - 1);
      exercised++;
    }
    expect(exercised, 'no registered module had a plain string export to remove, so this proved nothing').toBeGreaterThan(0);
  });

  it('the *Copy naming rule: any depth, .ts or .tsx, any case; a helper that merely ends that way is caught, and other names are not', () => {
    for (const path of ['../../apps/web/src/firstRunCopy.ts', '../../apps/web/src/screens/HouseCopy.tsx', '../../apps/web/src/a/b/skillsCOPY.ts', '../../apps/web/src/Copy.ts', '../../apps/web/src/clipboardCopy.ts']) {
      expect(isCopyModulePath(path), path).toBe(true);
    }
    for (const path of ['../../apps/web/src/copyHelpers.ts', '../../apps/web/src/firstRunCopy.test.ts', '../../apps/web/src/firstRunCopy.d.ts', '../../apps/web/src/copy.css', '../../apps/web/src/App.tsx']) {
      expect(isCopyModulePath(path), path).toBe(false);
    }
  });
});

describe('the shared honesty phrases catch what they should and allow honest wording (FD-07)', () => {
  const cases: { id: string; flagged: string[]; allowed: string[] }[] = [
    {
      id: 'nothing-was-scanned',
      flagged: [
        'Nothing was scanned.', 'Connecting is safe: nothing has been scanned yet.', 'Nothing is scanned until you press Check.', 'NOTHING WAS SCANNED',
        'Nothing had been scanned.', 'Nothing has yet been scanned.', 'Nothing will be scanned until you press Check.', 'Nothing\'s been scanned yet.', 'Nothing’s been scanned yet.', 'Nothing scanned.',
      ],
      allowed: [
        'No sessions were scanned. Folders and Git are still checked in the background.', 'Agent Town has not scanned any sessions.', 'A scan starts only when you ask.',
        'There was nothing to scan.', 'No scan has run yet.',
      ],
    },
    {
      id: 'handoff-state-claim',
      flagged: [
        'Task assigned.', 'The task was assigned to Claude Code.', 'Your hand-off has been started.', 'Hand-off started', 'Assigned to Codex', 'The prompt is now assigned.', 'Status: Started', 'Assigned', 'Packet started in your tool.',
        // active voice
        'Agent Town assigned the task to Claude Code.', 'We started your task.', 'Agent Town has started the hand-off.', 'Claude Code started the task.',
        'Agent Town is starting the packet.', 'It will run the prompt when you approve.', 'Agent Town launched a new task.', 'Codex has already started the second brief.',
        // a hand-off written as two words, and the object further from the verb
        'Hand off started', 'The hand off was assigned.', 'Agent Town assigned it to Claude Code.', 'Agent Town assigned the prepared task to Cursor.',
        // more label forms and tenses
        'State: Assigned', 'Started ✓', 'The task has now been assigned.', 'Your prompt was already started.', 'The hand-off is being started.',
        'The manager assigned each task.', 'Agent Town started 2 tasks.', 'Assigned.', 'Gemini started the task.',
      ],
      allowed: [
        'Agent Town does not assign or start a task.', 'Nothing is assigned or started until you run it yourself.', 'No task has started.', 'Connecting starts no agents or paid work.',
        'This does not mean the task was started.', 'Copy the text, then run it in your own tool.', 'Mark it "I ran it" once you have started it in your tool.',
        'A session started in Claude Code 3 minutes ago.', 'Assign a task', 'Assignment target',
        // honest negatives in other shapes, including a curly apostrophe
        'Agent Town never starts a hand-off for you.', 'Agent Town assigns nothing.', 'Agent Town starts no tasks.', 'We do not start your task.', 'You start the task in your own tool.',
        'Once you have started the task in your tool, mark it "I ran it".', 'No task was assigned, so nothing has started.', 'No tasks or hand-offs have started.',
        'Neither the task nor the hand-off has started.', 'Nothing is running, so no task has started.', 'It isn’t true that the task was started.', 'The task hasn’t started yet.',
        // observed facts about sessions are not hand-offs
        'Claude Code started a session 3 minutes ago.', 'Codex started a new session in this folder.', 'Started 3 minutes ago',
        // the wording the plan itself plans to use (CH-15, H0-05): these must never be flagged
        'Started (you marked it)', '3 hand-offs open', 'Copied (delivery unknown)', 'Drafted, Approved, Copied, I ran it, Report pasted.', 'Copilot CLI starts its own runtime.',
        'Agent Town is watching sessions you start in this folder with Claude Code and Codex. It does not start, run or assign anything.',
      ],
    },
    {
      id: 'installed-for-found-tool',
      flagged: [
        'Installed — no activity for this project yet', 'Installed: 3 sessions', 'Claude Code is installed.', 'Codex appears to be installed on this computer.', 'Cursor is already installed', 'Installed on this computer', 'The installed tools are listed below.',
        // label forms
        'Codex: installed', 'Codex - installed', 'Cursor: Installed', 'Copilot CLI (installed)', 'Claude Code – installed', 'Codex — installed', 'Status: Installed', 'Gemini CLI is installed.', 'Shown as installed.',
        'Installed.', 'Codex ✓ installed', 'Codex was found and installed.', 'Codex · installed',
      ],
      allowed: [
        'Settings folder found — no activity for this project yet', 'Not found on this machine', 'Connecting installs nothing.', 'No tool is installed by connecting.', 'Nothing is installed by connecting a project.',
        'Commands differ by installed version.', 'Hook applied by Agent Town.',
        'Codex: not installed', 'Copilot CLI (not installed)', 'Cursor: settings folder found', 'A settings folder does not mean the tool is installed.', 'We never mark a tool as installed.', 'Installed versions differ.',
      ],
    },
  ];

  it('has a self-test for every shared rule, so none can be added untested', () => {
    expect(cases.map(entry => entry.id).sort()).toEqual(SHARED_HONESTY_RULES.map(rule => rule.id).sort());
  });

  it('every shared pattern is global and case-insensitive, so matchAll works and "TASK ASSIGNED" is caught like "Task assigned"', () => {
    for (const rule of SHARED_HONESTY_RULES) for (const pattern of rule.patterns) {
      expect(pattern.flags, `${rule.id}: ${pattern.source}`).toContain('g');
      expect(pattern.flags, `${rule.id}: ${pattern.source}`).toContain('i');
    }
  });

  for (const { id, flagged, allowed } of cases) {
    const rule = SHARED_HONESTY_RULES.find(candidate => candidate.id === id)!;
    it(`${id}: flags each violating sentence`, () => {
      for (const text of flagged) expect(ruleHits(rule, text), `should flag: ${text}`).toBe(true);
    });
    it(`${id}: allows each honest sentence`, () => {
      for (const text of allowed) expect(ruleHits(rule, text), `should allow: ${text}`).toBe(false);
    });
  }

  describe('a negation only excuses a claim in its own clause (a dishonest clause after a comma, dash or "but" is still flagged)', () => {
    const breaks = [
      ', ', ' – ', ' — ', ' - ', ' -- ', '; ', ': ', '. ', '! ', ' | ', '… ', ' (',
      ', but ', ' but ', ', and ', ' and ', ' yet ', ' so ', ' then ', ' however ', ' although ', ' though ', ' while ', ' whereas ', ' instead ', ' because ', ' since ',
    ];
    const negations = ['No sessions yet', 'Nothing is running', 'Not connected', 'It isn’t watching anything', 'Never scanned'];
    const claims: Record<string, string[]> = {
      'handoff-state-claim': ['your task was assigned to Claude Code', 'the task has started', 'Agent Town started the task', 'the hand-off is now assigned'],
      'installed-for-found-tool': ['Codex is installed on this computer', 'Cursor: Installed', 'Claude Code is already installed', 'Copilot CLI (installed)'],
    };
    for (const [id, dishonest] of Object.entries(claims)) {
      const rule = SHARED_HONESTY_RULES.find(candidate => candidate.id === id)!;
      it(`${id}: flags "${dishonest[0]}" after every kind of clause break that follows a negation`, () => {
        for (const negation of negations) for (const split of breaks) for (const claim of dishonest) {
          const sentence = `${negation}${split}${claim}${split.endsWith('(') ? ')' : ''}.`;
          expect(ruleHits(rule, sentence), `should flag: ${sentence}`).toBe(true);
        }
      });
    }

    it('the reviewer\'s examples, word for word', () => {
      const handoff = SHARED_HONESTY_RULES.find(rule => rule.id === 'handoff-state-claim')!;
      const installed = SHARED_HONESTY_RULES.find(rule => rule.id === 'installed-for-found-tool')!;
      expect(ruleHits(handoff, 'No sessions yet, but your task was assigned to Claude Code.')).toBe(true);
      expect(ruleHits(handoff, 'Nothing is running, and the task has started.')).toBe(true);
      expect(ruleHits(installed, 'No activity yet, and Codex is installed on this computer.')).toBe(true);
    });

    it('a negation still excuses the claim it really governs, so honest wording is not flagged', () => {
      const handoff = SHARED_HONESTY_RULES.find(rule => rule.id === 'handoff-state-claim')!;
      const installed = SHARED_HONESTY_RULES.find(rule => rule.id === 'installed-for-found-tool')!;
      for (const honest of ['No task was assigned to Claude Code.', 'Nothing is assigned to Codex yet.', 'The task was never assigned to Claude Code.', 'Agent Town did not tell you that the task was started.', 'No tasks and no hand-offs have started.']) {
        expect(ruleHits(handoff, honest), `should allow: ${honest}`).toBe(false);
      }
      for (const honest of ['No tool is installed by connecting.', 'We cannot say the tool is installed.', 'Not every folder means the tool is installed.', 'Never assume Codex is installed.']) {
        expect(ruleHits(installed, honest), `should allow: ${honest}`).toBe(false);
      }
    });

    it('a negation in an earlier sentence, or after the claim, excuses nothing', () => {
      const handoff = SHARED_HONESTY_RULES.find(rule => rule.id === 'handoff-state-claim')!;
      expect(ruleHits(handoff, 'Nothing is running.\nThe task was assigned to Claude Code.')).toBe(true);
      expect(ruleHits(handoff, 'The task was assigned to Claude Code, not to Codex.')).toBe(true);
    });
  });

  it('applies a module\'s own banned words case-insensitively as substrings, plus the shared rules', () => {
    expect(violationsIn('Your Skills are ready', ['skill'])).toEqual(['banned word "skill"']);
    expect(violationsIn('Nothing was scanned', ['skill'])).toHaveLength(1);
    expect(violationsIn('Connecting starts no agents or paid work.', ['skill', 'upload'])).toEqual([]);
  });
});

describe('FD-07 mutation checks: the registry fails when a module is missing, malformed or dishonest', () => {
  const honest = (overrides: Record<string, unknown> = {}): CopyModule => ({
    HEADING: 'Connect a project.',
    greeting: (formal: boolean) => (formal ? 'Welcome.' : 'Hi.'),
    helper: () => 42,
    [REGISTRATION_EXPORT]: { bannedWords: ['upload'], textFunctions: { greeting: () => ['Welcome.', 'Hi.'] }, nonTextFunctions: ['helper'] },
    ...overrides,
  });
  const audit = (file: string, module: CopyModule) => auditCopyModules([{ file, module }]);

  it('a fully registered, honest module passes and reports how many strings it scanned', () => {
    const result = audit('apps/web/src/okCopy.ts', honest());
    expect(result).toEqual({ problems: [], violations: [], scanned: { 'apps/web/src/okCopy.ts': 3 }, texts: { 'apps/web/src/okCopy.ts': ['Connect a project.', 'Welcome.', 'Hi.'] } });
  });

  it('a new *Copy.ts with no registration fails and names the file', () => {
    const { problems } = audit('apps/web/src/houseCopy.ts', { HEADING: 'Anything.' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('apps/web/src/houseCopy.ts');
    expect(problems[0]).toContain(REGISTRATION_EXPORT);
  });

  it('a malformed registration fails: empty, duplicate or too-short banned words, missing lists', () => {
    const bad = (registration: unknown) => audit('apps/web/src/badCopy.ts', { [REGISTRATION_EXPORT]: registration }).problems;
    expect(bad({ bannedWords: [], textFunctions: {}, nonTextFunctions: [] })).toHaveLength(1);
    expect(bad({ bannedWords: ['upload', 'UPLOAD'], textFunctions: {}, nonTextFunctions: [] })).toEqual([expect.stringContaining('listed twice')]);
    expect(bad({ bannedWords: ['ab'], textFunctions: {}, nonTextFunctions: [] })).toEqual([expect.stringContaining('shorter than 3')]);
    expect(bad({ bannedWords: ['upload'], nonTextFunctions: [] })).toEqual([expect.stringContaining('textFunctions')]);
    expect(bad({ bannedWords: ['upload'], textFunctions: {} })).toEqual([expect.stringContaining('nonTextFunctions')]);
    expect(bad('not an object')).toEqual([expect.stringContaining(REGISTRATION_EXPORT)]);
  });

  it('an exported function that is in neither list fails, so new text-producing code cannot go unscanned', () => {
    const { problems } = audit('apps/web/src/newFunctionCopy.ts', honest({ newSentence: () => 'Anything.' }));
    expect(problems).toEqual([expect.stringContaining('exported function newSentence is not classified')]);
  });

  it('a name listed in the registration that is not an exported function fails (a rename or removal is caught)', () => {
    const registration = { bannedWords: ['upload'], textFunctions: { renamedAway: () => ['Text.'] }, nonTextFunctions: [] };
    const { problems } = audit('apps/web/src/staleCopy.ts', { [REGISTRATION_EXPORT]: registration });
    expect(problems).toEqual([expect.stringContaining('renamedAway')]);
  });

  it('a function nested inside an exported object fails instead of hiding text from the scan', () => {
    const { problems } = audit('apps/web/src/nestedCopy.ts', honest({ LABELS: { ready: () => 'Ready.' } }));
    expect(problems).toEqual([expect.stringContaining('LABELS.ready is a function inside an exported value')]);
  });

  it('a Map, a Set or a class instance holding text fails instead of hiding it from the scan (a scan of a Map export used to pass silently)', () => {
    class Labels { constructor(readonly ready = 'Nothing was scanned.') {} }
    const cases: [string, unknown, string][] = [
      ['a Map', new Map([['ready', 'Nothing was scanned.']]), 'LABELS is a Map'],
      ['a Set', new Set(['Nothing was scanned.']), 'LABELS is a Set'],
      ['a class instance', new Labels(), 'LABELS is an instance of Labels'],
      ['a Map nested in an object', { deep: new Map([['ready', 'Nothing was scanned.']]) }, 'LABELS.deep is a Map'],
      ['a Set nested in an array', [new Set(['Nothing was scanned.'])], 'LABELS[0] is a Set'],
    ];
    for (const [label, value, expected] of cases) {
      const { problems } = audit('apps/web/src/collectionCopy.ts', honest({ LABELS: value }));
      expect(problems, label).toEqual([expect.stringContaining(expected)]);
    }
    // A pattern or a date holds no UI text, so it is not in the way.
    expect(audit('apps/web/src/patternCopy.ts', honest({ PATTERN: /^[a-z]+$/, SINCE: new Date(0) })).problems).toEqual([]);
  });

  it('a text function that returns nothing, or throws, fails', () => {
    const empty = { bannedWords: ['upload'], textFunctions: { greeting: () => [] }, nonTextFunctions: [] };
    expect(audit('apps/web/src/emptyCopy.ts', { greeting: () => 'Hi.', [REGISTRATION_EXPORT]: empty }).problems).toEqual([expect.stringContaining('non-empty list')]);
    const throws = { bannedWords: ['upload'], textFunctions: { greeting: () => { throw new Error('boom'); } }, nonTextFunctions: [] };
    expect(audit('apps/web/src/throwsCopy.ts', { greeting: () => 'Hi.', [REGISTRATION_EXPORT]: throws }).problems).toEqual([expect.stringContaining('threw boom')]);
  });

  it('a module\'s own banned word in a plain string, an array, a nested object or a function result is reported with the file', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['plain string', { NOTE: 'Files never upload anywhere.' }],
      ['array', { LINES: ['Fine.', 'We upload nothing?'] }],
      ['nested object', { LABELS: { deep: { text: 'No upload.' } } }],
    ];
    for (const [label, extra] of cases) {
      const { violations } = audit('apps/web/src/leakCopy.ts', honest(extra));
      expect(violations, label).toHaveLength(1);
      expect(violations[0], label).toContain('apps/web/src/leakCopy.ts');
      expect(violations[0], label).toContain('banned word "upload"');
    }
    const fromFunction = honest({ [REGISTRATION_EXPORT]: { bannedWords: ['upload'], textFunctions: { greeting: () => ['Hi.', 'Ready to upload.'] }, nonTextFunctions: ['helper'] } });
    expect(audit('apps/web/src/leakCopy.ts', fromFunction).violations).toEqual([expect.stringContaining('banned word "upload"')]);
  });

  it('the shared honesty phrases apply to a module whose own list does not mention them', () => {
    const { violations } = audit('apps/web/src/sharedCopy.ts', honest({ NOTE: 'Nothing was scanned.' }));
    expect(violations).toEqual([expect.stringContaining('shared rule nothing-was-scanned')]);
    expect(audit('apps/web/src/sharedCopy.ts', honest({ STATE: 'Task assigned' })).violations).toEqual([expect.stringContaining('shared rule handoff-state-claim')]);
    expect(audit('apps/web/src/sharedCopy.ts', honest({ ROW: 'Installed — no activity yet' })).violations).toEqual([expect.stringContaining('shared rule installed-for-found-tool')]);
  });

  it('a dishonest clause after a negation is reported for a whole module, not just by the matcher', () => {
    const module = honest({ NOTES: ['No sessions yet, but your task was assigned to Claude Code.', 'Nothing is running - Agent Town started the task.', 'No activity yet, and Codex is installed on this computer.'] });
    const { violations } = audit('apps/web/src/clauseCopy.ts', module);
    expect(violations).toEqual([
      expect.stringContaining('shared rule handoff-state-claim'),
      expect.stringContaining('shared rule handoff-state-claim'),
      expect.stringContaining('shared rule installed-for-found-tool'),
    ]);
  });

  it('one module\'s banned words are not applied to another module', () => {
    const skills = honest({ NOTE: 'Pick a skill.', [REGISTRATION_EXPORT]: { bannedWords: ['analyse'], textFunctions: { greeting: () => ['Hi.'] }, nonTextFunctions: ['helper'] } });
    const firstRun = honest({ NOTE: 'Pick a skill.' });
    const result = auditCopyModules([{ file: 'apps/web/src/skillsCopy.ts', module: skills }, { file: 'apps/web/src/firstRunLikeCopy.ts', module: firstRun }]);
    expect(result.violations).toEqual([]);
    const banned = honest({ NOTE: 'Pick a skill.', [REGISTRATION_EXPORT]: { bannedWords: ['skill'], textFunctions: { greeting: () => ['Hi.'] }, nonTextFunctions: ['helper'] } });
    expect(audit('apps/web/src/firstRunLikeCopy.ts', banned).violations).toEqual([expect.stringContaining('banned word "skill"')]);
  });

  it('the registration and the module\'s own banned-word array are never scanned as copy', () => {
    const words = ['upload', 'context'];
    const module = { NOTE: 'Fine.', BANNED: words, [REGISTRATION_EXPORT]: { bannedWords: words, textFunctions: {}, nonTextFunctions: [] } };
    expect(audit('apps/web/src/selfCopy.ts', module)).toEqual({ problems: [], violations: [], scanned: { 'apps/web/src/selfCopy.ts': 1 }, texts: { 'apps/web/src/selfCopy.ts': ['Fine.'] } });
  });

  it('a COPY of the banned-word list is not scanned as copy either, whichever side holds the copy (it used to fail with "banned word upload in upload")', () => {
    const words = ['upload', 'context'];
    const registeredCopy = { NOTE: 'Fine.', BANNED: words, [REGISTRATION_EXPORT]: { bannedWords: [...words], textFunctions: {}, nonTextFunctions: [] } };
    const exportedCopy = { NOTE: 'Fine.', BANNED: [...words].reverse(), [REGISTRATION_EXPORT]: { bannedWords: words, textFunctions: {}, nonTextFunctions: [] } };
    for (const module of [registeredCopy, exportedCopy]) {
      expect(audit('apps/web/src/copiedListCopy.ts', module)).toEqual({ problems: [], violations: [], scanned: { 'apps/web/src/copiedListCopy.ts': 1 }, texts: { 'apps/web/src/copiedListCopy.ts': ['Fine.'] } });
    }
  });

  it('a different banned-word list is still scanned, and the failure says what it probably is', () => {
    const module = { NOTE: 'Fine.', OTHER_WORDS: ['upload', 'context', 'extra'], [REGISTRATION_EXPORT]: { bannedWords: ['upload', 'context'], textFunctions: {}, nonTextFunctions: [] } };
    const { violations } = audit('apps/web/src/otherListCopy.ts', module);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('banned word "upload" in "upload"');
    expect(violations[0]).toContain('exactly a banned word');
    expect(violations[0]).toContain(`${REGISTRATION_EXPORT}.bannedWords`);
    // Copy that merely contains a banned word gets no hint: it is an ordinary violation.
    expect(audit('apps/web/src/plainCopy.ts', honest({ NOTE: 'Files never upload anywhere.' })).violations[0]).not.toContain('exactly a banned word');
  });
});
