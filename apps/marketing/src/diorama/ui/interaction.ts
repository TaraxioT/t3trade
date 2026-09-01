/**
 * Pointer + keyboard interaction: footprint hover, click-to-focus, selection
 * clearing, first-visit hint, affordance beacon. Owner: UI worker.
 *
 * Pointer selection and a11y keyboard selection share one code path
 * (focusStation) so both get camera, card, cue, pulse, and story behavior.
 */
import gsap from "gsap";
import { Graphics, type Container } from "pixi.js";
import type { DioramaContext } from "../core/context.js";
import type { Camera } from "../core/camera.js";
import type { InfoCard, CardStation } from "./infoCard.js";
import { allStations, type StationHandle } from "../core/registry.js";
import { DISTRICTS, STATIONS, type StationId } from "../config/stations.js";
import { HYPERLIQUID } from "../config/geometry.js";
import { safeDestroy } from "../core/iso.js";
import { setBannersDim } from "./labels.js";
import { CUES, playDioramaCue } from "../audio.js";

/** Pointer travel (px) under which a down/up pair still counts as a click. */
const DRAG_TOLERANCE = 6;

/** Same-station story re-click debounce window. */
const STORY_DEBOUNCE_MS = 2500;

/** Delay before the first-visit hint appears after the scene is ready. */
const HINT_DELAY_MS = 1200;

/**
 * Self-dismiss lifetime for the first-visit hint. The pill is guidance, not
 * state: a visitor who never interacts must not have it parked over world
 * labels (it clipped EMERGENCY CONTROL at the risk district's west seam when
 * it lived at bottom-center).
 */
const HINT_AUTO_DISMISS_MS = 9000;

/** Affordance beacon cadence until the first station selection. */
const BEACON_INTERVAL_MS = 6000;

/** sessionStorage key suppressing the hint for the rest of the session. */
const HINT_STORAGE_KEY = "t3-diorama-hint";

export interface InteractionDeps {
  camera: Camera;
  infoCard: InfoCard;
  /** Runs a station demo story (Director.runStory); fire-and-forget. */
  onRunStory?: (storyId: string) => void;
  /** Notified true on station focus and false on every clear path
   * (Escape, backdrop click, card close, HUD reset). Used for rail dimming. */
  onFocusChange?: (focused: boolean) => void;
  /** Notified on every selection transition: the selected station id (or the
   * synthetic "hyperliquid") when a selection is set, null on every clear
   * path (Escape, backdrop click, card close, HUD reset). Deduped, so
   * repeated clears fire once. main.ts drives rails.setFocusStation. */
  onSelectionChange?: (stationId: string | null) => void;
  /** True while a story is running (Director.isRunning); gates retry clicks. */
  isStoryActive?: (storyId: string) => boolean;
}

/** Any pickable station: configured StationDef or the Hyperliquid synthetic. */
type PickableStation = CardStation & { handle?: StationHandle };

/** Module hooks set by createInteraction; consumed by a11y + clearSelection. */
let activeCard: InfoCard | null = null;
let activeFocus: ((def: CardStation) => void) | null = null;
let activeClearHover: (() => void) | null = null;
let activeFocusChange: ((focused: boolean) => void) | null = null;
let activeSelectionChange: ((stationId: string | null) => void) | null = null;
/** Current selection id (module-level so clearSelection can detect transitions). */
let selectedStationId: string | null = null;

/** Set the selection id and fire the change hook on transition only. */
function setSelection(id: string | null): void {
  if (selectedStationId === id) return;
  selectedStationId = id;
  activeSelectionChange?.(id);
}

/** Shared selection clearing, also usable before interaction is wired. */
export function clearSelection(): void {
  activeCard?.hide();
  setBannersDim(false);
  activeClearHover?.();
  activeFocusChange?.(false);
  setSelection(null);
}

/** Focus a station programmatically (a11y directory, keyboard, stories). */
export function focusStationById(id: string): void {
  if (!activeFocus) return;
  const station = STATIONS[id as StationId];
  const def: CardStation | undefined =
    station ?? (id === HYPERLIQUID_DEF.id ? HYPERLIQUID_DEF : undefined);
  if (def) activeFocus(def);
}

/**
 * The external Hyperliquid platform has no StationId, so it is picked as a
 * synthetic station from its geometry constant.
 */
const HYPERLIQUID_DEF: CardStation = {
  id: "hyperliquid",
  district: "external",
  label: "HYPERLIQUID TESTNET",
  signSize: "lg",
  anchor: { x: HYPERLIQUID.cx, y: HYPERLIQUID.cy },
  size: { w: HYPERLIQUID.w + 40, d: HYPERLIQUID.d + 40 },
  blurb: "The external exchange, authoritative for positions, orders, and fills.",
  status: "Simulated feed",
  relation: "Execution → Hyperliquid → Reconciliation",
  focusZoom: 1.5,
};

/** Hit padding around the drawn footprint, matching the visible outline. */
const HIT_PAD = 8;

/** True when (worldX, worldY) lies inside the station's diamond footprint. */
function inFootprint(
  worldX: number,
  worldY: number,
  anchor: { x: number; y: number },
  size: { w: number; d: number },
): boolean {
  const dx = Math.abs(worldX - anchor.x) / (size.w / 2 + HIT_PAD);
  const dy = Math.abs(worldY - anchor.y) / (size.d / 2 + HIT_PAD);
  return dx + dy <= 1;
}

/** (Re)draw a footprint diamond outline sized to the station def. */
function drawDiamond(g: Graphics, size: { w: number; d: number }): void {
  const hw = size.w / 2 + HIT_PAD;
  const hd = size.d / 2 + HIT_PAD;
  g.clear();
  g.poly([0, -hd, hw, 0, 0, hd, -hw, 0]);
  g.stroke({ width: 2.5, color: 0xffffff });
}

export function createInteraction(ctx: DioramaContext, deps: InteractionDeps): void {
  activeCard = deps.infoCard;
  const canvas = ctx.app.canvas;
  const host = (canvas.parentElement ?? canvas) as HTMLElement;

  // Pooled hover diamond: one instance, redrawn and repositioned per hover.
  const hoverRing = new Graphics();
  hoverRing.visible = false;
  hoverRing.alpha = 0;
  ctx.layers.overlay.addChild(hoverRing);

  let downPoint: { x: number; y: number } | null = null;
  let hovered: string | null = null;
  let liftedRoot: Container | null = null;

  /**
   * Station lookup by world point: diamond footprint containment over the
   * registry plus the synthetic Hyperliquid platform, highest zIndex wins so
   * nested stations (holo core inside the floor) pick correctly.
   */
  const pickStation = (worldX: number, worldY: number): PickableStation | null => {
    let best: StationHandle | null = null;
    let bestZ = -Infinity;
    for (const station of allStations()) {
      const def = STATIONS[station.id];
      if (!inFootprint(worldX, worldY, def.anchor, def.size)) continue;
      if (station.root.zIndex > bestZ) {
        best = station;
        bestZ = station.root.zIndex;
      }
    }
    if (best) return { ...STATIONS[best.id], handle: best };
    if (inFootprint(worldX, worldY, HYPERLIQUID_DEF.anchor, HYPERLIQUID_DEF.size)) {
      return { ...HYPERLIQUID_DEF };
    }
    return null;
  };

  /** Soft lift on the hovered station's registered root (alpha nudge only). */
  const setLift = (station: PickableStation | null): void => {
    if (liftedRoot) {
      gsap.killTweensOf(liftedRoot);
      liftedRoot.alpha = 1;
      liftedRoot = null;
    }
    if (!station?.handle || ctx.reducedMotion) return;
    const root = station.handle.root;
    liftedRoot = root;
    gsap.to(root, {
      alpha: 0.9,
      duration: 0.2,
      yoyo: true,
      repeat: 1,
      ease: "sine.inOut",
      onComplete: () => {
        root.alpha = 1;
        if (liftedRoot === root) liftedRoot = null;
      },
    });
  };

  const setHover = (picked: PickableStation | null): void => {
    const id = picked?.id ?? null;
    if (id === hovered) return;
    hovered = id;
    setLift(picked);
    if (!picked) {
      canvas.style.cursor = "";
      gsap.to(hoverRing, {
        alpha: 0,
        duration: 0.2,
        overwrite: true,
        onComplete: () => {
          hoverRing.visible = false;
        },
      });
      return;
    }
    const def = picked;
    hoverRing.tint = DISTRICTS[def.district].accent;
    drawDiamond(hoverRing, def.size);
    hoverRing.position.set(def.anchor.x, def.anchor.y);
    hoverRing.visible = true;
    gsap.to(hoverRing, { alpha: 0.85, duration: 0.25, overwrite: true });
    canvas.style.cursor = "pointer";
  };

  const clearHover = (): void => {
    hovered = null;
    setLift(null);
    canvas.style.cursor = "";
    gsap.killTweensOf(hoverRing);
    hoverRing.alpha = 0;
    hoverRing.visible = false;
  };
  activeClearHover = clearHover;

  /** Station screen position for card placement; undefined without support. */
  const stationScreen = (anchor: {
    x: number;
    y: number;
  }): { x: number; y: number } | undefined => {
    const cam = deps.camera as Camera & {
      worldToScreen?: (p: { x: number; y: number }) => { x: number; y: number };
    };
    if (typeof cam.worldToScreen !== "function") return undefined;
    try {
      return cam.worldToScreen(anchor);
    } catch {
      return undefined;
    }
  };

  /** One-shot pulse ring at a station anchor (selection feedback). */
  const pulseAt = (x: number, y: number, size: { w: number; d: number }, accent: number): void => {
    const ring = new Graphics();
    drawDiamond(ring, size);
    ring.tint = accent;
    ring.position.set(x, y);
    ctx.layers.overlay.addChild(ring);
    if (ctx.reducedMotion) {
      gsap.to(ring, {
        alpha: 0,
        duration: 0.9,
        delay: 0.4,
        overwrite: true,
        onComplete: () => safeDestroy(ring),
      });
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

  // ----- Affordance beacon: gentle pulses until the first selection. -----

  const BEACON_TARGETS: CardStation[] = [STATIONS.tradingFloor, STATIONS.mcpHub, HYPERLIQUID_DEF];
  let beaconIndex = 0;
  let selectedOnce = false;
  let staticBeacon: Graphics | null = null;
  let beaconTimer: number | null = null;

  const stopBeacon = (): void => {
    if (beaconTimer !== null) {
      window.clearInterval(beaconTimer);
      beaconTimer = null;
    }
    if (staticBeacon) {
      safeDestroy(staticBeacon);
      staticBeacon = null;
    }
  };

  const runBeacon = (): void => {
    const def = BEACON_TARGETS[beaconIndex % BEACON_TARGETS.length];
    beaconIndex += 1;
    pulseAt(def.anchor.x, def.anchor.y, def.size, DISTRICTS[def.district].accent);
  };

  if (ctx.reducedMotion) {
    // Calm variant: one static outline on the trading floor, no cycling.
    staticBeacon = new Graphics();
    drawDiamond(staticBeacon, STATIONS.tradingFloor.size);
    staticBeacon.tint = DISTRICTS.floor.accent;
    staticBeacon.alpha = 0.5;
    staticBeacon.position.set(STATIONS.tradingFloor.anchor.x, STATIONS.tradingFloor.anchor.y);
    ctx.layers.overlay.addChild(staticBeacon);
  } else {
    beaconTimer = window.setInterval(() => {
      if (!selectedOnce) runBeacon();
    }, BEACON_INTERVAL_MS);
  }

  // ----- First-visit onboarding hint (DOM, one per session). -----
  // Top-center: the bottom band is crowded with world labels at fit zoom
  // (AUDIT, IDENTITY & ACCESS, RECONCILIATION, EMERGENCY CONTROL), while the
  // top-center band is the empty north void above Market Landscape and stays
  // clear of the top-right HUD cluster. The pill is pointer-events:none and
  // also self-dismisses (HINT_AUTO_DISMISS_MS), so it can never linger over
  // a label for a visitor who does not interact.

  let hintEl: HTMLElement | null = null;
  let hintTimer: number | null = null;
  let hintDismissed = false;

  const storageAvailable = (): boolean => {
    try {
      window.sessionStorage.getItem(HINT_STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  };
  const hintSeen = (): boolean => {
    try {
      return window.sessionStorage.getItem(HINT_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  };
  const markHintSeen = (): void => {
    try {
      window.sessionStorage.setItem(HINT_STORAGE_KEY, "1");
    } catch {
      // Private mode: the hint simply is not persisted.
    }
  };

  if (!document.getElementById("diorama-hint-style")) {
    const style = document.createElement("style");
    style.id = "diorama-hint-style";
    style.textContent = `
.diorama-hint{
  position:absolute;
  top:16px;
  left:50%;
  transform:translateX(-50%);
  z-index:5;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:10px;
  letter-spacing:.05em;
  color:#d9e8f2;
  background:rgba(7,17,31,.88);
  border:1px solid rgba(52,229,229,.22);
  border-radius:8px;
  padding:5px 9px;
  white-space:nowrap;
  opacity:0;
  transition:opacity .6s ease;
  pointer-events:none;
}
.diorama-hint-visible{opacity:1}
@media (prefers-reduced-motion: reduce){
  .diorama-hint{transition:none}
}`;
    document.head.appendChild(style);
  }

  const removeHint = (): void => {
    if (hintTimer !== null) {
      window.clearTimeout(hintTimer);
      hintTimer = null;
    }
    host.removeEventListener("pointerdown", dismissHint);
    host.removeEventListener("wheel", dismissHint);
    hintEl?.remove();
    hintEl = null;
  };

  const dismissHint = (): void => {
    if (hintDismissed) return;
    hintDismissed = true;
    markHintSeen();
    if (hintEl && !ctx.reducedMotion) {
      hintEl.classList.remove("diorama-hint-visible");
      const el = hintEl;
      window.setTimeout(() => el.remove(), 700);
      hintEl = null;
    } else {
      hintEl?.remove();
      hintEl = null;
    }
    host.removeEventListener("pointerdown", dismissHint);
    host.removeEventListener("wheel", dismissHint);
    if (hintTimer !== null) {
      window.clearTimeout(hintTimer);
      hintTimer = null;
    }
  };

  if (!hintSeen() && storageAvailable()) {
    hintTimer = window.setTimeout(() => {
      const narrow = window.matchMedia("(max-width: 640px)").matches;
      const el = document.createElement("p");
      el.className = "diorama-hint";
      el.dataset.dioramaHint = "1";
      el.textContent = narrow
        ? "Drag - pinch - tap stations"
        : "Drag to pan - scroll to zoom - click any station";
      host.appendChild(el);
      hintEl = el;
      if (ctx.reducedMotion) el.classList.add("diorama-hint-visible");
      else requestAnimationFrame(() => el.classList.add("diorama-hint-visible"));
      // Reuse the same cleared-on-teardown slot: once visible, the hint
      // dismisses itself even without interaction.
      hintTimer = window.setTimeout(dismissHint, HINT_AUTO_DISMISS_MS);
    }, HINT_DELAY_MS);
    host.addEventListener("pointerdown", dismissHint);
    host.addEventListener("wheel", dismissHint, { passive: true });
  }

  // ----- Selection (single shared path for pointer and keyboard). -----

  const lastStoryRun = new Map<string, number>();

  const maybeRunStory = (def: CardStation): void => {
    if (!def.story || !deps.onRunStory) return;
    // Already running (e.g. focus auto-ran it): do not silently retry a lock.
    if (deps.isStoryActive?.(def.story) === true) return;
    const now = performance.now();
    const last = lastStoryRun.get(def.id) ?? -Infinity;
    if (now - last < STORY_DEBOUNCE_MS) return;
    lastStoryRun.set(def.id, now);
    deps.onRunStory(def.story);
  };

  const focusStation = (def: CardStation): void => {
    selectedOnce = true;
    stopBeacon();
    dismissHint();
    deps.camera.focusOn(def.anchor, def.focusZoom ?? 1.35);
    deps.infoCard.show(def, undefined, stationScreen(def.anchor));
    setBannersDim(true);
    deps.onFocusChange?.(true);
    setSelection(def.id);
    pulseAt(def.anchor.x, def.anchor.y, def.size, DISTRICTS[def.district].accent);
    playDioramaCue(CUES.select);
    maybeRunStory(def);
    // The card was shown before the story auto-ran; now that a story may
    // have just launched, re-render its busy/disabled action state.
    deps.infoCard.refreshActionState();
  };
  activeFocus = focusStation;
  activeFocusChange = (focused: boolean): void => deps.onFocusChange?.(focused);
  activeSelectionChange = (stationId: string | null): void => deps.onSelectionChange?.(stationId);

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
    if (station) focusStation(station);
    else clearSelection();
  };
  const onMove = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const world = deps.camera.screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setHover(pickStation(world.x, world.y));
  };
  const onLeave = (): void => setHover(null);

  // Escape clears the selection; no other keys are touched here.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") clearSelection();
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  window.addEventListener("keydown", onKeyDown);

  ctx.onCleanup(() => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("keydown", onKeyDown);
    stopBeacon();
    removeHint();
    gsap.killTweensOf(hoverRing);
    setLift(null);
    hoverRing.destroy();
    clearHover();
    activeCard = null;
    activeFocus = null;
    activeClearHover = null;
    activeFocusChange = null;
    activeSelectionChange = null;
    selectedStationId = null;
  });
}
