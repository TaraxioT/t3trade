/**
 * Camera: pixi-viewport wrapper with restrained isometric navigation.
 * Owner: skeleton worker (implemented in place).
 *
 * Movement model: GSAP tweens a plain proxy ({ cx, cy, scale }) and an
 * onUpdate applies it through viewport.moveCenter + scale.set, so every
 * transition (fit, focus, reset) is one code path and user input can cancel
 * it by killing the tween. User gestures (drag, wheel, pinch) are authoritative
 * and permanently stop resize-driven re-fitting.
 *
 * Zoom broadcast: every applied move (gesture or tween) emits the current
 * fit-relative zoom, throttled to ~100 ms, to instance subscribers (onZoom)
 * and to a module-level broadcast (onWorldZoom) so sign LOD in ui/labels.ts
 * can react without holding the camera instance. One live camera at a time.
 */
import gsap from "gsap";
import type { Application } from "pixi.js";
import type { Viewport } from "pixi-viewport";
import type { Point } from "../config/world.js";

export interface Camera {
  /** Fit the whole room-view box (room + plinth + walls) with ~6% breathing room. */
  fitWorld(animated?: boolean): void;
  /** Focus a station anchor: GSAP ease, 650 to 850 ms. */
  focusOn(target: Point, zoom?: number): void;
  /** Clear selection back to the last resting view (does not jump). */
  resetView(): void;
  /** Current zoom clamped between fit scale and 2.25x fit scale. */
  getZoom(): number;
  screenToWorld(p: Point): Point;
  /** World point to screen (CSS) pixels; used for audio panning and QA. */
  worldToScreen(p: { x: number; y: number }): { x: number; y: number };
  /** Throttled (~100 ms) zoom notifications, fit-relative (1 = fit). */
  onZoom(cb: (zoom: number) => void): () => void;
  onUserGesture(cb: () => void): () => void;
  resize(w: number, h: number): void;
}

export interface CameraParams {
  app: Application;
  viewport: Viewport;
  host: HTMLElement;
}

/**
 * The room-view box: the room diamond plus plinth treads and wall height.
 * The +52 axial tread makes the outer diamond 2728 x 1364 (bbox x 44..2772,
 * y 86..1450; the decision doc's x range 96..2720 under-counted the tread),
 * wall tops reach y 18 at the N corner, and the drop shadow stays inside.
 * fit frames exactly this box, so nothing clips.
 */
const ROOM_VIEW = { x1: 40, y1: 6, x2: 2776, y2: 1456 } as const;
const ROOM_VIEW_W = ROOM_VIEW.x2 - ROOM_VIEW.x1;
const ROOM_VIEW_H = ROOM_VIEW.y2 - ROOM_VIEW.y1;
const ROOM_VIEW_CX = (ROOM_VIEW.x1 + ROOM_VIEW.x2) / 2;
const ROOM_VIEW_CY = (ROOM_VIEW.y1 + ROOM_VIEW.y2) / 2;
/** Breathing room around the fitted room-view box; the room nearly fills the
 * viewport at fit zoom while keeping a sliver of void. */
const FIT_MARGIN = 0.94;
/** Hard ceiling relative to the current fit scale. */
const MAX_ZOOM_FACTOR = 2.25;
/** Focus/fit transition length, inside the 650 to 850 ms contract. GSAP
 * durations are seconds; convert at the call site. */
const TWEEN_MS = 750;
const EASE = "power2.inOut";
/** pixi-viewport "moved" types that count as user intent. */
const USER_GESTURE_TYPES = new Set(["drag", "wheel", "pinch", "slide"]);
/** Zoom notification throttle window in milliseconds. */
const ZOOM_EMIT_MS = 100;
/** Portrait/narrow initial framing: aspect below this focuses the floor. */
const PORTRAIT_ASPECT = 0.9;
/** Portrait initial view: Central Trading Floor at fit * 1.35. */
const PORTRAIT_FOCUS = { cx: 1435, cy: 850, zoom: 1.35 } as const;

/** Zoom >= this: LOD tier 1 (all station labels visible). */
export const ZOOM_TIER_1 = 1.15;
/** Zoom >= this: LOD tier 2 (deep zoom, fine detail tier). */
export const ZOOM_TIER_2 = 1.8;

/** LOD tier for a fit-relative zoom value. */
export function lodLevelForZoom(zoom: number): 0 | 1 | 2 {
  if (zoom >= ZOOM_TIER_2) return 2;
  if (zoom >= ZOOM_TIER_1) return 1;
  return 0;
}

type ZoomListener = (zoom: number) => void;

/** Module-level zoom broadcast; replays the last emitted zoom on subscribe. */
const worldZoomSubs = new Set<ZoomListener>();
let lastZoom = 1;

/** Subscribe to throttled zoom changes without holding the camera instance. */
export function onWorldZoom(cb: ZoomListener): () => void {
  worldZoomSubs.add(cb);
  cb(lastZoom);
  return () => {
    worldZoomSubs.delete(cb);
  };
}

export function createCamera({ viewport }: CameraParams): Camera {
  const gestureSubs = new Set<() => void>();
  const zoomSubs = new Set<ZoomListener>();
  let interacted = false;
  let proxy = { cx: ROOM_VIEW_CX, cy: ROOM_VIEW_CY, scale: 1 };
  let tween: gsap.core.Tween | null = null;
  let lastEmit = 0;

  const fitScale = (): number => {
    const w = viewport.screenWidth;
    const h = viewport.screenHeight;
    if (w <= 0 || h <= 0) return 1;
    return Math.min(w / ROOM_VIEW_W, h / ROOM_VIEW_H) * FIT_MARGIN;
  };

  const currentZoom = (): number => {
    const base = fitScale();
    return base > 0 ? viewport.scale.x / base : 1;
  };

  const emitZoom = (): void => {
    const now = performance.now();
    if (now - lastEmit < ZOOM_EMIT_MS) return;
    lastEmit = now;
    lastZoom = currentZoom();
    for (const cb of zoomSubs) cb(lastZoom);
    for (const cb of worldZoomSubs) cb(lastZoom);
  };

  const applyProxy = (): void => {
    viewport.scale.set(proxy.scale);
    viewport.moveCenter(proxy.cx, proxy.cy);
    emitZoom();
  };

  const cancelTween = (): void => {
    if (tween) {
      tween.kill();
      tween = null;
    }
  };

  const transitionTo = (cx: number, cy: number, scale: number, durationMs: number): void => {
    cancelTween();
    proxy = { cx: viewport.center.x, cy: viewport.center.y, scale: viewport.scale.x };
    // GSAP durations are seconds; callers speak milliseconds.
    tween = gsap.to(proxy, {
      cx,
      cy,
      scale,
      duration: durationMs / 1000,
      ease: EASE,
      onUpdate: applyProxy,
      onComplete: () => {
        tween = null;
      },
    });
  };

  const fitWorld = (animated = true): void => {
    const s = fitScale();
    if (animated) {
      transitionTo(ROOM_VIEW_CX, ROOM_VIEW_CY, s, TWEEN_MS);
    } else {
      cancelTween();
      proxy = { cx: ROOM_VIEW_CX, cy: ROOM_VIEW_CY, scale: s };
      applyProxy();
    }
  };

  /**
   * The one framing policy shared by initial view, resize refit, and reset:
   * landscape centers the room-view box (room diamond + plinth + walls) at
   * fit scale; portrait/narrow (aspect < 0.9) opens on the Central Trading
   * Floor at fit * 1.35 centered near (1435, 850).
   */
  const applyDefaultFraming = (animated: boolean): void => {
    const aspect = viewport.screenHeight > 0 ? viewport.screenWidth / viewport.screenHeight : 1;
    const target =
      aspect > 0 && aspect < PORTRAIT_ASPECT
        ? { cx: PORTRAIT_FOCUS.cx, cy: PORTRAIT_FOCUS.cy, scale: fitScale() * PORTRAIT_FOCUS.zoom }
        : { cx: ROOM_VIEW_CX, cy: ROOM_VIEW_CY, scale: fitScale() };
    if (animated) {
      transitionTo(target.cx, target.cy, target.scale, TWEEN_MS);
    } else {
      cancelTween();
      proxy = target;
      applyProxy();
    }
  };

  // pixi-viewport emits "moved" for every reposition; the type field
  // discriminates programmatic moves from user input. Wheel smoothing fires
  // "moved" with type "wheel" per animated step, so one gesture cancels once
  // and marks intent permanently.
  const onMoved = (data: { type?: string }): void => {
    if (data?.type && USER_GESTURE_TYPES.has(data.type)) {
      cancelTween();
      if (!interacted) {
        interacted = true;
      }
      for (const cb of gestureSubs) cb();
    }
    emitZoom();
  };
  viewport.on("moved", onMoved);

  // pixi-viewport clampZoom bounds track the fit scale so wheel/pinch can
  // never exceed the plan's zoom range, even during smoothed gestures.
  const applyClamp = (): void => {
    const s = fitScale();
    viewport.clampZoom({ minScale: s, maxScale: s * MAX_ZOOM_FACTOR });
  };
  applyClamp();

  // Initial view. Landscape: the whole room-view box centered at fit scale;
  // the floor diamond fills the frame and the open S corner faces the
  // camera. Portrait/narrow: a whole-room fit is an illegible strip, so open
  // on the Central Trading Floor at fit * 1.35 centered near (1435, 850);
  // zoom min stays at fit so the user can still zoom out to the full room.
  fitWorld(false);
  applyDefaultFraming(false);

  return {
    fitWorld,

    focusOn(target: Point, zoom = 1): void {
      const base = fitScale();
      const s = Math.min(Math.max(base * zoom, base), base * MAX_ZOOM_FACTOR);
      transitionTo(target.x, target.y, s, TWEEN_MS);
    },

    resetView(): void {
      interacted = false;
      applyDefaultFraming(true);
    },

    getZoom(): number {
      return currentZoom();
    },

    screenToWorld(p: Point): Point {
      const w = viewport.toWorld(p.x, p.y);
      return { x: w.x, y: w.y };
    },

    worldToScreen(p: { x: number; y: number }): { x: number; y: number } {
      const s = viewport.toScreen(p.x, p.y);
      return { x: s.x, y: s.y };
    },

    onZoom(cb: (zoom: number) => void): () => void {
      zoomSubs.add(cb);
      cb(lastZoom);
      return () => {
        zoomSubs.delete(cb);
      };
    },

    onUserGesture(cb: () => void): () => void {
      gestureSubs.add(cb);
      return () => {
        gestureSubs.delete(cb);
      };
    },

    resize(w: number, h: number): void {
      // The camera owns the viewport resize: callers hand dimensions here and
      // nowhere else, so this comparison can never be defeated by an external
      // viewport.resize having already updated screenWidth/screenHeight.
      // Ignore no-op and mid-tween resizes: hosts commonly emit spurious
      // observations (loader hide, canvas autoDensity writes) and a refit
      // during a focus tween visibly fights the transition.
      const dw = Math.abs(w - viewport.screenWidth);
      const dh = Math.abs(h - viewport.screenHeight);
      if (dw < 2 && dh < 2) return;
      viewport.resize(w, h);
      applyClamp();
      // Only re-frame when the user has not taken control; otherwise let
      // pixi-viewport clamp the existing view into the new bounds.
      if (!interacted && !(tween?.isActive() ?? false)) {
        applyDefaultFraming(false);
      }
    },

  };
}
