import { describe, expect, it } from "vite-plus/test";

import type { TradingAccountPosition, TradingAlertEvent } from "@t3tools/contracts";

import {
  alertNotificationText,
  describeArchiveHealth,
  describeProtection,
  describeSignerState,
  RESEARCH_MODE_LINE,
  selectNewAlerts,
} from "./tradeHomePresentation";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");

const runningArchive = {
  status: "owned-writer" as const,
  externalWriter: null,
  running: true,
  lastHeartbeat: "heartbeat",
  lastHeartbeatAt: new Date(NOW - 5_000).toISOString(),
  restarts: 0,
  stoppedReason: null,
};

describe("describeArchiveHealth", () => {
  it("is silent for an owned writer with a fresh heartbeat", () => {
    expect(describeArchiveHealth(runningArchive, NOW)).toBeNull();
  });

  it("is silent when the server does not report health at all", () => {
    expect(describeArchiveHealth(undefined, NOW)).toBeNull();
  });

  it("is silent when the server reports no status (an older server)", () => {
    const { status: _status, ...withoutStatus } = runningArchive;
    expect(describeArchiveHealth(withoutStatus, NOW)).toBeNull();
  });

  it("says a healthy external writer records the archive, never that recording stopped", () => {
    const message = describeArchiveHealth(
      {
        ...runningArchive,
        status: "healthy-external-writer",
        running: false,
        externalWriter: { pid: 4242, host: "mac-studio" },
        stoppedReason: "pid 4242 on mac-studio is writing the archive",
      },
      NOW,
    );
    expect(message).toContain("Recorded by another T3 Trade process");
    expect(message).toContain("4242");
    expect(message).toContain("isolated state");
    expect(message).not.toContain("stopped");
  });

  it("names the stop reason when stopped", () => {
    const message = describeArchiveHealth(
      { ...runningArchive, status: "stopped", running: false, stoppedReason: "spawn failed" },
      NOW,
    );
    expect(message).toContain("stopped");
    expect(message).toContain("spawn failed");
  });

  it("says ownership cannot be verified rather than guessing a cause", () => {
    const message = describeArchiveHealth(
      { ...runningArchive, status: "unavailable", running: false, stoppedReason: null },
      NOW,
    );
    expect(message).toContain("cannot be verified");
    expect(message).toContain("refusing");
  });

  it("reports a quiet heartbeat when the writer is stale", () => {
    const message = describeArchiveHealth(
      {
        ...runningArchive,
        status: "stale",
        lastHeartbeatAt: new Date(NOW - 5 * 60_000).toISOString(),
      },
      NOW,
    );
    expect(message).toContain("has not had a heartbeat");
    expect(message).toContain("5 min");
  });

  it("counts restarts while the supervisor is between runs", () => {
    expect(
      describeArchiveHealth(
        { ...runningArchive, status: "restarting", running: false, restarts: 3 },
        NOW,
      ),
    ).toContain("restart 3");
  });
});

describe("describeProtection", () => {
  const base: TradingAccountPosition = {
    market: { venue: "hyperliquid", asset: "ETH" },
    size: 0.5,
    unrealisedPnl: 1.2,
    marginUsed: 40,
    protectedSize: 0.5,
    protection: "resting_on_exchange",
    authority: { kind: "manual" },
    observedAt: new Date(NOW).toISOString(),
  };

  it("labels the two provenances and the unprotected state", () => {
    expect(describeProtection(base)).toBe("Stop on exchange");
    expect(describeProtection({ ...base, protection: "server_executed" })).toBe("Server-executed");
    expect(describeProtection({ ...base, protectedSize: 0 })).toBe("Unprotected");
    expect(describeProtection({ ...base, protection: null })).toBe("Unprotected");
  });
});

const alert = (id: string): TradingAlertEvent => ({
  id,
  market: { venue: "hyperliquid", asset: "ETH" },
  accountId: null,
  watchId: "watch-1",
  firedAt: new Date(NOW).toISOString(),
  summary: `ETH crossed above 4200 (${id})`,
});

describe("selectNewAlerts", () => {
  it("reports nothing on the first read", () => {
    expect(selectNewAlerts([alert("a")], null)).toEqual([]);
  });

  it("reports only unseen alerts, oldest first", () => {
    const next = selectNewAlerts([alert("c"), alert("b"), alert("a")], new Set(["a"]));
    expect(next.map((entry) => entry.id)).toEqual(["b", "c"]);
  });

  it("reports nothing when the read matches the previous one", () => {
    expect(selectNewAlerts([alert("a")], new Set(["a"]))).toEqual([]);
  });
});

describe("alertNotificationText", () => {
  it("titles by asset and bodies with the summary", () => {
    const text = alertNotificationText(alert("a"));
    expect(text.title).toBe("ETH alert");
    expect(text.body).toContain("crossed above");
  });
});

describe("describeSignerState", () => {
  it("says nothing when a signer is armed", () => {
    expect(describeSignerState(true)).toBeNull();
  });

  // Absent, not false: every server that predates the field had a signer.
  it("says nothing when the server does not report the field", () => {
    expect(describeSignerState(undefined)).toBeNull();
  });

  it("names research mode, and what still works in it", () => {
    const message = describeSignerState(false);
    expect(message).toBe(RESEARCH_MODE_LINE);
    expect(message).toContain("backtests and validations work");
    expect(message).toContain("orders will be refused");
  });
});
