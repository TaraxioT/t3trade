/**
 * Pooled world-space character effects: comic marks, card bursts, rolling
 * props. Owner: agent system worker.
 *
 * Everything lives in ctx.layers.sortable with a zIndex derived from its
 * world y so effects sort with the actors (marks float high, cards and props
 * sit just above the agents at the same foot y). All glyphs are real Graphics
 * redrawn only at spawn time; tick paths allocate nothing. The module holder
 * (`agentFx.current`, set by createAgentFx) follows the world/perimeter.ts
 * holder pattern so agent.ts can emit marks without a context.
 */
import { Graphics } from "pixi.js";
import { gsap } from "gsap";
import type { DioramaContext } from "../core/context.js";
import { PALETTE } from "../config/palette.js";
import { DEPTH, seededRandom } from "../config/world.js";

export type MarkKind = "!" | "?" | "stars" | "droplet" | "puff";

export interface AgentFx {
  /** Comic mark above a world point; auto-fades ~1.1 s (static ~1 s reduced). */
  popMarkAt(x: number, y: number, kind: MarkKind): void;
  /** Cards burst outward, settle, twinkle, gather-fade; resolves ~2.2 s. */
  scatterCards(x: number, y: number, color: number, count: number): Promise<void>;
  /** Capsule prop rolls along points, wobbles to rest, fades; resolves at rest. */
  rollProp(
    x: number,
    y: number,
    color: number,
    points: { x: number; y: number }[],
    speed: number,
  ): Promise<void>;
}

/** Populated by createAgentFx; consumed by agent.ts and stories. */
export const agentFx = { current: null as AgentFx | null };

// Module-level delegating exports: stories call these directly; they forward
// to the instance createAgentFx installed (no-op / immediate resolve before
// the population system has built the pools).
export function popMarkAt(x: number, y: number, kind: MarkKind): void {
  agentFx.current?.popMarkAt(x, y, kind);
}

export function scatterCards(
  x: number,
  y: number,
  color: number,
  count: number,
): Promise<void> {
  return agentFx.current?.scatterCards(x, y, color, count) ?? Promise.resolve();
}

export function rollProp(
  x: number,
  y: number,
  color: number,
  points: { x: number; y: number }[],
  speed: number,
): Promise<void> {
  return agentFx.current?.rollProp(x, y, color, points, speed) ?? Promise.resolve();
}

const MARK_POOL = 12;
const CARD_POOL = 16;
const PROP_POOL = 3;

const MARK_TINT: Record<MarkKind, number> = {
  "!": PALETTE.blocked,
  "?": PALETTE.violet,
  stars: PALETTE.yellow,
  droplet: PALETTE.waiting,
  puff: PALETTE.inkDim,
};

/** One pooled mark glyph. Redrawn only on spawn, never per frame. */
interface MarkSlot {
  g: Graphics;
  tween: gsap.core.Tween | gsap.core.Timeline | null;
}

interface CardSlot {
  g: Graphics;
}

interface PropSlot {
  g: Graphics;
}

function drawMarkGlyph(g: Graphics, kind: MarkKind, color: number): void {
  g.clear();
  g.removeChildren();
  switch (kind) {
    case "!": {
      g.roundRect(-2.6, -16, 5.2, 11, 2.4);
      g.fill({ color });
      g.circle(0, -1.5, 2.8);
      g.fill({ color });
      break;
    }
    case "?": {
      g.arc(0, -10, 6, Math.PI * 0.9, Math.PI * 2.15);
      g.stroke({ width: 3.4, color });
      g.circle(0, -1.5, 2.6);
      g.fill({ color });
      break;
    }
    case "stars": {
      for (const [sx, sy, s] of [
        [-7, -13, 1],
        [6, -15, 0.8],
        [0, -6, 0.65],
      ] as const) {
        g.star(sx, sy, 4, 4.5 * s, 1.8 * s);
        g.fill({ color });
      }
      break;
    }
    case "droplet": {
      g.moveTo(0, -17);
      g.quadraticCurveTo(7, -8, 0, -2);
      g.quadraticCurveTo(-7, -8, 0, -17);
      g.closePath();
      g.fill({ color });
      break;
    }
    case "puff": {
      for (const [cx, cy, r] of [
        [-6, -10, 4.5],
        [3, -13, 5.5],
        [7, -7, 3.8],
      ] as const) {
        g.circle(cx, cy, r);
        g.fill({ color, alpha: 0.55 });
      }
      break;
    }
  }
}

export function createAgentFx(ctx: DioramaContext): AgentFx {
  // Deterministic spread rng so bursts are varied but reproducible.
  const rng = seededRandom(4242);

  const marks: MarkSlot[] = [];
  const cards: CardSlot[] = [];
  const props: PropSlot[] = [];
  // Active multi-tween arcs (scatter/roll, plus reduced-motion fades); killed
  // as a group on cleanup, which also settles their pending promises.
  const arcs = new Set<gsap.core.Tween | gsap.core.Timeline>();

  // Pooled glyphs live directly in the sortable layer with a world-y zIndex so
  // they depth-sort with the actors instead of floating above the whole scene.
  for (let i = 0; i < MARK_POOL; i++) {
    const g = new Graphics();
    g.visible = false;
    ctx.layers.sortable.addChild(g);
    marks.push({ g, tween: null });
  }
  for (let i = 0; i < CARD_POOL; i++) {
    const g = new Graphics();
    g.roundRect(-5, -7, 10, 14, 2);
    g.fill({ color: PALETTE.cyan });
    g.roundRect(-5, -7, 10, 14, 2);
    g.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.9 });
    g.visible = false;
    ctx.layers.sortable.addChild(g);
    cards.push({ g });
  }
  for (let i = 0; i < PROP_POOL; i++) {
    const g = new Graphics();
    g.roundRect(-9, -7, 18, 14, 7);
    g.fill({ color: PALETTE.structureLight });
    g.roundRect(-9, -7, 18, 14, 7);
    g.stroke({ width: 1.2, color: PALETTE.surfacePale, alpha: 0.8 });
    g.moveTo(-4, -6);
    g.lineTo(-4, 6);
    g.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.9 });
    g.visible = false;
    ctx.layers.sortable.addChild(g);
    props.push({ g });
  }

  const releaseMark = (m: MarkSlot): void => {
    m.tween?.kill();
    m.tween = null;
    m.g.visible = false;
    m.g.alpha = 0;
  };

  const popMarkAt = (x: number, y: number, kind: MarkKind): void => {
    const slot = marks.find((m) => !m.g.visible);
    if (!slot) return; // pool exhausted: drop silently, never queue
    drawMarkGlyph(slot.g, kind, MARK_TINT[kind]);
    slot.g.position.set(x, y);
    slot.g.zIndex = y + DEPTH.overlay; // floaty: above local structures
    slot.g.scale.set(1);
    slot.g.alpha = 0.95;
    slot.g.visible = true;
    if (ctx.reducedMotion) {
      // Static mark, no motion, ~1 s hold.
      slot.tween = gsap.delayedCall(1, () => releaseMark(slot));
      return;
    }
    slot.tween = gsap
      .timeline()
      .fromTo(slot.g.scale, { x: 0.4, y: 0.4 }, { x: 1, y: 1, duration: 0.22, ease: "back.out(3)" })
      .to(slot.g, { y: y - 10, alpha: 0, duration: 0.85, ease: "power1.in" });
  };

  const scatterCards = (x: number, y: number, color: number, count: number): Promise<void> => {
    // Reserve only currently-hidden card slots: two concurrent bursts must
    // animate disjoint Graphics instead of overwriting each other's tweens.
    const freeCards = cards.filter((c) => !c.g.visible).map((c) => c.g);
    if (freeCards.length === 0) return Promise.resolve();
    const n = Math.max(1, Math.min(count, freeCards.length));
    // The promise settles on completion OR kill so an interrupted gag never
    // parks its awaiting story (whose locks must release in finally).
    let resolveDone: () => void = (): void => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let settled = false;
    const active: Graphics[] = [];
    const tl = gsap.timeline({
      onComplete: finish,
      onKill: finish,
    });
    arcs.add(tl);
    function finish(): void {
      if (settled) return;
      settled = true;
      active.forEach((g) => (g.visible = false));
      arcs.delete(tl);
      resolveDone();
    }
    for (let i = 0; i < n; i++) {
      const g = freeCards[i];
      active.push(g);
      g.tint = color;
      g.visible = true;
      g.alpha = 1;
      g.rotation = 0;
      g.position.set(x, y - 6);
      g.zIndex = y + 2; // just above agents at the same foot y
      if (ctx.reducedMotion) {
        // Static fan instead of a burst.
        g.position.set(x + (i - (n - 1) / 2) * 9, y - 8 - (i % 3) * 4);
        g.rotation = (i % 2 === 0 ? 1 : -1) * 0.15;
        continue;
      }
      const angle = -Math.PI / 2 + (rng() - 0.5) * Math.PI * 1.2;
      const dist = 18 + rng() * 34;
      const tx = x + Math.cos(angle) * dist;
      const peak = y - 16 - rng() * 20;
      const settleY = y - 2 + (rng() - 0.5) * 6;
      tl.to(
        g,
        { x: tx, duration: 0.5, ease: "power1.out" },
        0,
      );
      tl.to(g, { y: peak, duration: 0.22, ease: "power1.out" }, 0);
      tl.to(g, { y: settleY, duration: 0.34, ease: "bounce.out" }, 0.22);
      tl.to(g, { rotation: (rng() - 0.5) * 1.2, duration: 0.4, ease: "power1.out" }, 0);
    }
    if (ctx.reducedMotion) {
      // Static fan, brief fade so the beat still reads.
      tl.to(active, { alpha: 0, duration: 0.6, ease: "power1.in" }, 0.2);
    } else {
      // Twinkle in place, then gather-fade back toward the burst origin.
      tl.to(active, { alpha: 0.55, duration: 0.3, ease: "sine.inOut", yoyo: true, repeat: 1 }, 0.6);
      tl.to(
        active,
        {
          x,
          y: y - 10,
          alpha: 0,
          duration: 0.6,
          ease: "power2.in",
        },
        1.5,
      );
    }
    return done;
  };

  const rollProp = (
    x: number,
    y: number,
    color: number,
    points: { x: number; y: number }[],
    speed: number,
  ): Promise<void> => {
    const slot = props.find((p) => !p.g.visible);
    if (!slot) return Promise.resolve();
    const g = slot.g;
    g.tint = color;
    g.visible = true;
    g.alpha = 1;
    g.rotation = 0;
    g.zIndex = y + 2; // just above agents at the same foot y

    if (ctx.reducedMotion) {
      const last = points.length > 0 ? points[points.length - 1] : { x, y };
      g.position.set(last.x, last.y);
      return new Promise<void>((resolve) => {
        // Tracked in arcs so teardown kills it AND settles this promise.
        let settled = false;
        const fade = gsap.to(g, {
          alpha: 0,
          duration: 0.5,
          delay: 0.4,
          onComplete: () => {
            g.visible = false;
            settled = true;
            arcs.delete(fade);
            resolve();
          },
          onKill: () => {
            if (settled) return;
            settled = true;
            arcs.delete(fade);
            g.visible = false;
            resolve();
          },
        });
        arcs.add(fade);
      });
    }

    const RADIUS = 7; // glyph radius; rotation = travel / radius
    // Settles on completion OR kill so an interrupted chase never parks its
    // awaiting story.
    let resolveDone: () => void = (): void => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let settled = false;
    function finish(): void {
      if (settled) return;
      settled = true;
      g.visible = false;
      arcs.delete(tl);
      resolveDone();
    }
    const tl = gsap.timeline({
      onComplete: finish,
      onKill: finish,
    });
    arcs.add(tl);

    const from = { x, y };
    const state = { t: 0 };
    let travel = 0;
    for (const target of points) {
      const dx = target.x - from.x;
      const dy = target.y - from.y;
      const dist = Math.hypot(dx, dy);
      const start = { x: from.x, y: from.y };
      const startTravel = travel;
      if (dist < 0.5) continue;
      const duration = Math.max(dist / Math.max(speed, 1), 0.05);
      tl.to(
        state,
        {
          t: 1,
          duration,
          ease: "none",
          onUpdate: () => {
            g.x = start.x + dx * state.t;
            g.y = start.y + dy * state.t;
            g.zIndex = g.y + 2;
            g.rotation = (startTravel + dist * state.t) / RADIUS;
          },
        },
      );
      travel += dist;
      from.x = target.x;
      from.y = target.y;
      state.t = 0;
    }
    // Wobble to rest, then fade out.
    tl.to(g, { rotation: `+=${0.3}`, duration: 0.18, ease: "sine.inOut", yoyo: true, repeat: 3 });
    tl.to(g, { alpha: 0, duration: 0.45, ease: "power1.in" });
    tl.add(() => {
      g.visible = false;
    });

    return done;
  };

  const api: AgentFx = { popMarkAt, scatterCards, rollProp };
  agentFx.current = api;

  ctx.onCleanup(() => {
    for (const m of marks) {
      releaseMark(m);
      gsap.killTweensOf(m.g);
      m.g.destroy();
    }
    for (const a of arcs) a.kill();
    arcs.clear();
    for (const c of cards) {
      gsap.killTweensOf(c.g);
      c.g.destroy();
    }
    for (const p of props) {
      gsap.killTweensOf(p.g);
      p.g.destroy();
    }
    if (agentFx.current === api) agentFx.current = null;
  });

  return api;
}
