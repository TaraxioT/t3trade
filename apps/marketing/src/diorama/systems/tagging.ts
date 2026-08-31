/**
 * Tagging Station: bots bring capsules through; the machine clicks a
 * bright protective tag on with a green pulse. Occasionally the watchdog
 * spots a missing tag, runs over, re-tags and gives a satisfied nod
 * (spec §22).
 */
import gsap from "gsap";
import type { DirectorEvent } from "../types";
import { PLACES, pctPoint } from "../config/positions";
import { flashAt, makeProp } from "./util";

// Round 4: station moved onto measured clear floor south of the archives
// desk cluster (furniture union ends y71.5); the intake FX slot itself is
// unchanged — only the actor standing spot moved.
const STATION = pctPoint(37.2, 72.4);

export function taggingEvents(): DirectorEvent[] {
  const pass: DirectorEvent = {
    id: "tagging.pass",
    zone: null,
    actors: 1,
    actorKind: "occasional",
    priority: 4,
    cooldownSec: 8,
    minIntervalSec: 18,
    maxIntervalSec: 45,
    weight: 5,
    reducedMotionOk: true,
    soundCategory: "mechanical",
    run: (ctx, agents) => {
      const worker = agents[0];
      const capsule = makeProp(ctx, "archive-capsule");
      worker.carry(capsule);
      const tl = worker.walkTo([PLACES.archivesFront, STATION]);
      void tl;
      gsap.delayedCall(2.2, () => {
        // Click-on: bright tag + green confirmation pulse.
        ctx.audio.play("ping", "mechanical", STATION);
        flashAt(ctx, STATION, 0x3dd6c4, 18, 0.6);
        const tag = makeProp(ctx, "reduce-only-tag", { x: worker.x + 8, y: worker.y - 30 });
        ctx.layers.machineFX.addChild(tag);
        gsap.to(tag, {
          alpha: 0,
          y: tag.y - 10,
          delay: 1.6,
          duration: 0.4,
          onComplete: () => tag.destroy(),
        });
        worker.express("happy", 1);
        gsap.delayedCall(1.4, () => worker.walkTo([PLACES.gauntletOut])); // round-5 audited floor
      });
      return 7;
    },
  };

  const watchdog: DirectorEvent = {
    id: "tagging.watchdog",
    zone: null,
    actors: 1,
    actorKind: "guard",
    priority: 6,
    cooldownSec: 25,
    minIntervalSec: 40,
    maxIntervalSec: 100,
    weight: 3,
    reducedMotionOk: true,
    soundCategory: "character",
    run: (ctx, agents) => {
      const dog = agents[0];
      // Alarm: a missing tag is noticed.
      ctx.bubbles.show("!", { x: dog.x, y: dog.headTop });
      dog.express("wide", 1);
      ctx.audio.play("chirp", "character", dog.container.position);
      const tl = dog.walkTo([STATION], { run: true });
      tl.eventCallback("onComplete", () => {
        ctx.audio.play("ping", "mechanical", STATION);
        flashAt(ctx, STATION, 0x3dd6c4, 20, 0.7);
        const tag = makeProp(ctx, "reduce-only-tag", STATION);
        ctx.layers.machineFX.addChild(tag);
        gsap.to(tag, { alpha: 0, delay: 1.4, duration: 0.4, onComplete: () => tag.destroy() });
        gsap.delayedCall(0.9, () => {
          dog.express("happy", 1.2); // satisfied nod
          dog.hop(6, 1);
          ctx.bubbles.show("✓", { x: dog.x, y: dog.headTop });
          gsap.delayedCall(1.4, () => dog.walkTo([PLACES.boothClaude]));
        });
      });
      return 8;
    },
  };

  return [pass, watchdog];
}
