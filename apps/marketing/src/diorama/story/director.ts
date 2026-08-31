/**
 * Director: applies the compiled story timeline to the built world and fleet
 * as pure functions of absolute logical time (types.BuiltDirector).
 *
 * Cue API (chosen): `collectCrossings(fromMs, toMs)` — cues whose authored
 * time falls in the absolute monotonic window [fromMs, toMs), firing each
 * exactly once per covered loop (windows may span the 90000ms seam or several
 * whole loops; the logical clock main.ts passes never decreases).
 * Seeks must NOT emit cues: main.ts calls collectCrossings only for the
 * playing frame delta (prevLogicalTime -> now), never after a seek jump.
 * `setSilent(true)` additionally suppresses collection (seek scrubbing).
 *
 * Machine channels that map onto world anchor objects (clock flip, telescope
 * tube, crank, gauge needle, stamp pivot, vault door, exchange arm, mint
 * press, slot pulse, antenna rings, conveyor slats, ticker tape scroll) are
 * applied here every frame. Candle heights and tape color are pure functions
 * in beats.ts (candleFactor / MachineState.tape*) left for M09 to wire to the
 * named chartWall/tickerBoard materials, which the BuiltWorld contract does
 * not expose. No per-frame allocation: all evaluation writes into reused
 * out-params.
 */

import * as THREE from "three";
import { BEAT_STARTS, CAMERA_SHOTS, CAMERA_ISO, DURATION_MS, beatAt } from "../config";
import { applyFacing, applyPose } from "../bots/motion";
import type { FleetActor } from "../bots/fleet";
import type { BuiltFleetWithActors } from "../bots/fleet";
import type { BuiltWorld } from "../types";
import type {
  ActorSnapshot,
  AnchorId,
  BuiltDirector,
  CameraSnapshot,
  CueId,
  FiredCue,
  LifecycleState,
  PropSnapshot,
  WorldSnapshot,
} from "../types";
import {
  asActorId,
  asAnchorId,
  asPropId,
  type PathId as WirePathId,
  type WaypointId as WireWaypointId,
} from "../types";
import {
  ACTOR_IDS,
  PROP_IDS,
  compileBeats,
  createActorEval,
  createMachineState,
  createPropEval,
  evaluateActor,
  evaluateMachines,
  evaluateProp,
  moodValue,
  PROP_HOME_ANCHOR,
  type ActorEval,
  type CompiledStory,
  type MachineState,
  type PropEval,
} from "./beats";

const obj = (handle: unknown): THREE.Object3D => handle as THREE.Object3D;

/**
 * Pure cue-window collection over the ever-increasing logical clock.
 * `fromMs`/`toMs` are absolute monotonic timestamps; the window may span one
 * seam or several whole loops. Decomposition: loop k covers absolute
 * [k*DURATION, (k+1)*DURATION); the cue authored at c fires at k*DURATION+c,
 * exactly once per covered loop, iff that absolute time lies in [from, to).
 * Results are appended to `hits` (caller-owned reused buffer) and returned.
 */
export function collectCueCrossings(
  cues: readonly FiredCue[],
  fromMs: number,
  toMs: number,
  hits: FiredCue[] = [],
): readonly FiredCue[] {
  hits.length = 0;
  if (toMs <= fromMs) return hits;
  const firstLoop = Math.floor(fromMs / DURATION_MS);
  const lastLoop = Math.floor((toMs - 1) / DURATION_MS);
  for (let k = firstLoop; k <= lastLoop; k += 1) {
    const loopBase = k * DURATION_MS;
    for (const cue of cues) {
      const at = loopBase + cue.timeMs;
      if (at >= fromMs && at < toMs) hits.push(cue);
    }
  }
  return hits;
}

/** Cached anchor lookups; machines not present are silently skipped. */
interface MachineObjects {
  flip?: THREE.Object3D;
  tube?: THREE.Object3D;
  tickerTape?: THREE.Object3D;
  conveyorSlats?: THREE.Object3D;
  stampPivot?: THREE.Object3D;
  vaultPivot?: THREE.Object3D;
  cannonCrank?: THREE.Object3D;
  cannonGauge?: THREE.Object3D;
  antennaRings?: THREE.Object3D;
  armBase?: THREE.Object3D;
  armLift?: THREE.Object3D;
  armClaw?: THREE.Object3D;
  mintPress?: THREE.Object3D;
  slotA?: THREE.Object3D;
  blueprint?: THREE.Object3D;
}

export interface Director extends BuiltDirector {
  /** Suppress cue collection (seek scrubbing); evaluation still applies. */
  setSilent(silent: boolean): void;
  /** Current machine channel state (M09 reads candle/tape/light values). */
  readonly machine: MachineState;
  /** Mood 0..1 at a logical timestamp (light rig input). */
  moodAt(timeMs: number): number;
}

export function createDirector(world: BuiltWorld, fleet: BuiltFleetWithActors): Director {
  const compiled: CompiledStory = compileBeats();
  const machine = createMachineState();

  const machines: MachineObjects = {};
  const anchor = (id: string): THREE.Object3D | undefined => {
    const handle = world.anchors.get(id as AnchorId);
    return handle ? obj(handle) : undefined;
  };
  const bindMachines = (): void => {
    machines.flip = anchor("flip");
    machines.tube = anchor("tube");
    machines.tickerTape = anchor("tickerTape");
    machines.conveyorSlats = anchor("conveyorSlats");
    machines.stampPivot = anchor("stampPivot");
    machines.vaultPivot = anchor("vaultPivot");
    machines.cannonCrank = anchor("cannonCrank");
    machines.cannonGauge = anchor("cannonGauge");
    machines.antennaRings = anchor("antennaRings");
    machines.armBase = anchor("armBase");
    machines.armLift = anchor("armLift");
    machines.armClaw = anchor("armClaw");
    machines.mintPress = anchor("mintPress");
    machines.slotA = anchor("slotA");
    machines.blueprint = anchor("blueprint");
  };
  bindMachines();

  const worldRoot = obj(world.root);

  // ---- Reused evaluation state (no allocation in evaluate) ----------------
  const actorEvals = new Map<string, ActorEval>();
  const actorHandles = new Map<string, FleetActor>();
  for (const actor of fleet.actorList) {
    actorEvals.set(actor.actorId, createActorEval(actor.actorId));
    actorHandles.set(actor.actorId, actor);
  }
  const propEvals = new Map<string, PropEval>();
  const propObjects = new Map<string, THREE.Object3D>();
  for (const [propId, handle] of world.props) {
    propEvals.set(propId, createPropEval(propId));
    propObjects.set(propId, obj(handle.object));
  }
  /** Last applied placement per prop: "actor:<id>" | "anchor:<id>" | "arc". */
  const propPlacement = new Map<string, string>();

  let silent = false;
  let lastTimeMs = 0;

  /** Reused cue-collection buffer (collectCrossings allocates nothing). */
  const cueHits: FiredCue[] = [];

  const poseCtx = { timeMs: 0, phase: 0, seed: 0, speed: 1 };

  // ---- Actor application ---------------------------------------------------
  const applyActors = (timeMs: number): void => {
    for (const actorId of ACTOR_IDS) {
      const actor = actorHandles.get(actorId);
      const evaluation = actorEvals.get(actorId);
      if (!actor || !evaluation) continue;
      evaluateActor(compiled, asActorId(actorId), timeMs, evaluation);
      const { rig } = actor;
      rig.root.position.set(evaluation.position.x, evaluation.position.y, evaluation.position.z);
      applyFacing(actor, evaluation.yaw);
      poseCtx.timeMs = timeMs;
      poseCtx.phase = evaluation.phase;
      poseCtx.seed = actor.seed;
      poseCtx.speed = evaluation.state === "move" || evaluation.state === "carry" ? 1.4 : 1;
      applyPose(actor, evaluation.state, poseCtx);
    }
  };

  // ---- Prop application ----------------------------------------------------
  const applyProps = (timeMs: number): void => {
    for (const propId of PROP_IDS) {
      const evaluation = propEvals.get(propId);
      const object = propObjects.get(propId);
      if (!evaluation || !object) continue;
      evaluateProp(compiled, asPropId(propId), timeMs, evaluation);
      if (evaluation.ownerActorId !== null) {
        const key = `actor:${evaluation.ownerActorId}`;
        const prev = propPlacement.get(propId);
        if (prev !== key) {
          if (prev !== undefined && prev.startsWith("actor:")) {
            // Seek jump across a hand-over (owner A -> owner B without the
            // intermediate anchor frame): release A before attaching B.
            fleet.detach(asPropId(propId), PROP_HOME_ANCHOR[propId] ?? asAnchorId("breech"));
          }
          fleet.attach(asPropId(propId), evaluation.ownerActorId, evaluation.socket ?? "carry");
          propPlacement.set(propId, key);
        }
        object.visible = true;
        continue;
      }
      if (evaluation.anchorId === null) {
        // Active arc: free-fly under the world root in world coordinates.
        const prev = propPlacement.get(propId);
        if (prev !== "arc") {
          if (prev !== undefined && prev.startsWith("actor:")) {
            // Seek jump straight into an arc: clear the fleet ownership so
            // later attaches cannot see a stale owner. Parking at the home
            // anchor is harmless - the arc overrides the transform below.
            fleet.detach(asPropId(propId), PROP_HOME_ANCHOR[propId] ?? asAnchorId("breech"));
          }
          worldRoot.add(object);
          propPlacement.set(propId, "arc");
        }
        object.visible = true;
        object.position.set(evaluation.position.x, evaluation.position.y, evaluation.position.z);
        continue;
      }
      const key = `anchor:${evaluation.anchorId}`;
      const prev = propPlacement.get(propId);
      if (prev !== key) {
        if (prev !== undefined && prev.startsWith("actor:")) {
          // Hand-over from an actor: a real fleet detach (the prop is owned).
          fleet.detach(asPropId(propId), evaluation.anchorId);
        } else if (prev !== undefined || evaluation.anchorId !== PROP_HOME_ANCHOR[propId]) {
          // Direct reparent with no attachment to release: arc landing,
          // anchor -> anchor seek jumps, or a first-evaluate seek straight
          // to a non-home anchor. (The untouched no-op is only the boot
          // frame where the prop already rests at its home anchor.)
          const anchorObject = anchor(evaluation.anchorId as string);
          if (anchorObject) {
            anchorObject.add(object);
            object.position.set(0, 0, 0);
            object.rotation.set(0, 0, 0);
            object.scale.setScalar(1);
          }
        }
        propPlacement.set(propId, key);
      }
      object.visible = evaluation.visible;
    }
  };

  // ---- Machine application -------------------------------------------------
  const applyMachines = (timeMs: number): void => {
    evaluateMachines(timeMs, machine);
    const m = machines;
    if (m.flip) m.flip.rotation.x = (-machine.clockFlip * Math.PI) / 2;
    if (m.tube) m.tube.rotation.y = machine.telescopeYaw;
    if (m.tickerTape) m.tickerTape.position.x = -(machine.tapeScroll % 2.4);
    if (m.conveyorSlats) m.conveyorSlats.position.x = -((machine.slatOffset + 0.45) % 0.9);
    if (m.stampPivot) {
      // Approve/reject strike share the pivot; -1 means resting.
      const strike = machine.stampApprove >= 0 ? machine.stampApprove : machine.stampReject;
      m.stampPivot.rotation.x = strike >= 0 ? -Math.sin(strike * Math.PI) * 0.85 : 0;
    }
    if (m.vaultPivot) m.vaultPivot.rotation.y = machine.vaultDoor * 1.15;
    if (m.cannonCrank) m.cannonCrank.rotation.z = machine.crankAngle;
    if (m.cannonGauge) m.cannonGauge.rotation.z = -machine.needle * 0.028;
    if (m.antennaRings) {
      const pulse = machine.antennaPulse;
      // Two rings ease outward over the pulse window.
      const phase = pulse < 0 ? -1 : pulse / 1800;
      m.antennaRings.scale.setScalar(phase < 0 ? 0.001 : 0.6 + phase * 1.4);
      m.antennaRings.visible = phase >= 0 && phase < 1;
    }
    if (m.armBase) m.armBase.rotation.y = machine.armBaseYaw;
    if (m.armLift) m.armLift.position.y = machine.armLift;
    if (m.armClaw) m.armClaw.rotation.x = machine.armClaw * 0.7;
    if (m.mintPress) m.mintPress.position.y = -machine.mintPress * 0.35;
    if (m.slotA) {
      const s = 1 + 0.25 * machine.slotPulse;
      m.slotA.scale.setScalar(s);
    }
    if (m.blueprint) m.blueprint.visible = machine.blueprintBeam > 0.01;
  };

  // ---- Camera (pure interpolation over the authored shots) -----------------
  const camPos = { x: 0, y: 0, z: 0 };
  const camTarget = { x: 0, y: 0, z: 0 };
  const cameraZoom = { value: 1 };
  const cameraOut: CameraSnapshot = {
    position: camPos,
    target: camTarget,
    zoom: 1,
  };
  const applyCamera = (timeMs: number): void => {
    const t = ((timeMs % DURATION_MS) + DURATION_MS) % DURATION_MS;
    let index = 0;
    for (let i = 0; i < CAMERA_SHOTS.length; i += 1) {
      if (CAMERA_SHOTS[i].startMs <= t) index = i;
    }
    const shot = CAMERA_SHOTS[index] as (typeof CAMERA_SHOTS)[number];
    const next = CAMERA_SHOTS[(index + 1) % CAMERA_SHOTS.length] as (typeof CAMERA_SHOTS)[number];
    const spanStart = shot.startMs;
    const spanEnd = index === CAMERA_SHOTS.length - 1 ? DURATION_MS : next.startMs;
    const blend = spanEnd <= spanStart ? 1 : (t - spanStart) / (spanEnd - spanStart);
    // Hold the shot for its body, ease into the next over the final 15%.
    const mix = blend < 0.85 ? 0 : (blend - 0.85) / 0.15;
    const drift = shot.drift;
    const tx = shot.target[0] + drift[0] * blend;
    const ty = shot.target[1];
    const tz = shot.target[2] + drift[1] * blend;
    camTarget.x = tx + (next.target[0] - tx) * mix;
    camTarget.y = ty + (next.target[1] - ty) * mix;
    camTarget.z = tz + (next.target[2] - tz) * mix;
    cameraZoom.value = shot.zoom + (next.zoom - shot.zoom) * mix;
    (cameraOut as { zoom: number }).zoom = cameraZoom.value;
    // Orthographic iso placement from the locked yaw/pitch.
    const yaw = CAMERA_ISO.yawRadians;
    const pitch = CAMERA_ISO.pitchRadians;
    const dist = 60 / cameraZoom.value;
    camPos.x = camTarget.x + Math.sin(yaw) * Math.cos(pitch) * dist;
    camPos.y = camTarget.y + Math.sin(pitch) * dist;
    camPos.z = camTarget.z + Math.cos(yaw) * Math.cos(pitch) * dist;
  };

  // ---- Snapshot -------------------------------------------------------------
  const snapshotActor = (actorId: string): ActorSnapshot | null => {
    const evaluation = actorEvals.get(actorId);
    const actor = actorHandles.get(actorId);
    if (!evaluation || !actor) return null;
    return {
      actorId: evaluation.actorId,
      role: actor.role,
      state: evaluation.state,
      // Hold/home states carry the station waypoint; mid-path it is null.
      waypointId: (evaluation.waypointId as WireWaypointId | null) ?? null,
      pathId: (evaluation.pathId as WirePathId | null) ?? null,
      pathProgress: evaluation.pathProgress,
      position: { x: evaluation.position.x, y: evaluation.position.y, z: evaluation.position.z },
      yaw: evaluation.yaw,
      carriedPropId: evaluation.carriedPropId,
      socket: evaluation.socket,
    };
  };
  const snapshotProp = (propId: string): PropSnapshot | null => {
    const evaluation = propEvals.get(propId);
    if (!evaluation) return null;
    return {
      propId: evaluation.propId,
      ownerActorId: evaluation.ownerActorId,
      socket: evaluation.socket,
      anchorId: evaluation.anchorId,
      visible: evaluation.visible,
      position: { x: evaluation.position.x, y: evaluation.position.y, z: evaluation.position.z },
      yaw: evaluation.yaw,
    };
  };

  const lifecycle: LifecycleState = "playing";

  return {
    machine,
    beatIds: BEAT_STARTS.map((b) => b.id),
    setSilent(flag: boolean): void {
      silent = flag;
    },
    moodAt(timeMs: number): number {
      return moodValue(((timeMs % DURATION_MS) + DURATION_MS) % DURATION_MS);
    },
    evaluate(timeMs: number): void {
      lastTimeMs = timeMs;
      applyActors(timeMs);
      applyProps(timeMs);
      applyMachines(timeMs);
      applyCamera(timeMs);
    },
    collectCrossings(fromMs: number, toMs: number): readonly FiredCue[] {
      if (silent || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
      return collectCueCrossings(compiled.cues, fromMs, toMs, cueHits);
    },
    snapshot(): WorldSnapshot {
      const actors: ActorSnapshot[] = [];
      for (const actorId of ACTOR_IDS) {
        const snap = snapshotActor(actorId);
        if (snap) actors.push(snap);
      }
      const props: PropSnapshot[] = [];
      for (const propId of PROP_IDS) {
        const snap = snapshotProp(propId);
        if (snap) props.push(snap);
      }
      return {
        version: 1,
        lifecycle,
        timeMs: lastTimeMs,
        loopCount: Math.floor(lastTimeMs / DURATION_MS),
        beatId: beatAt(lastTimeMs).id,
        playing: lifecycle === "playing",
        reducedMotion: false,
        soundEnabled: !silent,
        camera: cameraOut,
        actors,
        props,
      };
    },
  };
}

/** Pure re-export so consumers can import moodAt from the director module. */
export const moodAt = moodValue;

/** Cue id helper for consumers building audio/effect routing tables. */
export const cueId = (value: string): CueId => value as CueId;
