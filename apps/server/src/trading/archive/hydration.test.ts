// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off - the transport is sync fs by design; the waits are wall-clock by design.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Effect } from "effect";

import {
  CANDLE_WINDOW_BARS,
  HYDRATION_MAX_BARS,
  HYDRATION_MAX_PENDING,
  HYDRATION_MAX_WAIT_MS,
  HYDRATION_QUEUE_LOCK_STALE_MS,
  HYDRATION_WRITER_SLICE_MS,
  INTERVAL_MS,
} from "./config.ts";
import {
  assessWindowCoverage,
  classifyHydrationOutcome,
  claimHydrationBatch,
  enqueueHydrationRequest,
  gridBarCount,
  HYDRATION_MAX_RESULTS,
  loadHydrationQueue,
  readHydrationQueueFile,
  makeHydrationFileWatcher,
  parseHydrationQueue,
  planHydrationFetches,
  providerReachFloor,
  recordHydrationResult,
  renderHydrationQueue,
  storeHydrationQueue,
  waitForHydrationResult,
  withHydrationQueueLock,
  type HydrationQueue,
  type HydrationRequest,
  type WindowCoverageAssessment,
} from "./hydration.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;
const MINUTE = 60_000;

const request = (overrides?: Partial<HydrationRequest>): HydrationRequest => ({
  id: "req-1",
  venue: "hyperliquid",
  coin: "ETH",
  interval: "1d",
  fromT: NOW - 90 * DAY,
  toT: NOW - 60 * DAY,
  purpose: "study",
  requestedAt: NOW,
  deadlineAt: NOW + HYDRATION_MAX_WAIT_MS,
  ...overrides,
});

const emptyQueue: HydrationQueue = { requests: [], results: [] };

const withTempQueuePath = <A>(use: (path: string) => A): A => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hydration."));
  try {
    return use(NodePath.join(dir, "queue.json"));
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

describe("providerReachFloor", () => {
  it("is one window of CANDLE_WINDOW_BARS behind now, per interval", () => {
    expect(providerReachFloor("1d", NOW)).toBe(NOW - (CANDLE_WINDOW_BARS - 1) * INTERVAL_MS["1d"]);
    expect(providerReachFloor("2h", NOW)).toBeNull();
  });
});

describe("gridBarCount", () => {
  it("counts grid-aligned opens, so a window exactly one reach wide passes the cap", () => {
    // The raw millisecond span of [floor, now] rounds up past 5000 days, but
    // the honest unit is bars: the reach window holds at most 5000 of them.
    const floor = providerReachFloor("1d", NOW) as number;
    expect(gridBarCount(floor, NOW, INTERVAL_MS["1d"])).toBeLessThanOrEqual(HYDRATION_MAX_BARS);
    expect(gridBarCount(floor, NOW, INTERVAL_MS["1d"])).toBeGreaterThan(HYDRATION_MAX_BARS - 2);
  });
});

describe("enqueueHydrationRequest", () => {
  it("queues a recoverable window under its stable id", () => {
    const { queue, answer } = enqueueHydrationRequest(emptyQueue, request(), NOW);
    expect(answer).toEqual({ outcome: "queued", id: "req-1" });
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]?.id).toBe("req-1");
  });

  it("queues testnet without merging it with the mainnet series", () => {
    const mainnet = enqueueHydrationRequest(emptyQueue, request(), NOW);
    const testnet = enqueueHydrationRequest(
      mainnet.queue,
      request({ id: "req-2", venue: "hyperliquid-testnet" }),
      NOW,
    );
    expect(testnet.answer.outcome).toBe("queued");
    expect(testnet.queue.requests).toHaveLength(2);
  });

  it("answers source_window_exhausted for a sound window older than the source's reach", () => {
    const floor = providerReachFloor("1d", NOW) as number;
    const { queue, answer } = enqueueHydrationRequest(
      emptyQueue,
      request({ fromT: floor - 10 * DAY, toT: floor - 1, deadlineAt: NOW + HYDRATION_MAX_WAIT_MS }),
      NOW,
    );
    // The interval and venue are supported; the history simply is not there —
    // a different sentence from "we do not hydrate that", and nothing queued.
    expect(answer.outcome).toBe("source_window_exhausted");
    if (answer.outcome === "source_window_exhausted") {
      expect(answer.reason).toContain("has not made");
    }
    expect(queue.requests).toHaveLength(0);
  });

  it("refuses a window wider than one recovery may fetch", () => {
    const { answer } = enqueueHydrationRequest(
      emptyQueue,
      request({ fromT: NOW - (CANDLE_WINDOW_BARS + 50) * DAY, toT: NOW }),
      NOW,
    );
    expect(answer.outcome).toBe("unsupported");
    if (answer.outcome === "unsupported") expect(answer.reason).toContain("coarser interval");
  });

  it("keeps `unsupported` for invalid input: interval, span, and deadlines", () => {
    expect(
      enqueueHydrationRequest(emptyQueue, request({ interval: "2h" }), NOW).answer.outcome,
    ).toBe("unsupported");
    expect(
      enqueueHydrationRequest(emptyQueue, request({ toT: NOW - 91 * DAY }), NOW).answer.outcome,
    ).toBe("unsupported");
    expect(
      enqueueHydrationRequest(emptyQueue, request({ deadlineAt: NOW - 1 }), NOW).answer.outcome,
    ).toBe("unsupported");
    expect(
      enqueueHydrationRequest(
        emptyQueue,
        request({ deadlineAt: NOW + HYDRATION_MAX_WAIT_MS + 1 }),
        NOW,
      ).answer.outcome,
    ).toBe("unsupported");
  });

  it("accepts a window of exactly one bar — a horizon-one study needs it", () => {
    const singleBarOpen = Math.floor((NOW - 10 * DAY) / DAY) * DAY;
    const { answer } = enqueueHydrationRequest(
      emptyQueue,
      request({ fromT: singleBarOpen, toT: singleBarOpen }),
      NOW,
    );
    expect(answer.outcome).toBe("queued");
  });

  it("shares one entry between identical requests, stretching the deadline", () => {
    const first = enqueueHydrationRequest(emptyQueue, request({ id: "a" }), NOW);
    const second = enqueueHydrationRequest(
      first.queue,
      request({ id: "b", deadlineAt: NOW + HYDRATION_MAX_WAIT_MS, purpose: "backtest" }),
      NOW,
    );
    expect(second.answer).toEqual({ outcome: "queued", id: "a" });
    expect(second.queue.requests).toHaveLength(1);
    expect(second.queue.requests[0]?.deadlineAt).toBe(NOW + HYDRATION_MAX_WAIT_MS);
  });

  it("keeps overlapping requests as separate entries with their own ids — no widening", () => {
    const first = enqueueHydrationRequest(
      emptyQueue,
      request({ id: "a", fromT: NOW - 90 * DAY, toT: NOW - 60 * DAY }),
      NOW,
    );
    const second = enqueueHydrationRequest(
      first.queue,
      request({ id: "b", fromT: NOW - 70 * DAY, toT: NOW - 40 * DAY, purpose: "backtest" }),
      NOW,
    );
    expect(second.answer).toEqual({ outcome: "queued", id: "b" });
    expect(second.queue.requests).toHaveLength(2);
    expect(second.queue.requests[0]?.fromT).toBe(NOW - 90 * DAY);
    expect(second.queue.requests[0]?.toT).toBe(NOW - 60 * DAY);
    expect(second.queue.requests[1]?.fromT).toBe(NOW - 70 * DAY);
    expect(second.queue.requests[1]?.toT).toBe(NOW - 40 * DAY);
  });

  it("never merges across venue, coin, or interval", () => {
    const first = enqueueHydrationRequest(emptyQueue, request({ id: "a" }), NOW);
    for (const differing of [
      request({ id: "b", coin: "BTC" }),
      request({ id: "c", interval: "1h" }),
    ]) {
      const next = enqueueHydrationRequest(first.queue, differing, NOW);
      expect(next.queue.requests).toHaveLength(2);
    }
  });

  it("leaves expired requests in place for the writer to answer exactly once", () => {
    const expired = request({ id: "old", deadlineAt: NOW - 1 });
    const next = enqueueHydrationRequest(
      { requests: [expired], results: [] },
      request({ id: "new" }),
      NOW,
    );
    expect(next.queue.requests).toHaveLength(2);
    expect(next.queue.results).toHaveLength(0);
    expect(next.queue.requests.some((entry) => entry.id === "old")).toBe(true);
  });

  it("displaces the closest-to-deadline request with a terminal result at the cap", () => {
    let queue = emptyQueue;
    for (let index = 0; index < HYDRATION_MAX_PENDING; index += 1) {
      queue = enqueueHydrationRequest(
        queue,
        request({
          id: `r${index}`,
          coin: `C${index}`,
          fromT: NOW - (index + 2) * DAY,
          toT: NOW - (index + 1) * DAY,
          deadlineAt: NOW + (index + 1) * 1_000,
        }),
        NOW,
      ).queue;
    }
    expect(queue.requests).toHaveLength(HYDRATION_MAX_PENDING);
    const overflow = enqueueHydrationRequest(
      queue,
      request({ id: "newest", coin: "NEW", fromT: NOW - 2 * DAY, toT: NOW - 1 * DAY }),
      NOW,
    );
    expect(overflow.answer.outcome).toBe("queued");
    expect(overflow.queue.requests).toHaveLength(HYDRATION_MAX_PENDING);
    // r0 had the least time left; it was answered, not sliced away in silence.
    expect(overflow.queue.requests.some((entry) => entry.id === "r0")).toBe(false);
    const displaced = overflow.queue.results.find((result) => result.id === "r0");
    expect(displaced?.outcome).toBe("failed");
    expect(displaced?.reason).toContain("displaced");
  });
});

describe("claimHydrationBatch", () => {
  it("hands the writer the oldest live requests first, bounded per tick", () => {
    const queue: HydrationQueue = {
      requests: [3, 1, 2, 5, 4].map((index) =>
        request({
          id: `c${index}`,
          coin: `C${index}`,
          requestedAt: NOW + index,
          fromT: NOW - (index + 2) * DAY,
          toT: NOW - (index + 1) * DAY,
        }),
      ),
      results: [],
    };
    const { batch, rest, expired } = claimHydrationBatch(queue, NOW);
    expect(batch.map((entry) => entry.coin)).toEqual(["C1", "C2"]);
    expect(rest.map((entry) => entry.coin)).toEqual(["C3", "C5", "C4"]);
    expect(expired).toHaveLength(0);
  });

  it("separates expired requests so they can be answered timed_out", () => {
    const queue: HydrationQueue = {
      requests: [request({ id: "old", coin: "OLD", deadlineAt: NOW - 1 })],
      results: [],
    };
    const { batch, expired } = claimHydrationBatch(queue, NOW);
    expect(batch).toHaveLength(0);
    expect(expired).toHaveLength(1);
  });
});

describe("planHydrationFetches (the writer's coalescing)", () => {
  const width = INTERVAL_MS["1d"];

  it("merges overlapping and adjacent windows of one series into one fetch", () => {
    const groups = planHydrationFetches([
      request({ id: "a", fromT: NOW - 90 * DAY, toT: NOW - 60 * DAY }),
      request({ id: "b", fromT: NOW - 70 * DAY, toT: NOW - 40 * DAY }),
      request({ id: "c", fromT: NOW - 60 * DAY, toT: NOW - 30 * DAY }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.fromT).toBe(NOW - 90 * DAY);
    expect(groups[0]?.toT).toBe(NOW - 30 * DAY);
    expect(groups[0]?.requests.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("fetches separated windows separately", () => {
    const groups = planHydrationFetches([
      request({ id: "a", fromT: NOW - 90 * DAY, toT: NOW - 60 * DAY }),
      request({ id: "b", fromT: NOW - 30 * DAY, toT: NOW - 10 * DAY }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("never widens a group past the span cap, even for overlapping windows", () => {
    const groups = planHydrationFetches([
      // A long window ending 100 days ago, overlapping a recent one: the
      // grid-aligned union is 5001 bars, one past the 5000-bar cap, so the
      // planner must fetch it as two groups. (NOW is deliberately not a
      // daily grid multiple — the cap counts grid bars, not raw days.)
      request({ id: "a", fromT: NOW - 5001 * DAY, toT: NOW - 100 * DAY }),
      request({ id: "b", fromT: NOW - 200 * DAY, toT: NOW }),
    ]);
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(gridBarCount(group.fromT, group.toT, width)).toBeLessThanOrEqual(HYDRATION_MAX_BARS);
    }
  });

  it("never coalesces across venue, coin, or interval", () => {
    const groups = planHydrationFetches([
      request({ id: "a", coin: "ETH", interval: "1d", fromT: NOW - 10 * DAY, toT: NOW }),
      request({ id: "b", coin: "BTC", interval: "1d", fromT: NOW - 10 * DAY, toT: NOW }),
      request({ id: "c", coin: "ETH", interval: "1h", fromT: NOW - 10 * DAY, toT: NOW }),
      request({ id: "d", venue: "hyperliquid-testnet", fromT: NOW - 10 * DAY, toT: NOW }),
    ]);
    expect(groups).toHaveLength(4);
  });
});

describe("recordHydrationResult and the file round trip", () => {
  it("records one answer per request id, newest first, capped", () => {
    let queue = emptyQueue;
    for (let index = 0; index < HYDRATION_MAX_RESULTS + 3; index += 1) {
      queue = recordHydrationResult(queue, {
        id: `k${index}`,
        outcome: "hydrated",
        finishedAt: NOW + index,
        barsFetched: index,
      });
    }
    expect(queue.results.length).toBe(HYDRATION_MAX_RESULTS);
    expect(queue.results[0]?.id).toBe(`k${HYDRATION_MAX_RESULTS + 2}`);
    const roundTrip = parseHydrationQueue(renderHydrationQueue(queue));
    expect(roundTrip.status).toBe("ok");
    if (roundTrip.status === "ok") {
      expect(roundTrip.queue.requests).toEqual(queue.requests);
      expect(roundTrip.queue.results[0]).toEqual(queue.results[0]);
    }
  });

  it("treats a missing file as empty but malformed content as unusable, never empty", () => {
    expect(parseHydrationQueue(null).status).toBe("ok");
    const notJson = parseHydrationQueue("not json");
    expect(notJson.status).toBe("unusable");
    const badEntry = parseHydrationQueue('{"requests":[{}],"results":[]}');
    expect(badEntry.status).toBe("unusable");
    const noArrays = parseHydrationQueue("{}");
    expect(noArrays.status).toBe("unusable");
    const duplicateId = parseHydrationQueue(
      renderHydrationQueue({ requests: [request({ id: "x" }), request({ id: "x" })], results: [] }),
    );
    expect(duplicateId.status).toBe("unusable");
  });
});

describe("assessWindowCoverage", () => {
  const width = MINUTE;
  const fromT = NOW;
  const toT = NOW + 9 * width;
  // Every bar in the window closed two bar-widths ago.
  const nowAfterClose = toT + 2 * width;
  const opens = (count: number) =>
    Array.from({ length: count }, (_, index) => fromT + index * width);

  it("is complete when every required closed bar is stored", () => {
    const assessment = assessWindowCoverage({
      intervalMs: width,
      fromT,
      toT,
      now: nowAfterClose,
      archivedOpens: opens(10),
      providerFloor: null,
      gaps: [],
    });
    expect(assessment.requiredBars).toBe(10);
    expect(assessment.missingBars).toBe(0);
    expect(assessment.complete).toBe(true);
    expect(assessment.finalBarMayBeOpen).toBe(false);
  });

  it("names exactly the missing closed bars", () => {
    const archived = opens(10).filter((open) => open !== fromT + 4 * width);
    const assessment = assessWindowCoverage({
      intervalMs: width,
      fromT,
      toT,
      now: nowAfterClose,
      archivedOpens: archived,
      providerFloor: null,
      gaps: [],
    });
    expect(assessment.missingBars).toBe(1);
    expect(assessment.missingOpens).toEqual([fromT + 4 * width]);
    expect(assessment.complete).toBe(false);
  });

  it("tolerates a requested final bar that has not closed yet", () => {
    // now sits inside the window's last bar: it may legitimately be absent.
    const nowMidLastBar = toT + 1;
    const assessment = assessWindowCoverage({
      intervalMs: width,
      fromT,
      toT,
      now: nowMidLastBar,
      archivedOpens: opens(9),
      providerFloor: null,
      gaps: [],
    });
    expect(assessment.finalBarMayBeOpen).toBe(true);
    expect(assessment.requiredBars).toBe(9);
    expect(assessment.complete).toBe(true);
  });

  it("never lets a present in-progress bar mask a missing closed one", () => {
    const nowMidLastBar = toT + 1;
    // The in-progress bar is stored; one closed bar in the middle is not.
    const archived = [...opens(9).filter((open) => open !== fromT + 3 * width), toT];
    const assessment = assessWindowCoverage({
      intervalMs: width,
      fromT,
      toT,
      now: nowMidLastBar,
      archivedOpens: archived,
      providerFloor: null,
      gaps: [],
    });
    expect(assessment.missingBars).toBe(1);
    expect(assessment.complete).toBe(false);
  });

  it("never claims coverage while a known gap overlaps the window", () => {
    const assessment = assessWindowCoverage({
      intervalMs: width,
      fromT,
      toT,
      now: nowAfterClose,
      archivedOpens: opens(10),
      providerFloor: null,
      gaps: [{ fromT: fromT + 2 * width, toT: fromT + 4 * width }],
    });
    expect(assessment.missingBars).toBe(0);
    expect(assessment.complete).toBe(false);
    expect(assessment.overlappingGaps).toEqual([
      { fromT: fromT + 2 * width, toT: fromT + 4 * width },
    ]);
  });

  it("never reports a window complete when its history predates the source (the Devcon shape)", () => {
    // An early occurrence before available history plus later recoverable
    // ones: the floor cuts three closed bars off the front of the window, and
    // every recoverable bar is stored. The window is still not complete —
    // the requested history cannot all exist — so nothing may claim
    // `already_covered` over it.
    const floor = fromT + 3 * width;
    const recoverable = opens(10).slice(3);
    const assessment = assessWindowCoverage({
      intervalMs: width,
      fromT,
      toT,
      now: nowAfterClose,
      archivedOpens: recoverable,
      providerFloor: floor,
      gaps: [],
    });
    expect(assessment.expectedClosedBars).toBe(10);
    expect(assessment.requiredBars).toBe(7);
    expect(assessment.unavailableBars).toBe(3);
    expect(assessment.missingBars).toBe(0);
    expect(assessment.complete).toBe(false);
  });

  it("is complete when the whole requested window is archived, however old", () => {
    // The same floor, but the three oldest bars were recorded while the
    // source still served them: every requested closed bar exists.
    const floor = fromT + 3 * width;
    const assessment = assessWindowCoverage({
      intervalMs: width,
      fromT,
      toT,
      now: nowAfterClose,
      archivedOpens: opens(10),
      providerFloor: floor,
      gaps: [],
    });
    expect(assessment.unavailableBars).toBe(3);
    expect(assessment.complete).toBe(true);
  });
});

describe("classifyHydrationOutcome", () => {
  const width = MINUTE;
  const fromT = NOW;
  const toT = NOW + 4 * width;
  const nowAfterClose = toT + 2 * width;
  const opensFrom = (count: number) =>
    Array.from({ length: count }, (_, index) => fromT + index * width);
  const assess = (overrides?: Partial<Parameters<typeof assessWindowCoverage>[0]>) =>
    assessWindowCoverage({
      intervalMs: width,
      fromT,
      toT,
      now: nowAfterClose,
      archivedOpens: opensFrom(5),
      providerFloor: null,
      gaps: [],
      ...overrides,
    });
  const full: WindowCoverageAssessment = assess();
  const withHole: WindowCoverageAssessment = assess({ archivedOpens: opensFrom(4) });
  const classify = (overrides: Partial<Parameters<typeof classifyHydrationOutcome>[0]>) =>
    classifyHydrationOutcome({
      after: withHole,
      completeBefore: false,
      barsFetched: 4,
      effectiveFloorT: fromT,
      emptySuccessfulResponse: false,
      ...overrides,
    });

  it("hydrated when this attempt finished making the window whole", () => {
    expect(
      classify({ after: full, completeBefore: false, barsFetched: 5, effectiveFloorT: null })
        .outcome,
    ).toBe("hydrated");
  });

  it("hydrated even when the fetch itself served nothing but the window newly closed whole", () => {
    // The WS feed or a concurrent unit landed the last bar between the claim
    // and the fetch: the transition is real, so the word is `hydrated`, not
    // `already_covered` — the window did NOT pre-exist this attempt.
    expect(
      classify({ after: full, completeBefore: false, barsFetched: 0, effectiveFloorT: null })
        .outcome,
    ).toBe("hydrated");
  });

  it("already_covered only when the complete window pre-existed the fetch — re-served rows cannot fabricate a recovery", () => {
    const verdict = classify({
      after: full,
      completeBefore: true,
      barsFetched: 5,
      effectiveFloorT: null,
    });
    expect(verdict.outcome).toBe("already_covered");
    expect(verdict.reason).toContain("already whole");
  });

  it("partial when recoverable bars were still not served, naming the count", () => {
    const verdict = classify({});
    expect(verdict.outcome).toBe("partial");
    expect(verdict.reason).toContain("1 recoverable bar(s)");
    expect(verdict.reason).toContain("can be asked again");
  });

  it("partial names both the recoverable misses and the older exhausted prefix truthfully", () => {
    // A hole inside the reach AND a prefix older than the floor: the reason
    // must say which is which rather than blending them.
    const straddle = assess({
      fromT: fromT - 3 * width,
      archivedOpens: [...opensFrom(4), fromT - width, fromT - 2 * width],
      providerFloor: fromT - 2 * width,
    });
    const verdict = classify({ after: straddle, effectiveFloorT: fromT - 2 * width });
    expect(verdict.outcome).toBe("partial");
    expect(verdict.reason).toContain("1 recoverable bar(s)");
    expect(verdict.reason).toContain("1 older bar(s) predate");
  });

  it("source_window_exhausted when everything recoverable is present and only the prefix is beyond the source", () => {
    // The Devcon shape through the writer: the earliest occurrence predates
    // the provider's history, the later ones are fully archived.
    const devcon = assess({
      fromT: fromT - 3 * width,
      archivedOpens: [fromT - 2 * width, fromT - width, ...opensFrom(5)],
      providerFloor: fromT - 2 * width,
    });
    expect(devcon.complete).toBe(false);
    expect(devcon.missingBars).toBe(0);
    expect(devcon.unavailableBars).toBe(1);
    const verdict = classify({
      after: devcon,
      barsFetched: 7,
      effectiveFloorT: fromT - 2 * width,
    });
    expect(verdict.outcome).toBe("source_window_exhausted");
    expect(verdict.reason).toContain("1 of the requested bar(s) predate");
    expect(verdict.reason).toContain("7 recoverable bar(s) served");
    expect(verdict.reason).toContain("has not made");
  });

  it("source_window_exhausted when a successful response held nothing at all", () => {
    const verdict = classify({
      barsFetched: 0,
      effectiveFloorT: null,
      emptySuccessfulResponse: true,
    });
    expect(verdict.outcome).toBe("source_window_exhausted");
  });

  it("partial, not exhausted, while an unresolved gap record keeps a fully stored window incomplete", () => {
    const gapped = assess({
      gaps: [{ fromT: fromT + width, toT: fromT + 2 * width }],
    });
    const verdict = classify({ after: gapped, effectiveFloorT: null });
    expect(verdict.outcome).toBe("partial");
    expect(verdict.reason).toContain("gap record");
  });

  it("errors map by kind: rate_limited and failed", () => {
    expect(classify({ error: "http 429", rateLimited: true }).outcome).toBe("rate_limited");
    expect(classify({ error: "boom" }).outcome).toBe("failed");
  });
});

describe("the transport: locked, atomic, honest", () => {
  it("keeps every request enqueued through the locked file path", () => {
    withTempQueuePath((path) => {
      for (let index = 0; index < 6; index += 1) {
        const locked = withHydrationQueueLock(path, () => {
          const loaded = loadHydrationQueue(path);
          if (loaded.status !== "ok") throw new Error(loaded.reason);
          const next = enqueueHydrationRequest(
            loaded.queue,
            request({
              id: `r${index}`,
              coin: `C${index}`,
              fromT: NOW - (index + 2) * DAY,
              toT: NOW - (index + 1) * DAY,
            }),
            NOW,
          );
          storeHydrationQueue(path, next.queue);
          return next.answer.outcome;
        });
        expect(locked.ok).toBe(true);
      }
      const loaded = loadHydrationQueue(path);
      expect(loaded.status).toBe("ok");
      if (loaded.status !== "ok") return;
      // Six asks, a cap of four pending: two were displaced with answers,
      // none was silently lost.
      expect(loaded.queue.requests).toHaveLength(HYDRATION_MAX_PENDING);
      expect(loaded.queue.results).toHaveLength(2);
      expect(loaded.queue.results.every((result) => result.outcome === "failed")).toBe(true);
    });
  });

  it("writes atomically: the file is always parseable and no temp remains", () => {
    withTempQueuePath((path) => {
      storeHydrationQueue(path, { requests: [request()], results: [] });
      const loaded = loadHydrationQueue(path);
      expect(loaded.status).toBe("ok");
      const dir = NodeFS.readdirSync(NodePath.dirname(path));
      expect(dir.filter((name) => name.includes(".tmp"))).toHaveLength(0);
    });
  });

  it("refuses to touch the file while another holder holds a fresh lock", () => {
    withTempQueuePath((path) => {
      const lockDir = `${path}.lock`;
      NodeFS.mkdirSync(lockDir);
      NodeFS.writeFileSync(NodePath.join(lockDir, "holder.json"), '{"pid":999999}');
      const verdict = withHydrationQueueLock(path, () => "ran");
      expect(verdict.ok).toBe(false);
      // The holder's lock is still there, and no queue file was created.
      expect(NodeFS.existsSync(lockDir)).toBe(true);
      expect(NodeFS.existsSync(path)).toBe(false);
      NodeFS.rmSync(lockDir, { recursive: true, force: true });
    });
  });

  it("breaks a stale lock whose holder is long gone", () => {
    withTempQueuePath((path) => {
      const lockDir = `${path}.lock`;
      NodeFS.mkdirSync(lockDir);
      const holder = NodePath.join(lockDir, "holder.json");
      NodeFS.writeFileSync(holder, '{"pid":999999}');
      const stale = new Date(Date.now() - HYDRATION_QUEUE_LOCK_STALE_MS - 1_000);
      NodeFS.utimesSync(holder, stale, stale);
      const verdict = withHydrationQueueLock(path, () => "ran");
      expect(verdict).toEqual({ ok: true, value: "ran" });
      expect(NodeFS.existsSync(lockDir)).toBe(false);
    });
  });
});

describe("reading the queue file: absent, malformed, unreadable", () => {
  it("an absent file is the honest empty queue", () => {
    withTempQueuePath((path) => {
      expect(readHydrationQueueFile(path)).toEqual({ status: "absent" });
      const loaded = loadHydrationQueue(path);
      expect(loaded.status).toBe("ok");
      if (loaded.status === "ok") {
        expect(loaded.queue.requests).toHaveLength(0);
        expect(loaded.queue.results).toHaveLength(0);
      }
    });
  });

  it("malformed content is unusable, never empty", () => {
    withTempQueuePath((path) => {
      NodeFS.writeFileSync(path, "{ not the queue");
      expect(readHydrationQueueFile(path).status).toBe("read");
      const loaded = loadHydrationQueue(path);
      expect(loaded.status).toBe("unusable");
      if (loaded.status === "unusable") expect(loaded.reason).toContain("not valid JSON");
    });
  });

  it("a read failure is unusable with the errno name, never absence", () => {
    withTempQueuePath((path) => {
      // A directory where the file should be: readFileSync fails with EISDIR,
      // a read error that is not "the queue does not exist".
      NodeFS.mkdirSync(path);
      const read = readHydrationQueueFile(path);
      expect(read.status).toBe("unreadable");
      if (read.status === "unreadable") {
        expect(read.reason).toContain("EISDIR");
        // The reason names the error class only — no file content travels.
        expect(read.reason).not.toContain("{");
      }
      const loaded = loadHydrationQueue(path);
      expect(loaded.status).toBe("unusable");
    });
  });

  it("a producer refuses to overwrite unreadable state as empty", () => {
    withTempQueuePath((path) => {
      NodeFS.mkdirSync(path);
      const verdict = withHydrationQueueLock(path, () => {
        const loaded = loadHydrationQueue(path);
        if (loaded.status !== "ok") return "refused";
        storeHydrationQueue(path, enqueueHydrationRequest(loaded.queue, request(), NOW).queue);
        return "wrote";
      });
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) throw new Error("the lock should have been held");
      expect(verdict.value).toBe("refused");
      // Nothing was written over the unreadable state: still a directory.
      expect(NodeFS.statSync(path).isDirectory()).toBe(true);
    });
  });

  // it.live: the deadline is a real 120ms wall-clock timeout (the header's
  // "waits are wall-clock by design"); it.effect's frozen clock would never
  // let the sleep side of the race fire.
  it.live("a waiter times out honestly over unreadable state and never mutates it", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hydration-dir."));
    const path = NodePath.join(dir, "queue.json");
    return Effect.gen(function* () {
      NodeFS.mkdirSync(path);
      const result = yield* waitForHydrationResult(path, "any-id", Date.now() + 120);
      expect(result).toBeNull();
      expect(NodeFS.statSync(path).isDirectory()).toBe(true);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
  });
});

describe("writer wake and timing", () => {
  it("pins the slice at half the maximum wait, so a live request beats its deadline", () => {
    // The relationship the whole wake design rests on: even with no watcher
    // at all, a request arriving the instant a slice begins is observed a
    // full half-deadline before it can expire.
    expect(HYDRATION_WRITER_SLICE_MS).toBeLessThanOrEqual(HYDRATION_MAX_WAIT_MS / 2);
    expect(HYDRATION_WRITER_SLICE_MS).toBeGreaterThan(0);
  });

  it("wakes on the queue file's own atomic rename, not on other files", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hydration-wake."));
    const path = NodePath.join(dir, "queue.json");
    try {
      const watcher = makeHydrationFileWatcher(path);
      assert.isNotNull(watcher);
      if (watcher === null) return;
      try {
        // An unrelated file in the same directory must not count as a wake.
        NodeFS.writeFileSync(NodePath.join(dir, "unrelated.json"), "{}");
        storeHydrationQueue(path, { requests: [request()], results: [] });
        const woken = await watcher.waitOrTimeout(5_000);
        expect(woken).toBe(true);
      } finally {
        watcher.close();
      }
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("waitForHydrationResult", () => {
  // `it.live`, not `it.effect`: the wait races a kernel file watch against a
  // wall-clock deadline, so freezing the clock would freeze the answer too.
  it.live("resolves on the writer's recorded answer, by stable id, event-driven", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hydration-wait."));
      const path = NodePath.join(dir, "queue.json");
      try {
        storeHydrationQueue(path, { requests: [request({ id: "wait-1" })], results: [] });
        const writer = Effect.gen(function* () {
          yield* Effect.sleep(30);
          const locked = withHydrationQueueLock(path, () => {
            const loaded = loadHydrationQueue(path);
            if (loaded.status !== "ok") return null;
            storeHydrationQueue(
              path,
              recordHydrationResult(loaded.queue, {
                id: "wait-1",
                outcome: "hydrated",
                finishedAt: Date.now(),
                barsFetched: 5,
              }),
            );
            return true;
          });
          if (!locked.ok || locked.value !== true)
            throw new Error("the writer could not lock the queue");
        });
        const [result] = yield* Effect.all(
          [waitForHydrationResult(path, "wait-1", Date.now() + 5_000), writer],
          { concurrency: "unbounded" },
        );
        assert.isNotNull(result);
        expect(result?.outcome).toBe("hydrated");
        expect(result?.barsFetched).toBe(5);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("returns null at the deadline rather than hanging", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hydration-timeout."));
      const path = NodePath.join(dir, "queue.json");
      try {
        storeHydrationQueue(path, { requests: [request({ id: "wait-2" })], results: [] });
        const result = yield* waitForHydrationResult(path, "wait-2", Date.now() + 120);
        expect(result).toBeNull();
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
});
