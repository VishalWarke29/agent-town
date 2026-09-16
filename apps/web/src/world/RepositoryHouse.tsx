import { useEffect, useMemo, useState } from 'react';
import { Html } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { Repository } from '@agent-town/contracts';
import { Block, type Position } from './primitives';
import { houseWidth, roomDeskPositions } from './room-layout';

function Roof({ color, width, depth }: { color: string; width: number; depth: number }) {
  const geometry = useMemo(() => {
    const w = width / 2, d = depth / 2;
    const vertices = [-w, 0, -d, w, 0, -d, w, 1.25, 0, -w, 0, -d, w, 1.25, 0, -w, 1.25, 0,
      -w, 1.25, 0, w, 1.25, 0, w, 0, d, -w, 1.25, 0, w, 0, d, -w, 0, d,
      -w, 0, d, -w, 0, -d, -w, 1.25, 0, w, 0, -d, w, 0, d, w, 1.25, 0];
    const result = new BufferGeometry();
    result.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    result.setIndex(Array.from({ length: vertices.length / 3 }, (_, i) => Math.floor(i / 3) * 3 + 2 - i % 3));
    result.computeVertexNormals();
    return result;
  }, [width, depth]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <group position={[0, 2.55, 0]}>
    <mesh geometry={geometry} castShadow receiveShadow><meshStandardMaterial color={color} roughness={1} /></mesh>
    {[-1, -0.5, 0, 0.5, 1].map((z, i) => <Block key={i} position={[0, 1.27 - Math.abs(z) * 1.25 / (depth / 2), z]} size={[width + 0.04, 0.035, 0.04]} color={color} />)}
    <Block position={[0, 1.26, 0]} size={[width + 0.15, 0.12, 0.14]} color={color} />
  </group>;
}

function Desk({ position }: { position: Position }) {
  return <group position={position}>
    <Block position={[0, 0.55, -0.08]} size={[0.94, 0.12, 0.6]} color="#bb946a" />
    {[-0.34, 0.34].map(x => <Block key={x} position={[x, 0.25, -0.08]} size={[0.08, 0.5, 0.42]} color="#826e55" />)}
    <Block position={[0, 0.78, -0.25]} size={[0.43, 0.34, 0.06]} color="#536b64" />
    <Block position={[0, 0.78, -0.212]} size={[0.35, 0.25, 0.01]} color="#c3d1b8" />
    <Block position={[0, 0.62, -0.01]} size={[0.4, 0.025, 0.14]} color="#e3dac4" />
    <Block position={[0.33, 0.65, 0.03]} size={[0.1, 0.12, 0.1]} color="#eee0bc" />
    <Block position={[0, 0.3, 0.45]} size={[0.4, 0.1, 0.37]} color="#738974" />
    <Block position={[0, 0.43, 0.62]} size={[0.4, 0.33, 0.08]} color="#738974" />
  </group>;
}

interface Props {
  repo: Repository;
  selected: boolean;
  open: boolean;
  labelsActive: boolean;
  labelsInteractive: boolean;
  onSelect: () => void;
}

export function RepositoryHouse({ repo, selected, open, labelsActive, labelsInteractive, onSelect }: Props) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const width = houseWidth(repo);
  const activate = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (event.delta <= 4) onSelect();
  };
  return <group name={`repository-${repo.id}`} position={[repo.position[0], 0, repo.position[1]]} onClick={activate} onPointerOver={event => { event.stopPropagation(); setHovered(true); }} onPointerOut={() => setHovered(false)}>
    <Block position={[0, 0.1, 0.1]} size={[width + 1, 0.2, 4.6]} color={selected || hovered || focused ? '#e6d5a9' : '#c3bea6'} />
    <Block position={[0, 0.22, 0]} size={[width + 0.05, 0.18, 3.25]} color={open ? '#d7bc92' : '#bcab8f'} />
    <Block position={[0, 1.4, -1.5]} size={[width, 2.3, 0.2]} color="#ebdfc4" />
    <Block position={[-width / 2 + 0.1, 1.4, 0]} size={[0.2, 2.3, 3.2]} color="#e5d5b6" />
    {open ? <group name={`workroom-${repo.id}`}>
      <Block position={[0, 0.36, -1.37]} size={[width - 0.35, 0.12, 0.06]} color="#a38766" />
      <Block position={[-width / 2 + 0.23, 0.36, 0]} size={[0.06, 0.12, 2.9]} color="#a38766" />
      <Block position={[0.55, 1.58, -1.37]} size={[1.15, 0.58, 0.035]} color="#9cab87" />
      <Block position={[0.55, 1.58, -1.342]} size={[1.02, 0.45, 0.02]} color="#e6e6cc" />
      {roomDeskPositions(repo).map((position, index) => <Desk key={index} position={position} />)}
      {[-1, 0, 1].map(x => <Block key={x} position={[x * (width - 0.45) / 3, 0.318, 0]} size={[0.012, 0.008, 2.96]} color="#c8ab82" />)}
    </group> : <>
      <Block position={[0, 1.4, 1.5]} size={[width, 2.3, 0.2]} color="#ebdfc4" />
      <Block position={[width / 2 - 0.1, 1.4, 0]} size={[0.2, 2.3, 3.2]} color="#ebdfc4" />
      <Roof color={repo.color} width={width + 0.6} depth={3.9} />
      <Block position={[width / 2 - 0.7, 3.4, -0.8]} size={[0.5, 1.3, 0.55]} color="#c4ad91" />
      <Block position={[width / 2 - 0.7, 4.08, -0.8]} size={[0.65, 0.14, 0.7]} color="#a38e74" />
      <Block position={[0, 0.99, 1.64]} size={[0.86, 1.65, 0.13]} color="#6b7c71" />
      <Block position={[0, 1.23, 1.72]} size={[0.6, 0.8, 0.035]} color="#bed1c3" />
      <Block position={[0.28, 0.8, 1.76]} size={[0.07, 0.07, 0.07]} color="#e8c88b" />
      {[-1, 1].map(side => <group key={side} position={[side * (width / 2 - 0.8), 1.55, 1.64]}>
        <Block position={[0, 0, 0]} size={[0.95, 0.95, 0.13]} color="#9e8d72" />
        <Block position={[0, 0, 0.08]} size={[0.76, 0.78, 0.04]} color="#a6bfb5" />
        <Block position={[0, 0, 0.12]} size={[0.06, 0.8, 0.04]} color="#f5e7ce" />
        <Block position={[0, 0, 0.12]} size={[0.8, 0.06, 0.04]} color="#f5e7ce" />
        <Block position={[0, -0.55, 0.12]} size={[1.15, 0.2, 0.4]} color={repo.color} />
        <Block position={[0, -0.41, 0.13]} size={[0.95, 0.16, 0.27]} color="#879869" />
      </group>)}
      {[0, 1].map(i => <group key={i} position={[width / 2 + 0.025, 1.6, i * 1.45 - 0.7]}>
        <Block position={[0, 0, 0]} size={[0.06, 0.95, 0.8]} color="#a1b9ae" />
        <Block position={[0.035, 0, 0]} size={[0.04, 0.97, 0.06]} color="#f2e5c9" />
        <Block position={[0.035, 0, 0]} size={[0.04, 0.06, 0.82]} color="#f2e5c9" />
      </group>)}
    </>}
    <Block position={[0, 0.19, 1.95]} size={[1.35, 0.28, 0.65]} color="#d0c2a5" />
    <group position={[-width / 2 - 0.1, 0, 2]}>
      <Block position={[0, 0.19, 0]} size={[0.8, 0.38, 0.55]} color="#ba9875" />
      <Block position={[0, 0.44, 0]} size={[0.65, 0.22, 0.4]} color="#879869" />
      <Block position={[0.1, 0.59, 0]} size={[0.17, 0.12, 0.17]} color="#ddb78e" />
    </group>
    {labelsActive && !open && <Html position={[0, 4.6, -0.3]} center zIndexRange={[12, 1]} style={{ pointerEvents: labelsInteractive ? 'auto' : 'none' }}>
      <button type="button" data-repo-id={repo.id} data-room-open={open} tabIndex={labelsInteractive ? 0 : -1} className={`world-label ${selected || open ? 'selected' : ''}`} aria-expanded={open} onClick={onSelect} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}><span className="label-dot" style={{ background: repo.color }} />{repo.name}</button>
    </Html>}
  </group>;
}
