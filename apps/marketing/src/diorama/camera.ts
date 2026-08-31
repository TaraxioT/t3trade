/**
 * pixi-viewport camera: fit + clamp + GSAP zone focus + idle drift.
 *
 * Framing model (fix-round 2): the width-fit scale is degenerate in
 * portrait, so zoom bounds and focus framing are derived from BOTH axes:
 *   widthFit  = vw * margin / worldW      (full overview, museum framing)
 *   heightFit = vh * 0.94 / worldH
 *   maxZoom   = max(widthFit * 2.4, heightFit * 1.5)
 * Zone focus frames the ZONE (not a multiple of widthFit):
 *   zoneFit = min(vw * 0.9 / zoneW, vh * 0.72 / zoneH)
 *   focus   = clamp(zoneFit, widthFit, min(max(widthFit*1.9, heightFit*1.5), maxZoom))
 * which keeps desktop focus at widthFit*1.9 (verified ~0.913 at 1440x900)
 * while letting portrait phone focus run as tight as the zone allows.
 * Reset/Esc/backdrop always return to the width-fit full overview.
 */
import gsap from "gsap";
import type { Viewport } from "pixi-viewport";
import { CAMERA, WORLD } from "./config";
import { ZONE_RECTS, zoneCenter } from "./config/positions";
import type { ZoneId } from "./config/positions";

export interface CameraHandle {
  viewport: Viewport;
  readonly fitScale: number;
  focusZone: (id: ZoneId) => void;
  resetCamera: () => void;
  worldToScreen: (x: number, y: number) => { x: number; y: number };
  screenToWorld: (sx: number, sy: number) => { x: number; y: number };
  markInput: () => void;
  onResize: (screenWidth: number, screenHeight: number) => void;
  dispose: () => void;
}

export function createCamera(viewport: Viewport, opts: { reducedMotion: boolean }): CameraHandle {
  const { reducedMotion } = opts;

  let widthFit = computeWidthFit(viewport.screenWidth);
  let heightFit = computeHeightFit(viewport.screenHeight);
  let maxZoom = computeMaxZoom(widthFit, heightFit);

  const applyZoomBounds = (): void => {
    viewport.clampZoom({ minScale: widthFit, maxScale: maxZoom });
  };

  viewport
    .drag({ direction: "all" })
    .wheel({ smooth: 6 })
    .pinch()
    .clamp({ direction: "all" })
    .decelerate({ friction: 0.94 });
  applyZoomBounds();

  // Initial framing: the whole world, centered, with margin.
  viewport.scale.set(widthFit);
  viewport.moveCenter(WORLD.width / 2, WORLD.height / 2);

  let focusTween: gsap.core.Tween | null = null;
  let driftTween: gsap.core.Tween | null = null;
  let lastInput = performance.now();
  let disposed = false;

  const markInput = (): void => {
    lastInput = performance.now();
    if (driftTween) {
      driftTween.kill();
      driftTween = null;
    }
    if (focusTween) {
      focusTween.kill();
      focusTween = null;
    }
  };

  // User input kills drift/focus tweens. NOTE: we deliberately do NOT
  // listen to "moved" — pixi-viewport's moveCenter (used by our own tweens)
  // also emits "moved", which would make every focus tween kill itself on
  // its first frame. Drag/pinch both begin with pointerdown.
  viewport.on("pointerdown", markInput);
  viewport.on("wheel", markInput);
  viewport.on("pinch-start", markInput);

  const clampTarget = (cx: number, cy: number, scale: number) => {
    const s = Math.min(Math.max(scale, widthFit), maxZoom);
    const halfW = viewport.screenWidth / 2 / s;
    const halfH = viewport.screenHeight / 2 / s;
    return {
      s,
      x: Math.min(Math.max(cx, halfW), WORLD.width - halfW),
      y: Math.min(Math.max(cy, halfH), WORLD.height - halfH),
    };
  };

  const tweenTo = (cx: number, cy: number, scale: number, duration: number): void => {
    focusTween?.kill();
    const state = { x: viewport.center.x, y: viewport.center.y, s: viewport.scale.x };
    const target = clampTarget(cx, cy, scale);
    focusTween = gsap.to(state, {
      x: target.x,
      y: target.y,
      s: target.s,
      duration,
      ease: "power2.inOut",
      onUpdate: () => {
        viewport.scale.set(state.s);
        viewport.moveCenter(state.x, state.y);
      },
    });
  };

  const resetCamera = (): void =>
    tweenTo(WORLD.width / 2, WORLD.height / 2, widthFit, CAMERA.focusDuration);

  const focusZone = (id: ZoneId): void => {
    const center = zoneCenter(id);
    const rect = ZONE_RECTS[id];
    // Portrait phones: a smaller vertical fraction adds top-edge margin and
    // the camera target is raised slightly so the framed zone (and its
    // actors' heads) sits lower on screen instead of clipping the viewport
    // top. Desktop framing (0.72 fraction, exact zone center) is a verified
    // anchor and is byte-for-byte unchanged.
    const portrait = viewport.screenWidth < CAMERA.phoneBreakpoint;
    const vFrac = portrait ? 0.6 : 0.72;
    const zoneFit = Math.min(
      (viewport.screenWidth * 0.9) / rect.w,
      (viewport.screenHeight * vFrac) / rect.h,
    );
    const cap = Math.min(Math.max(widthFit * 1.9, heightFit * 1.5), maxZoom);
    const headroomBias = portrait ? rect.h * 0.12 : 0;
    tweenTo(
      center.x,
      center.y - headroomBias,
      Math.min(Math.max(zoneFit, widthFit), cap),
      CAMERA.focusDuration,
    );
  };

  // Real resizes re-derive the framing model; user drag/pinch stays clamped
  // inside the world by the refreshed clampZoom bounds.
  const onResize = (screenWidth: number, screenHeight: number): void => {
    widthFit = computeWidthFit(screenWidth);
    heightFit = computeHeightFit(screenHeight);
    maxZoom = computeMaxZoom(widthFit, heightFit);
    applyZoomBounds();
  };

  // Idle drift: museum-display slow wander (spec §51), never under
  // reduced motion.
  const maybeDrift = (): void => {
    if (disposed || reducedMotion || driftTween || focusTween) return;
    if (performance.now() - lastInput < CAMERA.idleDriftDelaySec * 1000) return;
    const state = { x: viewport.center.x, y: viewport.center.y };
    const dx = (Math.random() - 0.5) * 2 * (60 + Math.random() * 80);
    const dy = (Math.random() - 0.5) * 2 * (30 + Math.random() * 40);
    const dist = Math.hypot(dx, dy);
    const target = clampTarget(state.x + dx, state.y + dy, viewport.scale.x);
    const duration = Math.max(dist / CAMERA.idleDriftSpeed, 12);
    driftTween = gsap.to(state, {
      x: target.x,
      y: target.y,
      duration,
      ease: "sine.inOut",
      onUpdate: () => viewport.moveCenter(state.x, state.y),
      onComplete: () => {
        driftTween = null;
        lastInput = performance.now() - CAMERA.idleDriftDelaySec * 1000 * 0.6;
      },
    });
  };

  // Self-scheduling idle check so no external loop needs to remember it.
  const driftCheck = (): void => {
    if (disposed) return;
    maybeDrift();
    gsap.delayedCall(2.5, driftCheck);
  };
  gsap.delayedCall(CAMERA.idleDriftDelaySec, driftCheck);

  return {
    viewport,
    get fitScale(): number {
      return widthFit;
    },
    focusZone,
    resetCamera,
    worldToScreen: (x, y) => viewport.toScreen(x, y),
    screenToWorld: (sx, sy) => viewport.toWorld(sx, sy),
    markInput,
    onResize,
    dispose: () => {
      disposed = true;
      focusTween?.kill();
      driftTween?.kill();
      viewport.off("pointerdown", markInput);
      viewport.off("wheel", markInput);
      viewport.off("pinch-start", markInput);
    },
  };
}

function computeWidthFit(screenWidth: number): number {
  return (screenWidth * CAMERA.fitMargin) / WORLD.width;
}

function computeHeightFit(screenHeight: number): number {
  return (screenHeight * 0.94) / WORLD.height;
}

function computeMaxZoom(widthFit: number, heightFit: number): number {
  return Math.max(widthFit * CAMERA.maxZoomFactor, heightFit * 1.5);
}
