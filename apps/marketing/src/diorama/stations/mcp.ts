/**
 * MCP & Provider district: tool hub interchange, tool consoles, schema
 * library drawers, adapter bay, provider booths, health console, and the
 * environment switchboard. Owner: MCP district worker.
 *
 * Story: agents OBTAIN capabilities here. The hub hands out typed tools,
 * schemas document them, adapters translate provider protocols, and the
 * switchboard picks the environment. Providers are adapters, never
 * authorities: six identical booths, no thrones.
 */
import { Container, Graphics, Sprite } from "pixi.js";
import { gsap } from "gsap";
import type { DioramaContext } from "../core/context.js";
import { registerStation } from "../core/registry.js";
import { STATIONS, type StationDef } from "../config/stations.js";
import { PALETTE, shade } from "../config/palette.js";
import { DEPTH, seededRandom } from "../config/world.js";
import { makeSign } from "../core/signs.js";
import { dotTexture, glow, isoBox, isoCylinder, isoTile, screenPanel } from "../core/iso.js";

export interface McpHubApi {
  /** Simulate a tool port degrading or recovering: green to amber to red. */
  setPortHealth(port: number, state: "green" | "amber" | "red"): void;
  /** Pulse a port when an agent calls the tool. */
  portCall(port: number): void;
}

export interface EnvSwitchboardApi {
  setEnv(state: "research" | "testnet" | "connected" | "signer"): void;
}

export type PortState = "green" | "amber" | "red";

/**
 * Shared port health read by BOTH the hub port lights and the MCP health
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

const rand = seededRandom(23);

/* ---------------------------------------------------------------- helpers */

interface StationShell {
  def: StationDef;
  root: Container;
  hit: Graphics;
}

/**
 * Standard station scaffold: root in the sortable layer at anchor depth, a
 * transparent diamond hit surface sized to the footprint, and the sign
 * mounted in the labels layer above the tallest point.
 */
function stationShell(
  ctx: DioramaContext,
  id: keyof typeof STATIONS,
  signYOffset: number,
): StationShell {
  const def = STATIONS[id];
  const root = new Container();
  root.position.set(def.anchor.x, def.anchor.y);
  root.zIndex = def.anchor.y + DEPTH.base;
  ctx.layers.sortable.addChild(root);

  const hit = new Graphics();
  const hw = def.size.w / 2;
  const hd = def.size.d / 2;
  hit.poly([0 - hw, 0, 0, hd, hw, 0, 0, 0 - hd]);
  hit.fill({ color: 0xffffff, alpha: 0 });
  hit.eventMode = "static";
  hit.cursor = "pointer";
  root.addChild(hit);

  const sign = makeSign(def.label, {
    x: def.anchor.x,
    y: def.anchor.y + signYOffset,
    size: def.signSize,
    accent: PALETTE.violet,
  });
  sign.zIndex = def.anchor.y + DEPTH.overlay;
  ctx.layers.labels.addChild(sign);

  return { def, root, hit };
}

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
 * Soft dark ground ellipse added right after the hit surface so each
 * structure grounds onto the platform instead of floating. Coordinates are
 * root-local (mcp roots are positioned at their anchor).
 */
function contactShadow(root: Container, x: number, y: number, w: number, d: number, alpha = 0.27): void {
  const g = new Graphics();
  g.ellipse(x, y, w / 2, d / 2);
  g.fill({ color: 0x03080f, alpha });
  root.addChild(g);
}

/** Small crate for filling dead space around the district. */
function propCrate(x: number, y: number, s = 13): Graphics {
  return isoBox({ x, y, w: s, d: s * 0.6, h: s * 0.55, color: PALETTE.structure, rim: PALETTE.violet, rimAlpha: 0.3 });
}

/* -------------------------------------------------------------- 1. hub */

function buildHub(ctx: DioramaContext): McpHubApi {
  const { root, hit } = stationShell(ctx, "mcpHub", -160);

  contactShadow(root, 0, 8, 310, 158, 0.25);
  // Ellipse interchange platform with a violet rim.
  const platform = new Graphics();
  platform.ellipse(0, 0, 140, 70).fill({ color: PALETTE.structure });
  platform.ellipse(0, 0, 140, 70).stroke({ width: 2.5, color: PALETTE.violet, alpha: 0.85 });
  platform.ellipse(0, 0, 104, 52).stroke({ width: 1, color: PALETTE.violet, alpha: 0.3 });
  root.addChild(platform);

  // Central core pillar with soft violet light.
  root.addChild(isoCylinder({ x: 0, y: -2, r: 20, h: 62, color: PALETTE.structureLight, rim: PALETTE.violet }));
  const coreGlow = glow(0, -74, 110, PALETTE.violet, 0.55);
  root.addChild(coreGlow);
  const corePillarLight = glow(0, -30, 46, PALETTE.violet, 0.28);
  root.addChild(corePillarLight);

  // Eight tool ports on a slowly rotating outer ring. Port 0 starts east
  // (angle 0) and indices proceed counterclockwise on screen.
  const RX = 96;
  const RY = 48;
  interface Port {
    c: Container;
    light: Graphics;
    badge: Container;
    state: PortState;
  }
  const ports: Port[] = [];
  for (let i = 0; i < 8; i++) {
    const c = new Container();
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

  const placePorts = (offset: number): void => {
    for (let i = 0; i < 8; i++) {
      const a = offset + i * (Math.PI / 4);
      // Screen y grows downward, so -sin keeps the sweep counterclockwise.
      ports[i].c.position.set(Math.cos(a) * RX, -Math.sin(a) * RY);
    }
  };
  placePorts(0);

  // Pooled pulse rings: drawn once, animated via scale/alpha, reused.
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

  const spark = new Sprite(dotTexture());
  spark.anchor.set(0.5);
  spark.width = 10;
  spark.height = 10;
  spark.tint = PALETTE.violet;
  spark.alpha = 0;
  spark.zIndex = 5;
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
    // Spark travels from the port to the core.
    gsap.killTweensOf(spark);
    spark.alpha = 1;
    spark.position.copyFrom(p.c.position);
    gsap.to(spark.position, {
      x: 0,
      y: 0,
      duration: 0.55,
      ease: "power2.in",
      onComplete: () => {
        gsap.to(spark, { alpha: 0, duration: 0.25 });
        gsap.fromTo(coreGlow, { alpha: 0.5 }, { alpha: 0.85, duration: 0.18, yoyo: true, repeat: 1 });
      },
    });
  };

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

  // Shared ticker: slow ring rotation plus an idle port pulse every ~6 s.
  let ringOffset = 0;
  let idleTimer = 0;
  let idlePort = 0;
  const offTick = ctx.onTick((ticker) => {
    const deltaMs = ticker.deltaMS;
    if (!ctx.reducedMotion) {
      ringOffset += (deltaMs / 40000) * Math.PI * 2;
      placePorts(ringOffset);
    }
    idleTimer += deltaMs;
    if (idleTimer >= 6000) {
      idleTimer = 0;
      if (ctx.reducedMotion) {
        const p = ports[idlePort % 8];
        gsap.fromTo(p.c, { alpha: 1 }, { alpha: 0.55, duration: 0.5, yoyo: true, repeat: 1 });
      } else {
        pulsePort(idlePort % 8);
      }
      idlePort++;
    }
  });
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
  return api;
}

/* ------------------------------------------- 2. market data tool consoles */

function miniConsole(x: number, y: number, screen: (g: Graphics) => void): Container {
  const c = new Container();
  c.position.set(x, y);
  c.addChild(isoBox({ x: 0, y: 4, w: 30, d: 16, h: 9, color: PALETTE.structure, rim: PALETTE.violet, rimAlpha: 0.5 }));
  const panel = screenPanel({ x: -15, y: -14, w: 30, h: 20, accent: PALETTE.cyan, alpha: 0.9 });
  const content = new Graphics();
  content.position.set(15, 10); // panel-local center
  screen(content);
  panel.addChild(content);
  c.addChild(panel);
  return c;
}

function buildMarketDataTools(ctx: DioramaContext): void {
  const { root, hit } = stationShell(ctx, "marketDataTools", -70);
  contactShadow(root, 0, 4, 168, 88);
  root.addChild(propCrate(-64, 28));
  root.addChild(propCrate(-54, 34, 9));
  root.addChild(isoTile(0, 0, 150, 76, PALETTE.structure, 1, PALETTE.structureLight));

  const cells: Array<{ x: number; y: number }> = [
    { x: -44, y: -18 }, { x: 0, y: -28 }, { x: 44, y: -18 },
    { x: -44, y: 16 }, { x: 0, y: 8 }, { x: 44, y: 16 },
  ];
  const screens: Array<(g: Graphics) => void> = [
    // chart
    (g) => {
      g.moveTo(-12, 4).lineTo(-5, -2).lineTo(1, 2).lineTo(8, -7).lineTo(12, -4);
      g.stroke({ width: 1.2, color: PALETTE.cyan, alpha: 0.9 });
    },
    // ladder
    (g) => {
      for (let i = 0; i < 4; i++) {
        g.rect(-11 + i * 0.5, -8 + i * 5, 18 - i * 1.5, 2.4).fill({ color: i < 2 ? PALETTE.healthy : PALETTE.blocked, alpha: 0.8 });
      }
    },
    // funding arc
    (g) => {
      g.arc(0, 6, 8, Math.PI, Math.PI * 1.7);
      g.stroke({ width: 1.5, color: PALETTE.orange, alpha: 0.85 });
      g.circle(3, -1, 1.6).fill({ color: PALETTE.orange });
    },
    // liquidity pool ellipse
    (g) => {
      g.ellipse(0, 0, 11, 5).stroke({ width: 1.2, color: PALETTE.aqua, alpha: 0.85 });
      g.ellipse(0, 0, 6, 2.7).fill({ color: PALETTE.aqua, alpha: 0.35 });
    },
    // volatility bars
    (g) => {
      for (let i = 0; i < 5; i++) {
        const h = 3 + Math.round(rand() * 7);
        g.rect(-11 + i * 5, 7 - h, 3, h).fill({ color: PALETTE.violet, alpha: 0.85 });
      }
    },
    // price ticker strip
    (g) => {
      g.rect(-13, -3, 26, 5).fill({ color: PALETTE.blue, alpha: 0.3 });
      g.rect(-13, -3, 15, 5).fill({ color: PALETTE.blue, alpha: 0.75 });
    },
  ];
  const consoles: Container[] = [];
  cells.forEach((pos, i) => {
    const c = miniConsole(pos.x, pos.y, screens[i]);
    root.addChild(c);
    consoles.push(c);
  });

  // One screen animates slowly: the chart line breathes.
  const chart = consoles[0];
  const tl = gsap.timeline({ repeat: -1 });
  tl.to(chart, { alpha: 0.55, duration: 2.6, ease: "sine.inOut" });
  tl.to(chart, { alpha: 1, duration: 2.6, ease: "sine.inOut" });
  ctx.onCleanup(() => tl.kill());
  registerStation({ id: "marketDataTools", root, hit });
}

/* ------------------------------------------------- 3. research tool tools */

function buildResearchToolsMcp(ctx: DioramaContext): void {
  const { root, hit } = stationShell(ctx, "researchToolsMcp", -70);
  contactShadow(root, 0, 4, 168, 88);
  root.addChild(propCrate(66, 30));
  root.addChild(isoTile(0, 0, 150, 76, PALETTE.structure, 1, PALETTE.structureLight));

  // News pulse console.
  const news = miniConsole(-44, -6, (g) => {
    g.circle(-6, -2, 2).fill({ color: PALETTE.cyan });
    g.circle(0, 1, 2).fill({ color: PALETTE.cyan, alpha: 0.7 });
    g.circle(6, -3, 2).fill({ color: PALETTE.cyan, alpha: 0.45 });
    g.circle(0, 1, 7).stroke({ width: 1, color: PALETTE.cyan, alpha: 0.35 });
  });
  // Token hex console.
  const hex = miniConsole(0, -10, (g) => {
    g.poly(Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      return [Math.cos(a) * 8, Math.sin(a) * 8 + 1];
    }).flat());
    g.stroke({ width: 1.4, color: PALETTE.magenta, alpha: 0.85 });
    g.circle(0, 1, 2.4).fill({ color: PALETTE.magenta, alpha: 0.8 });
  });
  // Protocol layers stack console.
  const stack = miniConsole(44, -6, (g) => {
    for (let i = 0; i < 4; i++) {
      g.rect(-11, 5 - i * 4.5, 22 - i * 2, 2.6).fill({ color: PALETTE.blue, alpha: 0.5 + i * 0.15 });
    }
  });
  root.addChild(news, hex, stack);

  const tl = gsap.timeline({ repeat: -1 });
  tl.to(news.scale, { x: 1.06, y: 1.06, duration: 1.8, ease: "sine.inOut" });
  tl.to(news.scale, { x: 1, y: 1, duration: 1.8, ease: "sine.inOut" });
  tl.to(hex.scale, { x: 1.06, y: 1.06, duration: 1.8, ease: "sine.inOut" }, "<0.6");
  tl.to(hex.scale, { x: 1, y: 1, duration: 1.8, ease: "sine.inOut" }, "<1.8");
  ctx.onCleanup(() => tl.kill());
  registerStation({ id: "researchToolsMcp", root, hit });
}

/* ---------------------------------------------------- 4. portfolio tools */

function buildPortfolioTools(ctx: DioramaContext): void {
  const { root, hit } = stationShell(ctx, "portfolioTools", -70);
  contactShadow(root, 0, 4, 168, 88);
  root.addChild(isoTile(0, 0, 150, 76, PALETTE.structure, 1, PALETTE.structureLight));

  // Four angled screens: balances, positions, orders, fills.
  const panels: Container[] = [];
  const layout = [
    [-40, -20], [40, -20], [-40, 18], [40, 18],
  ];
  layout.forEach(([x, y], idx) => {
    const p = screenPanel({ x: -19, y: -12, w: 38, h: 24, accent: PALETTE.cyan, alpha: 0.9 });
    p.position.set(x, y);
    p.rotation = (idx % 2 === 0 ? -1 : 1) * 0.04;
    const rows = new Graphics();
    for (let r = 0; r < 4; r++) {
      const w = 10 + Math.round(rand() * 18);
      rows.rect(4, 4 + r * 4.5, w, 2).fill({ color: PALETTE.surfacePale, alpha: 0.55 });
    }
    p.addChild(rows);
    root.addChild(p);
    panels.push(p);
  });

  // A total line that ticks.
  const total = new Graphics();
  total.moveTo(-24, 40).lineTo(-8, 40);
  total.stroke({ width: 2.5, color: PALETTE.yellow, alpha: 0.95 });
  total.moveTo(-4, 40).lineTo(24, 40);
  total.stroke({ width: 1.2, color: PALETTE.yellow, alpha: 0.5 });
  root.addChild(total);
  const tl = gsap.timeline({ repeat: -1 });
  tl.fromTo(total, { alpha: 0.55 }, { alpha: 1, duration: 0.9, ease: "power2.out" });
  tl.to(total, { alpha: 0.8, duration: 1.6, ease: "sine.inOut" });
  ctx.onCleanup(() => tl.kill());
  registerStation({ id: "portfolioTools", root, hit });
}

/* --------------------------------------------------------- 5. tool schemas */

function buildToolSchemas(ctx: DioramaContext): void {
  const { root, hit } = stationShell(ctx, "toolSchemas", -80);
  contactShadow(root, 0, 10, 180, 84);
  root.addChild(isoTile(0, 6, 160, 66, PALETTE.structure, 1, PALETTE.structureLight));

  // Library cabinet body.
  root.addChild(isoBox({ x: 0, y: -14, w: 130, d: 46, h: 40, color: PALETTE.structure, rim: PALETTE.violet, rimAlpha: 0.75 }));
  // Soft violet wash behind the cabinet so drawer rows read at fit zoom.
  root.addChild(glow(0, -40, 130, PALETTE.violet, 0.14));

  // 4x3 grid of illuminated drawers, each with a tiny card slot.
  const drawerW = 26;
  const drawerH = 13;
  const drawers: Container[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const d = new Container();
      const dx = -42 + col * 28;
      const dy = -46 + row * 14;
      d.position.set(dx, dy);
      const face = new Graphics();
      face.roundRect(-drawerW / 2, -drawerH / 2, drawerW, drawerH, 2);
      face.fill({ color: PALETTE.spaceAlt });
      face.roundRect(-drawerW / 2, -drawerH / 2, drawerW, drawerH, 2);
      face.stroke({ width: 1.2, color: PALETTE.violet, alpha: 0.8 });
      // Card slot.
      face.rect(-8, -1.5, 16, 2).fill({ color: PALETTE.violet, alpha: 0.55 });
      d.addChild(face);
      // Glowing schema card revealed when the drawer opens.
      const card = new Graphics();
      card.roundRect(-7, -18, 14, 16, 2);
      card.fill({ color: PALETTE.surfacePale, alpha: 0.92 });
      card.roundRect(-7, -18, 14, 16, 2);
      card.stroke({ width: 1, color: PALETTE.violet, alpha: 0.9 });
      card.rect(-4.5, -14, 9, 1.6).fill({ color: PALETTE.structure, alpha: 0.8 });
      card.rect(-4.5, -10.5, 6, 1.6).fill({ color: PALETTE.structure, alpha: 0.6 });
      card.rect(-4.5, -7, 7.5, 1.6).fill({ color: PALETTE.structure, alpha: 0.6 });
      card.visible = false;
      d.addChild(card);
      root.addChild(d);
      drawers.push(d);
    }
  }

  // Agent-sized reading ledge in front of the cabinet.
  root.addChild(isoTile(0, 34, 60, 26, PALETTE.structureLight, 1, PALETTE.violet));

  // Sequenced drawer openings: one every ~8 s, cycling deterministically.
  let idx = Math.floor(rand() * 12);
  const openNext = (): void => {
    const d = drawers[idx % 12];
    idx++;
    const card = d.children[1] as Graphics;
    card.visible = true;
    card.alpha = 0;
    gsap.fromTo(card, { y: 6, alpha: 0 }, {
      y: 0,
      alpha: 1,
      duration: 0.8,
      ease: "power2.out",
      onComplete: () => {
        gsap.to(card, {
          y: -4,
          alpha: 0,
          duration: 0.6,
          delay: 5.4,
          ease: "power2.in",
          onComplete: () => {
            card.visible = false;
            card.y = 0;
          },
        });
      },
    });
  };
  if (ctx.reducedMotion) {
    // Static: one drawer simply stays open with its card out.
    const d = drawers[4];
    (d.children[1] as Graphics).visible = true;
  } else {
    const loop = gsap.timeline({ repeat: -1, repeatDelay: 0 });
    loop.call(openNext, undefined, 0);
    loop.to({}, { duration: 8 });
    ctx.onCleanup(() => loop.kill());
  }
  registerStation({ id: "toolSchemas", root, hit });
}

/* ---------------------------------------------------------- 6. adapter bay */

function buildAdapterBay(ctx: DioramaContext): void {
  const { root, hit } = stationShell(ctx, "adapterBay", -70);
  contactShadow(root, 0, 4, 126, 112);
  root.addChild(propCrate(-46, 40));
  root.addChild(isoTile(0, 0, 110, 100, PALETTE.structure, 1, PALETTE.structureLight));

  const tints = [PALETTE.cyan, PALETTE.magenta];
  for (let m = 0; m < 2; m++) {
    const my = -22 + m * 40;
    // Translation machine: standardized cube in on the west, tinted packet out east.
    root.addChild(isoBox({ x: 0, y: my, w: 34, d: 20, h: 22, color: PALETTE.structureLight, rim: tints[m], rimAlpha: 0.7 }));
    const tintGlow = glow(0, my - 22, 40, tints[m], 0.2);
    root.addChild(tintGlow);

    // Belt line hint.
    const belt = new Graphics();
    belt.moveTo(-40, my).lineTo(-17, my);
    belt.moveTo(17, my).lineTo(40, my);
    belt.stroke({ width: 1.5, color: PALETTE.structureLight, alpha: 0.9 });
    root.addChild(belt);

    if (ctx.reducedMotion) continue;
    // Two cubes per belt, staggered halves of the 5 s loop.
    for (let k = 0; k < 2; k++) {
      const cube = isoBox({ x: -40, y: my, w: 12, d: 7, h: 8, color: PALETTE.surfacePale });
      cube.alpha = 0;
      root.addChild(cube);
      const packet = new Graphics();
      packet.roundRect(-5, -8, 10, 9, 2);
      packet.fill({ color: tints[m], alpha: 0.9 });
      packet.roundRect(-5, -8, 10, 9, 2);
      packet.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.7 });
      packet.position.set(17, my);
      packet.alpha = 0;
      root.addChild(packet);

      const tl = gsap.timeline({ repeat: -1, delay: m * 2.5 + k * 2.5 });
      // Pale cube slides in and is absorbed.
      tl.call(() => {
        cube.position.set(-40, my);
        cube.alpha = 1;
      });
      tl.to(cube.position, { x: -6, duration: 1.6, ease: "none" });
      tl.to(cube, { alpha: 0, duration: 0.3 });
      // Machine pulses, then a tinted packet emerges.
      tl.fromTo(tintGlow, { alpha: 0.2 }, { alpha: 0.55, duration: 0.3, yoyo: true, repeat: 1 });
      tl.call(() => {
        packet.position.set(6, my);
        packet.alpha = 1;
      });
      tl.to(packet.position, { x: 40, duration: 1.4, ease: "none" }, "+=0.1");
      tl.to(packet, { alpha: 0, duration: 0.3 }, "-=0.3");
      tl.to({}, { duration: 0.6 });
      ctx.onCleanup(() => tl.kill());
    }
  }
  registerStation({ id: "adapterBay", root, hit });
}

/* ------------------------------------------------------------ 7. providers */

const PROVIDERS: Array<{ name: string; accent: number }> = [
  { name: "CODEX", accent: PALETTE.cyan },
  { name: "CLAUDE", accent: PALETTE.orange },
  { name: "CURSOR", accent: PALETTE.blue },
  { name: "GROK", accent: PALETTE.magenta },
  { name: "OPENCODE", accent: PALETTE.aqua },
  { name: "OTHER", accent: PALETTE.violet },
];

function buildProviders(ctx: DioramaContext): void {
  const { def, root, hit } = stationShell(ctx, "providers", -120);
  contactShadow(root, 0, 22, 470, 96, 0.25);

  PROVIDERS.forEach((p, i) => {
    const bx = (i - 2.5) * 84;
    const booth = new Container();
    booth.position.set(bx, 18);

    // Open frame: two posts, lintel, low back rail. Same for every provider.
    const frame = new Graphics();
    for (const px of [-20, 16]) {
      frame.rect(px, -46, 4, 46).fill({ color: PALETTE.structureLight });
    }
    frame.rect(-22, -50, 44, 5).fill({ color: PALETTE.structure });
    frame.rect(-22, -50, 44, 5).stroke({ width: 1, color: shade(p.accent, -0.1), alpha: 0.7 });
    frame.rect(-20, -10, 40, 3).fill({ color: PALETTE.structure });
    booth.addChild(frame);
    booth.addChild(isoTile(0, 4, 52, 26, PALETTE.structure, 1, shade(p.accent, -0.2)));

    // Translating pedestal with a low-saturation accent tint.
    booth.addChild(isoBox({ x: 0, y: 0, w: 16, d: 9, h: 12, color: PALETTE.structure, rim: shade(p.accent, 0.05), rimAlpha: 0.6 }));
    const tint = glow(0, -18, 26, p.accent, 0.14);
    booth.addChild(tint);

    // Shared motif: a translation glyph (bracket pair around a dot).
    const glyph = new Graphics();
    glyph.moveTo(-6, -8).lineTo(-9, -8).lineTo(-9, -2).lineTo(-6, -2);
    glyph.moveTo(6, -8).lineTo(9, -8).lineTo(9, -2).lineTo(6, -2);
    glyph.stroke({ width: 1.2, color: p.accent, alpha: 0.85 });
    glyph.circle(0, -5, 2).fill({ color: p.accent });
    glyph.y = -14;
    booth.addChild(glyph);

    // Booth label sign (sm) above the lintel, in the labels layer.
    const label = makeSign(p.name, {
      x: def.anchor.x + bx,
      y: def.anchor.y - 46,
      size: "xs",
      accent: p.accent,
      halo: false,
    });
    label.zIndex = def.anchor.y + DEPTH.overlay - 5;
    ctx.layers.labels.addChild(label);

    root.addChild(booth);

    if (!ctx.reducedMotion) {
      // Gentle shared breathing across the row, staggered per booth.
      const tl = gsap.timeline({ repeat: -1, delay: i * 0.7 });
      tl.to(tint, { alpha: 0.3, duration: 3.2, ease: "sine.inOut" });
      tl.to(tint, { alpha: 0.14, duration: 3.2, ease: "sine.inOut" });
      ctx.onCleanup(() => tl.kill());
    }
  });

  registerStation({ id: "providers", root, hit });
}

/* ----------------------------------------------------------- 8. mcp health */

function buildMcpHealth(ctx: DioramaContext): void {
  const { root, hit } = stationShell(ctx, "mcpHealth", -66);
  contactShadow(root, 0, 8, 148, 78);
  root.addChild(isoTile(0, 4, 130, 66, PALETTE.structure, 1, PALETTE.structureLight));
  root.addChild(isoBox({ x: 0, y: 10, w: 26, d: 14, h: 8, color: PALETTE.structure, rim: PALETTE.structureLight }));

  // Panel-local space below: (0,0) is the panel's top-left, 104 x 44.
  const panel = screenPanel({ x: -52, y: -38, w: 104, h: 44, accent: PALETTE.cyan });
  root.addChild(panel);

  // Port health matrix mirroring the hub's 8 ports (shape + color per state).
  const cells: Container[] = [];
  for (let i = 0; i < 8; i++) {
    const cell = new Container();
    cell.position.set(14 + (i % 4) * 25, 7 + Math.floor(i / 4) * 11);
    const box = new Graphics();
    box.roundRect(-6, -4.5, 12, 9, 1.5);
    box.fill({ color: PALETTE.space });
    box.roundRect(-6, -4.5, 12, 9, 1.5);
    box.stroke({ width: 0.8, color: PALETTE.structureLight });
    cell.addChild(box);
    const badge = new Container();
    cell.addChild(badge);
    panel.addChild(cell);
    cells.push(badge);
  }
  const renderCells = (): void => {
    for (let i = 0; i < 8; i++) {
      cells[i].removeChildren();
      cells[i].addChild(stateBadge(portHealth[i]));
    }
  };
  renderCells();
  healthListeners.add(renderCells);
  ctx.onCleanup(() => healthListeners.delete(renderCells));

  // Latency sparkline.
  const spark = new Graphics();
  spark.moveTo(6, 32).lineTo(18, 28).lineTo(30, 34).lineTo(42, 26).lineTo(54, 31).lineTo(66, 27).lineTo(78, 32).lineTo(88, 29);
  spark.stroke({ width: 1, color: PALETTE.waiting, alpha: 0.8 });
  panel.addChild(spark);

  // Auth badge: a ringed dot at the sparkline's right end.
  const auth = new Graphics();
  auth.circle(97, 30, 3.5).stroke({ width: 1.2, color: PALETTE.healthy, alpha: 0.9 });
  auth.circle(97, 30, 1.4).fill({ color: PALETTE.healthy });
  panel.addChild(auth);

  // Rate-limit bars along the bottom edge.
  const barFills: Graphics[] = [];
  const limits = [0.72, 0.45, 0.85, 0.3];
  for (let i = 0; i < 4; i++) {
    const track = new Graphics();
    track.rect(8 + i * 24, 38, 20, 3.5).fill({ color: PALETTE.space });
    track.rect(8 + i * 24, 38, 20, 3.5).stroke({ width: 0.6, color: PALETTE.structureLight, alpha: 0.9 });
    panel.addChild(track);
    const fill = new Graphics();
    fill.rect(8 + i * 24, 38, 20 * limits[i], 3.5).fill({ color: PALETTE.violet, alpha: 0.85 });
    panel.addChild(fill);
    barFills.push(fill);
  }

  if (!ctx.reducedMotion) {
    const tl = gsap.timeline({ repeat: -1, yoyo: true });
    barFills.forEach((f, i) => {
      tl.to(f, { alpha: 0.5, duration: 3 + i * 0.4, ease: "sine.inOut" }, 0);
    });
    ctx.onCleanup(() => tl.kill());
  }

  registerStation({ id: "mcpHealth", root, hit });
}

/* ------------------------------------------------------ 9. env switchboard */

type EnvKey = "research" | "testnet" | "connected" | "signer";

function buildEnvSwitchboard(ctx: DioramaContext): EnvSwitchboardApi {
  const { root, hit } = stationShell(ctx, "envSwitchboard", -66);
  contactShadow(root, 0, 4, 158, 82);
  root.addChild(isoTile(0, 0, 140, 70, PALETTE.structure, 1, PALETTE.structureLight));
  // Signal mast on the west edge lifts the switchboard silhouette.
  const mast = new Graphics();
  mast.rect(-60, -78, 2, 82);
  mast.fill({ color: PALETTE.structureLight });
  mast.rect(-63, -78, 8, 1.4);
  mast.fill({ color: PALETTE.healthy, alpha: 0.7 });
  mast.circle(-59, -81, 2.2);
  mast.fill({ color: PALETTE.healthy, alpha: 0.95 });
  root.addChild(mast);
  root.addChild(glow(-59, -81, 12, PALETTE.healthy, 0.3));
  root.addChild(isoBox({ x: 0, y: -6, w: 110, d: 34, h: 26, color: PALETTE.structureLight, rim: PALETTE.violet, rimAlpha: 0.6 }));

  const glyphs: Record<EnvKey, (g: Graphics) => void> = {
    // flask
    research: (g) => {
      g.poly([-2, -6, 2, -6, 3, 6, -3, 6]);
      g.fill({ color: PALETTE.cyan, alpha: 0.9 });
    },
    // grid
    testnet: (g) => {
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 2; c++) g.rect(-5 + c * 6, -5 + r * 6, 4, 4).fill({ color: PALETTE.aqua, alpha: 0.9 });
      }
    },
    // link
    connected: (g) => {
      g.arc(-3, 0, 4, -Math.PI / 2, Math.PI / 2).stroke({ width: 1.6, color: PALETTE.blue });
      g.arc(3, 0, 4, Math.PI / 2, (Math.PI * 3) / 2).stroke({ width: 1.6, color: PALETTE.blue });
    },
    // key: a static symbol only, it never travels anywhere in this world.
    signer: (g) => {
      g.circle(-3, 0, 3.4).stroke({ width: 1.6, color: PALETTE.yellow });
      g.moveTo(0, 0).lineTo(6, 0);
      g.moveTo(4, 0).lineTo(4, 3);
      g.stroke({ width: 1.6, color: PALETTE.yellow });
    },
  };

  interface Column {
    key: EnvKey;
    lever: Graphics;
    lamp: Sprite;
    glyph: Graphics;
    lit: boolean;
  }
  const keys: EnvKey[] = ["research", "testnet", "connected", "signer"];
  const columns: Column[] = keys.map((key, i) => {
    const cx = -42 + i * 28;
    const lever = new Graphics();
    lever.rect(-1.2, 0, 2.4, 14);
    lever.fill({ color: PALETTE.surfacePale });
    lever.circle(0, 0, 2.4).fill({ color: PALETTE.structureLight });
    lever.position.set(cx, -34);
    lever.pivot.set(0, 0);
    root.addChild(lever);

    const lamp = glow(cx, -26, 16, PALETTE.healthy, 0.1);
    root.addChild(lamp);

    const glyph = new Graphics();
    glyphs[key](glyph);
    glyph.position.set(cx, -16);
    glyph.alpha = 0.4;
    root.addChild(glyph);

    return { key, lever, lamp, glyph, lit: false };
  });

  const applyColumn = (col: Column, lit: boolean, animate: boolean): void => {
    col.lit = lit;
    col.lamp.tint = lit ? PALETTE.healthy : PALETTE.structureLight;
    const targetAlpha = lit ? 0.5 : 0.12;
    if (animate) {
      gsap.to(col.lamp, { alpha: targetAlpha, duration: 0.4 });
      gsap.to(col.glyph, { alpha: lit ? 1 : 0.4, duration: 0.4 });
    } else {
      col.lamp.alpha = targetAlpha;
      col.glyph.alpha = lit ? 1 : 0.4;
    }
    // Lever throw: down when lit, up when not.
    gsap.to(col.lever, { y: lit ? -28 : -36, duration: 0.35, ease: "back.out(2)" });
  };

  // Default: testnet + connected + signer lit; research dimmed but present.
  columns.forEach((c) => applyColumn(c, c.key !== "research", false));

  const throwLever = (col: Column): void => {
    gsap.fromTo(col.lever, { y: col.lit ? -36 : -30 }, { y: col.lit ? -28 : -36, duration: 0.45, ease: "bounce.out" });
  };

  const api: EnvSwitchboardApi = {
    setEnv(state) {
      const col = columns.find((c) => c.key === state);
      if (!col) return;
      if (state === "research") {
        // Research mode stands alone: no trading authority is shared.
        columns.forEach((c) => applyColumn(c, c.key === "research", true));
      } else {
        columns.forEach((c) => applyColumn(c, c.key !== "research", true));
      }
      throwLever(col);
    },
  };
  ctx.onCleanup(() => {
    columns.forEach((c) => {
      gsap.killTweensOf(c.lever);
      gsap.killTweensOf(c.lamp);
      gsap.killTweensOf(c.glyph);
    });
  });
  registerStation({ id: "envSwitchboard", root, hit, api });
  return api;
}

/* ------------------------------------------------------------------ wiring */

export function buildMcpDistrict(ctx: DioramaContext): void {
  buildHub(ctx);
  buildMarketDataTools(ctx);
  buildResearchToolsMcp(ctx);
  buildPortfolioTools(ctx);
  buildToolSchemas(ctx);
  buildAdapterBay(ctx);
  buildProviders(ctx);
  buildMcpHealth(ctx);
  buildEnvSwitchboard(ctx);
}
