import { cameraBasis, clampCameraZoom, type CameraPoint, type CameraPose, type CameraViewport } from './camera-framing';

export interface CameraWheelInput {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/** Wheel events do not reliably identify mouse versus trackpad. Use one mapping:
 * scroll pans; browser pinch (Ctrl+wheel) zooms. Distances use CSS pixels, not DPR. */
export function cameraWheelPose(pose: CameraPose, input: CameraWheelInput, viewport: CameraViewport, frustum: CameraViewport): CameraPose | null {
  if (![viewport.width, viewport.height, frustum.width, frustum.height, pose.zoom].every(value => Number.isFinite(value) && value > 0)
    || ![input.deltaX, input.deltaY, ...pose.position, ...pose.target].every(Number.isFinite)) return null;

  // Read deltaMode before deltas at the event boundary. Line size is an explicit
  // canvas convention; page mode uses the corresponding viewport dimension.
  const scaleX = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? viewport.width : 1;
  const scaleY = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? viewport.height : 1;
  let x = input.deltaX * scaleX, y = input.deltaY * scaleY;
  if (input.ctrlKey) {
    if (!y) return null;
    const zoom = clampCameraZoom(pose.zoom * Math.exp(-Math.max(-100, Math.min(100, y)) * 0.01));
    return { position: [...pose.position], target: [...pose.target], zoom };
  }
  // Some browsers translate Shift+wheel into deltaX themselves; do not swap twice.
  if (input.shiftKey && x === 0) { x = y; y = 0; }
  if (!x && !y) return null;
  const offset = pose.position.map((value, index) => value - pose.target[index]) as CameraPoint;
  const basis = cameraBasis(offset);
  const right = Math.max(-viewport.width, Math.min(viewport.width, x)) * frustum.width / viewport.width / pose.zoom;
  const up = -Math.max(-viewport.height, Math.min(viewport.height, y)) * frustum.height / viewport.height / pose.zoom;
  const movement = basis.right.map((value, index) => value * right + basis.up[index] * up);
  return {
    position: pose.position.map((value, index) => value + movement[index]) as CameraPoint,
    target: pose.target.map((value, index) => value + movement[index]) as CameraPoint,
    zoom: pose.zoom,
  };
}
