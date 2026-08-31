/**
 * TRANSITIONAL central fragment (R5): the entire current canonical story,
 * moved verbatim from story/beats.ts with ABSOLUTE times. Behavior is
 * bit-identical to the pre-fragment table. When the eight zone loops, the
 * alarm fragment, and the PAUSE-hand fragment land, this file is decomposed
 * into them and shrinks to the central crate plot.
 */

import { asActorId } from "../../types";
import { P, arc, ax, cue, drop, faceTo, faceYaw, grab, holdAt, mv, poseOf } from "./authoring";
import type { Fragment, FragmentActorCommand, FragmentPropCommand } from "./types";

// Local construction sinks (module-private; no shared mutable state leaks).
const ACTORS: FragmentActorCommand[] = [];
const PROPS: FragmentPropCommand[] = [];
/** Narration cues ride an unobtrusive actor track (fireCue has no duration
 *  and never touches motion channels). */
const CUE_ACTOR = "ambient-6";

const A = (actorId: string, command: Parameters<typeof ax>[1]): void => {
  ACTORS.push(ax(actorId, command));
};
const Pr = (_propId: string, entry: FragmentPropCommand): void => {
  PROPS.push(entry);
};
const C = (cueId: string, t: number, detail?: Readonly<Record<string, number | string>>): void => {
  ACTORS.push(ax(CUE_ACTOR, cue(cueId, t, detail)));
};

// P0 shift_start (0-6000): low light, intern already typing at his desk slot,
// clock flips 08:59 -> 09:00 at 5200, antenna pulse. Everyone else rests at
// home (slotted, so the desk rows never stack).
{
  A("intern", holdAt("deskRowTrading", 0, 6000, "work"));
  C("clack", 5200); // time-clock flip
}

// P1 research_chaos (6000-20000): staged ensemble - chart-wall watchers with
// facing, telescope bot at the tube, the faint/catch pair pulled OUT onto the
// open loft floor via a real moveAlong, the paper-plane chase on offset
// parallel progress windows, analyst facing the ticker board, coffee swarm as
// a slotted 3-bot cluster that the steam burst scatters.
{
  // Chart wall: two watchers, slotted, facing the wall.
  A("researcher-2", holdAt("chartWall", 6000, 7900, "work"));
  A("researcher-2", faceTo("chartWall", 6100, 7700));
  A("researcher-2", mv("crateBrigade", 14100, 14800, "easeOutQuad", 0.04, 0.26)); // dashes to the catch
  A("researcher-2", poseOf("react", 14900, 1500)); // catches researcher-3
  A("researcher-2", holdAt("chartWall", 16600, 2800, "work"));
  A("researcher-6", holdAt("chartWall", 6000, 8100, "work"));
  A("researcher-6", faceTo("chartWall", 6100, 7900));
  A("researcher-6", poseOf("react", 14100, 1400)); // red-drop gasp
  A("researcher-6", holdAt("chartWall", 15600, 3800, "work"));

  // Telescope bot at the tube; staggers out and FAINTS on the open floor.
  A("researcher-3", holdAt("telescope", 6000, 6600, "work"));
  A("researcher-3", faceTo("telescope", 6100, 6400));
  A("researcher-3", mv("crateBrigade", 12800, 13900, "easeOutQuad", 0.16, 0.3));
  A("researcher-3", poseOf("faint", 14200, 1900)); // held >= 1.5s, open floor
  A("researcher-3", holdAt("deskRow", 16400, 3000, "idle"));

  // Paper-plane chase: two runners on offset parallel progress windows.
  A("researcher-5", mv("crateBrigade", 9500, 11600, "easeOutQuad", 0.1, 0.3));
  A("ambient-3", mv("crateBrigade", 9800, 11900, "easeOutQuad", 0.14, 0.34));
  C("tick", 9500, { effect: "paperBurst", x: -4.8, y: 5.2, z: 2.2 });

  // Coffee swarm: slotted 3-bot cluster, then the steam burst scatters them.
  A("researcher-1", holdAt("deskRow", 6000, 5700, "work"));
  A("researcher-1", holdAt("coffee", 11800, 1700, "idle"));
  A("researcher-1", poseOf("react", 12600, 1300)); // steam scatter
  A("researcher-1", holdAt("deskRow", 13700, 5700, "work"));
  A("researcher-4", holdAt("deskRow", 6000, 5700, "work"));
  A("researcher-4", holdAt("coffee", 11800, 1800, "idle"));
  A("researcher-4", poseOf("react", 12700, 1300));
  A("researcher-4", holdAt("deskRow", 13800, 5600, "work"));
  A("researcher-5", holdAt("coffee", 11700, 1600, "idle")); // joins after the chase
  A("researcher-5", poseOf("react", 12700, 1300));
  A("researcher-5", holdAt("deskRow", 13700, 5700, "work"));
  A("coffee", holdAt("coffee", 6000, 6400, "work"));
  A("coffee", poseOf("react", 12600, 1200)); // swarmed, returns calmly
  A("coffee", holdAt("coffee", 14000, 5500, "work"));
  C("tick", 12500, { effect: "steamPuff", x: -8.5, y: 5.0, z: -2.5 });

  // Analyst at the board, facing it, arguing at the flicker.
  A("analyst", holdAt("tickerBoard", 6000, 8800, "idle"));
  A("analyst", faceYaw(Math.PI, 6100, 13400)); // face the board behind the slot
  A("analyst", poseOf("argue", 15000, 3600));
  A("analyst", holdAt("tickerBoard", 18800, 700, "idle")); // smug
}

// P2 mission_briefing (20000-29000): foreman at the table facing a slotted
// half-moon of five, all facing the blueprint; nods; scatter. researcher-5
// rides the brigade path DOWN (visible moveAlong, not a cut) for the
// blueprint-wrap gag staged beside the table.
{
  A("foreman", holdAt("briefing", 20000, 600, "work"));
  A("foreman", faceYaw(0, 20100, 8300)); // face the gathered half-moon
  A("foreman", poseOf("argue", 20600, 800)); // blueprint slam
  A("foreman", holdAt("briefing", 21500, 6800, "work"));
  A("foreman", poseOf("celebrate", 27900, 500)); // presentation flourish

  A("analyst", holdAt("briefing", 20800, 7500, "idle"));
  A("analyst", faceTo("briefing", 20850, 7400));
  A("runner-a", holdAt("briefing", 21000, 7300, "idle"));
  A("runner-a", faceTo("briefing", 21050, 7200));
  A("runner-b", holdAt("briefing", 21200, 7100, "idle"));
  A("runner-b", faceTo("briefing", 21250, 7000));
  A("runner-b", poseOf("react", 21200, 600)); // dragged by the collar
  A("ambient-4", holdAt("briefing", 21400, 6900, "idle"));
  A("ambient-4", faceTo("briefing", 21450, 6800));
  A("ambient-4", poseOf("react", 21400, 600)); // dragged too
  A("janitor", holdAt("briefing", 21600, 6700, "idle"));
  A("janitor", faceTo("briefing", 21650, 6600));

  // Nods, staggered.
  A("analyst", poseOf("react", 27600, 500));
  A("runner-a", poseOf("react", 27750, 500));
  A("runner-b", poseOf("react", 27900, 500));
  A("ambient-4", poseOf("react", 28050, 500));

  // Blueprint-wrap gag: researcher-5 rides down, ends beside the table.
  A("researcher-5", mv("crateBrigade", 20800, 24000, "easeInOutCubic"));
  A("researcher-5", holdAt("briefing", 24100, 2500, "idle"));
  A("researcher-5", faceTo("briefing", 24150, 2400));
  C("tick", 24500, { effect: "paperBurst", x: 1.6, y: 0.6, z: -0.1 });
  A("researcher-5", poseOf("react", 24600, 1200)); // wrapped, waddling
  A("researcher-5", poseOf("faint", 25900, 2200)); // flops beside the table
  A("researcher-5", holdAt("briefing", 28200, 700, "idle"));

  // Intern keeps typing through the briefing.
  A("intern", holdAt("deskRowTrading", 20000, 8400, "work"));

  // Scatter to stations.
  A("analyst", holdAt("tickerBoard", 28400, 500, "idle"));
  A("runner-a", holdAt("conveyorIn", 28500, 400, "idle"));
  A("runner-b", holdAt("conveyorOut", 28500, 400, "idle"));
  A("ambient-4", holdAt("deskRowTrading", 28500, 400, "idle"));
  A("foreman", holdAt("briefing", 28400, 500, "idle"));
}

// P3 plan_crates (29000-41000): the brigade as a visible chain - loft hoist,
// pole drop, belt ride. The collision is STAGED at the merge: runner-b waits
// in runner-a's path, both collide, stagger apart to slotted positions, argue
// face-to-face, then re-pack side by side.
{
  // Crate-a loft delivery (hoist arc), then runner-c poles it down.
  Pr("crate-a", arc("crate-a", P(-3.4, 0, 6.0), P(3, 4.6, 5.5), 29200, 30200, 2, "easeInOutCubic"));
  Pr("crate-a", grab("runner-c", "crate-a", "carry", 30300));
  A("runner-c", holdAt("poleTopLoft", 29000, 1300, "work"));
  A("runner-c", mv("poleDropLoft", 30400, 33000, "easeInQuad"));
  C("clack", 30500, { effect: "poleDust", x: 3, y: 0.6, z: 5.5 });
  A("runner-c", holdAt("conveyorIn", 33200, 2300, "carry"));
  A("runner-c", mv("conveyorFlow", 35600, 39900, "linear", 0.05, 0.85)); // belt ride
  A("runner-c", poseOf("react", 33500, 800)); // jam startle
  C("clack", 33600, { x: 0.5, y: 0.4, z: 4.8 }); // belt jam lurch

  // Collision staging: runner-a carries crate-b into runner-b at the merge.
  Pr("crate-b", grab("runner-a", "crate-b", "carry", 29900));
  A("runner-a", holdAt("conveyorIn", 29000, 1000, "work")); // straps up
  A("runner-a", mv("conveyorFlow", 30100, 33500, "linear", 0.15, 0.75));
  A("runner-b", holdAt("conveyorOut", 29000, 4500, "work")); // waits at merge slot
  A("runner-b", faceYaw(-Math.PI / 2, 29100, 4400)); // faces the oncoming carrier
  A("runner-a", poseOf("collide", 33600, 700));
  A("runner-b", poseOf("collide", 33650, 700));
  C("clack", 33650, { x: 2.9, y: 0.4, z: 5.2 }); // impact
  C("tick", 33700, { effect: "paperBurst", x: 2.9, y: 0.6, z: 5.2 }); // paper blizzard

  // Stagger apart to slotted positions, argue face-to-face, joint re-pack.
  A("runner-a", holdAt("conveyorOut", 34400, 1800, "carry")); // sprung back, slot A
  A("runner-b", poseOf("react", 34400, 600)); // reels, stays at merge slot B
  A("runner-a", faceYaw(-1.0, 36400, 3100)); // faces runner-b
  A("runner-b", faceYaw(2.14, 36400, 3100)); // faces runner-a
  A("runner-a", poseOf("argue", 36600, 1800));
  A("runner-b", poseOf("argue", 36600, 1800));
  A("runner-a", poseOf("work", 38500, 1000)); // re-pack, side by side
  A("runner-b", poseOf("work", 38500, 1000));
  A("runner-a", faceYaw(-1.0, 38500, 2400)); // both over the spilled paper
  A("runner-b", faceYaw(-1.0, 38500, 2400));
  C("tick", 38600, { effect: "paperBurst", x: 4.6, y: 0.5, z: 4.8 });

  A("guard-1", holdAt("stampDesk", 29000, 12000, "work"));
  A("guard-1", faceTo("queueHead", 29100, 11900)); // faces the queue
  A("guard-2", holdAt("queueHead", 29000, 12000, "work"));
  A("guard-2", faceTo("queueTail", 29100, 11900)); // faces the line
  A("intern", holdAt("deskRowTrading", 29000, 12000, "work"));
}

// P4 risk_gate (41000-54000): a real queue - both carriers ride the pole down
// (visible), advance along gateQueue single-file with spacing, all facing the
// stamp desk. Queue-jumper blocked between tail and head; reject chute ride on
// the open camera side; vault door rumble lean-in.
{
  // Carriers ride the conga pole segment DOWN into the vault (visible stream).
  A("runner-c", mv("congaLoop", 41300, 44600, "easeInOutCubic", 0.1, 0.4));
  A("runner-c", faceTo("stampDesk", 44400, 9400));
  A("runner-c", mv("gateQueue", 45500, 46500, "easeInOutCubic", 0.7, 1.0)); // to the desk
  A("runner-c", holdAt("stampDesk", 46600, 7200, "carry")); // waiting slot
  A("runner-a", mv("congaLoop", 41400, 44300, "easeInOutCubic", 0.1, 0.34));
  A("runner-a", faceTo("stampDesk", 44400, 9400));
  A("runner-a", mv("gateQueue", 48000, 50000, "easeInOutCubic", 0.55, 0.95)); // measured
  A("runner-a", holdAt("stampDesk", 50100, 3700, "idle")); // rejected, waiting slot

  // Queue-jumper: dashes up the line, blocked, argues, slinks off.
  A("runner-d", holdAt("queueTail", 41100, 900, "idle"));
  A("runner-d", mv("gateQueue", 42100, 42700, "easeOutQuad", 0.3, 0.72)); // jumps ahead
  A("runner-d", faceTo("stampDesk", 42700, 900));
  A("guard-2", poseOf("react", 42800, 600)); // cartoon arm-point
  A("runner-d", poseOf("argue", 42800, 700)); // protests
  A("runner-d", mv("hatchApproachVault", 43700, 44700, "easeInOutCubic", 0, 0.3)); // slinks away
  A("runner-d", holdAt("chuteTop", 47400, 1900, "idle"));
  A("runner-d", mv("chuteDrop", 49350, 50350, "easeInQuad")); // rides after the crate
  A("runner-d", holdAt("chuteExit", 50400, 800, "idle"));
  Pr("crate-b", drop("crate-b", "chuteExit", 49400));
  Pr(
    "crate-b",
    arc("crate-b", P(0.5, -1.8, 0), P(-12.8, -1.4, 1.5), 49450, 50450, 0.8, "easeInQuad"),
  );
  Pr("crate-b", grab("runner-d", "crate-b", "carry", 51200)); // climbs out, crate on head
  A("runner-d", holdAt("queueTail", 52200, 1600, "carry")); // re-queues at the BACK
  A("runner-d", faceTo("stampDesk", 52300, 1500));

  // APPROVE (crate-a) / REJECT (crate-b) at the stamp desk.
  C("stamp", 46500, { effect: "stampDust", variant: "approve", x: 0.5, y: -1.6, z: 0 });
  C("ping", 47500, { x: 0.5, y: -1.4, z: 0 }); // green tick flies
  C("reject", 49500, { effect: "stampDust", variant: "reject", x: 0.5, y: -1.6, z: 0 });
  C("clack", 50450, { x: -12.8, y: -1.4, z: 1.5 }); // bin arrival

  // Vault door rumbles open; nearby bots lean in.
  A("accountant-2", poseOf("react", 50600, 1000));
  A("accountant-1", poseOf("react", 50650, 1000));
  A("gunner", poseOf("react", 50700, 900));

  A("researcher-5", holdAt("deskRow", 41500, 12500, "idle")); // back upstairs after the gag
  A("guard-1", holdAt("stampDesk", 41100, 12900, "work"));
  A("guard-1", faceTo("queueHead", 41200, 12800));
  A("guard-2", holdAt("queueHead", 41100, 12900, "work"));
  A("guard-2", faceTo("queueTail", 41200, 12800));
  A("intern", holdAt("deskRowTrading", 41100, 12900, "work"));
  A("analyst", holdAt("tickerBoard", 41100, 12900, "idle"));
  A("runner-b", holdAt("conveyorOut", 41100, 12900, "idle"));
  A("runner-b", faceTo("briefing", 71250, 7650)); // watches the conga
}

// P5 order_launch (54000-64000): crate-a arcs into the breech; a slotted
// safe-line row faces the cannon; crank, jam, overpressure pinball with
// scattered dodges; freeze; synchronized cheer burst; FIRE.
{
  // Crate-a loads into the breech and "merges" (hides at the breech anchor).
  Pr("crate-a", drop("crate-a", "breech", 54100));
  Pr(
    "crate-a",
    arc("crate-a", P(0.5, -1.8, 0), P(-7.4, -1.8, -2.7), 54150, 54950, 1.2, "easeInOutCubic"),
  );

  // The orb appears (parked-arc keeps it visible at the breech until pop).
  Pr(
    "orderOrb",
    arc("orderOrb", P(-7.4, -1.6, -2.7), P(-7.4, -1.6, -2.7), 55000, 61000, 0.01, "linear"),
  );

  // Safe line: slotted row at the vault door, all facing the cannon.
  A("runner-a", holdAt("vaultDoor", 54200, 16900, "idle"));
  A("runner-a", faceTo("cannon", 54250, 16800));
  A("runner-b", holdAt("vaultDoor", 54300, 16800, "idle"));
  A("runner-b", faceTo("cannon", 54350, 16700));
  A("runner-c", holdAt("vaultDoor", 54400, 16700, "idle"));
  A("runner-c", faceTo("cannon", 54450, 16600));
  A("runner-d", holdAt("vaultDoor", 54100, 17000, "carry"));
  A("runner-d", faceTo("cannon", 54150, 16900));
  A("guard-1", holdAt("stampDesk", 54100, 9900, "idle"));
  A("guard-1", faceTo("cannon", 54150, 9800));
  A("guard-2", holdAt("queueHead", 54200, 9800, "idle"));
  A("guard-2", faceTo("cannon", 54250, 9700));
  A("gunner", holdAt("cannon", 54000, 9400, "work")); // cranking
  A("gunner", poseOf("react", 57900, 1100)); // crank jam
  A("intern", holdAt("cannon", 59500, 3500, "work")); // jumps in, both crank

  // Overpressure: orb pops and pinballs (3 bounces), bots dodge, self-lands.
  Pr(
    "orderOrb",
    arc("orderOrb", P(-7.4, -1.6, -2.7), P(-4, -0.6, 1.5), 61000, 61400, 0.8, "easeOutQuad"),
  );
  Pr(
    "orderOrb",
    arc("orderOrb", P(-4, -0.6, 1.5), P(-6.5, -0.6, -1.2), 61600, 62000, 0.8, "easeOutQuad"),
  );
  Pr(
    "orderOrb",
    arc("orderOrb", P(-6.5, -0.6, -1.2), P(-7.4, -1.6, -2.7), 62100, 62400, 0.6, "easeOutQuad"),
  );
  Pr("orderOrb", drop("orderOrb", "breech", 62450));
  A("gunner", poseOf("react", 61100, 1300)); // dodge
  A("intern", poseOf("react", 61150, 1300));
  A("accountant-1", poseOf("react", 61200, 1200));
  A("accountant-2", poseOf("react", 61250, 1200));
  A("guard-1", poseOf("react", 61300, 1100));
  A("guard-2", poseOf("react", 61350, 1100));

  // Freeze (machine window 62450-62850), then a synchronized cheer burst.
  A("gunner", poseOf("celebrate", 62950, 900));
  A("intern", poseOf("celebrate", 62950, 900));
  A("runner-a", poseOf("celebrate", 62950, 900));
  A("runner-b", poseOf("celebrate", 62950, 900));
  A("runner-c", poseOf("celebrate", 62950, 900));
  A("runner-d", poseOf("celebrate", 62950, 900));
  A("guard-1", poseOf("celebrate", 62950, 900));
  A("guard-2", poseOf("celebrate", 62950, 900));
  C("pop", 63000, { x: -7.4, y: -1.4, z: -2.7 });

  // FIRE through the pipe bridge.
  C("whoosh", 63300, { effect: "cannonSmoke", x: -6, y: -0.9, z: -3.0 });
  Pr(
    "orderOrb",
    arc("orderOrb", P(-7.4, -1.6, -2.7), P(6.4, 10.8, -5.8), 63300, 63850, 2, "linear"),
  );
  Pr(
    "orderOrb",
    arc("orderOrb", P(6.4, 10.8, -5.8), P(16, 13, -6), 63900, 64300, 1.2, "easeOutQuad"),
  );
  C("ping", 64000, { effect: "receiptSparks", x: 6.4, y: 10.8, z: -5.8 });
}

// P6 receipt_return (64000-71000): arm catches and slots the orb; the
// nothing-happens beat is readable (rail bots still, facing the slot wall);
// mint press, coin arc after it, landing react at the tray; antenna double
// pulse; satellite confetti pop.
{
  Pr("orderOrb", drop("orderOrb", "slotA", 65950)); // slotted into the wall

  // Rail bots lean toward the satellite side; guards crane from the gate.
  A("ambient-5", holdAt("pipeArrival", 64000, 6900, "idle"));
  A("ambient-5", faceTo("slotWall", 64050, 6800));
  A("ambient-5", poseOf("react", 66100, 900)); // lean: nothing happens...
  A("ambient-4", holdAt("deskRowTrading", 64000, 6900, "idle"));
  A("ambient-4", faceTo("slotWall", 64050, 6800));
  A("ambient-4", poseOf("react", 66300, 600));
  A("guard-1", poseOf("react", 66250, 600));
  A("guard-2", poseOf("react", 66350, 600));

  // Mint clunk; receipt coin flies satellite -> return end -> coin slot.
  C("tick", 67600, { x: 14.4, y: 13.4, z: -4.4 });
  Pr(
    "receiptCoin-1",
    arc(
      "receiptCoin-1",
      P(14.4, 13, -4.4),
      P(1.5, -1.0, -3.0),
      67700,
      68700,
      2.5,
      "easeInOutCubic",
    ),
  );
  Pr(
    "receiptCoin-1",
    arc("receiptCoin-1", P(1.5, -1.0, -3.0), P(1.5, -1.6, -3.2), 68800, 69100, 0.3, "easeOutBack"),
  );
  Pr("receiptCoin-1", drop("receiptCoin-1", "coinSlot", 69200)); // clunk + tiny bounce
  C("ping", 69200, { x: 1.5, y: -1.6, z: -3.2 });
  C("pop", 70200, { x: 16, y: 13.6, z: -6 }); // satellite confetti cannon

  // Accountants at their posts, facing them; accountant-1 catches the coin.
  A("accountant-1", holdAt("receiptTray", 64000, 7000, "work"));
  A("accountant-1", faceTo("receiptTray", 64050, 6900));
  A("accountant-1", poseOf("react", 69250, 700)); // coin lands in the tray
  A("accountant-2", holdAt("vaultDoor", 64000, 7000, "work"));
  A("accountant-2", faceTo("vaultDoor", 64050, 6900));
  A("intern", holdAt("deskRowTrading", 64500, 6500, "idle"));
  A("intern", faceTo("slotWall", 64550, 6400)); // watches the exchange
}

// P7 celebration (71000-79000): conga chain (7 bots, phase offsets along the
// loop path), pole pile-up, foreman apart then swept in, coffee spin, intern
// elevated flanked by two, deadpan accountants, discrepancy beat, confetti.
{
  // Six riders (runner-b dropped: the loop folds tightly at the stamp-desk
  // corner, so the widest stagger that still clears the P8 holds wins).
  const CONGA = ["analyst", "runner-a", "runner-c", "runner-d", "ambient-4", "gunner"] as const;
  // Half-lap sweep: the v2 world's congaLoop is 83 units, so a full lap in
  // the celebration window would exceed the 8 units/s retiming discipline.
  CONGA.forEach((actorId, i) => {
    A(actorId, mv("congaLoop", 71050 + i * 450, 71050 + i * 450 + 5800, "linear", 0, 0.5));
  });
  C("bongo", 71500);
  C("bongo", 73500);
  C("bongo", 75500);
  C("bongo", 77500);

  // Mild pile-up at the pole (poses override the conga walk briefly).
  A("runner-d", poseOf("collide", 73000, 700));
  A("ambient-4", poseOf("collide", 73100, 700));
  A("ambient-4", poseOf("react", 73800, 600)); // bounces off
  C("clack", 73050, { effect: "poleDust", x: 3, y: -1.4, z: 5.5 });

  // Foreman resists (apart, at his slot), then gets swept in.
  A("foreman", holdAt("briefing", 71100, 800, "idle"));
  A("foreman", poseOf("argue", 71500, 1500));
  A("foreman", holdAt("briefing", 73200, 800, "idle"));
  A("foreman", mv("congaLoop", 74000, 78500, "linear", 0, 0.35));
  A("foreman", poseOf("celebrate", 74200, 4000)); // secretly enjoys it

  // Coffee bot spins on the machine.
  A("coffee", holdAt("coffee", 71500, 6000, "work"));
  A("coffee", poseOf("celebrate", 71800, 5600));

  // Intern elevated celebrate, flanked by two (slotted, no attachments).
  A("intern", holdAt("briefing", 72500, 5500, "celebrate"));
  A("ambient-1", holdAt("briefing", 72500, 5500, "celebrate"));
  A("ambient-2", holdAt("briefing", 72500, 5500, "celebrate"));

  // Deadpan accountants at their posts (deliberately NOT joining).
  A("accountant-1", holdAt("receiptTray", 71200, 7800, "work"));
  A("accountant-1", faceTo("receiptTray", 71250, 7700));
  A("accountant-2", holdAt("vaultDoor", 71200, 7800, "work"));
  A("accountant-2", faceTo("vaultDoor", 71250, 7700));
  A("accountant-1", poseOf("react", 75500, 900)); // discrepancy!
  C("tick", 75600, { effect: "paperBurst", x: 0.3, y: -1.4, z: -2.8 });
  C("tick", 75900, { x: 0.3, y: -1.4, z: -2.8 }); // correction tick
  A("accountant-1", poseOf("celebrate", 76200, 700)); // thumbs up

  C("pop", 75000, { effect: "confettiBurst", x: -1, y: 0.8, z: 0.5 }); // center burst
}

// P8 reconciliation (79000-86000): janitor sweeps along a visible path;
// accountants at the tray/vault facing their posts; staggered homeward holds
// (pole/stairs riders already arrived); vault closes; props return home.
{
  A("accountant-1", holdAt("receiptTray", 79200, 10800, "work"));
  A("accountant-1", faceTo("receiptTray", 79250, 10700));
  A("accountant-2", holdAt("vaultDoor", 79500, 6400, "work")); // sweeps
  A("accountant-2", faceTo("vaultDoor", 79550, 6300));
  A("janitor", mv("hatchApproachTrading", 79500, 81200, "easeInOutCubic", 0, 0.5)); // visible sweep
  A("janitor", holdAt("briefing", 81300, 200, "work"));

  // Homeward (staggered so streams read; authored cuts where no upward path
  // exists; all end at 90000 so the seam frame is the home rest state).
  A("runner-a", holdAt("conveyorIn", 79400, 10600, "idle"));
  A("runner-b", holdAt("conveyorOut", 79500, 10500, "idle"));
  A("runner-c", holdAt("poleTopLoft", 79600, 10400, "idle"));
  A("runner-d", holdAt("queueTail", 79400, 10600, "idle"));
  A("analyst", holdAt("tickerBoard", 79700, 10300, "idle"));
  A("ambient-4", holdAt("deskRowTrading", 79800, 10200, "idle"));
  A("ambient-1", holdAt("stairTopLoft", 79900, 10100, "idle"));
  A("ambient-2", holdAt("stairBottomLoft", 79950, 10050, "idle"));
  A("gunner", holdAt("cannon", 79500, 10500, "idle"));
  A("guard-1", holdAt("stampDesk", 79200, 10800, "idle"));
  A("guard-2", holdAt("queueHead", 79300, 10700, "idle"));
  A("foreman", holdAt("briefing", 78600, 11400, "idle"));
  A("intern", holdAt("deskRowTrading", 80000, 6000, "idle"));
  A("coffee", holdAt("coffee", 80000, 10000, "work"));

  // Props home: janitor restocks crate-a; runner-d sets crate-b down; the
  // orb and coin return to their hidden home anchors.
  Pr("crate-a", grab("janitor", "crate-a", "carry", 81500));
  A("janitor", holdAt("briefing", 81500, 2700, "carry")); // hoists crate-a home
  Pr("crate-a", drop("crate-a", "crate-aHome", 84200));
  Pr("crate-b", drop("crate-b", "crate-bHome", 84300));
  Pr(
    "orderOrb",
    arc("orderOrb", P(17.2, 13.4, -7.0), P(-7.4, -1.8, -2.7), 81500, 83500, 3, "easeInOutCubic"),
  );
  Pr("orderOrb", drop("orderOrb", "breech", 83600));
  Pr(
    "receiptCoin-1",
    arc("receiptCoin-1", P(1.5, -1.6, -3.2), P(14.4, 13, -4.4), 82000, 84000, 3, "easeInOutCubic"),
  );
  Pr("receiptCoin-1", drop("receiptCoin-1", "mintStation", 84100));
}

// P9 wind_down (86000-90000): mood eases back to 1.0; intern sneaks back to
// type (the one warm pool); time clock winds 09:00 -> 08:59; everyone settled
// at home; seam frame equals the P0 frame.
{
  A("intern", holdAt("deskRowTrading", 86100, 3900, "work"));
  A("janitor", holdAt("briefing", 86100, 3900, "idle"));
  A("accountant-2", holdAt("vaultDoor", 86100, 3900, "idle"));
  C("clack", 87800); // clock winds back
}

export const centralPlotFragment: Fragment = {
  id: "central-plot",
  reservedActors: [],
  actors: ACTORS,
  props: PROPS,
};
