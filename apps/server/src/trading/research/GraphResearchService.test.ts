import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import { createHash } from "node:crypto";
import type {
  ForgeEvidenceRecord,
  ForgeQueryCapture,
  ForgeSwapObservation,
  ForgeSourceHealth,
  ForgeWindowFetch,
} from "@t3tools/trading-contracts";
import { FORGE_MAX_WINDOW_SECONDS } from "@t3tools/trading-contracts";
import { eventStudyReadWindow } from "@t3tools/trading-contracts/eventSets";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ForgeGraphSource,
  FORGE_SWAPS_QUERY,
  type ForgeFetchWindowInput,
} from "../forge/GraphSource.ts";
import { ForgeSourceStore, type ForgeEvidenceInsert } from "../forge/ForgeSourceStore.ts";
import {
  GraphResearchService,
  makeGraphResearchService,
  GRAPH_STUDY_MAX_OCCURRENCES,
  GRAPH_STUDY_MAX_SEGMENTS,
} from "./GraphResearchService.ts";

const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const PIN = 18_500_000;
const HOUR = 3_600_000;
const START = 1_699_999_200_000; // Exact UTC-hour boundary.
const input = {
  environmentId: "env-1",
  poolId: POOL,
  market: "ETH",
  entryBasis: "first_closed_bar_after_event" as const,
  occurrences: [{ startAt: START - HOUR, endAt: START + 1_000, source: "test" }],
  intervalMs: HOUR,
  horizonBars: 1,
  now: START + 4 * HOUR,
};
// Two occurrences 40h apart: a 42h read window forces multi-segment capture.
const multiInput = {
  ...input,
  occurrences: [
    input.occurrences[0]!,
    { startAt: START + 40 * HOUR, endAt: START + 40 * HOUR + 1_000, source: "test" },
  ],
  now: START + 48 * HOUR,
};
const observation = (timestamp: number, seq: number): ForgeSwapObservation => ({
  chain: "ethereum-mainnet",
  poolId: POOL,
  observationId: `0x${"1".repeat(64)}:${seq}`,
  transactionHash: `0x${"1".repeat(64)}`,
  logIndex: seq,
  timestamp,
  sender: "0xa",
  recipient: "0xb",
  amount0: "2000000",
  amount1: "-1000",
  sqrtPriceX96: "1",
  tick: 0,
  baseIsToken1: true,
  priceQuotePerBase: { numerator: "2000", denominator: "1" },
  priceQuotePerBaseMicros: 2_000_000_000,
  quoteVolumeRaw: "2000000",
  quoteVolumeMicros: 2_000_000,
});

/** One retained row the fake store serves back for reuse paths. */
interface RetainedRow {
  readonly record: ForgeEvidenceRecord;
  readonly observations: ReadonlyArray<ForgeSwapObservation>;
  readonly queryCapture?: ForgeQueryCapture;
}

const fixture = (
  options: {
    configured?: boolean;
    retentionFails?: boolean;
    probe?: ForgeSourceHealth;
    fetchedAtMs?: number;
    /** Rows the fake source returns per segment fetch. */
    observationsAt?: (index: number) => number;
    /** Wall-clock advance applied on every segment fetch (fake clock). */
    clockStepMs?: number;
    rows?: ReadonlyArray<RetainedRow>;
    override?: (fetch: ForgeWindowFetch, index: number) => ForgeWindowFetch;
  } = {},
) => {
  const calls: ForgeFetchWindowInput[] = [];
  const probes: Array<ForgeSourceHealth> = [];
  const retained: ForgeEvidenceInsert[] = [];
  let clockNowMs = 1_700_000_000_000;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => clockNowMs,
    currentTimeMillis: Effect.sync(() => clockNowMs),
    currentTimeNanosUnsafe: () => BigInt(clockNowMs) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(clockNowMs) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  };
  const source = ForgeGraphSource.of({
    settings: Effect.succeed(
      options.configured === false
        ? { configured: false, reason: "source not configured" }
        : {
            configured: true,
            source: {
              kind: "uniswap-v3-graph",
              endpoint: "https://graph.example",
              deployment: "Qmdeploy",
              indexingEndpoint: "https://indexing.example",
              maxLagBlocks: 6,
              pageSize: 100,
              maxSwapsPerFetch: 500,
              pools: [
                {
                  chain: "ethereum-mainnet",
                  poolId: POOL,
                  feeTierHundredthsBps: 500,
                  label: "USDC/WETH",
                  baseIsToken1: true,
                  token0: { address: `0x${"2".repeat(40)}`, symbol: "USDC", decimals: 6 },
                  token1: { address: `0x${"3".repeat(40)}`, symbol: "WETH", decimals: 18 },
                },
              ],
            },
          },
    ),
    probeHealth: Effect.sync(() => {
      const health: ForgeSourceHealth = options.probe ?? {
        status: "healthy",
        latestBlock: PIN,
        probedAtMs: input.now,
      };
      probes.push(health);
      return health;
    }),
    fetchWindow: (request) =>
      Effect.sync(() => {
        calls.push(request);
        if (options.clockStepMs !== undefined) clockNowMs += options.clockStepMs;
        const index = calls.length - 1;
        const count = options.observationsAt?.(index) ?? 1;
        const fetch: ForgeWindowFetch = {
          poolId: POOL,
          status: "complete",
          historical: true,
          fetchedAtMs: options.fetchedAtMs ?? input.now + 100,
          deployment: "Qmdeploy",
          pinnedBlock: PIN,
          pinnedBlockHash: "0xpin",
          window: { startedAt: request.startedAt, endedAt: request.endedAt },
          observations: Array.from({ length: count }, (_, i) =>
            observation(request.startedAt + 1 + (i % 3_600), index * 1_000_000 + i),
          ),
          queryCapture: {
            query: FORGE_SWAPS_QUERY,
            variables: [
              {
                pool: POOL,
                first: 100,
                cursor: "",
                block: PIN,
                from: String(request.startedAt - 300),
                to: String(request.endedAt),
              },
            ],
          },
        };
        return options.override?.(fetch, index) ?? fetch;
      }),
    fetchAllPools: () => Effect.die("not used"),
  });
  const store = ForgeSourceStore.of({
    insert: (capture) =>
      options.retentionFails
        ? Effect.fail(new PersistenceSqlError({ operation: "test.insert" }))
        : Effect.sync(() => {
            retained.push(capture);
          }),
    readRecord: (evidenceId) =>
      Effect.succeed(
        options.rows?.find((row) => row.record.evidenceId === evidenceId)?.record ?? null,
      ),
    readObservations: (evidenceId) =>
      Effect.sync(() => {
        const row = options.rows?.find((entry) => entry.record.evidenceId === evidenceId);
        if (row === undefined) return null;
        return {
          record: row.record,
          observations: row.observations,
          claimedCount: row.record.observationCount,
          payloadIntact: row.record.observationCount === row.observations.length,
          ...(row.queryCapture === undefined ? {} : { queryCapture: row.queryCapture }),
        };
      }),
    listRecent: ({ limit }) =>
      Effect.sync(() =>
        [...(options.rows ?? [])]
          .sort((a, b) => b.record.fetchedAtMs - a.record.fetchedAtMs)
          .slice(0, Math.min(limit ?? 100, 100))
          .map((row) => row.record),
      ),
  });
  const layer = Layer.effect(
    GraphResearchService,
    makeGraphResearchService.pipe(
      Effect.provideService(ForgeGraphSource, source),
      Effect.provideService(ForgeSourceStore, store),
    ),
  );
  return { calls, probes, retained, clock, layer };
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The read window the service computes for an input, mirroring its math. */
const studyBounds = (request: typeof input) => {
  const bounds = eventStudyReadWindow(request.occurrences, request);
  const fromMs = Math.max(0, Math.ceil(bounds.fromT / request.intervalMs) * request.intervalMs);
  const toMs = Math.min(
    request.now,
    Math.floor(bounds.toT / request.intervalMs) * request.intervalMs + request.intervalMs,
  );
  return {
    fromMs,
    toMs,
    startedAt: Math.floor(fromMs / 1000),
    endedAt: Math.floor((toMs - 1) / 1000),
  };
};

/** Run one fresh acquisition and lift its retained insert into a seed row. */
const acquireSeed = (options: Parameters<typeof fixture>[0] = {}, request: typeof input = input) =>
  Effect.gen(function* () {
    const fake = fixture(options);
    const read = yield* Effect.gen(function* () {
      return yield* (yield* GraphResearchService).loadStudyDataset(request);
    }).pipe(Effect.provide(fake.layer));
    assert.equal(read.status, "ok");
    if (read.status !== "ok") throw new Error("seed acquisition failed");
    const stored = fake.retained[0]!;
    return {
      manifest: read.dataset.manifest,
      row: {
        record: stored.record,
        observations: stored.observations,
        ...(stored.queryCapture === undefined ? {} : { queryCapture: stored.queryCapture }),
      } as RetainedRow,
    };
  });

describe("Graph research capture integrity", () => {
  it.effect(
    "uses the study end and basis, captures the full exit bar and retains exact provenance",
    () => {
      const fake = fixture();
      return Effect.gen(function* () {
        const service = yield* GraphResearchService;
        for (const entryBasis of [
          "first_closed_bar_after_event",
          "first_bar_open_after_event",
        ] as const) {
          const read = yield* service.loadStudyDataset({ ...input, entryBasis });
          assert.equal(read.status, "ok");
          if (read.status !== "ok") return;
          assert.equal(read.dataset.reused, false);
          assert.equal(read.dataset.partialReason, undefined);
          const bounds = eventStudyReadWindow(input.occurrences, { ...input, entryBasis });
          const call = fake.calls.at(-1)!;
          assert.equal(call.startedAt * 1000, bounds.fromT);
          assert.equal((call.endedAt + 1) * 1000, bounds.toT + HOUR);
          const stored = fake.retained.at(-1)!;
          assert.equal(stored.record.evidenceId, read.dataset.manifest.id);
          assert.deepEqual(stored.observations, read.dataset.observations);
          assert.equal(read.dataset.manifest.contentSha256, hash(stored.observations));
          assert.equal(read.dataset.manifest.variablesSha256, hash(stored.queryCapture!.variables));
          assert.equal(
            read.dataset.manifest.programSha256,
            createHash("sha256").update(stored.queryCapture!.query).digest("hex"),
          );
          assert.equal(read.dataset.manifest.capturedAtMs, input.now + 100);
          assert.equal(read.dataset.quoteDecimals, 6);
          assert.equal(read.dataset.quoteSymbol, "USDC");
        }
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect("captures intervening baseline bars and keeps a healthy empty source sparse", () => {
    const fake = fixture({
      override: (fetch) => ({ ...fetch, status: "empty", observations: [] }),
    });
    return Effect.gen(function* () {
      const service = yield* GraphResearchService;
      const read = yield* service.loadStudyDataset({
        ...input,
        occurrences: [
          input.occurrences[0]!,
          {
            ...input.occurrences[0]!,
            endAt: START + 2 * HOUR + 1_000,
          },
        ],
        now: START + 5 * HOUR,
      });
      assert.equal(read.status, "ok");
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0]!.startedAt * 1000, START);
      assert.equal((fake.calls[0]!.endedAt + 1) * 1000, START + 4 * HOUR);
      if (read.status === "ok") {
        assert.deepEqual(read.dataset.candles, []);
        assert.equal(read.dataset.manifest.coverage.rows, 0);
        assert.equal(read.dataset.manifest.status, "complete");
        assert.equal(read.dataset.reused, false);
      }
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("refuses invalid scope and over-budget windows before fetching", () => {
    const fake = fixture();
    return Effect.gen(function* () {
      const service = yield* GraphResearchService;
      for (const change of [
        { market: "BTC" },
        { poolId: "0xunknown" },
        { intervalMs: 0 },
        { occurrences: [] },
        {
          occurrences: Array.from(
            { length: GRAPH_STUDY_MAX_OCCURRENCES + 1 },
            () => input.occurrences[0]!,
          ),
        },
        // 91 days needs more than the 90-segment request budget.
        {
          occurrences: [
            input.occurrences[0]!,
            { ...input.occurrences[0]!, endAt: START + 91 * 24 * HOUR },
          ],
          now: START + 93 * 24 * HOUR,
        },
      ]) {
        assert.equal(
          (yield* service.loadStudyDataset({ ...input, ...change })).status,
          "unavailable",
        );
      }
      assert.equal(fake.calls.length, 0);
      assert.equal(fake.probes.length, 0);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("refuses unhealthy or unretained captures instead of manufacturing a manifest", () => {
    const cases = [
      fixture({ configured: false }),
      fixture({ retentionFails: true }),
      fixture({ override: (fetch) => ({ ...fetch, status: "stale", reason: "lagged" }) }),
      fixture({ override: (fetch) => ({ ...fetch, queryCapture: undefined }) }),
    ];
    return Effect.gen(function* () {
      for (const fake of cases) {
        const read = yield* Effect.gen(function* () {
          return yield* (yield* GraphResearchService).loadStudyDataset(input);
        }).pipe(Effect.provide(fake.layer));
        assert.equal(read.status, "unavailable");
        assert.equal(fake.retained.length, 0);
      }
    });
  });

  it.effect("hashes normalized content rather than identity alone", () => {
    const first = fixture();
    const changed = fixture({
      override: (fetch) => ({
        ...fetch,
        observations: fetch.observations!.map((row) => ({
          ...row,
          amount0: "3000000",
          quoteVolumeRaw: "3000000",
          quoteVolumeMicros: 3_000_000,
        })),
      }),
    });
    return Effect.gen(function* () {
      const read = (layer: typeof first.layer) =>
        Effect.gen(function* () {
          return yield* (yield* GraphResearchService).loadStudyDataset(input);
        }).pipe(Effect.provide(layer));
      const a = yield* read(first.layer);
      const b = yield* read(changed.layer);
      assert.equal(a.status, "ok");
      assert.equal(b.status, "ok");
      if (a.status === "ok" && b.status === "ok") {
        assert.notEqual(a.dataset.manifest.contentSha256, b.dataset.manifest.contentSha256);
        assert.notEqual(a.dataset.manifest.id, b.dataset.manifest.id);
      }
    });
  });
});

describe("Graph research multi-segment acquisition", () => {
  it.effect(
    "tiles a >24h window into bounded segments sharing one pin and one evidence row",
    () => {
      const fake = fixture();
      return Effect.gen(function* () {
        const read = yield* (yield* GraphResearchService).loadStudyDataset(multiInput);
        const bounds = studyBounds(multiInput);
        assert.equal(read.status, "ok");
        if (read.status !== "ok") return;
        assert.ok(fake.calls.length >= 2, "a >24h window must use multiple segments");
        assert.equal(fake.calls[0]!.startedAt, bounds.startedAt);
        assert.equal(fake.calls.at(-1)!.endedAt, bounds.endedAt);
        for (let index = 0; index < fake.calls.length; index += 1) {
          const call = fake.calls[index]!;
          assert.isTrue(call.endedAt - call.startedAt <= FORGE_MAX_WINDOW_SECONDS);
          assert.equal(call.pinnedBlock, PIN);
          if (index > 0) {
            assert.equal(call.startedAt, fake.calls[index - 1]!.endedAt + 1);
          }
        }
        assert.equal(fake.probes.length, 1);
        // One retained row spans the whole window with concatenated variables.
        assert.equal(fake.retained.length, 1);
        const stored = fake.retained[0]!;
        assert.equal(stored.record.windowStart, bounds.startedAt);
        assert.equal(stored.record.windowEnd, bounds.endedAt);
        assert.equal(
          stored.queryCapture!.variables.length,
          fake.calls.length,
          "one page of variables per segment, in segment order",
        );
        fake.calls.forEach((call, index) => {
          assert.equal(stored.queryCapture!.variables[index]!.from, String(call.startedAt - 300));
        });
        const dataset = read.dataset;
        assert.equal(dataset.manifest.status, "complete");
        assert.deepEqual(dataset.manifest.requested, { fromMs: bounds.fromMs, toMs: bounds.toMs });
        assert.deepEqual(dataset.manifest.coverage, {
          fromMs: bounds.fromMs,
          toMs: bounds.toMs,
          rows: dataset.observations.length,
        });
        assert.deepEqual(dataset.manifest.pin, { blockNumber: String(PIN), blockHash: "0xpin" });
        assert.equal(dataset.reused, false);
        assert.equal(dataset.partialReason, undefined);
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect("refuses the whole dataset when one segment fails, naming its bounds", () => {
    const fake = fixture({
      override: (fetch, index) =>
        index === 1 ? { ...fetch, status: "unavailable", reason: "graph down" } : fetch,
    });
    return Effect.gen(function* () {
      const read = yield* (yield* GraphResearchService).loadStudyDataset(multiInput);
      assert.equal(read.status, "unavailable");
      if (read.status === "unavailable") {
        const failed = fake.calls[1]!;
        assert.match(read.reason, new RegExp(`${failed.startedAt}..${failed.endedAt}`));
        assert.match(read.reason, /graph down/);
      }
      assert.equal(fake.retained.length, 0);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("refuses when a segment drifts off the shared pin", () => {
    const fake = fixture({
      override: (fetch, index) =>
        index === 1 ? { ...fetch, pinnedBlockHash: "0xreorged" } : fetch,
    });
    return Effect.gen(function* () {
      const read = yield* (yield* GraphResearchService).loadStudyDataset(multiInput);
      assert.equal(read.status, "unavailable");
      if (read.status === "unavailable") {
        assert.match(read.reason, /drifted to block 18500000 \(0xreorged\)/);
      }
      assert.equal(fake.retained.length, 0);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("refuses a multi-segment capture when no shared pin can be resolved", () => {
    const fake = fixture({
      probe: { status: "unavailable", reason: "probe failed", probedAtMs: input.now },
    });
    return Effect.gen(function* () {
      const read = yield* (yield* GraphResearchService).loadStudyDataset(multiInput);
      assert.equal(read.status, "unavailable");
      if (read.status === "unavailable") {
        assert.match(read.reason, /could not resolve a shared pin for a multi-segment capture/);
      }
      assert.equal(fake.calls.length, 0);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("refuses a window above the segment budget up front, naming the cap", () => {
    const fake = fixture();
    return Effect.gen(function* () {
      const read = yield* (yield* GraphResearchService).loadStudyDataset({
        ...input,
        occurrences: [
          input.occurrences[0]!,
          { ...input.occurrences[0]!, endAt: START + 91 * 24 * HOUR },
        ],
        now: START + 93 * 24 * HOUR,
      });
      assert.equal(read.status, "unavailable");
      if (read.status === "unavailable") {
        assert.match(read.reason, new RegExp(`${GRAPH_STUDY_MAX_SEGMENTS}-segment request cap`));
        assert.match(read.reason, /narrow the event set and horizon/);
      }
      assert.equal(fake.calls.length, 0);
      assert.equal(fake.probes.length, 0);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect(
    "stops at the row budget and returns a partial dataset ending at the last segment",
    () => {
      const fake = fixture({ observationsAt: () => 51_000 });
      return Effect.gen(function* () {
        const read = yield* (yield* GraphResearchService).loadStudyDataset(multiInput);
        assert.equal(read.status, "ok");
        assert.equal(fake.calls.length, 1, "the row budget stops further segments");
        if (read.status !== "ok") return;
        const bounds = studyBounds(multiInput);
        const lastSegmentEnd = fake.calls[0]!.endedAt;
        assert.equal(read.dataset.manifest.status, "partial");
        assert.deepEqual(read.dataset.manifest.requested, {
          fromMs: bounds.fromMs,
          toMs: bounds.toMs,
        });
        assert.equal(read.dataset.manifest.coverage.toMs, (lastSegmentEnd + 1) * 1000);
        assert.equal(read.dataset.manifest.coverage.rows, read.dataset.observations.length);
        assert.match(read.dataset.partialReason ?? "", /row budget/);
        assert.equal(read.dataset.reused, false);
        assert.equal(fake.retained[0]!.record.windowEnd, lastSegmentEnd);
        assert.equal(fake.retained[0]!.record.observationCount, 51_000);
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect("stops at the elapsed-time budget and returns a partial dataset", () => {
    const fake = fixture({ clockStepMs: 130_000 });
    return Effect.gen(function* () {
      const read = yield* (yield* GraphResearchService)
        .loadStudyDataset(multiInput)
        .pipe(Effect.provideService(Clock.Clock, fake.clock));
      assert.equal(read.status, "ok");
      assert.equal(fake.calls.length, 1, "the time budget stops further segments");
      if (read.status !== "ok") return;
      assert.equal(read.dataset.manifest.status, "partial");
      assert.equal(read.dataset.manifest.coverage.toMs, (fake.calls[0]!.endedAt + 1) * 1000);
      assert.match(read.dataset.partialReason ?? "", /budget/);
      assert.equal(fake.retained.length, 1);
    }).pipe(Effect.provide(fake.layer));
  });
});

describe("Graph research dataset reuse", () => {
  it.effect("serves an explicitly named retained dataset without fetching", () =>
    Effect.gen(function* () {
      const seed = yield* acquireSeed();
      const fake = fixture({ rows: [seed.row] });
      const read = yield* Effect.gen(function* () {
        return yield* (yield* GraphResearchService).loadStudyDataset({
          ...input,
          datasetId: seed.manifest.id,
        });
      }).pipe(Effect.provide(fake.layer));
      assert.equal(read.status, "ok");
      assert.equal(fake.calls.length, 0);
      if (read.status !== "ok") return;
      assert.equal(read.dataset.reused, true);
      assert.equal(read.dataset.manifest.id, seed.manifest.id);
      assert.equal(read.dataset.manifest.status, "complete");
      assert.deepEqual(read.dataset.observations, seed.row.observations);
      assert.equal(read.dataset.manifest.contentSha256, seed.manifest.contentSha256);
      assert.equal(read.dataset.quoteDecimals, 6);
    }),
  );

  it.effect("refuses an explicitly named dataset whose payload fails integrity verification", () =>
    Effect.gen(function* () {
      const seed = yield* acquireSeed();
      const tampered: RetainedRow = {
        ...seed.row,
        record: { ...seed.row.record, digest: `0x${"d".repeat(64)}` },
      };
      const fake = fixture({ rows: [tampered] });
      const read = yield* Effect.gen(function* () {
        return yield* (yield* GraphResearchService).loadStudyDataset({
          ...input,
          datasetId: seed.manifest.id,
        });
      }).pipe(Effect.provide(fake.layer));
      assert.equal(read.status, "unavailable");
      if (read.status === "unavailable") {
        assert.match(read.reason, /failed integrity verification/);
      }
      assert.equal(fake.calls.length, 0, "explicit lineage never falls back to a fresh fetch");
    }),
  );

  it.effect("refuses an explicitly named dataset that does not cover the study window", () =>
    Effect.gen(function* () {
      const seed = yield* acquireSeed();
      const shortWindow: RetainedRow = {
        ...seed.row,
        record: { ...seed.row.record, windowEnd: seed.row.record.windowEnd - 1 },
      };
      const fake = fixture({ rows: [shortWindow] });
      const read = yield* Effect.gen(function* () {
        return yield* (yield* GraphResearchService).loadStudyDataset({
          ...input,
          datasetId: seed.manifest.id,
        });
      }).pipe(Effect.provide(fake.layer));
      assert.equal(read.status, "unavailable");
      if (read.status === "unavailable") {
        assert.match(read.reason, /does not cover the study window/);
      }
      assert.equal(fake.calls.length, 0);
    }),
  );

  it.effect("refuses an explicitly named dataset that is not retained", () => {
    const fake = fixture();
    return Effect.gen(function* () {
      const read = yield* (yield* GraphResearchService).loadStudyDataset({
        ...input,
        datasetId: "ds_missing",
      });
      assert.equal(read.status, "unavailable");
      if (read.status === "unavailable") {
        assert.match(read.reason, /dataset ds_missing is not retained/);
      }
      assert.equal(fake.calls.length, 0);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("auto-reuses a covering fresh-enough retained row without fetching", () =>
    Effect.gen(function* () {
      const seed = yield* acquireSeed();
      const fake = fixture({ rows: [seed.row] });
      const read = yield* Effect.gen(function* () {
        return yield* (yield* GraphResearchService).loadStudyDataset(input);
      }).pipe(Effect.provide(fake.layer));
      assert.equal(read.status, "ok");
      assert.equal(fake.calls.length, 0);
      if (read.status !== "ok") return;
      assert.equal(read.dataset.reused, true);
      assert.equal(read.dataset.manifest.id, seed.manifest.id);
      assert.deepEqual(read.dataset.observations, seed.row.observations);
    }),
  );

  it.effect("skips a too-recent retained row and acquires fresh instead", () =>
    Effect.gen(function* () {
      // Captured 60s after the window ends: below the 1h reuse freshness.
      const seed = yield* acquireSeed({ fetchedAtMs: START + 2 * HOUR + 60_000 });
      const fake = fixture({ rows: [seed.row] });
      const read = yield* Effect.gen(function* () {
        return yield* (yield* GraphResearchService).loadStudyDataset(input);
      }).pipe(Effect.provide(fake.layer));
      assert.equal(read.status, "ok");
      assert.ok(fake.calls.length >= 1, "a stale-in-time row must not prevent a fresh capture");
      if (read.status !== "ok") return;
      assert.equal(read.dataset.reused, false);
      assert.equal(read.dataset.manifest.status, "complete");
    }),
  );

  it.effect("ignores retained rows that are not research datasets", () =>
    Effect.gen(function* () {
      const seed = yield* acquireSeed();
      const other: RetainedRow = {
        ...seed.row,
        record: { ...seed.row.record, evidenceId: "fsrc_heartbeat" },
      };
      const fake = fixture({ rows: [other] });
      const read = yield* Effect.gen(function* () {
        return yield* (yield* GraphResearchService).loadStudyDataset(input);
      }).pipe(Effect.provide(fake.layer));
      assert.equal(read.status, "ok");
      assert.ok(fake.calls.length >= 1);
      if (read.status !== "ok") return;
      assert.equal(read.dataset.reused, false);
    }),
  );
});
