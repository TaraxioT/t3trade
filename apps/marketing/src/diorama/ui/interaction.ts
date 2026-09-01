/**
 * Pointer interaction: hover glow, click-to-focus, selection clearing.
 * Owner: UI worker.
 */
import gsap from "gsap";
import { Graphics } from "pixi.js";
import type { DioramaContext } from "../core/context.js";
import type { Camera } from "../core/camera.js";
import type { InfoCard } from "./infoCard.js";
import { allStations, type StationHandle } from "../core/registry.js";
import { DISTRICTS, STATIONS, type StationId, type StationDef } from "../config/stations.js";
import { HYPERLIQUID } from "../config/geometry.js";
import { safeDestroy } from "../core/iso.js";
import { PALETTE } from "../config/palette.js";
import { setBannersDim } from "./labels.js";
import { CUES, playDioramaCue } from "../audio.js";

/** Pointer travel (px) under which a down/up pair still counts as a click. */
const DRAG_TOLERANCE = 6;

interface FocusDeps {
  camera: Camera;
  infoCard: InfoCard;
}

/** Set by createInteraction; consumed by a11y keyboard focus. */
let focusDeps: FocusDeps | null = null;

/** Shared selection clearing, also usable before interaction is wired. */
export function clearSelection(): void {
  focusDeps?.infoCard.hide();
  setBannersDim(false);
}

/** Focus a station programmatically (a11y directory, future stories). */
export function focusStationById(id: string): void {
  const station = STATIONS[id as StationId];
  if (!station || !focusDeps) return;
  focusDeps.camera.focusOn(station.anchor, station.focusZoom ?? 1.35);
  focusDeps.infoCard.show(station);
  setBannersDim(true);
}

/**
 * The external Hyperliquid platform has no StationId, so it is picked as a
 * synthetic station from its geometry constant.
 */
const HYPERLIQUID_DEF: StationDef = {
  id: "tradingFloor", // placeholder id; only used for card data below
  district: "external",
  label: "HYPERLIQUID TESTNET",
  signSize: "lg",
  anchor: { x: HYPERLIQUID.cx, y: HYPERLIQUID.cy },
  size: { w: HYPERLIQUID.w + 40, d: HYPERLIQUID.d + 40 },
  blurb: "The external exchange, authoritative for positions, orders, and fills.",
  status: "Testnet live",
  relation: "Execution → Hyperliquid → Reconciliation",
  focusZoom: 1.5,
};

function makeRing(accent: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, 46);
  g.stroke({ width: 2.5, color: accent, alpha: 0.9 });
  return g;
}

export function createInteraction(ctx: DioramaContext, deps: { camera: Camera; infoCard: InfoCard }): void {
  focusDeps = deps;
  const canvas = ctx.app.canvas;
  const host = canvas.parentElement ?? canvas;

  // Pooled hover ring: one instance, repositioned per hover.
  const hoverRing = makeRing(PALETTE.cyan);
  hoverRing.visible = false;
  hoverRing.alpha = 0;
  ctx.layers.overlay.addChild(hoverRing);

  let downPoint: { x: number; y: number } | null = null;
  let hovered: string | null = null;

  /**
   * Station lookup by world point. Pixi's nested hit testing proved
   * unreliable under the viewport's managed event surface, so selection uses
   * a direct containment test over the registry in world space (rectangles
   * around each anchor, topmost zIndex wins). The external Hyperliquid
   * platform is picked from its geometry constant.
   */
  const pickStation = (worldX: number, worldY: number): { def: StationDef; handle?: StationHandle } | null => {
    let best: StationHandle | null = null;
    let bestZ = -Infinity;
    for (const station of allStations()) {
      const def = STATIONS[station.id];
      const hw = def.size.w / 2 + 12;
      const hd = def.size.d / 2 + 12;
      if (
        worldX >= def.anchor.x - hw &&
        worldX <= def.anchor.x + hw &&
        worldY >= def.anchor.y - hd &&
        worldY <= def.anchor.y + hd &&
        station.root.zIndex > bestZ
      ) {
        best = station;
        bestZ = station.root.zIndex;
      }
    }
    if (best) return { def: STATIONS[best.id], handle: best };
    const hx = HYPERLIQUID_DEF.anchor.x;
    const hy = HYPERLIQUID_DEF.anchor.y;
    const hw = HYPERLIQUID_DEF.size.w / 2;
    const hd = HYPERLIQUID_DEF.size.d / 2;
    if (worldX >= hx - hw && worldX <= hx + hw && worldY >= hy - hd && worldY <= hy + hd) {
      return { def: HYPERLIQUID_DEF };
    }
    return null;
  };

  const setHover = (picked: { def: StationDef } | null): void => {
    const id = picked?.def.anchor ? `${picked.def.label}` : null;
    if (id === hovered) return;
    hovered = id;
    if (!picked) {
      canvas.style.cursor = "";
      gsap.to(hoverRing, { alpha: 0, duration: 0.2, overwrite: true, onComplete: () => {
        hoverRing.visible = false;
      } });
      return;
    }
    const def = picked.def;
    const accent = DISTRICTS[def.district].accent;
    hoverRing.tint = accent;
    hoverRing.position.set(def.anchor.x, def.anchor.y);
    hoverRing.visible = true;
    gsap.to(hoverRing, { alpha: 0.85, duration: 0.25, overwrite: true });
    canvas.style.cursor = "pointer";
  };

  /** One-shot pulse ring at a station anchor (selection feedback). */
  const pulseAt = (x: number, y: number, accent: number): void => {
    const ring = makeRing(accent);
    ring.position.set(x, y);
    ctx.layers.overlay.addChild(ring);
    if (ctx.reducedMotion) {
      window.setTimeout(() => safeDestroy(ring), 700);
      return;
    }
    ring.scale.set(0.5);
    gsap.to(ring, {
      alpha: 0,
      scale: 1.8,
      duration: 0.7,
      ease: "power2.out",
      overwrite: true,
      onComplete: () => safeDestroy(ring),
    });
  };

  const selectStation = (picked: { def: StationDef }): void => {
    const def = picked.def;
    deps.camera.focusOn(def.anchor, def.focusZoom ?? 1.35);
    deps.infoCard.show(def);
    setBannersDim(true);
    pulseAt(def.anchor.x, def.anchor.y, DISTRICTS[def.district].accent);
    playDioramaCue(CUES.select);
  };

  // Canvas-level pointer handling: down records the point, up picks a station
  // when the pointer did not travel (drag threshold) and clears otherwise.
  const onDown = (e: PointerEvent): void => {
    downPoint = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent): void => {
    if (!downPoint) return;
    const moved = Math.hypot(e.clientX - downPoint.x, e.clientY - downPoint.y);
    downPoint = null;
    if (moved > DRAG_TOLERANCE) return;
    const rect = canvas.getBoundingClientRect();
    const world = deps.camera.screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const station = pickStation(world.x, world.y);
    if (station) selectStation(station);
    else clearSelection();
  };
  const onMove = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const world = deps.camera.screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setHover(pickStation(world.x, world.y));
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", () => setHover(null));

  ctx.onCleanup(() => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", () => setHover(null));
    gsap.killTweensOf(hoverRing);
    hoverRing.destroy();
    setHover(null);
    focusDeps = null;
  });
}
