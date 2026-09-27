import { describe, expect, it } from 'vitest';
import { tableColor } from '../../apps/web/src/world/colorVariants';

describe('per-table color variation', () => {
  it('gives different tables in the same file visibly different colors', () => {
    const base = '#7c9b7a';
    const colors = ['accounts', 'sessions', 'events', 'town_state', 'agent_archive'].map(name => tableColor(base, name));
    expect(new Set(colors).size).toBe(colors.length);
    for (const color of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('is stable for the same name (no per-render flicker)', () => {
    expect(tableColor('#7c9b7a', 'sessions')).toBe(tableColor('#7c9b7a', 'sessions'));
  });
});
