/**
 * Pure authoring helpers for story fragments. Every helper RETURNS data;
 * nothing here mutates module state or touches the compiler. Fragment files
 * import these plus the types and build their table with plain array pushes
 * inside their own module scope (or an IIFE) — local construction only.
 *
 * Re-exported from story/beats.ts for compatibility with existing authors.
 */

import type { StationId } from "../waypoints";
import type { PathId } from "../waypoints";
import {
  asActorId,
  asAnchorId,
  asCueId,
  asPathId,
  asPropId,
  asWaypointId,
  type ActorCommand,
  type BotState,
  type EasingName,
  type MoveAlongCommand,
  type PropCommand,
  type SocketId,
  type XYZ,
} from "../../types";
import type { FragmentActorCommand, FragmentPropCommand } from "./types";

export const P = (x: number, y: number, z: number): XYZ => ({ x, y, z });

export const mv = (
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

export const holdAt = (station: StationId, t0: number, dur: number, state: BotState = "idle") =>
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

export const poseOf = (state: BotState, t0: number, dur: number) =>
  ({ kind: "pose", startMs: t0, durationMs: dur, state }) as const;

export const cue = (cueId: string, t: number, detail?: Readonly<Record<string, number | string>>) =>
  ({ kind: "fireCue", startMs: t, cueId: asCueId(cueId), detail }) as const;

/** Attach a prop to an actor socket; the owner travels WITH the entry. */
export const grab = (
  actorId: string,
  propId: string,
  socket: SocketId,
  t: number,
): FragmentPropCommand => ({
  propId: asPropId(propId),
  ownerActorId: asActorId(actorId),
  command: { kind: "attachProp", startMs: t, propId: asPropId(propId), socket },
});

/** Release / re-park a prop at an anchor. */
export const drop = (propId: string, anchorId: string, t: number): FragmentPropCommand => ({
  propId: asPropId(propId),
  command: {
    kind: "detachProp",
    startMs: t,
    propId: asPropId(propId),
    anchorId: asAnchorId(anchorId),
  },
});

/** Ballistic arc for a free prop. */
export const arc = (
  propId: string,
  from: XYZ,
  to: XYZ,
  t0: number,
  t1: number,
  lift: number,
  easing: EasingName = "easeOutQuad",
): FragmentPropCommand => ({
  propId: asPropId(propId),
  command: {
    kind: "followArc",
    startMs: t0,
    durationMs: t1 - t0,
    propId: asPropId(propId),
    from,
    to,
    lift,
    easing,
  },
});

export const ax = (actorId: string, command: ActorCommand): FragmentActorCommand => ({
  actorId: asActorId(actorId),
  command,
});

export const propEntry = (propId: string, command: PropCommand): FragmentPropCommand => ({
  propId: asPropId(propId),
  command,
});
