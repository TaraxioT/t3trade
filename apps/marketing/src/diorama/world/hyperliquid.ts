/**
 * External Hyperliquid Testnet platform: a floating slab in a deliberately
 * different material language (pale cool top, aqua trim, dark edge) so it
 * reads as foreign and authoritative next to the campus, with an order-book
 * sculpture, a slow rotating trade ring, a landing pad where the exchange
 * tunnel arrives, and short pooled event animations. Not a registered
 * station: the interaction layer wires the exported holder specially.
 * Owner: hyperliquid worker.
 */
import { Container, Graphics, Polygon, Text, TextStyle } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { glow, isoBox } from "../core/iso.js";
import { makeSign } from "../core/signs.js";
import { PALETTE } from "../config/palette.js";
import { HYPERLIQUID } from "../config/geometry.js";
import { seededRandom, DEPTH } from "../config/world.js";

export interface HyperliquidApi {
  /** Animate: order received, acknowledged, filled, state update. */
  exchangeEvent(kind: "order" | "ack" | "fill" | "state"): void;
}

/** Populated by buildHyperliquid; consumed by the director/stories/interaction. */
export const hyperliquid = { api: null as HyperliquidApi | null, root: null as Container | null };

const { cx, cy, w, d } = HYPERLIQUID;
const HW = w / 2;
const HD = d / 2;
const SLAB_H = 22;
const TOP = cy - SLAB_H;
/** Landing pad on the west face, aligned with the east tunnel (cy 1140). */
const PAD = { x: cx - HW + 55, y: 1132 };
/** West drift target: the tunnel mouth where slips and packets exit. */
const MOUTH = { x: cx - HW - 42, y: 1142 };
const BANNER_Y = cy - HD - 80;

/** One pale order-book block; redrawn only when its state flips. */
function bookBlock(x: number, y: number, on: boolean): Graphics {
  const g = new Graphics();
  g.position.set(x, y);
  paintBlock(g, on);
  return g;
}

function paintBlock(g: Graphics, on: boolean): void {
  g.clear();
  g.rect(-4.5, -3.5, 9, 7);
  g.fill({ color: PALETTE.surfacePale, alpha: on ? 0.85 : 0.3 });
  g.rect(-4.5, -3.5, 9, 7);
  g.stroke({ width: 0.75, color: PALETTE.aqua, alpha: on ? 0.5 : 0.2 });
}

export function buildHyperliquid(ctx: DioramaContext): void {
  const root = new Container();
  root.zIndex = cy + DEPTH.base;
  root.eventMode = "static";
  root.cursor = "pointer";
  root.hitArea = new Polygon([cx - HW, TOP, cx, cy + HD - SLAB_H, cx + HW, TOP, cx, cy - HD - SLAB_H]);

  // --- Slab: foreign material, pale cool top with aqua trim -----------------
  const slab = new Graphics();
  slab.poly([cx - HW, cy, cx, cy + HD, cx, cy + HD - SLAB_H, cx - HW, cy - SLAB_H]);
  slab.fill({ color: PALETTE.structureLight });
  slab.poly([cx + HW, cy, cx, cy + HD, cx, cy + HD - SLAB_H, cx + HW, cy - SLAB_H]);
  slab.fill({ color: PALETTE.spaceAlt });
  slab.poly([cx - HW, TOP, cx, cy + HD - SLAB_H, cx + HW, TOP, cx, cy - HD - SLAB_H]);
  slab.fill({ color: PALETTE.surfacePale, alpha: 0.88 });
  slab.poly([cx - HW, TOP, cx, cy + HD - SLAB_H, cx + HW, TOP, cx, cy - HD - SLAB_H]);
  slab.stroke({ width: 1.5, color: PALETTE.aqua, alpha: 0.85 });
  root.addChild(slab);
  // Underglow: floats slightly apart from the campus island.
  root.addChild(glow(cx, cy + HD * 0.55, 520, PALETTE.aqua, 0.2));

  // --- Floating rock fragments: small iso shards drifting very slowly ------
  // Static geometry; the one shared onTick below offsets their y by a few
  // units over a 30 s loop (fully static under reduced motion).
  const shardBase = [
    { x: cx - 168, y: cy + 92, w: 30, d: 16, h: 18, p: 0 },
    { x: cx + 148, y: cy - 78, w: 22, d: 12, h: 14, p: 2 },
    { x: cx + 132, y: cy + 168, w: 26, d: 14, h: 16, p: 4 },
  ] as const;
  const shards = shardBase.map((s) => {
    const box = isoBox({
      x: s.x,
      y: s.y,
      w: s.w,
      d: s.d,
      h: s.h,
      color: PALETTE.structureLight,
      rim: PALETTE.aqua,
      rimAlpha: 0.5,
    });
    root.addChild(box);
    return { box, y0: s.y, p: s.p };
  });

  // --- Banner on two slim posts rising from the platform ---------------------
  const posts = new Graphics();
  for (const px of [cx - 58, cx + 58]) {
    posts.moveTo(px, cy - HD + 26);
    posts.lineTo(px, BANNER_Y + 16);
    posts.stroke({ width: 2.5, color: PALETTE.structureLight });
    posts.moveTo(px, cy - HD + 26);
    posts.lineTo(px, BANNER_Y + 16);
    posts.stroke({ width: 1, color: PALETTE.aqua, alpha: 0.9 });
  }
  root.addChild(posts);
  for (const px of [cx - 58, cx + 58]) {
    root.addChild(glow(px, BANNER_Y + 12, 18, PALETTE.aqua, 0.5));
  }
  // Stacked two-line sign: a single xl-width banner would run past the world
  // edge at this x, so the name breaks over two lg boards with one sub line.
  const sign1 = makeSign("HYPERLIQUID", { x: cx, y: BANNER_Y - 16, size: "lg", accent: PALETTE.aqua });
  const sign2 = makeSign("TESTNET", { x: cx, y: BANNER_Y + 22, size: "lg", accent: PALETTE.aqua });
  const sub = new Text({
    text: "AUTHORITATIVE EXCHANGE",
    style: new TextStyle({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 14,
      fontWeight: "500",
      letterSpacing: 2,
      fill: 0xa8c0cf,
    }),
  });
  sub.resolution = 2;
  sub.anchor.set(0.5);
  sub.position.set(cx, BANNER_Y + 60);
  sign1.zIndex = cy + DEPTH.overlay;
  sign2.zIndex = cy + DEPTH.overlay;
  ctx.layers.labels.addChild(sign1, sign2, sub);

  // --- Order-book wall sculpture (east side) ---------------------------------
  const book = new Container();
  book.position.set(cx + 46, cy - 22);
  const rnd = seededRandom(5);
  const blocks: Array<{ g: Graphics; on: boolean }> = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 6; col++) {
      if (rnd() < 0.2) continue; // missing levels
      const b = { g: bookBlock(-32 + col * 13, 20 - row * 10, true), on: true };
      blocks.push(b);
      book.addChild(b.g);
    }
  }
  root.addChild(book);

  // --- Rotating hexagonal trade ring (center, additive aqua) -----------------
  const ring = new Graphics();
  ring.position.set(cx - 8, TOP - 8);
  const hexPts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    hexPts.push(Math.cos(a) * 36, Math.sin(a) * 20);
  }
  ring.poly(hexPts);
  ring.stroke({ width: 2, color: PALETTE.aqua, alpha: 0.85 });
  ring.circle(0, 0, 3);
  ring.fill({ color: PALETTE.cyan, alpha: 0.9 });
  ring.blendMode = "add";
  root.addChild(ring);

  // --- Landing pad: cyan target ring + two guide lights ----------------------
  const pad = new Graphics();
  pad.ellipse(PAD.x, PAD.y, 30, 15);
  pad.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.9 });
  pad.ellipse(PAD.x, PAD.y, 16, 8);
  pad.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.55 });
  pad.ellipse(PAD.x, PAD.y, 3.5, 1.8);
  pad.fill({ color: PALETTE.aqua, alpha: 0.9 });
  root.addChild(pad);
  const guideL = glow(PAD.x - 40, PAD.y - 12, 26, PALETTE.cyan, 0.7);
  const guideR = glow(PAD.x + 40, PAD.y - 12, 26, PALETTE.cyan, 0.7);
  root.addChild(guideL, guideR);

  // --- External clerk glyph: rotating cube pedestal near the pad -------------
  root.addChild(
    isoBox({ x: cx - 26, y: PAD.y - 34, w: 16, d: 9, h: 10, color: PALETTE.structureLight, rim: PALETTE.aqua }),
  );
  const clerkCube = new Graphics();
  clerkCube.position.set(cx - 26, PAD.y - 52);
  clerkCube.rect(-5, -5, 10, 10);
  clerkCube.stroke({ width: 1.5, color: PALETTE.aqua, alpha: 0.9 });
  clerkCube.rect(-2.5, -2.5, 5, 5);
  clerkCube.fill({ color: PALETTE.aqua, alpha: 0.45 });
  root.addChild(clerkCube);

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
  ackRing.position.set(PAD.x, PAD.y);
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
  tick.position.set(ring.x, ring.y - 34);
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

  let orderTL: gsap.core.Timeline | null = null;
  let ackTL: gsap.core.Timeline | null = null;
  let fillTL: gsap.core.Timeline | null = null;
  let stateTL: gsap.core.Timeline | null = null;
  let flipDelay: gsap.core.Tween | null = null;
  let ambientDelay: gsap.core.Tween | null = null;
  let flipIdx = 0;

  hyperliquid.api = {
    exchangeEvent(kind) {
      switch (kind) {
        case "order": {
          orderTL?.kill();
          settle.alpha = 0;
          orderTL = gsap
            .timeline()
            .fromTo(
              capsule,
              { alpha: 0.95, x: PAD.x, y: PAD.y - 95 },
              { y: PAD.y - 5, duration: 0.55, ease: "power2.in" },
            )
            .fromTo(
              settle,
              { alpha: 0.9, x: PAD.x, y: PAD.y, scale: 0.5 },
              { alpha: 0, scale: 1.6, duration: 0.5, ease: "power2.out" },
              "-=0.05",
            )
            .to(capsule, { alpha: 0, duration: 0.3, ease: "power1.out" }, "-=0.35");
          break;
        }
        case "ack": {
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
              { alpha: 0, x: PAD.x, y: PAD.y - 8 },
              { alpha: 0.95, y: PAD.y - 30, duration: 0.35, ease: "power2.out" },
              0,
            )
            // ...then slides west toward the tunnel mouth and fades.
            .to(slip, { x: MOUTH.x, y: MOUTH.y - 24, duration: 0.7, ease: "power1.inOut" })
            .to(slip, { alpha: 0, duration: 0.25 }, "-=0.15");
          break;
        }
        case "fill": {
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
            // Sheet materializes above the platform...
            .fromTo(
              sheet,
              { alpha: 0, x: cx + 6, y: TOP - 150, scale: 1 },
              { alpha: 1, duration: 0.35, ease: "power1.out" },
            )
            // ...folds into a small aqua packet...
            .to(sheet, { scaleY: 0.25, duration: 0.3, ease: "power2.in" })
            .to(sheet, { alpha: 0, duration: 0.15 })
            .fromTo(
              packet,
              { alpha: 0, x: cx + 6, y: TOP - 120 },
              { alpha: 1, duration: 0.15 },
              "<",
            )
            // ...and drifts west to the tunnel mouth (exchangeStateReturn).
            .to(packet, { x: MOUTH.x, y: MOUTH.y - 30, duration: 0.9, ease: "power1.inOut" })
            .to(packet, { alpha: 0, duration: 0.25 });
          break;
        }
      }
    },
  };

  // --- Shared slow loops: banner bob, ring rotation, ambient book flip -------
  let lastFlip = 0;
  const un = ctx.onTick((ticker) => {
    const t = ticker.elapsedMS;
    if (!ctx.reducedMotion) {
      const bob = Math.sin((t / 6000) * Math.PI * 2) * 4;
      sign1.y = BANNER_Y - 16 + bob;
      sign2.y = BANNER_Y + 22 + bob;
      sub.y = BANNER_Y + 60 + bob;
      ring.rotation = (t / 40000) * Math.PI * 2;
      clerkCube.rotation = (t / 8000) * Math.PI * 2;
      // Very slow shard drift: 30 s loop, a few units of vertical bob.
      for (const s of shards) {
        s.box.y = s.y0 + Math.sin(((t + s.p * 5000) / 30000) * Math.PI * 2) * 5;
      }
      if (t - lastFlip >= 5000) {
        lastFlip = t;
        const b = blocks[flipIdx % blocks.length];
        flipIdx++;
        if (b) {
          b.on = !b.on;
          paintBlock(b.g, b.on);
          ambientDelay?.kill();
          ambientDelay = gsap.fromTo(b.g, { alpha: 1 }, { alpha: b.on ? 1 : 0.45, duration: 0.5, ease: "power1.inOut" });
        }
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
    hyperliquid.api = null;
    hyperliquid.root = null;
  });

  hyperliquid.root = root;
  ctx.layers.sortable.addChild(root);
}
