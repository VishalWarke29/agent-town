// Shared helpers for the folder-picker spike: builds the exact process the service will spawn.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));

function minifyNative(nativeOnly) {
  let text = readFileSync(join(here, 'fp-native.cs'), 'utf8');
  if (nativeOnly) text = `${text.split('// @@dialog')[0]}}\n`;
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('//')).join('\n');
}

/** Reads a candidate script and replaces the "#@include fp-native.cs [native]" marker (spike candidates only). */
export function loadScript(file) {
  return readFileSync(file, 'utf8').replace(/^#@include fp-native\.cs( native)?[ \t]*\r?$/m, (_m, native) => minifyNative(Boolean(native)));
}

export function encodeCommand(text) { return Buffer.from(text, 'utf16le').toString('base64'); }

export function powershellPath(kind = 'ps51') {
  if (kind === 'pwsh') return join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe');
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The service's spawn shape (identity/vault.ts pattern): absolute path, static encoded script, hidden window, no stdin,
 * minimal environment. Extra env entries are the helper's documented inputs. */
export function spawnHelper(text, extraEnv = {}, kind = 'ps51') {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodeCommand(text)];
  const env = { SystemRoot: systemRoot, WINDIR: systemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP, ...extraEnv };
  const child = spawn(powershellPath(kind), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  return { child, encodedLength: args[5].length, commandLineLength: powershellPath(kind).length + 2 + args.join(' ').length };
}
