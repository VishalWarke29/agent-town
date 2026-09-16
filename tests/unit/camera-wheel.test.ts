import { describe, expect, it } from 'vitest';
import { OrthographicCamera, Vector3 } from 'three';
import { CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, overviewPose, type CameraPose } from '../../apps/web/src/world/camera-framing';
import { cameraWheelPose, type CameraWheelInput } from '../../apps/web/src/world/camera-wheel';

const viewport = { width: 1440, height: 960 };
const pose = overviewPose(viewport);
const wheel = (changes: Partial<CameraWheelInput> = {}): CameraWheelInput => ({ deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false, shiftKey: false, ...changes });
function screenPoint(view: CameraPose, frustum = viewport) {
  const camera = new OrthographicCamera(-frustum.width / 2, frustum.width / 2, frustum.height / 2, -frustum.height / 2, 0.1, 200);
  camera.position.fromArray(view.position); camera.zoom = view.zoom; camera.lookAt(new Vector3(...view.target)); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const point = new Vector3(2, 0, 3).project(camera);
  return { x: (point.x + 1) * viewport.width / 2, y: (1 - point.y) * viewport.height / 2 };
}

describe('trackpad camera input', () => {
  it.each([{ x: 80, y: 0 }, { x: 0, y: 65 }, { x: -37.5, y: 22.25 }])('scrolls scene pixels by the supplied axes: %o', ({ x, y }) => {
    const before = screenPoint(pose), after = cameraWheelPose(pose, wheel({ deltaX: x, deltaY: y }), viewport, viewport)!;
    const projected = screenPoint(after);
    expect(projected.x - before.x).toBeCloseTo(-x, 6);
    expect(projected.y - before.y).toBeCloseTo(-y, 6);
    expect(after.zoom).toBe(pose.zoom);
    after.position.forEach((value, index) => expect(value - after.target[index]).toBeCloseTo(pose.position[index] - pose.target[index], 10));
  });

  it('keeps scrolling proportional at different zoom and frustum sizes', () => {
    const view = { ...pose, zoom: 75 }, frustum = { width: 720, height: 480 };
    const after = cameraWheelPose(view, wheel({ deltaX: 18, deltaY: 31 }), viewport, frustum)!;
    const beforePoint = screenPoint(view, frustum), afterPoint = screenPoint(after, frustum);
    expect(afterPoint.x - beforePoint.x).toBeCloseTo(-18, 6);
    expect(afterPoint.y - beforePoint.y).toBeCloseTo(-31, 6);
  });

  it('normalizes line and page units and avoids applying Shift twice', () => {
    expect(cameraWheelPose(pose, wheel({ deltaMode: 1, deltaY: 2 }), viewport, viewport)).toEqual(cameraWheelPose(pose, wheel({ deltaY: 32 }), viewport, viewport));
    expect(cameraWheelPose(pose, wheel({ deltaMode: 2, deltaX: 0.5, deltaY: 0.5 }), viewport, viewport)).toEqual(cameraWheelPose(pose, wheel({ deltaX: 720, deltaY: 480 }), viewport, viewport));
    const horizontal = cameraWheelPose(pose, wheel({ deltaX: 30 }), viewport, viewport);
    expect(cameraWheelPose(pose, wheel({ shiftKey: true, deltaY: 30 }), viewport, viewport)).toEqual(horizontal);
    expect(cameraWheelPose(pose, wheel({ shiftKey: true, deltaX: 30 }), viewport, viewport)).toEqual(horizontal);
  });

  it('smoothly zooms pinch input without panning and keeps existing zoom bounds', () => {
    const inward = cameraWheelPose(pose, wheel({ ctrlKey: true, deltaY: -8, deltaX: 40 }), viewport, viewport)!;
    expect(inward.zoom).toBeGreaterThan(pose.zoom);
    expect(inward.position).toEqual(pose.position); expect(inward.target).toEqual(pose.target);
    const restored = cameraWheelPose(inward, wheel({ ctrlKey: true, deltaY: 8 }), viewport, viewport)!;
    expect(restored.zoom).toBeCloseTo(pose.zoom, 8);
    expect(cameraWheelPose({ ...pose, zoom: 89 }, wheel({ ctrlKey: true, deltaY: -10000 }), viewport, viewport)?.zoom).toBe(CAMERA_MAX_ZOOM);
    expect(cameraWheelPose({ ...pose, zoom: 7 }, wheel({ ctrlKey: true, deltaY: 10000 }), viewport, viewport)?.zoom).toBe(CAMERA_MIN_ZOOM);
  });

  it('ignores empty/invalid input and bounds oversized pan events to one viewport', () => {
    expect(cameraWheelPose(pose, wheel(), viewport, viewport)).toBeNull();
    expect(cameraWheelPose(pose, wheel({ deltaY: NaN }), viewport, viewport)).toBeNull();
    expect(cameraWheelPose(pose, wheel({ deltaY: 20 }), { width: 0, height: 960 }, viewport)).toBeNull();
    expect(cameraWheelPose(pose, wheel({ deltaX: 1e10, deltaY: -1e10 }), viewport, viewport)).toEqual(cameraWheelPose(pose, wheel({ deltaX: 1440, deltaY: -960 }), viewport, viewport));
  });
});
