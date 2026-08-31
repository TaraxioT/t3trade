/**
 * Authored orthographic camera (M03).
 *
 * Isometric yaw/pitch come from config.CAMERA_ISO and are locked; only the
 * shot target/zoom/drift in config.CAMERA_SHOTS are authored. Pitch is a
 * single tunable constant in config (currently atan(1/pi) ~ 0.3097 rad; the
 * classic iso alternative is Math.atan(1 / Math.SQRT2) ~ 0.6155 rad).
 *
 * Framing: fitCameraToStage keeps a fixed logical scene box (bureau plus
 * satellite plus margin, derived from config.DIMENSIONS). Wide viewports
 * expand the horizontal frustum; narrow viewports expand the vertical one.
 * The applied fit scalar (half-height in scene units) is returned so shot
 * zoom multiplies on top of it, never substitutes for it.
 *
 * All hot-path evaluation is allocation-free: scratch vectors live in the
 * handle closure.
 */

import * as THREE from "three";
import { CAMERA_ISO, CAMERA_SHOTS, DIMENSIONS, DURATION_MS } from "../config";
import { clamp, lerp, periodic, saturate } from "../math";

/** Cross-fade duration into each new shot, in ms. */
const SHOT_EASE_MS = 1500;

/** Maximum pointer-parallax offset magnitude, in scene units. */
const PARALLAX_MAX = 0.6;

/** Fixed camera distance; orthographic, so any value beyond the scene works. */
const CAMERA_DISTANCE = 90;

/**
 * Logical scene box (v2 stepped-campus composition), derived from
 * DIMENSIONS.composition: full deck footprint plus the satellite's reach in
 * X/Z, plinth bottom to fitTopY + fxHeadroom in Y. The satellite is included
 * horizontally but capped vertically by fitTopY (terrace tower dominates).
 */
const SCENE_BOX = (() => {
  const c = DIMENSIONS.composition;
  const minX = Math.min(c.deckMinX, c.satellite.x - c.satellite.radius);
  const maxX = Math.max(c.deckMaxX, c.satellite.x + c.satellite.radius);
  const minY = DIMENSIONS.plinth.bottomY;
  const maxY = c.fitTopY + c.fxHeadroom;
  const minZ = Math.min(c.deckMinZ, c.satellite.z - c.satellite.radius);
  const maxZ = Math.max(c.deckMaxZ, c.satellite.z + c.satellite.radius);
  return { minX, maxX, minY, maxY, minZ, maxZ };
})();

export interface CameraHandle {
  readonly camera: THREE.OrthographicCamera;
  /** Fit the fixed logical scene box to a CSS-pixel viewport; returns the applied fit half-height. */
  fitCameraToStage(width: number, height: number): number;
  /** Evaluate the authored shot track + drift + parallax at a logical time. */
  evaluateCamera(timeMs: number, responsiveFit: number): void;
  /** Normalized pointer in [-1, 1] driving the additive parallax offset. */
  setPointerParallax(nx: number, ny: number): void;
  /** Reduced-motion / non-hover switch; disables and zeroes parallax. */
  setParallaxEnabled(enabled: boolean): void;
}

/** Compute the shot active at cyclic time t plus the previous (cross-fade) shot. */
function shotIndicesAt(t: number): { current: number; previous: number } {
  let current = 0;
  for (let i = 0; i < CAMERA_SHOTS.length; i += 1) {
    if (CAMERA_SHOTS[i]?.startMs <= t) current = i;
  }
  const previous = (current - 1 + CAMERA_SHOTS.length) % CAMERA_SHOTS.length;
  return { current, previous };
}

export function createCamera(_registry: unknown): CameraHandle {
  void _registry; // A camera holds no GPU resources; accepted for call-site symmetry.

  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);

  // Frozen isometric orientation basis from config.
  const yaw = CAMERA_ISO.yawRadians;
  const pitch = CAMERA_ISO.pitchRadians;
  const direction = new THREE.Vector3(
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  ).normalize();
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).normalize();
  const up = new THREE.Vector3().crossVectors(right, direction).normalize();

  // Hot-path scratch (never allocated per frame).
  const target = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const boxCenter = new THREE.Vector3();
  const fitCorner = new THREE.Vector3();
  const fitProjected = new THREE.Vector3();

  let viewportAspect = 1;
  let parallaxX = 0;
  let parallaxY = 0;
  let parallaxEnabled = true;

  // Cached responsive fit: recomputed only when the CSS viewport changes.
  let cachedFitWidth = -1;
  let cachedFitHeight = -1;
  let cachedFitHalfH = 0;

  const handle: CameraHandle = {
    camera,

    fitCameraToStage(width: number, height: number): number {
      if (width === cachedFitWidth && height === cachedFitHeight && cachedFitHalfH > 0) {
        return cachedFitHalfH; // unchanged viewport: keep the cached fit
      }
      const aspect = width > 0 && height > 0 ? width / height : 1;
      viewportAspect = aspect;

      // Project the logical scene box onto the camera's screen axes.
      boxCenter.set(
        (SCENE_BOX.minX + SCENE_BOX.maxX) / 2,
        (SCENE_BOX.minY + SCENE_BOX.maxY) / 2,
        (SCENE_BOX.minZ + SCENE_BOX.maxZ) / 2,
      );
      let halfW = 0;
      let halfH = 0;
      for (let i = 0; i < 8; i += 1) {
        fitCorner.set(
          i & 1 ? SCENE_BOX.maxX : SCENE_BOX.minX,
          i & 2 ? SCENE_BOX.maxY : SCENE_BOX.minY,
          i & 4 ? SCENE_BOX.maxZ : SCENE_BOX.minZ,
        );
        fitProjected.subVectors(fitCorner, boxCenter);
        halfW = Math.max(halfW, Math.abs(fitProjected.dot(right)));
        halfH = Math.max(halfH, Math.abs(fitProjected.dot(up)));
      }

      // Fixed logical box: wide viewports expand horizontally, narrow expand
      // vertically. The fit scalar is the applied half-height.
      const fitHalfH = aspect >= halfW / halfH ? halfH : halfW / aspect;
      camera.left = -fitHalfH * aspect;
      camera.right = fitHalfH * aspect;
      camera.top = fitHalfH;
      camera.bottom = -fitHalfH;
      camera.updateProjectionMatrix();
      cachedFitWidth = width;
      cachedFitHeight = height;
      cachedFitHalfH = fitHalfH;
      return fitHalfH;
    },

    evaluateCamera(timeMs: number, responsiveFit: number): void {
      const t = periodic(timeMs, DURATION_MS);
      const { current, previous } = shotIndicesAt(t);
      const shot = CAMERA_SHOTS[current] as (typeof CAMERA_SHOTS)[number];
      const prev = CAMERA_SHOTS[previous] as (typeof CAMERA_SHOTS)[number];

      const nextStart =
        current === CAMERA_SHOTS.length - 1
          ? DURATION_MS
          : (CAMERA_SHOTS[current + 1]?.startMs ?? DURATION_MS);
      const windowMs = Math.max(nextStart - shot.startMs, 1);
      const localMs = t - shot.startMs;

      // Cross-fade from the previous shot's end framing over the first
      // SHOT_EASE_MS of this shot; drift advances linearly across the window.
      const blend = saturate(localMs / SHOT_EASE_MS);
      const eased = blend * blend * (3 - 2 * blend); // smoothstep, allocation-free
      const driftT = clamp(localMs / windowMs, 0, 1);

      // Previous shot's END framing (its drift fully applied) cross-fades
      // into this shot; drift is [dx, dz] on the ground plane.
      const prevDriftX = prev.drift[0] ?? 0;
      const prevDriftZ = prev.drift[1] ?? 0;
      const driftX = shot.drift[0] ?? 0;
      const driftZ = shot.drift[1] ?? 0;
      target.set(
        lerp(prev.target[0] + prevDriftX, shot.target[0] + driftX * driftT, eased),
        lerp(prev.target[1], shot.target[1], eased),
        lerp(prev.target[2] + prevDriftZ, shot.target[2] + driftZ * driftT, eased),
      );

      const zoom = lerp(prev.zoom, shot.zoom, eased);

      // Frustum: responsive fit half-height with shot zoom as a multiplier.
      camera.left = -responsiveFit * viewportAspect;
      camera.right = responsiveFit * viewportAspect;
      camera.top = responsiveFit;
      camera.bottom = -responsiveFit;
      camera.zoom = zoom;
      camera.updateProjectionMatrix();

      // Additive pointer parallax (screen-plane translation), capped.
      offset.set(0, 0, 0);
      if (parallaxEnabled) {
        offset.addScaledVector(right, parallaxX * PARALLAX_MAX * 0.7);
        offset.addScaledVector(up, parallaxY * PARALLAX_MAX * 0.7);
        if (offset.length() > PARALLAX_MAX) offset.setLength(PARALLAX_MAX);
      }

      camera.position.copy(target).addScaledVector(direction, CAMERA_DISTANCE).add(offset);
      camera.lookAt(target.x + offset.x, target.y + offset.y, target.z + offset.z);
    },

    setPointerParallax(nx: number, ny: number): void {
      parallaxX = clamp(nx, -1, 1);
      parallaxY = clamp(ny, -1, 1);
    },

    setParallaxEnabled(enabled: boolean): void {
      parallaxEnabled = enabled;
      if (!enabled) {
        parallaxX = 0;
        parallaxY = 0;
      }
    },
  };

  // Initial framing so the camera is valid before the first fit/evaluate.
  handle.fitCameraToStage(16, 9);

  return handle;
}

// ---------------------------------------------------------------------------
// Free-function forms (frozen mission vocabulary). Both delegate to the
// handle's own methods, so callers may use either style.
// ---------------------------------------------------------------------------

export function fitCameraToStage(camera: CameraHandle, w: number, h: number): number {
  return camera.fitCameraToStage(w, h);
}

export function evaluateCamera(camera: CameraHandle, timeMs: number, responsiveFit: number): void {
  camera.evaluateCamera(timeMs, responsiveFit);
}

export function setPointerParallax(camera: CameraHandle, nx: number, ny: number): void {
  camera.setPointerParallax(nx, ny);
}
