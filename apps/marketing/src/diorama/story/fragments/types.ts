/**
 * Story fragments — the R5 authoring unit (plan Direct Answer 4).
 *
 * A fragment is an IMMUTABLE, PURE-DATA declaration of one worker's slice of
 * the story. Fragment files must never mutate module-level state, register
 * sinks, or import each other; the story kernel (story/beats.ts) alone merges
 * fragments, expands zone loops, builds tracks, and validates the result via
 * `compileFragments()`.
 *
 * Two kinds of fragment:
 *
 * 1. ZONE LOOP (`zone` + `cycleMs` set). Ambient shop life that repeats.
 *    `commands` use RELATIVE times in [0, cycleMs). The compiler expands
 *    them across the 90000 ms loop at `phaseMs`: instance k of a window
 *    starting at relative r fires at absolute `phaseMs + k*cycleMs + r`.
 *    Cycle lengths must divide 90000 cleanly (9000, 10000, 15000, 18000...).
 *    A duration-bearing window that would straddle the 90000 ms seam (or
 *    whose relative window exceeds cycleMs) is DROPPED with a warning —
 *    retime the window or shift the phase; the compiler never splits windows.
 *
 * 2. CENTRAL / GLOBAL (`zone` and `cycleMs` unset). Plot-level action with
 *    ABSOLUTE times in [0, 90000).
 *
 * Actor booking: actors listed in `reservedActors` belong to this fragment.
 * A reserved actor may be used by a central fragment ONLY inside the owning
 * zone's declared `interruptionWindows` for that actor. Reserved actors must
 * not be reserved by two fragments. Fragments that use an actor without
 * reserving it (shared extras) are fine — the compiler's per-actor channel
 * overlap rules still apply after expansion.
 *
 * Cue identity: parallel fragments may fire cues at the same millisecond.
 * Uniqueness is enforced per subject (the actor or prop track the fireCue
 * command lands on), not globally.
 */

import type { ZoneId } from "../../config";
import type { ActorCommand, ActorId, PropCommand, PropId } from "../../types";

/** A central-plot borrowing permit for one zone-reserved actor. */
export interface InterruptionWindow {
  readonly actorId: ActorId;
  /** Absolute [fromMs, toMs) inside the 90000 ms loop. */
  readonly fromMs: number;
  readonly toMs: number;
}

/** One actor command plus the actor it belongs to (the Beat wrapper shape). */
export interface FragmentActorCommand {
  readonly actorId: ActorId;
  readonly command: ActorCommand;
}

/**
 * One prop command. `ownerActorId` is REQUIRED for attachProp entries — it
 * replaces the old global ownership ledger and keeps fragments pure data.
 */
export interface FragmentPropCommand {
  readonly propId: PropId;
  readonly ownerActorId?: ActorId;
  readonly command: PropCommand;
}

export interface Fragment {
  /** Unique across all fragments. */
  readonly id: string;
  /** Zone id; presence makes this a zone loop. One fragment per zone. */
  readonly zone?: ZoneId;
  /** Actors this fragment owns; not bookable by other fragments' reserved sets. */
  readonly reservedActors: readonly ActorId[];
  /** Zone loops only: cycle length in ms; must divide 90000 with no remainder. */
  readonly cycleMs?: number;
  /** Zone loops only: phase offset in [0, cycleMs). Default 0. */
  readonly phaseMs?: number;
  /** Windows during which the central plot may borrow reserved actors. */
  readonly interruptionWindows?: readonly InterruptionWindow[];
  /** Actor commands (relative times for zone loops, absolute for central). */
  readonly actors: readonly FragmentActorCommand[];
  /** Prop commands (same time convention as `actors`). */
  readonly props: readonly FragmentPropCommand[];
  /**
   * Zone-loop cycle variants (gags that fire on specific cycle instances).
   * A variant applies to cycle instance k when k >= applyCycle and
   * (k - applyCycle) % everyNthCycle === 0. On an applicable cycle the
   * compiler DROPS the base windows matched by `replaces` (relative startMs
   * inside the span AND command kind listed — "*" matches every kind) and
   * splices the variant's commands at phaseMs + k*cycleMs + relative,
   * under the same bounds/seam rules as base windows.
   */
  readonly variants?: readonly FragmentVariant[];
}

/** Base windows a variant replaces, matched on the actor's RELATIVE time. */
export interface VariantReplace {
  readonly actorId: string;
  /** Relative span [fromMs, toMs) of base command START times. */
  readonly fromMs: number;
  readonly toMs: number;
  /** Command kinds dropped in the span; "*" drops every kind. */
  readonly channels: readonly string[];
}

/** A cycle-varying gag spliced into a zone loop on specific instances. */
export interface FragmentVariant {
  /** Unique within the fragment. */
  readonly id: string;
  /** Applies every N cycles (>= 1). */
  readonly everyNthCycle: number;
  /** First applicable cycle instance, 0-based (e.g. "every 3rd from cycle
   *  3" is everyNthCycle 3 + applyCycle 3, firing at 3, 6, 9...). */
  readonly applyCycle: number;
  /** Base windows this variant replaces; each entry must match >= 1 base
   * window (validated — a stale replacement reference is an error). */
  readonly replaces: readonly VariantReplace[];
  /** Gag commands, RELATIVE times in [0, cycleMs). */
  readonly actors: readonly FragmentActorCommand[];
}
