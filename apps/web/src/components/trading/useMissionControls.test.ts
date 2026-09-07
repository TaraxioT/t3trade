/**
 * The failure derivation behind the §14.7 controls.
 *
 * The hook itself needs a renderer the web suite does not have, so the part
 * worth pinning is extracted: what an operator is told when a pause, a close,
 * or a revoke does not happen. `void send()` used to swallow every one of
 * these, which made a refused control indistinguishable from a slow one.
 */
import type { OrchestrationTradingMission } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  CONTROL_RESULT_TIMEOUT_MILLIS,
  describeControlFailure,
  resolveControlOutcome,
} from "./useMissionControls";

describe("describeControlFailure", () => {
  it("says nothing about a command that succeeded", () => {
    expect(describeControlFailure(AsyncResult.success(undefined))).toBeNull();
  });

  it("reports the reason the domain refused the control", () => {
    const result = AsyncResult.failure(
      Cause.fail(new Error("mission is revoked; the control is not legal from a terminal")),
    );
    expect(describeControlFailure(result)).toBe(
      "mission is revoked; the control is not legal from a terminal",
    );
  });

  it("reports a non-Error failure rather than dropping it", () => {
    expect(describeControlFailure(AsyncResult.failure(Cause.fail("close_position rejected")))).toBe(
      "close_position rejected",
    );
  });

  it("never returns an empty string, which would read as no error at all", () => {
    expect(describeControlFailure(AsyncResult.failure(Cause.fail(new Error("   "))))).toBe(
      "The command failed.",
    );
  });

  // An unmount or a navigation interrupts the command. Showing "the close
  // failed" for a panel the operator just closed would be a false alarm on the
  // one control that must stay trustworthy.
  it("treats an interrupt as no failure", () => {
    expect(describeControlFailure(AsyncResult.failure(Cause.interrupt()))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RC06 — the correlated outcome derivation. A dispatched command proves the
// request landed; only the mission's durable control result proves what the
// control did, and only for the press it answers.
// ---------------------------------------------------------------------------

describe("resolveControlOutcome", () => {
  const result = (over: {
    readonly control?: string;
    readonly status?: "completed" | "failed" | "unknown";
    readonly summary?: string;
    readonly occurredAt?: string;
  }): OrchestrationTradingMission["lastControlResult"] =>
    ({
      control: over.control ?? "close_and_revoke",
      status: over.status ?? "completed",
      summary: over.summary ?? "All 1 held market(s) confirmed flat. Authority revoked.",
      markets: [],
      requestEventSequence: 42,
      occurredAt: over.occurredAt ?? new Date("2026-09-06T12:00:02.000Z").toISOString(),
    }) as OrchestrationTradingMission["lastControlResult"];

  const PRESS_AT = Date.parse("2026-09-06T12:00:00.000Z");

  it("shows nothing before any press or result", () => {
    expect(
      resolveControlOutcome({ pending: null, lastControlResult: null, nowMillis: PRESS_AT }),
    ).toEqual({ state: "idle" });
  });

  it("keeps a press pending until its durable result lands", () => {
    const view = resolveControlOutcome({
      pending: { control: "close_and_revoke", dispatchedAt: PRESS_AT },
      lastControlResult: null,
      nowMillis: PRESS_AT + 2_000,
    });
    expect(view.state).toBe("pending");
  });

  it("matches a result to the press it answers", () => {
    const view = resolveControlOutcome({
      pending: { control: "close_and_revoke", dispatchedAt: PRESS_AT },
      lastControlResult: result({}),
      nowMillis: PRESS_AT + 2_000,
    });
    expect(view).toEqual({
      state: "result",
      control: "close_and_revoke",
      status: "completed",
      summary: "All 1 held market(s) confirmed flat. Authority revoked.",
    });
  });

  it("ignores a result older than the press, and one for a different control", () => {
    const stale = resolveControlOutcome({
      pending: { control: "close_and_revoke", dispatchedAt: PRESS_AT },
      lastControlResult: result({ occurredAt: new Date(PRESS_AT - 60_000).toISOString() }),
      nowMillis: PRESS_AT + 2_000,
    });
    expect(stale.state).toBe("pending");

    const otherControl = resolveControlOutcome({
      pending: { control: "cancel_entries", dispatchedAt: PRESS_AT },
      lastControlResult: result({}),
      nowMillis: PRESS_AT + 2_000,
    });
    expect(otherControl.state).toBe("pending");
  });

  it("ends an unanswered press as interrupted after the timeout, never silently", () => {
    const view = resolveControlOutcome({
      pending: { control: "close_and_revoke", dispatchedAt: PRESS_AT },
      lastControlResult: null,
      nowMillis: PRESS_AT + CONTROL_RESULT_TIMEOUT_MILLIS + 1,
    });
    expect(view).toEqual({ state: "interrupted", control: "close_and_revoke" });
  });

  it("shows the mission's latest durable result even with no press in flight", () => {
    const view = resolveControlOutcome({
      pending: null,
      lastControlResult: result({ status: "unknown", summary: "outcome unknown after submit" }),
      nowMillis: PRESS_AT,
    });
    expect(view).toEqual({
      state: "result",
      control: "close_and_revoke",
      status: "unknown",
      summary: "outcome unknown after submit",
    });
  });
});
