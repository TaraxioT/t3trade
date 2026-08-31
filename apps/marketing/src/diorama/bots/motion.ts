/**
 * Pure pose evaluation for all ten bot states (plan section 6, research
 * section 1). Every pose is an analytic function of absolute time plus the
 * per-actor seed offset — no accumulated phase, no random calls, no state
 * transitions (the director owns those), and no allocation in the hot path.
 *
 * Each applyPose call fully re-specifies every channel it touches, so
 * switching states can never leak residual rotation from the previous state.
 * The rig root's world position and yaw stay owned by the director; only the
 * `body` group, arms, eyes, and root scale are written here.
 */

import { angleDelta, easeOutCubic, lerp, saturate } from "../math";
import type { BotState, Expression } from "../types";
import type { FleetActor } from "./fleet";

export interface PoseContext {
  /** Absolute logical story time in milliseconds. */
  readonly timeMs: number;
  /** Progress 0..1 within the current command (used by one-shot states). */
  readonly phase: number;
  /** Per-actor cosmetic seed (pass actor.seed). */
  readonly seed: number;
  /** Locomotion speed multiplier; 1 = normal walk. */
  readonly speed?: number;
  /**
   * Authored expression override (director-owned window). When present it
   * wins over the pose-state default; absent means "use the default".
   */
  readonly expression?: Expression;
}

/**
 * Deterministic default expression per pose state (codex R4 resolution
 * order: pose default, then authored override). Visibility-only switching
 * through rig.setExpression; repeated evaluation is idempotent.
 */
const DEFAULT_EXPRESSION: Readonly<Record<BotState, Expression>> = {
  idle: "neutral",
  move: "neutral",
  carry: "bored",
  work: "happy",
  argue: "angry",
  fight: "angry",
  collide: "panic",
  celebrate: "happy",
  react: "surprised",
  faint: "neutral",
};

const TAU_ = Math.PI * 2;

/** Amplitude multiplier; ambient extras keep everything at 60% so heroes read. */
const amplitudeFor = (actor: FleetActor): number => (actor.role === "ambient" ? 0.6 : 1);

export function applyPose(actor: FleetActor, state: BotState, ctx: PoseContext): void {
  const { rig } = actor;
  const t = ctx.timeMs / 1000;
  const speed = ctx.speed ?? 1;
  const amp = amplitudeFor(actor);
  // Deterministic per-actor phase offset in [0, 2pi).
  const o = (((ctx.seed >>> 4) % 997) / 997) * TAU_;
  const phase = saturate(ctx.phase);

  // Reset every channel a state may write (absolute evaluation contract).
  rig.body.position.y = rig.bodyBaseY;
  rig.body.rotation.set(0, 0, 0);
  rig.armL.rotation.set(0, 0, 0);
  rig.armR.rotation.set(0, 0, 0);
  rig.eyes.position.x = 0;
  rig.root.scale.setScalar(rig.baseScale);
  // Expression resolution: authored override wins over the pose default.
  rig.setExpression(ctx.expression ?? DEFAULT_EXPRESSION[state]);

  switch (state) {
    case "idle": {
      // Breathing bob plus a slow seeded eye dart.
      const breath = Math.sin(TAU_ * t * 0.55 + o) * 0.03 * amp;
      rig.body.position.y = rig.bodyBaseY + breath;
      rig.armL.rotation.x = Math.sin(TAU_ * t * 0.55 + o + 0.9) * 0.05 * amp;
      rig.armR.rotation.x = Math.sin(TAU_ * t * 0.55 + o - 0.9) * 0.05 * amp;
      rig.eyes.position.x = 0.06 * amp * Math.sin(TAU_ * (t / 3.3) + o);
      break;
    }

    case "move": {
      // Walk cycle: double-frequency root bob (leg suggestion via slight
      // asymmetry), counter-swinging arms, forward lean into travel.
      const w = TAU_ * t * (2.6 * speed) + o;
      const bob = (0.05 + 0.05 * Math.sin(2 * w)) * amp;
      rig.body.position.y = rig.bodyBaseY + bob;
      rig.body.rotation.x = (0.07 + 0.05 * speed) * amp;
      rig.body.rotation.z = Math.sin(w) * 0.04 * amp;
      rig.armL.rotation.x = Math.sin(w) * 0.7 * amp;
      rig.armR.rotation.x = -Math.sin(w) * 0.7 * amp;
      rig.eyes.position.x = 0;
      break;
    }

    case "carry": {
      // Arms locked forward holding the payload; bob halved, no lean roll.
      const w = TAU_ * t * (1.9 * speed) + o;
      rig.body.position.y = rig.bodyBaseY + Math.abs(Math.sin(w)) * 0.035 * amp;
      rig.body.rotation.x = 0.06 * amp;
      rig.armL.rotation.x = -1.15 + Math.sin(w) * 0.05 * amp;
      rig.armR.rotation.x = -1.15 - Math.sin(w) * 0.05 * amp;
      break;
    }

    case "work": {
      // Facing a desk: forward lean, tapping right arm at desk cadence
      // (amplitude doubled for diorama-scale readability).
      const tap = Math.sin(TAU_ * t * 3.1 + o);
      rig.body.rotation.x = 0.14 * amp;
      rig.body.position.y = rig.bodyBaseY + Math.sin(TAU_ * t * 0.8 + o) * 0.015 * amp;
      rig.armR.rotation.x = -0.95 + tap * 0.56 * amp;
      rig.armL.rotation.x = -0.4 - tap * 0.16 * amp;
      break;
    }

    case "argue": {
      // Two-body lean (director offsets the counterpart's seed), alternating
      // arm jabs, and a yaw oscillation swing on top of the lean.
      const jab = Math.sin(TAU_ * t * 1.6 + o);
      rig.body.rotation.z = (0.07 + 0.05 * jab) * amp;
      rig.body.rotation.x = 0.05 * amp;
      rig.body.rotation.y = jab * 0.25 * amp;
      rig.armR.rotation.x = -0.7 - Math.max(0, jab) * 0.7 * amp;
      rig.armR.rotation.z = -0.25 * amp;
      rig.armL.rotation.x = -0.3 - Math.max(0, -jab) * 0.7 * amp;
      rig.armL.rotation.z = 0.7 * amp;
      rig.eyes.position.x = 0.05 * amp;
      break;
    }

    case "fight": {
      // Fast alternate swings; hull wobble comes from body roll since the
      // hat is merged into the hull.
      const w = TAU_ * t * 5.5 + o;
      rig.armL.rotation.x = Math.sin(w) * 0.95 * amp;
      rig.armR.rotation.x = -Math.sin(w) * 0.95 * amp;
      rig.armL.rotation.z = 0.3 * amp;
      rig.armR.rotation.z = -0.3 * amp;
      rig.body.rotation.z = Math.sin(w + 1.3) * 0.06 * amp;
      rig.body.position.y = rig.bodyBaseY + Math.abs(Math.sin(w)) * 0.03 * amp;
      break;
    }

    case "collide": {
      // Squash-and-stretch keyframe from command phase: x/z ~1.3, y ~0.7 at
      // the impact midpoint, recovered to 1 by phase end. Arms flail: raise
      // fast on impact, drop through the recovery window.
      const s = Math.sin(phase * Math.PI) * amp;
      const flail = Math.sin(saturate(phase / 0.6) * Math.PI);
      const k = rig.baseScale;
      rig.root.scale.set(k * (1 + 0.3 * s), k * (1 - 0.3 * s), k * (1 + 0.3 * s));
      rig.armL.rotation.z = (0.3 + 1.6 * flail) * amp;
      rig.armR.rotation.z = -(0.3 + 1.6 * flail) * amp;
      rig.armL.rotation.x = -0.5 * flail * amp;
      rig.armR.rotation.x = -0.5 * flail * amp;
      rig.body.position.y = rig.bodyBaseY - 0.12 * s;
      break;
    }

    case "celebrate": {
      // Parabolic jump arcs: body y peaks at ~0.6 once per cycle, landing
      // with a small squash, plus raised arms; conga-ready (yaw owned by
      // the director).
      const u = (((t * 2.2 + o / TAU_) % 1) + 1) % 1;
      const jump = 4 * u * (1 - u); // parabola, 0 at landing/liftoff, 1 at apex
      rig.body.position.y = rig.bodyBaseY + jump * 0.6 * amp;
      const land = u < 0.16 ? Math.sin((u / 0.16) * Math.PI) : 0;
      const k = rig.baseScale;
      rig.root.scale.set(k * (1 + 0.08 * land), k * (1 - 0.14 * land), k * (1 + 0.08 * land));
      rig.armL.rotation.z = 2.2 * amp;
      rig.armR.rotation.z = -2.2 * amp;
      rig.armL.rotation.x = Math.sin(TAU_ * u + o) * 0.15 * amp;
      rig.armR.rotation.x = -Math.sin(TAU_ * u + o) * 0.15 * amp;
      rig.eyes.position.x = 0.04 * amp;
      break;
    }

    case "react": {
      // Freeze with an exaggerated lean back away from facing plus a tiny
      // high-frequency tremble.
      rig.body.rotation.x = -0.35 * amp;
      rig.armL.rotation.z = 0.5 * amp;
      rig.armR.rotation.z = -0.5 * amp;
      rig.armL.rotation.x = -0.2 * amp;
      rig.armR.rotation.x = -0.2 * amp;
      rig.body.rotation.z = Math.sin(TAU_ * t * 18) * 0.012 * amp;
      break;
    }

    case "faint": {
      // Fall backward toward horizontal (~70 degrees) over the first ~45%
      // of the command, settle-hold at the end of the fall, then lie still
      // with a tiny leg-twitch (read through bob). Recovery is a director
      // state change; the absolute resets above clear the rotation.
      const fall = easeOutCubic(saturate(phase / 0.45));
      rig.body.rotation.x = lerp(0, -1.2, fall) * amp;
      rig.body.position.y = lerp(rig.bodyBaseY, 0.45, fall);
      const twitch = (1 - fall) * Math.sin(TAU_ * t * 7 + o) * 0.03 * amp;
      rig.body.rotation.z = twitch;
      rig.armL.rotation.z = 0.6 * fall * amp;
      rig.armR.rotation.z = -0.6 * fall * amp;
      break;
    }
  }
}

/** Face `yaw` along the shortest angular path. Allocates nothing. */
export function applyFacing(actor: FleetActor, yaw: number): void {
  const current = actor.rig.root.rotation.y;
  actor.rig.root.rotation.y = current + angleDelta(current, yaw);
}
