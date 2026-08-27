import { describe, expect, it } from "vite-plus/test";

import { deriveCloid, deriveManualCloid } from "./Cloid.ts";

describe("deriveCloid", () => {
  it("is deterministic for identical inputs", () => {
    const input = {
      missionId: "mission_1",
      executionSequence: 0,
      actionType: "open",
    };
    expect(deriveCloid(input)).toBe(deriveCloid(input));
  });

  it("returns a 0x-prefixed 34-char lowercase hex string (the Hyperliquid wire shape)", () => {
    const cloid = deriveCloid({
      missionId: "mission_1",
      executionSequence: 0,
      actionType: "open",
    });
    // 0x + 32 hex chars (16 bytes / 128 bits). The exchange validates this
    // shape; a bare 32-char hex is silently dropped (Task 4 finding).
    expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
    expect(cloid.length).toBe(34);
  });

  it("changes when any input changes", () => {
    const base = {
      missionId: "mission_1",
      executionSequence: 0,
      actionType: "open",
    };
    const original = deriveCloid(base);
    expect(deriveCloid({ ...base, missionId: "mission_2" })).not.toBe(original);
    expect(deriveCloid({ ...base, executionSequence: 1 })).not.toBe(original);
    expect(deriveCloid({ ...base, actionType: "scale_in" })).not.toBe(original);
  });

  it("respects field boundaries (no suffix/prefix confusion)", () => {
    // missionId "ab" + sequence 12 must not collide with "a" + "b" + 12:
    // the field separator distinguishes them.
    const a = deriveCloid({
      missionId: "ab",
      executionSequence: 12,
      actionType: "open",
    });
    const b = deriveCloid({
      missionId: "a",
      executionSequence: 12,
      actionType: "open",
    });
    expect(a).not.toBe(b);
  });

  describe("deriveManualCloid", () => {
    it("has the wire shape and is deterministic", () => {
      const input = { accountId: "acct_1", executionSequence: 0, actionType: "open" };
      const cloid = deriveManualCloid(input);
      expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
      expect(cloid).toBe(deriveManualCloid(input));
      expect(cloid).toBe("0xba5cfb64c739925a1316a0bfd36aab96");
    });

    it("occupies its own namespace: never equal to any mission derivation", () => {
      // The obvious near-collisions: a mission literally named "manual", and a
      // mission named with the manual byte stream's own prefix.
      const manual = deriveManualCloid({
        accountId: "acct_1",
        executionSequence: 0,
        actionType: "open",
      });
      expect(manual).not.toBe(
        deriveCloid({ missionId: "manual", executionSequence: 0, actionType: "open" }),
      );
      expect(manual).not.toBe(
        deriveCloid({ missionId: "acct_1", executionSequence: 0, actionType: "open" }),
      );
      // The one input that CAN collide is a mission id carrying the raw 0x1f
      // field separator ("manual\x1facct_1") — out of domain: mission ids are
      // UUID-derived and never contain control bytes. The printable neighbour
      // must still differ.
      expect(manual).not.toBe(
        deriveCloid({ missionId: "manualacct_1", executionSequence: 0, actionType: "open" }),
      );
    });

    it("changes when any input changes", () => {
      const base = { accountId: "acct_1", executionSequence: 0, actionType: "open" };
      const original = deriveManualCloid(base);
      expect(deriveManualCloid({ ...base, accountId: "acct_2" })).not.toBe(original);
      expect(deriveManualCloid({ ...base, executionSequence: 1 })).not.toBe(original);
      expect(deriveManualCloid({ ...base, actionType: "close" })).not.toBe(original);
    });
  });

  it("is byte-stable: the pinned mission vector never moves", () => {
    // Phase 7 introduced the manual namespace beside this derivation. Every
    // persisted execution record, fill join, and resting order on the exchange
    // is keyed by cloids from THIS hash — if this pin ever fails, reconciliation
    // of historical orders silently breaks.
    expect(deriveCloid({ missionId: "mission_1", executionSequence: 0, actionType: "open" })).toBe(
      "0x112f1bd8e6168f14596649c3fd34717c",
    );
  });

  it("does not collide across a large batch of distinct inputs", () => {
    const seen = new Set<string>();
    for (let seq = 0; seq < 5_000; seq++) {
      for (const action of ["open", "scale_in", "reduce", "close", "cancel"]) {
        const cloid = deriveCloid({
          missionId: "mission_1",
          executionSequence: seq,
          actionType: action,
        });
        expect(seen.has(cloid)).toBe(false);
        seen.add(cloid);
      }
    }
  });
});
