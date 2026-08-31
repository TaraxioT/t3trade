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
import { BEAT_STARTS, CAMERA_SHOTS, CAMERA_ISO, DURATION_MS, PALETTE, beatAt } from "../config";
import { capsule, cone, mergeParts, paint, roundedBox } from "../geometry";
import { applyFacing, applyPose } from "../bots/motion";
import { EASINGS, saturate } from "../math";
import type { GlyphRenderer } from "../world/glyphs";
import type { SpawnOptions } from "../particles";
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
  Expression,
  XYZ,
} from "../types";
import { STATIONS, type StationId } from "./waypoints";
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
  MACHINE_WINDOWS,
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

/**
 * PAUSE-freeze time remap (pure): while the giant hand holds the MANUAL
 * CONTROL button the world clock clamps to the freeze instant for
 * freezeDur, then resumes shifted. The remap is applied to the loop-local
 * phase (the clamped instant is authored inside the 90000ms loop) and
 * rebuilt on the same loop base so the returned clock stays monotonic for
 * any absolute logical input. The camera and the hand itself run on raw
 * time and are NOT remapped.
 */
export function worldTime(timeMs: number): number {
  const phase = ((timeMs % DURATION_MS) + DURATION_MS) % DURATION_MS;
  const start = MACHINE_WINDOWS.freezeStart;
  const end = start + MACHINE_WINDOWS.freezeDur;
  const clamped = phase < start ? phase : phase < end ? start : phase - MACHINE_WINDOWS.freezeDur;
  return Math.floor(timeMs / DURATION_MS) * DURATION_MS + clamped;
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

/** Optional v2 subsystems; each is a clean no-op when absent. */
export interface DirectorDeps {
  /** Head-glyph renderer (R4); glyph windows are skipped when absent. */
  readonly glyphs?: GlyphRenderer;
  /** Particle system used for BOOT-registered beam-flash windows. */
  readonly effects?: { spawn(effectId: "beamFlash", origin: XYZ, opts?: SpawnOptions): boolean };
}

export interface Director extends BuiltDirector {
  /** Suppress cue collection (seek scrubbing); evaluation still applies. */
  setSilent(silent: boolean): void;
  /** Current machine channel state (M09 reads candle/tape/light values). */
  readonly machine: MachineState;
  /** Mood 0..1 at a logical timestamp (light rig input). */
  moodAt(timeMs: number): number;
  /** Release the director-owned transient props (the PAUSE hand). */
  dispose(): void;
}

export function createDirector(
  world: BuiltWorld,
  fleet: BuiltFleetWithActors,
  deps: DirectorDeps = {},
): Director {
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

  // ---- PAUSE gag: the giant USER HAND (director-owned transient) ----------
  // Hand v4: cartoon pointing silhouette. The deck back wall (z=-9, top
  // y~6.7) occludes the terrace below its lip, so the finger presses the
  // EMERGENCY CAP the world mounts ON the wall lip itself (see below), not
  // the podium buttons. Chunky clay-toy parts, absurdly long index finger.
  // Scale 2.2, raw-time driven, no shadows, hidden outside 74000-78000,
  // disposed with the director.
  const HAND_ENTER: XYZ = { x: -4.85, y: 16.4, z: -12.2 }; // high above, up-slope start
  const HAND_PRESS: XYZ = { x: -4.85, y: 13.13, z: -11.52 }; // fingertip meets the cap at y 6.85
  // Whole-hand tilt: ~12 deg about X toward the camera for the whole arc, so
  // the palm face angles at the viewer instead of reading edge-on.
  const HAND_TILT_X = (-12 * Math.PI) / 180;
  // Index finger: 2.4 long (capsule 0.24 r + 1.92 cylinder), tilted so the
  // tip juts forward to local z +0.55 as well as down.
  const FINGER_TILT = Math.asin(0.55 / 2.4); // ~13.3 deg from vertical
  const fingerDirY = -Math.cos(FINGER_TILT);
  const fingerDirZ = Math.sin(FINGER_TILT);
  const FINGER_BASE = { x: -0.75, y: -0.7, z: 0 };
  const handGeometry = mergeParts([
    // Sleeve ring (mint) — the wide cuff the wrist disappears into.
    paint(roundedBox(2.3, 0.8, 1.0, 0.15), PALETTE.mint).translate(0, 1.7, 0),
    // Wrist taper: narrower cream column between sleeve and palm.
    paint(roundedBox(1.4, 0.6, 0.75, 0.15), PALETTE.cream).translate(0, 1.15, 0),
    // Palm slab: 2.0 wide x 2.0 tall x 0.8 deep.
    paint(roundedBox(2.0, 2.0, 0.8, 0.3), PALETTE.cream).translate(0, -0.2, 0),
    // Index finger: capsule r 0.24, total 2.4, tilted FINGER_TILT toward the
    // camera. Center sits at base + 1.2 * dir.
    paint(capsule(0.24, 1.92, 10).rotateX(-FINGER_TILT), PALETTE.cream).translate(
      FINGER_BASE.x,
      FINGER_BASE.y + 1.2 * fingerDirY,
      FINGER_BASE.z + 1.2 * fingerDirZ,
    ),
    // Three curled knuckle bumps (0.5 x 0.55), 0.22-unit gaps between them,
    // curled back +z 0.3 behind the finger plane.
    paint(roundedBox(0.5, 0.55, 0.5, 0.18), PALETTE.cream).translate(-0.25, -0.75, 0.3),
    paint(roundedBox(0.5, 0.55, 0.5, 0.18), PALETTE.cream).translate(0.47, -0.75, 0.3),
    paint(roundedBox(0.5, 0.55, 0.5, 0.18), PALETTE.cream).translate(1.19, -0.75, 0.3),
    // Thumb: capsule r 0.35 x 0.9, sticking out sideways AND forward (+z),
    // well past the palm silhouette on the index side.
    paint(
      capsule(0.35, 0.9, 10)
        .rotateZ(Math.PI / 2)
        .rotateY(Math.PI / 6),
      PALETTE.cream,
    ).translate(-1.2, -0.5, 0.4),
  ]);
  const handMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const handMesh = new THREE.Mesh(handGeometry, handMaterial);
  handMesh.castShadow = false;
  handMesh.receiveShadow = false;
  const hand = new THREE.Group();
  hand.add(handMesh);
  hand.scale.setScalar(2.2);
  hand.rotation.x = HAND_TILT_X;
  hand.visible = false;
  worldRoot.add(hand);

  // ---- EMERGENCY CAP on the wall lip (always-visible transient) -----------
  // The terrace's big red button, mounted where the iso camera can actually
  // see it: on the deck back-wall lip directly above the MANUAL CONTROL
  // podium. Emissive red (toneMapped false for the pop) in a brass socket;
  // squashes 30% and fires a one-shot red pulse ring whenever the finger
  // presses (freezeStart and each impatient tap). No particle system — the
  // ring is an analytic scale/opacity pulse on a thin ring mesh.
  const CAP_POS: XYZ = { x: -6.5, y: 6.85, z: -8.95 };
  const capSocketGeo = paint(new THREE.CylinderGeometry(0.64, 0.72, 0.1, 20), PALETTE.brass);
  const capSocket = new THREE.Mesh(
    capSocketGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  );
  const capRedGeo = paint(new THREE.CylinderGeometry(0.5, 0.5, 0.18, 20), PALETTE.dataRed);
  const capRed = new THREE.Mesh(
    capRedGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
  );
  capRed.position.y = 0.12;
  const capRingGeo = new THREE.RingGeometry(0.55, 0.8, 24).rotateX(-Math.PI / 2);
  const capRing = new THREE.Mesh(
    capRingGeo,
    new THREE.MeshBasicMaterial({
      color: PALETTE.dataRed,
      transparent: true,
      opacity: 0,
      toneMapped: false,
      depthWrite: false,
    }),
  );
  capRing.position.y = 0.2;
  for (const m of [capSocket, capRed, capRing]) {
    m.castShadow = false;
    m.receiveShadow = false;
  }
  const cap = new THREE.Group();
  cap.add(capSocket, capRed, capRing);
  cap.position.set(CAP_POS.x, CAP_POS.y, CAP_POS.z);
  worldRoot.add(cap);
  /** Cap squash + pulse ring on every finger contact (raw loop time). */
  const applyCap = (t: number): void => {
    const pressPulse = (at: number, dur: number): number =>
      t < at || t >= at + dur ? 0 : Math.sin(Math.PI * ((t - at) / dur));
    const w = MACHINE_WINDOWS.pause;
    const inWindow = t >= w[0] && t < w[1];
    // Contacts: the freeze-press at freezeStart, then the two impatient taps.
    const squash = inWindow
      ? Math.max(
          pressPulse(MACHINE_WINDOWS.freezeStart, 350),
          pressPulse(74700, 200),
          pressPulse(75050, 200),
        )
      : 0;
    cap.scale.set(1 + 0.12 * squash, 1 - 0.3 * squash, 1 + 0.12 * squash);
    const ring = squash > 0 ? Math.min(1, squash * 1.4) : 0;
    capRing.visible = ring > 0.01;
    if (capRing.visible) {
      capRing.scale.setScalar(1 + 1.1 * ring);
      (capRing.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - ring);
    }
  };

  // ---- Gauntlet scanner emitter (director-owned transient) -----------------
  // Renders the scannerSweep channel: an emissive mint dot sliding along the
  // pylon row (x per MACHINE_WINDOWS.scannerX, above the belt between the
  // two pylon rows) with a downward beam cone onto the belt. Sized to read
  // at wide zoom (r 0.3 dot, 1.7 cone). Visible only while scannerGlow > 0.
  const SCANNER_Y = 2.0;
  const SCANNER_Z = 7;
  const scannerDotGeo = paint(new THREE.SphereGeometry(0.3, 12, 10), PALETTE.mintBright);
  const scannerDot = new THREE.Mesh(
    scannerDotGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true }),
  );
  const scannerConeGeo = paint(cone(0.6, 1.7, 10).rotateX(Math.PI), PALETTE.mint);
  const scannerCone = new THREE.Mesh(
    scannerConeGeo,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    }),
  );
  scannerDot.castShadow = false;
  scannerCone.castShadow = false;
  const scanner = new THREE.Group();
  scanner.add(scannerDot);
  scanner.add(scannerCone);
  scanner.visible = false;
  worldRoot.add(scanner);
  const applyScanner = (): void => {
    const [x0, x1] = MACHINE_WINDOWS.scannerX;
    scanner.visible = machine.scannerGlow > 0;
    if (!scanner.visible) return;
    const x = x0 + (x1 - x0) * machine.scannerSweep;
    scannerDot.position.set(x, SCANNER_Y, SCANNER_Z);
    scannerDot.scale.setScalar(0.7 + 0.3 * machine.scannerGlow);
    scannerCone.position.set(x, SCANNER_Y - 1.05, SCANNER_Z);
    const coneScale = 0.8 + 0.2 * machine.scannerGlow;
    scannerCone.scale.set(coneScale, 1, coneScale);
  };

  /**
   * Hand arc on RAW loop time (never remapped): descend 74000->74200, press
   * at 74200, two impatient 200ms taps while frozen time holds, retreat
   * 77400->78000, hidden outside the window.
   */
  const applyHand = (timeMs: number): void => {
    const t = ((timeMs % DURATION_MS) + DURATION_MS) % DURATION_MS;
    const w = MACHINE_WINDOWS.pause;
    if (t < w[0] || t >= w[1]) {
      hand.visible = false;
      return;
    }
    hand.visible = true;
    const descend = saturate((t - w[0]) / (MACHINE_WINDOWS.freezeStart - w[0]));
    const retreat = saturate((t - 77400) / (w[1] - 77400));
    // Cubic-arc feel: ease the descent in, the retreat out.
    const travel = EASINGS.easeInOutCubic(descend) * (1 - EASINGS.easeInOutCubic(retreat));
    const handPulse = (at: number, dur: number): number =>
      t < at || t >= at + dur ? 0 : Math.sin(Math.PI * ((t - at) / dur));
    const tap1 = handPulse(74700, 200);
    const tap2 = handPulse(75050, 200);
    const press = t >= MACHINE_WINDOWS.freezeStart ? 1 : 0;
    hand.position.set(
      HAND_ENTER.x + (HAND_PRESS.x - HAND_ENTER.x) * travel,
      HAND_ENTER.y + (HAND_PRESS.y - HAND_ENTER.y) * travel - press * 0.25 * (tap1 + tap2),
      HAND_ENTER.z + (HAND_PRESS.z - HAND_ENTER.z) * travel,
    );
    // Slight extra lean while pressing (the base -12 deg X tilt is constant).
    hand.rotation.z = 0.06 * travel * (1 - retreat);
  };

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

  const poseCtx = {
    timeMs: 0,
    phase: 0,
    seed: 0,
    speed: 1,
    expression: undefined as Expression | undefined,
  };

  /** Stable actorId -> glyph slot index (fleet.actorList order). */
  const actorIndex = new Map<string, number>();
  fleet.actorList.forEach((actor, index) => actorIndex.set(actor.actorId, index));
  const glyphVec = new THREE.Vector3();

  // BOOT registration: every authored beam gets its mint flash as an
  // analytic particle window keyed by (effectId, triggerMs, instance), so it
  // survives seeks (cues do not). Trigger at the cut instant, at the
  // destination station.
  if (deps.effects) {
    let beamInstance = 0;
    for (const track of compiled.actorTracks.values()) {
      for (const c of track.commands) {
        if (c.kind !== "beam") continue;
        const to = STATIONS[c.to as StationId];
        deps.effects.spawn(
          "beamFlash",
          { x: to.x, y: to.y + 0.6, z: to.z },
          {
            triggerMs: c.startMs + c.durationMs * 0.4,
            instance: beamInstance++,
          },
        );
      }
    }
  }

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
      poseCtx.expression = evaluation.expression ?? undefined;
      applyPose(actor, evaluation.state, poseCtx);
      // Beam hop: applyPose resets root scale every call, so multiply AFTER
      // the pose, and gate visibility per the beam's invisible cut phase.
      if (evaluation.beamScale !== null) rig.root.scale.multiplyScalar(evaluation.beamScale);
      rig.root.visible = !evaluation.hidden;
    }
  };

  /** Glyph windows: analytic, seek-safe. Actors with an active window get
   *  their head world position + phase applied; every other slot is hidden
   *  every frame, so a cold seek always leaves exactly the right slots. */
  const applyGlyphs = (): void => {
    const glyphs = deps.glyphs;
    if (!glyphs) return;
    for (const actorId of ACTOR_IDS) {
      const index = actorIndex.get(actorId);
      if (index === undefined || index >= glyphs.slotCount) continue;
      const evaluation = actorEvals.get(actorId);
      const actor = actorHandles.get(actorId);
      if (!evaluation || !actor) continue;
      if (evaluation.glyph !== null) {
        actor.rig.headFx.getWorldPosition(glyphVec);
        glyphs.setSlotPosition(index, glyphVec.x, glyphVec.y, glyphVec.z);
        glyphs.applyWindow(index, evaluation.glyph, evaluation.glyphPhase);
      } else {
        glyphs.hide(index);
      }
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
      expression: evaluation.expression ?? undefined,
      glyph: evaluation.glyph,
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
      // PAUSE freeze: actor/prop/machine/glyph evaluation runs on the
      // remapped world clock; the camera and the hand keep raw logical time
      // (main.ts's own camera evaluation is likewise never remapped).
      const wt = worldTime(timeMs);
      applyActors(wt);
      applyGlyphs();
      applyProps(wt);
      applyMachines(wt);
      applyHand(timeMs);
      applyCap(((timeMs % DURATION_MS) + DURATION_MS) % DURATION_MS);
      applyScanner();
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
    dispose(): void {
      // Transient director-owned props only; the world/fleet/effect
      // lifetimes belong to their builders and the main registry.
      worldRoot.remove(hand);
      handGeometry.dispose();
      handMaterial.dispose();
      worldRoot.remove(scanner);
      scannerDotGeo.dispose();
      (scannerDot.material as THREE.Material).dispose();
      scannerConeGeo.dispose();
      (scannerCone.material as THREE.Material).dispose();
      worldRoot.remove(cap);
      capSocketGeo.dispose();
      (capSocket.material as THREE.Material).dispose();
      capRedGeo.dispose();
      (capRed.material as THREE.Material).dispose();
      capRingGeo.dispose();
      (capRing.material as THREE.Material).dispose();
    },
  };
}

/** Pure re-export so consumers can import moodAt from the director module. */
export const moodAt = moodValue;

/** Cue id helper for consumers building audio/effect routing tables. */
export const cueId = (value: string): CueId => value as CueId;
