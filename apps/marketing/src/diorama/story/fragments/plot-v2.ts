/**
 * CENTRAL PLOT fragment v2 (R5) — the crate's journey through the R2 world
 * (10-r5-content-spec.md, "Central plot" section), 8 phases on absolute
 * times inside the 90000 ms loop.
 *
 * This fragment owns NO actors and NO zone: it BORROWS zone-reserved actors
 * strictly inside their interruption windows. Because the zone fragments
 * land in parallel, the borrows are declared in BORROW_REQUESTS below and
 * authored here as if approved; the kernel reconciles the requests against
 * the zones' declared windows at merge (widening or trimming as needed).
 *
 * Props owned by this fragment: crate-a (the hero crate — born at the plan
 * desk, FORGED into the orderOrb at the mint press at ~34200, restocked at
 * its gauntlet home by the seam), orderOrb (hidden at the breech anchor at
 * rest; forged at the mint press, cable-ridden, fired, slotted), and
 * receiptCoin-1/2 (hidden at the mint-station home anchor at rest).
 * crate-b/c/d stay staged at their homes — background dressing only.
 *
 * Machine channels are NOT authored here (kernel owns them): scannerSweep
 * (gauntlet check visual), carouselStep/ramSlam (mint), cablePulse (vault
 * cable), flipBoard (launch board flips at FIRE), boatRow (ferry), plus the
 * ALARM beams (46000-52000) and the PAUSE worldTime freeze (74200-76400)
 * from global-gags.ts. Cues here are sparse audio/effect pops only.
 */

import { asActorId, asWaypointId } from "../../types";
import type { ActorCommand, Expression, GlyphId, WaypointId } from "../../types";
import { P, arc, ax, cue, drop, faceTo, grab, holdAt, poseOf } from "./authoring";
import type {
  Fragment,
  FragmentActorCommand,
  FragmentPropCommand,
  InterruptionWindow,
} from "./types";

// ---------------------------------------------------------------------------
// Local v2 command constructors (beam / glyph / express) — same inline pattern
// as global-gags.ts; authoring.ts does not provide them yet.
// ---------------------------------------------------------------------------

const beam = (
  actorId: string,
  from: WaypointId,
  to: WaypointId,
  t0: number,
  dur: number,
): ActorCommand => ({
  kind: "beam",
  actorId: asActorId(actorId),
  from,
  to,
  startMs: t0,
  durationMs: dur,
});

const glyph = (actorId: string, g: GlyphId, t0: number, dur: number): ActorCommand => ({
  kind: "glyph",
  actorId: asActorId(actorId),
  glyph: g,
  startMs: t0,
  durationMs: dur,
});

const express = (
  actorId: string,
  expression: Expression,
  t0: number,
  t1: number,
): ActorCommand => ({
  kind: "express",
  actorId: asActorId(actorId),
  expression,
  startMs: t0,
  endMs: t1,
});

// Local construction sinks (module-private; fragments never share state).
const ACTORS: FragmentActorCommand[] = [];
const PROPS: FragmentPropCommand[] = [];

/**
 * Narration cues ride an unobtrusive shared-extra actor track (fireCue has
 * no duration and never touches motion/expression channels, so borrowing
 * ambient-6's track is legal even while the docks zone loop uses him).
 */
const CUE_ACTOR = "ambient-6";

const A = (actorId: string, command: ActorCommand): void => {
  ACTORS.push(ax(actorId, command));
};
const Pr = (entry: FragmentPropCommand): void => {
  PROPS.push(entry);
};
const C = (cueId: string, t: number, detail?: Readonly<Record<string, number | string>>): void => {
  ACTORS.push(ax(CUE_ACTOR, cue(cueId, t, detail)));
};

// Station coordinates (story/waypoints.ts STATIONS) inlined for prop arcs.
const PLAN_DESK = P(-5.5, 0, -2);
const ACTIVATION_SLOT = P(-5.5, 0, 1.6);
const GAUNTLET_IN = P(-4, 0, 7);
const CHECK_MID = P(0.5, 0, 7); // ~check 5
const CHECK_NINE = P(2.5, 0, 7); // the scary pause
const GAUNTLET_OUT = P(5, 0, 7);
const MINT_PRESS = P(7.5, 0, -2);
const MINT_COIN = P(7.9, 0.4, -1.6); // gag coin pops out here, upside down
const MINT_COIN_LAND = P(8.3, 0, -1.6);
const VAULT_CUBE = P(7, 3.2, -12);
const BREECH = P(12.5, 0.8, 1); // cannon mouth at the launch bay
const PINBALL_A = P(10.5, 0, 2.5);
const PINBALL_B = P(13.5, 0, -0.5);
const PIPE_MOUTH = P(13.5, 4, 2);
const PIPE_ARRIVAL = P(19, 6.5, -6);
const SLOT_WALL = P(20.2, 6.5, -7);
const MINT_STATION = P(17.8, 6.5, -5);
const COIN_POP = P(17.8, 7.1, -5);
const FERRY_DOCK = P(17.5, 0, 4);
const TRUTH_MONOLITH = P(17.5, 0, 8.5);

// ---------------------------------------------------------------------------
// P1 activation + street ride (0-8000): the TRADE.md is stamped at the plan
// desk (machine stamp cue; the foreman's own gag lives in the plan zone
// loop), crate-a is born, slides into the activation slot and rides the
// street down to the gauntlet mouth.
// ---------------------------------------------------------------------------
{
  C("stamp", 1600, { effect: "stampDust", variant: "approve", x: -5.5, y: 0.4, z: -2 });
  Pr(arc("crate-a", PLAN_DESK, ACTIVATION_SLOT, 1200, 2400, 1, "easeInOutCubic"));
  C("clack", 2450, { x: -5.5, y: 0, z: 1.6 }); // slot drop
  Pr(arc("crate-a", ACTIVATION_SLOT, GAUNTLET_IN, 3000, 7400, 0.6, "easeInQuad"));
  C("ping", 7600, { x: -4, y: 0.4, z: 7 }); // enters the gauntlet
}

// ---------------------------------------------------------------------------
// P2 gauntlet pass (8000-30000): crate-a rides the belt through the checks.
// The 14-check visual is the scannerSweep machine channel; the stamped cue
// peaks here are sparse audio pops. ONE scary pause at check 9: the belt
// stalls ~1.2 s, loader runner-a panics (borrow), then it PASSES — APPROVED
// stamp, cheer pop — and runner-b waves it off at gauntletOut (borrow).
// ---------------------------------------------------------------------------
{
  // Belt rides as free-prop arcs along the z = 7 street run.
  Pr(arc("crate-a", GAUNTLET_IN, CHECK_MID, 8200, 14200, 0.2, "linear"));
  C("stamp", 9000, { effect: "stampDust", variant: "check", x: -2, y: 0.4, z: 7 });
  C("stamp", 15500, { effect: "stampDust", variant: "check", x: 0.5, y: 0.4, z: 7 });
  Pr(arc("crate-a", CHECK_MID, CHECK_NINE, 15000, 21200, 0.2, "linear"));

  // Check 9: belt stall (implicit stationary gap 21600-22900), loader panic.
  C("clack", 21700, { x: 2.5, y: 0.2, z: 7 }); // belt stall lurch
  A("runner-a", poseOf("react", 23800, 1400)); // loader freezes mid-lift
  A("runner-a", express("runner-a", "panic", 23800, 25200));
  A("runner-a", glyph("runner-a", "alarm", 23900, 1100));

  // ...then it passes. APPROVED.
  C("stamp", 22800, { effect: "stampDust", variant: "check", x: 2.5, y: 0.4, z: 7 });
  Pr(arc("crate-a", CHECK_NINE, GAUNTLET_OUT, 22900, 27600, 0.2, "linear"));
  C("stamp", 27400, { effect: "stampDust", variant: "approve", x: 5, y: 0.4, z: 7 });
  C("pop", 27600, { x: 5, y: 0.6, z: 7 }); // cheer pop
  A("runner-a", poseOf("celebrate", 27600, 700));
  A("runner-a", express("runner-a", "happy", 27600, 28300));
  A("runner-a", glyph("runner-a", "star", 27650, 700));

  // runner-b unloads at gauntletOut and waves the crate through (borrow).
  A("runner-b", holdAt("gauntletOut", 28100, 2400, "work"));
  A("runner-b", faceTo("mintPress", 28200, 400));
  A("runner-b", express("runner-b", "happy", 28400, 30400));
  A("runner-b", poseOf("react", 30200, 350)); // the little wave
}

// ---------------------------------------------------------------------------
// P3 cloid mint + upside-down coin gag (30000-42000): crate-a arcs into the
// mint press and is FORGED — the crate hides in the press core, the orb
// appears glowing (mint press double-slam cues; carouselStep/ramSlam are
// machine channels). runner-c beams in from the watch tower for the coin
// gag: one coin comes out UPSIDE DOWN, he stares (surprised + "?"), flicks
// it, it lands THE SAME WAY (determinism gag), he shrugs (bored) and beams
// home.
// ---------------------------------------------------------------------------
{
  Pr(arc("crate-a", GAUNTLET_OUT, MINT_PRESS, 30400, 33400, 1.5, "easeInOutCubic"));
  C("clack", 33500, { x: 7.5, y: 0.4, z: -2 }); // crate arrives at the press
  Pr(drop("crate-a", "mintCore", 34200)); // FORGED — crate hides inside the press

  // The orb appears at the press, glowing, until its cable ride (P4).
  Pr(arc("orderOrb", MINT_PRESS, MINT_PRESS, 34400, 41800, 0.01, "linear"));
  C("stamp", 34400, { effect: "stampDust", variant: "mint", x: 7.5, y: 0.8, z: -2 }); // slam 1
  C("stamp", 35600, { effect: "stampDust", variant: "mint", x: 7.5, y: 0.8, z: -2 }); // slam 2

  // runner-c beams in for the gag (home watchTower -> mintPress).
  A(
    "runner-c",
    beam("runner-c", asWaypointId("watchTower"), asWaypointId("mintPress"), 33800, 900),
  );
  A("runner-c", holdAt("mintPress", 34800, 5600, "idle"));
  A("runner-c", faceTo("mintPress", 34900, 400));

  // The upside-down coin mints out beside the press.
  Pr(arc("receiptCoin-2", MINT_PRESS, MINT_COIN, 35600, 36200, 0.3, "easeOutBack"));

  // Stare, flick, lands the same way, shrug, beam home.
  A("runner-c", express("runner-c", "surprised", 35200, 36600));
  A("runner-c", glyph("runner-c", "question", 35300, 1300));
  A("runner-c", poseOf("react", 36300, 500)); // the flick
  Pr(arc("receiptCoin-2", MINT_COIN, MINT_COIN_LAND, 36400, 37200, 0.8, "easeOutBack"));
  A("runner-c", poseOf("react", 37400, 600)); // the shrug
  A("runner-c", express("runner-c", "bored", 37400, 39800));
  A(
    "runner-c",
    beam("runner-c", asWaypointId("mintPress"), asWaypointId("watchTower"), 40600, 900),
  );
  C("ping", 37000, { x: 7.5, y: 1.0, z: -2 }); // coin glow pulse
}

// ---------------------------------------------------------------------------
// P4 vault cable + launch (42000-56600): the orb rides the armored cable up
// to the vault cube (cablePulse machine channel), pulses at the edge, rides
// back down to the cannon. gunner cranks (borrow 42000-56200), JAMS
// (panic), intern beams in to join the crank (borrow 45900-56200),
// OVERPRESSURE: the orb pops out and pinballs 3 bounces across the launch
// bay (dodges with panic glyphs), self-loads into the breech, a held-breath
// freeze, the cheer (star glyphs), then FIRE — whoosh + cannonSmoke; the
// flipBoard flip is a machine channel (noted, not authored).
// ---------------------------------------------------------------------------
{
  // gunner: cranking at the cannon the whole window.
  A("gunner", holdAt("launchBay", 42100, 13100, "work"));
  A("gunner", faceTo("vaultCube", 42200, 400));
  // KERNEL RULING (merge): the ALARM wave skips the on-duty launch crew —
  // gunner and intern each get one mid-crank react-glance at the racket.
  A("gunner", poseOf("react", 48000, 600));

  // Cable ride up, vault hold, ride back down.
  Pr(arc("orderOrb", MINT_PRESS, VAULT_CUBE, 42200, 44800, 0.8, "easeInOutCubic"));
  C("clack", 44900, { x: 7, y: 3.4, z: -12 }); // vault clunk
  Pr(arc("orderOrb", VAULT_CUBE, VAULT_CUBE, 45000, 47000, 0.01, "linear")); // parked at the vault edge
  C("ping", 47000, { x: 7, y: 3.6, z: -12 }); // edge pulse (cablePulse carries the visual)
  Pr(arc("orderOrb", VAULT_CUBE, BREECH, 47300, 50200, 0.8, "easeInOutCubic"));

  // Jam: gunner panics at the gauge.
  A("gunner", poseOf("react", 50400, 1000));
  A("gunner", express("gunner", "panic", 50400, 51250));
  A("gunner", glyph("gunner", "anger", 50450, 800));

  // Intern beams in to join the crank.
  A(
    "intern",
    beam("intern", asWaypointId("backOfficeDeskB"), asWaypointId("launchBay"), 46000, 900),
  );
  A("intern", holdAt("launchBay", 47000, 4200, "work"));
  A("intern", poseOf("react", 48300, 600)); // the ruling's mid-crank glance

  // OVERPRESSURE: orb pops and pinballs; both bots dodge (panic glyphs).
  Pr(arc("orderOrb", BREECH, PINBALL_A, 51200, 51600, 0.5, "easeOutQuad"));
  C("clack", 51250, { x: 12.5, y: 0.8, z: 1 }); // the pop
  A("gunner", poseOf("react", 51250, 1200));
  A("gunner", glyph("gunner", "alarm", 51300, 1000));
  A("intern", poseOf("react", 51300, 1200));
  A("intern", express("intern", "panic", 51300, 52450));
  A("intern", glyph("intern", "alarm", 51350, 1000));
  Pr(arc("orderOrb", PINBALL_A, PINBALL_B, 51700, 52100, 0.5, "easeOutQuad"));
  C("clack", 51700, { x: 10.5, y: 0.4, z: 2.5 });
  Pr(arc("orderOrb", PINBALL_B, BREECH, 52200, 52500, 0.4, "easeOutQuad")); // self-loads
  C("clack", 52250, { x: 13.5, y: 0.4, z: -0.5 });
  Pr(drop("orderOrb", "breech", 52600));

  // Held breath (surprised expressions, no motion 52500-52900), then cheer.
  A("gunner", express("gunner", "surprised", 51300, 52450));
  A("intern", express("intern", "surprised", 52500, 52950));
  A("gunner", poseOf("celebrate", 53000, 900));
  A("gunner", express("gunner", "happy", 53000, 54000));
  A("gunner", glyph("gunner", "star", 53050, 900));
  A("intern", poseOf("celebrate", 53050, 900));
  A("intern", express("intern", "happy", 53050, 54000));
  A("intern", glyph("intern", "star", 53150, 900));
  C("pop", 53000, { x: 12.5, y: 1.2, z: 1 });

  // FIRE through the pipe mouth toward the exchange pad. flipBoard = machine.
  C("whoosh", 54600, { effect: "cannonSmoke", x: 12.5, y: 1.0, z: 1 });
  A("gunner", poseOf("react", 54600, 600)); // recoil
  Pr(arc("orderOrb", BREECH, PIPE_MOUTH, 54600, 55200, 0.6, "linear"));
  Pr(arc("orderOrb", PIPE_MOUTH, PIPE_ARRIVAL, 55250, 56400, 1, "easeOutQuad"));

  // Wind-down of the borrows: gunner settles, intern beams back to the desk.
  A("gunner", holdAt("launchBay", 55200, 900, "idle"));
  A(
    "intern",
    beam("intern", asWaypointId("launchBay"), asWaypointId("backOfficeDeskB"), 55300, 800),
  );
}

// ---------------------------------------------------------------------------
// P5 exchange catch + nothing-beat + coin return (56600-68000): the exchange
// arm catches the orb and slots it (slot pulse), then a 700 ms NOTHING-beat
// — ambient-5 leans in, nothing happens (borrow) — then the receipt coin is
// minted at the satellite mint station and arcs back down the receiptReturn
// fall to the ferry dock (ping), with the tape/green-row flash cue.
// ---------------------------------------------------------------------------
{
  Pr(arc("orderOrb", PIPE_ARRIVAL, SLOT_WALL, 57000, 57600, 0.3, "easeInOutCubic"));
  Pr(drop("orderOrb", "slotAnchorV2", 57700));
  C("ping", 57700, { x: 20.2, y: 6.7, z: -7 }); // slot pulse

  // The nothing-beat: ambient-5 leans toward the slot wall. Nothing.
  A("ambient-5", holdAt("launchBay", 57400, 1200, "idle"));
  A("ambient-5", faceTo("pipeMouth", 57500, 400));
  A("ambient-5", poseOf("react", 57800, 700));
  A("ambient-5", express("ambient-5", "surprised", 57700, 58500));

  // Coin minted on the pad, then the receiptReturn falling arc to the dock.
  C("ping", 59000, { x: 17.8, y: 6.9, z: -5 }); // mint ping
  Pr(arc("receiptCoin-1", MINT_STATION, COIN_POP, 59000, 59400, 0.2, "easeOutBack"));
  Pr(arc("receiptCoin-1", COIN_POP, FERRY_DOCK, 59500, 63800, 0.5, "easeInOutCubic"));
  C("ping", 63900, { x: 17.5, y: 0.4, z: 4 }); // coin lands at the dock
  C("tick", 65000, { effect: "tapeFlash", x: 20.2, y: 6.5, z: -7 }); // green row flash
}

// ---------------------------------------------------------------------------
// P6 ferry compare + confetti + sweep (67900-83200): accountant-2 rows the
// coin across to the truth monolith (boatRow machine channel), compares
// ("?" then heart — balanced!), files it; confetti pops at center and the
// janitor beams in to sweep it up (borrow 77900-83200). accountant-1 files
// the ledger side (borrow). The PAUSE worldTime freeze (74200-76400,
// global-gags) freezes the confetti mid-air — coffee is the mid-sip freeze
// victim at the oil bar (borrow 73800-76200).
// ---------------------------------------------------------------------------
{
  // accountant-2: rows, compares, files.
  A("accountant-2", holdAt("ferryDock", 68000, 13800, "work"));
  A("accountant-2", faceTo("truthMonolith", 68100, 400));
  Pr(grab("accountant-2", "receiptCoin-1", "carry", 68100)); // coin aboard the ferry
  A("accountant-2", express("accountant-2", "happy", 69000, 70000));
  A("accountant-2", glyph("accountant-2", "question", 70500, 900)); // compares...
  A("accountant-2", poseOf("react", 70500, 800));
  Pr(drop("receiptCoin-1", "ferryBoat", 71500)); // onto the boat for the crossing
  Pr(arc("receiptCoin-1", FERRY_DOCK, TRUTH_MONOLITH, 71600, 72300, 0.4, "easeInOutCubic"));
  Pr(drop("receiptCoin-1", "monolithSlot", 72400)); // filed — balanced!
  A("accountant-2", glyph("accountant-2", "heart", 71600, 1000));
  A("accountant-2", express("accountant-2", "happy", 71600, 72600));

  // accountant-1: ledger side, then the confetti delight.
  A("accountant-1", holdAt("backOfficeDeskA", 68000, 7100, "work"));
  A("accountant-1", faceTo("ferryDock", 68100, 400));
  A("accountant-1", poseOf("celebrate", 74200, 800));
  A("accountant-1", express("accountant-1", "happy", 74200, 75100));
  A("accountant-1", glyph("accountant-1", "heart", 74200, 900));
  A("accountant-1", holdAt("backOfficeDeskA", 75200, 6800, "work")); // files it

  // Confetti at the center of the crossing (frozen mid-air by the PAUSE).
  C("pop", 74000, { effect: "confettiBurst", x: 17.5, y: 1.0, z: 6.2 });

  // coffee: the mid-sip freeze victim at the oil bar.
  A("coffee", holdAt("oilBar", 73950, 2100, "idle"));
  A("coffee", express("coffee", "happy", 73950, 76050));

  // janitor: beams in, sweeps the confetti, beams home.
  A("janitor", beam("janitor", asWaypointId("rejectBin"), asWaypointId("ferryDock"), 78100, 900));
  A("janitor", holdAt("ferryDock", 79100, 3100, "work"));
  C("tick", 80500, { effect: "sweepDust", x: 17.5, y: 0.2, z: 6.2 });
  A("janitor", beam("janitor", asWaypointId("ferryDock"), asWaypointId("rejectBin"), 82200, 800));
}

// ---------------------------------------------------------------------------
// P7 wind-down + returns (81900-90000): the intern sneaks back to type
// under the desk lamp; every remaining prop rides home so the seam frame
// equals the start frame (orb hidden at the breech, coins hidden at the
// mint-station home, a fresh crate-a restocked at its gauntlet home).
// ---------------------------------------------------------------------------
{
  A("intern", holdAt("backOfficeDeskB", 82100, 7800, "work")); // typing under the lamp
  C("tick", 83500, { effect: "lampGlow", x: 19.5, y: 0.6, z: -2 });

  // Props home (free-prop arcs; the "restock" beam-ups read as logistics churn).
  Pr(arc("receiptCoin-2", MINT_COIN_LAND, MINT_STATION, 82000, 84500, 2, "easeInOutCubic"));
  Pr(drop("receiptCoin-2", "mintStationHome", 84600));
  Pr(arc("receiptCoin-1", TRUTH_MONOLITH, MINT_STATION, 85000, 87500, 2, "easeInOutCubic"));
  Pr(drop("receiptCoin-1", "mintStationHome", 87600));
  Pr(arc("orderOrb", SLOT_WALL, BREECH, 85000, 88000, 2.5, "easeInOutCubic"));
  Pr(drop("orderOrb", "breech", 88100));
  Pr(arc("crate-a", MINT_PRESS, GAUNTLET_IN, 85000, 88400, 2, "easeInOutCubic"));
  Pr(drop("crate-a", "crate-aHome", 88500));
}

export const CENTRAL_PLOT_V2: Fragment = {
  id: "central-plot-v2",
  reservedActors: [],
  actors: ACTORS,
  props: PROPS,
};

// ---------------------------------------------------------------------------
// BORROW_REQUESTS — every zone-reserved actor this fragment commands, with
// the absolute window it needs. Authored as if approved; the kernel
// reconciles against the zone fragments' interruptionWindows at merge.
// ---------------------------------------------------------------------------

const windowFor = (actorId: string, fromMs: number, toMs: number): InterruptionWindow => ({
  actorId: asActorId(actorId),
  fromMs,
  toMs,
});

export const BORROW_REQUESTS: readonly InterruptionWindow[] = [
  windowFor("runner-a", 23600, 28400), // check-9 loader panic + APPROVED cheer
  windowFor("runner-b", 28000, 30600), // gauntletOut unload + wave
  windowFor("runner-c", 33700, 41600), // beams to mint; upside-down coin gag
  windowFor("gunner", 42000, 56200), // crank, jam, dodge, cheer, FIRE recoil
  windowFor("intern", 45900, 56200), // joins crank, dodge, cheer, beams home
  windowFor("intern", 81900, 89900), // sneaks back to type under the lamp
  windowFor("ambient-5", 57300, 58700), // exchange nothing-beat lean
  windowFor("accountant-1", 67900, 82100), // ledger side + confetti delight
  windowFor("accountant-2", 67900, 82100), // ferry row, compare, files the coin
  windowFor("coffee", 73800, 76200), // mid-sip PAUSE freeze victim
  windowFor("janitor", 77900, 83200), // beams in, sweeps confetti, beams home
];
