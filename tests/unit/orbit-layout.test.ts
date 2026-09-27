import { describe, expect, it } from 'vitest';
import { layoutSolarSystems } from '../../apps/web/src/world/orbitLayout';
import type { DbSchemaGroup } from '../../packages/contracts/src/db-visualizer';

function group(overrides: Partial<DbSchemaGroup> = {}): DbSchemaGroup {
  return { label: 'Test group', fileKind: 'workspace', tables: [], foreignKeys: [], ...overrides };
}

describe('solar system layout', () => {
  it('gives a moon real clearance from its parent, accounting for the parent\'s own size too', () => {
    // A real bug this guards against: the orbit radius once used only the moon's own size (0.55 +
    // its own size), so a moon of a large parent could sit almost inside it — hiding the connection
    // line (MoonLink, in ArchiveGraph.tsx) drawn in the gap between the two surfaces. accounts has
    // many more rows than sessions, so it renders as the visibly larger sphere here.
    const { systems } = layoutSolarSystems([group({
      tables: [
        { name: 'accounts', columns: [], hiddenColumnCount: 0, rowCount: 5000 },
        { name: 'sessions', columns: [], hiddenColumnCount: 0, rowCount: 3 },
      ],
      foreignKeys: [{ fromTable: 'sessions', fromColumn: 'account_id', toTable: 'accounts', toColumn: 'id' }],
    })]);
    const bodies = systems[0]!.bodies;
    const accounts = bodies.find(b => b.label === 'accounts')!, sessions = bodies.find(b => b.label === 'sessions')!;
    expect(sessions.parentId).toBe(accounts.id);
    // The gap between the two surfaces (moon orbit radius minus both radii) must be a real, visible
    // clearance, not near zero, regardless of which of the two tables happens to be larger.
    const gap = sessions.orbitRadius - accounts.size - sessions.size;
    expect(gap).toBeGreaterThan(0.4);
  });

  it('leaves a table with no foreign key orbiting the sun directly', () => {
    const { systems } = layoutSolarSystems([group({
      tables: [{ name: 'town_state', columns: [], hiddenColumnCount: 0, rowCount: 1 }],
      foreignKeys: [],
    })]);
    const [body] = systems[0]!.bodies;
    expect(body!.parentId).toBeNull();
    expect(body!.level).toBe(1);
  });

  it('breaks a foreign-key cycle by orbiting the sun instead of looping forever', () => {
    const { systems } = layoutSolarSystems([group({
      tables: [
        { name: 'a', columns: [], hiddenColumnCount: 0, rowCount: 0 },
        { name: 'b', columns: [], hiddenColumnCount: 0, rowCount: 0 },
      ],
      foreignKeys: [
        { fromTable: 'a', fromColumn: 'b_id', toTable: 'b', toColumn: 'id' },
        { fromTable: 'b', fromColumn: 'a_id', toTable: 'a', toColumn: 'id' },
      ],
    })]);
    const levels = systems[0]!.bodies.map(b => b.level);
    expect(levels.every(level => Number.isFinite(level) && level < 10)).toBe(true);
  });

  it('grows footprintRadius for a bigger schema instead of using one fixed guess', () => {
    const small = layoutSolarSystems([group({ tables: [{ name: 'only', columns: [], hiddenColumnCount: 0, rowCount: 0 }], foreignKeys: [] })]);
    const chain = Array.from({ length: 6 }, (_, i) => ({ name: `t${i}`, columns: [], hiddenColumnCount: 0, rowCount: 0 }));
    const chainFks = chain.slice(1).map((t, i) => ({ fromTable: t.name, fromColumn: 'parent_id', toTable: chain[i]!.name, toColumn: 'id' }));
    const big = layoutSolarSystems([group({ tables: chain, foreignKeys: chainFks })]);
    expect(big.footprintRadius).toBeGreaterThan(small.footprintRadius);
  });

  it('never returns a footprint radius smaller than the actual content', () => {
    const { systems, footprintRadius } = layoutSolarSystems([group({
      tables: [
        { name: 'a', columns: [], hiddenColumnCount: 0, rowCount: 100000 },
        { name: 'b', columns: [], hiddenColumnCount: 0, rowCount: 0 },
      ],
      foreignKeys: [{ fromTable: 'b', fromColumn: 'a_id', toTable: 'a', toColumn: 'id' }],
    })]);
    for (const body of systems[0]!.bodies) expect(body.orbitRadius + body.size).toBeLessThanOrEqual(footprintRadius);
  });
});
