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

import { BEAT_STARTS, DURATION_MS } from "../config";
import { EASINGS, evaluateCurve, lerp, periodic, saturate } from "../math";
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

/** Home station per actor (must match fleet ROSTER homes). */
export const HOME_STATION: Readonly<Record<string, StationId>> = {
  foreman: "briefing",
  "researcher-1": "deskRow",
  "researcher-2": "chartWall",
  "researcher-3": "telescope",
  "researcher-4": "deskRow",
  "researcher-5": "deskRow",
  "researcher-6": "chartWall",
  analyst: "tickerBoard",
  "runner-a": "conveyorIn",
  "runner-b": "conveyorOut",
  "runner-c": "poleTopLoft",
  "runner-d": "queueTail",
  "guard-1": "stampDesk",
  "guard-2": "queueHead",
  gunner: "cannon",
  "accountant-1": "receiptTray",
  "accountant-2": "vaultDoor",
  intern: "deskRowTrading",
  janitor: "briefing",
  coffee: "coffee",
  "ambient-1": "stairTopLoft",
  "ambient-2": "stairBottomLoft",
  "ambient-3": "deskRow",
  "ambient-4": "deskRowTrading",
  "ambient-5": "pipeArrival",
  "ambient-6": "roofStair",
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
};

/** Anchors where a parked prop stays hidden (orb breech park, minted coins). */
const HIDDEN_ANCHORS = new Set(["breech", "mintStation"]);

const stationPos = (id: StationId): XYZ => {
  const s = STATIONS[id];
  return { x: s.x, y: s.y, z: s.z };
};

// ---------------------------------------------------------------------------
// Command authoring helpers (keep BEATS below compact)
// ---------------------------------------------------------------------------

type ActorEntry = { readonly actorId: ActorId; readonly command: ActorCommand };
type PropEntry = { readonly propId: PropId; readonly command: PropCommand };
type Detail = Readonly<Record<string, number | string>>;

const mv = (
  path: PathId,
  t0: number,
  t1: number,
  easing: EasingName = "easeInOutCubic",
  p0 = 0,
  p1 = 1,
): MoveAlongCommand => ({
  kind: "moveAlong",
  startMs: t0,
  durationMs: t1 - t0,
  pathId: asPathId(path),
  startProgress: p0,
  endProgress: p1,
  easing,
});

const holdAt = (station: StationId, t0: number, dur: number, state: BotState = "idle") =>
  ({
    kind: "hold",
    startMs: t0,
    durationMs: dur,
    waypointId: asWaypointId(station),
    state,
  }) as const;

export const faceTo = (station: StationId, t0: number, dur = 400) =>
  ({ kind: "face", startMs: t0, durationMs: dur, waypointId: asWaypointId(station) }) as const;

export const faceYaw = (yaw: number, t0: number, dur = 400) =>
  ({ kind: "face", startMs: t0, durationMs: dur, yaw }) as const;

const poseOf = (state: BotState, t0: number, dur: number) =>
  ({ kind: "pose", startMs: t0, durationMs: dur, state }) as const;

const cue = (cueId: string, t: number, detail?: Detail) =>
  ({ kind: "fireCue", startMs: t, cueId: asCueId(cueId), detail }) as const;

/** Ownership ledger: types.AttachPropCommand carries no actor, so beats.ts
 *  records who grabbed what; compileBeats cross-checks it. */
const OWNERSHIP: readonly {
  readonly propId: string;
  readonly actorId: string;
  readonly startMs: number;
}[] = [];

const grab = (actorId: string, propId: string, socket: SocketId, t: number) => {
  (OWNERSHIP as { propId: string; actorId: string; startMs: number }[]).push({
    propId,
    actorId,
    startMs: t,
  });
  return { kind: "attachProp", startMs: t, propId: asPropId(propId), socket } as const;
};

const drop = (propId: string, anchorId: string, t: number) =>
  ({
    kind: "detachProp",
    startMs: t,
    propId: asPropId(propId),
    anchorId: asAnchorId(anchorId),
  }) as const;

const arc = (
  propId: string,
  from: XYZ,
  to: XYZ,
  t0: number,
  t1: number,
  lift: number,
  easing: EasingName = "easeOutQuad",
) =>
  ({
    kind: "followArc",
    startMs: t0,
    durationMs: t1 - t0,
    propId: asPropId(propId),
    from,
    to,
    lift,
    easing,
  }) as const;

const P = (x: number, y: number, z: number): XYZ => ({ x, y, z });

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

const ax = (actorId: string, command: ActorCommand): ActorEntry => ({
  actorId: asActorId(actorId),
  command,
});
const px = (propId: string, command: PropCommand): PropEntry => ({
  propId: asPropId(propId),
  command,
});

// ---------------------------------------------------------------------------
// BEATS — authored as flat command streams per phase, then distributed into
// the canonical skeleton beats by start-time containment.
// ---------------------------------------------------------------------------

const ALL_ACTOR: ActorEntry[] = [];
const ALL_PROP: PropEntry[] = [];

/** Authoring sinks. */
const A = (actorId: string, command: ActorCommand): void => {
  ALL_ACTOR.push(ax(actorId, command));
};
const Pr = (propId: string, command: PropCommand): void => {
  ALL_PROP.push(px(propId, command));
};
/** Narration cues ride an unobtrusive actor track (fireCue has no duration
 *  and never touches motion channels). */
const CUE_ACTOR = "ambient-6";
const C = (cueId: string, t: number, detail?: Detail): void => {
  ALL_ACTOR.push(ax(CUE_ACTOR, cue(cueId, t, detail)));
};

// --- Phase authoring blocks are appended below (one Edit per phase) -------
// Distribution into BEATS happens at the bottom of this file, after all
// phase blocks have run their A()/Pr()/C() calls.

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
  CONGA.forEach((actorId, i) => {
    A(actorId, mv("congaLoop", 71050 + i * 550, 71050 + i * 550 + 5600, "linear"));
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
  A("foreman", mv("congaLoop", 74000, 78500, "linear", 0, 0.6));
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
  const actorMap = new Map<string, ActorCommand[]>();
  const propMap = new Map<string, PropCommand[]>();
  const cues: FiredCue[] = [];
  const errors: string[] = [];

  if (BEATS.length !== BEAT_STARTS.length) errors.push("beat count mismatch vs BEAT_STARTS");
  BEATS.forEach((beat, i) => {
    const skeleton = BEAT_STARTS[i];
    if (!skeleton || beat.id !== skeleton.id) errors.push(`beat ${i} id mismatch`);
    if (beat.startMs !== (skeleton?.startMs ?? beat.startMs))
      errors.push(`beat ${beat.id} start mismatch`);
    if (beat.startMs < 0 || beat.startMs + beat.durationMs > DURATION_MS) {
      errors.push(`beat ${beat.id} exceeds loop`);
    }
    for (const { actorId, command } of beat.actorCommands) {
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
      if (command.kind === "fireCue") {
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
          c.kind === "hold" || c.kind === "moveAlong",
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
  for (const own of OWNERSHIP) {
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
  const cueTimes = new Set(cues.map((c) => c.timeMs));
  if (cueTimes.size !== cues.length) errors.push("duplicate cue times");
  if (errors.length > 0) throw new Error(`compileBeats: ${errors.join("; ")}`);
  return { beats: BEATS, actorTracks, propTracks, cues, ownership: OWNERSHIP };
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
  if (track) {
    for (const c of track.commands) {
      if (c.startMs > t) break;
      if (c.kind === "hold" || c.kind === "moveAlong") motion = c;
      else if (c.kind === "pose") pose = c;
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
  } else {
    out.state = motion.state;
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

// ---------------------------------------------------------------------------
// Beat assembly (runs after every phase block above)
// ---------------------------------------------------------------------------

const beatIndexFor = (startMs: number): number => {
  if (startMs < 0 || startMs >= DURATION_MS)
    throw new Error(`command start ${startMs} outside loop`);
  let index = 0;
  for (let i = 0; i < BEAT_STARTS.length; i += 1) {
    if (BEAT_STARTS[i].startMs <= startMs) index = i;
  }
  return index;
};

const actorByBeat: ActorEntry[][] = BEAT_STARTS.map(() => []);
const propByBeat: PropEntry[][] = BEAT_STARTS.map(() => []);
for (const entry of ALL_ACTOR) actorByBeat[beatIndexFor(entry.command.startMs)]?.push(entry);
for (const entry of ALL_PROP) propByBeat[beatIndexFor(entry.command.startMs)]?.push(entry);

export const BEATS: readonly Beat[] = BEAT_STARTS.map((_s, i) =>
  makeBeat(i)(actorByBeat[i] ?? [], propByBeat[i] ?? []),
);
