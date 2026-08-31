/**
 * Observatory: chart lines, candle refreshes and EMA ticks at offset
 * cycles — never synced (spec §23). Telescopes slew occasionally and the
 * analyst peers and notes. Research works here with no signer involved.
 */
import gsap from "gsap";
import { Graphics, Sprite } from "pixi.js";
import type { DioramaContext, DirectorEvent } from "../types";
import { pctPoint } from "../config/positions";
import type { Pt } from "../config/positions";
import { makeProp } from "./util";

const MONITORS: Array<{ at: Pt; phase: number; color: number }> = [
  { at: pctPoint(59, 54), phase: 0, color: 0x3dd6c4 },
  { at: pctPoint(62.5, 53), phase: 2.1, color: 0x5bb974 },
  { at: pctPoint(66, 54), phase: 4.4, color: 0x8ac5d9 },
];
// Round 4: pier bases MEASURED from the plate (vision boxes): three
// floor-standing telescopes at x67.6-73.3, y58.9-62.3 — the painted props
// now sit on the real piers instead of floating on the railing deck.
const TELESCOPES = [pctPoint(68.1, 60.1), pctPoint(71.3, 61.2), pctPoint(72.85, 59.6)];

export class ObservatorySystem {
  private charts: Array<{ g: Graphics; seed: number; phase: number; color: number; at: Pt }> = [];
  private scopes: Sprite[] = [];

  constructor(private ctx: DioramaContext) {
    for (const m of MONITORS) {
      const g = new Graphics();
      g.position.set(m.at.x, m.at.y);
      g.zIndex = 36;
      ctx.layers.machineFX.addChild(g);
      this.charts.push({ g, seed: Math.random() * 100, phase: m.phase, color: m.color, at: m.at });
    }
    for (const at of TELESCOPES) {
      // Painted iso telescope (scope + spotter), pivoting at its base.
      const g = makeProp(ctx, "telescope", at);
      g.anchor.set(0.5, 1);
      g.zIndex = 36;
      ctx.layers.machineFX.addChild(g);
      this.scopes.push(g);
      // Idle slew: each telescope drifts on its own slow cycle.
      gsap.to(g, {
        rotation: gsap.utils.random(-0.3, 0.3),
        duration: gsap.utils.random(4, 9),
        delay: Math.random() * 6,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
      });
    }
  }

  /** Chart refresh on offset cycles (called from the world ticker). */
  update(elapsed: number): void {
    for (const chart of this.charts) {
      const period = 2.6;
      if (
        Math.sin(((elapsed + chart.phase) / period) * Math.PI) > 0.985 ||
        chart.g.children.length === 0
      ) {
        this.redraw(chart, elapsed);
      }
    }
  }

  private redraw(chart: { g: Graphics; seed: number; color: number; at: Pt }, t: number): void {
    const g = chart.g;
    g.clear();
    const w = 58;
    const h = 30;
    g.roundRect(-w / 2 - 3, -h - 3, w + 6, h + 6, 3)
      .fill({ color: 0x0a0f14, alpha: 0.85 })
      .stroke({ color: 0x2a384c, width: 1 });
    // Price line
    g.moveTo(-w / 2, -h / 2);
    for (let i = 0; i <= 10; i++) {
      const f = i / 10;
      const y = -h / 2 - Math.sin(f * 5 + chart.seed + t * 0.2) * h * 0.32 - h * 0.2 * f;
      g.lineTo(-w / 2 + f * w, y);
    }
    g.stroke({ width: 1.6, color: chart.color, alpha: 0.9 });
    // A couple of candles
    for (let i = 0; i < 4; i++) {
      const cx = -w / 2 + 8 + i * 13;
      const ch = 5 + Math.abs(Math.sin(chart.seed + i + t * 0.4)) * 12;
      g.rect(cx, -6 - ch / 2, 5, ch).fill({ color: chart.color, alpha: 0.35 });
    }
  }

  wake(): void {
    for (const chart of this.charts) {
      gsap.fromTo(chart.g, { alpha: 0.2 }, { alpha: 1, duration: 0.8, ease: "power2.out" });
    }
    this.ctx.audio.play("ping", "mechanical", this.charts[0]?.at ?? { x: 0, y: 0 });
  }

  event(): DirectorEvent {
    return {
      id: "observatory.notes",
      zone: "observatory",
      actors: 1,
      actorKind: "any",
      priority: 3,
      cooldownSec: 10,
      minIntervalSec: 16,
      maxIntervalSec: 40,
      weight: 5,
      reducedMotionOk: true,
      soundCategory: "mechanical",
      run: (c, agents) => {
        const watcher = c.agents.find((a) => a.id === "s4") ?? agents[0];
        watcher?.tiltHead();
        const target = TELESCOPES[Math.floor(Math.random() * TELESCOPES.length)];
        const scope = this.scopes[TELESCOPES.indexOf(target)];
        if (scope) {
          gsap.to(scope, {
            rotation: gsap.utils.random(-0.4, 0.4),
            duration: 0.9,
            ease: "power2.inOut",
          });
          c.audio.play("scan", "mechanical", target);
        }
        gsap.delayedCall(1.2, () => watcher?.type());
        return 5;
      },
    };
  }
}
