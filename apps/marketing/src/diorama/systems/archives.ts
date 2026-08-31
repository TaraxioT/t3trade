/**
 * Archives: every event stays replayable. Capsules of journalled events
 * drop into the intake slot on a quiet cadence (spec §35 item 28).
 */
import gsap from "gsap";
import type { DirectorEvent } from "../types";
import { PLACES } from "../config/positions";
import { flashAt, makeProp } from "./util";

const INTAKE = PLACES.archivesSlot;

export function archivesEvent(): DirectorEvent {
  return {
    id: "archives.capsule",
    zone: "archives",
    actors: 1,
    actorKind: "occasional",
    priority: 3,
    cooldownSec: 8,
    minIntervalSec: 15,
    maxIntervalSec: 38,
    weight: 5,
    reducedMotionOk: true,
    soundCategory: "mechanical",
    run: (ctx, agents) => {
      const attendant = ctx.agents.find((a) => a.id === "c6") ?? agents[0];
      const capsule = makeProp(ctx, "archive-capsule", { x: INTAKE.x, y: INTAKE.y - 46 });
      capsule.zIndex = 32;
      ctx.layers.machineFX.addChild(capsule);
      ctx.audio.play("tubeWhoosh", "mechanical", INTAKE);
      gsap.to(capsule, {
        y: INTAKE.y,
        duration: 1.2,
        ease: "power2.in",
        onComplete: () => {
          flashAt(ctx, INTAKE, 0x8ac5d9, 14, 0.5);
          gsap.to(capsule, {
            alpha: 0,
            duration: 0.4,
            onComplete: () => capsule.destroy(),
          });
          attendant?.stamp();
        },
      });
      return 4;
    },
  };
}
