/**
 * ZONE LOOP fragments for the campus center: PLAN/ACTIVATION and GAUNTLET
 * (R5 story wave). Pure data only — relative times inside each cycle; the
 * story kernel (story/beats.ts) expands, merges, and validates.
 *
 * Cycle-varying gags CANNOT live in the repeating fragment table (every
 * expansion instance is identical), so each gag is exported as its own
 * RELATIVE-TIME table plus the cycle instances it replaces. Kernel contract:
 * for the listed instances, DROP that actor's base windows inside the gag's
 * time span and SPLICE the gag windows at phase + k*cycleMs + relative.
 * All gag windows already avoid channel overlap as base-window replacements.
 *
 * Machine channels assumed (kernel-owned, do not author here): scannerSweep
 * (gauntlet scanner pulse), the scanner sweep and belt slats are NOT
 * per-actor commands. No named story props (crate-a..d) are used — belt
 * business reads from poses, expressions, glyphs, and cues only.
 */

import {
  asActorId,
  asWaypointId,
  type ActorCommand,
  type BeamCommand,
  type Expression,
  type ExpressCommand,
  type GlyphCommand,
  type GlyphId,
} from "../../types";
import { ax, cue, faceTo, holdAt, mv, poseOf } from "./authoring";
import type { Fragment, FragmentActorCommand } from "./types";

const ids = (names: readonly string[]) => names.map(asActorId);

// Local pure-data constructors for the v2 channels (no authoring helpers
// exist for express/glyph yet; keep them here until promoted to authoring.ts).
const expressOf = (
  actorId: string,
  expression: Expression,
  startMs: number,
  endMs: number,
): ExpressCommand => ({
  kind: "express",
  actorId: asActorId(actorId),
  expression,
  startMs,
  endMs,
});

const glyphOf = (
  actorId: string,
  glyph: GlyphId,
  startMs: number,
  durationMs: number,
): GlyphCommand => ({
  kind: "glyph",
  actorId: asActorId(actorId),
  glyph,
  startMs,
  durationMs,
});

// ---------------------------------------------------------------------------
// PLAN / ACTIVATION (cycle 15000, foreman)
// ---------------------------------------------------------------------------

const planActors: FragmentActorCommand[] = [];
{
  const A = (command: ActorCommand): void => {
    planActors.push(ax("foreman", command));
  };

  // Rest == start state: foreman idles at his desk (home: briefing/planDesk).
  A(holdAt("planDesk", 0, 1000, "idle"));

  // Stamp beat: works the TRADE.md on the desk, stamp lands (tick cue).
  // NOTE FOR KERNEL: no TRADE.md prop exists yet — the stamp/slide are cue
  // details; if a `tradeDoc` prop lands, add followArc(planDesk ->
  // activationSlot) at 5600-6600 in this window.
  A(holdAt("planDesk", 1000, 6500, "work"));
  A(expressOf("foreman", "happy", 1200, 5000));
  A(cue("tick", 3000, { effect: "stamp" })); // stamp lands on TRADE.md
  A(cue("tick", 5800, { effect: "slide", from: "planDesk", to: "activationSlot" })); // doc slides into the slot

  // Nod: satisfied idle bounce after the doc drops in.
  A(poseOf("react", 7600, 800));
  A(holdAt("planDesk", 7500, 1500, "idle"));

  // Rest tail; rest state == start state (idle at planDesk).
  A(holdAt("planDesk", 9000, 6000, "idle"));
}

/** Cycle-3 clipboard gag (relative times). Replaces the foreman's base
 * windows in [1000, 9000) — motion, express, and cues — of instance 3 only. */
export const PLAN_CLIPBOARD_GAG: readonly FragmentActorCommand[] = (() => {
  const g: FragmentActorCommand[] = [];
  const A = (command: ActorCommand): void => {
    g.push(ax("foreman", command));
  };
  // Stamp comes down on his own clipboard instead of the doc: bonk.
  A(holdAt("planDesk", 1000, 900, "work"));
  A(cue("clack", 3000)); // the bonk
  // Stagger react + anger; clipboard flips (kernel: accessory rotate anim).
  A(poseOf("react", 3100, 900));
  A(expressOf("foreman", "angry", 3100, 6000));
  A(glyphOf("foreman", "anger", 3100, 2100));
  // Shakes his head at the flipped clipboard.
  A(poseOf("argue", 4200, 1300));
  A(holdAt("planDesk", 5500, 1500, "idle"));
  // Re-stamps correctly and slides it, satisfied.
  A(holdAt("planDesk", 7000, 2000, "work"));
  A(cue("tick", 7600, { effect: "stamp" }));
  A(expressOf("foreman", "happy", 7100, 8800));
  A(holdAt("planDesk", 9000, 1000, "idle"));
  return g;
})();

export const PLAN_FRAGMENT: Fragment = {
  id: "zone-plan",
  zone: "plan",
  cycleMs: 15000,
  reservedActors: ids(["foreman"]),
  // ALARM borrows the foreman for the 46000-52000 scramble.
  interruptionWindows: [{ actorId: asActorId("foreman"), fromMs: 46000, toMs: 52000 }],
  actors: planActors,
  props: [],
};

// ---------------------------------------------------------------------------
// GAUNTLET (cycle 10000, runner-a/b/d + janitor + ambient-2; risk zone's
// guard-1/guard-2 share this block and are reserved here)
// ---------------------------------------------------------------------------

const gauntletActors: FragmentActorCommand[] = [];
{
  const A = (actorId: string, command: ActorCommand): void => {
    gauntletActors.push(ax(actorId, command));
  };

  // runner-a (loader, home gauntletIn): loads crates onto the belt, one
  // startle beat as the belt lurches, then rests.
  A("runner-a", holdAt("gauntletIn", 0, 4500, "work"));
  A("runner-a", expressOf("runner-a", "happy", 500, 4000));
  A("runner-a", cue("tick", 1500, { effect: "loadClunk" })); // crate onto belt
  A("runner-a", poseOf("react", 4500, 700)); // belt lurch startle
  A("runner-a", holdAt("gauntletIn", 5200, 4800, "idle"));

  // runner-b (unloader, home gauntletOut): waits bored, unloads at the far
  // end, happy with the clean catch, rests.
  A("runner-b", holdAt("gauntletOut", 0, 3500, "idle"));
  A("runner-b", expressOf("runner-b", "bored", 500, 3000));
  A("runner-b", holdAt("gauntletOut", 3500, 3500, "work"));
  A("runner-b", expressOf("runner-b", "happy", 3500, 6500));
  A("runner-b", cue("tick", 4500, { effect: "unloadThump" }));
  A("runner-b", holdAt("gauntletOut", 7000, 3000, "idle"));

  // runner-d (queue tail, home queueBack): waits in line, shrugs, keeps
  // waiting. The queue-jump attempt is the every-2nd-cycle gag below.
  A("runner-d", holdAt("queueBack", 0, 10000, "idle"));
  A("runner-d", expressOf("runner-d", "bored", 1000, 6000));
  A("runner-d", poseOf("react", 8000, 600));

  // janitor (gauntlet zone, home briefing): sweeps his corner; a wide
  // interruption window lets the central plot borrow him for the
  // confetti sweep at the ferry dock (68000-82000).
  A("janitor", holdAt("briefing", 0, 2000, "idle"));
  A("janitor", holdAt("briefing", 2000, 5000, "work"));
  A("janitor", holdAt("briefing", 7000, 3000, "idle"));

  // ambient-2 (home stairBottomLoft): background loiterer; flinches when
  // anything clatters near the reject chute, settles back down.
  A("ambient-2", holdAt("stairBottomLoft", 0, 6000, "idle"));
  A("ambient-2", poseOf("react", 6000, 800));
  A("ambient-2", expressOf("ambient-2", "surprised", 6000, 7500));
  A("ambient-2", holdAt("stairBottomLoft", 6800, 3200, "idle"));

  // guard-1 (risk, home stampDesk): works the stamp station all cycle.
  A("guard-1", holdAt("stampStation", 0, 8000, "work"));
  A("guard-1", holdAt("stampStation", 8000, 2000, "idle"));
  A("guard-1", expressOf("guard-1", "bored", 8200, 9800));

  // guard-2 (risk, home queueHead): watches the queue head, turns to scan
  // the belt mouth once per cycle.
  A("guard-2", holdAt("queueFront", 0, 10000, "work"));
  A("guard-2", faceTo("gauntletIn", 2000, 1800));
  A("guard-2", faceTo("queueFront", 4000, 1500));
}

/** Every-3rd-cycle REJECT gag (relative times). Replaces runner-a's base
 * windows in [0, 7000) (motion + express) and runner-b's base EXPRESS windows
 * in [0, 6500); the react-chorus entries (runner-b poses/cue, ambient-2
 * glyph, janitor pose) ride on top of unchanged base windows. No prop: the
 * "crate" is mimed — the red X and the bin clack are cues, the toss is a
 * carry pose at the chute mouth. */
export const GAUNTLET_REJECT_GAG: readonly FragmentActorCommand[] = (() => {
  const g: FragmentActorCommand[] = [];
  const A = (actorId: string, command: ActorCommand): void => {
    g.push(ax(actorId, command));
  };

  // runner-a: loader panic — the scanner just rejected his crate.
  A("runner-a", holdAt("gauntletIn", 0, 2000, "work"));
  A("runner-a", cue("tick", 2000, { effect: "rejectMark" })); // red X flash on the scanner
  A("runner-a", poseOf("react", 2000, 1200));
  A("runner-a", expressOf("runner-a", "panic", 2000, 4500));
  A("runner-a", glyphOf("runner-a", "alarm", 2000, 2000));
  // Sheepish re-load next beat (this cycle's tail reads as the recovery).
  A("runner-a", holdAt("gauntletIn", 3400, 3600, "work"));
  A("runner-a", expressOf("runner-a", "bored", 4600, 6600));
  A("runner-a", cue("tick", 5000, { effect: "loadClunk" }));
  A("runner-a", holdAt("gauntletIn", 7000, 3000, "idle"));

  // runner-b: dodges the rejected crate arcing past him, then mimes the
  // bin toss down the chute (carry pose + bin clack cue).
  A("runner-b", poseOf("react", 2400, 800));
  A("runner-b", expressOf("runner-b", "surprised", 2400, 3800));
  A("runner-b", poseOf("carry", 3300, 900));
  A("runner-b", cue("clack", 4300, { effect: "binDrop", at: "rejectBin" }));

  // ambient-2: the chute clatter spooks him properly this time.
  A("ambient-2", glyphOf("ambient-2", "question", 4300, 1800));

  // janitor: glances over at the commotion, goes back to sweeping.
  A("janitor", poseOf("react", 2500, 700));
  return g;
})();

/** Every-2nd-cycle QUEUE-JUMP gag (relative times). Replaces runner-d's base
 * windows in [0, 8000) (motion + express; the 8000 poseOf stays) and
 * guard-2's base motion window [0, 10000) plus express windows. runner-d
 * bolts down the gate queue shortcut, guard-2 arm-blocks him, runner-d
 * slinks back to the tail. */
export const GAUNTLET_QUEUEJUMP_GAG: readonly FragmentActorCommand[] = (() => {
  const g: FragmentActorCommand[] = [];
  const A = (actorId: string, command: ActorCommand): void => {
    g.push(ax(actorId, command));
  };

  // runner-d: shortcut dash to the head of the line (forward-only paths —
  // gateQueue runs queueBack -> stampStation), nose-to-nose with guard-2 at
  // queueFront, then sent to the BACK of the line with a short reluctant
  // beam hop (no reverse path exists for a walked slink; kernel may add a
  // queueReturn path and swap the beam for a slow mv).
  A("runner-d", mv("gateQueue", 500, 2400, "easeOutQuad", 0, 0.5));
  A("runner-d", holdAt("queueFront", 2400, 2200, "idle"));
  // Blocked: react + angry under guard-2's outstretched arm, then deflated.
  A("runner-d", poseOf("react", 2500, 900));
  A("runner-d", expressOf("runner-d", "angry", 2500, 4600));
  A("runner-d", expressOf("runner-d", "bored", 4700, 6600));
  A("runner-d", {
    kind: "beam",
    actorId: asActorId("runner-d"),
    from: asWaypointId("queueFront"),
    to: asWaypointId("queueBack"),
    startMs: 4700,
    durationMs: 900,
  } satisfies BeamCommand);
  // Sulk at the tail for the rest of the cycle; rest == start state.
  A("runner-d", holdAt("queueBack", 5700, 4300, "idle"));

  // guard-2: the arm-block — react pose + angry + anger glyph, then
  // satisfied watchfulness (happy) for the rest of the cycle.
  A("guard-2", holdAt("queueFront", 0, 3000, "work"));
  A("guard-2", poseOf("react", 3000, 1000)); // arm out, full stop
  A("guard-2", expressOf("guard-2", "angry", 3000, 4800));
  A("guard-2", glyphOf("guard-2", "anger", 3100, 1700));
  A("guard-2", holdAt("queueFront", 4100, 4900, "work"));
  A("guard-2", expressOf("guard-2", "happy", 5000, 9000));
  A("guard-2", holdAt("queueFront", 9000, 1000, "idle"));
  return g;
})();

export const GAUNTLET_FRAGMENT: Fragment = {
  id: "zone-gauntlet",
  zone: "gauntlet",
  cycleMs: 10000,
  reservedActors: ids([
    "runner-a",
    "runner-b",
    "runner-d",
    "janitor",
    "ambient-2",
    "guard-1",
    "guard-2",
  ]),
  // Central plot may borrow the janitor for the confetti sweep; runner-a/b
  // for the check-9 panic / APPROVED wave; runner-b again for the PAUSE
  // glyph; janitor + ambient-2 for the ALARM scramble.
  interruptionWindows: [
    { actorId: asActorId("janitor"), fromMs: 66000, toMs: 83000 },
    { actorId: asActorId("janitor"), fromMs: 46000, toMs: 52000 },
    { actorId: asActorId("ambient-2"), fromMs: 46000, toMs: 52000 },
    { actorId: asActorId("runner-a"), fromMs: 23600, toMs: 28400 },
    { actorId: asActorId("runner-b"), fromMs: 28000, toMs: 30600 },
    { actorId: asActorId("runner-b"), fromMs: 75500, toMs: 77500 },
  ],
  actors: gauntletActors,
  props: [],
};
