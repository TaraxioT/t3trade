import { describe, expect, it } from "vite-plus/test";

import { deriveArchiveWriterStatus, WRITER_STALE_AFTER_MS } from "./ArchiveSupervisor.ts";

const NOW = 1_800_000_000_000;
const FRESH = NOW - 30_000;
const QUIET = NOW - 5 * 60_000;

const noLease = { unreadableLock: false as const, external: null };
const held = (heartbeatAt: number, pidAlive: boolean | null) => ({
  unreadableLock: false as const,
  external: { heartbeatAt, pidAlive },
});
const unreadable = { unreadableLock: true as const };

describe("deriveArchiveWriterStatus", () => {
  it("a running archiver with a fresh heartbeat is the owned writer", () => {
    expect(
      deriveArchiveWriterStatus({
        running: true,
        lastHeartbeatAt: FRESH,
        stoppedReason: null,
        now: NOW,
        lease: noLease,
      }),
    ).toBe("owned-writer");
  });

  it("a running archiver that has never heartbeat is still starting, not stale", () => {
    expect(
      deriveArchiveWriterStatus({
        running: true,
        lastHeartbeatAt: null,
        stoppedReason: null,
        now: NOW,
        lease: noLease,
      }),
    ).toBe("owned-writer");
  });

  it("a running archiver with a quiet heartbeat is stale, no matter what else is true", () => {
    expect(
      deriveArchiveWriterStatus({
        running: true,
        lastHeartbeatAt: QUIET,
        stoppedReason: null,
        now: NOW,
        lease: noLease,
      }),
    ).toBe("stale");
  });

  it("classifies the heartbeat boundary exactly: quiet at the threshold, owned one tick before", () => {
    const atThreshold = NOW - WRITER_STALE_AFTER_MS;
    expect(
      deriveArchiveWriterStatus({
        running: true,
        lastHeartbeatAt: atThreshold,
        stoppedReason: null,
        now: NOW,
        lease: noLease,
      }),
    ).toBe("stale");
    expect(
      deriveArchiveWriterStatus({
        running: true,
        // One tick fresher than the threshold: still owned.
        lastHeartbeatAt: atThreshold + 1,
        stoppedReason: null,
        now: NOW,
        lease: noLease,
      }),
    ).toBe("owned-writer");
  });

  it("between runs with a restart pending is restarting", () => {
    expect(
      deriveArchiveWriterStatus({
        running: false,
        lastHeartbeatAt: FRESH,
        stoppedReason: "restarting",
        now: NOW,
        lease: noLease,
      }),
    ).toBe("restarting");
  });

  it("a fresh external holder on a live local pid is a healthy external writer", () => {
    expect(
      deriveArchiveWriterStatus({
        running: false,
        lastHeartbeatAt: null,
        stoppedReason: "pid 4242 on host is writing the archive",
        now: NOW,
        lease: held(FRESH, true),
      }),
    ).toBe("healthy-external-writer");
  });

  it("a fresh external holder on a foreign host is healthy: not probeable, never guessed", () => {
    expect(
      deriveArchiveWriterStatus({
        running: false,
        lastHeartbeatAt: null,
        stoppedReason: "pid 4242 on other-host is writing the archive",
        now: NOW,
        lease: held(FRESH, null),
      }),
    ).toBe("healthy-external-writer");
  });

  it("a fresh lease naming a provably dead local pid is stale in fact", () => {
    expect(
      deriveArchiveWriterStatus({
        running: false,
        lastHeartbeatAt: null,
        stoppedReason: "pid 4242 on host is writing the archive",
        now: NOW,
        lease: held(FRESH, false),
      }),
    ).toBe("stale");
  });

  it("an external holder whose lease heartbeat went quiet is stale however alive the pid", () => {
    expect(
      deriveArchiveWriterStatus({
        running: false,
        lastHeartbeatAt: null,
        stoppedReason: "pid 4242 on host is writing the archive",
        now: NOW,
        lease: held(QUIET, true),
      }),
    ).toBe("stale");
  });

  it("an unparseable writer lock is unavailable: ownership cannot be verified, not stopped", () => {
    expect(
      deriveArchiveWriterStatus({
        running: false,
        lastHeartbeatAt: null,
        stoppedReason: null,
        now: NOW,
        lease: unreadable,
      }),
    ).toBe("unavailable");
  });

  it("no writer and no lease at all is stopped, whatever the prose reason", () => {
    for (const stoppedReason of ["not started", "the archiver entry file was not found", null]) {
      expect(
        deriveArchiveWriterStatus({
          running: false,
          lastHeartbeatAt: null,
          stoppedReason,
          now: NOW,
          lease: noLease,
        }),
      ).toBe("stopped");
    }
  });
});
