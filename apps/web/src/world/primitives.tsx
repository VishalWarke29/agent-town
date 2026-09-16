export type Position = [number, number, number];

export function Block({ position, size, color, rotation = 0 }: { position: Position; size: Position; color: string; rotation?: number }) {
  return <mesh position={position} rotation={[0, rotation, 0]} castShadow receiveShadow><boxGeometry args={size} /><meshStandardMaterial color={color} roughness={0.95} /></mesh>;
}
