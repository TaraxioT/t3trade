/**
 * Preview Gauntlet: crates ride the scanner line through stations; fails
 * are diverted before signing. The clerk stays unemotional; onlookers are
 * expressive (spec §18).
 */
import gsap from "gsap";
import type { DirectorEvent } from "../types";
import { PLACES, pctPoint } from "../config/positions";
import { PROBABILITIES } from "../config";
import { flashAt, makeProp } from "./util";

const STATIONS = [pctPoint(24, 47), pctPoint(28, 49), pctPoint(33, 48)];
const SCANNER = pctPoint(26.5, 43);

export function gauntletEvent(): DirectorEvent {
  return {
    id: "gauntlet.cycle",
    zone: "gauntlet",
    actors: 1,
    actorKind: "wanderer",
    priority: 8,
    cooldownSec: 4,
    minIntervalSec: 9,
    maxIntervalSec: 20,
    weight: 10,
    reducedMotionOk: true,
    soundCategory: "mechanical",
    run: (ctx, onlookers) => {
      const onlooker = onlookers[0];
      const rejected = Math.random() < PROBABILITIES.gauntletReject;
      const clerk = ctx.agents.find((a) => a.id === "c3");
      // Painted crate: plain on entry; the verdict is baked into the frame
      // (postal seals on approval, red X on rejection) — no overlay glyphs.
      const crate = makeProp(ctx, "order-crate", PLACES.gauntletIn);
      crate.zIndex = 30;
      ctx.layers.machineFX.addChild(crate);

      const tl = gsap.timeline({
        onComplete: () => {
          crate.destroy();
          onlooker.setState("idle");
          clerk?.setState("idle");
        },
      });

      // Crate enters and passes under the scanner beam.
      tl.to(crate, { ...PLACES.gauntletMid, duration: 2.6, ease: "none" });
      tl.add(() => {
        ctx.audio.play("scan", "mechanical", SCANNER);
        flashAt(ctx, SCANNER, 0x8ac5d9, 22, 0.7);
      }, 1.2);

      let elapsed = 2.6;
      STATIONS.forEach((station, i) => {
        const failHere = rejected && i === STATIONS.length - 1;
        tl.to(crate, { x: station.x, y: station.y, duration: 1.1, ease: "none" });
        elapsed += 1.1;
        tl.add(() => {
          if (failHere) {
            ctx.audio.play("rejectBuzz", "mechanical", station);
            flashAt(ctx, station, 0xe0534c, 20, 0.6);
            crate.texture = ctx.assets.props["rejected-order-crate"];
            clerk?.stamp();
          } else {
            ctx.audio.play("ping", "mechanical", station);
            flashAt(ctx, station, 0x5bb974, 14, 0.45);
            if (i === 0) clerk?.stamp();
          }
        }, elapsed);
      });

      if (rejected) {
        // Deterministic divert; the onlooker carries the disappointment.
        tl.to(
          crate,
          {
            x: PLACES.gauntletMid.x,
            y: PLACES.gauntletMid.y + 40,
            duration: 1.4,
            ease: "power1.in",
          },
          elapsed + 0.6,
        );
        tl.add(() => {
          onlooker.setState("reacting");
          onlooker.express("worried", 1.6);
          onlooker.shrug();
          ctx.bubbles.show("?!", { x: onlooker.x, y: onlooker.headTop });
          ctx.audio.play("squeak", "character", onlooker.container.position);
        }, elapsed + 0.9);
        return elapsed + 3.2;
      }

      tl.to(crate, { ...PLACES.gauntletOut, duration: 1.3, ease: "none" }, elapsed + 0.4);
      tl.add(() => {
        // Approved: seals are stamped into the painted frame itself.
        crate.texture = ctx.assets.props["stamped-order-crate"];
        if (Math.random() < 0.4) {
          onlooker.setState("reacting");
          onlooker.celebrate();
          ctx.audio.play("celebrate", "character", onlooker.container.position);
        } else {
          onlooker.point(1);
        }
        // Approved: hand off toward the vault.
        ctx.director.force("vault.cycle");
      }, elapsed + 1.8);
      return elapsed + 3.4;
    },
  };
}
