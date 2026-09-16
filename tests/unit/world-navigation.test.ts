import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-town/contracts';
import { stableResidentOrder } from '../../apps/web/src/useWorldNavigation';
import { canUseDesk, isActivityStale } from '../../apps/web/src/world/interaction';

const now = Date.parse('2026-09-14T18:00:00Z');
function agent(activity: Agent['activity'] = 'working'): Agent {
  return { id: 'one', name: 'One', provider: 'Codex', role: 'Worker', repoId: 'web', task: '', activity, color: '#888888', home: [0, 0], updatedAt: new Date(now).toISOString(), files: [], evidence: '', contextVersion: null,
    observation: { connectionId: 'source', sessionId: 'one', parentSessionId: null, lastSequence: null, sourceTime: new Date(now - 1000).toISOString(), freshness: 'current', billing: 'unavailable' } };
}

describe('repository presentation without changing saved agent state', () => {
  it('preserves existing order across snapshot sorting and appends new residents deterministically', () => {
    expect(stableResidentOrder(['b', 'a'], ['d', 'a', 'c', 'b'])).toEqual(['b', 'a', 'c', 'd']);
    expect(stableResidentOrder(['b', 'a', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
  });
  it('keeps reporting and terminal sessions out of working desks', () => {
    for (const activity of ['reporting', 'review', 'offline', 'failed', 'cancelled'] as const) expect(canUseDesk(agent(activity))).toBe(false);
    for (const activity of ['working', 'testing', 'idle', 'waiting'] as const) expect(canUseDesk(agent(activity))).toBe(true);
  });
  it('uses source age instead of recent receipt time and rejects unknown/future source timestamps', () => {
    const record = agent();
    expect(isActivityStale(record, true, now)).toBe(false);
    record.observation!.sourceTime = new Date(now - 120001).toISOString();
    expect(isActivityStale(record, true, now)).toBe(true);
    record.observation!.sourceTime = 'invalid';
    expect(isActivityStale(record, true, now)).toBe(true);
    record.observation!.sourceTime = new Date(now + 6000).toISOString();
    expect(isActivityStale(record, true, now)).toBe(true);
  });
  it('pauses even fresh or managed activity on stream loss without mutating records', () => {
    const record = agent(), saved = structuredClone(record);
    expect(isActivityStale(record, false, now)).toBe(true);
    expect(record).toEqual(saved);
    delete record.observation;
    expect(isActivityStale(record, false, now)).toBe(true);
    expect(isActivityStale(record, true, now)).toBe(false);
  });
});
