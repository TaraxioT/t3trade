/**
 * Budget Desk: a readout ticks continuously, a clerk checks the ledger,
 * and the new-exposure gate occasionally closes. Invariant: the protected
 * position tags keep pulsing no matter what — protection never visually
 * disappears (spec §21).
 */
import gsap from "gsap";
import { Graphics, Sprite } from "pixi.js";
import type { DioramaContext, DirectorEvent } from "../types";
import { pctPoint } from "../config/positions";
import { flashAt, makeProp, makeReadout } from "./util";
import type { ReadoutChip } from "./util";

const READOUT = pctPoint(8, 46);
const GATE = pctPoint(9, 56);

export class BudgetSystem {
  private tags: Sprite[] = [];
  private readout: ReadoutChip;
  private gate: Graphics;
  private value = 1875;

  constructor(ctx: DioramaContext) {
    // Protected-position tags: painted reduce-only-tag props ("RO" and the
    // down-arrow are baked in) that pulse forever — protection never
    // visually disappears, whatever the gate does.
    const tagSpots = [pctPoint(4, 57), pctPoint(7, 59), pctPoint(11, 58)];
    for (const at of tagSpots) {
      const tag = makeProp(ctx, "reduce-only-tag", at);
      tag.zIndex = 38;
      ctx.layers.machineFX.addChild(tag);
      this.tags.push(tag);
    }
    this.readout = makeReadout(ctx, READOUT, "BUDGET 1875", "#5bb974");

    this.gate = new Graphics();
    this.gate.roundRect(-46, -3, 92, 6, 3).fill({ color: 0xff7a45, alpha: 0.9 });
    this.gate.position.set(GATE.x, GATE.y - 26);
    this.gate.zIndex = 38;
    ctx.layers.machineFX.addChild(this.gate);
    this.gate.scale.y = 0.2;

    // The readout ticks on its own desynced cadence.
    const tick = (): void => {
      this.value = Math.max(120, this.value + Math.round(gsap.utils.random(-14, 9)));
      this.readout.setText(`BUDGET ${this.value}`);
      gsap.delayedCall(gsap.utils.random(1.2, 3.4), tick);
    };
    gsap.delayedCall(2, tick);
  }

  /** Called every frame; owns the eternal protected-tag pulse. */
  update(elapsed: number): void {
    for (let i = 0; i < this.tags.length; i++) {
      const s = 0.5 + 0.5 * Math.sin(elapsed * 2.4 + i * 1.9);
      this.tags[i].alpha = 0.55 + 0.45 * s;
    }
  }

  event(): DirectorEvent {
    return {
      id: "budget.gate",
      zone: "budget",
      actors: 1,
      actorKind: "wanderer",
      priority: 5,
      cooldownSec: 20,
      minIntervalSec: 25,
      maxIntervalSec: 70,
      weight: 4,
      reducedMotionOk: true,
      soundCategory: "mechanical",
      run: (ctx, agents) => {
        const clerk = ctx.agents.find((a) => a.id === "c5") ?? agents[0];
        ctx.audio.play("lever", "mechanical", GATE);
        // New-exposure gate closes...
        gsap.to(this.gate, { scaleY: 1, duration: 0.6, ease: "power2.out" });
        flashAt(ctx, GATE, 0xff7a45, 16, 0.5);
        clerk?.type();
        gsap.delayedCall(1.4, () => {
          ctx.bubbles.show("✓", { x: clerk.x, y: clerk.headTop });
          // ...and reopens. The protected tags never stopped pulsing.
          ctx.audio.play("lever", "mechanical", GATE);
          gsap.to(this.gate, { scaleY: 0.2, duration: 0.6, ease: "power2.in" });
        });
        return 5.5;
      },
    };
  }
}
