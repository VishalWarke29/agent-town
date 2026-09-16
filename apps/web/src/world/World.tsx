import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, RoundedBox } from '@react-three/drei';
import { Mesh, MeshBasicMaterial, PCFShadowMap, Vector3 } from 'three';
import type { Agent, Repository, TownState } from '@agent-town/contracts';
import { characterTexture } from './sprites';
import { campusBounds } from './layout';
import { CameraRig } from './CameraRig';
import { RepositoryHouse } from './RepositoryHouse';
import { Character } from './Character';
import { Block } from './primitives';
import { roomAgentAnchor } from './room-layout';
import { canUseDesk, ROOM_PAGE_SIZE, type CameraAction, type RoomView, type Selection } from './interaction';

export type { Selection, CameraAction } from './interaction';
interface Props {
  state: TownState;
  selection: Selection | null;
  onSelect: (value: Selection) => void;
  follow: string | null;
  onStopFollow: () => void;
  cameraAction: CameraAction;
  reducedMotion: boolean;
  active: boolean;
  room: RoomView | null;
  connected: boolean;
  snapshotGeneration: number;
  labelsInteractive?: boolean;
  onUnavailable: () => void;
}
function Tree({ x, z, scale = 1, kind = 0 }: { x: number; z: number; scale?: number; kind?: number }) {
  return <group position={[x, 0, z]} scale={scale}>
    <mesh position={[0, 0.8, 0]} castShadow><cylinderGeometry args={[0.13, 0.2, 1.6, 5]} /><meshStandardMaterial color="#796b50" /></mesh>
    {kind % 3 === 0 ? [0, 1, 2].map(i => <mesh key={i} position={[0, 1.25 + i * 0.62, 0]} castShadow><coneGeometry args={[1.05 - i * 0.22, 1.65, 7]} /><meshStandardMaterial color={['#5a785c', '#668464', '#799171'][i]} /></mesh>) : <>
      <mesh position={[0, 2, 0]} castShadow><icosahedronGeometry args={[1.25, 1]} /><meshStandardMaterial color={kind % 2 ? '#879762' : '#6f8e68'} flatShading /></mesh>
      <mesh position={[-0.6, 1.5, 0.3]} castShadow><icosahedronGeometry args={[0.8, 0]} /><meshStandardMaterial color="#799069" flatShading /></mesh>
    </>}
  </group>;
}

function Planter({ x, z, color = '#ddb78e' }: { x: number; z: number; color?: string }) {
  return <group position={[x, 0, z]}>
    <Block position={[0, 0.19, 0]} size={[0.8, 0.38, 0.55]} color="#ba9875" />
    <Block position={[0, 0.4, 0]} size={[0.74, 0.08, 0.49]} color="#77674f" />
    {[-0.23, 0, 0.23].map((p, i) => <group key={p} position={[p, 0.56, (i % 2) * 0.13 - 0.05]}><Block position={[0, 0, 0]} size={[0.12, 0.25, 0.12]} color="#7b9366" /><Block position={[0, 0.14, 0]} size={[0.22, 0.13, 0.22]} color={color} /></group>)}
  </group>;
}

function Bench({ x, z, rotation = 0 }: { x: number; z: number; rotation?: number }) {
  return <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
    {[-0.6, 0.6].map(p => <Block key={p} position={[p, 0.25, 0]} size={[0.12, 0.5, 0.5]} color="#53645b" />)}
    {[0, 1, 2].map(p => <Block key={p} position={[0, 0.55, p * 0.18 - 0.18]} size={[1.7, 0.12, 0.14]} color="#b29773" />)}
    <Block position={[0, 0.93, -0.28]} size={[1.7, 0.4, 0.12]} color="#b29773" />
  </group>;
}

function Lamp({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <Block position={[0, 1.05, 0]} size={[0.09, 2.1, 0.09]} color="#53675c" />
    <Block position={[0, 2.2, 0]} size={[0.3, 0.4, 0.3]} color="#f2dfad" />
    <Block position={[0, 2.44, 0]} size={[0.4, 0.1, 0.4]} color="#53675c" />
  </group>;
}

function Terrain({ repositories, reportingAgents, agents }: { repositories: Repository[]; reportingAgents: number; agents: Agent[] }) {
  const bounds = campusBounds(repositories, reportingAgents, agents);
  const width = bounds.maxX - bounds.minX, depth = bounds.maxZ - bounds.minZ;
  const centerX = (bounds.maxX + bounds.minX) / 2, centerZ = (bounds.maxZ + bounds.minZ) / 2;
  const trees = useMemo(() => [
    [-12, -8, 1.2], [-10, -9, 1], [-7.5, -10, 0.9], [-3.5, -9, 1.1], [-1, -9.5, 1.3], [2, -10, 0.95], [6.5, -9.5, 1.15], [10, -8, 1.1], [12.5, -6.5, 1.4],
    [-13, -4, 1.1], [-12, -1, 1.25], [-12.5, 3, 1], [-11.5, 6, 1.3], [-10, 9, 1.05], [-7, 9.6, 0.8], [-4, 9.6, 0.9], [0, 10, 1.1], [12.3, -2, 1], [12.5, 1, 0.8], [12, 8.5, 1.2], [10, 10, 0.95],
  ], []);
  return <group>
    <RoundedBox args={[width, 0.75, depth]} radius={0.35} smoothness={3} position={[centerX, -0.55, centerZ]} receiveShadow><meshStandardMaterial color="#c4b698" /></RoundedBox>
    <RoundedBox args={[width - 0.15, 0.2, depth - 0.15]} radius={0.09} smoothness={2} position={[centerX, -0.1, centerZ]} receiveShadow><meshStandardMaterial color="#a9b987" /></RoundedBox>
    {bounds.maxX > 15 && <>
      <Block position={[(bounds.maxX + 8) / 2, 0.018, 1.4]} size={[bounds.maxX - 8 - 2, 0.03, 2]} color="#d8cfb4" />
      {[...new Set(repositories.filter(repo => repo.position[0] > 15).map(repo => repo.position[1]))].map(z => <Block key={z} position={[(bounds.maxX + 12) / 2, 0.018, z + 3]} size={[bounds.maxX - 12 - 2, 0.03, 1.6]} color="#d8cfb4" />)}
      <Block position={[13.5, 0.019, (bounds.maxZ - 4) / 2]} size={[1.8, 0.03, bounds.maxZ + 2]} color="#d8cfb4" />
    </>}
    {bounds.maxZ > 12 && <Block position={[0, 0.021, (bounds.maxZ + 7) / 2]} size={[2.5, 0.03, bounds.maxZ - 7 - 1]} color="#d8cfb4" />}
    <Block position={[0, 0.012, 1.4]} size={[24, 0.035, 2]} color="#d8cfb4" />
    <Block position={[0, 0.017, 0]} size={[2.5, 0.04, 18]} color="#d8cfb4" />
    <Block position={[-6, 0.02, 0]} size={[1.6, 0.04, 5]} color="#d8cfb4" />
    <Block position={[5.7, 0.02, -0.8]} size={[1.6, 0.04, 5.8]} color="#d8cfb4" />
    <Block position={[-4.5, 0.02, 6.5]} size={[9, 0.04, 1.8]} color="#d8cfb4" />
    <Block position={[5, 0.02, 4.6]} size={[8.2, 0.04, 7]} color="#b8c396" />
    {Array.from({ length: 24 }, (_, i) => <Block key={i} position={[-11.5 + i, 0.037, 1.4]} size={[0.015, 0.008, 1.96]} color="#c6bfa6" />)}
    {Array.from({ length: 17 }, (_, i) => <Block key={i} position={[0, 0.04, -8 + i]} size={[2.46, 0.008, 0.016]} color="#c6bfa6" />)}
    {trees.map(([x, z, scale], i) => <Tree key={i} x={x!} z={z!} scale={scale} kind={i} />)}
    {Array.from({ length: 56 }, (_, i) => {
      const x = Math.sin(i * 127.1) * 13.5, z = Math.cos(i * 53.6) * 10.8;
      return Math.abs(x) > 9 || Math.abs(z) > 8 ? <group key={i} position={[x, 0.08, z]}><Block position={[0, 0, 0]} size={[0.13, 0.13, 0.13]} color={i % 3 ? '#c5cc97' : '#eed7ab'} /><Block position={[0.16, -0.02, 0.1]} size={[0.1, 0.1, 0.1]} color="#879b6b" /></group> : null;
    })}
    <Bench x={3.5} z={5.8} /><Bench x={7.2} z={3.4} rotation={-Math.PI / 2} />
    <Planter x={3.5} z={3} color="#c5959d" /><Planter x={7.6} z={6} color="#e4c686" />
    <Lamp x={-2.2} z={2.8} /><Lamp x={8.8} z={0.1} /><Lamp x={-8.8} z={0.1} />
    <group position={[9, 0, 7.8]}>
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.55, 1, 1]} receiveShadow><circleGeometry args={[1.65, 16]} /><meshStandardMaterial color="#c4bfa1" /></mesh>
      <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.55, 1, 1]}><circleGeometry args={[1.38, 16]} /><meshStandardMaterial color="#8aafb0" roughness={0.3} /></mesh>
      <Block position={[-0.3, 0.055, 0.3]} size={[0.8, 0.015, 0.035]} color="#bfd0c5" />
      <Block position={[0.55, 0.055, -0.3]} size={[0.55, 0.015, 0.035]} color="#bfd0c5" />
    </group>
    <Html position={[5, 0.1, 7.2]} center zIndexRange={[10, 1]}><span className="place-label">REVIEW GARDEN</span></Html>
    {[-1, 1].map(side => <group key={side} position={[side * 3.6, 0, -7]}><Block position={[0, 0.38, 0]} size={[2.4, 0.65, 0.55]} color="#93a578" /><Planter x={0} z={0.1} /></group>)}
  </group>;
}

function Manager({ selected, pending, onSelect, active, labelsInteractive }: { selected: boolean; pending: number; onSelect: () => void; active: boolean; labelsInteractive: boolean }) {
  const texture = useMemo(() => characterTexture('#65786c', 2, 0, true), []);
  useEffect(() => () => texture.dispose(), [texture]);
  return <group position={[0, 0, -2]}>
    <mesh position={[0, 0.055, 0.3]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow><circleGeometry args={[2.1, 32]} /><meshStandardMaterial color={selected ? '#e6d6af' : '#d3c5a5'} /></mesh>
    <sprite position={[0, 1.07, -0.15]} scale={[1.1, 1.54, 1]} onClick={e => { e.stopPropagation(); onSelect(); }}><spriteMaterial map={texture} transparent alphaTest={0.5} /></sprite>
    <group position={[0, 0, 0.8]} onClick={e => { e.stopPropagation(); onSelect(); }}>
      <Block position={[0, 0.73, 0]} size={[1.95, 0.18, 0.88]} color="#ad8d63" />
      {[-0.75, 0.75].map(x => <Block key={x} position={[x, 0.37, 0]} size={[0.15, 0.74, 0.65]} color="#8e7656" />)}
      <Block position={[-0.4, 0.85, -0.15]} size={[0.5, 0.03, 0.33]} color="#f3e9ce" />
      <Block position={[0.35, 1.06, -0.15]} size={[0.5, 0.4, 0.07]} color="#526b61" />
      <Block position={[0.35, 1.07, -0.105]} size={[0.39, 0.28, 0.02]} color="#bfceb1" />
    </group>
    {active && <Html position={[0, 2.4, 0]} center zIndexRange={[15, 1]} style={{ pointerEvents: labelsInteractive ? 'auto' : 'none' }}><button className="world-label manager-label" tabIndex={labelsInteractive ? 0 : -1} onClick={onSelect}>✦ Town manager{pending > 0 && <span className="count">{pending}</span>}</button></Html>}
  </group>;
}

function ServicePulse({ repo, receivedAt, reduced }: { repo: Repository; receivedAt: string; reduced: boolean }) {
  const mesh = useRef<Mesh>(null), material = useRef<MeshBasicMaterial>(null);
  const received = Date.parse(receivedAt);
  useFrame(() => {
    if (!mesh.current || !material.current) return;
    const age = Date.now() - received;
    mesh.current.visible = Number.isFinite(age) && age >= 0 && age < 8000;
    const progress = reduced ? 0 : (age % 1600) / 1600;
    mesh.current.scale.setScalar(1 + progress * 1.8);
    material.current.opacity = reduced ? 0.7 : (1 - progress) * 0.7;
  });
  return <mesh ref={mesh} position={[repo.position[0] + 3.2, 0.08, repo.position[1] + 2.8]} rotation={[-Math.PI / 2, 0, 0]}>
    <ringGeometry args={[0.3, 0.4, 20]} /><meshBasicMaterial ref={material} color="#376d7a" transparent depthWrite={false} />
  </mesh>;
}

function Scene(props: Props) {
  const positions = useMemo(() => new Map<string, Vector3>(), []);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!props.active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, [props.active]);
  const { gl } = useThree();
  const palette = [...new Set(props.state.agents.map(agent => agent.color))].sort().join(',');
  const textures = useMemo(() => new Map(palette ? palette.split(',').map(color => [color, Array.from({ length: 4 }, (_, direction) => Array.from({ length: 3 }, (_, frame) => characterTexture(color, direction, frame)))]) : []), [palette]);
  useEffect(() => () => { for (const frames of textures.values()) frames.flat().forEach(texture => texture.dispose()); }, [textures]);
  const layout = props.state.repositories.map(repo => `${repo.id}:${repo.position.join(',')}`).join('|');
  const roomRepo = props.state.repositories.find(repo => repo.id === props.room?.repoId);
  useEffect(() => { gl.shadowMap.needsUpdate = true; }, [gl, layout, roomRepo?.id]);
  const reporting = props.state.agents.filter(agent => agent.activity === 'reporting');
  const reportingSlots = new Map(reporting.map((agent, index) => [agent.id, index]));
  return <>
    <color attach="background" args={['#e7eadc']} />
    <ambientLight intensity={1.25} />
    <hemisphereLight args={['#fff4de', '#758166', 1.7]} />
    <directionalLight position={[-9, 18, 10]} intensity={2.5} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-22} shadow-camera-right={22} shadow-camera-top={22} shadow-camera-bottom={-22} shadow-normalBias={0.04} shadow-bias={-0.0002} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1, 0]} receiveShadow><planeGeometry args={[200, 200]} /><shadowMaterial transparent opacity={0.12} /></mesh>
    <Terrain repositories={props.state.repositories} reportingAgents={reporting.length} agents={props.state.agents} />
    {props.state.repositories.map(repo => <RepositoryHouse key={repo.id} repo={repo} open={roomRepo?.id === repo.id} selected={roomRepo?.id === repo.id || (props.selection?.kind === 'repo' && props.selection.id === repo.id)} labelsActive={props.active} labelsInteractive={props.labelsInteractive ?? true} onSelect={() => props.onSelect({ kind: 'repo', id: repo.id })} />)}
    {props.state.repositories.map(repo => {
      const received = props.state.telemetry?.sources?.filter(source => source.repoId === repo.id && source.status === 'receiving' && source.lastReceivedAt).map(source => source.lastReceivedAt!).sort().at(-1);
      return received ? <ServicePulse key={`traffic-${repo.id}`} repo={repo} receivedAt={received} reduced={props.reducedMotion} /> : null;
    })}
    <Manager pending={props.state.handoffs.filter(h => h.status === 'saved').length} selected={props.selection?.kind === 'manager'} active={props.active} labelsInteractive={props.labelsInteractive ?? true} onSelect={() => props.onSelect({ kind: 'manager' })} />
    {props.state.agents.map(agent => {
      const belongsToRoom = roomRepo?.id === agent.repoId;
      const deskIndex = belongsToRoom && canUseDesk(agent) ? props.room!.agentIds.slice(0, ROOM_PAGE_SIZE).indexOf(agent.id) : -1;
      const deskAnchor = deskIndex >= 0 && roomRepo ? roomAgentAnchor(roomRepo, deskIndex) : null;
      const source = props.state.observation?.connections.find(connection => connection.id === agent.observation?.connectionId);
      return <Character key={agent.id} agent={agent} slot={reportingSlots.get(agent.id) ?? 0} selected={props.selection?.kind === 'agent' && props.selection.id === agent.id} onSelect={() => props.onSelect({ kind: 'agent', id: agent.id })} reduced={props.reducedMotion} connected={props.connected && source?.status !== 'revoked'} active={props.active} now={now} snapshotGeneration={props.snapshotGeneration} repositories={props.state.repositories} positions={positions} textures={textures.get(agent.color)!} deskAnchor={deskAnchor} deskIndex={deskIndex >= 0 ? deskIndex : undefined} hidden={belongsToRoom && canUseDesk(agent) && !deskAnchor} labelsInteractive={props.labelsInteractive ?? true} />;
    })}
    <CameraRig action={props.cameraAction} follow={props.follow} onStopFollow={props.onStopFollow} positions={positions} reducedMotion={props.reducedMotion} active={props.active} />
  </>;
}

class SceneBoundary extends Component<{ children: ReactNode; onUnavailable: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onUnavailable(); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function World(props: Props) {
  const [visible, setVisible] = useState(!document.hidden);
  const gesture = useRef({ pointers: new Map<number, { x: number; y: number }>(), cancelled: false });
  const [supported] = useState(() => {
    try {
      const context = document.createElement('canvas').getContext('webgl2');
      if (!context) return false;
      context.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch { return false; }
  });
  useEffect(() => { const change = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change); }, []);
  useEffect(() => { if (!supported) props.onUnavailable(); }, [supported, props.onUnavailable]);
  const roomRepo = props.state.repositories.find(repo => repo.id === props.room?.repoId);
  const visibleDeskAgents = roomRepo ? props.state.agents.filter(agent => agent.repoId === roomRepo.id && canUseDesk(agent) && props.room!.agentIds.slice(0, ROOM_PAGE_SIZE).includes(agent.id)).map(agent => agent.id) : [];
  const visibleActorCount = props.state.agents.filter(agent => agent.repoId !== roomRepo?.id || !canUseDesk(agent) || visibleDeskAgents.includes(agent.id)).length;
  return <div className="world-canvas" data-testid="world-canvas" data-room={roomRepo?.id} data-room-repo-id={roomRepo?.id ?? ''} data-visible-desk-agents={JSON.stringify(visibleDeskAgents)} data-visible-actor-count={visibleActorCount} aria-label={`Interactive 3D ${props.state.workspace.mode === 'demo' ? 'sample' : 'private'} town. Use List view for keyboard access to all agents and places.`}
    onPointerDownCapture={event => {
      if (!gesture.current.pointers.size) gesture.current.cancelled = false;
      gesture.current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (gesture.current.pointers.size > 1) gesture.current.cancelled = true;
    }}
    onPointerMoveCapture={event => {
      const start = gesture.current.pointers.get(event.pointerId);
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) gesture.current.cancelled = true;
    }}
    onPointerUpCapture={event => { gesture.current.pointers.delete(event.pointerId); }}
    onPointerCancelCapture={event => { gesture.current.cancelled = true; gesture.current.pointers.delete(event.pointerId); }}
    onClickCapture={event => {
      if (event.detail > 0 && gesture.current.cancelled) { event.preventDefault(); event.stopPropagation(); }
    }}>
    {supported && <SceneBoundary onUnavailable={props.onUnavailable}>
      <Canvas orthographic camera={{ position: [19, 25, 28], zoom: 28, near: 0.1, far: 200 }} dpr={[1, 1.5]} shadows={{ type: PCFShadowMap }} frameloop={visible && props.active ? 'always' : 'never'} gl={{ antialias: true, powerPreference: 'low-power' }} onCreated={({ gl }) => { gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = true; gl.domElement.addEventListener('webglcontextlost', props.onUnavailable, { once: true }); }} fallback={<p>Use List view to explore this town without a canvas.</p>}>
        <Scene key={props.state.workspace.id} {...props} active={props.active && visible} />
      </Canvas>
    </SceneBoundary>}
  </div>;
}
