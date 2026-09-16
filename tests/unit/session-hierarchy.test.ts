import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-town/contracts';
import { matchingSessionParents, sessionHierarchy, sessionParentId } from '../../apps/web/src/sessionHierarchy';

const timestamp = '2026-09-16T02:00:00.000Z';
function actor(id: string, parent?: string, overrides: Partial<Agent> = {}): Agent {
  return { id, name: 'The same display name', provider: 'Codex', role: 'Worker', repoId: 'project', task: '', activity: 'unknown',
    color: '#999999', home: [1, 2], updatedAt: timestamp, files: [], evidence: '', contextVersion: null,
    discovery: { sourceId: 'source', nativeSessionId: id, ...(parent ? { parentNativeSessionId: parent } : {}),
      title: 'The same title', nativeAgentName: 'The same nickname', discoveredAt: timestamp, nativeUpdatedAt: null }, ...overrides };
}
const ids = (agents: readonly Agent[]) => agents.map(agent => agent.id);
function observed(id: string, parent: string | null, connectionId = 'connection', nativeSourceId?: string): Agent {
  return actor(id, undefined, { discovery: undefined, observation: { connectionId, sessionId: id, parentSessionId: parent,
    nativeSourceId, lastSequence: null, sourceTime: timestamp, freshness: 'current', billing: 'unavailable' } });
}

describe('saved visible session hierarchy', () => {
  it('groups nested children in input order while keeping all identities and records untouched', () => {
    const root = actor('root'), child = actor('child', 'root'), grandchild = actor('grandchild', 'child'), sibling = actor('sibling', 'root'), other = actor('other');
    const agents = [grandchild, other, sibling, root, child];
    const before = structuredClone(agents);
    Object.freeze(agents);
    const result = sessionHierarchy(agents);
    expect(ids(result.primary)).toEqual(['other', 'root']);
    expect(ids(result.children)).toEqual(['grandchild', 'sibling', 'child']);
    expect(result.unresolved).toEqual([]);
    expect(result.parentById.get('grandchild')).toBe(child);
    expect(ids(result.childrenById.get('root')!)).toEqual(['sibling', 'child']);
    expect(ids(result.descendantsById.get('root')!)).toEqual(['grandchild', 'sibling', 'child']);
    expect(ids(result.descendantsById.get('child')!)).toEqual(['grandchild']);
    expect(agents).toEqual(before);
    expect(agents.find(agent => agent.id === 'grandchild')).toBe(grandchild);
  });

  it('keeps three roots and fifteen independent child records without grouping by names or roles', () => {
    const roots = [actor('one'), actor('two'), actor('three')];
    const children = Array.from({ length: 15 }, (_, index) => actor(`child-${index}`, roots[index % 3]!.id));
    const unrelated = actor('unrelated', undefined, { role: 'Discovered child session' });
    const result = sessionHierarchy([...roots, ...children, unrelated]);
    expect(ids(result.primary)).toEqual(['one', 'two', 'three', 'unrelated']);
    expect(result.children).toHaveLength(15);
    expect(new Set([...result.primary, ...result.children].map(agent => agent.id)).size).toBe(19);
    for (const root of roots) expect(result.descendantsById.get(root.id)).toHaveLength(5);
  });

  it('matches native IDs within their source, repository and provider only', () => {
    const root = actor('root'), child = actor('child', 'root');
    const otherSource = actor('other-source'); otherSource.discovery!.nativeSessionId = 'root'; otherSource.discovery!.sourceId = 'elsewhere';
    const otherRepo = actor('other-repo', undefined, { repoId: 'other-project' }); otherRepo.discovery!.nativeSessionId = 'root';
    const otherProvider = actor('other-tool', undefined, { provider: 'Cursor' }); otherProvider.discovery!.nativeSessionId = 'root';
    expect(matchingSessionParents(child, [otherSource, otherRepo, otherProvider, root])).toEqual([root]);
    for (const foreign of [otherSource, otherRepo, otherProvider]) {
      const result = sessionHierarchy([child, foreign]);
      expect(ids(result.primary)).toEqual(['child', foreign.id]);
      expect(result.unresolved).toEqual([child]);
    }
  });

  it('keeps missing and ambiguous parents visible, with known children below the unresolved group', () => {
    const missing = actor('missing', 'not-loaded'), descendant = actor('descendant', 'missing');
    const result = sessionHierarchy([descendant, missing]);
    expect(result.primary).toEqual([missing]); expect(result.unresolved).toEqual([missing]);
    expect(result.children).toEqual([descendant]);
    const duplicate = actor('duplicate'); duplicate.discovery!.nativeSessionId = 'root';
    const child = actor('child', 'root');
    const ambiguous = sessionHierarchy([actor('root'), duplicate, child]);
    expect(ambiguous.parentById.has(child.id)).toBe(false); expect(ambiguous.unresolved).toEqual([child]);
  });

  it('does not attach self parents, cycles, or descendants whose ancestry enters a cycle', () => {
    const self = actor('self', 'self'), a = actor('a', 'b'), b = actor('b', 'a'), child = actor('child', 'a'), selfChild = actor('self-child', 'self'), root = actor('root');
    const agents = [child, b, root, selfChild, self, a];
    const result = sessionHierarchy(agents);
    expect(result.primary).toEqual(agents); expect(result.children).toEqual([]);
    expect(ids(result.unresolved)).toEqual(['child', 'b', 'self-child', 'self', 'a']);
    expect(result.parentById.size).toBe(0);
    expect([...result.descendantsById.values()].flat()).toEqual([]);
  });

  it('uses legacy connection identity only when neither actor has a native source', () => {
    const parent = observed('parent', null), child = observed('child', 'parent');
    expect(sessionHierarchy([child, parent]).parentById.get(child.id)).toBe(parent);
    for (const alternative of [observed('parent', null, 'another'), observed('parent', null, 'connection', 'source')]) {
      expect(sessionHierarchy([child, alternative]).unresolved).toEqual([child]);
    }
    const nativeChild = observed('child', 'parent', 'new-connection', 'source');
    const nativeParent = observed('parent', null, 'old-connection', 'source');
    expect(sessionHierarchy([nativeChild, nativeParent]).parentById.get(nativeChild.id)).toBe(nativeParent);
    const conflicting = actor('conflicting', 'parent', { observation: observed('conflicting', 'parent', 'connection', 'another-source').observation });
    expect(sessionHierarchy([conflicting, nativeParent]).unresolved).toEqual([conflicting]);
  });

  it('uses canonical discovery identities and leaves unavailable hidden or archived parents unresolved', () => {
    const root = actor('root'), child = actor('child', 'root', { observation: observed('transport-child', 'root').observation });
    expect(sessionParentId(child)).toBe('root');
    const full = sessionHierarchy([child, root]);
    expect(full.parentById.get(child.id)).toBe(root);
    const withoutParent = sessionHierarchy([child]);
    expect(withoutParent.primary).toEqual([child]); expect(withoutParent.unresolved).toEqual([child]);
    expect(full.children[0]).toBe(child); expect(child.id).toBe('child');
    expect(sessionHierarchy([child, root]).parentById.get(child.id)).toBe(root);
  });

  it('handles the 200-actor chain iteratively and refuses duplicate actor IDs as grouping keys', () => {
    const agents = Array.from({ length: 200 }, (_, index) => actor(String(index), index ? String(index - 1) : undefined));
    const result = sessionHierarchy(agents);
    expect(ids(result.primary)).toEqual(['0']); expect(result.children).toHaveLength(199);
    expect(result.descendantsById.get('0')).toHaveLength(199);
    expect(result.descendantsById.get('198')).toEqual([agents[199]]);
    const child = actor('child', 'duplicate'), first = actor('duplicate'), second = actor('duplicate');
    const malformed = sessionHierarchy([child, first, second]);
    expect(malformed.primary).toEqual([child, first, second]);
    expect(malformed.children).toEqual([]); expect(malformed.unresolved).toEqual([child, first, second]);
  });
});
