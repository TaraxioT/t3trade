/**
 * Watchtower: rare alerts. Bell swings and rings, the sleeping ringer
 * wakes wide-eyed, grabs the dossier and runs to the work area while
 * nearby bots startle (spec §20). Sound always has a visible counterpart:
 * ring + tower flash.
 */
import gsap from "gsap";
import { Graphics } from "pixi.js";
import type { DioramaContext, DirectorEvent } from "../types";
import { PLACES, pctPoint } from "../config/positions";
import { flashAt, makeProp } from "./util";

const BELL_A = pctPoint(47.5, 30);
const BELL_B = pctPoint(52, 30);

export class WatchtowerSystem {
  private bells: Array<{ g: Graphics; baseY: number }> = [];
  private ringerId = "o8";

  constructor(private ctx: DioramaContext) {
    void this.ctx;
    for (const at of [BELL_A, BELL_B]) {
      const g = new Graphics();
      // Little bronze bell under the tower arch.
      g.moveTo(-10, 0)
        .lineTo(10, 0)
        .lineTo(7, 16)
        .lineTo(-7, 16)
        .closePath()
        .fill(0xffd166)
        .stroke({ color: 0x8a6a1c, width: 1 });
      g.circle(0, 18, 2.6).fill(0x8a6a1c);
      g.position.set(at.x, at.y);
      g.zIndex = 45;
      ctx.layers.machineFX.addChild(g);
      this.bells.push({ g, baseY: at.y });
    }
    // The ringer dozes at the tower base between alerts.
    const ringer = ctx.agents.find((a) => a.id === this.ringerId);
    if (ringer) ringer.sleep();
  }

  event(): DirectorEvent {
    return {
      id: "watchtower.alert",
      zone: "watchtower",
      actors: 0,
      actorKind: "any",
      priority: 10,
      cooldownSec: 30,
      minIntervalSec: 45,
      maxIntervalSec: 110,
      weight: 3,
      reducedMotionOk: false,
      soundCategory: "rare",
      run: (ctx) => {
        const ringer = ctx.agents.find((a) => a.id === this.ringerId);
        const pos = { x: BELL_A.x, y: BELL_A.y + 20 };

        ctx.audio.play("bell", "rare", pos);
        flashAt(ctx, { x: BELL_A.x, y: BELL_A.y + 30 }, 0xffd166, 30, 1.2);
        ctx.bubbles.show("!!", { x: BELL_A.x, y: BELL_A.y + 8 });

        for (const bell of this.bells) {
          gsap.to(bell.g, {
            rotation: 0.4,
            duration: 0.35,
            yoyo: true,
            repeat: 7,
            ease: "sine.inOut",
          });
        }

        // Nearby bots startle; one may cover its ears (squint + panic).
        const nearby = ctx.agents
          .filter(
            (a) =>
              a.kind !== "stationary" &&
              a.state !== "sleeping" &&
              !ctx.director.isRunning("watchtower.alert"),
          )
          .slice(0, 2);
        for (const bot of nearby) {
          gsap.delayedCall(0.15, () => {
            bot.setState("reacting");
            bot.startle();
            ctx.audio.play("squeak", "character", bot.container.position);
            gsap.delayedCall(1.6, () => bot.setState("idle"));
          });
        }

        // The sleeping ringer wakes, takes the dossier, runs to the floor.
        if (ringer) {
          gsap.delayedCall(0.8, () => {
            ringer.wake();
            ctx.audio.play("chirp", "character", ringer.container.position);
            gsap.delayedCall(1.1, () => {
              ringer.carry(makeProp(ctx, "dossier"));
              // Round 5: the tower platform has no verified floor — the ringer's home is
              // the mezzanine rail above; the wake run goes straight to the floor.
              const tl = ringer.walkTo([PLACES.mezzCenter, PLACES.centralFloor], { run: true });
              tl.eventCallback("onComplete", () => {
                ringer.dropProp();
                ctx.bubbles.show("!", { x: ringer.x, y: ringer.headTop });
              });
            });
          });
        }
        return 9;
      },
    };
  }
}
