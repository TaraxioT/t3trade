/**
 * Signer's Vault: approved crates travel to the service window; the window
 * opens, signing glows, the crate leaves. Occasional keyless refusal:
 * shutter stays shut, polite refusal, agent shrugs and walks away
 * (spec §19). Keys never leave; nobody enters.
 */
import gsap from "gsap";
import { Graphics } from "pixi.js";
import type { DioramaContext, DirectorEvent } from "../types";
import { PLACES, pctPoint } from "../config/positions";
import { BUBBLE_WORDS, PROBABILITIES } from "../config";
import { flashAt, makeProp } from "./util";

// Round 5 surface audit: the vault has NO adjacent walkable floor — the
// basin rim is water/structure. The shutter FX stays on the rim (machine
// effect, non-actor); the courier now stops at the audited east-deck floor.
const WINDOW = pctPoint(34.2, 75.2);

function shutter(ctx: DioramaContext): Graphics {
  const g = new Graphics();
  g.roundRect(WINDOW.x - 22, WINDOW.y - 30, 44, 30, 4)
    .fill({ color: 0x2a384c, alpha: 0.95 })
    .stroke({ color: 0x3dd6c4, width: 1, alpha: 0.4 });
  g.zIndex = 40;
  ctx.layers.machineFX.addChild(g);
  return g;
}

export function vaultEvent(): DirectorEvent {
  return {
    id: "vault.cycle",
    zone: "vault",
    actors: 1,
    actorKind: "wanderer",
    priority: 7,
    cooldownSec: 6,
    minIntervalSec: 14,
    maxIntervalSec: 34,
    weight: 8,
    reducedMotionOk: true,
    soundCategory: "mechanical",
    run: (ctx, agents) => {
      const courier = agents[0];
      const keyless = Math.random() < PROBABILITIES.vaultKeylessRefusal;
      // Workers carry the crate in the baked worker-crate pose; other
      // families carry the painted crate as a loose prop.
      if (courier.role === "worker") courier.pose("crate");
      else courier.carry(makeProp(ctx, "order-crate"));

      const route = [PLACES.centralFloor, PLACES.vaultApproach, PLACES.vaultWindow];
      const tl = courier.walkTo(route);
      const walkSec =
        route.reduce((acc, pt, i) => {
          const prev = i === 0 ? { x: courier.x, y: courier.y } : route[i - 1];
          return acc + Math.hypot(pt.x - prev.x, pt.y - prev.y) / 88;
        }, 0) + 0.5;

      const sh = shutter(ctx);
      sh.scale.y = 0.25;
      gsap.delayedCall(walkSec, () => {
        if (keyless) {
          ctx.audio.play("lever", "mechanical", WINDOW);
          ctx.bubbles.show(ctx.pick(BUBBLE_WORDS.refuse), { x: WINDOW.x, y: WINDOW.y - 44 });
          flashAt(ctx, { x: WINDOW.x, y: WINDOW.y - 20 }, 0xe0534c, 12, 0.5);
          gsap.delayedCall(1.2, () => {
            courier.express("squint", 1.2);
            courier.shrug();
            ctx.audio.play("squeak", "character", courier.container.position);
            courier.pose("neutral");
            courier.dropProp();
            courier.walkTo([PLACES.vaultApproach, PLACES.centralFloor]);
          });
        } else {
          ctx.audio.play("vaultClunk", "mechanical", WINDOW);
          gsap.to(sh, { scaleY: 0.05, duration: 0.5, ease: "power2.out" });
          gsap.delayedCall(0.6, () => {
            flashAt(ctx, { x: WINDOW.x, y: WINDOW.y - 16 }, 0x3dd6c4, 18, 0.9);
            ctx.audio.play("ping", "mechanical", WINDOW);
            courier.pose("neutral");
            courier.dropProp();
            ctx.bubbles.show("✓", { x: courier.x, y: courier.headTop });
            gsap.delayedCall(1.0, () => {
              gsap.to(sh, { scaleY: 0.25, duration: 0.5, ease: "power2.in" });
              courier.walkTo([PLACES.vaultApproach, PLACES.centralFloor]);
              // Signed work may now head for the bridge.
              gsap.delayedCall(2.5, () => ctx.director.force("bridge.crossing"));
            });
          });
        }
        gsap.delayedCall(4, () => sh.destroy());
      });

      void tl;
      return walkSec + (keyless ? 6.5 : 9);
    },
  };
}
