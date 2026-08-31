/**
 * GLOBAL GAGS fragments (R5): the watch-tower ALARM scramble and the USER
 * HAND pause (10-r5-content-spec.md, "ALARM fragment" + "PAUSE fragment").
 *
 * Absolute times inside the 90000 ms loop. Machine channels are NOT authored
 * here — the kernel owns the tower bellSwing/beaconPulse and the PAUSE
 * handArc + freezeWindow remap; this file only moves actors.
 *
 * ALARM (46000-52000): every touched bot pops an alarm glyph + a react jump,
 * beams to its OWN zone station (staggered 100 ms), realizes ~5 s later it
 * was a drill (bored/angry; one fist-shake at the tower), then beams back to
 * its prior-activity station. Every command for a touched actor ends by
 * 52000 so the zone loops' next cycle takes over cleanly.
 *
 * PAUSE (74000-78000): the freeze itself is the kernel's worldTime remap
 * (FREEZE_WINDOW below is the data contract). The only authored actor bit is
 * the cheeky glyph above the nearest frozen bot just AFTER the freeze ends —
 * everything else is frozen by the remap, so this fragment commands nothing
 * else. NOTE: GlyphId has no "..." yet; "question" is the closest licensed
 * id and the kernel may swap in a dedicated ellipsis glyph.
 */

import { asActorId, asWaypointId } from "../../types";
import type { ActorCommand, Expression, GlyphId, WaypointId } from "../../types";
import { ax, faceTo, poseOf } from "./authoring";
import type { Fragment, FragmentActorCommand, InterruptionWindow } from "./types";

// ---------------------------------------------------------------------------
// Local constructors for the v2 command kinds (beam / glyph / express) —
// authoring.ts does not provide them yet, so this file builds them inline
// rather than editing a shared file mid-wave.
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

// ---------------------------------------------------------------------------
// ALARM choreography table
// ---------------------------------------------------------------------------

/** One bot's slice of the alarm scramble. */
interface ScrambleEntry {
  readonly actorId: string;
  /** Zone anchor the bot beams TO (its own zone's station). */
  readonly zoneStation: WaypointId;
  /** Prior-activity station the bot beams BACK to after the drill. */
  readonly activityStation: WaypointId;
  /** Realization mood: most are bored, a few are angry. */
  readonly mood: "bored" | "angry";
}

const W = (station: string): WaypointId => asWaypointId(station);

/**
 * The scramble roster (zone per bots/fleet.ts ROSTER; activity stations from
 * the transitional HOME_STATION table until the zone loops own their own
 * posts). The kernel trims this to actors whose zone windows actually allow
 * 46000-52000.
 */
const SCRAMBLE: readonly ScrambleEntry[] = [
  {
    actorId: "ambient-1",
    zoneStation: W("watchTower"),
    activityStation: W("stairTopLoft"),
    mood: "angry",
  }, // 0: the fist-shaker
  { actorId: "coffee", zoneStation: W("oilBar"), activityStation: W("coffee"), mood: "bored" },
  {
    actorId: "ambient-6",
    zoneStation: W("docksA"),
    activityStation: W("roofStair"),
    mood: "bored",
  },
  {
    actorId: "researcher-1",
    zoneStation: W("greenhouse"),
    activityStation: W("deskRow"),
    mood: "bored",
  },
  {
    actorId: "researcher-2",
    zoneStation: W("greenhouse"),
    activityStation: W("chartWall"),
    mood: "angry",
  },
  {
    actorId: "researcher-3",
    zoneStation: W("greenhouse"),
    activityStation: W("telescope"),
    mood: "bored",
  },
  {
    actorId: "researcher-4",
    zoneStation: W("greenhouse"),
    activityStation: W("deskRow"),
    mood: "bored",
  },
  {
    actorId: "researcher-5",
    zoneStation: W("greenhouse"),
    activityStation: W("deskRow"),
    mood: "bored",
  },
  {
    actorId: "researcher-6",
    zoneStation: W("greenhouse"),
    activityStation: W("chartWall"),
    mood: "bored",
  },
  {
    actorId: "analyst",
    zoneStation: W("greenhouse"),
    activityStation: W("tickerBoard"),
    mood: "angry",
  },
  {
    actorId: "ambient-3",
    zoneStation: W("greenhouse"),
    activityStation: W("deskRow"),
    mood: "bored",
  },
  { actorId: "foreman", zoneStation: W("planDesk"), activityStation: W("briefing"), mood: "angry" },
  {
    actorId: "janitor",
    zoneStation: W("gauntletIn"),
    activityStation: W("briefing"),
    mood: "bored",
  },
  {
    actorId: "ambient-2",
    zoneStation: W("gauntletIn"),
    activityStation: W("stairBottomLoft"),
    mood: "bored",
  },
  {
    actorId: "accountant-1",
    zoneStation: W("backOfficeDeskA"),
    activityStation: W("receiptTray"),
    mood: "bored",
  },
  {
    actorId: "accountant-2",
    zoneStation: W("backOfficeDeskA"),
    activityStation: W("vaultDoor"),
    mood: "bored",
  },
  {
    actorId: "ambient-4",
    zoneStation: W("backOfficeDeskA"),
    activityStation: W("deskRowTrading"),
    mood: "bored",
  },
  {
    actorId: "ambient-5",
    zoneStation: W("launchBay"),
    activityStation: W("pipeArrival"),
    mood: "bored",
  }, // the sleeper, wakes mid-topple
  // KERNEL RULING (merge): gunner and intern are TRIMMED from the scramble —
  // they are on-duty mid-crank in the central plot at 46000-52000, and the
  // alarm wave visibly skips them (everyone scatters, the launch crew
  // grimly cranks on). Their mid-crank react-glances live in plot-v2.ts.
];

/** Absolute window of the alarm gag (content spec: 46000-52000). */
export const ALARM_WINDOW = { startMs: 46000, endMs: 52000 } as const;

const alarmActors: FragmentActorCommand[] = [];

SCRAMBLE.forEach((e, i) => {
  // Staggered 100 ms: the wave of alarm glyphs + jumps reads left-to-right.
  const b = ALARM_WINDOW.startMs + 50 + i * 100;

  // 1) Panic: alarm glyph + react jump (glyph/pose channels, not motion).
  alarmActors.push(ax(e.actorId, glyph(e.actorId, "alarm", b, 800)));
  alarmActors.push(ax(e.actorId, poseOf("react", b, 600)));

  // 2) Beam to OWN zone station (the scramble — a real beam command).
  alarmActors.push(ax(e.actorId, beam(e.actorId, e.activityStation, e.zoneStation, b + 700, 900)));

  // 3) ~5 s in: it was a drill. Expression windows + a face to the tower.
  const realize = 50600 + i * 20;
  alarmActors.push(ax(e.actorId, express(e.actorId, e.mood, realize, realize + 550)));
  alarmActors.push(ax(e.actorId, faceTo("watchTower", realize, 600)));
  if (e.mood === "angry") {
    alarmActors.push(ax(e.actorId, poseOf("argue", realize + 100, 900))); // fist at the tower
    alarmActors.push(ax(e.actorId, glyph(e.actorId, "anger", realize + 150, 800)));
  }

  // 4) Beam back to the prior-activity station; everything ends by 52000.
  const back = 51200 + i * 15;
  alarmActors.push(ax(e.actorId, beam(e.actorId, e.zoneStation, e.activityStation, back, 500)));
});

// The fist-shaker leads the realization: ambient-1 shakes a fist at the
// tower on top of the generic mood windows above (pose channel, ends <52000
// with the rest of the gag).
alarmActors.push(ax("ambient-1", poseOf("argue", 50850, 1000)));

export const ALARM_FRAGMENT: Fragment = {
  id: "global-alarm",
  reservedActors: [],
  actors: alarmActors,
  props: [],
};

// ---------------------------------------------------------------------------
// PAUSE fragment (74000-78000)
// ---------------------------------------------------------------------------

/**
 * The kernel's worldTime remap contract: the USER hand presses at 74200,
 * holds 2200 ms, releases at 76400. Camera and hand run on logical time;
 * everything else is clamped to the freeze instant inside this window.
 */
export const FREEZE_WINDOW = { startMs: 74200, endMs: 76400 } as const;

/** The nearest frozen bot for the cheeky glyph (launch bay side, near the hand). */
export const PAUSE_BOT = "runner-b" as const;

/**
 * The ONE authored actor bit: a glyph over the nearest frozen bot just after
 * the freeze releases (~76500) — the only thing that moves, so the only
 * thing worth commanding. "question" stands in for the spec's "..." until a
 * dedicated ellipsis GlyphId exists.
 */
export const PAUSE_FRAGMENT: Fragment = {
  id: "global-pause",
  reservedActors: [],
  actors: [ax(PAUSE_BOT, glyph(PAUSE_BOT, "question", 76500, 800))],
  props: [],
};

// ---------------------------------------------------------------------------
// BORROW_REQUESTS — interruption windows this global author needs from the
// zone loop owners (the kernel reconciles; expects trimming where a zone's
// own windows cannot cover the full span).
// ---------------------------------------------------------------------------

const windowFor = (actorId: string, fromMs: number, toMs: number): InterruptionWindow => ({
  actorId: asActorId(actorId),
  fromMs,
  toMs,
});

export const BORROW_REQUESTS: readonly InterruptionWindow[] = [
  // ALARM: every commanded actor, full gag span [46000, 52000).
  ...SCRAMBLE.map((e) => windowFor(e.actorId, ALARM_WINDOW.startMs, ALARM_WINDOW.endMs)),
  // PAUSE: the single cheeky glyph bit at ~76500.
  windowFor(PAUSE_BOT, 75500, 77500),
];
