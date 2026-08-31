/**
 * EAST ZONE LOOP fragments (R5 wave): LAUNCH, BACK OFFICE, OIL BAR.
 *
 * Pure data only: relative times inside each zone's cycle; the kernel
 * (story/beats.ts compileFragments) expands, merges, and validates. This
 * file never mutates module state and never imports other fragment files.
 *
 * Comedy rules (10-r5-content-spec.md sections 6-8): expressions and glyphs
 * carry the gags; cues stay sparse; every actor's motion windows tile its
 * cycle so the end-of-cycle rest pose equals the start-of-cycle pose.
 *
 * Two spec gags fire on ALTERNATE cycles ("every 2nd cycle", "cycle 4"),
 * which a relative-time zone loop cannot express (every cycle is identical).
 * Those gags live in the two small central fragments at the bottom of this
 * file, firing at the absolute times of the matching cycle instances. They
 * borrow zone-reserved actors strictly inside the interruption windows
 * declared on the owning zone fragments below.
 *
 * Spec liberties taken (noted for the kernel owner):
 * - The oil-bar "cycle 4 failed pour" uses ambient-4 (backOffice) rather
 *   than the intern, so the intern stays booked to BACK OFFICE and the gag
 *   still never crosses a fragment the east wave does not own.
 * - ambient-5 sleeps at streetRunEast: there is no dedicated safe-line
 *   station, and streetRunEast is the nearest authored deck point behind
 *   the launch bay.
 * - accountant-2 "rows" while holding ferryDock in the work state; the boat
 *   itself is a kernel machine channel (boatRow), per the R5 plan.
 * - The oil-bar visitor is ambient-3 (greenhouse). Every ambient extra is
 *   rostered to some zone, so whoever registers the greenhouse fragment
 *   must reconcile ambient-3's beam windows with its greenhouse duties.
 */

import { asActorId, asWaypointId, type Expression, type GlyphId } from "../../types";
import { ax, cue, faceTo, holdAt, poseOf } from "./authoring";
import type { Fragment, FragmentActorCommand } from "./types";

// --- Local channel helpers (authoring.ts covers motion/pose/cue only). -----

const express = (
  actorId: string,
  expression: Expression,
  t0: number,
  t1: number,
): FragmentActorCommand =>
  ax(actorId, {
    kind: "express",
    actorId: asActorId(actorId),
    expression,
    startMs: t0,
    endMs: t1,
  });

const glyph = (actorId: string, g: GlyphId, t0: number, dur: number): FragmentActorCommand =>
  ax(actorId, {
    kind: "glyph",
    actorId: asActorId(actorId),
    glyph: g,
    startMs: t0,
    durationMs: dur,
  });

const beam = (
  actorId: string,
  from: string,
  to: string,
  t0: number,
  dur: number,
): FragmentActorCommand =>
  ax(actorId, {
    kind: "beam",
    actorId: asActorId(actorId),
    from: asWaypointId(from),
    to: asWaypointId(to),
    startMs: t0,
    durationMs: dur,
  });

// ---------------------------------------------------------------------------
// LAUNCH — cycle 30000, gunner + ambient-5 (spec section 6)
// ---------------------------------------------------------------------------

const LAUNCH_ACTORS: FragmentActorCommand[] = [
  // Gunner: polish (work + happy), gauge check (react), tire kick
  // (clack cue + recoil), then the hat-tip mock at the sleeper.
  ax("gunner", holdAt("launchBay", 0, 30000, "work")),
  express("gunner", "happy", 1000, 7000),
  ax("gunner", poseOf("react", 8000, 9000)), // gauge squint
  ax("gunner", cue("clack", 15000, { x: 12.5, y: 0.4, z: 1 })), // tire kick
  ax("gunner", poseOf("react", 15000, 1580)), // kick recoil
  express("gunner", "surprised", 15000, 15650),
  // Hat-tip mock: gunner turns to the sleeper, flashes happy, flourishes.
  ax("gunner", faceTo("streetRunEast", 25000, 800)),
  ax("gunner", poseOf("celebrate", 25400, 2600)),
  express("gunner", "happy", 25200, 27200),
  // Safe-line sleeper: one long sleep-glyph window per cycle; the idle
  // hold state supplies the slow standing bob from the rig's idle motion.
  ax("ambient-5", holdAt("streetRunEast", 0, 30000, "idle")),
  glyph("ambient-5", "sleep", 1000, 28000),
];

export const LAUNCH_FRAGMENT: Fragment = {
  id: "zone-launch",
  zone: "launch",
  cycleMs: 30000,
  reservedActors: [asActorId("gunner"), asActorId("ambient-5")],
  // Borrows: gunner for the plot's crank/jam/FIRE window; ambient-5 for the
  // ALARM scramble AND the plot's exchange nothing-beat lean.
  interruptionWindows: [
    { actorId: asActorId("gunner"), fromMs: 42000, toMs: 56200 },
    { actorId: asActorId("ambient-5"), fromMs: 46000, toMs: 52000 },
    { actorId: asActorId("ambient-5"), fromMs: 57300, toMs: 58700 },
    { actorId: asActorId("ambient-5"), fromMs: 59000, toMs: 60500 },
  ],
  actors: LAUNCH_ACTORS,
  props: [],
};

// ---------------------------------------------------------------------------
// BACK OFFICE — cycle 18000, accountant-1/2 + intern + ambient-4 (section 7)
// ---------------------------------------------------------------------------

const BACKOFFICE_ACTORS: FragmentActorCommand[] = [
  // accountant-1: stamps ledgers at desk A; one stamp cue per cycle.
  ax("accountant-1", holdAt("backOfficeDeskA", 0, 18000, "work")),
  ax("accountant-1", cue("stamp", 4000, { variant: "approve", x: 16.5, y: 0.6, z: -2 })),
  express("accountant-1", "happy", 4200, 5600),
  // accountant-2: rows at the ferry dock (boat itself is a kernel channel),
  // then compares against the truth monolith: "?" then happy + heart.
  ax("accountant-2", holdAt("ferryDock", 0, 18000, "work")),
  ax("accountant-2", faceTo("truthMonolith", 0, 18000)),
  ax("accountant-2", poseOf("react", 6000, 1000)), // squints at the monolith
  glyph("accountant-2", "question", 6000, 1600),
  express("accountant-2", "happy", 8100, 11000), // balanced!
  glyph("accountant-2", "heart", 8100, 2000),
  ax("accountant-2", poseOf("react", 11200, 600)), // satisfied nod
  // intern: types under the desk lamp; one soft clack per cycle.
  ax("intern", holdAt("backOfficeDeskB", 0, 18000, "idle")),
  ax("intern", poseOf("work", 1000, 17000)),
  ax("intern", cue("clack", 6000, { x: 19.5, y: 0.5, z: -2 })),
  // ambient-4: files at desk B, quietly dying of boredom.
  ax("ambient-4", holdAt("backOfficeDeskB", 0, 18000, "work")),
  express("ambient-4", "bored", 9000, 10500),
];

export const BACKOFFICE_FRAGMENT: Fragment = {
  id: "zone-backoffice",
  zone: "backOffice",
  cycleMs: 18000,
  reservedActors: [
    asActorId("accountant-1"),
    asActorId("accountant-2"),
    asActorId("intern"),
    asActorId("ambient-4"),
  ],
  // Borrow permits for this file's central gags (see file header): the
  // missed-capsule gag fires on alternate cycles only.
  interruptionWindows: [
    { actorId: asActorId("accountant-1"), fromMs: 18000, toMs: 36000 },
    { actorId: asActorId("accountant-1"), fromMs: 54000, toMs: 72000 },
    { actorId: asActorId("accountant-1"), fromMs: 46000, toMs: 52000 },
    { actorId: asActorId("accountant-1"), fromMs: 67900, toMs: 82100 },
    { actorId: asActorId("accountant-2"), fromMs: 46000, toMs: 52000 },
    { actorId: asActorId("accountant-2"), fromMs: 67900, toMs: 82100 },
    // intern: the plot's crank join and the lamp return (NOT the ALARM —
    // the launch crew is on-duty and skips the scramble by ruling).
    { actorId: asActorId("intern"), fromMs: 45900, toMs: 56200 },
    { actorId: asActorId("intern"), fromMs: 81900, toMs: 89900 },
    // The oil-bar failed-pour gag borrows ambient-4 during oil-bar cycle 4;
    // the ALARM (46000-52000) sits inside the same wide window.
    { actorId: asActorId("ambient-4"), fromMs: 45000, toMs: 60000 },
  ],
  actors: BACKOFFICE_ACTORS,
  props: [],
};

// ---------------------------------------------------------------------------
// OIL BAR — cycle 15000, coffee + one beaming visitor (section 8)
// ---------------------------------------------------------------------------

const OILBAR_ACTORS: FragmentActorCommand[] = [
  // Coffee bot: pours (work, smug), sips (idle smug) at the bar.
  ax("coffee", holdAt("oilBar", 0, 15000, "work")),
  express("coffee", "happy", 1000, 4000), // smug pour
  ax("coffee", poseOf("idle", 8000, 3000)), // the sip
  express("coffee", "happy", 8100, 11000),
  // Visitor (ambient-3, greenhouse): beams in from docksA, drinks
  // (happy + heart), beams back before the cycle seam.
  beam("ambient-3", "docksA", "oilBar", 1000, 800),
  ax("ambient-3", holdAt("oilBar", 1800, 10200, "idle")),
  express("ambient-3", "happy", 4000, 8000),
  glyph("ambient-3", "heart", 4000, 3000),
  beam("ambient-3", "oilBar", "docksA", 12500, 800),
  ax("ambient-3", holdAt("docksA", 13300, 1700, "idle")),
];

export const OILBAR_FRAGMENT: Fragment = {
  id: "zone-oilbar",
  zone: "oilBar",
  cycleMs: 15000,
  reservedActors: [asActorId("coffee")],
  interruptionWindows: [
    // The failed-pour gag (oil-bar cycle 4, 45000-60000) borrows coffee; the
    // ALARM scramble (46000-52000) rides the same window. The plot borrows
    // coffee separately as the PAUSE mid-sip freeze victim.
    { actorId: asActorId("coffee"), fromMs: 45000, toMs: 60000 },
    { actorId: asActorId("coffee"), fromMs: 73800, toMs: 76200 },
  ],
  actors: OILBAR_ACTORS,
  props: [],
};

// ---------------------------------------------------------------------------
// Central gags that fire on ALTERNATE cycles (see file header).
// ---------------------------------------------------------------------------

// Missed-capsule gag, every 2nd back-office cycle (instances at 18000 and
// 54000): accountant-1 leans (react), bends to pick (carry pose, no prop),
// files it with a bored eye-roll.
export const BACKOFFICE_GAG_FRAGMENT: Fragment = {
  id: "gag-backoffice-capsule",
  reservedActors: [],
  actors: [
    ax("accountant-1", poseOf("react", 26200, 800)),
    express("accountant-1", "surprised", 26200, 27000),
    ax("accountant-1", poseOf("carry", 27200, 4000)),
    express("accountant-1", "bored", 27200, 31500),
    ax("accountant-1", poseOf("work", 32000, 3000)),
    ax("accountant-1", poseOf("react", 62200, 800)),
    express("accountant-1", "surprised", 62200, 63000),
    ax("accountant-1", poseOf("carry", 63200, 4000)),
    express("accountant-1", "bored", 63200, 67500),
    ax("accountant-1", poseOf("work", 68000, 3000)),
  ],
  props: [],
};

// Failed-pour gag, oil-bar cycle 4 (45000-60000): ambient-4 tries to pour,
// the tap sputters (steamPuff), ambient-4 panics, coffee does it in one
// smooth motion, ambient-4 slumps (bored).
export const OILBAR_GAG_FRAGMENT: Fragment = {
  id: "gag-oilbar-pour",
  reservedActors: [],
  actors: [
    // Timed into the free express slot of oil-bar cycle 4 (the zone loop's
    // smug-pour window runs 46000-49000; this gag starts after it).
    ax("ambient-4", poseOf("work", 49500, 1000)), // grabs the tap
    ax("ambient-4", cue("tick", 50500, { effect: "steamPuff", x: 18.5, y: 0.6, z: 10 })),
    ax("ambient-4", poseOf("react", 50600, 900)),
    express("ambient-4", "panic", 50600, 51500),
    ax("ambient-4", poseOf("idle", 51500, 4000)), // slumps
    express("ambient-4", "bored", 51600, 54400),
    ax("coffee", poseOf("work", 49600, 800)), // one smooth motion
    express("coffee", "happy", 49650, 50300),
  ],
  props: [],
};
