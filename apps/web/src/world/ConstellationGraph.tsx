import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import type { Group } from 'three';
import type { DbSchemaSnapshot } from '@agent-town/contracts';
import { layoutConstellation, type StarNode } from './constellationLayout';
import { tableColor } from './colorVariants';

const FILE_COLOR: Record<string, string> = { workspace: '#e8e2c0', identity: '#e0c9a0' };
const UNAVAILABLE_COLOR = '#8f8d80';

function starSize(rowCount: number | null): number {
  if (rowCount === null) return 0.12;
  return 0.13 + Math.log10(rowCount + 1) * 0.07;
}

function StarDetailCard({ node }: { node: StarNode }) {
  return <div className="orbit-detail">
    <strong>{node.label}</strong>
    <span className="orbit-detail-meta">{node.rowCount === null ? 'rows unavailable' : `${node.rowCount} row${node.rowCount === 1 ? '' : 's'}`}</span>
    <ul>
      {node.columns.map(column => <li key={column.name}>{column.primaryKey ? <b>{column.name} (primary key)</b> : column.name}</li>)}
      {node.hiddenColumnCount > 0 && <li>{node.hiddenColumnCount} hidden for privacy</li>}
    </ul>
    {node.outgoingForeignKey
      ? <p className="orbit-detail-fk">{node.outgoingForeignKey.column} &rarr; {node.outgoingForeignKey.toTable}.{node.outgoingForeignKey.toColumn}</p>
      : <p className="orbit-detail-fk muted">No foreign key from this table</p>}
  </div>;
}

function Star({ node, twinklePhase }: { node: StarNode; twinklePhase: number }) {
  const grow = useRef<Group>(null);
  const progress = useRef(0);
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const size = starSize(node.rowCount);
  useFrame(({ clock }, delta) => {
    progress.current = Math.min(1, progress.current + delta / 0.6);
    const twinkle = 1 + Math.sin(clock.elapsedTime * 2.2 + twinklePhase) * 0.12;
    grow.current?.scale.setScalar(Math.max(0.04, progress.current) * twinkle);
  });
  const color = node.rowCount === null ? UNAVAILABLE_COLOR : tableColor(FILE_COLOR[node.fileKind] ?? FILE_COLOR.workspace!, node.label);
  return <group position={[node.x, 0, node.z]}>
    <group ref={grow}>
      <mesh
        onPointerOver={(event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); setHovered(true); }}
        onPointerOut={() => setHovered(false)}
        onClick={(event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); setExpanded(value => !value); }}
      >
        <sphereGeometry args={[size, 14, 12]} />
        <meshStandardMaterial color={hovered || expanded ? '#fff4d6' : color} emissive={color} emissiveIntensity={0.7} roughness={0.5} />
      </mesh>
    </group>
    {expanded ? <Html position={[0, size + 0.3, 0]} center zIndexRange={[9, 1]}><StarDetailCard node={node} /></Html>
      : <Html position={[0, size + 0.3, 0]} center zIndexRange={[8, 1]}>
        <span className={`orbit-label ${hovered ? 'orbit-label-active' : ''}`}>{node.label}{hovered && (node.rowCount === null ? ' · unavailable' : ` · ${node.rowCount} rows`)}</span>
      </Html>}
  </group>;
}

/** The alternative "constellation" view: every table is a star, placed by a force-directed layout
 * where distance falls out of relationship strength (foreign keys pull two stars together, everything
 * else repels) — the general "data constellation" convention, distinct from the Solar System view's
 * fixed sun/orbit hierarchy. Foreign keys draw as faint connecting lines, like a star chart. No
 * central body, no orbital motion — a scattered field instead of a hierarchy, useful when the
 * relationships matter more than which table is "central". */
export function ConstellationGraph({ snapshot, origin }: { snapshot: DbSchemaSnapshot; origin: [number, number, number] }) {
  const { nodes, links } = useMemo(() => layoutConstellation(snapshot.groups), [snapshot]);
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  return <group position={origin}>
    {nodes.map((node, i) => <Star key={node.id} node={node} twinklePhase={i * 1.7} />)}
    {links.map((link, index) => {
      const from = byId.get(link.from), to = byId.get(link.to);
      if (!from || !to) return null;
      return <Line key={index} points={[[from.x, 0, from.z], [to.x, 0, to.z]]} color="#c9c2a0" lineWidth={1} transparent opacity={0.55} />;
    })}
  </group>;
}
