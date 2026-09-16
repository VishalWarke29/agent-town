import { describe, expect, it } from 'vitest';
import type { Agent, Repository } from '@agent-town/contracts';
import { campusBounds } from '../../apps/web/src/world/layout';
import { ROOM_DESK_COUNT, houseWidth, roomAgentAnchor, roomDeskPositions } from '../../apps/web/src/world/room-layout';

function repo(id: string, position: [number, number]): Repository {
  return { id, name: id, description: '', language: '', branch: 'main', color: '#888888', position };
}
const home = (value: [number, number]): Pick<Agent, 'home'> => ({ home: value });

describe('campus bounding box', () => {
  it('never shrinks below the default footprint when there are no repositories or agents', () => {
    expect(campusBounds([], 0)).toEqual({ minX: -15, maxX: 15, minZ: -12, maxZ: 12 });
  });

  it('grows to fit repositories with a fixed 5-unit margin on every side', () => {
    expect(campusBounds([repo('a', [20, -20]), repo('b', [-30, 5])], 0)).toEqual({ minX: -35, maxX: 25, minZ: -25, maxZ: 12 });
  });

  it('grows the back row to fit a reporting-agent queue in increments of three, plus a fixed margin', () => {
    expect(campusBounds([], 3).maxZ).toBe(12); // ceil(3/3)*0.75+3 = 3.75, still below the default 12
    expect(campusBounds([], 40).maxZ).toBeCloseTo(Math.ceil(40 / 3) * 0.75 + 3);
    expect(campusBounds([], 40).maxZ).toBeGreaterThan(12);
  });

  it('expands to fit agent homes with a 1.5-unit margin', () => {
    const bounds = campusBounds([], 0, [home([-50, 0]), home([0, 40])]);
    expect(bounds).toEqual({ minX: -51.5, maxX: 15, minZ: -12, maxZ: 41.5 });
  });

  it('excludes homes with non-finite or out-of-range coordinates instead of letting them blow out the bounds', () => {
    const corrupted = [home([NaN, 0]), home([Infinity, 0]), home([-Infinity, 0]), home([1025, 0]), home([-1025, 0])];
    expect(campusBounds([], 0, corrupted)).toEqual({ minX: -15, maxX: 15, minZ: -12, maxZ: 12 });
    // exactly at the 1024 boundary is still admitted
    expect(campusBounds([], 0, [home([1024, 0])])).toEqual({ minX: -15, maxX: 1025.5, minZ: -12, maxZ: 12 });
  });

  it('does not mutate the repository or agent inputs it reads', () => {
    const repos = [repo('a', [1, 2])], agents = [home([3, 4])];
    const beforeRepos = structuredClone(repos), beforeAgents = structuredClone(agents);
    campusBounds(repos, 5, agents);
    expect(repos).toEqual(beforeRepos);
    expect(agents).toEqual(beforeAgents);
  });
});

describe('room desk layout', () => {
  it('lays out desks as two rows of three, centered on the house, with a shared floor height', () => {
    const slots = roomDeskPositions(repo('web', [0, 0]));
    expect(slots).toHaveLength(ROOM_DESK_COUNT);
    const spacing = (houseWidth(repo('web', [0, 0])) - 1.8) / 2;
    expect(slots[0]).toEqual([-spacing, 0.28, -0.83]);
    expect(slots[1]).toEqual([0, 0.28, -0.83]);
    expect(slots[2]).toEqual([spacing, 0.28, -0.83]);
    expect(slots[3]).toEqual([-spacing, 0.28, 0.62]);
    expect(slots[4]).toEqual([0, 0.28, 0.62]);
    expect(slots[5]).toEqual([spacing, 0.28, 0.62]);
  });

  it('narrows desk spacing for the tools house, which is narrower than every other repository house', () => {
    expect(houseWidth(repo('tools', [0, 0]))).toBe(3.7);
    expect(houseWidth(repo('web', [0, 0]))).toBe(4.8);
    expect(houseWidth(repo('anything-else', [0, 0]))).toBe(4.8);
    const [toolsSlot] = roomDeskPositions(repo('tools', [0, 0]));
    const [defaultSlot] = roomDeskPositions(repo('web', [0, 0]));
    expect(Math.abs(toolsSlot![0])).toBeLessThan(Math.abs(defaultSlot![0]));
  });

  it('anchors a resident above the room floor at the house origin plus its desk slot', () => {
    const house = repo('web', [10, -6]);
    const slot = roomDeskPositions(house)[2]!;
    expect(roomAgentAnchor(house, 2)).toEqual([10 + slot[0], slot[1] + 0.06, -6 + slot[2] + 0.35]);
  });

  it('returns null for a desk index outside the fixed six-desk room', () => {
    const house = repo('web', [0, 0]);
    expect(roomAgentAnchor(house, -1)).toBeNull();
    expect(roomAgentAnchor(house, ROOM_DESK_COUNT)).toBeNull();
    expect(roomAgentAnchor(house, 5)).not.toBeNull();
  });
});
