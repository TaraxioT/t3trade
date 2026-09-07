/**
 * Authority seam (dio-3 R6): a subtle static gold floor inlay along the
 * center<->east section boundary polyline, plus pulseSeam(), a one-shot
 * emissive sweep played when the human's approval binds. Floor inlay only:
 * no wall, no barrier. The east lane's approval api and the story call layer
 * on top of pulseSeam(); the polyline matches the frozen floor/risk section
 * boundary in config/geometry.ts.
 * Owner: room-world lane.
 */
import { Container, Graphics } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { glow } from "../core/iso.js";
import { PALETTE } from "../config/palette.js";

/** The seam polyline: seam-top on the N-E wall base down to the south. */
const SEAM: ReadonlyArray<{ x: number; y: number }> = [
  { x: 1750, y: 309 },
  { x: 1750, y: 950 },
  { x: 1520, y: 1340 },
];
/** Half-gap of the static double line. */
const LINE_GAP = 4.5;

/** Segment lengths and total length, used to parametrize the sweep head. */
const SEG_LENS = SEAM.slice(1).map((p, i) => Math.hypot(p.x - SEAM[i].x, p.y - SEAM[i].y));
const TOTAL_LEN = SEG_LENS.reduce((a, b) => a + b, 0);

interface PulseLayer {
  line: Graphics;
  head: Container;
  timeline: gsap.core.Timeline | null;
  reducedMotion: boolean;
}

/** Live pulse layer; null when the seam is not built (pulseSeam no-ops). */
let pulse: PulseLayer | null = null;

function pointAt(distance: number): { x: number; y: number } {
  let d = Math.max(0, Math.min(TOTAL_LEN, distance));
  for (let i = 0; i < SEG_LENS.length; i++) {
    if (d <= SEG_LENS[i] || i === SEG_LENS.length - 1) {
      const t = SEG_LENS[i] > 0 ? d / SEG_LENS[i] : 0;
      return {
        x: SEAM[i].x + (SEAM[i + 1].x - SEAM[i].x) * t,
        y: SEAM[i].y + (SEAM[i + 1].y - SEAM[i].y) * t,
      };
    }
    d -= SEG_LENS[i];
  }
  return { ...SEAM[SEAM.length - 1] };
}

export function buildSeam(ctx: DioramaContext): void {
  const root = new Container();

  // Static double line in a restrained authority tone (gold at low alpha).
  const g = new Graphics();
  for (let i = 0; i < SEAM.length - 1; i++) {
    const a = SEAM[i];
    const b = SEAM[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / len) * LINE_GAP;
    const ny = ((b.x - a.x) / len) * LINE_GAP;
    for (const s of [1, -1]) {
      g.moveTo(a.x + nx * s, a.y + ny * s);
      g.lineTo(b.x + nx * s, b.y + ny * s);
      g.stroke({ width: 1.2, color: PALETTE.yellow, alpha: 0.2, cap: "round" });
    }
  }
  // Quiet endpoint ticks anchor the inlay without reading as a barrier.
  for (const p of [SEAM[0], SEAM[SEAM.length - 1]]) {
    g.poly([p.x, p.y - 5, p.x + 8, p.y, p.x, p.y + 5, p.x - 8, p.y]);
    g.stroke({ width: 1, color: PALETTE.yellow, alpha: 0.3 });
  }
  root.addChild(g);

  // One-shot sweep layer: an additive line wash plus a traveling glow head.
  const line = new Graphics();
  line.moveTo(SEAM[0].x, SEAM[0].y);
  for (let i = 1; i < SEAM.length; i++) line.lineTo(SEAM[i].x, SEAM[i].y);
  line.stroke({ width: 2.2, color: PALETTE.yellow, alpha: 0 });
  line.blendMode = "add";

  const head = new Container();
  head.addChild(glow(0, 0, 46, PALETTE.yellow, 0.9));
  head.alpha = 0;
  const start = pointAt(0);
  head.position.set(start.x, start.y);

  root.addChild(line);
  root.addChild(head);
  ctx.layers.ground.addChild(root);

  pulse = { line, head, timeline: null, reducedMotion: ctx.reducedMotion };
  ctx.onCleanup(() => {
    pulse?.timeline?.kill();
    pulse = null;
  });
}

/**
 * Play the one-shot authority pulse along the seam (replays safely if called
 * again mid-sweep). Reduced motion snaps to a brief alpha flash instead of
 * the traveling head. No-op until buildSeam has run.
 */
export function pulseSeam(): void {
  if (!pulse) return;
  pulse.timeline?.kill();
  const { line, head, reducedMotion } = pulse;

  if (reducedMotion) {
    const tl = gsap.timeline();
    tl.fromTo(line, { alpha: 0 }, { alpha: 0.55, duration: 0.12, ease: "power2.out" });
    tl.to(line, { alpha: 0, duration: 0.35, ease: "power2.in" });
    pulse.timeline = tl;
    return;
  }

  const state = { d: 0 };
  const tl = gsap.timeline({
    onUpdate: () => {
      const p = pointAt(state.d);
      head.position.set(p.x, p.y);
    },
  });
  tl.fromTo(line, { alpha: 0 }, { alpha: 0.4, duration: 0.15, ease: "power2.out" }, 0);
  tl.fromTo(head, { alpha: 0 }, { alpha: 0.95, duration: 0.12, ease: "power2.out" }, 0);
  tl.to(state, { d: TOTAL_LEN, duration: 1.1, ease: "power1.inOut" }, 0);
  tl.to(head, { alpha: 0, duration: 0.3, ease: "power2.in" }, 0.85);
  tl.to(line, { alpha: 0, duration: 0.45, ease: "power2.in" }, 0.75);
  pulse.timeline = tl;
}
