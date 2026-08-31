/**
 * Boundary types for the diorama runtime.
 *
 * This module is pure TypeScript: no THREE, no DOM. It defines the narrow
 * contracts every subsystem (world M04, fleet M05, director M06) codes
 * against, so builders never need to meet each other.
 */

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

export type ActorId = string & { readonly __brand: "ActorId" };
export type PropId = string & { readonly __brand: "PropId" };
export type WaypointId = string & { readonly __brand: "WaypointId" };
export type PathId = string & { readonly __brand: "PathId" };
export type BeatId = string & { readonly __brand: "BeatId" };
export type AnchorId = string & { readonly __brand: "AnchorId" };
export type CueId = string & { readonly __brand: "CueId" };

/** Brand helpers so story authoring modules can mint IDs without casting. */
export const asActorId = (value: string): ActorId => value as ActorId;
export const asPropId = (value: string): PropId => value as PropId;
export const asWaypointId = (value: string): WaypointId => value as WaypointId;
export const asPathId = (value: string): PathId => value as PathId;
export const asBeatId = (value: string): BeatId => value as BeatId;
export const asAnchorId = (value: string): AnchorId => value as AnchorId;
export const asCueId = (value: string): CueId => value as CueId;

// ---------------------------------------------------------------------------
// Core unions
// ---------------------------------------------------------------------------

/** Visual bot states owned by the director; poses owned by motion.ts. */
export type BotState =
  | "idle"
  | "move"
  | "carry"
  | "work"
  | "argue"
  | "fight"
  | "collide"
  | "celebrate"
  | "react"
  | "faint";

/** Story cast roles (see 04-story-script.md). */
export type Role =
  | "foreman"
  | "researcher"
  | "analyst"
  | "runner"
  | "guard"
  | "gunner"
  | "accountant"
  | "intern"
  | "janitor"
  | "coffee"
  | "ambient";

/** Attachment sockets exposed by every bot rig. */
export type SocketId = "leftHand" | "rightHand" | "carry";

/** Easing names resolvable in math.ts. */
export type EasingName =
  | "linear"
  | "smoothstep"
  | "easeInOutCubic"
  | "easeOutCubic"
  | "easeOutBack"
  | "easeInQuad"
  | "easeOutQuad"
  | "easeOutElastic";

/**
 * Bot facial expression, v2 emotion system (08-design-direction-v2.md
 * Decision 3). Implemented as geometry toggle between prebuilt eye-pair
 * shapes; never a facial rig.
 */
export type Expression = "happy" | "bored" | "angry" | "panic" | "surprised" | "neutral";

/**
 * Comic glyph popped above a bot's head (Decision 3 glyph pops). Analytic
 * duration windows, not fireCue one-shots, so seeking directly into the
 * window shows the glyph.
 */
export type GlyphId = "alarm" | "question" | "sleep" | "anger" | "heart" | "star";

/** Runtime lifecycle, owned and arbitrated by main.ts. */
export type LifecycleState =
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "static"
  | "failed"
  | "disposed";

/** Immutable plain number triple shared across modules. */
export interface XYZ {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// ---------------------------------------------------------------------------
// Story commands (plan section 6 vocabulary)
// ---------------------------------------------------------------------------

export interface HoldCommand {
  readonly kind: "hold";
  readonly startMs: number;
  readonly durationMs: number;
  readonly waypointId: WaypointId;
  readonly state: BotState;
}

export interface MoveAlongCommand {
  readonly kind: "moveAlong";
  readonly startMs: number;
  readonly durationMs: number;
  readonly pathId: PathId;
  /** Progress window inside the path, both in [0, 1]. */
  readonly startProgress: number;
  readonly endProgress: number;
  readonly easing: EasingName;
}

export interface FaceCommand {
  readonly kind: "face";
  readonly startMs: number;
  readonly durationMs: number;
  /** Target waypoint to look at, or an explicit authored yaw in radians. */
  readonly waypointId?: WaypointId;
  readonly yaw?: number;
}

export interface AttachPropCommand {
  readonly kind: "attachProp";
  readonly startMs: number;
  readonly propId: PropId;
  readonly socket: SocketId;
}

export interface DetachPropCommand {
  readonly kind: "detachProp";
  readonly startMs: number;
  readonly propId: PropId;
  readonly anchorId: AnchorId;
}

export interface PoseCommand {
  readonly kind: "pose";
  readonly startMs: number;
  readonly durationMs: number;
  readonly state: BotState;
}

/** Analytic ballistic-style arc for thrown, falling, launched, returned props. */
export interface FollowArcCommand {
  readonly kind: "followArc";
  readonly startMs: number;
  readonly durationMs: number;
  readonly propId: PropId;
  readonly from: XYZ;
  readonly to: XYZ;
  /** Peak height added above the straight from-to line, in scene units. */
  readonly lift: number;
  readonly easing: EasingName;
}

/** One-shot effect/audio cue fired on a forward threshold crossing. */
export interface FireCueCommand {
  readonly kind: "fireCue";
  readonly startMs: number;
  readonly cueId: CueId;
  /** Cue-specific payload (particle origin, audio sprite name, ...). */
  readonly detail?: Readonly<Record<string, number | string>>;
}

/**
 * Authored expression override window on the independent expression channel.
 * Resolution order: pose state supplies the default expression, then an
 * active `express` command overrides it. Exactly one express command may be
 * active per actor at a time; overlaps are rejected at compile time.
 * `endMs` is absolute, like `startMs`.
 */
export interface ExpressCommand {
  readonly kind: "express";
  readonly actorId: ActorId;
  readonly expression: Expression;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Comic glyph window above the actor's head. A duration-bearing analytic
 * command (NOT a fireCue): visibility, float, overshoot, and fade derive
 * purely from absolute time, so a direct seek into the window renders it
 * correctly. One glyph per actor at a time; overlaps rejected at compile
 * time.
 */
export interface GlyphCommand {
  readonly kind: "glyph";
  readonly actorId: ActorId;
  readonly glyph: GlyphId;
  readonly startMs: number;
  readonly durationMs: number;
}

/**
 * Teleport hop: bot contracts at `from`, cuts (invisible) to `to`, and
 * expands back to normal scale. Participates in the EXCLUSIVE motion channel
 * (mutually exclusive with hold and moveAlong); compile-time validation:
 * both waypoints exist, duration > 0, no motion-channel overlap for the
 * actor. Windows crossing the 90000 ms seam are an advisory warning, not an
 * error. The destination is the persistent post-command rest position.
 */
export interface BeamCommand {
  readonly kind: "beam";
  readonly actorId: ActorId;
  readonly from: WaypointId;
  readonly to: WaypointId;
  readonly startMs: number;
  readonly durationMs: number;
}

export type ActorCommand =
  | HoldCommand
  | MoveAlongCommand
  | FaceCommand
  | PoseCommand
  | FireCueCommand
  | ExpressCommand
  | GlyphCommand
  | BeamCommand;

export type PropCommand = AttachPropCommand | DetachPropCommand | FollowArcCommand | FireCueCommand;

export type StoryCommand = ActorCommand | PropCommand;

// ---------------------------------------------------------------------------
// Beats and compiled tracks
// ---------------------------------------------------------------------------

export interface Beat {
  readonly id: BeatId;
  readonly startMs: number;
  readonly durationMs: number;
  readonly actorCommands: ReadonlyArray<{
    readonly actorId: ActorId;
    readonly command: ActorCommand;
  }>;
  readonly propCommands: ReadonlyArray<{ readonly propId: PropId; readonly command: PropCommand }>;
}

/** Compiled, time-sorted command track for one subject. */
export interface Track<C extends StoryCommand> {
  readonly subjectId: string;
  readonly starts: ReadonlyArray<number>;
  readonly commands: readonly C[];
}

/** A cue that crossed the evaluation window, delivered to effects/audio. */
export interface FiredCue {
  readonly cueId: CueId;
  readonly timeMs: number;
  readonly detail?: Readonly<Record<string, number | string>>;
}

// ---------------------------------------------------------------------------
// Snapshots (instrumentation + seam test surface)
// ---------------------------------------------------------------------------

export interface CameraSnapshot {
  readonly position: XYZ;
  readonly target: XYZ;
  readonly zoom: number;
}

export interface ActorSnapshot {
  readonly actorId: ActorId;
  readonly role: Role;
  readonly state: BotState;
  readonly waypointId: WaypointId | null;
  readonly pathId: PathId | null;
  readonly pathProgress: number;
  readonly position: XYZ;
  readonly yaw: number;
  readonly carriedPropId: PropId | null;
  readonly socket: SocketId | null;
  /** Active expression after pose-default/express-override resolution. */
  readonly expression?: Expression;
  /** Active head glyph, or null/omitted when no glyph window is active. */
  readonly glyph?: GlyphId | null;
}

export interface PropSnapshot {
  readonly propId: PropId;
  /** Owning actor, or null when parked at an anchor. */
  readonly ownerActorId: ActorId | null;
  readonly socket: SocketId | null;
  readonly anchorId: AnchorId | null;
  readonly visible: boolean;
  readonly position: XYZ;
  readonly yaw: number;
}

export interface WorldSnapshot {
  readonly version: number;
  readonly lifecycle: LifecycleState;
  readonly timeMs: number;
  readonly loopCount: number;
  readonly beatId: BeatId;
  readonly playing: boolean;
  readonly reducedMotion: boolean;
  readonly soundEnabled: boolean;
  readonly camera: CameraSnapshot;
  readonly actors: readonly ActorSnapshot[];
  readonly props: readonly PropSnapshot[];
}

// ---------------------------------------------------------------------------
// Built subsystem contracts (what M04 / M05 / M06 return to main.ts)
// ---------------------------------------------------------------------------

/**
 * Opaque scene-object handle. Builders hold real THREE.Object3D values;
 * consumers of these contracts must not reach into Three through them.
 */
export type SceneObject = object & { readonly __brand: "SceneObject" };

/** World-prop handle returned by world builders and consumed by the fleet/director. */
export interface PropHandle {
  readonly propId: PropId;
  readonly object: SceneObject;
  /** Anchor the prop occupies when the loop is at rest. */
  readonly homeAnchorId: AnchorId;
}

export interface ActorHandle {
  readonly actorId: ActorId;
  readonly role: Role;
  readonly object: SceneObject;
  /** Bot-height seed derived from the actor ID; used for cosmetic phase offsets. */
  readonly seed: number;
  readonly sockets: Readonly<Record<SocketId, SceneObject>>;
}

/** Built by world/index.ts (M04). Static geometry and named registries only. */
export interface BuiltWorld {
  readonly root: SceneObject;
  /** World anchors keyed by AnchorId (detach targets, spawn points). */
  readonly anchors: ReadonlyMap<AnchorId, SceneObject>;
  /** Named props keyed by PropId. */
  readonly props: ReadonlyMap<PropId, PropHandle>;
  /** Objects that must be rendered into the frozen static shadow map. */
  readonly staticShadowCasters: readonly SceneObject[];
}

/** Built by bots/fleet.ts (M05). Named actors plus attachment ownership. */
export interface BuiltFleet {
  readonly root: SceneObject;
  readonly actors: ReadonlyMap<ActorId, ActorHandle>;
  /**
   * Idempotent attachment table: exactly zero or one owner per prop.
   * `ownerActorId === null` parks the prop at `anchorId`.
   */
  attach(propId: PropId, ownerActorId: ActorId, socket: SocketId): void;
  detach(propId: PropId, anchorId: AnchorId): void;
  /** Reset all props to the world-prop root; used on seek/reload. */
  clearAttachments(): void;
  /** Throws on double ownership or detach-without-owner. */
  assertConsistent(): void;
}

/** Built by story/director.ts (M06). Pure absolute-time evaluation. */
export interface BuiltDirector {
  /** Evaluate the full story at an absolute logical timestamp (ms, cyclic). */
  evaluate(timeMs: number): void;
  /**
   * One-shot cues whose `startMs` crossed in [fromMs, toMs) while playing
   * forward. Seek/jump evaluation never emits crossings.
   */
  collectCrossings(fromMs: number, toMs: number): readonly FiredCue[];
  /** Canonical, JSON-serializable snapshot at the current logical time. */
  snapshot(): WorldSnapshot;
  /** Ordered beat IDs from the compiled table. */
  readonly beatIds: readonly BeatId[];
}

/** Aggregate handed to main.ts (M09) after staged assembly. */
export interface BuiltSubsystems {
  readonly world: BuiltWorld;
  readonly fleet: BuiltFleet;
  readonly director: BuiltDirector;
}
