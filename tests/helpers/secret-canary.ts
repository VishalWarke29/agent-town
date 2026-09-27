/**
 * secretCanary(): a random, obviously fake secret that a test plants where a real credential would be (an environment
 * variable, a saved credential, an API-key argument, a file the service reads), then looks for everywhere it must never
 * appear: model input, saved state, API responses, log lines, exports, files written to a folder, recorded process arguments.
 * The project rule is that raw credentials, sensitive headers and URL secrets stay out of monitoring, logs, exports and model
 * inputs; a canary turns that rule into an assertion that fails on the day something starts leaking.
 *
 * find() searches strings, nested objects and arrays, Maps, Sets, Errors (message, stack, cause), Buffers and typed arrays,
 * and matches the canary in its plain form and its base64, base64url, hex and URL-encoded forms. Base64 and base64url are
 * matched at all three byte alignments, so the canary is found inside a longer encoded string whatever precedes it: an HTTP
 * Basic 'Authorization' value (base64 of 'user:' + secret), a JSON blob, a token with a prefix. It reports WHERE it was found,
 * never the value itself, so a failing run does not print the canary into the report either.
 *
 * Not searched: getter-only (accessor) properties, which are never called because a getter can have side effects, and #private
 * class fields, which no code outside the class can read. Other encodings (UTF-16, gzip, encryption, a secret split across two
 * fields) are out of sight too. A test that needs those hands the decoded or joined text to find().
 *
 * Limits are the ones in ./index.ts: it can only look at what the test hands it (or captures from this process's console).
 * A leak inside a child tool, a worker thread or the e2e service is out of its sight.
 */
import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';

export type CanaryKind = 'api-key' | 'github-token' | 'generic';

export interface CanaryHit {
  /** Where it was found, e.g. "$.headers.authorization" or "file:logs/service.log". */
  where: string;
  /** Which spelling matched: 'plain', 'base64', 'base64url', 'hex' or 'url-encoded'. */
  form: string;
}

export interface SecretCanary {
  /** The fake secret. Plant it; never assert on it directly in a message. */
  readonly value: string;
  /** Every spelling that counts as a leak. */
  readonly forms: readonly { name: string; text: string }[];
  find(subject: unknown, label?: string): CanaryHit[];
  /** Throws (naming where, never printing the value) when the canary is found in `subject`. */
  expectAbsent(subject: unknown, label?: string): void;
  /** Throws when any file under `directory` (recursively, first 5 MB of each, at most 2000 files) holds the canary. */
  expectAbsentFromFiles(directory: string): Promise<void>;
  /** Sets process.env[name] to the canary; restore() puts the old value back. */
  plantEnv(name: string): void;
  /** Captures console.log/info/warn/error/debug output until stop(); output() is what was written. */
  watchConsole(): { output(): string[]; stop(): void };
  /** Undoes plantEnv() and watchConsole(). Safe to call more than once. */
  restore(): void;
}

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function token(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let index = 0; index < length; index++) out += ALPHANUMERIC[bytes[index] % ALPHANUMERIC.length];
  return out;
}

function makeValue(kind: CanaryKind): string {
  if (kind === 'api-key') return `sk-canary-${token(32)}`;
  if (kind === 'github-token') return `ghp_${token(36)}`;
  return `canary-${randomBytes(16).toString('hex')}`;
}

/**
 * The base64 text a value leaves inside a longer base64 string, whatever comes before and after it. Base64 encodes three bytes
 * at a time, so the same secret spells differently depending on its byte offset modulo 3 (an HTTP Basic header is
 * base64('user:' + secret): five bytes in, offset 2). Each of the three offsets is encoded with 0, 1 or 2 filler bytes in
 * front, then the characters that still hold filler bits (2 or 3 at the start) and the last character when the value does not
 * end on a 3-byte boundary (it shares bits with whatever follows) are dropped, leaving only characters no neighbour can change.
 */
function base64Spellings(buffer: Buffer): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const encoding of ['base64', 'base64url'] as const) {
    for (const shift of [0, 1, 2]) {
      const encoded = Buffer.concat([Buffer.alloc(shift), buffer]).toString(encoding).replace(/=+$/, '');
      const dropAtStart = [0, 2, 3][shift]!, dropAtEnd = (shift + buffer.length) % 3 === 0 ? 0 : 1;
      out.push({ name: encoding, text: encoded.slice(dropAtStart, encoded.length - dropAtEnd) });
    }
  }
  return out;
}

function spellings(value: string): { name: string; text: string }[] {
  const buffer = Buffer.from(value, 'utf8');
  const all = [
    { name: 'plain', text: value },
    ...base64Spellings(buffer),
    { name: 'hex', text: buffer.toString('hex') },
    { name: 'url-encoded', text: encodeURIComponent(value) },
  ];
  const seen = new Set<string>();
  return all.filter(form => !seen.has(form.text) && seen.add(form.text));
}

const MAX_DEPTH = 24;

export function secretCanary(kind: CanaryKind = 'api-key'): SecretCanary {
  const value = makeValue(kind);
  const forms = spellings(value);
  const planted = new Map<string, string | undefined>();
  const watchers: (() => void)[] = [];

  // One hit per place: the first spelling that matches (plain first), so base64 and base64url of the same text are not reported twice.
  const scanText = (text: string, where: string, hits: CanaryHit[]) => {
    const form = forms.find(candidate => text.includes(candidate.text));
    if (form) hits.push({ where, form: form.name });
  };
  const walk = (subject: unknown, where: string, hits: CanaryHit[], seen: WeakSet<object>, depth: number): void => {
    if (typeof subject === 'string') return scanText(subject, where, hits);
    if (subject === null || typeof subject !== 'object') return;
    if (seen.has(subject) || depth > MAX_DEPTH) return;
    seen.add(subject);
    if (ArrayBuffer.isView(subject)) {
      const bytes = Buffer.from(subject.buffer, subject.byteOffset, subject.byteLength);
      return scanText(bytes.toString('latin1'), where, hits);
    }
    if (subject instanceof Error) {
      scanText(subject.message, `${where}.message`, hits);
      if (subject.stack) scanText(subject.stack, `${where}.stack`, hits);
      if ('cause' in subject) walk((subject as { cause?: unknown }).cause, `${where}.cause`, hits, seen, depth + 1);
    }
    if (subject instanceof Map) {
      let index = 0;
      for (const [key, item] of subject) { walk(key, `${where}<key ${index}>`, hits, seen, depth + 1); walk(item, `${where}<value ${index}>`, hits, seen, depth + 1); index++; }
      return;
    }
    if (subject instanceof Set) { let index = 0; for (const item of subject) walk(item, `${where}<item ${index++}>`, hits, seen, depth + 1); return; }
    if (subject instanceof Date) return;
    for (const key of Reflect.ownKeys(subject)) {
      if (typeof key === 'string') scanText(key, `${where}<key>`, hits);
      const descriptor = Object.getOwnPropertyDescriptor(subject, key);
      if (descriptor && 'value' in descriptor) walk(descriptor.value, typeof key === 'string' ? `${where}.${key}` : `${where}[symbol]`, hits, seen, depth + 1);
    }
  };
  const find = (subject: unknown, label = '$'): CanaryHit[] => {
    const hits: CanaryHit[] = [];
    walk(subject, label, hits, new WeakSet(), 0);
    const seenHits = new Set<string>();
    return hits.filter(hit => { const id = `${hit.where}\u0000${hit.form}`; return !seenHits.has(id) && !!seenHits.add(id); });
  };
  const describeHits = (hits: CanaryHit[]) => hits.map(hit => `${hit.where} (${hit.form})`).join('; ');

  const scanDirectory = async (directory: string, root: string, hits: CanaryHit[], budget: { files: number }): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (budget.files <= 0) return;
      const path = join(directory, entry.name);
      const relative = path.slice(root.length + 1).split('\\').join('/');
      scanText(entry.name, `file-name:${relative}`, hits);
      if (entry.isDirectory()) await scanDirectory(path, root, hits, budget);
      else if (entry.isFile()) {
        budget.files--;
        const size = (await stat(path)).size;
        if (size === 0) continue;
        const bytes = await readFile(path);
        scanText(bytes.subarray(0, 5 * 1024 * 1024).toString('latin1'), `file:${relative}`, hits);
      }
    }
  };

  const canary: SecretCanary = {
    value,
    forms,
    find,
    expectAbsent(subject, label = '$') {
      const hits = find(subject, label);
      if (hits.length) throw new Error(`A planted secret canary leaked into ${describeHits(hits)}. The canary value is deliberately not printed.`);
    },
    async expectAbsentFromFiles(directory) {
      const hits: CanaryHit[] = [];
      await scanDirectory(directory, directory, hits, { files: 2000 });
      if (hits.length) throw new Error(`A planted secret canary leaked into ${describeHits(hits)}. The canary value is deliberately not printed.`);
    },
    plantEnv(name) {
      if (!planted.has(name)) planted.set(name, process.env[name]);
      process.env[name] = value;
    },
    watchConsole() {
      const lines: string[] = [];
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(arg => typeof arg === 'string' ? arg : (() => { try { return JSON.stringify(arg); } catch { return String(arg); } })()).join(' '));
      }));
      const stop = () => { for (const spy of spies) spy.mockRestore(); };
      watchers.push(stop);
      return { output: () => [...lines], stop };
    },
    restore() {
      for (const [name, previous] of planted) { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
      planted.clear();
      for (const stop of watchers.splice(0)) stop();
    },
  };
  return canary;
}
