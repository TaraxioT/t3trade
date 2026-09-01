/**
 * Rail system: renders the rail network and moves typed packets along named
 * routes with a pooled packet layer. Owner: rails worker.
 *
 * Design notes:
 * - Static rail geometry (base line, kind glow line, junction dots) is drawn
 *   once per route into Graphics; only child alpha is animated afterwards.
 * - Packets come from a fixed pool of 40 containers built up front; dispatch
 *   only flips visibility/tints and starts a GSAP tween. No construction and
 *   no per-frame allocations happen in the travel update path (positions are
 *   written through a module-level scratch sample object).
 */
import { Container, Graphics, Sprite } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { PACKET_STYLE, PRIMARY_ROUTES, RETURN_ROUTES, ROUTES, ROUTE_ORDER } from "../config/rails.js";
import type { PacketKind, RouteDef, RouteId } from "../config/rails.js";
import { PALETTE } from "../config/palette.js";
import { DEPTH, seededRandom } from "../config/world.js";
import type { Point } from "../config/world.js";
import { dotTexture, glow } from "../core/iso.js";

export interface PacketHandle {
  /** Resolve when the packet reaches the route end. */
  done: Promise<void>;
  cancel(): void;
}

export interface RailSystem {
  dispatch(route: RouteId, kind?: PacketKind, opts?: { reverse?: boolean; label?: string }): PacketHandle;
  /** Slow ambient pulses so rails never look dead between stories. */
  startAmbient(): void;
  /** Dim non-primary rails while a station is in focus. No caller yet. */
  setFocusDim(on: boolean): void;
}

/** Travel speed in world units per second. */
const PACKET_SPEED = 260;
const POOL_SIZE = 40;
const POP_POOL_SIZE = 6;
/** Quiet routes ambient traffic may use; never busy story corridors. */
const AMBIENT_ROUTES: RouteId[] = [
  "landscapeToMarketData",
  "landscapeToResearchTools",
  "floorToMcp",
  "receiptsToArchive",
  "localStateStream",
];
const AMBIENT_MAX_ALIVE = 2;

interface RoutePath {
  def: RouteDef;
  /** Cumulative length at each point: cum[0] = 0, cum[n-1] = total. */
  cum: number[];
  total: number;
}

interface Packet {
  root: Container;
  glow: Sprite;
  chevron: Graphics;
  dotHalo: Sprite;
  dotCore: Sprite;
  card: Graphics;
  capsule: Graphics;
  slip: Graphics;
  trail: [Sprite, Sprite];
}

interface ActivePacket {
  packet: Packet;
  tween: gsap.core.Tween;
  resolve: () => void;
  settled: boolean;
}

/** Scratch output for path sampling; reused to avoid per-frame allocation. */
const sampleOut: { x: number; y: number; angle: number } = { x: 0, y: 0, angle: 0 };

function buildPath(def: RouteDef): RoutePath {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < def.points.length; i++) {
    const a = def.points[i - 1];
    const b = def.points[i];
    total += Math.hypot(b.x - a.x, b.y - a.y);
    cum.push(total);
  }
  return { def, cum, total };
}

/** Sample position + segment angle at forward distance d. Writes sampleOut. */
function samplePath(path: RoutePath, d: number): void {
  const pts = path.def.points;
  const cum = path.cum;
  const last = pts.length - 1;
  if (d <= 0) {
    sampleOut.x = pts[0].x;
    sampleOut.y = pts[0].y;
    sampleOut.angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
    return;
  }
  if (d >= path.total) {
    sampleOut.x = pts[last].x;
    sampleOut.y = pts[last].y;
    sampleOut.angle = Math.atan2(pts[last].y - pts[last - 1].y, pts[last].x - pts[last - 1].x);
    return;
  }
  let i = 1;
  while (cum[i] < d) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1]);
  sampleOut.x = a.x + (b.x - a.x) * t;
  sampleOut.y = a.y + (b.y - a.y) * t;
  sampleOut.angle = Math.atan2(b.y - a.y, b.x - a.x);
}

function medianY(points: Point[]): number {
  const ys = points.map((p) => p.y).sort((a, b) => a - b);
  return ys[Math.floor(ys.length / 2)];
}

function strokePolyline(g: Graphics, points: Point[], width: number, color: number, alpha: number): void {
  g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
  g.stroke({ width, color, alpha, cap: "round", join: "round" });
}

/** Dashed polyline: dashes of dashU units with gapU gaps, drawn once. */
function strokeDashed(
  g: Graphics,
  points: Point[],
  width: number,
  color: number,
  alpha: number,
  dashU: number,
  gapU: number,
): void {
  let remainingDash = 0;
  let drawing = true;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len <= 0) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let d = 0;
    while (d < len) {
      const budget = drawing ? dashU - remainingDash : gapU - remainingDash;
      const step = Math.min(budget, len - d);
      const x1 = a.x + ux * d;
      const y1 = a.y + uy * d;
      if (drawing) {
        g.moveTo(x1, y1);
        g.lineTo(a.x + ux * (d + step), a.y + uy * (d + step));
      }
      d += step;
      if (step >= budget - 1e-6) {
        drawing = !drawing;
        remainingDash = 0;
      } else {
        remainingDash += step;
      }
    }
  }
  g.stroke({ width, color, alpha, cap: "round", join: "round" });
}

/**
 * Static direction chevrons stamped along a primary route every ~90 units.
 * Prebuilt once into a single Graphics (no per-frame draws); they never
 * animate, so reduced motion needs no variant.
 */
function buildChevrons(path: RoutePath, color: number): Graphics {
  const g = new Graphics();
  const step = 90;
  for (let d = step; d < path.total - 40; d += step) {
    samplePath(path, d);
    // Copy out of the shared scratch before the next call.
    const x = sampleOut.x;
    const y = sampleOut.y;
    const ca = Math.cos(sampleOut.angle);
    const sa = Math.sin(sampleOut.angle);
    // Chevron in local coords: tip (5,0), barbs (-4,-3.6) and (-4,3.6).
    const tx = (lx: number, ly: number): number => x + lx * ca - ly * sa;
    const ty = (lx: number, ly: number): number => y + lx * sa + ly * ca;
    g.moveTo(tx(5, 0), ty(5, 0));
    g.lineTo(tx(-4, -3.6), ty(-4, -3.6));
    g.moveTo(tx(5, 0), ty(5, 0));
    g.lineTo(tx(-4, 3.6), ty(-4, 3.6));
  }
  g.stroke({ width: 1.4, color, alpha: 0.5, cap: "round", join: "round" });
  g.blendMode = "add";
  return g;
}

function buildRouteVisual(ctx: DioramaContext, path: RoutePath): Container {
  const def = path.def;
  const route = new Container();
  route.zIndex = medianY(def.points) + DEPTH.rail;
  const kindColor = PACKET_STYLE[def.kind].color;
  const primary = PRIMARY_ROUTES.has(def.id);
  const isReturn = RETURN_ROUTES.has(def.id);
  // Return legs are warm gold so they read as a distinct flow from the
  // cyan/violet outgoing traffic and the orange order capsules.
  const lineColor = isReturn ? PALETTE.yellow : kindColor;

  // Structural base: dark casing the glow line sits inside. Primary rails
  // are wider and more present; subordinate traffic stays thin and dim.
  const base = new Graphics();
  strokePolyline(base, def.points, primary ? 6 : 4, PALETTE.spaceAlt, primary ? 0.38 : 0.2);
  route.addChild(base);

  // Inner glow line, additive. Returns draw dashed to separate the return
  // flow from solid outgoing rails even where the two run near each other.
  const inner = new Graphics();
  if (isReturn) {
    strokeDashed(inner, def.points, 1.8, lineColor, primary ? 0.5 : 0.34, 10, 8);
  } else {
    strokePolyline(inner, def.points, primary ? 2.4 : 1.4, lineColor, primary ? 0.55 : 0.28);
  }
  inner.blendMode = "add";
  route.addChild(inner);

  // Direction chevrons on the primary lifecycle corridor only.
  if (primary) {
    route.addChild(buildChevrons(path, lineColor));
  }

  // Junction nodes: small glowing dots at interior bends.
  if (def.points.length > 2) {
    const nodes = new Graphics();
    for (let i = 1; i < def.points.length - 1; i++) {
      const p = def.points[i];
      nodes.circle(p.x, p.y, 2.2);
      nodes.fill({ color: lineColor, alpha: primary ? 0.3 : 0.2 });
    }
    nodes.blendMode = "add";
    route.addChild(nodes);
  }

  // The exchange crossing gets a physical casing from the ground worker;
  // a brighter pulsing inner line marks it as THE crossing to the exchange.
  if (def.id === "exchangeTunnel") {
    const pulse = new Graphics();
    strokePolyline(pulse, def.points, 3.2, PALETTE.orange, 0.35);
    pulse.blendMode = "add";
    route.addChild(pulse);
    // Static alpha 0.35 when reduced motion; otherwise a gentle pulse.
    if (!ctx.reducedMotion) {
      const tween = gsap.to(pulse, {
        alpha: 0.55,
        duration: 1.6,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      });
      ctx.onCleanup(() => tween.kill());
    }
  }

  ctx.layers.sortable.addChild(route);
  return route;
}

function buildPacket(): Packet {
  const root = new Container();
  root.visible = false;

  // Soft glow underlay, retinted per dispatch.
  const halo = new Sprite(dotTexture());
  halo.anchor.set(0.5);
  halo.alpha = 0.35;
  halo.blendMode = "add";

  // Chevron: arrow pointing along +x; rotated to the segment angle.
  const chevron = new Graphics();
  chevron.poly([6, 0, -5, -4.5, -2.5, 0, -5, 4.5]);
  chevron.fill({ color: 0xffffff });
  chevron.poly([6, 0, -5, -4.5, -2.5, 0, -5, 4.5]);
  chevron.stroke({ width: 1, color: 0xffffff, alpha: 0.5 });

  // Dot family: additive glow sprite plus a crisp core sprite.
  const dotHalo = new Sprite(dotTexture());
  dotHalo.anchor.set(0.5);
  dotHalo.alpha = 0.5;
  dotHalo.blendMode = "add";
  const dotCore = new Sprite(dotTexture());
  dotCore.anchor.set(0.5);
  dotCore.alpha = 1;

  // Card: small rounded rect with dark fill and a kind-colored frame.
  const card = new Graphics();
  card.roundRect(-8, -5.5, 16, 11, 3);
  card.fill({ color: PALETTE.space });
  card.roundRect(-8, -5.5, 16, 11, 3);
  card.stroke({ width: 1.4, color: 0xffffff, alpha: 0.95 });
  card.moveTo(-5, -1.8);
  card.lineTo(5, -1.8);
  card.stroke({ width: 1.1, color: 0xffffff, alpha: 0.5 });

  // Capsule: rounded elongated rect in the kind color.
  const capsule = new Graphics();
  capsule.roundRect(-11, -3.8, 22, 7.6, 3.8);
  capsule.fill({ color: 0xffffff, alpha: 0.92 });

  // Slip: pale rect with two dark text-lines (a printed receipt).
  const slip = new Graphics();
  slip.roundRect(-6.5, -5, 13, 10, 1.5);
  slip.fill({ color: PALETTE.surfacePale, alpha: 0.95 });
  slip.moveTo(-4, -2);
  slip.lineTo(4, -2);
  slip.stroke({ width: 1.1, color: PALETTE.structure, alpha: 0.9 });
  slip.moveTo(-4, 1.5);
  slip.lineTo(2.5, 1.5);
  slip.stroke({ width: 1.1, color: PALETTE.structure, alpha: 0.9 });

  // Fading two-sprite trail, quality "high" only.
  const t0 = new Sprite(dotTexture());
  t0.anchor.set(0.5);
  t0.alpha = 0.22;
  t0.blendMode = "add";
  t0.visible = false;
  const t1 = new Sprite(dotTexture());
  t1.anchor.set(0.5);
  t1.alpha = 0.1;
  t1.blendMode = "add";
  t1.visible = false;

  root.addChild(halo, chevron, dotHalo, dotCore, card, capsule, slip, t0, t1);
  return {
    root,
    glow: halo,
    chevron,
    dotHalo,
    dotCore,
    card,
    capsule,
    slip,
    trail: [t0, t1],
  };
}

function configurePacketVisual(p: Packet, kind: PacketKind): void {
  const style = PACKET_STYLE[kind];
  const s = style.size;
  p.glow.tint = style.color;
  p.glow.width = s * 3.6;
  p.glow.height = s * 3.6;
  p.chevron.tint = style.color;
  p.dotHalo.tint = style.color;
  p.dotHalo.width = s * 3;
  p.dotHalo.height = s * 3;
  p.dotCore.tint = style.color;
  p.dotCore.width = s;
  p.dotCore.height = s;
  // Cards are stroked with a fixed white tint; tint the whole graphics.
  p.card.tint = style.color;
  p.capsule.tint = style.color;
  p.trail[0].tint = style.color;
  p.trail[1].tint = style.color;
  const showChevron = style.shape === "chevron";
  const showDot = style.shape === "dot";
  const showCard = style.shape === "card";
  const showCapsule = style.shape === "capsule";
  const showSlip = style.shape === "slip";
  p.chevron.visible = showChevron;
  p.dotHalo.visible = showDot;
  p.dotCore.visible = showDot;
  p.card.visible = showCard;
  p.capsule.visible = showCapsule;
  p.slip.visible = showSlip;
}

export function createRailSystem(ctx: DioramaContext): RailSystem {
  const paths = new Map<RouteId, RoutePath>();
  const routeVisuals = new Map<RouteId, Container>();
  for (const id of ROUTE_ORDER) {
    const path = buildPath(ROUTES[id]);
    paths.set(id, path);
    routeVisuals.set(id, buildRouteVisual(ctx, path));
  }

  // Packet pool: fully built up front; dispatch only reuses.
  const pool: Packet[] = [];
  const free: Packet[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const p = buildPacket();
    pool.push(p);
    free.push(p);
    ctx.layers.sortable.addChild(p.root);
  }

  // Arrival pop glows, pooled likewise.
  const pops: Sprite[] = [];
  const freePops: Sprite[] = [];
  for (let i = 0; i < POP_POOL_SIZE; i++) {
    const pop = glow(0, 0, 18, 0xffffff, 0);
    pop.visible = false;
    pops.push(pop);
    freePops.push(pop);
    ctx.layers.sortable.addChild(pop);
  }

  const active = new Set<ActivePacket>();
  let ambientAlive = 0;
  let ambientStarted = false;
  const ambientTimers: gsap.core.Tween[] = [];

  ctx.onCleanup(() => {
    for (const a of active) a.tween.kill();
    active.clear();
    for (const t of ambientTimers) t.kill();
    ambientTimers.length = 0;
    for (const pop of pops) gsap.killTweensOf(pop);
    for (const visual of routeVisuals.values()) gsap.killTweensOf(visual);
  });

  function popArrival(x: number, y: number, color: number): void {
    if (ctx.reducedMotion) return;
    const pop = freePops.pop();
    if (!pop) return;
    pop.tint = color;
    pop.position.set(x, y);
    pop.zIndex = y + DEPTH.packet;
    pop.visible = true;
    pop.alpha = 0.55;
    pop.width = 18;
    pop.height = 18;
    gsap.to(pop, {
      alpha: 0,
      width: 44,
      height: 44,
      duration: 0.45,
      ease: "quad.out",
      onComplete: () => {
        pop.visible = false;
        if (!freePops.includes(pop)) freePops.push(pop);
      },
    });
  }

  function release(a: ActivePacket): void {
    if (a.settled) return;
    a.settled = true;
    a.tween.kill();
    a.packet.root.visible = false;
    a.packet.trail[0].visible = false;
    a.packet.trail[1].visible = false;
    free.push(a.packet);
    active.delete(a);
    a.resolve();
  }

  function dispatch(
    routeId: RouteId,
    kind?: PacketKind,
    opts?: { reverse?: boolean; label?: string },
  ): PacketHandle {
    // `label` is intentionally unused: packets are too small for text.
    void opts?.label;
    const path = paths.get(routeId);
    const packet = free.pop();
    if (!path || !packet) {
      return { done: Promise.resolve(), cancel: () => {} };
    }
    const reverse = opts?.reverse === true;
    const useKind = kind ?? path.def.kind;
    const style = PACKET_STYLE[useKind];
    configurePacketVisual(packet, useKind);

    // Return legs: warm gold tint plus a single-sprite tail so the dash
    // rhythm matches the dashed rail beneath. Receipt slips keep their pale
    // paper read; only glow and tail warm up.
    const isReturn = RETURN_ROUTES.has(routeId);
    if (isReturn) {
      packet.glow.tint = PALETTE.yellow;
      packet.trail[0].tint = PALETTE.yellow;
      packet.trail[1].tint = PALETTE.yellow;
      if (style.shape !== "slip" && style.shape !== "card") {
        packet.chevron.tint = PALETTE.yellow;
        packet.dotHalo.tint = PALETTE.yellow;
        packet.dotCore.tint = PALETTE.yellow;
        packet.capsule.tint = PALETTE.yellow;
      }
    }

    const useTrail = ctx.quality === "high" && !ctx.reducedMotion;
    packet.trail[0].visible = useTrail;
    // Returns keep only the near trail sprite: one trailing dash.
    packet.trail[1].visible = useTrail && !isReturn;
    if (useTrail) {
      const tw = style.size * 1.6;
      packet.trail[0].width = tw;
      packet.trail[0].height = tw;
      packet.trail[1].width = tw * 0.8;
      packet.trail[1].height = tw * 0.8;
    }

    packet.root.visible = true;
    // Progress object is tweened; sampled position writes into scratch.
    const state = { d: 0 };
    let settled = false;
    let tween: gsap.core.Tween;

    const done = new Promise<void>((resolve) => {
      const record: ActivePacket = { packet, tween: null as unknown as gsap.core.Tween, resolve, settled: false };
      tween = gsap.to(state, {
        d: path.total,
        duration: path.total / PACKET_SPEED,
        ease: "none",
        onUpdate: () => {
          const forward = reverse ? path.total - state.d : state.d;
          samplePath(path, forward);
          packet.root.position.set(sampleOut.x, sampleOut.y);
          packet.root.zIndex = sampleOut.y + DEPTH.packet;
          let angle = sampleOut.angle;
          if (reverse) angle += Math.PI;
          if (style.shape === "chevron") packet.chevron.rotation = angle;
          if (style.shape === "capsule") packet.capsule.rotation = angle;
          if (useTrail) {
            samplePath(path, Math.max(0, forward - 12));
            packet.trail[0].position.set(sampleOut.x - packet.root.x, sampleOut.y - packet.root.y);
            samplePath(path, Math.max(0, forward - 24));
            packet.trail[1].position.set(sampleOut.x - packet.root.x, sampleOut.y - packet.root.y);
          }
        },
        onComplete: () => {
          const end = reverse ? path.def.points[0] : path.def.points[path.def.points.length - 1];
          popArrival(end.x, end.y, style.color);
          record.tween = tween;
          release(record);
          settled = true;
        },
      });
      record.tween = tween;
      active.add(record);
    });

    return {
      done,
      cancel: () => {
        if (settled) return;
        settled = true;
        for (const a of active) {
          if (a.packet === packet) {
            release(a);
            return;
          }
        }
      },
    };
  }

  function startAmbient(): void {
    if (ambientStarted) return;
    ambientStarted = true;
    // Reduced motion keeps ambient packets (they are informational, not
    // decorative drift) but dispatch already drops trails and arrival pops.
    const rng = seededRandom(42);
    const schedule = (): void => {
      const delay = 5 + rng() * 4; // 5-9 s between bursts
      const timer = gsap.delayedCall(delay, () => {
        const slots = AMBIENT_MAX_ALIVE - ambientAlive;
        if (slots > 0) {
          const count = rng() < 0.35 ? Math.min(2, slots) : 1;
          for (let i = 0; i < count; i++) {
            const routeId = AMBIENT_ROUTES[Math.floor(rng() * AMBIENT_ROUTES.length)];
            const def = ROUTES[routeId];
            // Reverse travel only on two-way routes; the flag gates ambient.
            const reverse = def.twoWay === true && rng() < 0.5;
            ambientAlive++;
            const handle = dispatch(routeId, undefined, { reverse });
            void handle.done.then(() => {
              ambientAlive--;
            });
          }
        }
        schedule();
      });
      ambientTimers.push(timer);
    };
    schedule();
  }

  let focusDim = false;

  function setFocusDim(on: boolean): void {
    if (on === focusDim) return;
    focusDim = on;
    for (const [id, visual] of routeVisuals) {
      if (PRIMARY_ROUTES.has(id)) continue;
      if (ctx.reducedMotion) {
        gsap.killTweensOf(visual);
        visual.alpha = on ? 0.25 : 1;
      } else {
        gsap.to(visual, { alpha: on ? 0.25 : 1, duration: 0.3, ease: "power1.out", overwrite: true });
      }
    }
  }

  return { dispatch, startAmbient, setFocusDim };
}
