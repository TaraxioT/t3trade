/**
 * Reading per-order statuses out of an `/exchange` response (§17.2 step 4).
 *
 * The payloads below are the shapes the exchange actually sends. The nesting
 * under `response.data.statuses` is the load-bearing one: reading only the
 * shallow path returns an empty list for every real order response, and an
 * empty list is indistinguishable from "nothing was accepted".
 */
import { describe, expect, it } from "@effect/vitest";

import {
  exchangeResponseType,
  isLiveOnExchange,
  readCancelAcknowledgement,
  readExchangeResponse,
} from "./ExchangeResponse.ts";

const orderResponse = (statuses: ReadonlyArray<unknown>) => ({
  status: "ok",
  response: { type: "order", data: { statuses } },
});

describe("readExchangeResponse", () => {
  it("reads statuses nested under response.data", () => {
    const outcome = readExchangeResponse(
      orderResponse([{ filled: { totalSz: "0.01", avgPx: "3000.5", oid: 77, cloid: "0xabc" } }]),
    );

    expect(outcome.actionError).toBeUndefined();
    expect(outcome.statuses).toHaveLength(1);
    expect(outcome.statuses[0]).toMatchObject({
      outcome: "filled",
      orderId: 77,
      cloid: "0xabc",
      filledSize: 0.01,
      averagePrice: 3_000.5,
    });
  });

  it("still reads a flattened response.statuses", () => {
    const outcome = readExchangeResponse({
      status: "ok",
      response: { type: "order", statuses: [{ resting: { oid: 12 } }] },
    });
    expect(outcome.statuses[0]?.outcome).toBe("resting");
    expect(outcome.statuses[0]?.orderId).toBe(12);
  });

  it("reads every row of a grouped submission, not just the first", () => {
    // §17.1: never treat a batch as atomic. A 200 with a live parent and a
    // rejected child is the case this exists to catch.
    const outcome = readExchangeResponse(
      orderResponse([
        { filled: { totalSz: "0.01", avgPx: "3000.0", oid: 1 } },
        { error: "Order has invalid size" },
      ]),
    );

    expect(outcome.statuses).toHaveLength(2);
    expect(outcome.statuses[0]?.outcome).toBe("filled");
    expect(outcome.statuses[1]?.outcome).toBe("error");
    expect(outcome.statuses[1]?.reason).toContain("invalid size");
  });

  it("reads a parent-linked child that is only waiting for its trigger", () => {
    // Present in the response, NOT live protection (§17.1).
    const outcome = readExchangeResponse(
      orderResponse([{ resting: { oid: 1 } }, "waitingForTrigger"]),
    );

    expect(outcome.statuses[1]?.outcome).toBe("waiting_for_trigger");
    expect(isLiveOnExchange(outcome.statuses[1]!)).toBe(false);
  });

  it("reads waitingForFill and success rows", () => {
    const outcome = readExchangeResponse(orderResponse(["waitingForFill", "success"]));
    expect(outcome.statuses.map((s) => s.outcome)).toEqual(["waiting_for_fill", "success"]);
  });

  it("surfaces an action-level rejection carried as a bare string", () => {
    // Insufficient margin arrives this way: no per-order rows at all.
    const outcome = readExchangeResponse({
      status: "err",
      response: "Insufficient margin to place order.",
    });

    expect(outcome.actionError).toBe("Insufficient margin to place order.");
    expect(outcome.statuses).toEqual([]);
  });

  it("reports an order response with no statuses as an action error", () => {
    // "No rows" must never read as "accepted".
    const outcome = readExchangeResponse({ status: "ok", response: { type: "order" } });
    expect(outcome.actionError).toContain("no per-order statuses");
  });

  it("accepts a noop, which legitimately carries no statuses", () => {
    const outcome = readExchangeResponse({ status: "ok", response: { type: "default" } });
    expect(outcome.actionError).toBeUndefined();
    expect(outcome.statuses).toEqual([]);
  });

  it("reports an unrecognised row as an error rather than skipping it", () => {
    const outcome = readExchangeResponse(orderResponse([{ somethingNew: { oid: 1 } }]));
    expect(outcome.statuses[0]?.outcome).toBe("error");
    expect(outcome.statuses[0]?.reason).toContain("unrecognised order status");
  });

  it("reports a non-object response rather than throwing", () => {
    expect(readExchangeResponse(null).actionError).toContain("not an object");
    expect(readExchangeResponse({ status: "ok" }).actionError).toContain("no `response`");
  });
});

describe("isLiveOnExchange", () => {
  it("counts filled and resting as live, and nothing else", () => {
    const outcome = readExchangeResponse(
      orderResponse([
        { filled: { totalSz: "0.01", avgPx: "3000.0", oid: 1 } },
        { resting: { oid: 2 } },
        "waitingForTrigger",
        { error: "nope" },
      ]),
    );
    expect(outcome.statuses.map(isLiveOnExchange)).toEqual([true, true, false, false]);
  });
});

describe("exchangeResponseType", () => {
  it("echoes the response variant", () => {
    expect(exchangeResponseType(orderResponse([]))).toBe("order");
    expect(exchangeResponseType({ status: "ok", response: { type: "default" } })).toBe("default");
    expect(exchangeResponseType({ status: "err", response: "nope" })).toBeUndefined();
  });
});

describe("readCancelAcknowledgement", () => {
  const cloid = "0x" + "a".repeat(32);
  const cancelResponse = (statuses: ReadonlyArray<unknown>) => ({
    status: "ok",
    response: { type: "cancel", data: { statuses } },
  });

  it("acknowledges an explicit per-order success", () => {
    const ack = readCancelAcknowledgement(cancelResponse(["success"]), cloid);
    expect(ack.acknowledged).toBe(true);
    expect(ack.reason).toBeUndefined();
  });

  it("rejects an action-level rejection carried over a successful transport", () => {
    const ack = readCancelAcknowledgement(
      { status: "err", response: "Order does not exist" },
      cloid,
    );
    expect(ack.acknowledged).toBe(false);
    expect(ack.reason).toBe("Order does not exist");
  });

  it("rejects a per-order error row with the exchange's own words", () => {
    const ack = readCancelAcknowledgement(
      cancelResponse([{ error: "Invalid order id or client order id" }]),
      cloid,
    );
    expect(ack.acknowledged).toBe(false);
    expect(ack.reason).toContain("Invalid order id or client order id");
  });

  it("rejects a malformed envelope rather than inventing success", () => {
    expect(readCancelAcknowledgement(null, cloid).reason).toContain("not an object");
    expect(readCancelAcknowledgement({ status: "ok" }, cloid).reason).toContain("no `response`");
  });

  it("rejects a cancel envelope with no per-order statuses", () => {
    // The permissive reader tolerates this for its own purposes; one submitted
    // cloid must have one explicit acknowledgement.
    const ack = readCancelAcknowledgement(
      { status: "ok", response: { type: "cancel", data: {} } },
      cloid,
    );
    expect(ack.acknowledged).toBe(false);
    expect(ack.reason).toContain("no per-order statuses");
  });

  it("rejects an unexpected success-shaped ORDER response", () => {
    const ack = readCancelAcknowledgement(
      {
        status: "ok",
        response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.5", oid: 9 } }] } },
      },
      cloid,
    );
    expect(ack.acknowledged).toBe(false);
    expect(ack.reason).toContain("expected a cancel response");
  });

  it("rejects a wrong-cardinality response for the single submitted cloid", () => {
    const ack = readCancelAcknowledgement(cancelResponse(["success", "success"]), cloid);
    expect(ack.acknowledged).toBe(false);
    expect(ack.reason).toContain("exactly one cancellation status");
  });

  it("never reads an order-status word as a cancellation success", () => {
    // Bare waiting strings are recognisable order words: they describe the
    // order's state, not the cancellation's.
    for (const row of ["waitingForFill", "waitingForTrigger"]) {
      const ack = readCancelAcknowledgement(cancelResponse([row]), cloid);
      expect(ack.acknowledged).toBe(false);
      expect(ack.reason).toContain("not as cancelled");
    }
    const filled = readCancelAcknowledgement(
      cancelResponse([{ filled: { totalSz: "0.5", avgPx: "3000", oid: 5 } }]),
      cloid,
    );
    expect(filled.acknowledged).toBe(false);
    expect(filled.reason).toContain("not as cancelled");
    const resting = readCancelAcknowledgement(cancelResponse([{ resting: { oid: 6 } }]), cloid);
    expect(resting.acknowledged).toBe(false);
    expect(resting.reason).toContain("not as cancelled");
    // An unrecognised bare string (e.g. a free-text rejection) is not a
    // success either — it surfaces verbatim.
    const unknown = readCancelAcknowledgement(cancelResponse(["someNewState"]), cloid);
    expect(unknown.acknowledged).toBe(false);
    expect(unknown.reason).toBe("someNewState");
  });
});
