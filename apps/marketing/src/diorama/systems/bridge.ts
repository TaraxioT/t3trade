/**
 * Testnet Bridge: approved carts cross, receipts return, lightning pulses
 * along the conduit while the cart is mid-bridge (spec §27). The bridge is
 * the only route out of the Bureau — everything on it is already signed.
 */
import gsap from "gsap";
import { Graphics } from "pixi.js";
import type { DioramaContext, DirectorEvent } from "../types";
import { PLACES } from "../config/positions";
import { makeProp } from "./util";

export class BridgeSystem {
  private bolt: Graphics;

  constructor(private ctx: DioramaContext) {
    this.bolt = new Graphics();
    this.bolt.blendMode = "add";
    this.bolt.zIndex = 12;
    ctx.layers.bridgeFX.addChild(this.bolt);
    this.drawBolt(0);
    this.bolt.alpha = 0;
  }

  /** Jagged energy polyline across the bridge, low alpha. */
  private drawBolt(seed: number): void {
    const g = this.bolt;
    g.clear();
    const from = PLACES.bridgeStart;
    const to = PLACES.bridgeEnd;
    g.moveTo(from.x, from.y);
    const steps = 7;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const jitter = Math.sin(seed * 13.7 + i * 5.1) * 7;
      g.lineTo(from.x + (to.x - from.x) * f, from.y + jitter + Math.sin(f * Math.PI) * -6);
    }
    g.stroke({ color: 0x3dd6c4, width: 2.5, alpha: 0.55 });
  }

  /** Flash sequence while a cart is crossing. */
  pulse(): void {
    const state = { seed: 0 };
    gsap
      .timeline({ onComplete: () => gsap.to(this.bolt, { alpha: 0, duration: 0.6 }) })
      .to(this.bolt, { alpha: 1, duration: 0.1 })
      .to(state, {
        seed: 6,
        duration: 3.2,
        ease: "none",
        onUpdate: () => this.drawBolt(state.seed),
      });
    this.ctx.audio.play("tubeWhoosh", "mechanical", PLACES.bridgeStart);
  }

  event(): DirectorEvent {
    return {
      id: "bridge.crossing",
      zone: "bridge",
      actors: 0,
      actorKind: "any",
      priority: 6,
      cooldownSec: 12,
      minIntervalSec: 24,
      maxIntervalSec: 60,
      weight: 4,
      reducedMotionOk: true,
      soundCategory: "mechanical",
      run: (ctx) => {
        const cart = makeProp(ctx, "cart", PLACES.bridgeStart);
        cart.zIndex = 25;
        ctx.layers.machineFX.addChild(cart);
        this.pulse();
        const cross = gsap.to(cart, {
          x: PLACES.bridgeEnd.x,
          y: PLACES.bridgeEnd.y,
          duration: 3.4,
          ease: "none",
          onComplete: () => {
            // The exchange acknowledges: a receipt comes back.
            const receipt = makeProp(ctx, "receipt", PLACES.bridgeEnd);
            receipt.zIndex = 25;
            ctx.layers.machineFX.addChild(receipt);
            gsap.to(receipt, {
              x: PLACES.bridgeStart.x,
              y: PLACES.bridgeStart.y,
              duration: 2.6,
              delay: 0.8,
              ease: "none",
              onComplete: () => {
                ctx.audio.play("ping", "mechanical", PLACES.bridgeStart);
                receipt.destroy();
                // Reconciliation follows a crossing.
                gsap.delayedCall(2, () => ctx.director.force("ferry.reconciliation"));
              },
            });
          },
        });
        void cross;
        return 9;
      },
    };
  }
}
