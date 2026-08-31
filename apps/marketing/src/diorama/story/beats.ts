/**
 * Authored story timeline for the diorama loop (04-story-script.md compressed
 * to the 90s skeleton in config.BEAT_STARTS).
 *
 * Pure TypeScript: no THREE, no DOM, so story.test.ts runs in bare node.
 * Exports: BEATS (authored), compileBeats() (validated, sorted tracks),
 * evaluateMachines()/evaluateActor()/evaluateProp() (pure absolute-time
 * evaluation the director applies to scene objects and the seam test
 * compares at t=0 vs t=90000), and the mood curve.
 */

import { BEAT_STARTS, DURATION_MS, type ZoneId } from "../config";
import { EASINGS, curveLength, evaluateCurve, lerp, periodic, saturate } from "../math";
import type { CurveSampleOut } from "../math";
import { PATHS, STATIONS, type PathId, type StationId } from "./waypoints";
import {
  asActorId,
  asAnchorId,
  asBeatId,
  asCueId,
  asPathId,
  asPropId,
  asWaypointId,
  type ActorCommand,
  type AnchorId,
  type ActorId,
  type Beat,
  type BotState,
  type EasingName,
  type Expression,
  type GlyphId,
  type FiredCue,
  type MoveAlongCommand,
  type PropCommand,
  type PropId,
  type SocketId,
  type StoryCommand,
  type Track,
  type WaypointId,
  type XYZ,
} from "../types";

// ---------------------------------------------------------------------------
// Cast / props / anchors (mirrors bots/fleet.ts ROSTER and world props)
// ---------------------------------------------------------------------------

export const ACTOR_IDS = [
  "foreman",
  "researcher-1",
  "researcher-2",
  "researcher-3",
  "researcher-4",
  "researcher-5",
  "researcher-6",
  "analyst",
  "runner-a",
  "runner-b",
  "runner-c",
  "runner-d",
  "guard-1",
  "guard-2",
  "gunner",
  "accountant-1",
  "accountant-2",
  "intern",
  "janitor",
  "coffee",
  "ambient-1",
  "ambient-2",
  "ambient-3",
  "ambient-4",
  "ambient-5",
  "ambient-6",
] as const;

/**
 * Home station per actor — the station its zone fragment holds at cycle
 * start, so the implicit-home fallback (t before a fragment's first
 * command) equals the end-of-loop rest and the seam is continuous. The
 * fleet ROSTER homes are the R2 zone homes; where a zone fragment posts an
 * actor elsewhere (greenhouse station assignments, the displaced
 * ambient-3), the fragment wins.
 */
export const HOME_STATION: Readonly<Record<string, StationId>> = {
  foreman: "planDesk",
  "researcher-1": "greenhouse",
  "researcher-2": "whiteboard",
  "researcher-3": "greenhouseTelescope",
  "researcher-4": "greenhouse",
  "researcher-5": "greenhouse",
  "researcher-6": "whiteboard",
  analyst: "greenhouseTelescope",
  "runner-a": "gauntletIn",
  "runner-b": "gauntletOut",
  "runner-c": "watchTower",
  "runner-d": "queueBack",
  "guard-1": "stampStation",
  "guard-2": "queueFront",
  gunner: "launchBay",
  "accountant-1": "backOfficeDeskA",
  "accountant-2": "ferryDock",
  intern: "backOfficeDeskB",
  janitor: "briefing",
  coffee: "oilBar",
  // ambient-1 has no zone fragment; the watch terrace panel is its post.
  "ambient-1": "controlPanel",
  "ambient-2": "stampStation",
  // ambient-3 is the oil-bar visitor loan: it lives at the docks.
  "ambient-3": "docksA",
  "ambient-4": "backOfficeDeskB",
  "ambient-5": "streetRunEast",
  "ambient-6": "whiteboard",
};

export const PROP_IDS = [
  "crate-a",
  "crate-b",
  "crate-c",
  "crate-d",
  "orderOrb",
  "receiptCoin-1",
  "receiptCoin-2",
] as const;

/** Rest anchor per prop (seam target; must match world PropHandle.homeAnchorId). */
export const PROP_HOME_ANCHOR: Readonly<Record<string, AnchorId>> = {
  "crate-a": asAnchorId("crate-aHome"),
  "crate-b": asAnchorId("crate-bHome"),
  "crate-c": asAnchorId("crate-cHome"),
  "crate-d": asAnchorId("crate-dHome"),
  orderOrb: asAnchorId("breech"),
  "receiptCoin-1": asAnchorId("mintStation"),
  "receiptCoin-2": asAnchorId("mintStation"),
};

/**
 * Pure anchor positions used by prop evaluation (detach parking + arcs).
 * Scene-object anchors are authoritative in the world builder; these mirror
 * them so tests and cue details stay pure. Only the home anchors are
 * seam-critical.
 */
export const ANCHOR_POS: Readonly<Record<string, XYZ>> = {
  "crate-aHome": { x: -3.4, y: 0, z: 6.0 },
  "crate-bHome": { x: -2.4, y: 0, z: 6.6 },
  "crate-cHome": { x: -1.6, y: 0, z: 6.95 },
  "crate-dHome": { x: -0.9, y: 0, z: 6.2 },
  breech: { x: -7.4, y: -1.8, z: -2.7 },
  mintStation: { x: 14.4, y: 13, z: -4.4 },
  slotA: { x: 17.2, y: 13.4, z: -7.0 },
  coinSlot: { x: 1.5, y: -1.6, z: -3.2 },
  pop: { x: 16, y: 13.6, z: -6 },
  pipeMouth: { x: 6.4, y: 10.8, z: -5.8 },
  returnEnd: { x: 1.5, y: -1.0, z: -3.0 },
  // R5 plot-v2 parking anchors (mintCore/slot/monolith rest hidden inside
  // their machines; ferryBoat visible on the crossing boat).
  mintCore: { x: 7.5, y: 0, z: -2 },
  mintStationHome: { x: 17.8, y: 6.5, z: -5 },
  slotAnchorV2: { x: 20.2, y: 6.5, z: -7 },
  ferryBoat: { x: 17.5, y: 0.4, z: 4 },
  monolithSlot: { x: 17.5, y: 0, z: 8.5 },
};

/** Anchors where a parked prop stays hidden (orb breech park, minted coins). */
const HIDDEN_ANCHORS = new Set([
  "breech",
  "mintStation",
  "mintCore",
  "mintStationHome",
  "slotAnchorV2",
  "monolithSlot",
]);

const stationPos = (id: StationId): XYZ => {
  const s = STATIONS[id];
  return { x: s.x, y: s.y, z: s.z };
};

// ---------------------------------------------------------------------------
// Authoring helpers — pure constructors live in fragments/authoring.ts and
// are re-exported here for fragment authors and backwards compatibility.
// ---------------------------------------------------------------------------

export {
  P,
  arc,
  ax,
  cue,
  drop,
  faceTo,
  faceYaw,
  grab,
  holdAt,
  mv,
  poseOf,
} from "./fragments/authoring";
import { ax } from "./fragments/authoring";
import {
  GAUNTLET_FRAGMENT,
  GAUNTLET_QUEUEJUMP_GAG,
  GAUNTLET_REJECT_GAG,
  PLAN_CLIPBOARD_GAG,
  PLAN_FRAGMENT,
} from "./fragments/zones-center";
import {
  BACKOFFICE_FRAGMENT,
  BACKOFFICE_GAG_FRAGMENT,
  LAUNCH_FRAGMENT,
  OILBAR_FRAGMENT,
  OILBAR_GAG_FRAGMENT,
} from "./fragments/zones-east";
import { DOCKS_FRAGMENT, GREENHOUSE_FRAGMENT } from "./fragments/zones-west";
import { ALARM_FRAGMENT, PAUSE_FRAGMENT } from "./fragments/global-gags";
import { CENTRAL_PLOT_V2 } from "./fragments/plot-v2";
import type {
  Fragment,
  FragmentPropCommand,
  FragmentVariant,
  InterruptionWindow,
} from "./fragments/types";

/** Beat assembly entry types (the compiled Beat wrapper shape). */
type ActorEntry = { readonly actorId: ActorId; readonly command: ActorCommand };
type PropEntry = { readonly propId: PropId; readonly command: PropCommand };
type Detail = Readonly<Record<string, number | string>>;

/** Beat builder bound to the canonical skeleton entry `index`. */
const makeBeat = (index: number) => {
  const skeleton = BEAT_STARTS[index] as { id: string; startMs: number };
  const next = BEAT_STARTS[index + 1];
  const durationMs = (next ? next.startMs : DURATION_MS) - skeleton.startMs;
  return (actorCommands: readonly ActorEntry[], propCommands: readonly PropEntry[]): Beat => ({
    id: asBeatId(skeleton.id),
    startMs: skeleton.startMs,
    durationMs,
    actorCommands,
    propCommands,
  });
};

// ---------------------------------------------------------------------------
// Machine channels — authored windows + pure absolute-time evaluation
// ---------------------------------------------------------------------------

/** Authored machine window table (ms). Channels evaluate as functions of it. */
export const MACHINE_WINDOWS = {
  clockFlipAt: 5200,
  clockFlipBackAt: 87800,
  flipDur: 400,
  moodRiseEnd: 3500,
  moodFallStart: 86000,
  candleRise: [8000, 14000] as const,
  candleDropAt: 14000,
  candleDropDur: 900,
  candleJumpAt: 69000,
  candleJumpDur: 600,
  tapeFlicker: [14000, 18000] as const,
  tapeGreenAt: 69500,
  tapeGreenDur: 700,
  steamScatter: [12500, 1500] as const,
  telescopeSwivel: [16500, 21500] as const,
  blueprint: [20500, 28500] as const,
  slatJam: [33500, 800] as const,
  stampApproveAt: 46500,
  stampRejectAt: 49500,
  stampDur: 500,
  vaultOpen: [50500, 2500] as const,
  vaultClose: [82500, 2000] as const,
  crankA: [55800, 60000] as const,
  crankJam: [57800, 1200] as const,
  crankB: [59300, 60800] as const,
  fireAt: 63300,
  orbPopAt: 61000,
  freeze: [62450, 400] as const,
  antennaA: 2500,
  armCatch: [64100, 64800] as const,
  armSlot: [65100, 65900] as const,
  armWave: [18500, 21000] as const,
  mintAt: 67600,
  mintDur: 400,
  slotPulseAt: 66000,
  antennaAt: 70000,
  coffeeSpin: [71500, 72000] as const,
  // R5 machine channels (10-r5-content-spec.md final section).
  scannerCycle: 10000, // gauntlet pylon sweep, one pass per cycle
  scannerX: [-3, 5] as const, // sweep extent (scene x)
  scannerPeak: [8000, 30000] as const, // crate-through peak intensity
  carouselCycle: 30000, // mint carousel
  carouselSteps: 6,
  ramBurst: [30000, 42000] as const, // cloid mint double-slam burst
  capsuleCycle: 18000, // back office chutes
  capsuleDrops: 2,
  towerActive: [46000, 52000] as const, // ALARM bell + beacon
  cableActive: [42000, 56000] as const, // mint -> vault cable edge pulse
  flipBoardAt: 55000, // FIRE board flip
  flipBoardDur: 600,
  boatCycle: 18000, // ferry bob + rock
  boatLively: [68000, 82000] as const, // coin crossing liveliness
  pause: [74000, 78000] as const, // PAUSE gag window
  freezeStart: 74200, // button press instant
  freezeDur: 2200, // world freeze length
} as const;

/** Reused machine channel state (no per-frame allocation). */
export interface MachineState {
  clockFlip: number;
  blueprintBeam: number;
  tapeScroll: number;
  tapeFlicker: number;
  tapeGreen: number;
  candleDrop: number;
  candleJump: number;
  slatOffset: number;
  conveyorJam: number;
  stampApprove: number;
  stampReject: number;
  vaultDoor: number;
  crankAngle: number;
  needle: number;
  armBaseYaw: number;
  armLift: number;
  armClaw: number;
  slotPulse: number;
  mintPress: number;
  antennaPulse: number;
  coffeeSteam: number;
  telescopeYaw: number;
  mood: number;
  // R5 channels (pure absolute-time functions; all idle at 0/90000).
  scannerSweep: number;
  scannerGlow: number;
  carouselStep: number;
  ramSlam: number;
  capsuleDrop: number;
  bellSwing: number;
  beaconPulse: number;
  cablePulse: number;
  flipBoard: number;
  boatBob: number;
  boatRock: number;
  pauseHand: number;
}

export const createMachineState = (): MachineState => ({
  clockFlip: 0,
  blueprintBeam: 0,
  tapeScroll: 0,
  tapeFlicker: 0,
  tapeGreen: 0,
  candleDrop: 0,
  candleJump: 0,
  slatOffset: 0,
  conveyorJam: 0,
  stampApprove: -1,
  stampReject: -1,
  vaultDoor: 0,
  crankAngle: 0,
  needle: 0,
  armBaseYaw: 0,
  armLift: 0,
  armClaw: 0,
  slotPulse: 0,
  mintPress: 0,
  antennaPulse: -1,
  coffeeSteam: 0,
  telescopeYaw: 0,
  mood: 1,
  scannerSweep: 0,
  scannerGlow: 1,
  carouselStep: 0,
  ramSlam: 0,
  capsuleDrop: 0,
  bellSwing: 0,
  beaconPulse: 0,
  cablePulse: 0,
  flipBoard: 0,
  boatBob: 0,
  boatRock: 0,
  pauseHand: 0,
});

const pulse = (t: number, at: number, dur: number): number =>
  t < at || t >= at + dur ? 0 : Math.sin(Math.PI * ((t - at) / dur));

/** Mood: 1 at seam, eases to 0 by 3500, holds, eases back to 1 at 90000. */
export const moodValue = (t: number): number => {
  const w = MACHINE_WINDOWS;
  if (t < w.moodRiseEnd) return 1 - EASINGS.easeInOutCubic(t / w.moodRiseEnd);
  if (t < w.moodFallStart) return 0;
  return EASINGS.easeInOutCubic((t - w.moodFallStart) / (DURATION_MS - w.moodFallStart));
};

/** Fill `out` with every machine channel at absolute cyclic time `timeMs`. */
export function evaluateMachines(timeMs: number, out: MachineState): MachineState {
  const t = periodic(timeMs, DURATION_MS);
  const w = MACHINE_WINDOWS;
  const flip = (at: number) => saturate((t - at) / w.flipDur);
  out.clockFlip = t < w.clockFlipBackAt ? flip(w.clockFlipAt) : 1 - flip(w.clockFlipBackAt);
  out.mood = moodValue(t);
  out.blueprintBeam = t >= w.blueprint[0] && t < w.blueprint[1] ? pulse(t, w.blueprint[0], 600) : 0;
  out.tapeScroll = t * 0.004;
  out.tapeFlicker =
    t >= w.tapeFlicker[0] && t < w.tapeFlicker[1] ? 0.5 + 0.5 * Math.sin(t * 0.09) : 0;
  out.tapeGreen = pulse(t, w.tapeGreenAt, w.tapeGreenDur);
  out.candleDrop = EASINGS.easeInQuad(saturate((t - w.candleDropAt) / w.candleDropDur));
  out.candleJump = EASINGS.easeOutBack(saturate((t - w.candleJumpAt) / w.candleJumpDur));
  // Slats scroll except during the authored jam window (offset freezes).
  const jamStart = w.slatJam[0];
  const jamEnd = jamStart + w.slatJam[1];
  const scroll = (time: number) => time * 0.005;
  out.slatOffset =
    t < jamStart ? scroll(t) : t < jamEnd ? scroll(jamStart) : scroll(t - w.slatJam[1]);
  out.conveyorJam = pulse(t, jamStart, w.slatJam[1]);
  out.stampApprove =
    t >= w.stampApproveAt && t < w.stampApproveAt + 900
      ? EASINGS.easeOutCubic((t - w.stampApproveAt) / w.stampDur)
      : -1;
  out.stampReject =
    t >= w.stampRejectAt && t < w.stampRejectAt + 900
      ? EASINGS.easeOutCubic((t - w.stampRejectAt) / w.stampDur)
      : -1;
  out.vaultDoor =
    t < w.vaultOpen[0]
      ? 0
      : t < w.vaultOpen[0] + w.vaultOpen[1]
        ? EASINGS.easeInOutCubic((t - w.vaultOpen[0]) / w.vaultOpen[1])
        : t < w.vaultClose[0]
          ? 1
          : t < w.vaultClose[0] + w.vaultClose[1]
            ? 1 - EASINGS.easeInOutCubic((t - w.vaultClose[0]) / w.vaultClose[1])
            : 0;
  // Crank accumulates rotation across both windows; the jam freezes the
  // needle (below) while bots react, then the second window resumes.
  const crankRate = 0.004; // rad/ms
  const cranked = (from: number, to: number) =>
    t <= from ? 0 : t >= to ? (to - from) * crankRate : (t - from) * crankRate;
  out.crankAngle = cranked(w.crankA[0], w.crankA[1]) + cranked(w.crankB[0], w.crankB[1]);
  out.needle =
    t < w.crankA[0]
      ? 0
      : t < w.crankJam[0]
        ? 45 * ((t - w.crankA[0]) / (w.crankJam[0] - w.crankA[0]))
        : t < w.crankB[0]
          ? 45
          : t < w.fireAt
            ? 45 + 45 * saturate((t - w.crankB[0]) / (w.fireAt - w.crankB[0]))
            : t < w.fireAt + 600
              ? 90 * (1 - EASINGS.easeOutCubic((t - w.fireAt) / 600))
              : 0;
  // Exchange arm: rest -> catch (yaw toward pipeArrival, claw open->shut) ->
  // slot into wall -> wave -> rest.
  out.armBaseYaw =
    t >= w.armCatch[0] && t < w.armSlot[1]
      ? EASINGS.easeInOutCubic(saturate((t - w.armCatch[0]) / 600)) * 0.9
      : t >= w.armSlot[1]
        ? 0.9 - EASINGS.easeInOutCubic(saturate((t - w.armSlot[1]) / 900)) * 0.9
        : 0;
  out.armLift =
    t >= w.armCatch[0] && t < w.armSlot[1]
      ? 0.4 +
        0.2 * Math.sin(Math.PI * saturate((t - w.armCatch[0]) / (w.armSlot[1] - w.armCatch[0])))
      : t >= w.armWave[0] && t < w.armWave[1]
        ? 0.5 + 0.1 * Math.sin(t * 0.02)
        : 0.4;
  out.armClaw =
    t >= w.armCatch[1] && t < w.armSlot[0]
      ? 1 - EASINGS.easeOutBack(saturate((t - w.armCatch[1]) / 400))
      : t >= w.armWave[0] && t < w.armWave[1]
        ? 0.5 + 0.5 * Math.sin(t * 0.025)
        : t >= w.armSlot[0]
          ? 0.15
          : 1;
  out.slotPulse = pulse(t, w.slotPulseAt, 800);
  out.mintPress =
    t >= w.mintAt && t < w.mintAt + 800 ? EASINGS.easeOutCubic((t - w.mintAt) / w.mintDur) : 0;
  out.antennaPulse =
    t >= w.antennaA && t < w.antennaA + 1200
      ? t - w.antennaA
      : t >= w.antennaAt && t < w.antennaAt + 1800
        ? t - w.antennaAt
        : -1;
  out.coffeeSteam =
    t >= w.steamScatter[0] && t < w.steamScatter[0] + w.steamScatter[1]
      ? 1
      : t >= 81500 && t < 84500
        ? 0.4
        : 0;
  out.telescopeYaw =
    t >= w.telescopeSwivel[0] && t < w.telescopeSwivel[1]
      ? EASINGS.easeInOutCubic(
          (t - w.telescopeSwivel[0]) / (w.telescopeSwivel[1] - w.telescopeSwivel[0]),
        ) * 1.1
      : t < w.telescopeSwivel[0]
        ? 0
        : 1.1 - EASINGS.easeInOutCubic(saturate((t - 23500) / 1500)) * 1.1;

  // ---- R5 machine channels --------------------------------------------------
  // Gauntlet scanner: one emissive pass over the pylon row (x -3..5) per
  // 10000ms cycle; the sweep position is a normalized sawtooth the world
  // maps onto scannerX. Glow is boosted while the crate is on the belt.
  out.scannerSweep = (t % w.scannerCycle) / w.scannerCycle;
  const scanning = t >= w.scannerPeak[0] && t < w.scannerPeak[1];
  out.scannerGlow = scanning ? 1.5 + 0.4 * Math.sin(t * 0.02) : 1;
  // Mint carousel: 6 steps per 30000ms; the ram slams shortly after each
  // step boundary. During the cloid burst window every step double-slams.
  const stepDur = w.carouselCycle / w.carouselSteps;
  const intoStep = t % stepDur;
  const slamAt = (at: number): number => pulse(intoStep, at, 420);
  out.carouselStep = Math.floor((t % w.carouselCycle) / stepDur);
  const doubleSlam = t >= w.ramBurst[0] && t < w.ramBurst[1];
  out.ramSlam = doubleSlam ? Math.max(slamAt(300), slamAt(780)) : slamAt(300);
  // Back office chutes: 2 capsule drops per 18000ms; the channel is the
  // progress of the current drop (world maps the descent).
  const dropDur = w.capsuleCycle / w.capsuleDrops;
  out.capsuleDrop = (t % dropDur) / dropDur;
  // Watch tower (ALARM): bell swing + beacon pulse, windowed to 46000-52000
  // with a 500ms ramp so the swing starts and ends at rest.
  const tower = t >= w.towerActive[0] && t < w.towerActive[1];
  if (tower) {
    const lt = t - w.towerActive[0];
    const span = w.towerActive[1] - w.towerActive[0];
    const ramp = Math.min(1, lt / 500, (span - lt) / 500);
    out.bellSwing = ramp * 0.5 * Math.sin(lt * 0.012);
    out.beaconPulse = ramp * (0.5 + 0.5 * Math.sin(lt * 0.015));
  } else {
    out.bellSwing = 0;
    out.beaconPulse = 0;
  }
  // Mint -> vault cable: one smooth edge pulse across the window.
  const cable = t >= w.cableActive[0] && t < w.cableActive[1];
  out.cablePulse = cable
    ? 0.5 -
      0.5 * Math.cos((2 * Math.PI * (t - w.cableActive[0])) / (w.cableActive[1] - w.cableActive[0]))
    : 0;
  // Launch board: a single flip at FIRE.
  out.flipBoard = pulse(t, w.flipBoardAt, w.flipBoardDur);
  // Ferry: bob + rock ride a 18000ms cycle with full sine periods (seam-
  // continuous); amplitude roughly doubles during the coin crossing.
  const lively = t >= w.boatLively[0] && t < w.boatLively[1];
  const bobAmp = lively ? 0.16 : 0.08;
  const boatPhase = ((t % w.boatCycle) / w.boatCycle) * Math.PI * 4;
  out.boatBob = bobAmp * Math.sin(boatPhase);
  out.boatRock = bobAmp * 0.6 * Math.sin(boatPhase + Math.PI / 3);
  // PAUSE gag: normalized raw-time phase across the window, 0 outside (the
  // hand itself is raw-time driven; the world freeze is a director remap).
  out.pauseHand =
    t >= w.pause[0] && t < w.pause[1] ? (t - w.pause[0]) / (w.pause[1] - w.pause[0]) : 0;

  return out;
}

/** Deterministic chart-wall candle height factor for candle `i` (c0..c7). */
export function candleFactor(i: number, timeMs: number): number {
  const t = periodic(timeMs, DURATION_MS);
  const w = MACHINE_WINDOWS;
  const rise =
    t >= w.candleRise[0] && t < w.candleRise[1]
      ? 0.3 +
        0.7 * EASINGS.easeOutCubic((t - w.candleRise[0]) / (w.candleRise[1] - w.candleRise[0]))
      : t < w.candleRise[0]
        ? 0.3
        : 1;
  const drift = 0.08 * Math.sin(t * 0.0012 + i * 1.7);
  if (i === 3)
    return saturate(rise + drift - 0.55 * EASINGS.easeInQuad(saturate((t - w.candleDropAt) / 900)));
  if (i === 7)
    return saturate(
      rise + drift + 0.35 * EASINGS.easeOutBack(saturate((t - w.candleJumpAt) / 600)),
    );
  return saturate(rise + drift);
}

// ---------------------------------------------------------------------------
// compileBeats — validation + time-sorted tracks
// ---------------------------------------------------------------------------

export interface Ownership {
  readonly propId: string;
  readonly actorId: string;
  readonly startMs: number;
}

export interface CompiledStory {
  readonly beats: readonly Beat[];
  readonly actorTracks: ReadonlyMap<ActorId, Track<ActorCommand>>;
  readonly propTracks: ReadonlyMap<PropId, Track<PropCommand>>;
  readonly cues: readonly FiredCue[];
  readonly ownership: readonly Ownership[];
  /** Advisory notes (e.g. beam windows crossing the loop seam). */
  readonly warnings: readonly string[];
}

const trackOf = <C extends { readonly startMs: number } & StoryCommand>(
  subjectId: string,
  commands: readonly C[],
): Track<C> => {
  const sorted = commands.slice().sort((a, b) => a.startMs - b.startMs);
  return { subjectId, starts: sorted.map((c) => c.startMs), commands: sorted };
};

const activeBetween = (
  c: { readonly startMs: number; readonly durationMs?: number },
  t: number,
): boolean => {
  const end = c.startMs + (c.durationMs ?? Infinity);
  return c.startMs <= t && t < end;
};

export function compileBeats(): CompiledStory {
  return compileFragments(CANONICAL_FRAGMENTS).story;
}

// ---------------------------------------------------------------------------
// R5 merged facade. The zone fragments whose gags are cycle-varying tables
// (zones-center) get their variants attached here — the kernel owns the
// splice data, the author files own the content. The transitional
// central-plot.ts is retired from the composition (file kept for R6).
//
// Variant cycles (reconciled):
// - plan clipboard gag: authored "cycle 3"; instance 3 (45000-60000) is
//   ALARM-interrupted, so the gag fires on instance 4 (60000-75000), once
//   per loop (every 6 cycles of the 6-instance loop).
// - gauntlet reject gag: every 3rd cycle (instances 3 and 6).
// - gauntlet queue-jump gag: every 2nd cycle (instances 2, 4, 6, 8).
// ---------------------------------------------------------------------------

const MOTION_AND_EXPRESS = ["hold", "moveAlong", "beam", "express"] as const;

const PLAN_WITH_GAGS: Fragment = {
  ...PLAN_FRAGMENT,
  variants: [
    {
      id: "plan-clipboard-gag",
      everyNthCycle: 6,
      applyCycle: 4,
      replaces: [
        // Per the gag header: the foreman's base windows in [1000, 9000),
        // extended through the 9000 rest hold so the gag's own 9000 window
        // cannot collide with it (the gag re-covers the rest transition).
        { actorId: "foreman", fromMs: 1000, toMs: 10000, channels: ["*"] },
      ],
      actors: PLAN_CLIPBOARD_GAG,
    } satisfies FragmentVariant,
  ],
};

const GAUNTLET_WITH_GAGS: Fragment = {
  ...GAUNTLET_FRAGMENT,
  variants: [
    {
      id: "gauntlet-reject-gag",
      everyNthCycle: 3,
      applyCycle: 3,
      replaces: [
        // runner-a base motion+express in [0, 7000); runner-b base EXPRESS
        // windows in [0, 6500). The chorus entries ride on base windows.
        { actorId: "runner-a", fromMs: 0, toMs: 7000, channels: MOTION_AND_EXPRESS },
        { actorId: "runner-b", fromMs: 0, toMs: 6500, channels: ["express"] },
      ],
      actors: GAUNTLET_REJECT_GAG,
    },
    {
      id: "gauntlet-queuejump-gag",
      everyNthCycle: 2,
      applyCycle: 2,
      replaces: [
        // runner-d base motion+express in [0, 8000) (the 8000 pose stays);
        // guard-2 base motion window [0, 10000).
        { actorId: "runner-d", fromMs: 0, toMs: 8000, channels: MOTION_AND_EXPRESS },
        { actorId: "guard-2", fromMs: 0, toMs: 10000, channels: ["hold", "moveAlong", "beam"] },
      ],
      actors: GAUNTLET_QUEUEJUMP_GAG,
    },
  ],
};

/**
 * Kernel-owned seam homing: borrowed actors the plot parks away from their
 * zone rest get one beam home before the loop seam, so t=0 rest equals
 * t=90000 rest. (ambient-5: the plot leaves the woken sleeper at the
 * launch bay; he beams back to his safe-line post.)
 */
const SEAM_HOMING: Fragment = {
  id: "kernel-seam-homing",
  reservedActors: [],
  actors: [
    ax("ambient-5", {
      kind: "beam",
      actorId: asActorId("ambient-5"),
      from: asWaypointId("launchBay"),
      to: asWaypointId("streetRunEast"),
      startMs: 59200,
      durationMs: 800,
    }),
  ],
  props: [],
};

/**
 * The canonical fragment table (R5 merge): 7 zone loops (plan and gauntlet
 * with variants), the east-wave central gags, the plot, and the global
 * gags. Order matters for conflict resolution: the global gags come last,
 * so the ALARM beats a same-actor zone/gag window it overlaps. The mint is
 * machine-only (no fragment). The PAUSE "..." glyph stays a "question"
 * stand-in until a dedicated ellipsis GlyphId is licensed.
 */
export const CANONICAL_FRAGMENTS: readonly Fragment[] = [
  DOCKS_FRAGMENT,
  GREENHOUSE_FRAGMENT,
  PLAN_WITH_GAGS,
  GAUNTLET_WITH_GAGS,
  LAUNCH_FRAGMENT,
  BACKOFFICE_FRAGMENT,
  BACKOFFICE_GAG_FRAGMENT,
  OILBAR_FRAGMENT,
  OILBAR_GAG_FRAGMENT,
  CENTRAL_PLOT_V2,
  SEAM_HOMING,
  ALARM_FRAGMENT,
  PAUSE_FRAGMENT,
];

export interface FragmentCompile {
  readonly story: CompiledStory;
  readonly beats: readonly Beat[];
  /** Advisory notes (seam-straddling expanded windows, seam-crossing beams). */
  readonly warnings: readonly string[];
}

/**
 * Merge fragments, expand zone loops, and compile the combined story.
 *
 * Rules (R5 kernel):
 * - Fragment ids unique; at most one fragment per zone; zone fragments must
 *   set a cycleMs that divides DURATION_MS cleanly; central fragments must
 *   not set cycleMs.
 * - Reserved actors are known ids and reserved by exactly one fragment.
 * - Zone loops: relative times in [0, cycleMs); instance k of a window at
 *   relative r fires at phaseMs + k*cycleMs + r. A window whose relative
 *   extent exceeds cycleMs is an error (it would self-overlap each cycle);
 *   an expanded window that would straddle the 90000 ms seam is DROPPED with
 *   a warning (never split).
 * - Central fragments may use a zone-reserved actor only inside that zone's
 *   declared interruption windows for the actor.
 * - Cue identity is per subject (actor/prop track), not global: parallel
 *   fragments may fire at the same millisecond.
 * - moveAlong retiming discipline: implied path speed must be within
 *   [0.5, 8] scene units per second (checked in compileStory).
 */
export function compileFragments(fragments: readonly Fragment[]): FragmentCompile {
  const errors: string[] = [];
  const warnings: string[] = [];
  const zoneOf = new Map<ZoneId, string>();
  const reservedBy = new Map<string, string>();
  const borrowWindows = new Map<string, readonly InterruptionWindow[]>();
  const seen = new Set<string>();
  for (const f of fragments) {
    if (seen.has(f.id)) errors.push(`duplicate fragment id ${f.id}`);
    seen.add(f.id);
    if (f.zone !== undefined) {
      const prior = zoneOf.get(f.zone);
      if (prior !== undefined) errors.push(`zone ${f.zone} claimed by ${f.id} and ${prior}`);
      zoneOf.set(f.zone, f.id);
      if (f.cycleMs === undefined) {
        errors.push(`zone fragment ${f.id} missing cycleMs`);
      } else if (f.cycleMs <= 0 || DURATION_MS % f.cycleMs !== 0) {
        errors.push(`cycleMs ${f.cycleMs} of ${f.id} does not divide ${DURATION_MS}`);
      } else if (f.phaseMs !== undefined && (f.phaseMs < 0 || f.phaseMs >= f.cycleMs)) {
        errors.push(`phaseMs of ${f.id} outside [0, cycleMs)`);
      }
    } else if (f.cycleMs !== undefined) {
      errors.push(`central fragment ${f.id} must not set cycleMs`);
    }
    for (const actorId of f.reservedActors) {
      if (!ACTOR_IDS.includes(actorId as never))
        errors.push(`reserved unknown actor ${actorId} in ${f.id}`);
      const prior = reservedBy.get(actorId);
      if (prior !== undefined) errors.push(`actor ${actorId} reserved by ${f.id} and ${prior}`);
      reservedBy.set(actorId, f.id);
    }
    for (const w of f.interruptionWindows ?? []) {
      if (!ACTOR_IDS.includes(w.actorId as never))
        errors.push(`interruption for unknown actor ${w.actorId} in ${f.id}`);
      if (w.fromMs < 0 || w.toMs > DURATION_MS || w.toMs <= w.fromMs) {
        errors.push(`bad interruption window [${w.fromMs},${w.toMs}) in ${f.id}`);
      }
      borrowWindows.set(w.actorId, [...(borrowWindows.get(w.actorId) ?? []), w]);
    }
    // Variants: zone-only, well-formed, and every replacement entry must
    // match at least one authored base window (stale references error).
    if (f.variants !== undefined) {
      if (f.zone === undefined) {
        errors.push(`variants on central fragment ${f.id} (zone loops only)`);
      }
      const cycle = f.cycleMs ?? DURATION_MS;
      const variantIds = new Set<string>();
      for (const v of f.variants) {
        if (variantIds.has(v.id)) errors.push(`duplicate variant id ${v.id} in ${f.id}`);
        variantIds.add(v.id);
        if (v.everyNthCycle < 1) errors.push(`variant ${v.id} of ${f.id} has everyNthCycle < 1`);
        if (v.applyCycle < 0 || (f.zone !== undefined && v.applyCycle >= DURATION_MS / cycle)) {
          errors.push(`variant ${v.id} of ${f.id} applyCycle outside [0, loop instances)`);
        }
        for (const r of v.replaces) {
          const matched = f.actors.some(
            (entry) =>
              entry.actorId === r.actorId &&
              entry.command.startMs >= r.fromMs &&
              entry.command.startMs < r.toMs &&
              (r.channels.includes("*") || r.channels.includes(entry.command.kind)),
          );
          if (!matched) {
            errors.push(
              `variant ${v.id} of ${f.id} replaces no base window for ${r.actorId} in [${r.fromMs},${r.toMs})`,
            );
          }
        }
      }
    }
  }

  // Expansion to absolute-time entries. Zone loops expand per cycle with
  // variants applied: on an applicable cycle the variant's `replaces`
  // entries DROP the matched base windows and the gag commands splice in at
  // the same cycle base (identical bounds and seam rules as base windows).
  interface OutActor {
    actorId: string;
    srcId: string;
    command: ActorCommand;
    dropped: boolean;
  }
  const outActors: OutActor[] = [];
  const outProps: { propId: string; ownerActorId?: string; command: PropCommand }[] = [];
  const channelEnd = (c: { startMs: number } & { endMs?: number; durationMs?: number }): number =>
    c.endMs !== undefined ? c.endMs : c.startMs + (c.durationMs ?? 0);
  for (const f of fragments) {
    const isZone = f.zone !== undefined;
    const cycle = f.cycleMs ?? DURATION_MS;
    const phase = isZone ? (f.phaseMs ?? 0) : 0;
    const cycles = isZone ? DURATION_MS / cycle : 1;
    const bound = isZone ? cycle : DURATION_MS;
    const startFor = (rel: number, end: number, cycleBase: number, what: string): number | null => {
      if (rel < 0 || rel >= bound) {
        errors.push(`${what} in ${f.id} at relative ${rel} outside [0, ${bound})`);
        return null;
      }
      if (end > bound) {
        errors.push(`${what} in ${f.id} window [${rel},${end}) exceeds cycleMs ${bound}`);
        return null;
      }
      const start = cycleBase + rel;
      if (start + (end - rel) > DURATION_MS) {
        warnings.push(`${what} in ${f.id} at ${start} straddles the seam; dropped`);
        return null;
      }
      return start;
    };
    const pushActor = (entry: { actorId: string; command: ActorCommand }, start: number): void => {
      const c = entry.command as ActorCommand & { endMs?: number };
      const shifted = { ...c, startMs: start } as ActorCommand & { endMs?: number };
      if (c.endMs !== undefined)
        (shifted as { endMs: number }).endMs = start + (c.endMs - c.startMs);
      outActors.push({ actorId: entry.actorId, srcId: f.id, command: shifted, dropped: false });
    };
    const pushProp = (
      entry: { propId: string; ownerActorId?: string; command: PropCommand },
      start: number,
    ): void => {
      outProps.push({
        propId: entry.propId,
        ownerActorId: entry.ownerActorId,
        command: { ...entry.command, startMs: start },
      });
    };
    if (!isZone) {
      for (const entry of f.actors) {
        const start = startFor(
          entry.command.startMs,
          channelEnd(entry.command as never),
          0,
          `command for ${entry.actorId}`,
        );
        if (start !== null) pushActor(entry, start);
      }
      for (const entry of f.props) {
        const start = startFor(
          entry.command.startMs,
          channelEnd(entry.command as never),
          0,
          `prop ${entry.propId} command`,
        );
        if (start !== null) pushProp(entry, start);
      }
      continue;
    }
    for (let k = 0; k < cycles; k += 1) {
      const cycleBase = phase + k * cycle;
      const applicable = (f.variants ?? []).filter(
        (v) => k >= v.applyCycle && (k - v.applyCycle) % v.everyNthCycle === 0,
      );
      const replaced = (entry: {
        actorId: string;
        command: { kind: string; startMs: number };
      }): boolean =>
        applicable.some((v) =>
          v.replaces.some(
            (r) =>
              r.actorId === entry.actorId &&
              entry.command.startMs >= r.fromMs &&
              entry.command.startMs < r.toMs &&
              (r.channels.includes("*") || r.channels.includes(entry.command.kind)),
          ),
        );
      for (const entry of f.actors) {
        if (replaced(entry)) continue;
        const start = startFor(
          entry.command.startMs,
          channelEnd(entry.command as never),
          cycleBase,
          `command for ${entry.actorId}`,
        );
        if (start !== null) pushActor(entry, start);
      }
      for (const v of applicable) {
        for (const entry of v.actors) {
          const start = startFor(
            entry.command.startMs,
            channelEnd(entry.command as never),
            cycleBase,
            `variant ${v.id} command for ${entry.actorId}`,
          );
          if (start !== null) pushActor(entry, start);
        }
      }
      for (const entry of f.props) {
        const start = startFor(
          entry.command.startMs,
          channelEnd(entry.command as never),
          cycleBase,
          `prop ${entry.propId} command`,
        );
        if (start !== null) pushProp(entry, start);
      }
    }
  }

  // Borrow sanction: any fragment (central, global, or a sibling zone) using
  // an actor reserved by ANOTHER fragment must land every use inside the
  // owner's declared interruption windows. fireCue narration rides any track
  // without a window (it touches no motion/expression channel).
  for (const f of fragments) {
    const timesByActor = new Map<string, number[]>();
    for (const entry of f.actors) {
      if (entry.command.kind === "fireCue") continue;
      const list = timesByActor.get(entry.actorId) ?? [];
      list.push(entry.command.startMs);
      timesByActor.set(entry.actorId, list);
    }
    for (const entry of f.props) {
      if (entry.ownerActorId === undefined) continue;
      const list = timesByActor.get(entry.ownerActorId) ?? [];
      list.push(entry.command.startMs);
      timesByActor.set(entry.ownerActorId, list);
    }
    for (const [actorId, times] of timesByActor) {
      const owner = reservedBy.get(actorId);
      if (owner === undefined || owner === f.id) continue;
      const windows = borrowWindows.get(actorId) ?? [];
      if (windows.length === 0) {
        errors.push(`${f.id} uses zone-reserved actor ${actorId} with no interruption window`);
        continue;
      }
      for (const t0 of times) {
        if (!windows.some((w) => w.fromMs <= t0 && t0 < w.toMs)) {
          errors.push(
            `${f.id} uses ${actorId} at ${t0} outside its interruption windows (owner ${owner})`,
          );
        }
      }
    }
  }

  // Cross-fragment channel conflicts. A sanctioned borrower interrupts the
  // owning zone loop: on the motion / express / glyph channels, an owner
  // window that overlaps a borrower window is DROPPED whole (windows are
  // never split). Between two non-owners (both sanctioned borrowers) the
  // LATER fragment in the input order wins — the canonical order lists the
  // global gags last, so e.g. the ALARM beats an oil-bar visitor cycle.
  const fragOrder = new Map(fragments.map((f, i) => [f.id, i]));
  // Motion (hold/moveAlong/beam) is ONE exclusive channel group; express and
  // glyph are their own groups.
  const CONFLICT_GROUPS = [["hold", "moveAlong", "beam"], ["express"], ["glyph"]] as const;
  for (const group of CONFLICT_GROUPS) {
    const byActor = new Map<string, OutActor[]>();
    for (const e of outActors) {
      if (!group.includes(e.command.kind as never) || e.dropped) continue;
      const list = byActor.get(e.actorId) ?? [];
      list.push(e);
      byActor.set(e.actorId, list);
    }
    for (const [actorId, list] of byActor) {
      const ordered = list.sort((a, b) => a.command.startMs - b.command.startMs);
      for (let i = 0; i < ordered.length; i += 1) {
        const a = ordered[i] as OutActor;
        if (a.dropped) continue;
        const aEnd = channelEnd(a.command as never);
        for (let j = i + 1; j < ordered.length; j += 1) {
          const b = ordered[j] as OutActor;
          if (b.dropped || b.srcId === a.srcId) continue;
          if (b.command.startMs >= aEnd) break;
          const owner = reservedBy.get(actorId);
          let loser: OutActor;
          if (owner === a.srcId && owner !== b.srcId) loser = a;
          else if (owner === b.srcId && owner !== a.srcId) loser = b;
          else loser = (fragOrder.get(a.srcId) ?? 0) < (fragOrder.get(b.srcId) ?? 0) ? a : b;
          loser.dropped = true;
          warnings.push(
            `${loser.srcId} ${loser.command.kind} for ${actorId} at ${loser.command.startMs} dropped: interrupted by the borrowing fragment`,
          );
          if (loser === a) break;
        }
      }
    }
  }
  const keptActors = outActors.filter((e) => !e.dropped);

  // Ownership ledger from attach entries (pure data; no global sink).
  const ownership: Ownership[] = [];
  for (const entry of outProps) {
    if (entry.command.kind !== "attachProp") continue;
    if (entry.ownerActorId === undefined) {
      errors.push(`attachProp for ${entry.propId} at ${entry.command.startMs} has no ownerActorId`);
      continue;
    }
    ownership.push({
      propId: entry.propId,
      actorId: entry.ownerActorId,
      startMs: entry.command.startMs,
    });
  }

  // Beat assembly by start-time containment.
  const beatIndexFor = (startMs: number): number => {
    let index = 0;
    for (let i = 0; i < BEAT_STARTS.length; i += 1) {
      if (BEAT_STARTS[i].startMs <= startMs) index = i;
    }
    return index;
  };
  const actorByBeat: ActorEntry[][] = BEAT_STARTS.map(() => []);
  const propByBeat: PropEntry[][] = BEAT_STARTS.map(() => []);
  for (const entry of keptActors) {
    if (entry.command.startMs < 0 || entry.command.startMs >= DURATION_MS) {
      errors.push(`expanded command for ${entry.actorId} at ${entry.command.startMs} outside loop`);
      continue;
    }
    // v2 kinds carry their own actorId; wrapper mirrors it when equal.
    const ownId = (entry.command as { actorId?: string }).actorId;
    const wrapperId = ownId ?? entry.actorId;
    actorByBeat[beatIndexFor(entry.command.startMs)]?.push({
      actorId: asActorId(wrapperId),
      command: entry.command,
    });
  }
  for (const entry of outProps) {
    if (entry.command.startMs < 0 || entry.command.startMs >= DURATION_MS) {
      errors.push(`expanded prop command for ${entry.propId} outside loop`);
      continue;
    }
    propByBeat[beatIndexFor(entry.command.startMs)]?.push({
      propId: asPropId(entry.propId),
      command: entry.command,
    });
  }
  const beats: readonly Beat[] = BEAT_STARTS.map((_s, i) =>
    makeBeat(i)(actorByBeat[i] ?? [], propByBeat[i] ?? []),
  );

  if (errors.length > 0) throw new Error(`compileFragments: ${errors.join("; ")}`);
  const story = compileStory(beats, { ownership, checkSkeleton: false });
  return { story, beats, warnings: [...warnings, ...story.warnings] };
}

/** Compiled canonical table handed to the director and the facade. */
export const BEATS: readonly Beat[] = compileFragments(CANONICAL_FRAGMENTS).beats;

/**
 * Compile any beat table (the seam test feeds synthetic beats through this).
 * Validation per the v2 contract:
 * - express/glyph/beam carry their own actorId; it is authoritative, and the
 *   Beat wrapper's actorId is accepted when equal (both placements legal).
 * - express: exactly one active window per actor (overlaps rejected).
 * - glyph: one window per actor at a time (overlaps rejected).
 * - beam: exclusive with hold/moveAlong on the motion channel; both
 *   waypoints must exist; duration > 0; a window crossing the loop seam is
 *   an advisory warning, not an error.
 */
export function compileStory(
  beats: readonly Beat[],
  options: {
    /** Ownership ledger (fragment-derived); defaults to none. */
    readonly ownership?: readonly Ownership[];
    /** Check the canonical BEAT_STARTS skeleton (compileBeats passes true). */
    readonly checkSkeleton?: boolean;
  } = {},
): CompiledStory {
  const ownership = options.ownership ?? [];
  const actorMap = new Map<string, ActorCommand[]>();
  const propMap = new Map<string, PropCommand[]>();
  const cues: FiredCue[] = [];
  const cueKeys = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];

  const canonical = options.checkSkeleton === true;
  beats.forEach((beat, i) => {
    if (canonical) {
      const skeleton = BEAT_STARTS[i];
      if (!skeleton || beat.id !== skeleton.id) errors.push(`beat ${i} id mismatch`);
      if (beat.startMs !== (skeleton?.startMs ?? beat.startMs))
        errors.push(`beat ${beat.id} start mismatch`);
    }
    if (beat.startMs < 0 || beat.startMs + beat.durationMs > DURATION_MS) {
      errors.push(`beat ${beat.id} exceeds loop`);
    }
    for (const entry of beat.actorCommands) {
      const wrapperId = entry.actorId as string;
      const command = entry.command;
      // v2 kinds carry their own actorId; it wins, both placements accepted.
      const ownId = command as { actorId?: string };
      const actorId =
        command.kind === "express" || command.kind === "glyph" || command.kind === "beam"
          ? (ownId.actorId as string)
          : wrapperId;
      if (wrapperId !== actorId && !ACTOR_IDS.includes(wrapperId as never)) {
        errors.push(`unknown wrapper actor ${wrapperId} in ${beat.id}`);
      }
      if (!ACTOR_IDS.includes(actorId as never))
        errors.push(`unknown actor ${actorId} in ${beat.id}`);
      if (command.startMs < 0 || command.startMs >= DURATION_MS) {
        errors.push(`command for ${actorId} outside loop`);
      }
      if (command.kind === "hold" && !(command.waypointId in STATIONS)) {
        errors.push(`hold at unknown station ${command.waypointId}`);
      }
      if (command.kind === "moveAlong" && !(command.pathId in PATHS)) {
        errors.push(`moveAlong on unknown path ${command.pathId}`);
      }
      if (command.kind === "moveAlong" && command.endProgress <= command.startProgress) {
        errors.push(`non-forward moveAlong for ${actorId}`);
      }
      if (command.kind === "express") {
        if (command.endMs <= command.startMs) errors.push(`express window for ${actorId} is empty`);
        if (command.endMs > DURATION_MS)
          warnings.push(`express window for ${actorId} crosses the seam`);
      }
      if (command.kind === "glyph" && command.durationMs <= 0) {
        errors.push(`glyph window for ${actorId} is empty`);
      }
      if (command.kind === "glyph" && command.startMs + command.durationMs > DURATION_MS) {
        warnings.push(`glyph window for ${actorId} crosses the seam`);
      }
      if (command.kind === "beam") {
        if (!(command.from in STATIONS)) errors.push(`beam from unknown waypoint ${command.from}`);
        if (!(command.to in STATIONS)) errors.push(`beam to unknown waypoint ${command.to}`);
        if (command.durationMs <= 0) errors.push(`beam for ${actorId} has empty duration`);
        if (command.startMs + command.durationMs > DURATION_MS) {
          warnings.push(`beam for ${actorId} at ${command.startMs} crosses the loop seam`);
        }
      }
      if (command.kind === "moveAlong") {
        // Retime discipline: implied path speed must stay in [0.5, 8] u/s.
        const units =
          curveLength(PATHS[command.pathId as PathId]) *
          Math.abs(command.endProgress - command.startProgress);
        const speed = units / (command.durationMs / 1000);
        if (speed < 0.5 || speed > 8) {
          errors.push(
            `moveAlong for ${actorId} implies ${speed.toFixed(2)} units/s (outside 0.5..8)`,
          );
        }
      }
      if (command.kind === "fireCue") {
        // Per-subject identity: parallel zones may fire at the same ms.
        const key = `${actorId}@${command.startMs}`;
        if (cueKeys.has(key)) errors.push(`duplicate cue for ${actorId} at ${command.startMs}`);
        cueKeys.add(key);
        cues.push({ cueId: command.cueId, timeMs: command.startMs, detail: command.detail });
      }
      const list = actorMap.get(actorId) ?? [];
      list.push(command);
      actorMap.set(actorId, list);
    }
    for (const { propId, command } of beat.propCommands) {
      if (!PROP_IDS.includes(propId as never)) errors.push(`unknown prop ${propId} in ${beat.id}`);
      if (command.startMs < 0 || command.startMs >= DURATION_MS) {
        errors.push(`prop command outside loop`);
      }
      if (
        command.kind === "followArc" &&
        (command.durationMs <= 0 || !Number.isFinite(command.lift))
      ) {
        errors.push(`bad arc for ${propId}`);
      }
      if (command.kind === "fireCue") {
        const key = `prop:${propId}@${command.startMs}`;
        if (cueKeys.has(key)) errors.push(`duplicate cue for ${propId} at ${command.startMs}`);
        cueKeys.add(key);
        cues.push({ cueId: command.cueId, timeMs: command.startMs, detail: command.detail });
      }
      const list = propMap.get(propId) ?? [];
      list.push(command);
      propMap.set(propId, list);
    }
  });

  // Motion-channel overlap: hold/moveAlong windows for one actor must not
  // overlap (pose/face may ride on top; they are state/orientation only).
  for (const [actorId, commands] of actorMap) {
    const motion = commands
      .filter(
        (c): c is Extract<ActorCommand, { durationMs: number }> =>
          c.kind === "hold" || c.kind === "moveAlong" || c.kind === "beam",
      )
      .sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < motion.length; i += 1) {
      const prev = motion[i - 1] as { startMs: number; durationMs: number };
      const cur = motion[i] as { startMs: number; durationMs: number };
      if (prev.startMs + prev.durationMs > cur.startMs) {
        errors.push(`motion overlap for ${actorId} at ${cur.startMs}`);
      }
    }
  }

  // Express channel: at most one active window per actor at any instant.
  for (const [actorId, commands] of actorMap) {
    const windows = commands
      .filter((c): c is Extract<ActorCommand, { kind: "express" }> => c.kind === "express")
      .sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < windows.length; i += 1) {
      if (windows[i - 1].endMs > windows[i].startMs) {
        errors.push(`express overlap for ${actorId} at ${windows[i].startMs}`);
      }
    }
    const glyphsOrdered = commands
      .filter((c): c is Extract<ActorCommand, { kind: "glyph" }> => c.kind === "glyph")
      .sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < glyphsOrdered.length; i += 1) {
      const prev = glyphsOrdered[i - 1];
      if (prev.startMs + prev.durationMs > glyphsOrdered[i].startMs) {
        errors.push(`glyph overlap for ${actorId} at ${glyphsOrdered[i].startMs}`);
      }
    }
  }

  // Attachment legality: strict attach/detach alternation per prop, no arc
  // while attached, and no attachment alive at the loop seam.
  for (const [propId, commands] of propMap) {
    const ordered = commands.slice().sort((a, b) => a.startMs - b.startMs);
    let owner: string | null = null;
    let arcUntil = -1;
    for (const c of ordered) {
      if (c.kind === "followArc") {
        if (owner !== null) errors.push(`arc on attached prop ${propId} at ${c.startMs}`);
        if (c.startMs < arcUntil) errors.push(`overlapping arcs on ${propId}`);
        arcUntil = c.startMs + c.durationMs;
      } else if (c.kind === "attachProp") {
        if (owner !== null) errors.push(`double attach on ${propId} at ${c.startMs}`);
        owner = "attached";
      } else if (c.kind === "detachProp") {
        // Detach with an owner hands the prop over; without one it is a
        // legal re-park of a free prop (orb/coin arcs end at an anchor).
        owner = null;
      }
    }
    if (owner !== null) errors.push(`prop ${propId} still attached at seam`);
  }

  // Ownership ledger must match the attach commands one-to-one.
  const attachTimes = new Map<string, number[]>();
  for (const [propId, commands] of propMap) {
    attachTimes.set(
      propId,
      commands.filter((c) => c.kind === "attachProp").map((c) => c.startMs),
    );
  }
  for (const own of ownership) {
    if (!PROP_IDS.includes(own.propId as never))
      errors.push(`ownership of unknown prop ${own.propId}`);
    if (!ACTOR_IDS.includes(own.actorId as never))
      errors.push(`ownership by unknown actor ${own.actorId}`);
    if (!(attachTimes.get(own.propId) ?? []).includes(own.startMs)) {
      errors.push(`ownership record for ${own.propId} at ${own.startMs} has no attach command`);
    }
  }

  const actorTracks = new Map<ActorId, Track<ActorCommand>>();
  for (const [id, commands] of actorMap) {
    actorTracks.set(asActorId(id), trackOf(id, commands));
  }
  const propTracks = new Map<PropId, Track<PropCommand>>();
  for (const [id, commands] of propMap) {
    propTracks.set(asPropId(id), trackOf(id, commands));
  }
  cues.sort((a, b) => a.timeMs - b.timeMs);
  if (errors.length > 0) throw new Error(`compileBeats: ${errors.join("; ")}`);
  return { beats, actorTracks, propTracks, cues, ownership, warnings };
}

// ---------------------------------------------------------------------------
// Pure per-subject evaluation (director input + seam test surface)
// ---------------------------------------------------------------------------

export interface ActorEval {
  readonly actorId: ActorId;
  state: BotState;
  position: { x: number; y: number; z: number };
  yaw: number;
  /** Station the actor is holding at (hold/home states), else null. */
  waypointId: WaypointId | null;
  pathId: PathId | null;
  pathProgress: number;
  phase: number;
  carriedPropId: PropId | null;
  socket: SocketId | null;
  /** Active authored expression override, else null (pose default applies). */
  expression: Expression | null;
  /** Active head glyph window, else null. */
  glyph: GlyphId | null;
  /** Clamped 0..1 progress within the active glyph window. */
  glyphPhase: number;
  /** Beam scale multiplier (null = no beam scaling this frame). */
  beamScale: number | null;
  /** True while the actor is inside a beam's invisible cut phase. */
  hidden: boolean;
}

export const createActorEval = (actorId: ActorId): ActorEval => ({
  actorId,
  state: "idle",
  position: { x: 0, y: 0, z: 0 },
  yaw: 0,
  waypointId: null,
  pathId: null,
  pathProgress: 0,
  phase: 0,
  carriedPropId: null,
  socket: null,
  expression: null,
  glyph: null,
  glyphPhase: 0,
  beamScale: null,
  hidden: false,
});

export interface PropEval {
  readonly propId: PropId;
  ownerActorId: ActorId | null;
  socket: SocketId | null;
  anchorId: AnchorId | null;
  visible: boolean;
  position: { x: number; y: number; z: number };
  yaw: number;
}

export const createPropEval = (propId: PropId): PropEval => ({
  propId,
  ownerActorId: null,
  socket: null,
  anchorId: PROP_HOME_ANCHOR[propId] ?? null,
  visible: !HIDDEN_ANCHORS.has(PROP_HOME_ANCHOR[propId] ?? ""),
  position: { x: 0, y: 0, z: 0 },
  yaw: 0,
});

let sharedSample: CurveSampleOut | null = null;
const sample = (): CurveSampleOut =>
  (sharedSample ??= { position: { x: 0, y: 0, z: 0 }, tangent: { x: 0, y: 0, z: 0 } });

const yawFromTangent = (tx: number, tz: number): number => Math.atan2(tx, tz);

/**
 * Per-actor station slot offsets, keyed `actorId@stationId` as [dx, dz].
 * Staging rule: whenever several actors share one station (gathers, queues,
 * desk rows), each gets a slot so no two bodies overlap; spacing >= 1.4 units.
 * Offsets apply to hold and implicit-home states (not to moveAlong samples,
 * which are absolute path positions). Applied identically at t=0 and the
 * seam, so the rest-state contract is unaffected.
 */
export const SLOT_OFFSETS: Readonly<Record<string, readonly [number, number]>> = {
  // Briefing half-moon (audience side, facing foreman/blueprint).
  "analyst@briefing": [-3.2, 1.8],
  "runner-a@briefing": [-1.9, 2.7],
  "runner-b@briefing": [-0.5, 3.0],
  "ambient-4@briefing": [0.9, 2.7],
  "janitor@briefing": [3.2, -0.5],
  "foreman@briefing": [-1.2, -1.4],
  "researcher-5@briefing": [3.8, 1.0],
  "intern@briefing": [-2.6, 0.9],
  "ambient-1@briefing": [-4.2, -0.1],
  "ambient-2@briefing": [-2.2, -0.9],
  // Loft desk row (researchers + ambient never overlap).
  "researcher-1@deskRow": [-1.7, -0.5],
  "researcher-4@deskRow": [0, 0.7],
  "researcher-5@deskRow": [1.7, -0.5],
  "ambient-3@deskRow": [-3.4, 0.3],
  "researcher-3@deskRow": [1.7, 1.6],
  // Chart wall watchers (front of the wall).
  "researcher-2@chartWall": [-1.5, 1.2],
  "researcher-6@chartWall": [1.5, 1.2],
  // Telescope.
  "researcher-3@telescope": [-1.2, 1.0],
  // Trading desk row.
  "intern@deskRowTrading": [0.8, 0.4],
  "ambient-4@deskRowTrading": [-1.6, -0.6],
  // Coffee swarm cluster.
  "researcher-1@coffee": [-1.4, 0.6],
  "researcher-4@coffee": [0, 1.5],
  "ambient-3@coffee": [1.4, 0.6],
  "researcher-5@coffee": [-1.4, -0.9],
  // Conveyor merge (collision staging + stagger-apart slots).
  "runner-a@conveyorOut": [-1.6, -1.0],
  "runner-b@conveyorOut": [-1.4, 0.9],
  // Stamp desk (guard + post-measure waiting spots).
  "guard-1@stampDesk": [0, -1.2],
  "runner-c@stampDesk": [-1.6, 1.2],
  "runner-a@stampDesk": [1.8, 1.4],
  // Vault safe line (order_launch retreat row, facing the cannon).
  "runner-a@vaultDoor": [-1.6, 0.9],
  "runner-b@vaultDoor": [0, 1.7],
  "runner-c@vaultDoor": [1.6, 0.9],
  "runner-d@vaultDoor": [-0.8, -1.0],
  "accountant-2@vaultDoor": [-2.8, -0.9],
  // Receipt tray.
  "accountant-1@receiptTray": [-1.2, 0.4],
  // ---- R5 zone-loop stations (shared posts + ALARM scramble gathers) ----
  // Greenhouse bay: three tenders + the alarm's 8-bot scramble wave.
  "researcher-1@greenhouse": [-2.0, 0.6],
  "researcher-4@greenhouse": [0, 1.5],
  "researcher-5@greenhouse": [2.0, 0.6],
  "researcher-2@greenhouse": [-2.6, 1.6],
  "researcher-6@greenhouse": [2.6, 1.6],
  "researcher-3@greenhouse": [-1.0, 2.4],
  "analyst@greenhouse": [1.0, 2.4],
  "ambient-3@greenhouse": [0, -1.2],
  // Greenhouse telescope bay.
  "researcher-3@greenhouseTelescope": [-1.2, 1.0],
  "analyst@greenhouseTelescope": [1.2, 1.0],
  // Whiteboard rack (tenders + the docks beamee's rest).
  "researcher-2@whiteboard": [-1.4, 0.7],
  "researcher-6@whiteboard": [1.4, 0.7],
  "ambient-3@whiteboard": [0, 1.6],
  "ambient-6@whiteboard": [0, -1.4],
  // Docks pads (oil-bar visitor's home pad vs the docks beamee).
  "ambient-3@docksA": [1.3, 0.9],
  "ambient-6@docksA": [-1.3, 0.9],
  // Oil bar (coffee + the drinking visitor).
  "coffee@oilBar": [-1.3, 0.9],
  "ambient-3@oilBar": [1.3, 0.9],
  // Back office desk A (accountants + the alarm gather + pour gag).
  "accountant-2@backOfficeDeskA": [1.4, 0.8],
  "ambient-4@backOfficeDeskA": [-1.4, 0.8],
  // Back office desk B (intern + ambient-4 filer).
  "ambient-4@backOfficeDeskB": [1.4, -0.8],
  // Gauntlet mouth (loader + the alarm gather).
  "runner-a@gauntletIn": [0, -1.2],
  "janitor@gauntletIn": [-1.3, 0.9],
  "ambient-2@gauntletIn": [1.3, 0.9],
  // Gate queue head (guard-2 + the queue-jumper nose-to-nose).
  "guard-2@queueFront": [-1.2, 0.9],
  "runner-d@queueFront": [1.2, 0.9],
  // Launch bay (gunner + the co-cranking intern + the waking sleeper).
  "gunner@launchBay": [0, -1.2],
  "intern@launchBay": [-1.4, 0.9],
  "ambient-5@launchBay": [1.4, 0.9],
};

const slotFor = (actorId: string, station: StationId): readonly [number, number] =>
  SLOT_OFFSETS[`${actorId}@${station}`] ?? [0, 0];

const placeAtStation = (out: ActorEval, actorId: string, station: StationId): void => {
  const p = stationPos(station);
  const [dx, dz] = slotFor(actorId, station);
  out.position.x = p.x + dx;
  out.position.y = p.y;
  out.position.z = p.z + dz;
};

/**
 * Evaluate one actor at absolute cyclic time. Rules (deterministic, no
 * history): position from the latest started hold (station + slot offset) or
 * moveAlong (absolute path sample, resting at endProgress after it ends);
 * state from an active pose, else the motion command's state (carry
 * overrides move when a prop is attached); yaw from an active face (resolved
 * AFTER positioning, using the live position; degenerate same-point targets
 * keep the previous yaw), else the move tangent while moving, else the
 * station facing.
 */
export function evaluateActor(
  compiled: CompiledStory,
  actorId: ActorId,
  timeMs: number,
  out: ActorEval,
): ActorEval {
  const t = periodic(timeMs, DURATION_MS);
  const track = compiled.actorTracks.get(actorId);
  const homeId = HOME_STATION[actorId];
  out.carriedPropId = null;
  out.socket = null;
  out.expression = null;
  out.glyph = null;
  out.glyphPhase = 0;
  out.beamScale = null;
  out.hidden = false;
  for (const own of compiled.ownership) {
    if (own.actorId !== actorId || own.startMs > t) continue;
    const propTrack = compiled.propTracks.get(asPropId(own.propId));
    const detached = propTrack?.commands.some(
      (c) => c.kind === "detachProp" && c.startMs > own.startMs && c.startMs <= t,
    );
    const regrabbed = compiled.ownership.some(
      (o) => o.propId === own.propId && o.startMs > own.startMs && o.startMs <= t,
    );
    if (!detached && !regrabbed) {
      out.carriedPropId = asPropId(own.propId);
      out.socket =
        propTrack?.commands.find((c) => c.kind === "attachProp" && c.startMs === own.startMs)
          ?.kind === "attachProp"
          ? (
              propTrack?.commands.find(
                (c) => c.kind === "attachProp" && c.startMs === own.startMs,
              ) as { socket: SocketId }
            ).socket
          : null;
    }
  }

  let motion: Extract<ActorCommand, { durationMs: number }> | null = null;
  let pose: Extract<ActorCommand, { durationMs: number }> | null = null;
  let faceCmd: { readonly yaw?: number; readonly waypointId?: StationId } | null = null;
  let expressCmd: Extract<ActorCommand, { kind: "express" }> | null = null;
  let glyphCmd: Extract<ActorCommand, { kind: "glyph" }> | null = null;
  if (track) {
    for (const c of track.commands) {
      if (c.startMs > t) break;
      if (c.kind === "hold" || c.kind === "moveAlong" || c.kind === "beam") motion = c;
      else if (c.kind === "pose") pose = c;
      else if (c.kind === "express") expressCmd = c;
      else if (c.kind === "glyph") glyphCmd = c;
    }
    if (expressCmd && t < expressCmd.endMs) out.expression = expressCmd.expression;
    if (glyphCmd && t < glyphCmd.startMs + glyphCmd.durationMs) {
      out.glyph = glyphCmd.glyph;
      out.glyphPhase = saturate((t - glyphCmd.startMs) / glyphCmd.durationMs);
    }
    for (const c of track.commands) {
      const face = c as { kind: string; startMs: number; durationMs: number };
      if (face.kind === "face" && activeBetween(face, t)) {
        faceCmd = c as { yaw?: number; waypointId?: StationId };
        break;
      }
    }
  }

  let station: StationId | null = null;
  if (!motion) {
    station = homeId;
    placeAtStation(out, actorId, homeId);
    out.waypointId = asWaypointId(homeId);
    out.pathId = null;
    out.pathProgress = 0;
    out.phase = 0;
  } else if (motion.kind === "hold") {
    station = motion.waypointId as StationId;
    placeAtStation(out, actorId, station);
    out.waypointId = motion.waypointId;
    out.pathId = null;
    out.pathProgress = 0;
    out.phase = saturate((t - motion.startMs) / motion.durationMs);
  } else if (motion.kind === "beam") {
    // Teleport hop: source until the cut (start + 40%), then destination.
    const cut = motion.startMs + motion.durationMs * 0.4;
    const reappear = motion.startMs + motion.durationMs * 0.7;
    const end = motion.startMs + motion.durationMs;
    if (t < cut) {
      station = motion.from as StationId;
      placeAtStation(out, actorId, station);
      out.beamScale = 1 - 0.8 * EASINGS.easeInQuad((t - motion.startMs) / (cut - motion.startMs));
    } else {
      station = motion.to as StationId;
      placeAtStation(out, actorId, station);
      out.hidden = t < reappear;
      out.beamScale =
        t < reappear
          ? 0.2
          : t < end
            ? 0.2 + 0.8 * EASINGS.easeOutCubic((t - reappear) / (end - reappear))
            : null;
    }
    out.waypointId = asWaypointId(station);
    out.pathId = null;
    out.pathProgress = 0;
    out.phase = saturate((t - motion.startMs) / motion.durationMs);
  } else {
    const path = PATHS[motion.pathId as PathId];
    const raw = saturate((t - motion.startMs) / motion.durationMs);
    const eased = EASINGS[motion.easing](raw);
    out.phase = raw;
    out.pathId = motion.pathId as PathId;
    out.pathProgress = lerp(motion.startProgress, motion.endProgress, eased);
    out.waypointId = null;
    const s = evaluateCurve(path, out.pathProgress, sample());
    out.position.x = s.position.x;
    out.position.y = s.position.y;
    out.position.z = s.position.z;
    if (raw < 1) out.yaw = yawFromTangent(s.tangent.x, s.tangent.z);
  }

  if (pose && activeBetween(pose, t)) {
    out.state = pose.state;
    out.phase = saturate((t - pose.startMs) / pose.durationMs);
  } else if (!motion) {
    out.state = "idle";
  } else if (motion.kind === "moveAlong") {
    out.state = activeBetween(motion, t) ? (out.carriedPropId ? "carry" : "move") : "idle";
  } else if (motion.kind === "hold") {
    out.state = motion.state;
  } else {
    out.state = "idle"; // beam hop: no locomotion silhouette
  }

  // Facing resolves after positioning so station-target faces use the live
  // (slotted) position; a degenerate same-point target keeps the last yaw.
  if (faceCmd !== null) {
    if (typeof faceCmd.yaw === "number") out.yaw = faceCmd.yaw;
    else if (faceCmd.waypointId) {
      const target = stationPos(faceCmd.waypointId);
      const dx = target.x - out.position.x;
      const dz = target.z - out.position.z;
      if (Math.hypot(dx, dz) > 0.3) out.yaw = Math.atan2(dx, dz);
    }
  } else {
    const target = station ?? homeId;
    const facing = STATIONS[target].facing;
    out.yaw = facing ?? 0;
    if (out.carriedPropId && motion && activeBetween(motion, t) && motion.kind === "hold") {
      out.state = "carry";
    }
  }
  return out;
}

/**
 * Evaluate one prop at absolute cyclic time. Latest attach/detach decides
 * owner vs anchor; an active arc overrides both with a sampled ballistic
 * position. Parked props rest at their anchor position.
 */
export function evaluateProp(
  compiled: CompiledStory,
  propId: PropId,
  timeMs: number,
  out: PropEval,
): PropEval {
  const t = periodic(timeMs, DURATION_MS);
  const track = compiled.propTracks.get(propId);
  out.ownerActorId = null;
  out.socket = null;
  let anchor: AnchorId | null = null;
  let arcCmd: Extract<PropCommand, { kind: "followArc" }> | null = null;
  if (track) {
    for (const c of track.commands) {
      if (c.startMs > t) break;
      if (c.kind === "attachProp") {
        const own = compiled.ownership.find((o) => o.propId === propId && o.startMs === c.startMs);
        out.ownerActorId = own ? asActorId(own.actorId) : null;
        out.socket = c.socket;
        anchor = null;
      } else if (c.kind === "detachProp") {
        out.ownerActorId = null;
        out.socket = null;
        anchor = c.anchorId;
      } else if (c.kind === "followArc") {
        arcCmd = c;
      }
    }
  }
  if (arcCmd && activeBetween(arcCmd, t)) {
    const raw = saturate((t - arcCmd.startMs) / arcCmd.durationMs);
    const e = EASINGS[arcCmd.easing](raw);
    const { from, to, lift } = arcCmd;
    const bulge = 4 * lift * e * (1 - e);
    out.position.x = lerp(from.x, to.x, e);
    out.position.y = lerp(from.y, to.y, e) + bulge;
    out.position.z = lerp(from.z, to.z, e);
    out.anchorId = null;
    out.visible = true;
    out.yaw = 0;
    return out;
  }
  const restAnchor = anchor ?? PROP_HOME_ANCHOR[propId];
  out.anchorId = restAnchor;
  const p = ANCHOR_POS[restAnchor] ?? ANCHOR_POS.breech;
  out.position.x = p.x;
  out.position.y = p.y;
  out.position.z = p.z;
  out.visible = out.socket !== null || !HIDDEN_ANCHORS.has(restAnchor);
  return out;
}
