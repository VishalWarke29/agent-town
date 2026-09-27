import { describe, expect, it } from 'vitest';
import { applyStatePatch, createStatePatch } from '../../apps/service/src/ops/patches.js';

const rows = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({
  id: `activity-${from - index}`, message: `Event ${from - index}`, createdAt: `2026-09-20T00:00:${String((from - index) % 60).padStart(2, '0')}Z`
}));
const size = (patches: unknown) => JSON.stringify(patches).length;
const roundTrips = (before: unknown, after: unknown) => {
  const patches = createStatePatch(before, after);
  expect(applyStatePatch(structuredClone(before), patches)).toEqual(after);
  return patches;
};

describe('state patches', () => {
  it('records an unshift onto a full 500-item newest-first list as a couple of operations', () => {
    const before = { activity: rows(1000, 500), other: 1 };
    const after = { activity: [{ id: 'activity-1001', message: 'New', createdAt: 'now' }, ...before.activity].slice(0, 500), other: 1 };
    const patches = roundTrips(before, after);
    expect(patches.length).toBeLessThanOrEqual(3);
    expect(size(patches)).toBeLessThan(2000);
  });

  it('handles a multi-item prepend without trimming, and a prepend that trims more than it adds', () => {
    const before = { activity: rows(50, 10) };
    const grown = { activity: [...rows(53, 3), ...before.activity] };
    expect(createStatePatch(before, grown).length).toBeLessThanOrEqual(2);
    roundTrips(before, grown);
    const trimmed = { activity: [...rows(52, 2), ...before.activity].slice(0, 8) };
    expect(createStatePatch(before, trimmed).length).toBeLessThanOrEqual(3);
    roundTrips(before, trimmed);
  });

  it('still patches edits inside the surviving run of a prepended list', () => {
    const before = { activity: rows(20, 6) };
    const edited = [{ id: 'activity-21', message: 'New', createdAt: 'now' }, ...before.activity.map(item => ({ ...item }))];
    edited[3] = { ...edited[3], message: 'Edited' };
    const patches = roundTrips(before, { activity: edited });
    expect(patches.some(patch => patch.op === 'set' && patch.path.join('.') === 'activity.3.message')).toBe(true);
    expect(size(patches)).toBeLessThan(600);
  });

  it('keeps the existing shift, push, and in-place behaviour', () => {
    const before = { list: rows(30, 20) };
    expect(createStatePatch(before, { list: before.list.slice(1) })).toEqual([{ op: 'splice', path: ['list'], start: 0, remove: 1, values: [] }]);
    const pushed = { list: [...before.list, { id: 'activity-0', message: 'Tail', createdAt: 'x' }] };
    expect(createStatePatch(before, pushed)).toHaveLength(1);
    roundTrips(before, pushed);
    const replaced = { list: before.list.map((item, index) => index === 4 ? { ...item, message: 'Changed' } : item) };
    expect(createStatePatch(before, replaced)).toEqual([{ op: 'set', path: ['list', 4, 'message'], value: 'Changed' }]);
    roundTrips(before, { list: [...before.list.slice(2), { id: 'activity-x', message: 'a', createdAt: 'b' }] });
  });

  it('falls back to an exact rewrite when items have no stable key', () => {
    const before = { list: [{ text: 'a' }, { text: 'b' }] };
    roundTrips(before, { list: [{ text: 'z' }, { text: 'a' }, { text: 'b' }] });
    roundTrips({ list: [] }, { list: [{ id: 'one' }] });
    roundTrips({ list: [{ id: 'one' }] }, { list: [] });
    roundTrips({ list: [{ id: 'a' }, { id: 'b' }] }, { list: [{ id: 'b' }, { id: 'a' }] });
  });

  it('round-trips arbitrary keyed list changes', () => {
    let seed = 20260920;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 400; round++) {
      const length = Math.floor(next() * 12);
      const before = { list: Array.from({ length }, (_, index) => ({ id: `id-${index}`, n: Math.floor(next() * 3) })) };
      let list = before.list.map(item => ({ ...item }));
      const front = Math.floor(next() * 4);
      list = [...Array.from({ length: front }, (_, index) => ({ id: `new-${round}-${index}`, n: 0 })), ...list];
      if (next() < 0.4) list = list.slice(Math.floor(next() * 3));
      if (next() < 0.4) list = list.slice(0, Math.max(0, list.length - Math.floor(next() * 3)));
      if (next() < 0.4) list.push({ id: `tail-${round}`, n: 1 });
      if (list.length && next() < 0.5) list[Math.floor(next() * list.length)] = { id: list[0].id, n: 9 };
      roundTrips(before, { list });
    }
  });

  // REV-22: external repo/tool text (a repository name, a file path, an agent name) must stay a
  // VALUE, never an object KEY, so it can never collide with __proto__/prototype/constructor and
  // silently corrupt or block a commit. Values are unrestricted; only object keys are forbidden.
  it('round-trips __proto__/prototype/constructor as ordinary string VALUES without corrupting the result', () => {
    const before = { repositories: [{ id: 'repo-1', name: 'normal' }], handoffs: [] as { id: string; summary: string }[] };
    const after = { repositories: [{ id: 'repo-1', name: '__proto__' }, { id: 'repo-2', name: 'prototype' }],
      handoffs: [{ id: 'h1', summary: 'constructor' }] };
    const patches = roundTrips(before, after);
    const result = applyStatePatch(structuredClone(before), patches);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.repositories.map(r => r.name)).toEqual(['__proto__', 'prototype']);
    expect(result.handoffs[0].summary).toBe('constructor');
  });

  it('refuses to diff or apply a patch that would key an object by __proto__, prototype or constructor', () => {
    const before = { settings: { normal: 'a' } };
    for (const forbidden of ['__proto__', 'prototype', 'constructor']) {
      const after = { settings: { normal: 'a', [forbidden]: 'polluted' } };
      expect(() => createStatePatch(before, after)).toThrow('Unsupported state property.');
      expect(() => applyStatePatch(structuredClone(before), [{ op: 'set', path: ['settings', forbidden], value: 'polluted' }])).toThrow('Invalid state patch.');
    }
  });
});
