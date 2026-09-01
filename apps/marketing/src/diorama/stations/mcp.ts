/**
 * West section, south wedge: the TOOLS compound (mcpHub). Owner: west lane.
 *
 * Cycle 4 rebuild (freeze.md §1): ONE pickable station that absorbs the old
 * toolSchemas, adapterBay, mcpHealth, envSwitchboard, and portfolioTools as
 * sub-fixtures of a single root — no separate registrations, no signs, no
 * text beyond registered detail copy. The compound is demoted infrastructure:
 * agents obtain typed tools here; adapters translate provider protocols and
 * never authorize; the environment stays research-mode / testnet honest.
 *
 * Sub-fixtures (all children of the station root):
 * - eight typed tool ports on the ring with health LEDs (setPortHealth),
 * - a schema drawer bank north (one card slides out on a slow cycle),
 * - a provider-adapter socket strip west (identical sockets; names only as
 *   registered detail text, i.e. focus-depth reading),
 * - a health matrix panel east (port LEDs mirrored + latency sparkline),
 * - an environment lever row south (Research mode lit, Testnet lit, Signer
 *   dim) with the research-mode honesty line,
 * - a quiet portfolio readout panel south-east (balances/orders/fills rows).
 */
import { Container, Graphics } from "pixi.js";
import { gsap } from "gsap";
import type { DioramaContext } from "../core/context.js";
import { registerStation } from "../core/registry.js";
import { STATIONS } from "../config/stations.js";
import { PALETTE } from "../config/palette.js";
import { DEPTH } from "../config/world.js";
import { makeSign } from "../core/signs.js";
import { glow, isoBox, isoCylinder, screenPanel } from "../core/iso.js";
import { detailKit } from "./research.js";

export interface McpHubApi {
  /** Simulate a tool port degrading or recovering: green to amber to red. */
  setPortHealth(port: number, state: "green" | "amber" | "red"): void;
  /** Pulse a port when an agent calls the tool. */
  portCall(port: number): void;
}

export type PortState = "green" | "amber" | "red";

/**
 * Shared port health read by the hub's port lights and the compound's health
 * matrix. Stories mutate it through McpHubApi.setPortHealth.
 */
export const portHealth: PortState[] = Array.from({ length: 8 }, () => "green" as PortState);

const PORT_COLORS: Record<PortState, number> = {
  green: PALETTE.healthy,
  amber: PALETTE.warning,
  red: PALETTE.blocked,
};

type HealthListener = () => void;
const healthListeners = new Set<HealthListener>();
const notifyHealth = (): void => healthListeners.forEach((fn) => fn());

/** West-section counter-accent (research district accent2, violet). */
const VIOLET = PALETTE.violet;

/** Tiny status badge shape reinforcing the color: green circle, amber triangle, red square. */
function stateBadge(state: PortState): Graphics {
  const g = new Graphics();
  const c = PORT_COLORS[state];
  if (state === "green") g.circle(0, 0, 2.4).fill({ color: c });
  else if (state === "amber") g.poly([0, -3, 3, 2.4, -3, 2.4]).fill({ color: c });
  else g.rect(-2.6, -2.6, 5.2, 5.2).fill({ color: c });
  return g;
}

/**
 * Soft dark ground ellipse so the compound grounds onto the platform instead
 * of floating. Coordinates are root-local (root sits at the station anchor).
 */
function contactShadow(
  root: Container,
  x: number,
  y: number,
  w: number,
  d: number,
  alpha = 0.27,
): void {
  const g = new Graphics();
  g.ellipse(x, y, w / 2, d / 2);
  g.fill({ color: 0x03080f, alpha });
  root.addChild(g);
}

/* ------------------------------------------------------ the TOOLS compound */

function buildToolsCompound(ctx: DioramaContext): void {
  const detail = detailKit("mcpHub");
  const def = STATIONS.mcpHub;

  const root = new Container();
  root.position.set(def.anchor.x, def.anchor.y);
  root.zIndex = def.anchor.y + DEPTH.base;
  ctx.layers.sortable.addChild(root);

  // Hit surface: flat diamond covering the footprint, kept invisible.
  const hit = new Graphics();
  const hw = def.size.w / 2;
  const hd = def.size.d / 2;
  hit.poly([0 - hw, 0, 0, hd, hw, 0, 0, 0 - hd]);
  hit.fill({ color: 0xffffff, alpha: 0 });
  hit.eventMode = "static";
  hit.cursor = "pointer";
  root.addChild(hit);

  // Demoted infrastructure: md board so the compound declutters at fit zoom.
  const sign = makeSign(def.label, {
    x: def.anchor.x,
    y: def.anchor.y - 148,
    size: def.signSize,
    accent: VIOLET,
  });
  sign.zIndex = def.anchor.y + DEPTH.overlay;
  ctx.layers.labels.addChild(sign);

  contactShadow(root, 0, 8, 300, 168, 0.25);

  // Ellipse interchange platform: violet rim keeps the row identity, cyan
  // interior rings tie the hub to the research district accent.
  const platform = new Graphics();
  platform.ellipse(0, 0, 148, 74).fill({ color: PALETTE.structure });
  platform.ellipse(0, 0, 148, 74).stroke({ width: 2.5, color: VIOLET, alpha: 0.85 });
  platform.ellipse(0, 0, 118, 59).stroke({ width: 2, color: PALETTE.cyan, alpha: 0.35 });
  platform.ellipse(0, 0, 64, 32).stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.45 });
  root.addChild(platform);

  // Central core pillar with one soft violet light.
  root.addChild(
    isoCylinder({ x: 0, y: -4, r: 16, h: 50, color: PALETTE.structureLight, rim: VIOLET }),
  );
  const coreGlow = glow(0, -66, 100, VIOLET, 0.4);
  root.addChild(coreGlow);

  /* Tool ports: eight typed sockets on a static inner ring (ports 0..7,
   * port 0 east, counterclockwise on screen). */
  const RX = 84;
  const RY = 40;
  interface Port {
    c: Container;
    light: Graphics;
    badge: Container;
    state: PortState;
  }
  const ports: Port[] = [];
  for (let i = 0; i < 8; i++) {
    const a = i * (Math.PI / 4);
    const c = new Container();
    c.position.set(Math.cos(a) * RX, -Math.sin(a) * RY);
    const socket = new Graphics();
    socket.circle(0, 0, 8).fill({ color: PALETTE.space });
    socket.circle(0, 0, 8).stroke({ width: 1.5, color: PALETTE.structureLight });
    c.addChild(socket);
    const light = new Graphics();
    c.addChild(light);
    const badgeHolder = new Container();
    badgeHolder.position.set(0, -9);
    c.addChild(badgeHolder);
    root.addChild(c);
    ports.push({ c, light, badge: badgeHolder, state: "green" });
  }

  const applyHealth = (port: number): void => {
    const p = ports[port];
    if (!p) return;
    const c = PORT_COLORS[p.state];
    p.light.clear();
    p.light.circle(0, -1, 3).fill({ color: c });
    p.light.circle(0, -1, 6).stroke({ width: 1, color: c, alpha: 0.35 });
    p.badge.removeChildren();
    p.badge.addChild(stateBadge(p.state));
  };
  for (let i = 0; i < 8; i++) applyHealth(i);

  // Pooled pulse rings + spark traveling to the core on portCall.
  const ringPool: Graphics[] = [];
  const takeRing = (): Graphics => {
    const existing = ringPool.find((r) => !r.visible);
    if (existing) return existing;
    const r = new Graphics();
    r.circle(0, 0, 9).stroke({ width: 2, color: PALETTE.cyan, alpha: 0.9 });
    r.visible = false;
    root.addChild(r);
    ringPool.push(r);
    return r;
  };
  const spark = new Container();
  const sparkDot = new Graphics();
  sparkDot.circle(0, 0, 3.2).fill({ color: VIOLET });
  spark.addChild(sparkDot);
  spark.visible = false;
  root.addChild(spark);

  const pulsePort = (port: number): void => {
    const p = ports[port];
    if (!p) return;
    const ring = takeRing();
    ring.position.copyFrom(p.c.position);
    ring.scale.set(0.4);
    ring.alpha = 0.9;
    ring.visible = true;
    gsap.to(ring.scale, {
      x: 2.4,
      y: 2.4,
      duration: 0.7,
      ease: "power2.out",
      onComplete: () => {
        ring.visible = false;
      },
    });
    gsap.to(ring, { alpha: 0, duration: 0.7, ease: "power1.in" });
    if (ctx.reducedMotion) {
      gsap.fromTo(p.c, { alpha: 0.5 }, { alpha: 1, duration: 0.5 });
      return;
    }
    gsap.killTweensOf(spark);
    spark.visible = true;
    spark.alpha = 1;
    spark.position.copyFrom(p.c.position);
    gsap.to(spark.position, {
      x: 0,
      y: -8,
      duration: 0.55,
      ease: "power2.in",
      onComplete: () => {
        gsap.to(spark, {
          alpha: 0,
          duration: 0.25,
          onComplete: () => {
            spark.visible = false;
          },
        });
        gsap.fromTo(
          coreGlow,
          { alpha: 0.55 },
          { alpha: 0.85, duration: 0.18, yoyo: true, repeat: 1 },
        );
      },
    });
  };

  // Idle ambient: one quiet port pulse every ~6 s.
  let idleTimer = 0;
  let idlePort = 0;
  const offTick = ctx.onTick((ticker) => {
    idleTimer += ticker.deltaMS;
    if (idleTimer >= 6000) {
      idleTimer = 0;
      pulsePort(idlePort % 8);
      idlePort++;
    }
  });

  /* Schema drawer bank (north): four drawers, one card slides out on a slow
   * deterministic cycle (the absorbed toolSchemas). */
  root.addChild(
    isoBox({
      x: 0,
      y: -88,
      w: 76,
      d: 20,
      h: 24,
      color: PALETTE.structure,
      rim: VIOLET,
      rimAlpha: 0.75,
    }),
  );
  const drawers: Container[] = [];
  for (let d = 0; d < 4; d++) {
    const face = new Graphics();
    const dx = -28 + d * 19;
    face.roundRect(dx - 7, -96, 15, 11, 2);
    face.fill({ color: PALETTE.spaceAlt });
    face.roundRect(dx - 7, -96, 15, 11, 2);
    face.stroke({ width: 1, color: VIOLET, alpha: 0.8 });
    face.rect(dx - 4, -91, 8, 1.6).fill({ color: VIOLET, alpha: 0.55 });
    root.addChild(face);
    drawers.push(face);
  }
  const schemaCard = new Graphics();
  schemaCard.roundRect(-7, -18, 14, 16, 2);
  schemaCard.fill({ color: PALETTE.surfacePale, alpha: 0.92 });
  schemaCard.roundRect(-7, -18, 14, 16, 2);
  schemaCard.stroke({ width: 1, color: VIOLET, alpha: 0.9 });
  schemaCard.rect(-4.5, -14, 9, 1.6).fill({ color: PALETTE.structure, alpha: 0.8 });
  schemaCard.rect(-4.5, -10.5, 6, 1.6).fill({ color: PALETTE.structure, alpha: 0.6 });
  schemaCard.rect(-4.5, -7, 7.5, 1.6).fill({ color: PALETTE.structure, alpha: 0.6 });
  schemaCard.position.set(-9.5, -78);
  schemaCard.visible = false;
  root.addChild(schemaCard);
  if (ctx.reducedMotion) {
    schemaCard.visible = true;
  } else {
    const cycle = gsap.timeline({ repeat: -1 });
    cycle
      .call(() => {
        schemaCard.visible = true;
      })
      .fromTo(
        schemaCard,
        { alpha: 0, y: -72 },
        { alpha: 1, y: -78, duration: 0.8, ease: "power2.out" },
      )
      .to(schemaCard, { alpha: 0, y: -82, duration: 0.6, delay: 5.4, ease: "power2.in" })
      .call(() => {
        schemaCard.visible = false;
      })
      .to({}, { duration: 1.2 });
    ctx.onCleanup(() => cycle.kill());
  }

  /* Provider-adapter strip (west): six identical sockets; adapters translate
   * and never authorize. Names only as registered detail (focus-depth). */
  const adapterStrip = new Graphics();
  for (let i = 0; i < 6; i++) {
    const py = -25 + i * 10;
    adapterStrip.roundRect(-124, py - 4.5, 7, 9, 1.5);
    adapterStrip.fill({ color: PALETTE.structureLight });
    adapterStrip.roundRect(-124, py - 4.5, 7, 9, 1.5);
    adapterStrip.stroke({ width: 1, color: VIOLET, alpha: 0.65 });
    adapterStrip.circle(-120.5, py - 1.5, 1.4).fill({ color: VIOLET, alpha: 0.85 });
    adapterStrip.rect(-122.5, py + 1, 4, 1).fill({ color: VIOLET, alpha: 0.45 });
  }
  root.addChild(adapterStrip);
  const adapterNamesA = detail("CODEX \u00b7 CLAUDE \u00b7 CURSOR", 5, PALETTE.inkDim);
  adapterNamesA.anchor.set(0.5, 0.5);
  adapterNamesA.position.set(-97, 42);
  root.addChild(adapterNamesA);
  const adapterNamesB = detail("GROK \u00b7 OPENCODE", 5, PALETTE.inkDim);
  adapterNamesB.anchor.set(0.5, 0.5);
  adapterNamesB.position.set(-97, 50);
  root.addChild(adapterNamesB);

  /* Health matrix (east): port LEDs mirrored from portHealth plus a latency
   * sparkline (the absorbed mcpHealth). */
  root.addChild(
    isoBox({
      x: 100,
      y: -20,
      w: 10,
      d: 10,
      h: 8,
      color: PALETTE.structure,
      rim: PALETTE.structureLight,
    }),
  );
  const healthPanel = screenPanel({ x: 72, y: -62, w: 52, h: 30, accent: PALETTE.cyan });
  root.addChild(healthPanel);
  const healthCells: Container[] = [];
  for (let i = 0; i < 8; i++) {
    const cell = new Container();
    cell.position.set(80 + (i % 4) * 10, -56 + Math.floor(i / 4) * 9);
    const box = new Graphics();
    box.roundRect(-3.5, -3, 7, 6, 1);
    box.fill({ color: PALETTE.space });
    box.roundRect(-3.5, -3, 7, 6, 1);
    box.stroke({ width: 0.7, color: PALETTE.structureLight });
    cell.addChild(box);
    const badge = new Container();
    cell.addChild(badge);
    healthPanel.addChild(cell);
    healthCells.push(badge);
  }
  const renderCells = (): void => {
    for (let i = 0; i < 8; i++) {
      healthCells[i].removeChildren();
      healthCells[i].addChild(stateBadge(portHealth[i]));
    }
  };
  renderCells();
  healthListeners.add(renderCells);
  ctx.onCleanup(() => healthListeners.delete(renderCells));
  const sparkline = new Graphics();
  sparkline
    .moveTo(76, -38)
    .lineTo(84, -41)
    .lineTo(92, -37)
    .lineTo(100, -42)
    .lineTo(108, -38)
    .lineTo(116, -40);
  sparkline.stroke({ width: 1, color: PALETTE.waiting, alpha: 0.8 });
  healthPanel.addChild(sparkline);
  const available = detail("Available", 5.5, PALETTE.healthy);
  available.anchor.set(0.5, 0.5);
  available.position.set(98, -68);
  root.addChild(available);

  /* Environment levers (south): Research mode lit, Testnet lit, Signer dim —
   * the absorbed envSwitchboard, honest about where authority lives. */
  const leverSpecs: Array<{ color: number; lit: boolean }> = [
    { color: PALETTE.cyan, lit: true },
    { color: PALETTE.aqua, lit: true },
    { color: PALETTE.yellow, lit: false },
  ];
  leverSpecs.forEach((spec, i) => {
    const cx = -30 + i * 30;
    const post = new Graphics();
    post.rect(cx - 1.2, 52, 2.4, 12);
    post.fill({ color: PALETTE.structureLight });
    root.addChild(post);
    const lever = new Graphics();
    lever.rect(-1.2, -12, 2.4, 12);
    lever.fill({ color: PALETTE.surfacePale });
    lever.circle(0, -12, 2.6).fill({ color: spec.lit ? spec.color : PALETTE.structureLight });
    lever.position.set(cx, 54);
    root.addChild(lever);
    const lamp = glow(cx, 58, 14, spec.color, spec.lit ? 0.4 : 0.1);
    root.addChild(lamp);
  });
  const researchMode = detail("Research mode \u00b7 signer not required", 5, PALETTE.cyan);
  researchMode.anchor.set(0.5, 0.5);
  researchMode.position.set(0, 82);
  root.addChild(researchMode);

  /* Portfolio readout (south-east): quiet balances/orders/fills rows (the
   * absorbed portfolioTools; full detail lives on POSITIONS). */
  const portfolioPanel = screenPanel({ x: 68, y: 38, w: 48, h: 28, accent: VIOLET });
  root.addChild(portfolioPanel);
  for (let r = 0; r < 3; r++) {
    const row = new Graphics();
    row.rect(74, 44 + r * 7, 10 + r * 8, 2.4).fill({ color: PALETTE.surfacePale, alpha: 0.5 });
    root.addChild(row);
  }
  const totalTick = new Graphics();
  totalTick.moveTo(74, 63).lineTo(88, 63);
  totalTick.stroke({ width: 2, color: PALETTE.yellow, alpha: 0.9 });
  portfolioPanel.addChild(totalTick);

  ctx.onCleanup(() => {
    offTick();
    ringPool.forEach((r) => gsap.killTweensOf(r));
    gsap.killTweensOf(spark);
    gsap.killTweensOf(coreGlow);
  });

  const api: McpHubApi = {
    setPortHealth(port, state) {
      if (port < 0 || port > 7) return;
      portHealth[port] = state;
      ports[port].state = state;
      applyHealth(port);
      notifyHealth();
    },
    portCall(port) {
      pulsePort(port);
    },
  };
  registerStation({ id: "mcpHub", root, hit, api });
}

/* ------------------------------------------------------------------ wiring */

export function buildMcpDistrict(ctx: DioramaContext): void {
  // Module state must not survive a route teardown: a story that left a port
  // amber/red would degrade the next visit's initial health display.
  portHealth.fill("green");
  buildToolsCompound(ctx);
}
