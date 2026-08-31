/**
 * R5 zone loops for the west bazaar edge: DOCKS and GREENHOUSE
 * (10-r5-content-spec.md sections 1-2).
 *
 * Pure data only. Commands use RELATIVE times in [0, cycleMs); the story
 * kernel (story/beats.ts compileFragments) expands them across the 90000 ms
 * loop and validates channels, seams, and booking.
 *
 * Casting note: the docks roster is a single ambient bot (ambient-6), so the
 * "rotating beamee" of the spec is ambient-6 itself playing double duty —
 * each cycle it IS the next arrival who discovers the tablet the previous
 * arrival left hovering. The per-Nth-cycle gags of the spec (docks cycle 3,
 * greenhouse cycle 2) cannot be expressed with identical per-cycle
 * expansion, so each gag is embedded as a readable beat inside every cycle.
 *
 * Machine motions the kernel owns and this file cannot command (handoff):
 * - DOCKS: the tablet dispenser glow/drop and the abandoned tablet's hover
 *   bob (approximated here by the "tick" retrieve cue and "?" glyph).
 * - GREENHOUSE: the plant scale-squash wilt after over-watering and the
 *   red->green data-bud mark swap (approximated by steamPuff cue, panic
 *   expression, "!" glyph and the heart-glyph recovery).
 */

import {
  asActorId,
  asWaypointId,
  type ActorCommand,
  type Expression,
  type GlyphId,
} from "../../types";
import { ax, cue, faceTo, faceYaw, holdAt, poseOf } from "./authoring";
import type { Fragment, FragmentActorCommand } from "./types";

// ---------------------------------------------------------------------------
// Local pure constructors for the v2 channels that authoring.ts does not yet
// wrap (express / glyph / beam). They only build plain command objects.
// ---------------------------------------------------------------------------

const beamHop = (
  actorId: string,
  from: string,
  to: string,
  t0: number,
  dur: number,
): ActorCommand => ({
  kind: "beam",
  actorId: asActorId(actorId),
  from: asWaypointId(from),
  to: asWaypointId(to),
  startMs: t0,
  durationMs: dur,
});

const glyphPop = (actorId: string, glyph: GlyphId, t0: number, dur: number): ActorCommand => ({
  kind: "glyph",
  actorId: asActorId(actorId),
  glyph,
  startMs: t0,
  durationMs: dur,
});

const expressAs = (
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

// ---------------------------------------------------------------------------
// DOCKS — cycle 15000 ms, actor: ambient-6.
//
// Every cycle: beam IN from the whiteboard to pad C (flash + "!" + surprised),
// discover the tablet the last arrival abandoned ("?" + happy retrieve),
// draw a fresh tablet from the dispenser, then beam OUT back to the
// whiteboard. Rest at cycle end == rest at cycle start (whiteboard).
// ---------------------------------------------------------------------------

const DOCKS_ACTORS: FragmentActorCommand[] = (() => {
  const A: FragmentActorCommand[] = [];
  const BEE = "ambient-6";
  // Pad C position for cue details (mirrors waypoints STATIONS.docksC).
  const PAD = { x: -18, y: 0.6, z: -6.2 };

  // Rest at the whiteboard (the beam source) until the hop.
  A.push(ax(BEE, holdAt("whiteboard", 0, 700, "idle")));

  // Beam IN: contract at the whiteboard, cut, expand on pad C.
  A.push(ax(BEE, cue("pop", 850, { effect: "beamFlash", ...PAD })));
  A.push(ax(BEE, beamHop(BEE, "whiteboard", "docksC", 800, 900)));
  A.push(ax(BEE, glyphPop(BEE, "alarm", 950, 1000))); // "!" on arrival
  A.push(ax(BEE, expressAs(BEE, "surprised", 950, 2200)));

  // On the pad: register the arrival, then notice the hovering tablet.
  A.push(ax(BEE, holdAt("docksC", 1750, 9050, "idle")));
  A.push(ax(BEE, faceTo("docksB", 2000, 600)));
  A.push(ax(BEE, glyphPop(BEE, "question", 2300, 1100))); // "?" — whose tablet?
  A.push(ax(BEE, expressAs(BEE, "happy", 2400, 4200)));
  A.push(ax(BEE, cue("tick", 2700, { effect: "tabletGrab", ...PAD })));
  A.push(ax(BEE, poseOf("react", 2800, 700))); // scoops it up

  // Fresh tablet from the dispenser (machine flash is the kernel's; the cue
  // and the work pose carry the action from the iso camera).
  A.push(ax(BEE, cue("ping", 5200, { effect: "dispenserDrop", x: -18.6, y: 0.8, z: -6.2 })));
  A.push(ax(BEE, poseOf("work", 5300, 1500)));

  // Idle glances while "reading" the tablet.
  A.push(ax(BEE, faceYaw(Math.PI, 7200, 700))); // looks down the pad row
  A.push(ax(BEE, faceTo("docksE", 8100, 700)));

  // Beam OUT toward the zone (back to the whiteboard rest).
  A.push(ax(BEE, cue("whoosh", 11000, { effect: "beamFlash", ...PAD })));
  A.push(ax(BEE, beamHop(BEE, "docksC", "whiteboard", 11050, 900)));

  // Rest at the whiteboard again — seam matches the cycle start.
  A.push(ax(BEE, holdAt("whiteboard", 12000, 3000, "idle")));

  return A;
})();

export const DOCKS_FRAGMENT: Fragment = {
  id: "zone-docks",
  zone: "docks",
  cycleMs: 15000,
  phaseMs: 0,
  reservedActors: [asActorId("ambient-6")],
  // ALARM borrows ambient-6 for the 46000-52000 scramble (plot narration
  // cues ride his track without a window; fireCue touches no channel).
  interruptionWindows: [{ actorId: asActorId("ambient-6"), fromMs: 46000, toMs: 52000 }],
  actors: DOCKS_ACTORS,
  props: [],
};

// ---------------------------------------------------------------------------
// GREENHOUSE — cycle 18000 ms, actors: researcher-1..6, analyst, ambient-3.
//
// researcher-1 tends the chart-plants (work, heart). researcher-2 tends the
// whiteboard rack. researcher-3 measures with oversized calipers (bored,
// dozes). researcher-4 over-waters: steamPuff, panic, "!" — then relief
// (perky again next cycle). researcher-5 gasps at the wilt. researcher-6
// polishes (happy, star). analyst stares at the red data-bud ("?",
// surprised), taps it — heart + happy (stand-in for the mark swap).
// ambient-3 dozes by the whiteboard. Everyone rests exactly where the cycle
// began (full-cycle holds).
// ---------------------------------------------------------------------------

const GREENHOUSE_ACTORS: FragmentActorCommand[] = (() => {
  const A: FragmentActorCommand[] = [];
  // Greenhouse bay / telescope positions for cue details (STATIONS mirrors).
  const BAY = { x: -11.5, y: 1.0, z: -4 };
  const BUD = { x: -9, y: 1.0, z: -5 };

  // Plant tender A: steady work, warm beat.
  A.push(ax("researcher-1", holdAt("greenhouse", 0, 18000, "work")));
  A.push(ax("researcher-1", faceTo("whiteboard", 100, 17800)));
  A.push(ax("researcher-1", poseOf("work", 4000, 1500)));
  A.push(ax("researcher-1", expressAs("researcher-1", "happy", 5000, 7500)));
  A.push(ax("researcher-1", glyphPop("researcher-1", "heart", 5600, 1400)));

  // Plant tender B at the whiteboard rack: quiet pruning with a paper rustle.
  A.push(ax("researcher-2", holdAt("whiteboard", 0, 18000, "work")));
  A.push(ax("researcher-2", faceTo("greenhouse", 100, 17800)));
  A.push(ax("researcher-2", poseOf("work", 9400, 1600)));
  A.push(ax("researcher-2", cue("tick", 9500, { effect: "paperBurst", x: -13.5, y: 1.0, z: -5 })));

  // Caliper measurer: bored to the point of napping, then a guilty resume.
  A.push(ax("researcher-3", holdAt("greenhouseTelescope", 0, 18000, "work")));
  A.push(ax("researcher-3", faceTo("greenhouse", 100, 17800)));
  A.push(ax("researcher-3", expressAs("researcher-3", "bored", 3000, 9000)));
  A.push(ax("researcher-3", glyphPop("researcher-3", "sleep", 4000, 2000)));
  A.push(ax("researcher-3", poseOf("idle", 9200, 2000)));
  A.push(ax("researcher-3", expressAs("researcher-3", "surprised", 11400, 12900)));

  // The over-waterer (gag): steam, panic, "!", then the plant perks back.
  A.push(ax("researcher-4", holdAt("greenhouse", 0, 18000, "work")));
  A.push(ax("researcher-4", faceTo("whiteboard", 100, 17800)));
  A.push(ax("researcher-4", poseOf("work", 4500, 1800))); // can swing...
  A.push(ax("researcher-4", cue("tick", 6000, { effect: "steamPuff", ...BAY })));
  A.push(ax("researcher-4", expressAs("researcher-4", "panic", 6100, 8800)));
  A.push(ax("researcher-4", glyphPop("researcher-4", "alarm", 6200, 1600)));
  A.push(ax("researcher-4", poseOf("react", 6300, 1200)));
  A.push(ax("researcher-4", cue("tick", 12100, { ...BAY }))); // recovery perk
  A.push(ax("researcher-4", expressAs("researcher-4", "happy", 12300, 14300)));
  A.push(ax("researcher-4", poseOf("celebrate", 12400, 900)));

  // Witness: gasps at the wilt, relieved sigh after.
  A.push(ax("researcher-5", holdAt("greenhouse", 0, 18000, "idle")));
  A.push(ax("researcher-5", faceTo("whiteboard", 100, 17800)));
  A.push(ax("researcher-5", poseOf("react", 6600, 900)));
  A.push(ax("researcher-5", expressAs("researcher-5", "surprised", 6650, 8200)));

  // Polisher at the whiteboard rack: happy little star beat.
  A.push(ax("researcher-6", holdAt("whiteboard", 0, 18000, "work")));
  A.push(ax("researcher-6", faceTo("greenhouse", 100, 17800)));
  A.push(ax("researcher-6", expressAs("researcher-6", "happy", 10000, 12400)));
  A.push(ax("researcher-6", glyphPop("researcher-6", "star", 10600, 1500)));

  // Analyst and the red data-bud: stare, "?", tap, heart (mark-swap stand-in).
  A.push(ax("analyst", holdAt("greenhouseTelescope", 0, 18000, "idle")));
  A.push(ax("analyst", faceTo("greenhouse", 100, 17800)));
  A.push(ax("analyst", poseOf("react", 2500, 700)));
  A.push(ax("analyst", expressAs("analyst", "surprised", 2400, 5200)));
  A.push(ax("analyst", glyphPop("analyst", "question", 3000, 1600)));
  A.push(ax("analyst", cue("tick", 6800, { ...BUD }))); // THE tap
  A.push(ax("analyst", expressAs("analyst", "happy", 7200, 9800)));
  A.push(ax("analyst", glyphPop("analyst", "heart", 7600, 1600)));
  A.push(ax("analyst", poseOf("celebrate", 8300, 800)));

  // Ambient dozer by the whiteboard.
  A.push(ax("ambient-3", holdAt("whiteboard", 0, 18000, "idle")));
  A.push(ax("ambient-3", faceTo("greenhouse", 100, 17800)));
  A.push(ax("ambient-3", expressAs("ambient-3", "bored", 12800, 16000)));
  A.push(ax("ambient-3", glyphPop("ambient-3", "sleep", 13000, 2600)));

  return A;
})();

export const GREENHOUSE_FRAGMENT: Fragment = {
  id: "zone-greenhouse",
  zone: "greenhouse",
  cycleMs: 18000,
  phaseMs: 4000,
  reservedActors: [
    asActorId("researcher-1"),
    asActorId("researcher-2"),
    asActorId("researcher-3"),
    asActorId("researcher-4"),
    asActorId("researcher-5"),
    asActorId("researcher-6"),
    asActorId("analyst"),
    asActorId("ambient-3"),
  ],
  // Borrows: the ALARM scramble (46000-52000) for the whole bay; ambient-3
  // is ALSO loaned to the oil-bar zone loop as its beaming visitor for the
  // whole loop (a near-full window — the visitor displacement is the
  // reconciled east-wave decision).
  interruptionWindows: [
    ...[
      "researcher-1",
      "researcher-2",
      "researcher-3",
      "researcher-4",
      "researcher-5",
      "researcher-6",
      "analyst",
    ].map((actorId) => ({ actorId: asActorId(actorId), fromMs: 46000, toMs: 52000 })),
    { actorId: asActorId("ambient-3"), fromMs: 1000, toMs: 90000 },
  ],
  actors: GREENHOUSE_ACTORS,
  props: [],
};
