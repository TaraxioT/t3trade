/**
 * Camera: pixi-viewport wrapper with restrained isometric navigation.
 * Owner: skeleton worker (implemented in place).
 *
 * Movement model: GSAP tweens a plain proxy ({ cx, cy, scale }) and an
 * onUpdate applies it through viewport.moveCenter + scale.set, so every
 * transition (fit, focus, reset) is one code path and user input can cancel
 * it by killing the tween. User gestures (drag, wheel, pinch) are authoritative
 * and permanently stop resize-driven re-fitting.
 */
import gsap from "gsap";
import type { Application } from "pixi.js";
import type { Viewport } from "pixi-viewport";
import type { Point } from "../config/world.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "../config/world.js";

export interface Camera {
  /** Fit the whole campus with ~8% breathing room. */
  fitWorld(animated?: boolean): void;
  /** Focus a station anchor: GSAP ease, 650 to 850 ms. */
  focusOn(target: Point, zoom?: number): void;
  /** Clear selection back to the last resting view (does not jump). */
  resetView(): void;
  /** Current zoom clamped between fit scale and 2.25x fit scale. */
  getZoom(): number;
  screenToWorld(p: Point): Point;
  onUserGesture(cb: () => void): () => void;
  resize(w: number, h: number): void;
}

export interface CameraParams {
  app: Application;
  viewport: Viewport;
  host: HTMLElement;
}

/** Breathing room around the fitted campus; the slab should nearly fill the
 * viewport at fit zoom while keeping a sliver of space void. */
const FIT_MARGIN = 0.96;
/** Hard ceiling relative to the current fit scale. */
const MAX_ZOOM_FACTOR = 2.25;
/** Focus/fit transition length, inside the 650 to 850 ms contract. GSAP
 * durations are seconds; convert at the call site. */
const TWEEN_MS = 750;
const EASE = "power2.inOut";
/** pixi-viewport "moved" types that count as user intent. */
const USER_GESTURE_TYPES = new Set(["drag", "wheel", "pinch", "slide"]);

export function createCamera({ viewport }: CameraParams): Camera {
  const gestureSubs = new Set<() => void>();
  let interacted = false;
  let proxy = { cx: WORLD_WIDTH / 2, cy: WORLD_HEIGHT / 2, scale: 1 };
  let tween: gsap.core.Tween | null = null;

  const fitScale = (): number => {
    const w = viewport.screenWidth;
    const h = viewport.screenHeight;
    if (w <= 0 || h <= 0) return 1;
    return Math.min(w / WORLD_WIDTH, h / WORLD_HEIGHT) * FIT_MARGIN;
  };

  const applyProxy = (): void => {
    viewport.scale.set(proxy.scale);
    viewport.moveCenter(proxy.cx, proxy.cy);
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
      transitionTo(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, s, TWEEN_MS);
    } else {
      cancelTween();
      proxy = { cx: WORLD_WIDTH / 2, cy: WORLD_HEIGHT / 2, scale: s };
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
  };
  viewport.on("moved", onMoved);

  // pixi-viewport clampZoom bounds track the fit scale so wheel/pinch can
  // never exceed the plan's zoom range, even during smoothed gestures.
  const applyClamp = (): void => {
    const s = fitScale();
    viewport.clampZoom({ minScale: s, maxScale: s * MAX_ZOOM_FACTOR });
  };
  applyClamp();

  // Initial view: entire campus visible with the Central Trading Floor
  // (anchor 1430,740) slightly above the viewport center. Centering 120
  // world units below the anchor lifts the floor above the middle line while
  // Hyperliquid in the east stays inside the fitted frame.
  fitWorld(false);
  proxy = { cx: WORLD_WIDTH / 2, cy: 740 + 120, scale: fitScale() };
  applyProxy();

  return {
    fitWorld,

    focusOn(target: Point, zoom = 1): void {
      const base = fitScale();
      const s = Math.min(Math.max(base * zoom, base), base * MAX_ZOOM_FACTOR);
      transitionTo(target.x, target.y, s, TWEEN_MS);
    },

    resetView(): void {
      interacted = false;
      fitWorld(true);
    },

    getZoom(): number {
      const base = fitScale();
      return base > 0 ? viewport.scale.x / base : 1;
    },

    screenToWorld(p: Point): Point {
      const w = viewport.toWorld(p.x, p.y);
      return { x: w.x, y: w.y };
    },

    onUserGesture(cb: () => void): () => void {
      gestureSubs.add(cb);
      return () => {
        gestureSubs.delete(cb);
      };
    },

    resize(w: number, h: number): void {
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
        proxy = { cx: viewport.center.x, cy: viewport.center.y, scale: fitScale() };
        applyProxy();
      }
    },

  };
}
