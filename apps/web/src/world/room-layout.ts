import type { Repository } from '@agent-town/contracts';
import type { Position } from './primitives';

export const ROOM_DESK_COUNT = 6;
export const houseWidth = (repo: Pick<Repository, 'id'>) => repo.id === 'tools' ? 3.7 : 4.8;

/** Presentation coordinates only. Never persist these as agent homes. */
export function roomDeskPositions(repo: Pick<Repository, 'id'>): Position[] {
  const spacing = (houseWidth(repo) - 1.8) / 2;
  return Array.from({ length: ROOM_DESK_COUNT }, (_, index) => [
    (index % 3 - 1) * spacing, 0.28, Math.floor(index / 3) * 1.45 - 0.83,
  ]);
}

export function roomAgentAnchor(repo: Pick<Repository, 'id' | 'position'>, deskIndex: number): Position | null {
  const slot = roomDeskPositions(repo)[deskIndex];
  // Keep the selection ring above the room floor (whose top is y=0.31).
  return slot ? [repo.position[0] + slot[0], slot[1] + 0.06, repo.position[1] + slot[2] + 0.35] : null;
}
