/**
 * Trading domain errors.
 *
 * @module TradingErrors
 */
import * as Schema from "effect/Schema";

import { TradingMissionBlockedReason, TradingMissionStatus } from "./Schemas.ts";

export class TradingMissionNotFoundError extends Schema.TaggedErrorClass<TradingMissionNotFoundError>()(
  "TradingMissionNotFoundError",
  {
    missionId: Schema.String,
  },
) {
  override get message(): string {
    return `No trading mission ${this.missionId}`;
  }
}

/** D4: only one active mission may hold a `{venue, market}` at a time. */
export class TradingMissionAlreadyActiveError extends Schema.TaggedErrorClass<TradingMissionAlreadyActiveError>()(
  "TradingMissionAlreadyActiveError",
  {
    userId: Schema.String,
    activeMissionId: Schema.String,
    activeStatus: TradingMissionStatus,
    /** The market the existing mission holds. */
    market: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return (
      `User ${this.userId} already has an active mission ${this.activeMissionId} ` +
      `(${this.activeStatus})${this.market === undefined ? "" : ` on ${this.market}`}`
    );
  }
}

/**
 * D4, the other direction: the market has MANUAL exposure — an open manual
 * position, a resting manual order, or a manual submission in flight — so a
 * mission may not take authority over it until the user is out.
 */
export class TradingMarketManualExposureError extends Schema.TaggedErrorClass<TradingMarketManualExposureError>()(
  "TradingMarketManualExposureError",
  {
    market: Schema.String,
    exposure: Schema.Literals(["open_position", "resting_order", "pending_execution"]),
  },
) {
  override get message(): string {
    return (
      `${this.market} has manual exposure (${this.exposure.replace("_", " ")}); ` +
      "close it or cancel it before a mission can take this market"
    );
  }
}

export class TradingMissionTransitionError extends Schema.TaggedErrorClass<TradingMissionTransitionError>()(
  "TradingMissionTransitionError",
  {
    missionId: Schema.String,
    from: TradingMissionStatus,
    to: TradingMissionStatus,
    reason: Schema.Literals([
      "illegal_transition",
      "blocked_reason_required",
      "blocked_reason_not_allowed",
    ]),
    blockedReason: Schema.optional(TradingMissionBlockedReason),
  },
) {
  override get message(): string {
    return `Cannot move mission ${this.missionId} from ${this.from} to ${this.to}: ${this.reason}`;
  }
}

/**
 * The harness binding is immutable for an active POC mission (§10.2).
 *
 * Only the binding's identity — provider, providerInstanceId, threadId — is
 * frozen. Session id, resume cursor, and availability are runtime bookkeeping
 * that ProviderService updates as the session starts, resumes, and drops.
 */
export class TradingHarnessBindingImmutableError extends Schema.TaggedErrorClass<TradingHarnessBindingImmutableError>()(
  "TradingHarnessBindingImmutableError",
  {
    missionId: Schema.String,
    status: TradingMissionStatus,
    changedFields: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Mission ${this.missionId} is ${this.status}; its harness binding cannot change (${this.changedFields.join(", ")})`;
  }
}

/** A stale optimistic version was supplied for a mission row. */
export class TradingMissionVersionConflictError extends Schema.TaggedErrorClass<TradingMissionVersionConflictError>()(
  "TradingMissionVersionConflictError",
  {
    missionId: Schema.String,
    expectedVersion: Schema.Number,
    currentVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `Mission ${this.missionId} is at version ${this.currentVersion}, not ${this.expectedVersion}`;
  }
}
