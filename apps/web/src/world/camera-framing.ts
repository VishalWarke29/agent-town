export type CameraPoint = [number, number, number];
export interface CameraViewport { width: number; height: number }
export interface CameraInsets { top?: number; right?: number; bottom?: number; left?: number }
export interface CameraBounds { min: CameraPoint; max: CameraPoint }
export interface CameraPose { position: CameraPoint; target: CameraPoint; zoom: number }

export const DEFAULT_CAMERA_OFFSET: CameraPoint = [19, 25, 28];
export const CAMERA_MIN_ZOOM = 6;
export const CAMERA_MAX_ZOOM = 90;
export const CAMERA_TRANSITION_SECONDS = 0.45;

const add = (a: CameraPoint, b: CameraPoint): CameraPoint => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: CameraPoint, amount: number): CameraPoint => [a[0] * amount, a[1] * amount, a[2] * amount];
const dot = (a: CameraPoint, b: CameraPoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: CameraPoint, b: CameraPoint): CameraPoint => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (value: CameraPoint): CameraPoint => scale(value, 1 / Math.hypot(...value));
const finitePoint = (value: CameraPoint) => value.every(Number.isFinite);

export function clampCameraZoom(zoom: number) {
  return Math.max(CAMERA_MIN_ZOOM, Math.min(CAMERA_MAX_ZOOM, Number.isFinite(zoom) ? zoom : CAMERA_MIN_ZOOM));
}

export function overviewZoom(viewport: CameraViewport) {
  return clampCameraZoom(Math.min(viewport.width / 36, viewport.height / 27));
}

export function overviewPose(viewport: CameraViewport): CameraPose {
  return { position: [...DEFAULT_CAMERA_OFFSET], target: [0, 0, 0], zoom: overviewZoom(viewport) };
}

/** Screen-right/up vectors for the fixed-tilt orthographic camera. */
export function cameraBasis(offset: CameraPoint = DEFAULT_CAMERA_OFFSET) {
  if (!finitePoint(offset) || Math.hypot(offset[0], offset[2]) < 0.000001) throw new RangeError('Camera offset needs a finite horizontal direction.');
  const backward = normalize(offset);
  const right = normalize(cross([0, 1, 0], backward));
  return { right, up: normalize(cross(backward, right)) };
}

export function boundsCorners(bounds: CameraBounds): CameraPoint[] {
  return [bounds.min[0], bounds.max[0]].flatMap(x => [bounds.min[1], bounds.max[1]].flatMap(y => [bounds.min[2], bounds.max[2]].map(z => [x, y, z] as CameraPoint)));
}

/** Fits world bounds into a pixel-sized orthographic frustum without changing tilt. */
export function fitOrthographicBounds(bounds: CameraBounds, viewport: CameraViewport, insets: CameraInsets = {}, offset: CameraPoint = DEFAULT_CAMERA_OFFSET): CameraPose {
  if (!finitePoint(bounds.min) || !finitePoint(bounds.max) || bounds.min.some((value, index) => value > bounds.max[index])) throw new RangeError('Camera bounds must be finite and ordered.');
  if (![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Camera viewport must have positive finite dimensions.');
  const { right, up } = cameraBasis(offset);
  const corners = boundsCorners(bounds);
  const horizontal = corners.map(point => dot(point, right)), vertical = corners.map(point => dot(point, up));
  const width = Math.max(...horizontal) - Math.min(...horizontal), height = Math.max(...vertical) - Math.min(...vertical);
  if (width < 0.000001 || height < 0.000001) throw new RangeError('Camera bounds must have visible area.');
  // Even an almost fully covered canvas keeps a finite fit; its HTML roster remains available.
  const inset = (value = 0) => Number.isFinite(value) ? Math.max(0, value) : 0;
  const left = inset(insets.left), rightInset = inset(insets.right), top = inset(insets.top), bottom = inset(insets.bottom);
  const usableWidth = Math.max(1, viewport.width - left - rightInset), usableHeight = Math.max(1, viewport.height - top - bottom);
  const zoom = clampCameraZoom(Math.min(usableWidth / width, usableHeight / height));
  const center: CameraPoint = bounds.min.map((value, index) => (value + bounds.max[index]) / 2) as CameraPoint;
  const horizontalShift = (left - rightInset) / 2, verticalShift = (bottom - top) / 2;
  const target = add(add(center, scale(right, -horizontalShift / zoom)), scale(up, -verticalShift / zoom));
  return { target, position: add(target, offset), zoom };
}

export function roomCameraPose(point: [number, number], viewport: CameraViewport): CameraPose {
  const mobile = viewport.width < 900;
  // Match the short-landscape context/list layout: its left panel ends at x=376.
  // The workroom occupies the clear region to its right, below the topbar.
  const shortLandscape = viewport.width >= 700 && viewport.height <= 500;
  return fitOrthographicBounds({ min: [point[0] - 3, 0, point[1] - 2.4], max: [point[0] + 3, 3.3, point[1] + 2.4] }, viewport,
    shortLandscape ? { top: 82, bottom: 76, left: 390, right: 24 }
      : mobile ? { top: Math.min(235, viewport.height * 0.28), bottom: Math.min(155, viewport.height * 0.2), left: 24, right: 24 } : { top: Math.min(170, viewport.height * 0.28), bottom: Math.min(100, viewport.height * 0.2), left: 95, right: 35 });
}

/** Frames the Archive's floating 3D visualization (a solar system or constellation) as close to
 * full-screen as this world's fixed-tilt orthographic camera allows: a box centered on where it
 * floats, generously sized to its footprint, with only the topbar and the still-open right-side
 * details drawer reserved. Unlike roomCameraPose (sized and positioned for a ground-level repository
 * house), this box sits at the visualization's own elevation, not the ground. */
// Steeper than DEFAULT_CAMERA_OFFSET (more overhead, less oblique) specifically for the Archive: at
// the town's normal isometric tilt, a nearby ground-level building can sit almost directly along the
// camera's viewing/depth axis from wherever the Archive happens to stand — a horizontal-only
// separation (raw X/Z distance) does not prevent that, as an oblique view compresses depth far more
// than a steep one. Looking down more steeply keeps whichever building is nearby low in the frame
// instead of centered in it, without needing the Archive to sit somewhere with no neighbor at all —
// the owner's own placement, not a placement chosen to dodge this, is what's preserved this way.
// Symmetric in X/Z on purpose: it should help regardless of which side a building happens to be on.
const ARCHIVE_CAMERA_OFFSET: CameraPoint = [11, 40, 11];

export function archiveCameraPose(point: [number, number], elevation: number, radius: number, viewport: CameraViewport): CameraPose {
  const mobile = viewport.width < 900;
  const rightPanel = mobile ? 0 : Math.min(460, viewport.width * 0.34);
  return fitOrthographicBounds(
    { min: [point[0] - radius, elevation - 0.8, point[1] - radius], max: [point[0] + radius, elevation + 2.6, point[1] + radius] },
    viewport,
    mobile ? { top: Math.min(230, viewport.height * 0.26), bottom: Math.min(150, viewport.height * 0.2), left: 20, right: 20 }
      : { top: 78, bottom: 24, left: 90, right: rightPanel + 24 },
    ARCHIVE_CAMERA_OFFSET,
  );
}

/** Preserve the same relative scale when restoring an overview in a resized viewport. */
export function resizeCameraPose(pose: CameraPose, before: CameraViewport, after: CameraViewport): CameraPose {
  const scaleBefore = Math.min(before.width / 36, before.height / 27);
  const scaleAfter = Math.min(after.width / 36, after.height / 27);
  const ratio = Number.isFinite(scaleBefore) && scaleBefore > 0 && Number.isFinite(scaleAfter) && scaleAfter > 0 ? scaleAfter / scaleBefore : 1;
  return { target: [...pose.target], position: [...pose.position], zoom: clampCameraZoom(pose.zoom * ratio) };
}

export function interpolateCameraPose(from: CameraPose, to: CameraPose, progress: number): CameraPose {
  const t = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  if (t === 0 || t === 1) {
    const endpoint = t === 0 ? from : to;
    return { position: [...endpoint.position], target: [...endpoint.target], zoom: endpoint.zoom };
  }
  const eased = t * t * (3 - 2 * t);
  const mix = (a: number, b: number) => a + (b - a) * eased;
  return { position: from.position.map((value, index) => mix(value, to.position[index])) as CameraPoint, target: from.target.map((value, index) => mix(value, to.target[index])) as CameraPoint, zoom: mix(from.zoom, to.zoom) };
}
