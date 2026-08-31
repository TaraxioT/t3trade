/**
 * Reconciliation Ferry: the little tugboat departs the Bureau, checks the
 * exchange, and returns; the Bureau-side ledger then visibly updates to
 * the exchange-side value — never the other way (spec §28). The exchange
 * is authoritative.
 */
import gsap from "gsap";
import { Container, Graphics, Sprite } from "pixi.js";
import type { DioramaContext, DirectorEvent } from "../types";
import { pctPoint } from "../config/positions";
import type { Pt } from "../config/positions";
import { makeReadout } from "./util";

const DOCK: Pt = pctPoint(77, 83);
const EXCHANGE_SIDE: Pt = pctPoint(89, 82);
const BUREAU_LEDGER: Pt = pctPoint(37, 55);
const EXCHANGE_BOARD: Pt = pctPoint(88.5, 71);

export class FerrySystem {
  private exchangeValue = 143.2;

  private ferry: Container; // water shadow + painted hull, tweened together
  private hull: Sprite;
  private bureauText: ReturnType<typeof import("./util").makeReadout>;
  private exchangeText: ReturnType<typeof import("./util").makeReadout>;

  constructor(ctx: DioramaContext) {
    // Round 4: grounding — a soft water shadow (+ faint wake ellipse)
    // under the hull so the hover-ferry does not read as floating.
    this.ferry = new Container();
    const bed = new Graphics();
    bed.ellipse(0, 6, 74, 16).fill({ color: 0x06131c, alpha: 0.5 });
    bed.ellipse(-40, 6, 30, 8).fill({ color: 0x0d2836, alpha: 0.35 }); // wake smear
    this.ferry.addChild(bed);
    this.hull = new Sprite(ctx.assets.ferry);
    this.hull.anchor.set(0.5, 0.5);
    this.hull.scale.set(ctx.assets.ferryTexel);
    this.ferry.addChild(this.hull);
    this.ferry.position.set(DOCK.x, DOCK.y);
    this.ferry.zIndex = 26;
    ctx.layers.waterFX.addChild(this.ferry);

    this.bureauText = makeReadout(ctx, BUREAU_LEDGER, "LOCAL 142.5", "#8ac5d9");
    this.exchangeText = makeReadout(ctx, EXCHANGE_BOARD, "EXCH 143.2", "#4a90e2");

    // The exchange board keeps drifting on its own cadence — it is the
    // source of truth, not a mirror of us.
    const drift = (): void => {
      const next = 130 + Math.random() * 40;
      this.exchangeValue = next;
      this.exchangeText.setText(`EXCH ${next.toFixed(1)}`);
      gsap.delayedCall(gsap.utils.random(4, 11), drift);
    };
    gsap.delayedCall(3, drift);
  }

  /** Subtle wake behind the ferry while under way. */
  private wake(on: boolean): void {
    gsap.to(this.ferry, { alpha: on ? 0.92 : 1, duration: 0.4 });
  }

  event(): DirectorEvent {
    return {
      id: "ferry.reconciliation",
      zone: "bridge",
      actors: 0,
      actorKind: "any",
      priority: 5,
      cooldownSec: 20,
      minIntervalSec: 35,
      maxIntervalSec: 80,
      weight: 3,
      reducedMotionOk: true,
      soundCategory: "mechanical",
      run: (ctx) => {
        this.wake(true);
        ctx.audio.play("ferryWater", "ambient", DOCK);
        gsap
          .timeline({
            onComplete: () => {
              this.hull.scale.x = Math.abs(this.hull.scale.x);
              this.ferry.position.set(DOCK.x, DOCK.y);
              this.wake(false);
            },
          })
          .to(this.ferry, {
            x: EXCHANGE_SIDE.x,
            y: EXCHANGE_SIDE.y,
            duration: 5.5,
            ease: "sine.inOut",
          })
          // Painted hover-ferry never rotates freely; the return leg
          // mirrors horizontally (bow stays toward the direction of travel).
          .to(this.hull.scale, {
            x: -Math.abs(this.hull.scale.x),
            duration: 0.9,
            ease: "power2.inOut",
          })
          // The Bureau-side value adopts the exchange-side value.
          .add(() => {
            // The Bureau-side value adopts the exchange-side value.
            this.bureauText.setText(`LOCAL ${this.exchangeValue.toFixed(1)}`);
            gsap.fromTo(this.bureauText.container, { alpha: 0.2 }, { alpha: 1, duration: 0.8 });
            ctx.audio.play("ping", "mechanical", BUREAU_LEDGER);
          })
          .to(this.ferry, { x: DOCK.x, y: DOCK.y, duration: 5.5, ease: "sine.inOut" });
        return 14;
      },
    };
  }
}
