/**
 * Zone interaction: invisible generous hit areas, hover name labels
 * (world-anchored), click-to-focus with a DOM info card anchored via
 * worldToScreen, Esc/backdrop dismissal, and the a11y "Explore <zone>"
 * buttons with keyboard focus parity (spec §32-34, §46).
 */
import { Container, Graphics, Text } from "pixi.js";
import { ZONE_RECTS, ZONES } from "../config/positions";
import type { ZoneId, ZoneDef } from "../config/positions";
import type { CameraHandle } from "../camera";

export interface HotspotDeps {
  hotspotLayer: Container;
  labelLayer: Container;
  camera: CameraHandle;
  director: { emphasize: (zone: ZoneId | null) => void };
  stage: HTMLElement;
  announcer: HTMLElement;
  onFocus?: (zone: ZoneId) => void;
}

export interface HotspotsHandle {
  setActiveZone: (id: ZoneId | null) => void;
  update: () => void;
  dispose: () => void;
}

const LABEL_STYLE = {
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 17,
  fontWeight: "600",
  fill: "#eef2f6",
  letterSpacing: 1.5,
} as const;

export function createHotspots(deps: HotspotDeps): HotspotsHandle {
  const { hotspotLayer, labelLayer, camera, director, stage, announcer } = deps;

  let activeZone: ZoneId | null = null;
  let hoverLabel: Container | null = null;
  let emphasizedZone: ZoneId | null = null;
  let zoneStress: Graphics | null = null;
  const disposers: Array<() => void> = [];

  // ------------------------------------------------------------ DOM card
  const card = document.createElement("div");
  card.className = "zone-card";
  card.hidden = true;
  card.innerHTML =
    '<p class="zone-card-eyebrow"></p><h2 class="zone-card-title"></h2><p class="zone-card-copy"></p><button class="zone-card-close" type="button" aria-label="Close">✕</button>';
  stage.parentElement?.appendChild(card);
  const eyebrow = card.querySelector<HTMLElement>(".zone-card-eyebrow");
  const title = card.querySelector<HTMLElement>(".zone-card-title");
  const copy = card.querySelector<HTMLElement>(".zone-card-copy");
  const closeButton = card.querySelector<HTMLButtonElement>(".zone-card-close");

  // ------------------------------------------------------ a11y zone nav
  // Compact disclosure: a single "Explore systems" button opens the 13
  // zone chips as a popover grid. Keyboard reachable, Esc and click-outside
  // close it, focus parity on each chip is unchanged.
  const drawer = document.createElement("div");
  drawer.className = "zone-drawer";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "zone-drawer-toggle";
  toggle.textContent = "Explore systems";
  toggle.setAttribute("aria-expanded", "false");
  const nav = document.createElement("nav");
  nav.className = "zone-nav";
  nav.setAttribute("aria-label", "Explore diorama zones");
  nav.hidden = true;
  const buttons = new Map<ZoneId, HTMLButtonElement>();
  for (const zone of ZONES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Explore ${zone.name}`;
    const activate = () => openZone(zone.id);
    button.addEventListener("click", activate);
    button.addEventListener("focus", () => highlight(zone.id, true));
    button.addEventListener("blur", () => highlight(zone.id, false));
    nav.appendChild(button);
    buttons.set(zone.id, button);
  }
  let drawerOpen = false;
  const setDrawer = (open: boolean): void => {
    drawerOpen = open;
    nav.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => setDrawer(!drawerOpen));
  // Click-outside closes (pointer and touch).
  const onOutside = (event: PointerEvent): void => {
    if (!drawerOpen) return;
    if (event.target instanceof Node && !drawer.contains(event.target)) setDrawer(false);
  };
  document.addEventListener("pointerdown", onOutside);
  drawer.append(toggle, nav);
  stage.parentElement?.appendChild(drawer);

  // ------------------------------------------------------------ helpers
  function highlight(id: ZoneId | null, on: boolean): void {
    if (zoneStress) {
      zoneStress.destroy();
      zoneStress = null;
    }
    emphasizedZone = on && id ? id : null;
    if (!emphasizedZone) return;
    const r = ZONE_RECTS[emphasizedZone];
    const g = new Graphics();
    g.roundRect(r.x, r.y, r.w, r.h, 14).stroke({ color: 0x8ac5d9, width: 2.5, alpha: 0.5 });
    g.zIndex = 1;
    labelLayer.addChildAt(g, 0);
    zoneStress = g;
    if (on && id) director.emphasize(id);
  }

  function showLabel(zone: ZoneDef): void {
    hideLabel();
    const r = ZONE_RECTS[zone.id];
    const text = new Text({ text: zone.name.toUpperCase(), style: LABEL_STYLE });
    const bg = new Graphics();
    const pad = 10;
    bg.roundRect(0, 0, text.width + pad * 2, text.height + pad, 7)
      .fill({ color: 0x0c0e14, alpha: 0.88 })
      .stroke({ color: 0x8ac5d9, width: 1, alpha: 0.35 });
    text.position.set(pad, pad / 2);
    const c = new Container();
    c.addChild(bg, text);
    c.position.set(r.x + r.w / 2 - (text.width + pad * 2) / 2, r.y - 30);
    c.zIndex = 5;
    labelLayer.addChild(c);
    hoverLabel = c;
  }

  function hideLabel(): void {
    hoverLabel?.destroy({ children: true });
    hoverLabel = null;
  }

  function openZone(id: ZoneId): void {
    activeZone = id;
    const zone = ZONES.find((z) => z.id === id);
    if (!zone) return;
    if (eyebrow) eyebrow.textContent = "THE BUREAU / ENFORCEMENT";
    if (title) title.textContent = zone.name;
    if (copy) copy.textContent = zone.copy;
    card.hidden = false;
    card.classList.add("open");
    camera.focusZone(id);
    highlight(id, true);
    director.emphasize(id);
    announcer.textContent = `${zone.name}. ${zone.copy}`;
    deps.onFocus?.(id);
    update();
  }

  function closeCard(): void {
    activeZone = null;
    card.hidden = true;
    card.classList.remove("open");
    highlight(null, false);
    hideLabel();
  }

  function resetView(): void {
    closeCard();
    camera.resetCamera();
  }

  // ------------------------------------------------------------ hotspots
  for (const zone of ZONES) {
    const r = ZONE_RECTS[zone.id];
    const hit = new Graphics();
    hit.rect(0, 0, r.w, r.h).fill({ color: 0xffffff, alpha: 0.001 });
    hit.position.set(r.x, r.y);
    hit.eventMode = "static";
    hit.cursor = "pointer";
    const onOver = (): void => {
      showLabel(zone);
      camera.markInput();
    };
    const onOut = (): void => hideLabel();
    const onTap = (event: import("pixi.js").FederatedPointerEvent): void => {
      event.stopPropagation(); // keep the backdrop (reset) handler out
      openZone(zone.id);
    };
    hit.on("pointerover", onOver);
    hit.on("pointerout", onOut);
    hit.on("pointertap", onTap);
    hotspotLayer.addChild(hit);
  }

  // Backdrop click (empty world) returns to overview.
  const onBackdropTap = (): void => {
    if (activeZone) resetView();
  };
  deps.camera.viewport.on("pointertap", onBackdropTap);

  // Esc closes the card and resets; also collapses keyboard focus parity.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (drawerOpen) {
      setDrawer(false);
      toggle.focus();
      return;
    }
    resetView();
  };
  window.addEventListener("keydown", onKey);

  const onCloseClick = () => resetView();
  closeButton?.addEventListener("click", onCloseClick);

  const resetButton = document.getElementById("reset");
  const onResetClick = () => resetView();
  resetButton?.addEventListener("click", onResetClick);

  disposers.push(
    () => window.removeEventListener("keydown", onKey),
    () => closeButton?.removeEventListener("click", onCloseClick),
    () => resetButton?.removeEventListener("click", onResetClick),
    () => deps.camera.viewport.off("pointertap", onBackdropTap),
    () => document.removeEventListener("pointerdown", onOutside),
    () => drawer.remove(),
    () => card.remove(),
  );

  // Keep the DOM card pinned to the zone's world anchor every frame.
  function update(): void {
    if (activeZone && !card.hidden) {
      const r = ZONE_RECTS[activeZone];
      const screen = camera.worldToScreen(r.x + r.w / 2, r.y);
      const stageRect = stage.getBoundingClientRect();
      card.style.left = `${screen.x + stageRect.left}px`;
      card.style.top = `${screen.y + stageRect.top}px`;
    }
  }

  return {
    setActiveZone: (id) => (id ? openZone(id) : closeCard()),
    update,
    dispose: () => {
      for (const dispose of disposers) dispose();
      hideLabel();
      zoneStress?.destroy();
    },
  };
}
