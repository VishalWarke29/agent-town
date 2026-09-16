import { describe, expect, it } from 'vitest';
import { OrthographicCamera, Vector3 } from 'three';
import { CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, DEFAULT_CAMERA_OFFSET, boundsCorners, fitOrthographicBounds, interpolateCameraPose, overviewPose, resizeCameraPose, roomCameraPose, type CameraBounds, type CameraInsets, type CameraPose, type CameraViewport } from '../../apps/web/src/world/camera-framing';

function projected(bounds: CameraBounds, pose: CameraPose, viewport: CameraViewport) {
  const camera = new OrthographicCamera(-viewport.width / 2, viewport.width / 2, viewport.height / 2, -viewport.height / 2, 0.1, 200);
  camera.position.fromArray(pose.position); camera.zoom = pose.zoom;
  camera.lookAt(new Vector3(...pose.target)); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  return boundsCorners(bounds).map(point => {
    const ndc = new Vector3(...point).project(camera);
    return { x: (ndc.x + 1) * viewport.width / 2, y: (1 - ndc.y) * viewport.height / 2, depth: ndc.z };
  });
}

function expectVisible(bounds: CameraBounds, pose: CameraPose, viewport: CameraViewport, insets: CameraInsets) {
  for (const point of projected(bounds, pose, viewport)) {
    expect(point.x).toBeGreaterThanOrEqual((insets.left ?? 0) - 0.0001);
    expect(point.x).toBeLessThanOrEqual(viewport.width - (insets.right ?? 0) + 0.0001);
    expect(point.y).toBeGreaterThanOrEqual((insets.top ?? 0) - 0.0001);
    expect(point.y).toBeLessThanOrEqual(viewport.height - (insets.bottom ?? 0) + 0.0001);
    expect(point.depth).toBeGreaterThan(-1); expect(point.depth).toBeLessThan(1);
  }
}

describe('orthographic house framing', () => {
  it.each([{ width: 1440, height: 960 }, { width: 390, height: 844 }])('frames room geometry clear of controls at $width × $height', viewport => {
    const bounds: CameraBounds = { min: [15, 0, -6.4], max: [21, 3.3, -1.6] };
    const pose = roomCameraPose([18, -4], viewport);
    const insets = viewport.width >= 900 ? { top: 170, bottom: 100, left: 95, right: 35 } : { top: 235, bottom: 155, left: 24, right: 24 };
    expectVisible(bounds, pose, viewport, insets);
    expect(pose.position.every(Number.isFinite)).toBe(true);
    expect(pose.target.every(Number.isFinite)).toBe(true);
  });

  it.each([{ width: 700, height: 390 }, { width: 844, height: 390 }, { width: 1200, height: 450 }])('places the entire room beside the landscape context at $width × $height', viewport => {
    const bounds: CameraBounds = { min: [-9, 0, -5.7], max: [-3, 3.3, -0.9] };
    const points = projected(bounds, roomCameraPose([-6, -3.3], viewport), viewport);
    // The rendered context is x=96..376; topbar and footer occupy the outer
    // 82/76px. Assert actual Three.js screen projections against those UI regions,
    // independently of the fitting helper's basis and inset calculations.
    const contextRight = 376, topbarBottom = 82, footerTop = viewport.height - 76;
    expect(Math.min(...points.map(point => point.x))).toBeGreaterThanOrEqual(contextRight + 14 - 0.0001);
    expect(Math.max(...points.map(point => point.x))).toBeLessThanOrEqual(viewport.width - 24 + 0.0001);
    expect(Math.min(...points.map(point => point.y))).toBeGreaterThanOrEqual(topbarBottom - 0.0001);
    expect(Math.max(...points.map(point => point.y))).toBeLessThanOrEqual(footerTop + 0.0001);
    expect(Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x))).toBeGreaterThan(220);
  });

  it('changes actual projected room size when entering from overview', () => {
    const viewport = { width: 1440, height: 960 }, bounds: CameraBounds = { min: [-3, 0, -2.4], max: [3, 3.3, 2.4] };
    const overview = projected(bounds, overviewPose(viewport), viewport), focused = projected(bounds, roomCameraPose([0, 0], viewport), viewport);
    const width = (points: { x: number }[]) => Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x));
    expect(width(focused)).toBeGreaterThan(width(overview) * 2);
  });

  it('fits tall geometry and asymmetric overlays using independent Three.js projection', () => {
    const bounds: CameraBounds = { min: [-42, -1, 17], max: [-39, 13, 20] }, viewport = { width: 1050, height: 800 };
    const insets = { left: 340, right: 40, top: 100, bottom: 90 };
    const pose = fitOrthographicBounds(bounds, viewport, insets);
    expectVisible(bounds, pose, viewport, insets);
    expect(pose.position.map((value, index) => value - pose.target[index])).toEqual(DEFAULT_CAMERA_OFFSET);
  });

  it('clamps both zoom limits and rejects unusable world bounds', () => {
    const viewport = { width: 1440, height: 960 };
    expect(fitOrthographicBounds({ min: [0, 0, 0], max: [0.001, 0.001, 0.001] }, viewport).zoom).toBe(CAMERA_MAX_ZOOM);
    expect(fitOrthographicBounds({ min: [-1000, 0, -1000], max: [1000, 1000, 1000] }, viewport).zoom).toBe(CAMERA_MIN_ZOOM);
    expect(() => fitOrthographicBounds({ min: [0, 0, 0], max: [0, 0, 0] }, viewport)).toThrow('visible area');
    expect(() => fitOrthographicBounds({ min: [2, 0, 0], max: [1, 1, 1] }, viewport)).toThrow('ordered');
    expect(() => roomCameraPose([NaN, 0], viewport)).toThrow('finite');
    expect(() => roomCameraPose([0, 0], { width: 0, height: 100 })).toThrow('viewport');
  });

  it('restores an unchanged viewport exactly and scales saved composition after resizing', () => {
    const viewport = { width: 1440, height: 960 }, smaller = { width: 720, height: 480 };
    const saved: CameraPose = { position: [39, 25, 45], target: [20, 0, 17], zoom: 40 };
    expect(resizeCameraPose(saved, viewport, viewport)).toEqual(saved);
    const adjusted = resizeCameraPose(saved, viewport, smaller);
    expect(adjusted.position).toEqual(saved.position); expect(adjusted.target).toEqual(saved.target); expect(adjusted.zoom).toBe(20);
    expect(resizeCameraPose(adjusted, smaller, viewport)).toEqual(saved);
    expect(saved.zoom).toBe(40);
  });

  it('allows a superseding transition to start at the currently rendered pose', () => {
    const viewport = { width: 1440, height: 960 }, from = overviewPose(viewport), houseA = roomCameraPose([-6, -3.3], viewport), houseB = roomCameraPose([18, -4], viewport);
    const interrupted = interpolateCameraPose(from, houseA, 0.35);
    expect(interpolateCameraPose(interrupted, houseB, 0)).toEqual(interrupted);
    expect(interpolateCameraPose(interrupted, houseB, 1)).toEqual(houseB);
    expect(interpolateCameraPose(from, houseA, -1)).toEqual(from);
    expect(interpolateCameraPose(from, houseA, 3)).toEqual(houseA);
  });
});
