import type { Agent } from '@agent-town/contracts';

export type Selection = { kind: 'agent' | 'repo'; id: string } | { kind: 'manager' } | { kind: 'archive' };
export interface RoomView { repoId: string; agentIds: (string | null)[] }
export interface CameraAction {
  kind: 'reset' | 'in' | 'out' | 'focus' | 'room' | 'archive' | 'return' | 'pan';
  point?: [number, number];
  direction?: 'left' | 'right' | 'up' | 'down';
  /** 'archive' only: how far the camera needs to see from `point` to show the whole visualization,
   * computed from its actual current content (see orbitLayout/constellationLayout's footprintRadius)
   * rather than a fixed guess — falls back to ARCHIVE_CAMERA_RADIUS below when omitted. */
  radius?: number;
  nonce: number;
}

export const ROOM_PAGE_SIZE = 6;
/** The Archive building's fixed world position (x, z) and the height its floating 3D visualization
 * hovers at, shared between World.tsx (placing the building and the visualization) and App.tsx/
 * CameraRig (framing a tight, near-full-screen camera view on it — see camera('archive', ...) and
 * archiveCameraPose — instead of leaving it to whatever zoom level the camera last happened to be
 * at, which used to let it render half-hidden behind or overlapping a nearby house). */
// Back to [8, 2], the original spot from before the full-screen camera framing existed — the owner
// confirmed this placement in the town itself was already right and asked for it back specifically,
// rather than [15, -8] (chosen afterwards, projected through the camera tilt for clearance from every
// building at that tight zoom). Verified below with the current build: whether archiveCameraPose's
// now-dynamic radius still isolates the visualization cleanly from Backend lab at this closer spot,
// or needs its own adjustment now that it's back.
export const ARCHIVE_POSITION: [number, number] = [8, 2];
export const ARCHIVE_VISUAL_ELEVATION = 6.2;
export const ARCHIVE_CAMERA_RADIUS = 4.4;

export function canUseDesk(agent: Agent): boolean {
  return agent.activity === 'working' || agent.activity === 'testing' || agent.activity === 'waiting' || agent.activity === 'idle' || agent.activity === 'unknown';
}

export function isActivityStale(agent: Agent, connected: boolean, now: number): boolean {
  if (agent.activity === 'unknown' && !agent.observation) return false;
  if (!connected) return true;
  if (!agent.observation) return false;
  const sourceTime = Date.parse(agent.observation.sourceTime);
  return agent.observation.freshness === 'stale' || !Number.isFinite(sourceTime) || sourceTime > now + 5000 || now - sourceTime >= 120000;
}
