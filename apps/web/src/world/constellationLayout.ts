import type { DbSchemaGroup } from '@agent-town/contracts';

export interface StarNode {
  id: string; label: string; x: number; z: number; rowCount: number | null; fileKind: DbSchemaGroup['fileKind'];
  columns: { name: string; primaryKey: boolean }[];
  hiddenColumnCount: number;
  outgoingForeignKey: { column: string; toTable: string; toColumn: string } | null;
}
export interface StarLink { from: string; to: string }

/** Deterministic pseudo-random in [0,1) from an integer index — stable across re-renders. */
function seeded(index: number): number {
  const value = Math.sin(index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/** A hand-rolled force-directed layout (mutual repulsion, spring edges along foreign keys, a gentle
 * pull to center): every table is a star, distance between two stars falls out of how strongly (or
 * whether) they're connected, exactly the "data constellation" convention — nodes placed apart from
 * and connected to each other in proportion to relationship strength — rather than fixed rings. No
 * third-party graph-layout library. Rescaled to a fixed footprint at the end: the simulation's own
 * repulsion/spring constants converge to whatever radius they happen to (larger with more tables),
 * not to a size chosen for this world's scale. */
export function layoutConstellation(groups: DbSchemaGroup[], iterations = 200): { nodes: StarNode[]; links: StarLink[]; footprintRadius: number } {
  const nodes: StarNode[] = [];
  for (const group of groups) {
    const fkOf = new Map<string, { column: string; toTable: string; toColumn: string }>();
    for (const fk of group.foreignKeys) if (!fkOf.has(fk.fromTable)) fkOf.set(fk.fromTable, { column: fk.fromColumn, toTable: fk.toTable, toColumn: fk.toColumn });
    for (const table of group.tables) {
      const index = nodes.length;
      const angle = seeded(index) * Math.PI * 2;
      const radius = 1.4 + seeded(index + 97) * 1.6;
      nodes.push({
        id: `${group.fileKind}.${table.name}`, label: table.name, x: Math.cos(angle) * radius, z: Math.sin(angle) * radius, rowCount: table.rowCount, fileKind: group.fileKind,
        columns: table.columns.map(column => ({ name: column.name, primaryKey: column.primaryKey })),
        hiddenColumnCount: table.hiddenColumnCount,
        outgoingForeignKey: fkOf.get(table.name) ?? null,
      });
    }
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const links: StarLink[] = [];
  for (const group of groups) {
    for (const fk of group.foreignKeys) {
      const from = `${group.fileKind}.${fk.fromTable}`, to = `${group.fileKind}.${fk.toTable}`;
      if (byId.has(from) && byId.has(to)) links.push({ from, to });
    }
  }
  const REPEL = 3.2, SPRING = 0.06, SPRING_LENGTH = 3, CENTER_PULL = 0.02;
  for (let step = 0; step < iterations; step++) {
    const forceX = new Map<string, number>(), forceZ = new Map<string, number>();
    for (const node of nodes) { forceX.set(node.id, 0); forceZ.set(node.id, 0); }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!, b = nodes[j]!;
        let dx = a.x - b.x, dz = a.z - b.z;
        let distSq = dx * dx + dz * dz;
        if (distSq < 0.0001) { dx = seeded(i + j * 31) - 0.5; dz = seeded(i * 17 + j) - 0.5; distSq = 0.01; }
        const dist = Math.sqrt(distSq), force = REPEL / distSq;
        forceX.set(a.id, forceX.get(a.id)! + (dx / dist) * force); forceZ.set(a.id, forceZ.get(a.id)! + (dz / dist) * force);
        forceX.set(b.id, forceX.get(b.id)! - (dx / dist) * force); forceZ.set(b.id, forceZ.get(b.id)! - (dz / dist) * force);
      }
    }
    for (const link of links) {
      const a = byId.get(link.from)!, b = byId.get(link.to)!;
      const dx = b.x - a.x, dz = b.z - a.z;
      const dist = Math.max(0.01, Math.hypot(dx, dz)), stretch = (dist - SPRING_LENGTH) * SPRING;
      forceX.set(a.id, forceX.get(a.id)! + (dx / dist) * stretch); forceZ.set(a.id, forceZ.get(a.id)! + (dz / dist) * stretch);
      forceX.set(b.id, forceX.get(b.id)! - (dx / dist) * stretch); forceZ.set(b.id, forceZ.get(b.id)! - (dz / dist) * stretch);
    }
    for (const node of nodes) {
      node.x += forceX.get(node.id)! - node.x * CENTER_PULL;
      node.z += forceZ.get(node.id)! - node.z * CENTER_PULL;
    }
  }
  const TARGET_RADIUS = 2.8;
  const maxDist = Math.max(0.001, ...nodes.map(node => Math.hypot(node.x, node.z)));
  if (maxDist > TARGET_RADIUS) {
    const scale = TARGET_RADIUS / maxDist;
    for (const node of nodes) { node.x *= scale; node.z *= scale; }
  }
  // The actual reach after any rescale above, not the fixed TARGET_RADIUS cap: a handful of stars
  // never spreads out that far on its own, so framing the camera to TARGET_RADIUS regardless would
  // leave them looking small and distant instead of filling the frame.
  const footprintRadius = Math.min(TARGET_RADIUS, maxDist) + 0.5;
  return { nodes, links, footprintRadius };
}
