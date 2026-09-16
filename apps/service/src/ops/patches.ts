type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Path = (string | number)[];
export type StatePatch = { op: 'set'; path: Path; value: JsonValue } | { op: 'delete'; path: Path }
  | { op: 'splice'; path: Path; start: number; remove: number; values: JsonValue[] };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const same = (a: JsonValue, b: JsonValue) => a === b || typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b);
const key = (value: JsonValue): string | number | null => value && typeof value === 'object' && !Array.isArray(value)
  && (typeof value.id === 'string' || typeof value.id === 'number') ? value.id : typeof value === 'string' || typeof value === 'number' ? value : null;

/** Structural patches stay small for appended records and bounded FIFO telemetry lists. */
export function createStatePatch(before: unknown, after: unknown): StatePatch[] {
  const patches: StatePatch[] = [];
  const visit = (old: JsonValue, value: JsonValue, path: Path): void => {
    if (old === value) return;
    if (Array.isArray(old) && Array.isArray(value)) {
      let offset = 0;
      if (old.length && value.length && key(old[0]) !== key(value[0]) && key(value[0]) !== null) {
        const possible = old.findIndex(item => key(item) === key(value[0]));
        if (possible > 0 && old.slice(possible, possible + value.length).every((item, index) => key(item) !== null && key(item) === key(value[index]))) offset = possible;
      }
      if (offset) patches.push({ op: 'splice', path, start: 0, remove: offset, values: [] });
      const overlap = Math.min(old.length - offset, value.length);
      for (let index = 0; index < overlap; index++) visit(old[index + offset], value[index], [...path, index]);
      if (old.length - offset !== value.length) patches.push({ op: 'splice', path, start: overlap,
        remove: Math.max(0, old.length - offset - overlap), values: value.slice(overlap) });
    } else if (old && value && typeof old === 'object' && typeof value === 'object' && !Array.isArray(old) && !Array.isArray(value)) {
      for (const name of new Set([...Object.keys(old), ...Object.keys(value)])) {
        if (forbidden.has(name)) throw new Error('Unsupported state property.');
        if (!(name in value)) patches.push({ op: 'delete', path: [...path, name] });
        else if (!(name in old)) patches.push({ op: 'set', path: [...path, name], value: value[name] });
        else visit(old[name], value[name], [...path, name]);
      }
    } else if (!same(old, value)) patches.push({ op: 'set', path, value });
  };
  visit(before as JsonValue, after as JsonValue, []);
  return patches;
}

export function applyStatePatch<T>(input: T, patches: StatePatch[]): T {
  let state = input as unknown as JsonValue;
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || patch.path.length > 64 || patch.path.some(part => typeof part === 'string' ? forbidden.has(part) : !Number.isSafeInteger(part) || part < 0)) throw new Error('Invalid state patch.');
    if (patch.path.length === 0 && patch.op === 'set') { state = structuredClone(patch.value); continue; }
    let target = state;
    const steps = patch.op === 'splice' ? patch.path : patch.path.slice(0, -1);
    for (const part of steps) {
      if (target === null || typeof target !== 'object' || !Object.hasOwn(target, part)) throw new Error('Invalid state patch target.');
      target = (target as { [key: string | number]: JsonValue })[part];
    }
    if (patch.op === 'splice') {
      if (!Array.isArray(target) || !Number.isSafeInteger(patch.start) || !Number.isSafeInteger(patch.remove)
        || patch.start < 0 || patch.remove < 0 || patch.start > target.length || patch.start + patch.remove > target.length || !Array.isArray(patch.values)) throw new Error('Invalid array patch.');
      target.splice(patch.start, patch.remove, ...structuredClone(patch.values));
    } else {
      if (target === null || typeof target !== 'object') throw new Error('Invalid state patch target.');
      const part = patch.path.at(-1)!;
      if (patch.op === 'delete') delete (target as { [key: string | number]: JsonValue })[part];
      else (target as { [key: string | number]: JsonValue })[part] = structuredClone(patch.value);
    }
  }
  return state as T;
}
