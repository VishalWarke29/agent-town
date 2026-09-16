import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Group, Sprite, SpriteMaterial, Vector3 } from 'three';
import { activityLabel, type Agent, type AgentActivity, type Repository } from '@agent-town/contracts';
import { findPath, type Point } from './pathfinding';
import { isActivityStale } from './interaction';
import { Block, type Position } from './primitives';
import type { characterTexture } from './sprites';
import { agentDisplayName } from '../agentDisplayName';

const activityMark: Record<AgentActivity, string> = {
  working: '•', testing: 'T', waiting: '!', reporting: '▤', review: '?', idle: 'Ⅱ', offline: '×', failed: '!', cancelled: '■', unknown: '?',
};

interface Props {
  agent: Agent;
  slot: number;
  selected: boolean;
  onSelect: () => void;
  reduced: boolean;
  connected: boolean;
  active: boolean;
  now: number;
  snapshotGeneration: number;
  repositories: Repository[];
  positions: Map<string, Vector3>;
  textures: ReturnType<typeof characterTexture>[][];
  deskAnchor: Position | null;
  deskIndex?: number;
  hidden: boolean;
  labelsInteractive: boolean;
}

/** One simulation owner per saved agent; desks only change its visual anchor. */
export function Character({ agent, slot, selected, onSelect, reduced, connected, active, now, snapshotGeneration, repositories, positions, textures, deskAnchor, deskIndex, hidden, labelsInteractive }: Props) {
  const displayName = agentDisplayName(agent);
  const nativeSessionId = agent.discovery?.nativeSessionId ?? agent.observation?.sessionId;
  const childSession = Boolean(agent.discovery?.parentNativeSessionId ?? agent.observation?.parentSessionId);
  const conversationTitle = agent.discovery?.title;
  const group = useRef<Group>(null);
  const sprite = useRef<Sprite>(null);
  const material = useRef<SpriteMaterial>(null);
  const [hovered, setHovered] = useState(false);
  const route = useRef<Point[]>([]);
  const reportPoint = useMemo<Point>(() => [(slot % 3 - 1) * 0.75, Math.floor(slot / 3) * 0.75 - 0.25], [slot]);
  const target = agent.activity === 'reporting' ? reportPoint : agent.home;
  const canonical = useRef(new Vector3(target[0], 0.05, target[1]));
  const prior = useRef({ key: `${agent.activity}:${target.join(',')}`, generation: snapshotGeneration });
  const elapsed = useRef(0);
  const stale = isActivityStale(agent, connected, now);
  const inRoom = deskAnchor !== null;
  const movingAtDesk = inRoom && !stale && !reduced && (agent.activity === 'working' || agent.activity === 'testing');

  useLayoutEffect(() => {
    const targetKey = `${agent.activity}:${target.join(',')}`;
    const restored = prior.current.generation !== snapshotGeneration;
    if (restored || reduced || !active) {
      canonical.current.set(target[0], 0.05, target[1]);
      route.current = [];
    } else if (prior.current.key !== targetKey) {
      route.current = findPath([canonical.current.x, canonical.current.z], target, repositories.map(repo => ({
        x: repo.position[0], z: repo.position[1], width: repo.id === 'tools' ? 4 : 5.1, depth: 3.8,
      })));
    }
    prior.current = { key: targetKey, generation: snapshotGeneration };
    positions.set(agent.id, canonical.current);
  }, [agent.id, agent.activity, target[0], target[1], repositories, reduced, active, snapshotGeneration, positions]);

  useLayoutEffect(() => {
    if (group.current) {
      if (deskAnchor) group.current.position.set(...deskAnchor);
      else group.current.position.copy(canonical.current);
    }
  }, [deskAnchor?.[0], deskAnchor?.[1], deskAnchor?.[2], hidden, snapshotGeneration, agent.activity]);

  useFrame((_, delta) => {
    elapsed.current += Math.min(delta, 0.05);
    const next = route.current[0];
    let direction = 2;
    if (next && !stale) {
      const dx = next[0] - canonical.current.x, dz = next[1] - canonical.current.z;
      const distance = Math.hypot(dx, dz), step = Math.min(delta, 0.05) * 4.8;
      direction = Math.abs(dx) > Math.abs(dz) ? dx > 0 ? 1 : 3 : dz > 0 ? 2 : 0;
      if (distance <= step || reduced) { canonical.current.set(next[0], 0.05, next[1]); route.current.shift(); }
      else { canonical.current.x += dx / distance * step; canonical.current.z += dz / distance * step; }
    }
    // The camera map always follows canonical work movement, including hidden actors.
    positions.set(agent.id, canonical.current);
    if (!group.current || !material.current) return;
    if (deskAnchor) group.current.position.set(...deskAnchor);
    else group.current.position.copy(canonical.current);
    material.current.map = textures[inRoom ? 2 : direction]![next && !stale && !reduced && !inRoom ? Math.floor(elapsed.current * 8) % 3 : 0]!;
    if (sprite.current) sprite.current.position.y = (inRoom ? 0.68 : 0.89) + (movingAtDesk ? Math.sin(elapsed.current * (agent.activity === 'testing' ? 3 : 4)) * 0.018 : 0);
  });

  useEffect(() => () => { positions.delete(agent.id); }, [agent.id, positions]);

  // Omit the full visual, not only its opacity: hidden actors have no pointer or keyboard target.
  if (hidden) return null;
  return <group ref={group} name={`agent-${agent.id}`} userData={{ agentId: agent.id, location: inRoom ? 'desk' : 'campus' }}>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}><circleGeometry args={[inRoom ? selected ? 0.37 : 0.24 : selected ? 0.55 : 0.34, 24]} /><meshBasicMaterial color={selected ? '#f7e7b7' : '#596d4a'} transparent opacity={selected ? 0.9 : 0.22} depthWrite={false} /></mesh>
    {selected && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.028, 0]}><ringGeometry args={inRoom ? [0.37, 0.41, 24] : [0.55, 0.59, 24]} /><meshBasicMaterial color="#617d5c" /></mesh>}
    <sprite ref={sprite} position={[0, inRoom ? 0.68 : 0.89, 0]} scale={inRoom ? [0.74, 1.04, 1] : [1.1, 1.54, 1]} onClick={event => { event.stopPropagation(); if (event.delta <= 4) onSelect(); }} onPointerOver={event => { event.stopPropagation(); setHovered(true); }} onPointerOut={() => setHovered(false)}>
      <spriteMaterial ref={material} map={textures[2]![0]} transparent alphaTest={0.5} color={stale || agent.activity === 'offline' || agent.activity === 'unknown' ? '#b2b8aa' : '#ffffff'} opacity={stale || agent.activity === 'offline' || agent.activity === 'unknown' ? 0.72 : 1} />
    </sprite>
    {agent.activity === 'reporting' && <Block position={[0.43, 0.8, 0.12]} size={[0.32, 0.33, 0.035]} color="#f8efd6" />}
    {active && (inRoom || selected || hovered || agent.activity === 'waiting') && <Html position={[0, inRoom ? 1.47 : 2.04, 0]} center zIndexRange={[16, 1]} style={{ pointerEvents: labelsInteractive ? 'auto' : 'none' }}>
      <button type="button" className={`agent-label ${inRoom ? 'room-agent-label' : ''}`} data-agent-id={agent.id} data-agent-location={inRoom ? 'desk' : 'campus'} tabIndex={labelsInteractive ? 0 : -1} aria-label={`Inspect ${displayName}${childSession ? ' · Child session' : ''}${inRoom ? ' in workroom' : ''}`} title={`${displayName}${childSession ? ' · Child session' : ''}${conversationTitle && conversationTitle !== displayName ? ` · Conversation: ${conversationTitle}` : ''} · ${activityLabel[agent.activity]}${nativeSessionId ? ` · Session ${nativeSessionId}` : ''}${stale ? ' · Last reported update is stale' : ''}`} onClick={onSelect}>
        <span className={`agent-activity-mark status-${agent.activity}`} data-stale={stale || undefined} aria-hidden="true">{stale ? '◷' : activityMark[agent.activity]}</span>{childSession && <span className="agent-child-mark" aria-hidden="true" style={{ flexShrink: 0, color: 'inherit' }}>↳</span>}{inRoom ? <><span className="room-agent-name">{displayName}</span><span className="room-desk-number" aria-hidden="true">{deskIndex === undefined ? '•' : deskIndex + 1}</span></> : <span className="campus-agent-name" style={{ maxWidth: 180, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: 'inherit' }}>{displayName}</span>}{!inRoom && <small>{agent.provider}</small>}
        <span className="sr-only">{activityLabel[agent.activity]}{stale ? ' · Stale update' : ''}</span>
      </button>
    </Html>}
  </group>;
}
