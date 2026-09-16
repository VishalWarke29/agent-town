import { describe, expect, it } from 'vitest';
import { reconcileDeskSlots } from '../../apps/web/src/useWorldNavigation';

describe('stable workroom desk slots', () => {
  it('keeps the seventh resident on its page when an earlier resident reports away, fills the vacancy, and resumes without displacement', () => {
    const original = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const away = reconcileDeskSlots(original, original.slice(1));
    expect(away).toEqual([null, 'b', 'c', 'd', 'e', 'f', 'g']);
    const joined = reconcileDeskSlots(away, ['h', ...original.slice(1)]);
    expect(joined).toEqual(['h', 'b', 'c', 'd', 'e', 'f', 'g']);
    const resumed = reconcileDeskSlots(joined, [...original, 'h']);
    expect(resumed).toEqual(['h', 'b', 'c', 'd', 'e', 'f', 'g', 'a']);
    expect(original).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('preserves empty early pages until the last occupied page disappears', () => {
    const slots = reconcileDeskSlots(['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['g']);
    expect(slots).toEqual([null, null, null, null, null, null, 'g']);
    expect(reconcileDeskSlots(slots, ['g', 'h'])).toEqual(['h', null, null, null, null, null, 'g']);
    expect(reconcileDeskSlots(['h', null, null, null, null, null, 'g'], ['h'])).toEqual(['h']);
    expect(reconcileDeskSlots(slots, [])).toEqual([]);
  });

  it('ignores metadata ordering and duplicate incoming IDs without modifying its inputs', () => {
    const slots = Object.freeze(['b', null, 'a', 'c']);
    const incoming = Object.freeze(['c', 'a', 'b', 'd', 'd']);
    expect(reconcileDeskSlots(slots, incoming)).toEqual(['b', 'd', 'a', 'c']);
    expect(slots).toEqual(['b', null, 'a', 'c']);
    expect(incoming).toEqual(['c', 'a', 'b', 'd', 'd']);
  });

  it('bounds presentation history at the live-session capacity through repeated archive and replacement', () => {
    let ids = Array.from({ length: 200 }, (_, index) => `session-${index}`);
    let slots = reconcileDeskSlots([], ids);
    const last = slots.at(-1)!;
    for (let round = 0; round < 250; round++) {
      const freed = slots.findIndex(id => id !== last);
      const departed = slots[freed];
      ids = ids.filter(id => id !== departed);
      slots = reconcileDeskSlots(slots, ids);
      ids.push(`replacement-${round}`);
      slots = reconcileDeskSlots(slots, ids);
      expect(slots).toHaveLength(200);
      expect(slots[freed]).toBe(`replacement-${round}`);
      expect(slots.at(-1)).toBe(last);
    }
    expect(new Set(slots).size).toBe(200);
    expect(reconcileDeskSlots([], ['other-repository-session'])).toEqual(['other-repository-session']);
  });
});
