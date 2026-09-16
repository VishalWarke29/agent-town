import { lstatSync, realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** Normalize a local path without interpreting UNC/device paths or traversal. */
export function normalizeObservationPath(value: string): string | null {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  let path = value;
  if (/^\\\\\?\\[a-z]:[\\/]/i.test(path)) path = path.slice(4);
  if (/^[\\/]{2}/.test(path) || /^[\\/]\?/.test(path)) return null;
  if (/^[a-z]:[\\/]/i.test(path)) {
    if (path.slice(2).includes(':')) return null;
    const parts = path.slice(3).split(/[\\/]/).filter(Boolean);
    if (parts.some(part => part === '.' || part === '..' || /[. ]$/.test(part) || /[<>"|?*]/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
    return win32.normalize(path);
  }
  if (process.platform === 'win32' || !path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '.' || part === '..')) return null;
  return posix.normalize(path);
}

function pathApi(path: string) { return /^[a-z]:/i.test(path) ? win32 : posix; }
function key(path: string) { return /^[a-z]:/i.test(path) ? path.toLowerCase() : path; }

export function sameObservationPath(left: string, right: string): boolean {
  const a = normalizeObservationPath(left), b = normalizeObservationPath(right);
  return a !== null && b !== null && key(a) === key(b);
}

/** Scope comparison only. Call checkedPath before opening a file or directory. */
export function observationPathWithin(root: string, candidate: string): boolean {
  const a = normalizeObservationPath(root), b = normalizeObservationPath(candidate);
  if (!a || !b || pathApi(a) !== pathApi(b)) return false;
  const api = pathApi(a), remainder = api.relative(key(a), key(b));
  return remainder === '' || (!api.isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${api.sep}`));
}

/** Hook input is metadata; reject existing linked components without opening content. */
export function safeHookProjectPath(root: string, candidate: string): boolean {
  const a = normalizeObservationPath(root), b = normalizeObservationPath(candidate);
  if (!a || !b || !observationPathWithin(a, b)) return false;
  // A recorded cwd may no longer exist. Preserve lexical validation in that case,
  // but inspect every existing ancestor so a missing leaf cannot hide a junction.
  if ((process.platform === 'win32') !== (pathApi(b) === win32)) return true;
  const api = pathApi(b);
  let current = api.parse(b).root;
  for (const part of api.relative(current, b).split(api.sep).filter(Boolean)) {
    current = api.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
      const canonical = normalizeObservationPath(realpathSync.native(current));
      if (!canonical || !sameObservationPath(current, canonical)) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      return false;
    }
  }
  return true;
}

export function reportedRelativePath(root: string, file: string): string | null {
  const normalizedRoot = normalizeObservationPath(root), normalizedFile = normalizeObservationPath(file);
  if (!normalizedRoot || !normalizedFile || !safeHookProjectPath(normalizedRoot, normalizedFile)) return null;
  return pathApi(normalizedRoot).relative(normalizedRoot, normalizedFile).replaceAll('\\', '/');
}
