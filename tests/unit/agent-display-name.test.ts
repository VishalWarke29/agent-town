import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-town/contracts';
import { agentDisplayName, agentSearchText } from '../../apps/web/src/agentDisplayName';

const timestamp = '2026-09-16T02:00:00.000Z';
function actor(overrides: Partial<Agent> = {}): Agent {
  return { id: 'one', name: 'Codex 3', provider: 'Codex', role: 'Worker', repoId: 'project', task: '', activity: 'unknown',
    color: '#999999', home: [1, 2], updatedAt: timestamp, files: [], evidence: '', contextVersion: null, ...overrides };
}

describe('agent display name resolution', () => {
  it('keeps a custom name untouched when there is no discovery record at all', () => {
    expect(agentDisplayName(actor({ name: 'My renamed agent', discovery: undefined }))).toBe('My renamed agent');
  });

  it('keeps a custom name even when it happens to start with the provider, once observed', () => {
    const agent = actor({ name: 'Codex reviewer', discovery: { sourceId: 's', nativeSessionId: 'abcdefgh1234', discoveredAt: timestamp, nativeUpdatedAt: null },
      observation: { connectionId: 'c', sessionId: 'one', parentSessionId: null, lastSequence: null, sourceTime: timestamp, freshness: 'current', billing: 'unavailable' } });
    expect(agentDisplayName(agent)).toBe('Codex reviewer');
  });

  it('recognizes the "provider · first-8-of-id" generated name even without an observation', () => {
    const agent = actor({ name: 'Codex · abcdefgh', discovery: { sourceId: 's', nativeSessionId: 'abcdefgh1234', discoveredAt: timestamp, nativeUpdatedAt: null } });
    // no nativeAgentName/title available, so it falls back to the id-derived label using the LAST 8 characters
    expect(agentDisplayName(agent)).toBe('Codex · …efgh1234');
  });

  it('recognizes the "provider N" generated name only once the session has been observed', () => {
    const withoutObservation = actor({ name: 'Codex 3', discovery: { sourceId: 's', nativeSessionId: 'abcdefgh1234', discoveredAt: timestamp, nativeUpdatedAt: null } });
    expect(agentDisplayName(withoutObservation)).toBe('Codex 3');
    const observed = actor({ ...withoutObservation, observation: { connectionId: 'c', sessionId: 'one', parentSessionId: null, lastSequence: null, sourceTime: timestamp, freshness: 'current', billing: 'unavailable' } });
    expect(agentDisplayName(observed)).toBe('Codex · …efgh1234');
  });

  it('rejects "provider N" look-alikes with a leading zero, a non-digit suffix, or zero itself', () => {
    const discovery = { sourceId: 's', nativeSessionId: 'abcdefgh1234', discoveredAt: timestamp, nativeUpdatedAt: null };
    const observation = { connectionId: 'c', sessionId: 'one', parentSessionId: null, lastSequence: null, sourceTime: timestamp, freshness: 'current' as const, billing: 'unavailable' as const };
    for (const name of ['Codex 0', 'Codex 03', 'Codex 3a', 'Codex ', 'Codex']) expect(agentDisplayName(actor({ name, discovery, observation }))).toBe(name);
  });

  it('prefers the native agent name over the session title when the name is generated', () => {
    const observation = { connectionId: 'c', sessionId: 'one', parentSessionId: null, lastSequence: null, sourceTime: timestamp, freshness: 'current' as const, billing: 'unavailable' as const };
    const discovery = { sourceId: 's', nativeSessionId: 'abcdefgh1234', title: 'Fix the flaky test', nativeAgentName: 'reviewer-bot', discoveredAt: timestamp, nativeUpdatedAt: null };
    expect(agentDisplayName(actor({ name: 'Codex 7', discovery, observation }))).toBe('reviewer-bot');
    expect(agentDisplayName(actor({ name: 'Codex 7', discovery: { ...discovery, nativeAgentName: undefined }, observation }))).toBe('Fix the flaky test');
    expect(agentDisplayName(actor({ name: 'Codex 7', discovery: { ...discovery, nativeAgentName: undefined, title: undefined }, observation }))).toBe('Codex · …efgh1234');
  });

  it('omits the ellipsis and pads nothing when the native session id is 8 characters or shorter', () => {
    const exactlyEight = actor({ name: 'Codex · 12345678', discovery: { sourceId: 's', nativeSessionId: '12345678', discoveredAt: timestamp, nativeUpdatedAt: null } });
    expect(agentDisplayName(exactlyEight)).toBe('Codex · 12345678');
    const short = actor({ name: 'Codex · abc', discovery: { sourceId: 's', nativeSessionId: 'abc', discoveredAt: timestamp, nativeUpdatedAt: null } });
    expect(agentDisplayName(short)).toBe('Codex · abc');
  });

  it('does not mutate the agent record it inspects', () => {
    const agent = actor({ name: 'Codex 3', discovery: { sourceId: 's', nativeSessionId: 'abcdefgh1234', discoveredAt: timestamp, nativeUpdatedAt: null },
      observation: { connectionId: 'c', sessionId: 'one', parentSessionId: null, lastSequence: null, sourceTime: timestamp, freshness: 'current', billing: 'unavailable' } });
    const before = structuredClone(agent);
    agentDisplayName(agent);
    expect(agent).toEqual(before);
  });
});

describe('agent search text', () => {
  it('folds the resolved display name and identifying fields into one lowercase, space-joined string', () => {
    const agent = actor({ name: 'Codex 3', role: 'Reviewer', task: 'Ship the release',
      discovery: { sourceId: 's', nativeSessionId: 'abcdefgh1234', title: 'Fix the flaky test', nativeAgentName: 'Reviewer-Bot', discoveredAt: timestamp, nativeUpdatedAt: null },
      observation: { connectionId: 'c', sessionId: 'one', parentSessionId: null, lastSequence: null, sourceTime: timestamp, freshness: 'current', billing: 'unavailable' } });
    const text = agentSearchText(agent);
    expect(text).toBe(text.toLowerCase());
    for (const token of ['reviewer-bot', 'codex 3', 'codex', 'reviewer', 'ship the release', 'fix the flaky test', 'abcdefgh1234', 'one'])
      expect(text).toContain(token);
  });

  it('omits missing optional fields cleanly instead of leaving blank tokens', () => {
    const agent = actor({ name: 'My renamed agent', role: 'Worker', task: '', discovery: undefined, observation: undefined });
    expect(agentSearchText(agent)).toBe('my renamed agent my renamed agent codex worker');
  });
});
