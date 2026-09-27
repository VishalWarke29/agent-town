import { useCallback, useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { MOUSE, OrthographicCamera, TOUCH, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { CameraAction } from './interaction';
import { cameraWheelPose } from './camera-wheel';
import { archiveCameraPose, CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, CAMERA_TRANSITION_SECONDS, cameraBasis, clampCameraZoom, interpolateCameraPose, overviewPose, resizeCameraPose, roomCameraPose, type CameraPoint, type CameraPose, type CameraViewport } from './camera-framing';
import { ARCHIVE_CAMERA_RADIUS, ARCHIVE_VISUAL_ELEVATION } from './interaction';

interface Props {
  action: CameraAction;
  follow: string | null;
  positions: Map<string, Vector3>;
  onStopFollow: () => void;
  reducedMotion: boolean;
  active: boolean;
  /** Only while the Archive's floating visualization is framed: lets a right-click/single-touch
   * drag orbit around it (three.js OrbitControls' actual rotate action), so it can be looked at
   * from any angle instead of only panned/zoomed at this world's one fixed isometric tilt. */
  rotatable?: boolean;
}
type CameraMode = 'manual' | 'transition' | 'follow';
interface Transition { from: CameraPose; to: CameraPose; elapsed: number }

/** The sole writer of camera position, target and zoom, including OrbitControls input. */
export function CameraRig({ action, follow, positions, onStopFollow, reducedMotion, active, rotatable = false }: Props) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, size, gl } = useThree();
  const mode = useRef<CameraMode>('manual');
  const transition = useRef<Transition | null>(null);
  const returnView = useRef<{ pose: CameraPose; viewport: CameraViewport } | null>(null);
  const framedRoom = useRef<[number, number] | null>(null);
  const framedArchive = useRef<{ point: [number, number]; radius: number } | null>(null);
  const followed = useRef<string | null>(null);
  const viewport = useRef<CameraViewport>({ width: size.width, height: size.height });
  const initialized = useRef(false);
  const request = useRef(-1);
  const followOffset = useRef(new Vector3());

  const readPose = useCallback((): CameraPose => ({
    position: camera.position.toArray() as CameraPoint,
    target: controls.current?.target.toArray() as CameraPoint ?? [0, 0, 0],
    zoom: camera instanceof OrthographicCamera ? camera.zoom : 1,
  }), [camera]);

  // Inert numeric diagnostics allow browser tests to verify actual camera behavior.
  // No repository, workspace, session IDs, renderer handles or mutation API are exposed.
  const publish = useCallback(() => {
    if (!(camera instanceof OrthographicCamera) || !controls.current) return;
    const fields = {
      cameraMode: mode.current,
      cameraPosition: JSON.stringify(camera.position.toArray().map(value => Number(value.toFixed(6)))),
      cameraTarget: JSON.stringify(controls.current.target.toArray().map(value => Number(value.toFixed(6)))),
      cameraZoom: String(Number(camera.zoom.toFixed(6))),
      cameraRequest: String(request.current),
    };
    for (const [key, value] of Object.entries(fields)) if (gl.domElement.dataset[key] !== value) gl.domElement.dataset[key] = value;
  }, [camera, gl]);

  const apply = useCallback((pose: CameraPose) => {
    if (!(camera instanceof OrthographicCamera) || !controls.current) return;
    camera.position.fromArray(pose.position);
    controls.current.target.fromArray(pose.target);
    camera.zoom = clampCameraZoom(pose.zoom);
    camera.updateProjectionMatrix();
    controls.current.update();
    publish();
  }, [camera, publish]);

  const settle = useCallback(() => {
    const pending = transition.current;
    transition.current = null;
    if (mode.current === 'transition') mode.current = 'manual';
    if (pending) apply(pending.to); else publish();
  }, [apply, publish]);

  const begin = useCallback((to: CameraPose) => {
    transition.current = null;
    followed.current = null;
    if (reducedMotion || !active) { mode.current = 'manual'; apply(to); }
    else { mode.current = 'transition'; transition.current = { from: readPose(), to, elapsed: 0 }; publish(); }
  }, [active, reducedMotion, apply, readPose, publish]);

  const stopAutomatic = useCallback(() => {
    transition.current = null;
    framedRoom.current = null;
    framedArchive.current = null;
    followed.current = null;
    mode.current = 'manual';
    onStopFollow();
    publish();
  }, [onStopFollow, publish]);

  useLayoutEffect(() => {
    if (!active || !(camera instanceof OrthographicCamera)) return;
    // Capture only the scene, including its HTML labels. Glass panels and List
    // view are outside this boundary and retain normal scrolling/browser zoom.
    const surface = gl.domElement.closest('.world-canvas') ?? gl.domElement;
    const wheel = (event: WheelEvent) => {
      if (!controls.current?.enabled) return;
      const deltaMode = event.deltaMode;
      const next = cameraWheelPose(readPose(), { deltaMode, deltaX: event.deltaX, deltaY: event.deltaY, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey },
        { width: size.width, height: size.height }, { width: camera.right - camera.left, height: camera.top - camera.bottom });
      event.preventDefault();
      // OrbitControls otherwise turns every vertical scroll into a zoom.
      event.stopPropagation();
      if (!next) return;
      stopAutomatic();
      apply(next);
    };
    surface.addEventListener('wheel', wheel as EventListener, { capture: true, passive: false });
    return () => surface.removeEventListener('wheel', wheel as EventListener, true);
  }, [active, camera, gl, size.width, size.height, readPose, stopAutomatic, apply]);

  useLayoutEffect(() => {
    if (!controls.current || !(camera instanceof OrthographicCamera)) return;
    const next = { width: size.width, height: size.height };
    if (!initialized.current) { initialized.current = true; apply(overviewPose(next)); }
    else if (viewport.current.width !== next.width || viewport.current.height !== next.height) {
      // Resize settles a destination once. Overlay-only layout does not affect canvas size.
      const pose = framedRoom.current ? roomCameraPose(framedRoom.current, next)
        : framedArchive.current ? archiveCameraPose(framedArchive.current.point, ARCHIVE_VISUAL_ELEVATION, framedArchive.current.radius, next)
        : resizeCameraPose(transition.current?.to ?? readPose(), viewport.current, next);
      transition.current = null;
      if (mode.current === 'transition') mode.current = 'manual';
      apply(pose);
    }
    viewport.current = next;
  }, [camera, size.width, size.height, apply, readPose]);

  useLayoutEffect(() => {
    followed.current = follow;
    if (follow) { transition.current = null; framedRoom.current = null; mode.current = 'follow'; }
    else if (mode.current === 'follow') mode.current = 'manual';
    publish();
  }, [follow, publish]);

  useLayoutEffect(() => {
    if (!controls.current || !(camera instanceof OrthographicCamera) || request.current === action.nonce) return;
    request.current = action.nonce;
    const previous = readPose();
    transition.current = null;
    followed.current = null;
    mode.current = 'manual';
    if (action.kind === 'room' && action.point?.every(Number.isFinite)) {
      returnView.current ??= { pose: previous, viewport: { ...viewport.current } };
      const alreadyFramed = framedRoom.current?.[0] === action.point[0] && framedRoom.current[1] === action.point[1];
      framedRoom.current = [...action.point]; framedArchive.current = null;
      if (alreadyFramed) apply(roomCameraPose(action.point, viewport.current));
      else begin(roomCameraPose(action.point, viewport.current));
    } else if (action.kind === 'archive' && action.point?.every(Number.isFinite)) {
      returnView.current ??= { pose: previous, viewport: { ...viewport.current } };
      const radius = Number.isFinite(action.radius) ? action.radius! : ARCHIVE_CAMERA_RADIUS;
      const alreadyFramed = framedArchive.current?.point[0] === action.point[0] && framedArchive.current?.point[1] === action.point[1] && framedArchive.current?.radius === radius;
      framedArchive.current = { point: [...action.point], radius }; framedRoom.current = null;
      const pose = archiveCameraPose(action.point, ARCHIVE_VISUAL_ELEVATION, radius, viewport.current);
      if (alreadyFramed) apply(pose); else begin(pose);
    } else if (action.kind === 'return') {
      const saved = returnView.current;
      returnView.current = null; framedRoom.current = null; framedArchive.current = null;
      begin(saved ? resizeCameraPose(saved.pose, saved.viewport, viewport.current) : overviewPose(viewport.current));
    } else if (action.kind === 'reset') {
      returnView.current = null; framedRoom.current = null; framedArchive.current = null;
      // Workspace switches also request Reset: discard the previous private pose immediately.
      apply(overviewPose(viewport.current));
    } else {
      framedRoom.current = null; framedArchive.current = null;
      if (action.kind === 'in' || action.kind === 'out') apply({ ...previous, zoom: previous.zoom * (action.kind === 'in' ? 1.2 : 1 / 1.2) });
      if (action.kind === 'focus' && action.point?.every(Number.isFinite)) {
        const target: CameraPoint = [action.point[0], 0, action.point[1]];
        begin({ ...previous, target, position: previous.position.map((value, index) => value + target[index] - previous.target[index]) as CameraPoint });
      }
      if (action.kind === 'pan' && action.direction) {
        const offset = previous.position.map((value, index) => value - previous.target[index]) as CameraPoint;
        const basis = cameraBasis(offset);
        const axis = action.direction === 'left' || action.direction === 'right' ? basis.right : basis.up;
        const sign = action.direction === 'left' || action.direction === 'down' ? -1 : 1;
        const distance = Math.min(size.width, size.height) * 0.18 / previous.zoom * sign;
        apply({ ...previous, target: previous.target.map((value, index) => value + axis[index] * distance) as CameraPoint, position: previous.position.map((value, index) => value + axis[index] * distance) as CameraPoint });
      }
    }
    publish();
  }, [action, camera, apply, begin, publish, readPose, size.width, size.height]);

  useLayoutEffect(() => { if (!active || reducedMotion) settle(); }, [active, reducedMotion, settle]);

  useFrame((_, delta) => {
    if (!active || !controls.current || !(camera instanceof OrthographicCamera)) return;
    const pending = transition.current;
    if (pending) {
      pending.elapsed += Math.max(0, delta);
      if (pending.elapsed >= CAMERA_TRANSITION_SECONDS) settle();
      else apply(interpolateCameraPose(pending.from, pending.to, pending.elapsed / CAMERA_TRANSITION_SECONDS));
    } else if (followed.current) {
      const position = positions.get(followed.current);
      if (position) {
        // Only canonical movement positions enter this map; room desk anchors never do.
        followOffset.current.copy(camera.position).sub(controls.current.target);
        controls.current.target.copy(position);
        camera.position.copy(position).add(followOffset.current);
        controls.current.update(); publish();
      }
    }
  });

  return <OrbitControls ref={controls} enabled={active} enableRotate={rotatable} enableDamping={false} minZoom={CAMERA_MIN_ZOOM} maxZoom={CAMERA_MAX_ZOOM}
    mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: rotatable ? MOUSE.ROTATE : MOUSE.PAN }}
    touches={{ ONE: rotatable ? TOUCH.ROTATE : TOUCH.PAN, TWO: TOUCH.DOLLY_PAN }} onStart={stopAutomatic} onChange={publish} />;
}
