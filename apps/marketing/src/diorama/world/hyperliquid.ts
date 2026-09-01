/**
 * Hyperliquid testnet exchange port: the external exchange docked INTO the
 * Central Trading Floor's east side. A wall-aligned booth in a deliberately
 * different material language (pale cool slab, aqua trim, dark keel) so it
 * reads as outside infrastructure plugged through the N-E wall rather than
 * another internal console: a service collar on the wall face, an umbilical
 * conduit down to the slab, an order-book wall on the booth's back, a slow
 * rotating trade ring, and the terminal threshold (pad + frame) where the
 * order and state rails dock. Registered like every station under id
 * "hyperliquidVenue", exposing the frozen exchangeEvent api through the
 * station registry. Idle luminance stays low so the central floor dominates;
 * the pad and collar peak only on order/ack/fill/state beats. Honesty copy
 * ("AUTHORITATIVE EXCHANGE", "Simulated feed", "Open on Hyperliquid") is
 * registered detail text owned by the signs policy.
 */
import { Container, Graphics } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { glow, isoBox, isoWall } from "../core/iso.js";
import { makeDetailText, makeSign } from "../core/signs.js";
import { registerStation } from "../core/registry.js";
import { PALETTE, shade } from "../config/palette.js";
import { STATIONS } from "../config/stations.js";
import { WALL_EDGES } from "../config/geometry.js";
import { seededRandom } from "../config/world.js";

export interface HyperliquidApi {
  /** Animate: order received, acknowledged, filled, state update. */
  exchangeEvent(kind: "order" | "ack" | "fill" | "state"): void;
}

const S = 1 / Math.sqrt(5);
/** Along the N-E wall base (screen slope +1/2), pointing toward the E corner. */
const E1 = { x: 2 * S, y: S };
/** Wall's ground-perpendicular, pointing into the room (screen slope -1/2). */
const E2 = { x: -2 * S, y: S };
/** Outward screen normal of the N-E wall base. */
const N_OUT = { x: S, y: -2 * S };

const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** One pale order-book block; redrawn only when its state flips. */
function bookBlock(x: number, y: number, on: boolean): Graphics {
  const g = new Graphics();
  g.position.set(x, y);
  paintBlock(g, on);
  return g;
}

function paintBlock(g: Graphics, on: boolean): void {
  g.clear();
  g.rect(-3.3, -2.6, 6.6, 5.2);
  g.fill({ color: PALETTE.surfacePale, alpha: on ? 0.85 : 0.3 });
  g.rect(-3.3, -2.6, 6.6, 5.2);
  g.stroke({ width: 0.7, color: PALETTE.aqua, alpha: on ? 0.5 : 0.2 });
}

export function buildExchangePort(ctx: DioramaContext): void {
  const def = STATIONS.hyperliquidVenue;
  const { x, y } = def.anchor;

  // Wall-aligned booth frame: the back edge runs parallel to the N-E wall;
  // the docking link spans whatever gap the anchor leaves to the wall face.
  const L = 200; // along-wall length
  const D = 148; // ground depth into the room
  const SLAB_H = 16;
  const back = { x: x - E2.x * (D / 2), y: y - E2.y * (D / 2) };
  const A = { x: back.x - E1.x * (L / 2), y: back.y - E1.y * (L / 2) }; // back-west
  const B = { x: back.x + E1.x * (L / 2), y: back.y + E1.y * (L / 2) }; // back-east
  const A2 = { x: A.x + E2.x * D, y: A.y + E2.y * D }; // front-west
  const B2 = { x: B.x + E2.x * D, y: B.y + E2.y * D }; // front-east
  // Perpendicular foot of the back-edge center on the N-E wall base.
  const wallA = WALL_EDGES.east.a;
  const sOut = (back.x - wallA.x) * N_OUT.x + (back.y - wallA.y) * N_OUT.y;
  const foot = { x: back.x - N_OUT.x * sOut, y: back.y - N_OUT.y * sOut };

  const root = new Container();
  root.zIndex = y;
  ctx.layers.sortable.addChild(root);

  // --- Keel and contact shadow: dark mass under the pale top so the booth
  // reads as heavy infrastructure resting on the room floor.
  const shadow = new Graphics();
  shadow.ellipse(x, y + 20, 138, 48);
  shadow.fill({ color: PALETTE.space, alpha: 0.32 });
  root.addChild(shadow);

  const keel = new Graphics();
  keel.poly([A.x, A.y + 9, B.x, B.y + 9, B2.x, B2.y + 9, A2.x, A2.y + 9]);
  keel.fill({ color: shade(PALETTE.structure, -0.45) });
  // Inner keel band: the ground print shrunk 6% toward the booth center.
  const shrink = (p: { x: number; y: number }, t = 0.06): { x: number; y: number } => ({
    x: p.x + (x - p.x) * t,
    y: p.y + (y - p.y) * t + 4,
  });
  keel.poly([shrink(A), shrink(B), shrink(B2), shrink(A2)].flatMap((p) => [p.x, p.y]));
  keel.fill({ color: PALETTE.spaceAlt });
  root.addChild(keel);

  // --- Slab: foreign material, pale cool top with aqua trim -----------------
  const slab = new Graphics();
  slab.poly([A2.x, A2.y, B2.x, B2.y, B2.x, B2.y - SLAB_H, A2.x, A2.y - SLAB_H]);
  slab.fill({ color: PALETTE.structureLight });
  slab.poly([B.x, B.y, B2.x, B2.y, B2.x, B2.y - SLAB_H, B.x, B.y - SLAB_H]);
  slab.fill({ color: PALETTE.spaceAlt });
  slab.poly([A.x, A.y - SLAB_H, B.x, B.y - SLAB_H, B2.x, B2.y - SLAB_H, A2.x, A2.y - SLAB_H]);
  slab.fill({ color: PALETTE.surfacePale, alpha: 0.88 });
  slab.poly([A.x, A.y - SLAB_H, B.x, B.y - SLAB_H, B2.x, B2.y - SLAB_H, A2.x, A2.y - SLAB_H]);
  slab.stroke({ width: 1.5, color: PALETTE.aqua, alpha: 0.6 });
  root.addChild(slab);
  // Underglow, restrained: the booth must read through structure, not
  // outshine the central trading floor it serves.
  root.addChild(glow(x, y + 26, 240, PALETTE.aqua, 0.07));

  // --- Back wall along the room wall: two low chevron segments meeting at
  // the back-edge center. The order-book mounts on its face.
  root.addChild(
    isoWall({
      x1: A.x,
      y1: A.y - SLAB_H,
      x2: back.x,
      y2: back.y - SLAB_H,
      h: 36,
      color: PALETTE.structure,
      alpha: 0.96,
      rim: PALETTE.aqua,
    }),
    isoWall({
      x1: back.x,
      y1: back.y - SLAB_H,
      x2: B.x,
      y2: B.y - SLAB_H,
      h: 36,
      color: PALETTE.structure,
      alpha: 0.96,
      rim: PALETTE.aqua,
    }),
  );

  // --- Order-book wall sculpture: a billboard panel of pale levels on the
  // back wall's west half (the east half stays open toward the state row).
  const bookPanelAt = lerp(back, A, 0.56);
  const book = new Container();
  book.position.set(bookPanelAt.x, bookPanelAt.y - 20);
  const bookBack = new Graphics();
  bookBack.roundRect(-31, -20, 62, 40, 4);
  bookBack.fill({ color: PALETTE.space, alpha: 0.72 });
  bookBack.roundRect(-31, -20, 62, 40, 4);
  bookBack.stroke({ width: 1.2, color: PALETTE.aqua, alpha: 0.55 });
  book.addChild(bookBack);
  root.addChild(book);
  const rnd = seededRandom(5);
  const blocks: Array<{ g: Graphics; on: boolean }> = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 6; col++) {
      if (rnd() < 0.2) continue; // missing levels
      const b = { g: bookBlock(-25 + col * 10, 12 - row * 7, true), on: true };
      blocks.push(b);
      book.addChild(b.g);
    }
  }

  // --- Rotating hexagonal trade ring (slab center, additive aqua) -----------
  const ring = new Graphics();
  ring.position.set(x, y - 12);
  const hexPts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    hexPts.push(Math.cos(a) * 26, Math.sin(a) * 14.5);
  }
  ring.poly(hexPts);
  ring.stroke({ width: 2, color: PALETTE.aqua, alpha: 0.5 });
  ring.circle(0, 0, 2.4);
  ring.fill({ color: PALETTE.cyan, alpha: 0.8 });
  ring.blendMode = "add";
  root.addChild(ring);

  // --- Terminal threshold (room-facing front edge): landing pad + socket
  // cradle + a small gate frame. exchangeOrder and exchangeStateReturn dock
  // here, on the floor side of the booth, right at the seam.
  const pad = { x: x + E2.x * 60 - E1.x * 10, y: y + E2.y * 60 - E1.y * 10 };
  const padG = new Graphics();
  padG.ellipse(pad.x, pad.y, 24, 12);
  padG.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.75 });
  padG.ellipse(pad.x, pad.y, 13, 6.5);
  padG.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.45 });
  padG.ellipse(pad.x, pad.y, 2.8, 1.4);
  padG.fill({ color: PALETTE.aqua, alpha: 0.8 });
  root.addChild(padG);
  const guideL = glow(pad.x - E1.x * 32, pad.y - E1.y * 32 - 8, 22, PALETTE.cyan, 0.3);
  const guideR = glow(pad.x + E1.x * 32, pad.y + E1.y * 32 - 8, 22, PALETTE.cyan, 0.3);
  root.addChild(guideL, guideR);
  // Socket cradle around the pad: etched side ticks give the rail beams a
  // visible terminal instead of stopping mid-slab.
  const socket = new Graphics();
  socket.ellipse(pad.x, pad.y, 31, 15.5);
  socket.stroke({ width: 2, color: PALETTE.aqua, alpha: 0.7 });
  socket.ellipse(pad.x, pad.y, 26, 13);
  socket.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.45 });
  socket.moveTo(pad.x - 38, pad.y);
  socket.lineTo(pad.x - 33, pad.y);
  socket.moveTo(pad.x + 33, pad.y);
  socket.lineTo(pad.x + 38, pad.y);
  socket.moveTo(pad.x, pad.y - 20);
  socket.lineTo(pad.x, pad.y - 16);
  socket.moveTo(pad.x, pad.y + 16);
  socket.lineTo(pad.x, pad.y + 20);
  socket.stroke({ width: 1.5, color: PALETTE.aqua, alpha: 0.55, cap: "round" });
  socket.blendMode = "add";
  root.addChild(socket);
  // Threshold frame: two slim posts and a beam straddling the pad, parallel
  // to the wall, marking where crossing traffic enters the booth.
  const frame = new Graphics();
  for (const side of [-1, 1]) {
    const px = pad.x + E1.x * 27 * side;
    const py = pad.y + E1.y * 27 * side;
    frame.roundRect(px - 2.2, py - 30, 4.4, 30, 2);
    frame.fill({ color: PALETTE.structureLight });
    frame.roundRect(px - 2.2, py - 30, 4.4, 30, 2);
    frame.stroke({ width: 1, color: PALETTE.aqua, alpha: 0.8 });
  }
  const fl = { x: pad.x - E1.x * 27, y: pad.y - E1.y * 27 - 28 };
  const fr = { x: pad.x + E1.x * 27, y: pad.y + E1.y * 27 - 28 };
  frame.moveTo(fl.x, fl.y);
  frame.lineTo(fr.x, fr.y);
  frame.stroke({ width: 2.5, color: PALETTE.structureLight });
  frame.moveTo(fl.x, fl.y);
  frame.lineTo(fr.x, fr.y);
  frame.stroke({ width: 1, color: PALETTE.aqua, alpha: 0.9 });
  root.addChild(frame);

  // --- Docking link to the wall: umbilical conduit + service collar on the
  // wall face, so the booth visibly plugs THROUGH the room wall. The collar
  // is the exchange's entry; everything beyond it is outside.
  const ub = { x: back.x - E1.x * 30, y: back.y - E1.y * 30 };
  const ub2 = { x: back.x + E1.x * 30, y: back.y + E1.y * 30 };
  const uf = { x: foot.x - E1.x * 26, y: foot.y - E1.y * 26 };
  const uf2 = { x: foot.x + E1.x * 26, y: foot.y + E1.y * 26 };
  const umbilical = new Graphics();
  umbilical.poly([ub.x, ub.y, ub2.x, ub2.y, uf2.x, uf2.y, uf.x, uf.y]);
  umbilical.fill({ color: shade(PALETTE.structure, -0.35), alpha: 0.95 });
  for (const off of [-14, 0, 14]) {
    const p1 = lerp(
      { x: back.x + E1.x * off, y: back.y + E1.y * off },
      { x: foot.x + E1.x * off, y: foot.y + E1.y * off },
      0.05,
    );
    const p2 = lerp(
      { x: back.x + E1.x * off, y: back.y + E1.y * off },
      { x: foot.x + E1.x * off, y: foot.y + E1.y * off },
      0.95,
    );
    umbilical.moveTo(p1.x, p1.y);
    umbilical.lineTo(p2.x, p2.y);
    umbilical.stroke({ width: 1.5, color: PALETTE.aqua, alpha: 0.4 });
  }
  root.addChild(umbilical);
  const junction = lerp(back, foot, 0.5);
  root.addChild(
    isoBox({
      x: junction.x,
      y: junction.y,
      w: 20,
      d: 11,
      h: 9,
      color: PALETTE.structureLight,
      rim: PALETTE.aqua,
    }),
  );
  root.addChild(
    isoWall({
      x1: foot.x - E1.x * 32,
      y1: foot.y - E1.y * 32,
      x2: foot.x + E1.x * 32,
      y2: foot.y + E1.y * 32,
      h: 42,
      color: PALETTE.structureLight,
      rim: PALETTE.aqua,
    }),
  );
  root.addChild(glow(foot.x, foot.y - 20, 26, PALETTE.aqua, 0.35));
  root.addChild(glow(foot.x - E1.x * 32, foot.y - E1.y * 32 - 8, 16, PALETTE.aqua, 0.3));
  root.addChild(glow(foot.x + E1.x * 32, foot.y - E1.y * 32 - 8, 16, PALETTE.aqua, 0.3));

  // --- Pooled event sprites ---------------------------------------------------
  const capsule = new Graphics();
  capsule.roundRect(-9, -4.5, 18, 9, 4.5);
  capsule.fill({ color: PALETTE.orange, alpha: 0.95 });
  capsule.alpha = 0;
  root.addChild(capsule);

  const settle = new Graphics();
  settle.ellipse(0, 0, 14, 7);
  settle.stroke({ width: 1.5, color: PALETTE.orange, alpha: 0.9 });
  settle.alpha = 0;
  root.addChild(settle);

  const ackRing = new Graphics();
  ackRing.ellipse(0, 0, 12, 6);
  ackRing.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.9 });
  ackRing.position.set(pad.x, pad.y);
  ackRing.alpha = 0;
  root.addChild(ackRing);

  const slip = new Graphics();
  slip.roundRect(-7, -5, 14, 10, 2);
  slip.fill({ color: PALETTE.surfacePale, alpha: 0.9 });
  slip.alpha = 0;
  root.addChild(slip);

  const tick = new Graphics();
  tick.moveTo(-5, 0);
  tick.lineTo(-1, 4);
  tick.lineTo(6, -5);
  tick.stroke({ width: 2.5, color: PALETTE.healthy, alpha: 0.95 });
  tick.position.set(ring.x, ring.y - 26);
  tick.alpha = 0;
  root.addChild(tick);

  const sheet = new Graphics();
  sheet.roundRect(-13, -9, 26, 18, 2);
  sheet.fill({ color: PALETTE.surfacePale, alpha: 0.9 });
  sheet.rect(-9, -4, 18, 1.5);
  sheet.fill({ color: PALETTE.structure, alpha: 0.6 });
  sheet.rect(-9, 1, 12, 1.5);
  sheet.fill({ color: PALETTE.structure, alpha: 0.6 });
  sheet.alpha = 0;
  root.addChild(sheet);

  const packet = new Graphics();
  packet.rect(-5, -5, 10, 10);
  packet.fill({ color: PALETTE.aqua, alpha: 0.9 });
  packet.alpha = 0;
  root.addChild(packet);

  // Idle vs peaks: the booth sits quiet between beats, then the terminal
  // flashes with each exchange event so activity, not static glow, carries
  // the port's presence. Alpha-only; skipped under reduced motion.
  const surge = glow(pad.x, pad.y, 100, PALETTE.cyan, 0);
  surge.alpha = 0;
  root.addChild(surge);
  let surgeTween: gsap.core.Tween | null = null;
  const surgePulse = (color: number, strength: number): void => {
    if (ctx.reducedMotion) return;
    surge.tint = color;
    surgeTween?.kill();
    surgeTween = gsap.fromTo(
      surge,
      { alpha: strength },
      { alpha: 0, duration: 0.8, ease: "power2.out" },
    );
  };

  // Receipt exits: the pale ack slip leaves toward the execution gateway; the
  // folded state packet leaves toward the reconciliation dock. Both fade
  // after ~95 units; the rails carry the traffic onward.
  const exitToward = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    dist: number,
  ): { x: number; y: number } => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: from.x + (dx / len) * dist, y: from.y + (dy / len) * dist };
  };
  const ACK_EXIT = exitToward(pad, STATIONS.executionGateway.anchor, 95);
  const STATE_EXIT = exitToward(pad, STATIONS.reconciliationDock.anchor, 100);

  let orderTL: gsap.core.Timeline | null = null;
  let ackTL: gsap.core.Timeline | null = null;
  let fillTL: gsap.core.Timeline | null = null;
  let stateTL: gsap.core.Timeline | null = null;
  let flipDelay: gsap.core.Tween | null = null;
  let ambientDelay: gsap.core.Tween | null = null;
  let flipIdx = 0;

  const api: HyperliquidApi = {
    exchangeEvent(kind) {
      switch (kind) {
        case "order": {
          surgePulse(PALETTE.orange, 0.55);
          orderTL?.kill();
          settle.alpha = 0;
          orderTL = gsap
            .timeline()
            .fromTo(
              capsule,
              { alpha: 0.95, x: pad.x, y: pad.y - 78 },
              { y: pad.y - 4, duration: 0.55, ease: "power2.in" },
            )
            .fromTo(
              settle,
              { alpha: 0.9, x: pad.x, y: pad.y, scale: 0.5 },
              { alpha: 0, scale: 1.6, duration: 0.5, ease: "power2.out" },
              "-=0.05",
            )
            .to(capsule, { alpha: 0, duration: 0.3, ease: "power1.out" }, "-=0.35");
          break;
        }
        case "ack": {
          surgePulse(PALETTE.cyan, 0.45);
          ackTL?.kill();
          ackTL = gsap
            .timeline()
            .fromTo(
              ackRing,
              { alpha: 0.9, scale: 0.4 },
              { alpha: 0, scale: 2, duration: 0.7, ease: "power2.out" },
            )
            // Pale slip rises from the pad...
            .fromTo(
              slip,
              { alpha: 0, x: pad.x, y: pad.y - 8 },
              { alpha: 0.95, y: pad.y - 30, duration: 0.35, ease: "power2.out" },
              0,
            )
            // ...then slides toward the gateway rail and fades.
            .to(slip, { x: ACK_EXIT.x, y: ACK_EXIT.y - 20, duration: 0.7, ease: "power1.inOut" })
            .to(slip, { alpha: 0, duration: 0.25 }, "-=0.15");
          break;
        }
        case "fill": {
          surgePulse(PALETTE.healthy, 0.45);
          fillTL?.kill();
          fillTL = gsap
            .timeline()
            .fromTo(
              tick,
              { alpha: 0, y: ring.y - 26 },
              { alpha: 1, y: ring.y - 34, duration: 0.3, ease: "power2.out" },
            )
            .to(tick, { alpha: 0, duration: 0.4, ease: "power1.in" }, "+=0.35");
          // One order-book level flips to filled, then settles back.
          const b = blocks[flipIdx % blocks.length];
          flipIdx++;
          if (b) {
            paintBlock(b.g, true);
            b.g.alpha = 1;
            flipDelay?.kill();
            flipDelay = gsap.to(b.g, { alpha: 0.55, duration: 1.6, delay: 1, ease: "power1.in" });
          }
          break;
        }
        case "state": {
          stateTL?.kill();
          stateTL = gsap
            .timeline()
            // Sheet materializes above the booth...
            .fromTo(
              sheet,
              { alpha: 0, x: ring.x + 8, y: ring.y - 72 },
              { alpha: 1, duration: 0.35, ease: "power1.out" },
            )
            // ...folds into a small aqua packet...
            .to(sheet.scale, { y: 0.25, duration: 0.3, ease: "power2.in" })
            .to(sheet, { alpha: 0, duration: 0.15 })
            .fromTo(
              packet,
              { alpha: 0, x: ring.x + 8, y: ring.y - 52 },
              { alpha: 1, duration: 0.15 },
              "<",
            )
            // ...and drifts out toward the reconciliation rail.
            .to(packet, { x: STATE_EXIT.x, y: STATE_EXIT.y, duration: 0.9, ease: "power1.inOut" })
            .to(packet, { alpha: 0, duration: 0.25 });
          break;
        }
      }
    },
  };

  // --- Signage: the tier-0 board plus the exchange-owned honesty details,
  // all through the signs system (never text inside graphics).
  ctx.layers.labels.addChild(
    makeSign(def.label, {
      x,
      y: y - 140,
      size: def.signSize,
      accent: PALETTE.aqua,
      lod: def.lod,
      stationId: def.id,
    }),
  );
  ctx.layers.labels.addChild(
    makeDetailText("AUTHORITATIVE EXCHANGE", {
      x,
      y: y - 112,
      stationId: def.id,
      size: 11,
      color: PALETTE.aqua,
    }),
  );
  ctx.layers.labels.addChild(
    makeDetailText("Simulated feed", { x, y: y - 97, stationId: def.id, size: 9 }),
  );
  ctx.layers.labels.addChild(
    makeDetailText("Open on Hyperliquid", { x, y: y - 84, stationId: def.id, size: 9 }),
  );

  // --- Registration: like every station, with the frozen api on the handle.
  const hit = new Container();
  const hitBox = new Graphics();
  hitBox.rect(x - def.size.w / 2, y - def.size.d / 2, def.size.w, def.size.d);
  hitBox.fill({ color: 0xffffff, alpha: 0.001 });
  hit.addChild(hitBox);
  hit.eventMode = "static";
  hit.cursor = "pointer";
  root.addChild(hit);
  registerStation({ id: def.id, root, hit, api });

  // --- Shared slow loops: ring rotation + ambient book flip. No bob, no
  // drifting shards: the booth is docked, not floating. Wall-clock time is
  // accumulated per tick; elapsedMS is a frame delta, not a clock.
  let lastFlip = performance.now();
  let lastT = lastFlip;
  const un = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const now = performance.now();
    ring.rotation += ((now - lastT) / 40000) * Math.PI * 2;
    lastT = now;
    if (now - lastFlip >= 5000) {
      lastFlip = now;
      const b = blocks[flipIdx % blocks.length];
      flipIdx++;
      if (b) {
        b.on = !b.on;
        paintBlock(b.g, b.on);
        ambientDelay?.kill();
        ambientDelay = gsap.fromTo(
          b.g,
          { alpha: 1 },
          { alpha: b.on ? 1 : 0.45, duration: 0.5, ease: "power1.inOut" },
        );
      }
    }
  });
  ctx.onCleanup(un);

  ctx.onCleanup(() => {
    orderTL?.kill();
    ackTL?.kill();
    fillTL?.kill();
    stateTL?.kill();
    flipDelay?.kill();
    ambientDelay?.kill();
    surgeTween?.kill();
  });
}
