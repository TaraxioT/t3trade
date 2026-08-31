/**
 * Idle micro-stories (spec §35). These are the free-roaming character
 * beats; system-owned story events (gauntlet, vault, watchtower, ferry,
 * interpreters, tagging, archives) live in systems/*.ts. Together they
 * cover the full 28-item list. All cadences are randomized per descriptor.
 */
import gsap from "gsap";
import type { DioramaContext, DirectorEvent } from "../types";
import type { Agent } from "../actors/Agent";
import { PLACES } from "../config/positions";
import { makeProp } from "../systems/util";

type Beat = (ctx: DioramaContext, agents: Agent[]) => number;

function beat(
  id: string,
  actors: DirectorEvent["actorKind"],
  interval: [number, number],
  run: Beat,
  opts: Partial<DirectorEvent> = {},
): DirectorEvent {
  return {
    id,
    zone: null,
    actors:
      typeof actors === "string" && ["wanderer", "occasional", "any", "stationary"].includes(actors)
        ? 1
        : 1,
    actorKind: actors,
    priority: 2,
    cooldownSec: 6,
    minIntervalSec: interval[0],
    maxIntervalSec: interval[1],
    weight: 4,
    reducedMotionOk: true,
    soundCategory: "character",
    ...opts,
    run,
  };
}

const squeak = (ctx: DioramaContext, a: Agent): void => {
  ctx.audio.play("squeak", "character", a.container.position);
};

export function characterEvents(): DirectorEvent[] {
  return [
    // 1. bot carries a crate across the floor
    beat("ev.carryCrate", "wanderer", [10, 26], (ctx, agents) => {
      const a = agents[0];
      if (a.role === "worker") a.pose("crate");
      else a.carry(makeProp(ctx, "order-crate"));
      const tl = a.walkTo([PLACES.centralFloor, PLACES.archivesFront]);
      tl.eventCallback("onComplete", () => {
        a.pose("neutral");
        a.dropProp();
      });
      return 9;
    }),
    // 2. bot drops papers
    beat(
      "ev.dropPapers",
      "wanderer",
      [14, 34],
      (ctx, agents) => {
        const a = agents[0];
        const papers = makeProp(ctx, "papers", { x: a.x + 6, y: a.y - 26 });
        ctx.layers.machineFX.addChild(papers);
        squeak(ctx, a);
        a.express("wide", 0.8);
        gsap.to(papers, {
          y: a.y + 2,
          rotation: gsap.utils.random(-1, 1),
          duration: 0.5,
          ease: "power2.in",
        });
        gsap.to(papers, { alpha: 0, delay: 3, duration: 0.5, onComplete: () => papers.destroy() });
        return 4;
      },
      { weight: 1.6 },
    ),
    // 3. a second bot helps pick up
    beat(
      "ev.helpPickup",
      "occasional",
      [22, 55],
      (ctx, agents) => {
        const helper = agents[0];
        const tl = helper.walkTo([PLACES.centralFloor]);
        tl.eventCallback("onComplete", () => {
          helper.express("happy", 1.4);
          helper.wave();
          ctx.bubbles.show("✓", { x: helper.x, y: helper.headTop });
          squeak(ctx, helper);
        });
        return 7;
      },
      { weight: 1.6 },
    ),
    // 6. worker shrugs off a confusing readout
    beat(
      "ev.shrug",
      "any",
      [12, 30],
      (ctx, agents) => {
        agents[0].tiltHead();
        gsap.delayedCall(1.4, () => {
          agents[0].shrug();
          squeak(ctx, agents[0]);
        });
        return 4;
      },
      { weight: 1.6 },
    ),
    // 7. bot trips over a cable
    beat(
      "ev.trip",
      "wanderer",
      [30, 70],
      (ctx, agents) => {
        const a = agents[0];
        const tl = a.walkTo([PLACES.tribunalDais]);
        tl.eventCallback("onComplete", () => {
          a.trip();
          squeak(ctx, a);
          ctx.audio.play("yelp", "character", a.container.position);
        });
        return 8;
      },
      { reducedMotionOk: false, weight: 0.7 },
    ),
    // 8. friend laughs at the trip
    beat(
      "ev.laugh",
      "occasional",
      [26, 60],
      (ctx, agents) => {
        const a = agents[0];
        a.express("happy", 2);
        a.hop(5, 2);
        ctx.audio.play("giggle", "character", a.container.position);
        return 3;
      },
      { reducedMotionOk: false, weight: 0.7 },
    ),
    // 9. dramatic cartoon cry with the full arc: struggle -> stumble ->
    // crying pose -> oversized tears -> tiny shake -> sob -> a nearby bot
    // reacts -> recover (2-3s; no spoken words).
    beat(
      "ev.cry",
      "wanderer",
      [45, 120],
      (ctx, agents) => {
        const a = agents[0];
        a.setState("reacting");
        a.walkTo([{ x: a.x + 14, y: a.y + 3 }]); // the struggle-stumble approach
        gsap.delayedCall(0.7, () => {
          a.cry();
          ctx.audio.play("sob", "character", a.container.position);
          const neighbor = ctx.agents.find(
            (n) => n !== a && n.kind !== "stationary" && n.state === "idle",
          );
          if (neighbor) {
            gsap.delayedCall(1.0, () => {
              neighbor.lookAt(a.x, a.y);
              neighbor.express("worried", 0.9);
            });
          }
        });
        return 4;
      },
      { reducedMotionOk: false, soundCategory: "rare", weight: 0.2 },
    ),
    // 10. friend pats the crying bot
    beat(
      "ev.pat",
      "occasional",
      [50, 130],
      (ctx, agents) => {
        const friend = agents[0];
        const tl = friend.walkTo([PLACES.centralFloor]);
        tl.eventCallback("onComplete", () => {
          friend.express("happy", 1.4);
          friend.point(1);
          ctx.bubbles.show("♡", { x: friend.x, y: friend.headTop });
          ctx.audio.play("chirp", "character", friend.container.position);
        });
        return 7;
      },
      { weight: 0.2 },
    ),
    // 21. a steam puff surprises a worker
    beat(
      "ev.steamSurprise",
      "wanderer",
      [24, 55],
      (ctx, agents) => {
        const a = agents[0];
        a.startle();
        squeak(ctx, a);
        gsap.delayedCall(1.4, () => a.express("squint", 0.8));
        return 4;
      },
      { reducedMotionOk: false },
    ),
    // 22. two bots briefly argue
    beat("ev.argue", "wanderer", [20, 48], (ctx, agents) => {
      const a = agents[0];
      const tl = a.walkTo([PLACES.tribunalDais]);
      tl.eventCallback("onComplete", () => {
        a.argue();
        ctx.bubbles.show("?!", { x: a.x, y: a.headTop });
        squeak(ctx, a);
        gsap.delayedCall(1.6, () => a.express("neutral", 0));
      });
      return 8;
    }),
    // 23. celebrate a successful approval
    beat(
      "ev.celebrate",
      "any",
      [18, 42],
      (ctx, agents) => {
        agents[0].celebrate();
        ctx.audio.play("celebrate", "character", agents[0].container.position);
        return 4;
      },
      { reducedMotionOk: false, weight: 0.7 },
    ),
    // 24. agent pushes a stubborn crate
    beat(
      "ev.pushCrate",
      "wanderer",
      [16, 40],
      (ctx, agents) => {
        const a = agents[0];
        const crate = makeProp(ctx, "order-crate", { x: a.x + 26, y: a.y - 8 });
        ctx.layers.machineFX.addChild(crate);
        a.push();
        squeak(ctx, a);
        gsap.to(crate, { x: crate.x + 34, duration: 1.4, ease: "steps(5)" });
        gsap.to(crate, { alpha: 0, delay: 3, duration: 0.5, onComplete: () => crate.destroy() });
        return 5;
      },
      { weight: 0.7 },
    ),
    // 25. terminal causes a confused head tilt
    beat("ev.terminalTilt", "occasional", [14, 36], (_ctx, agents) => {
      agents[0].tiltHead();
      return 4;
    }),
    // 26. bot drinks a tiny futuristic beverage
    beat("ev.drink", "stationary", [18, 45], (ctx, agents) => {
      const a = agents[0];
      a.carry(makeProp(ctx, "coffee"));
      a.drink();
      ctx.audio.play("chirp", "character", a.container.position);
      gsap.delayedCall(2.4, () => a.dropProp());
      return 5;
    }),
    // 27. clerk straightens a stack of forms
    beat("ev.straighten", "stationary", [12, 30], (ctx, agents) => {
      const a = agents[0];
      a.type();
      gsap.delayedCall(1.2, () => {
        a.stamp();
        ctx.audio.play("stamp", "mechanical", a.container.position);
      });
      return 5;
    }),
    // 20. operator-room guard curiosity is handled by operator.guard; a
    // wandering tourist gazing across the water rounds out the periphery.
    beat("ev.gazeAcross", "occasional", [20, 50], (_ctx, agents) => {
      const a = agents[0];
      // Round 5: gaze from the audited south deck (bridge base is railing).
      const tl = a.walkTo([PLACES.rightLowerLane]);
      tl.eventCallback("onComplete", () => {
        a.lookAt(PLACES.bazaarDeck.x, PLACES.bazaarDeck.y);
        a.express("neutral", 0);
        gsap.delayedCall(2.2, () => a.walkTo([PLACES.centralFloor]));
      });
      return 10;
    }),
    // A wave between passing bots: cheap warmth, rare enough to matter.
    beat("ev.waveHello", "any", [16, 38], (ctx, agents) => {
      const a = agents[0];
      a.wave();
      ctx.audio.play("chirp", "character", a.container.position);
      return 4;
    }),
    // A sleepy nod at the archives desk.
    beat(
      "ev.sleepyNod",
      "occasional",
      [25, 60],
      (ctx, agents) => {
        const a = agents[0];
        a.express("sleep", 1.6);
        gsap.to(a.container, { y: a.y + 2, duration: 0.6, yoyo: true, repeat: 1 });
        gsap.delayedCall(1.8, () => {
          a.startle();
          squeak(ctx, a);
        });
        return 5;
      },
      { weight: 1.6 },
    ),
    // Chase a rolling capsule that escaped the intake.
    beat(
      "ev.chaseRolling",
      "wanderer",
      [30, 75],
      (ctx, agents) => {
        const a = agents[0];
        const capsule = makeProp(ctx, "archive-capsule", { x: a.x - 20, y: a.y - 6 });
        ctx.layers.machineFX.addChild(capsule);
        gsap.to(capsule, { x: capsule.x - 60, rotation: 6, duration: 2, ease: "power1.out" });
        const tl = a.walkTo([{ x: capsule.x - 60, y: a.y }], { run: true });
        squeak(ctx, a);
        tl.eventCallback("onComplete", () => {
          capsule.destroy();
          a.express("happy", 1.2);
          a.hop(6, 1);
        });
        return 6;
      },
      { reducedMotionOk: false, weight: 0.7 },
    ),
    // Stationary clerk micro-motion pool: keeps desks alive between beats.
    beat(
      "ev.clerkMicro",
      "stationary",
      [6, 16],
      (_ctx, agents) => {
        const a = agents[0];
        if (Math.random() < 0.5) a.type();
        else {
          a.express("blink", 0.2);
          a.lookAt(a.x + gsap.utils.random(-200, 200), a.y);
        }
        return 3;
      },
      { soundCategory: "character" },
    ),
  ];
}
