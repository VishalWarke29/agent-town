import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { BufferAttribute, BufferGeometry, Line as ThreeLine, LineBasicMaterial, Vector3, type Group, type Mesh } from 'three';
import type { DbSchemaSnapshot } from '@agent-town/contracts';
import { layoutSolarSystems, type OrbitBody, type Sun } from './orbitLayout';
import { tableColor } from './colorVariants';

const FILE_COLOR: Record<string, string> = { workspace: '#7c9b7a', identity: '#a8926b' };
const SUN_COLOR: Record<string, string> = { workspace: '#e3b969', identity: '#e0916a' };
const UNAVAILABLE_COLOR = '#9c9a8e';

function ringPoints(radius: number): [number, number, number][] {
  return Array.from({ length: 65 }, (_, i) => {
    const a = (i / 64) * Math.PI * 2;
    return [Math.cos(a) * radius, 0, Math.sin(a) * radius];
  });
}

function TableDetailCard({ body }: { body: OrbitBody }) {
  return <div className="orbit-detail">
    <strong>{body.label}</strong>
    <span className="orbit-detail-meta">{body.rowCount === null ? 'rows unavailable' : `${body.rowCount} row${body.rowCount === 1 ? '' : 's'}`}</span>
    <ul>
      {body.columns.map(column => <li key={column.name}>{column.primaryKey ? <b>{column.name} (primary key)</b> : column.name}</li>)}
      {body.hiddenColumnCount > 0 && <li>{body.hiddenColumnCount} hidden for privacy</li>}
    </ul>
    {body.outgoingForeignKey
      ? <p className="orbit-detail-fk">{body.outgoingForeignKey.column} &rarr; {body.outgoingForeignKey.toTable}.{body.outgoingForeignKey.toColumn}</p>
      : <p className="orbit-detail-fk muted">No foreign key from this table</p>}
  </div>;
}

function OrbitingBody({ body, childrenByParent, registry }: { body: OrbitBody; childrenByParent: Map<string | null, OrbitBody[]>; registry: Map<string, Group> }) {
  const spin = useRef<Group>(null);
  const grow = useRef<Group>(null);
  const growProgress = useRef(0);
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Kepler-ish: a body further from what it orbits moves slower, so the whole system doesn't
  // read as one uniform carousel — the nearest bodies visibly sweep past the outer ones.
  const speed = (body.speedDirection * 0.55) / Math.sqrt(body.orbitRadius + 0.4);
  useFrame((_, delta) => {
    if (spin.current) spin.current.rotation.y += speed * delta;
    growProgress.current = Math.min(1, growProgress.current + delta / 0.6);
    grow.current?.scale.setScalar(Math.max(0.04, growProgress.current));
  });
  const color = body.rowCount === null ? UNAVAILABLE_COLOR : tableColor(FILE_COLOR[body.fileKind] ?? FILE_COLOR.workspace!, body.label);
  const children = childrenByParent.get(body.id) ?? [];
  return <>
    <Line points={ringPoints(body.orbitRadius)} color="#5f6f57" lineWidth={1} transparent opacity={0.35} />
    <group ref={spin} rotation={[0, body.angleOffset, 0]}>
      {/* Registered by id so MoonLink can read this body's actual current world position each frame
          (it orbits continuously, so only a live position — not the static layout radius — draws a
          connection line that stays attached to it) — never read outside a frame loop; a plain ref,
          not React state, since neither this map nor its writes should ever trigger a re-render. */}
      <group position={[body.orbitRadius, 0, 0]} ref={el => { if (el) registry.set(body.id, el); else registry.delete(body.id); }}>
        <group ref={grow}>
          <mesh
            castShadow
            onPointerOver={(event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); setHovered(true); }}
            onPointerOut={() => setHovered(false)}
            onClick={(event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); setExpanded(value => !value); }}
          >
            <sphereGeometry args={[body.size, 20, 16]} />
            <meshStandardMaterial color={hovered || expanded ? '#e6d5a9' : color} roughness={0.7} />
          </mesh>
        </group>
        {/* Click for the full column/foreign-key detail card ("look into it in detail"); hover alone
            still gives the quick name-and-row-count peek so a passing glance costs nothing. */}
        {expanded ? <Html position={[0, body.size + 0.3, 0]} center zIndexRange={[9, 1]}><TableDetailCard body={body} /></Html>
          : <Html position={[0, body.size + 0.3, 0]} center zIndexRange={[8, 1]}>
            <span className={`orbit-label ${hovered ? 'orbit-label-active' : ''}`}>{body.label}{hovered && (body.rowCount === null ? ' · unavailable' : ` · ${body.rowCount} rows`)}</span>
          </Html>}
        {/* A moon's own moons orbit it from here, inside its rotating frame, so they sweep around
            together with their parent — exactly how a real orbital hierarchy composes. */}
        {children.map(child => <OrbitingBody key={child.id} body={child} childrenByParent={childrenByParent} registry={registry} />)}
      </group>
    </group>
  </>;
}

/** A visible tether from a moon to the table it depends on (its foreign-key target) — not just the
 * implied nesting of orbiting-around-it, since that reads clearly at a glance but not necessarily on
 * closer inspection once several moons/planets overlap on screen. Reads both bodies' actual current
 * world position every frame (both are continuously orbiting) rather than the static layout radius,
 * so the line stays attached as they move. */
function MoonLink({ bodyId, parentId, registry }: { bodyId: string; parentId: string; registry: Map<string, Group> }) {
  // A plain three.js Line built and held imperatively, rendered via <primitive> — not drei's fat-line
  // <Line> (Line2): both mutating its geometry in place after mount and re-rendering it with a fresh
  // points array every frame (recreating its internal LineGeometry via drei's own useMemo) failed to
  // render here, an apparent quirk of its instanced-attribute setup with very short, fast-changing
  // segments. JSX's own lowercase <line>/<bufferGeometry> intrinsics collide with React's built-in SVG
  // element types, so the object is constructed directly instead of written as nested JSX.
  const object = useMemo(() => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
    const line = new ThreeLine(geometry, new LineBasicMaterial({ color: '#c98f5a', transparent: true, opacity: 0.8 }));
    line.frustumCulled = false;
    return line;
  }, []);
  const from = useMemo(() => new Vector3(), []);
  const to = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const body = registry.get(bodyId), parent = registry.get(parentId);
    if (!body || !parent) return;
    body.getWorldPosition(from);
    parent.getWorldPosition(to);
    // getWorldPosition returns true world-space coordinates, but this object itself is mounted inside
    // ArchiveGraph's own offset group (<group position={origin}>) — writing world coordinates
    // straight into its geometry double-applies that group's transform on render (it's added again on
    // top of coordinates that already include it), moving the line far from both bodies and out of
    // frame entirely, which is what made every earlier attempt here look like nothing was rendering at
    // all. worldToLocal converts back into whatever this object's actual parent turns out to be, so it
    // stays correct even if this line is ever mounted somewhere else in the tree.
    object.parent?.worldToLocal(from);
    object.parent?.worldToLocal(to);
    const position = object.geometry.attributes.position as BufferAttribute;
    position.setXYZ(0, from.x, from.y, from.z);
    position.setXYZ(1, to.x, to.y, to.z);
    position.needsUpdate = true;
    object.geometry.computeBoundingSphere();
  });
  return <primitive object={object} />;
}

function SunBody({ sun }: { sun: Sun }) {
  const pulse = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    const t = 1 + Math.sin(clock.elapsedTime * 1.4) * 0.035;
    pulse.current?.scale.setScalar(t);
  });
  return <group>
    <mesh ref={pulse} castShadow>
      <sphereGeometry args={[0.62, 24, 18]} />
      <meshStandardMaterial color={SUN_COLOR[sun.fileKind] ?? SUN_COLOR.workspace} emissive={SUN_COLOR[sun.fileKind] ?? SUN_COLOR.workspace} emissiveIntensity={0.55} roughness={0.4} />
    </mesh>
    <Html position={[0, 1.05, 0]} center zIndexRange={[8, 1]}>
      <span className="orbit-label" style={{ fontWeight: 700, flexDirection: 'column', alignItems: 'flex-start' }}>
        {sun.label}
        {!sun.hasForeignKeys && <span className="orbit-sun-note">No foreign keys yet — nothing to connect</span>}
      </span>
    </Html>
  </group>;
}

/** The 3D schema view: one small "solar system" per local database file. The file itself is the sun;
 * each table is a body that orbits the sun directly if nothing depends on it, or orbits the table its
 * own foreign key points to if it has one, connected to it by a visible tether (MoonLink) — so a
 * dependency reads as both a physical orbit and an explicit line, not just relative position. Body
 * size is row count, log-scaled. Continuously animated (real orbital motion, Kepler-ish — farther
 * bodies move slower), not a one-shot layout. Free camera rotation while this view is open (see
 * CameraRig's rotatable prop) lets it be inspected from any angle. Deliberately no third-party graph
 * or orbit-rendering library — built from this world's own Three.js primitives (the same sphere/line
 * geometry already used elsewhere in the app), adapting two established, cited techniques: radial/
 * concentric graph layout for hierarchy depth, and the sun/orbit/planet-size mapping from Graham &
 * Yang's 2004 "Solar System Metaphor" paper for software metrics. Schema and counts only: never a
 * body per row, never a cell of row content. */
export function ArchiveGraph({ snapshot, origin }: { snapshot: DbSchemaSnapshot; origin: [number, number, number] }) {
  const { systems } = useMemo(() => layoutSolarSystems(snapshot.groups), [snapshot]);
  // One registry per mount (not per system): a moon and its parent are always in the same system in
  // today's schema (a real SQLite foreign key cannot cross files), but nothing here assumes that.
  const registry = useMemo(() => new Map<string, Group>(), [snapshot]);
  return <group position={origin}>
    {systems.map(system => {
      const childrenByParent = new Map<string | null, OrbitBody[]>();
      for (const body of system.bodies) {
        const key = body.parentId;
        if (!childrenByParent.has(key)) childrenByParent.set(key, []);
        childrenByParent.get(key)!.push(body);
      }
      const roots = childrenByParent.get(null) ?? [];
      return <group key={system.sun.id} position={[system.offsetX, 0, 0]}>
        <SunBody sun={system.sun} />
        {roots.map(body => <OrbitingBody key={body.id} body={body} childrenByParent={childrenByParent} registry={registry} />)}
      </group>;
    })}
    {systems.flatMap(system => system.bodies).filter(body => body.parentId).map(body => <MoonLink key={body.id} bodyId={body.id} parentId={body.parentId!} registry={registry} />)}
  </group>;
}
