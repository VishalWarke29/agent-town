import { describe, expect, it } from 'vitest';
import { findPath } from '../../apps/web/src/world/pathfinding';

describe('report walking routes', () => {
  it('routes around a building rather than crossing its footprint', () => {
    const obstacle = { x: 0, z: 0, width: 4, depth: 4 };
    const path = findPath([-4, 0], [4, 0], [obstacle]);
    expect(path.length).toBeGreaterThan(8);
    expect(path.at(-1)).toEqual([4, 0]);
    expect(path.every(([x, z]) => Math.abs(x) >= 2.35 || Math.abs(z) >= 2.35)).toBe(true);
  });

  it('does not fabricate a route to an unreachable destination', () => {
    expect(findPath([-4, 0], [0, 0], [{ x: 0, z: 0, width: 3, depth: 3 }])).toEqual([]);
  });

  it('brings a report from an outer repository back to the manager', () => {
    const buildings = Array.from({ length: 50 }, (_, index) => ({ x: 18 + index % 5 * 8, z: -4 + Math.floor(index / 5) * 8, width: 5.1, depth: 3.8 }));
    const start: [number, number] = [50, 70.7];
    const route = findPath(start, [0, -0.25], buildings);
    expect(route.length).toBeGreaterThan(100);
    expect(route.at(-1)).toEqual([0, -0.25]);
    expect(route.every(([x, z]) => buildings.every(building => Math.abs(x - building.x) >= building.width / 2 + 0.35 || Math.abs(z - building.z) >= building.depth / 2 + 0.35))).toBe(true);
  });

  it('rejects malformed or unbounded positions', () => {
    expect(findPath([NaN, 0], [0, 0], [])).toEqual([]);
    expect(findPath([0, 0], [100000, 0], [])).toEqual([]);
  });
});
