/**
 * spawnSpy(): records every process a test starts through node:child_process, by executable, and refuses the ones that are
 * not on its allow list. Only git is allowed by default: reading a repository is what discovery is for, while a tool
 * launcher (claude, codex, cursor, copilot, code), node, PowerShell and the like are refused before they start. A flow that
 * must "start no tool" is proved by launchesOf('claude', 'codex', ...) being empty, and one that must stay read-only by
 * reading the recorded git arguments.
 *
 * Covers spawn, spawnSync, exec, execSync, execFile, execFileSync and fork, including promisify(exec/execFile) called AFTER
 * the spy is installed. Code that copied a function reference before spawnSpy() ran (const run = promisify(execFile) at the
 * top of a file) keeps the original and is not seen: create the spy in beforeEach and build such helpers lazily.
 *
 * Every executable in a shell command line is judged, not only the first. exec/execSync and any launch with shell: true run a
 * command line, so 'git --version && codex login' is recorded as git AND codex and refused because codex is not allowed
 * (launch.executables lists them all, launchesOf('codex') finds it, launch.refused names the ones that were not allowed). The
 * line is split at &&, ||, |, a lone &, a new line, ; (POSIX shells only: in cmd.exe a ; is just a word separator), $( ... )
 * and `...` substitutions (backticks on POSIX only) and ( ... ) groups. Quotes are honoured the way the shell that will run it
 * honours them (cmd.exe on Windows: no single quotes, ^ escapes; a POSIX shell elsewhere: single quotes, backslash escapes),
 * and the command after cmd /c or /k, or after sh, bash, zsh, dash or ksh -c (also -lc and the like), is read the same way.
 * Not read: PowerShell (pwsh, powershell: its script language is not a command line, so allowing powershell allows whatever
 * script it is given, and the launch is judged as 'powershell' only), a command hidden in a variable or alias
 * (exec(`${tool} --version`) is judged by the text it was given), a script file the shell runs, here-documents, and wrappers
 * such as env, sudo or start (each is judged as itself, so it is refused unless allowed).
 *
 * A refused launch throws SpawnBlockedError synchronously and is still recorded, so a flow that swallows the error still
 * shows up in launches. Limits are the ones in ./index.ts: this sees launches made from this test process, not what a
 * launched process does, and not worker threads or the e2e service.
 */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

export type LaunchVia = 'spawn' | 'spawnSync' | 'exec' | 'execSync' | 'execFile' | 'execFileSync' | 'fork';

export interface Launch {
  /** Lower-case name of the first executable, without folder or .exe/.cmd/.bat/.com, e.g. 'git', 'codex', 'node'. */
  executable: string;
  /** Every executable the launch runs, in order and without repeats: more than one for a chained shell command line. */
  executables: string[];
  /** The command as written (a full command line for exec/execSync and shell launches). */
  command: string;
  args: string[];
  cwd: string | null;
  via: LaunchVia;
  /** True only when every executable is on the allow list. */
  allowed: boolean;
  /** The executables that were not on the allow list (empty when allowed). */
  refused: string[];
}

export class SpawnBlockedError extends Error {
  readonly launch: Launch;
  constructor(launch: Launch) {
    super(`Blocked launch of ${launch.refused.map(name => `'${name}'`).join(', ')} (${launch.via}). Only the executables on the spawnSpy allow list (git by default) may start in this test; pass allow: [...] to spawnSpy() if this launch is intended.`);
    this.name = 'SpawnBlockedError';
    this.launch = launch;
  }
}

export interface SpawnSpy {
  readonly launches: readonly Launch[];
  /** Refused launches only. */
  readonly blocked: readonly Launch[];
  /** Launches that ran any of the named executables (case-insensitive, no extension), including one chained after another in a command line. */
  launchesOf(...executables: string[]): Launch[];
  count(): number;
  /** Throws when anything at all was launched, allowed or not. */
  expectNone(): void;
  /** Throws when any launch ran an executable that is not one of these. */
  expectOnly(...executables: string[]): void;
  /** Puts the real functions back. Restore spies in the reverse order they were created. */
  restore(): void;
}

const NAMES = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
type AnyFunction = (...args: unknown[]) => unknown;
const module_ = childProcess as unknown as Record<string, AnyFunction>;

export function executableName(command: string): string {
  const leaf = command.split(/[\\/]/).pop() ?? command;
  return leaf.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

/** Shells whose /c or -c argument is itself a command line of the same kind (PowerShell's -Command is a script, not a command line, so it is left out on purpose). */
const SHELLS = new Set(['cmd', 'sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHELL_COMMAND_FLAG = /^(?:\/[ckr]|-[a-z]*c)$/i;

/** Index of the ')' that closes the '(' at `open`, counting nested pairs; the end of the line when it is never closed. */
function closingParenthesis(line: string, open: number): number {
  let depth = 0;
  for (let index = open; index < line.length; index++) {
    if (line[index] === '(') depth++;
    else if (line[index] === ')' && --depth === 0) return index;
  }
  return line.length;
}

/** Splits a shell command line into simple commands (each a list of unquoted words) plus the bodies of $(...) and `...` found inside it. */
function scanCommandLine(line: string, windows: boolean): { commands: string[][]; nested: string[] } {
  const commands: string[][] = [], nested: string[] = [];
  let words: string[] = [], word = '', inWord = false, quote: '"' | "'" | null = null, groups = 0;
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!, next = line[index + 1];
    if (quote === "'") { if (char === "'") quote = null; else word += char; continue; }
    // POSIX: a backslash escapes the next character (inside double quotes only $ ` " and \, so a Windows path stays a path).
    if (!windows && char === '\\' && next !== undefined && (quote === null || '"\\$`'.includes(next))) { word += next; inWord = true; index++; continue; }
    if (windows && char === '^' && quote === null && next !== undefined) { word += next; inWord = true; index++; continue; }
    if (char === '$' && next === '(') {
      const end = closingParenthesis(line, index + 1);
      nested.push(line.slice(index + 2, end)); index = end; inWord = true; continue;
    }
    if (char === '`' && !windows) {
      const end = line.indexOf('`', index + 1);
      nested.push(line.slice(index + 1, end === -1 ? undefined : end)); index = end === -1 ? line.length : end; inWord = true; continue;
    }
    if (quote === '"') { if (char === '"') quote = null; else word += char; continue; }
    if (char === '"') { quote = '"'; inWord = true; continue; }
    if (char === "'" && !windows) { quote = "'"; inWord = true; continue; }
    if (char === '\n' || char === '\r' || char === '|' || (char === ';' && !windows)) { endCommand(); continue; }
    if (char === '&') {
      // 2>&1, >&2 and &>file are redirections, not a second command.
      if (word.endsWith('>') || word.endsWith('<') || next === '>') { word += char; inWord = true; continue; }
      endCommand(); continue;
    }
    if (char === '(' && !inWord && !words.length) { groups++; continue; } // (git status; git log): a group; a ( inside a word, as in --format=%(refname), is text
    if (char === ')' && groups > 0) { groups--; endCommand(); continue; }
    if (char === ' ' || char === '\t') { endWord(); continue; }
    word += char; inWord = true;
  }
  endCommand();
  return { commands, nested };
}

/** The executables of one simple command: its first word (after any leading VAR=value on POSIX) and, for a shell, what it is told to run. */
function executablesOfWords(words: readonly string[], windows: boolean, shellSyntax = true): string[] {
  let start = 0;
  if (shellSyntax && !windows) while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!)) start++;
  const first = words[start];
  if (first === undefined) return [];
  const name = executableName(first);
  const found = [name];
  if (SHELLS.has(name)) {
    const flag = words.findIndex((word, position) => position > start && SHELL_COMMAND_FLAG.test(word));
    const inner = flag < 0 ? undefined : words[flag + 1];
    // The command a shell is handed is written in THAT shell's syntax, whatever shell started it: cmd's rules for cmd, POSIX rules for sh and the rest.
    if (inner !== undefined) found.push(...executablesOfLine(inner, name === 'cmd'));
  }
  return found;
}

function executablesOfLine(line: string, windows: boolean): string[] {
  const { commands, nested } = scanCommandLine(line, windows);
  return [...commands.flatMap(words => executablesOfWords(words, windows)), ...nested.flatMap(body => executablesOfLine(body, windows))];
}

/**
 * Every executable a shell command line would run, in order and without repeats: 'git --version && echo x' gives ['git', 'echo'].
 * `platform` picks the shell's quoting rules (win32 is cmd.exe, anything else a POSIX shell); it defaults to this machine's.
 */
export function commandLineExecutables(commandLine: string, platform: NodeJS.Platform = process.platform): string[] {
  return [...new Set(executablesOfLine(commandLine, platform === 'win32'))];
}

function describeLaunch(via: LaunchVia, args: readonly unknown[], allow: ReadonlySet<string>): Launch {
  const first = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].pathname : '';
  const list = via === 'exec' || via === 'execSync' ? null : Array.isArray(args[1]) ? args[1].map(String) : [];
  const options = (via === 'exec' || via === 'execSync' ? args[1] : Array.isArray(args[1]) ? args[2] : args[1]) as { cwd?: unknown; shell?: unknown } | undefined;
  const cwd = options && typeof options === 'object' && typeof options.cwd === 'string' ? options.cwd : null;
  const windows = process.platform === 'win32';
  let command = first, argv = list ?? [];
  let executables: string[];
  if (via === 'fork') {
    command = process.execPath; argv = [first, ...argv];
    executables = [executableName(command)];
  } else if (list === null || (options && typeof options === 'object' && options.shell)) {
    // A shell runs this: with shell: true Node joins the command and its arguments into one command line.
    executables = commandLineExecutables(list === null ? first : [first, ...list].join(' '));
  } else {
    executables = [...new Set(executablesOfWords([first, ...list], windows, false))]; // no shell parses this one, so no VAR=value prefix
  }
  if (!executables.length) executables = [executableName(first)]; // an empty command is judged as the empty name, so it is refused
  const refused = executables.filter(name => !allow.has(name));
  return { executable: executables[0]!, executables, command: first, args: argv, cwd, via, allowed: refused.length === 0, refused };
}

const label = (launch: Launch) => `${launch.executables.join(' + ')} (${launch.via})`;

export function spawnSpy(options: { allow?: readonly string[] } = {}): SpawnSpy {
  const allow = new Set((options.allow ?? ['git']).map(name => executableName(name)));
  const launches: Launch[] = [];
  const originals = new Map<string, AnyFunction>();
  const wrappers = new Map<string, AnyFunction>();
  let active = true;

  const check = (via: LaunchVia, args: readonly unknown[]) => {
    if (!active) return;
    const launch = describeLaunch(via, args, allow);
    launches.push(launch);
    if (!launch.allowed) throw new SpawnBlockedError(launch);
  };

  for (const name of NAMES) {
    const original = module_[name];
    originals.set(name, original);
    const wrapper = function guardedLaunch(this: unknown, ...args: unknown[]) { check(name, args); return original.apply(this, args); };
    // promisify(exec) and promisify(execFile) resolve { stdout, stderr } through a custom hook that would otherwise bypass this wrapper.
    const custom = (original as unknown as Record<symbol, AnyFunction | undefined>)[promisify.custom];
    if (custom) Object.defineProperty(wrapper, promisify.custom, { value: function guardedCustom(this: unknown, ...args: unknown[]) { check(name, args); return custom.apply(this, args); }, configurable: true });
    wrappers.set(name, wrapper);
    module_[name] = wrapper;
  }
  syncBuiltinESMExports();

  return {
    get launches() { return [...launches]; },
    get blocked() { return launches.filter(launch => !launch.allowed); },
    launchesOf: (...executables) => { const wanted = new Set(executables.map(executableName)); return launches.filter(launch => launch.executables.some(name => wanted.has(name))); },
    count: () => launches.length,
    expectNone: () => {
      if (launches.length) throw new Error(`Expected no process launch, but ${launches.length} happened: ${launches.map(label).join(', ')}`);
    },
    expectOnly: (...executables) => {
      const wanted = new Set(executables.map(executableName));
      const extra = launches.filter(launch => launch.executables.some(name => !wanted.has(name)));
      if (extra.length) throw new Error(`Expected launches of ${[...wanted].join(', ') || 'nothing'} only, but also saw: ${extra.map(label).join(', ')}`);
    },
    restore: () => {
      active = false;
      // If a spy created later is still in front of this one, leave the (now inert) wrapper in the chain instead of cutting that spy out.
      for (const name of NAMES) if (module_[name] === wrappers.get(name)) module_[name] = originals.get(name)!;
      syncBuiltinESMExports();
    },
  };
}
