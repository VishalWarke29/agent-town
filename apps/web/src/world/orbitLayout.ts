import type { DbSchemaGroup } from '@agent-town/contracts';

export interface OrbitBody {
  id: string;
  label: string;
  fileKind: DbSchemaGroup['fileKind'];
  rowCount: number | null;
  parentId: string | null; // null = orbits the sun directly; otherwise orbits another body (a moon)
  level: number; // 1 = orbits the sun, 2 = a moon of a level-1 body, ...
  orbitRadius: number;
  angleOffset: number;
  speedDirection: 1 | -1;
  size: number;
  /** For the click-to-inspect detail card: every real column (primary keys marked), independent of
   * the layout math above. hiddenColumnCount counts columns the server already excluded entirely
   * (credential_ref, token_hash, ...) so their absence reads as "hidden for privacy", not "this table
   * only has these few columns". */
  columns: { name: string; primaryKey: boolean }[];
  hiddenColumnCount: number;
  /** This body's own outgoing foreign key, if it has one — the same relationship parentId encodes as
   * an orbit, spelled out in words for the detail card ("account_id → accounts.id"). */
  outgoingForeignKey: { column: string; toTable: string; toColumn: string } | null;
}
export interface Sun {
  id: string;
  label: string;
  fileKind: DbSchemaGroup['fileKind'];
  /** True when this file's foreign-key list is empty — shown plainly near the sun so "no lines
   * connect any of these tables" reads as an honest fact about the data, not a broken feature. */
  hasForeignKeys: boolean;
}
export interface SolarSystem {
  sun: Sun;
  bodies: OrbitBody[]; // flat list; render recursively by matching parentId
  offsetX: number; // this system's own center, for laying several systems out side by side
}
export const SOLAR_SYSTEM_SPACING = 3.6;
const SUN_RADIUS = 0.62;

/** Deterministic pseudo-random in [0,1) from an integer index — stable across re-renders. */
function seeded(index: number): number {
  const value = Math.sin(index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function bodySize(rowCount: number | null): number {
  if (rowCount === null) return 0.22;
  return 0.24 + Math.log10(rowCount + 1) * 0.14;
}

/** One foreign key names a body's orbital parent: a table that references another table (its FK
 * target) orbits that target as a moon, directly showing the dependency as a physical relationship —
 * "this table's data depends on that one" reads as "this moon circles that planet". A table with no
 * outgoing foreign key orbits the sun (the database file itself) directly. Established prior art for
 * both halves of this: radial/concentric layouts are a standard graph-drawing technique for hierarchy
 * depth (yFiles, Cambridge Intelligence, AntV G6's radial layout), and Graham & Yang's "A Solar System
 * Metaphor for 3D Visualisation of Object-Oriented Software Metrics" (2004 Australasian Symposium on
 * Information Visualisation) used exactly this sun/orbit/planet-size mapping for package/class metrics —
 * this reuses that mapping (file = sun, table = planet, dependency depth = orbit, row count = size),
 * not a third-party rendering library. A cycle (A depends on B depends on A) is broken by orbiting the
 * sun once every parent has already been visited on the current chain, rather than looping forever. */
/** Also returns footprintRadius: how far the camera needs to see from the whole collection's own
 * center to show every system in full, computed from this run's actual bodies (a small schema with
 * no foreign keys zooms in close; a deep one gets a wider frame) rather than a fixed guess sized for
 * a hypothetical worst case, which either clipped large schemas or left small ones looking distant
 * and empty. */
export function layoutSolarSystems(groups: DbSchemaGroup[]): { systems: SolarSystem[]; footprintRadius: number } {
  const startX = -((groups.length - 1) * SOLAR_SYSTEM_SPACING) / 2;
  let maxReach = SUN_RADIUS;
  const systems = groups.map((group, groupIndex) => {
    const sun: Sun = { id: `sun:${group.fileKind}`, label: group.label, fileKind: group.fileKind, hasForeignKeys: group.foreignKeys.length > 0 };
    const parentOf = new Map<string, string>(); // table name -> its FK target table name (first one wins)
    const fkOf = new Map<string, { column: string; toTable: string; toColumn: string }>();
    for (const fk of group.foreignKeys) if (!parentOf.has(fk.fromTable)) { parentOf.set(fk.fromTable, fk.toTable); fkOf.set(fk.fromTable, { column: fk.fromColumn, toTable: fk.toTable, toColumn: fk.toColumn }); }
    const tableNames = new Set(group.tables.map(table => table.name));

    const levelOf = (name: string, seen = new Set<string>()): number => {
      const parent = parentOf.get(name);
      if (!parent || !tableNames.has(parent) || parent === name || seen.has(name)) return 1;
      return 1 + levelOf(parent, new Set(seen).add(name));
    };

    const orbitCounts = new Map<string, number>(); // parentId (or 'sun') -> how many bodies already placed there, for angle spacing
    const nextAngle = (parentKey: string, siblingIndex: number, siblingTotal: number) => {
      const base = (siblingIndex / Math.max(1, siblingTotal)) * Math.PI * 2;
      // A little jitter so evenly-spaced bodies don't look like a perfectly mechanical ring — but
      // bounded to a fraction of the actual gap between neighbors, not a fixed amount: at a fixed
      // ±0.6 radians, two adjacent bodies among many siblings (a small gap to begin with) could jitter
      // toward each other far enough to collide, which is exactly what overlapping labels were.
      const gap = (Math.PI * 2) / Math.max(1, siblingTotal);
      return base + (seeded(groupIndex * 97 + parentKey.length + siblingIndex) - 0.5) * gap * 0.5;
    };

    const byParent = new Map<string, string[]>(); // parentId key ('sun' or a table name) -> table names
    for (const table of group.tables) {
      const parent = parentOf.get(table.name);
      const key = parent && tableNames.has(parent) && parent !== table.name ? parent : 'sun';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(table.name);
    }

    const rowCountByName = new Map(group.tables.map(table => [table.name, table.rowCount]));
    const bodies: OrbitBody[] = group.tables.map(table => {
      const level = levelOf(table.name);
      const parent = parentOf.get(table.name);
      const parentIsSelfOrMissing = !parent || !tableNames.has(parent) || parent === table.name;
      const parentKey = parentIsSelfOrMissing ? 'sun' : parent!;
      const siblings = byParent.get(parentKey) ?? [table.name];
      const siblingIndex = siblings.indexOf(table.name);
      const count = orbitCounts.get(parentKey) ?? 0;
      orbitCounts.set(parentKey, count + 1);
      const orbitRadius = parentIsSelfOrMissing
        // Rings around the sun; capped so one pathologically deep dependency chain still reads as
        // nested rings rather than sprawling indefinitely. Also grows with how many tables share this
        // exact ring: a fixed radius gave every body on a ring the same label-sized arc of space
        // regardless of whether there were 3 siblings or 15, so a database with many same-depth
        // tables (the common case — most tables have no foreign key at all) crowded their labels
        // into each other however the camera happened to be angled.
        ? Math.max(Math.min(3.4, 1.5 + (level - 1) * 1.15), siblings.length * 0.24)
        // A moon orbits clear of its planet's actual surface, not just its own: the previous formula
        // (0.55 + own size) ignored a big parent's own radius, so a moon of a large table could sit
        // almost inside it, hiding the connection line (MoonLink, in ArchiveGraph) drawn between them
        // in the gap that should exist between the two surfaces.
        : bodySize(rowCountByName.get(parent!) ?? null) + bodySize(table.rowCount) + 0.55;
      return {
        id: `${group.fileKind}.${table.name}`,
        label: table.name,
        fileKind: group.fileKind,
        rowCount: table.rowCount,
        parentId: parentIsSelfOrMissing ? null : `${group.fileKind}.${parent}`,
        level,
        orbitRadius,
        angleOffset: nextAngle(parentKey, siblingIndex, siblings.length),
        speedDirection: siblingIndex % 2 === 0 ? 1 : -1,
        size: bodySize(table.rowCount),
        columns: table.columns.map(column => ({ name: column.name, primaryKey: column.primaryKey })),
        hiddenColumnCount: table.hiddenColumnCount,
        outgoingForeignKey: fkOf.get(table.name) ?? null,
      };
    });
    // A moon's true distance from the sun is its own orbit plus every ancestor's, not just its own
    // radius — walked once here rather than assumed, so a real (even if currently rare) moon-of-a-moon
    // still gets a correctly sized camera frame instead of an underestimate that clips it.
    const byId = new Map(bodies.map(body => [body.id, body]));
    const reachOf = (body: OrbitBody, seen = new Set<string>()): number => {
      const own = body.orbitRadius + body.size;
      if (!body.parentId || seen.has(body.id)) return own;
      const parent = byId.get(body.parentId);
      return parent ? body.orbitRadius + reachOf(parent, new Set(seen).add(body.id)) : own;
    };
    for (const body of bodies) maxReach = Math.max(maxReach, reachOf(body));
    const offsetX = startX + groupIndex * SOLAR_SYSTEM_SPACING;
    return { sun, bodies, offsetX };
  });
  const footprintRadius = Math.abs(startX) + maxReach + 0.6;
  return { systems, footprintRadius };
}
