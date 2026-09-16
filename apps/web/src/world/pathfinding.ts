export type Point = [number, number];
export interface Obstacle { x: number; z: number; width: number; depth: number }

// Bounded A* follows the expanding campus without searching the entire town per walk.
export function findPath(start: Point, end: Point, obstacles: Obstacle[]): Point[] {
  if (![...start, ...end, ...obstacles.flatMap(o => [o.x, o.z, o.width, o.depth])].every(Number.isFinite)
    || [...start, ...end].some(value => Math.abs(value) > 1024) || obstacles.length > 200) return [];
  const key = (x: number, z: number) => `${x},${z}`;
  const from: Point = [Math.round(start[0]), Math.round(start[1])];
  const to: Point = [Math.round(end[0]), Math.round(end[1])];
  const minX = Math.max(-1024, Math.floor(Math.min(-13, start[0], end[0], ...obstacles.map(o => o.x - o.width / 2)) - 3));
  const maxX = Math.min(1024, Math.ceil(Math.max(13, start[0], end[0], ...obstacles.map(o => o.x + o.width / 2)) + 3));
  const minZ = Math.max(-1024, Math.floor(Math.min(-10, start[1], end[1], ...obstacles.map(o => o.z - o.depth / 2)) - 3));
  const maxZ = Math.min(1024, Math.ceil(Math.max(10, start[1], end[1], ...obstacles.map(o => o.z + o.depth / 2)) + 3));
  const blocked = new Set<string>();
  for (const o of obstacles) {
    if (o.width <= 0 || o.depth <= 0 || o.width > 100 || o.depth > 100) return [];
    for (let x = Math.ceil(o.x - o.width / 2 - 0.35); x < o.x + o.width / 2 + 0.35; x++)
      for (let z = Math.ceil(o.z - o.depth / 2 - 0.35); z < o.z + o.depth / 2 + 0.35; z++) blocked.add(key(x, z));
  }
  const walkable = (x: number, z: number) => x >= minX && x <= maxX && z >= minZ && z <= maxZ && !blocked.has(key(x, z));
  if (!walkable(...to)) return [];
  const distance = (point: Point) => Math.abs(point[0] - to[0]) + Math.abs(point[1] - to[1]);
  const queue: { point: Point; score: number; cost: number }[] = [];
  const push = (point: Point, cost: number) => {
    const entry = { point, cost, score: cost + distance(point) }; queue.push(entry);
    let index = queue.length - 1;
    while (index > 0) { const parent = (index - 1) >> 1; if (queue[parent]!.score <= entry.score) break; queue[index] = queue[parent]!; index = parent; }
    queue[index] = entry;
  };
  const pop = () => {
    const first = queue[0]!, last = queue.pop()!;
    if (queue.length) {
      let index = 0;
      while (index * 2 + 1 < queue.length) {
        let child = index * 2 + 1;
        if (child + 1 < queue.length && queue[child + 1]!.score < queue[child]!.score) child++;
        if (last.score <= queue[child]!.score) break;
        queue[index] = queue[child]!; index = child;
      }
      queue[index] = last;
    }
    return first;
  };
  push(from, 0);
  const costs = new Map<string, number>([[key(...from), 0]]);
  const parents = new Map<string, Point | null>([[key(...from), null]]);
  for (let visited = 0; queue.length && visited < 100_000; visited++) {
    const { point: current, cost } = pop();
    if (cost !== costs.get(key(...current))) continue;
    if (current[0] === to[0] && current[1] === to[1]) {
      const path: Point[] = [end];
      let node: Point | null = current;
      while (node) { path.unshift(node); node = parents.get(key(...node)) ?? null; }
      return path;
    }
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const next: Point = [current[0] + dx!, current[1] + dz!];
      if (walkable(...next) && cost + 1 < (costs.get(key(...next)) ?? Infinity)) {
        parents.set(key(...next), current); costs.set(key(...next), cost + 1); push(next, cost + 1);
      }
    }
  }
  return []; // No route is safer than walking through a building.
}
