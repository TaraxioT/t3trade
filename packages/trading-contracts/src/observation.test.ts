import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { DERIVED_METRIC_CATALOG } from "./watch.ts";
import {
  FORGE_CAPABILITY_ID_PATTERN,
  FORGE_EXECUTION_QUOTE_V3_FIELDS,
  FORGE_SDK_SCHEMA_VERSION,
  ForgeAcceptanceCase,
  ForgeBuildReceipt,
  ForgeCapabilityCatalogEntry,
  ForgeCapabilityManifest,
  ForgeCapabilityVersion,
  ForgeDetectorResultSummary,
  ForgeEvaluationEvidence,
  ForgePolicyBinding,
  ForgePoolProposal,
  ForgeSignalReading,
  nearestTradingLookKey,
  parseTradingLookFetchKey,
  renderTradingLookMenu,
  TRADING_LOOK_CATALOG,
  TRADING_LOOK_INTERVALS,
  TRADING_LOOK_MAX_ARCHIVE_ROWS,
  TRADING_LOOK_MAX_BARS,
  TRADING_LOOK_MAX_EVENTS,
  TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS,
  TradingForgeInput,
  TradingForgeResult,
  TradingLookInput,
  TradingObservation,
} from "./observation.ts";

/**
 * Plan 38 §2 — the data menu. The published size is the contract: the model
 * budgets its own context off the catalog, so the catalog must be complete
 * and the menu must stay a small blob.
 */
describe("the fetch catalog", () => {
  it("holds the 29 published keys, in order, at their published sizes", () => {
    assert.deepStrictEqual(
      TRADING_LOOK_CATALOG.map((entry) => [entry.key, entry.chars]),
      [
        ["snapshot", 454],
        ["book", 130],
        ["book_full", 898],
        ["microstructure", 599],
        ["candles", 38],
        ["indicators", 63],
        ["volatility", 677],
        ["volatility_htf", 680],
        ["structure", 4375],
        ["structure_brief", 640],
        ["funding_stats", 140],
        ["funding_series", 52],
        ["oi_premium", 100],
        ["book_history", 89],
        ["scan", 550],
        ["levels", 1136],
        ["position", 180],
        ["position_costs", 900],
        ["orders", 46],
        ["account", 248],
        ["plan", 1258],
        ["watches", 2860],
        ["events", 90],
        ["journal", 1219],
        ["trades", 1173],
        ["calibration", 1047],
        ["plan_history", 3342],
        // Not in the plan's §2.2 table; §4.2's nothing-deleted invariant keeps
        // the market scope's cost line reachable.
        ["cost", 101],
        // F2: the Forge capability discovery key. The KEY is static; which
        // capabilities it lists comes from the store at runtime, so no
        // detector is ever hardcoded into this catalog.
        ["forge", 140],
      ],
    );
  });

  it("marks exactly the five archive-backed keys", () => {
    assert.deepStrictEqual(
      TRADING_LOOK_CATALOG.filter((entry) => entry.archive === true).map((entry) => entry.key),
      ["funding_stats", "funding_series", "oi_premium", "book_history", "scan"],
    );
  });
});

describe("renderTradingLookMenu", () => {
  const menu = renderTradingLookMenu();

  // Plan 38 phase 3: the menu grew the derived-metric catalog (§3.3), one
  // line per metric rendered from `DERIVED_METRIC_CATALOG`. Measured 1,252
  // chars then; R3's scan key, its legend clause, and the thirteenth metric
  // (`vwap_distance`) measure 1,368; the grammar-and-caps suffixes on the
  // parameterized entries (the discoverability repair: one catalog call must
  // suffice to compose a legal key) measure 1,429. The band keeps a
  // deliberate ceiling — the handler test pins the same 1,500 — so another
  // key's worth of prose has to say so here.
  it("stays in the 1,250–1,500 band, targeted at ~1,430", () => {
    assert.isTrue(menu.length >= 1_250 && menu.length <= 1_500, `menu is ${menu.length} chars`);
  });

  // Grammar and caps ride the parameterized entries, composed from the same
  // constants `parseTradingLookFetchKey` refuses by. This is the "one catalog
  // call suffices" property: a model holding the menu can compose a legal key
  // without a refused call teaching it the shape first.
  it("states each parameterized key's grammar and cap from the parser's constants", () => {
    assert.include(
      menu,
      `candles:tf:n[${TRADING_LOOK_INTERVALS.join("|")};n≤${TRADING_LOOK_MAX_BARS}]`,
    );
    assert.include(menu, `funding_stats:W[days 1-${TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS}]`);
    for (const key of ["funding_series", "oi_premium", "book_history"]) {
      assert.include(menu, `${key}:n[1-${TRADING_LOOK_MAX_ARCHIVE_ROWS}]`);
    }
    assert.include(menu, `events:n[1-${TRADING_LOOK_MAX_EVENTS}]`);
  });

  // The interval list the menu prints is exactly the set the parser accepts:
  // every advertised interval parses, a non-member (`4h`, the invalid call
  // this repair targets) refuses with the same list, and both surfaces quote
  // one constant so they cannot drift.
  it("advertises exactly the candle intervals the parser accepts", () => {
    for (const tf of TRADING_LOOK_INTERVALS) {
      assert.equal(parseTradingLookFetchKey(`candles:${tf}:10`).base, "candles");
    }
    const refused = parseTradingLookFetchKey("candles:4h:10");
    assert.equal(refused.base, "invalid_params");
    if (refused.base === "invalid_params") {
      assert.include(refused.bound, TRADING_LOOK_INTERVALS.join(","));
    }
  });

  it("presents scan as cross-market context, never market selection", () => {
    assert.include(menu, "scan: cross-market context, never market selection");
  });

  it("prices every key and stars the archive keys", () => {
    for (const entry of TRADING_LOOK_CATALOG) {
      assert.include(menu, `${entry.key}`);
    }
    assert.include(menu, "*");
    // The legend must tell the model an archive miss is not data.
    assert.include(menu, "unavailable");
  });

  it("names indicators as the cheaper alternative to candles", () => {
    assert.include(menu, "indicators");
    assert.include(menu, "cheaper");
  });

  it("lists every derived metric the watch kind can arm (plan 38 §3.3)", () => {
    for (const metric of DERIVED_METRIC_CATALOG) {
      assert.include(menu, `derived:${metric.metric} `);
    }
  });
});

describe("parseTradingLookFetchKey", () => {
  it("parses every valid shape", () => {
    assert.deepStrictEqual(parseTradingLookFetchKey("snapshot"), { base: "snapshot" });
    assert.deepStrictEqual(parseTradingLookFetchKey("cost"), { base: "cost" });
    assert.deepStrictEqual(parseTradingLookFetchKey("candles:5m:20"), {
      base: "candles",
      interval: "5m",
      n: 20,
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("candles:1h:0"), {
      base: "candles",
      interval: "1h",
      n: 0,
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("indicators:ema20"), {
      base: "indicators",
      spec: "ema20",
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("funding_stats:7"), {
      base: "funding_stats",
      windowDays: 7,
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("funding_series:24"), {
      base: "funding_series",
      n: 24,
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("oi_premium:50"), {
      base: "oi_premium",
      n: 50,
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("book_history:10"), {
      base: "book_history",
      n: 10,
    });
  });

  it("refuses out-of-bound parameters with the cap named", () => {
    const bound = (parsed: ReturnType<typeof parseTradingLookFetchKey>) =>
      parsed.base === "invalid_params" ? parsed.bound : "";

    const candles = parseTradingLookFetchKey(`candles:5m:${TRADING_LOOK_MAX_BARS + 1}`);
    assert.equal(candles.base, "invalid_params");
    assert.include(bound(candles), String(TRADING_LOOK_MAX_BARS));

    const interval = parseTradingLookFetchKey("candles:2h:20");
    assert.equal(interval.base, "invalid_params");
    assert.include(bound(interval), "1m");

    const window = parseTradingLookFetchKey(
      `funding_stats:${TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS + 1}`,
    );
    assert.equal(window.base, "invalid_params");
    assert.include(bound(window), String(TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS));

    for (const key of [
      `funding_series:${TRADING_LOOK_MAX_ARCHIVE_ROWS + 1}`,
      `oi_premium:${TRADING_LOOK_MAX_ARCHIVE_ROWS + 1}`,
      `book_history:${TRADING_LOOK_MAX_ARCHIVE_ROWS + 1}`,
    ]) {
      const parsed = parseTradingLookFetchKey(key);
      assert.equal(parsed.base, "invalid_params");
      assert.include(bound(parsed), String(TRADING_LOOK_MAX_ARCHIVE_ROWS));
    }
  });

  it("reports unknown keys as unknown, never silently", () => {
    assert.deepStrictEqual(parseTradingLookFetchKey("nonexistent"), {
      base: "unknown",
      key: "nonexistent",
    });
  });
});

describe("nearestTradingLookKey", () => {
  it("maps a typo to the catalog base it normalizes to", () => {
    assert.equal(nearestTradingLookKey("candle"), "candles");
    assert.equal(nearestTradingLookKey("book_ful"), "book_full");
    assert.equal(nearestTradingLookKey("fundingstat"), "funding_stats");
  });

  it("maps exact keys to themselves", () => {
    for (const entry of TRADING_LOOK_CATALOG) {
      assert.equal(nearestTradingLookKey(entry.key), entry.key);
    }
  });
});

describe("the fetch parameter", () => {
  const decodeLook = Schema.decodeUnknownSync(TradingLookInput);

  it("accepts arbitrary strings — unknown keys are the handler's to refuse by name", () => {
    // Not an enum on purpose (plan 38 §2.3 rule 4): a schema rejection cannot
    // name the nearest valid key, and reads to the model as "nothing here".
    const decoded = decodeLook({ fetch: ["candles:5m:20", "not_a_key"] });
    assert.deepStrictEqual(decoded.fetch, ["candles:5m:20", "not_a_key"]);
  });
});

// -- F2: the Forge capability lifecycle contracts ---------------------------------

describe("the forge fetch key", () => {
  it("parses catalog, latest and history selections", () => {
    assert.deepStrictEqual(parseTradingLookFetchKey("forge"), {
      base: "forge",
      selection: "catalog",
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("forge:wash-detector"), {
      base: "forge",
      capabilityId: "wash-detector",
      selection: "latest",
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("forge:wash-detector:history"), {
      base: "forge",
      capabilityId: "wash-detector",
      selection: "history",
    });
  });

  it("refuses malformed capability ids and suffixes with the grammar named", () => {
    for (const key of ["forge:../escape", "forge:UPPER", "forge:a b", "forge:id:latest"]) {
      const parsed = parseTradingLookFetchKey(key);
      assert.equal(parsed.base, "invalid_params", key);
    }
    const traversal = parseTradingLookFetchKey("forge:../escape");
    if (traversal.base === "invalid_params") {
      assert.include(traversal.bound, "capabilityId must match");
    }
  });

  it("states its grammar in the menu from the parser's own bound", () => {
    const menu = renderTradingLookMenu();
    assert.include(menu, "forge:id[:history]");
  });

  it("maps a typo to the forge base", () => {
    assert.equal(nearestTradingLookKey("forg"), "forge");
  });
});

describe("ForgeCapabilityManifest", () => {
  const decode = Schema.decodeUnknownSync(ForgeCapabilityManifest);

  it("accepts the F2 schema version", () => {
    const decoded = decode({
      capabilityId: "wash-detector",
      version: 1,
      schemaVersion: FORGE_SDK_SCHEMA_VERSION,
      description: "flag coordinated wash trading across the approved pools",
    });
    assert.equal(decoded.capabilityId, "wash-detector");
  });

  it("refuses a foreign schema version — no silent cross-generation install", () => {
    assert.throws(() =>
      decode({
        capabilityId: "wash-detector",
        version: 1,
        schemaVersion: FORGE_SDK_SCHEMA_VERSION + 1,
        description: "x",
      }),
    );
  });

  it("refuses ids the store could not key safely", () => {
    assert.throws(() =>
      decode({
        capabilityId: "../escape",
        version: 1,
        schemaVersion: FORGE_SDK_SCHEMA_VERSION,
        description: "x",
      }),
    );
    assert.isTrue(FORGE_CAPABILITY_ID_PATTERN.test("a"));
    assert.isFalse(FORGE_CAPABILITY_ID_PATTERN.test("../escape"));
  });
});

describe("ForgeSignalReading", () => {
  const decode = Schema.decodeUnknownSync(ForgeSignalReading);

  it("accepts both readings", () => {
    const ready = decode({
      kind: "ready",
      regime: "coordinated",
      agreement: 1,
      eligiblePoolIds: ["p1"],
    });
    assert.equal(ready.kind, "ready");
    const insufficient = decode({ kind: "insufficient", reason: "no anchor" });
    assert.equal(insufficient.kind, "insufficient");
  });

  it("bounds agreement to 0..1 — an invented fraction is not a reading", () => {
    assert.throws(() =>
      decode({ kind: "ready", regime: "quiet", agreement: 1.5, eligiblePoolIds: [] }),
    );
    assert.throws(() =>
      decode({ kind: "ready", regime: "quiet", agreement: -0.1, eligiblePoolIds: [] }),
    );
  });
});

describe("the forge lifecycle records", () => {
  it("decodes a build receipt with its stage trail", () => {
    const receipt = Schema.decodeUnknownSync(ForgeBuildReceipt)({
      buildId: "fb_1",
      environmentId: "env_1",
      threadId: "th_1",
      requestedSemantics: "detect coordinated wash trading",
      stage: "ready",
      stages: [
        { stage: "requested", atMs: 1_000 },
        { stage: "ready", atMs: 2_000 },
      ],
      checks: [{ name: "generated-tests", passed: true, exitCode: 0 }],
      acceptance: { total: 2, passed: 2, failed: [] },
      artifactSha256: [{ path: "signal.ts", sha256: "ab".repeat(32) }],
      bundleSha256: "cd".repeat(32),
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
    });
    assert.equal(receipt.stage, "ready");
    assert.equal(receipt.checks?.length, 1);
  });

  it("decodes a capability version with immutable identity", () => {
    const version = Schema.decodeUnknownSync(ForgeCapabilityVersion)({
      capabilityId: "wash-detector",
      version: 1,
      bundleSha256: "cd".repeat(32),
      artifacts: [{ path: "signal.ts", sha256: "ab".repeat(32), bytes: 100 }],
      manifest: {
        capabilityId: "wash-detector",
        version: 1,
        schemaVersion: FORGE_SDK_SCHEMA_VERSION,
        description: "d",
      },
      createdAtMs: 1_000,
    });
    assert.equal(version.version, 1);
    assert.equal(version.artifacts.length, 1);
  });

  it("decodes evaluation evidence, catalog entries, proposals and policy bindings", () => {
    const evaluation = Schema.decodeUnknownSync(ForgeEvaluationEvidence)({
      evaluationId: "fe_1",
      environmentId: "env_1",
      capabilityId: "wash-detector",
      capabilityVersion: 1,
      bundleSha256: "cd".repeat(32),
      window: { startedAt: 0, endedAt: 60_000 },
      historical: false,
      evidenceIds: ["forge_ev_1"],
      status: "complete",
      reading: { kind: "ready", regime: "isolated", agreement: 1, eligiblePoolIds: ["p1"] },
      createdAtMs: 1_000,
      completedAtMs: 1_500,
    });
    assert.equal(evaluation.status, "complete");

    const entry = Schema.decodeUnknownSync(ForgeCapabilityCatalogEntry)({
      capabilityId: "wash-detector",
      version: 1,
      bundleSha256: "cd".repeat(32),
      description: "d",
      status: "installed",
      installedAtMs: 2_000,
    });
    assert.equal(entry.status, "installed");

    const proposal = Schema.decodeUnknownSync(ForgePoolProposal)({
      proposalId: "fp_1",
      environmentId: "env_1",
      poolId: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      status: "proposed",
      proposedAtMs: 1_000,
    });
    assert.equal(proposal.status, "proposed");

    const policy = Schema.decodeUnknownSync(ForgePolicyBinding)({
      policyId: "fpol_1",
      environmentId: "env_1",
      capabilityId: "wash-detector",
      capabilityVersion: 1,
      bundleSha256: "cd".repeat(32),
      poolId: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      detectionFeeHundredthsBps: 500,
      status: "draft",
      createdAtMs: 1_000,
    });
    assert.equal(policy.status, "draft");
  });

  it("decodes an acceptance case as data — expectations travel in the request", () => {
    const example = Schema.decodeUnknownSync(ForgeAcceptanceCase)({
      name: "two same-sign moving pools",
      input: {
        evidence: {
          mode: "live",
          provider: "the-graph",
          deploymentId: "dep",
          blockNumber: "100",
          blockHash: "0x" + "ab".repeat(32),
          fetchedAtMs: 1_000,
          windowEndMs: 900,
          querySha256: "q",
          responseSha256: "r",
          complete: true,
        },
        pools: [
          {
            poolId: "p1",
            moveBps: 40,
            quoteVolumeMicros: "1000000",
            tradeCount: 2,
            observationIds: ["a:1", "a:2"],
          },
        ],
      },
      expected: {
        kind: "ready",
        regime: "coordinated",
        agreement: 1,
        eligiblePoolIds: ["p1", "p2"],
      },
    });
    assert.equal(example.input.pools.length, 1);
  });
});

describe("TradingForgeInput", () => {
  const decode = Schema.decodeUnknownSync(TradingForgeInput);

  it("takes every lifecycle action and an optional missionId", () => {
    for (const action of [
      "inspect_sources",
      "prepare",
      "check",
      "install",
      "revise",
      "status",
      "cancel",
      "pause",
      "resume",
      "uninstall",
      "arm",
      "disarm",
      "evaluate",
      "propose_pool",
      "approve_pool",
      "bind_policy",
      "revoke_policy",
      "quote",
      "propose_envelope",
      "approve_envelope",
      "envelope",
      "evaluate_policy",
      "swap",
    ] as const) {
      const decoded = decode({ action });
      assert.equal(decoded.action, action);
    }
    const withMission = decode({ action: "status", missionId: "tm_1" });
    assert.equal(withMission.missionId, "tm_1");
  });

  it("refuses capability ids outside the store's key grammar", () => {
    assert.throws(() => decode({ action: "install", capabilityId: "../escape" }));
    assert.throws(() => decode({ action: "install", capabilityId: "UP" }));
  });
});

// -- P4: the detector-program (v2) additive fields ---------------------------------

describe("the forge detector (v2) additive contracts", () => {
  it("summarizes the three DetectionResult shapes with bounded fields", () => {
    const decode = Schema.decodeUnknownSync(ForgeDetectorResultSummary);
    assert.deepStrictEqual(
      decode({ status: "matched", occurrenceKey: "occ_1", validUntilMs: 9_000 }),
      { status: "matched", occurrenceKey: "occ_1", validUntilMs: 9_000 },
    );
    assert.deepStrictEqual(decode({ status: "not-matched", explanation: "flag not set" }), {
      status: "not-matched",
      explanation: "flag not set",
    });
    assert.deepStrictEqual(decode({ status: "unknown", explanation: "source lagging" }), {
      status: "unknown",
      explanation: "source lagging",
    });
    // The mirror is bounded on purpose: the full result's fact/evidence
    // arrays are not look payload.
    assert.throws(() => decode({ status: "matched", occurrenceKey: "occ_1" }));
    assert.throws(() => decode({ status: "unknown" }));
  });

  it("decodes the forge look struct unchanged without the v2 fields, and with them", () => {
    const decode = Schema.decodeUnknownSync(TradingObservation);
    const base = {
      observedAt: 1_000,
      market: "ETH",
      // A pre-v2 payload: only catalog/latest/history. Additive optionality
      // means this decodes byte-identically after the v2 fields exist.
      forge: {
        catalog: [],
      },
    };
    const legacy = decode(base);
    assert.deepStrictEqual(legacy.forge?.catalog, []);
    assert.isUndefined(legacy.forge?.armed);
    assert.isUndefined(legacy.forge?.detectorStateRevision);
    assert.isUndefined(legacy.forge?.latestDetectorResult);

    const v2 = decode({
      ...base,
      forge: {
        catalog: [],
        armed: true,
        detectorStateRevision: 3,
        latestDetectorResult: { status: "matched", occurrenceKey: "occ_1", validUntilMs: 9_000 },
      },
    });
    assert.equal(v2.forge?.armed, true);
    assert.equal(v2.forge?.detectorStateRevision, 3);
    assert.equal(v2.forge?.latestDetectorResult?.status, "matched");
  });

  it("carries the detector standing and committed run view on the forge result", () => {
    const decode = Schema.decodeUnknownSync(TradingForgeResult);
    const decoded = decode({
      outcome: "accepted",
      action: "status",
      detector: {
        programKind: 2,
        armed: true,
        stateRevision: 2,
        lastEvaluationId: "dtev_fixture",
        latestResult: {
          result: { status: "unknown", explanation: "window incomplete" },
          asOfMs: 1_700_000_000_000,
        },
      },
    });
    assert.equal(decoded.detector?.programKind, 2);
    assert.equal(decoded.detector?.stateRevision, 2);
    assert.equal(decoded.detector?.latestResult?.result.status, "unknown");
    // The v2 view's absence is named, never invented.
    const unavailable = decode({
      outcome: "accepted",
      action: "status",
      detector: { programKind: 2, armed: false, unavailable: "store unwired" },
    });
    assert.equal(unavailable.detector?.unavailable, "store unwired");
  });
});

// -- P5.4: the execution-action additive contracts ---------------------------------

describe("the forge execution actions (P5.4 additive)", () => {
  const decodeInput = Schema.decodeUnknownSync(TradingForgeInput);
  const decodeResult = Schema.decodeUnknownSync(TradingForgeResult);

  it("carries the execution input fields; the envelope and quote ride as unknown JSON", () => {
    const decoded = decodeInput({
      action: "swap",
      routeId: "weth-usdc-500",
      amountInRaw: "1000000",
      maxSlippageBps: 30,
      envelopeId: "env_1",
      proposalId: "pprop_1",
      envelope: { revision: 1 },
      quote: { quoteId: "sq_1" },
    });
    assert.equal(decoded.action, "swap");
    assert.equal(decoded.routeId, "weth-usdc-500");
    assert.equal(decoded.amountInRaw, "1000000");
    assert.equal(decoded.maxSlippageBps, 30);
    assert.equal(decoded.envelopeId, "env_1");
    assert.equal(decoded.proposalId, "pprop_1");
    // Unknown-carried JSON passes through verbatim for the server-side
    // strict decode; an empty routeId still refuses.
    assert.deepEqual(decoded.envelope, { revision: 1 });
    assert.deepEqual(decoded.quote, { quoteId: "sq_1" });
    assert.throws(() => decodeInput({ action: "quote", routeId: "" }));
    assert.throws(() => decodeInput({ action: "quote", maxSlippageBps: -1 }));
  });

  it("decodes the protected_swap input and the v3 quote identity fields", () => {
    // The protected lane's only agent-reachable action: admission inputs.
    const decoded = decodeInput({
      action: "protected_swap",
      proposalId: "pprop_1",
      deadlineUnix: 1_789_000_000,
    });
    assert.equal(decoded.action, "protected_swap");
    assert.equal(decoded.deadlineUnix, 1_789_000_000);
    assert.throws(() => decodeInput({ action: "protected_swap", deadlineUnix: 0 }));

    // The v3 identity fields the mirror added beside SwapQuoteRecord: a
    // protected-lane record carries all nine; a retained v2-era record
    // decodes unchanged without them.
    const withIdentity = decodeResult({
      outcome: "accepted",
      action: "quote",
      quoteRecord: {
        quoteId: "sq_v3",
        chainId: "1",
        routeId: "ur-v3-usdc-weth-500",
        tokenIn: "0xaaa",
        tokenOut: "0xbbb",
        amountInRaw: "1000000",
        minAmountOutRaw: "900000",
        gasEstimateWei: "150000000000000",
        quotedAtMs: 1,
        expiresAtMs: 2,
        basis: "eth_call",
        routeConfigDigest: "a".repeat(64),
        quotedBlockNumber: "20000000",
        quotedBlockHash: "0xhash",
        quotedAmountOutRaw: "950000",
        quoterCodeHash: "b".repeat(64),
        targetCodeHash: "c".repeat(64),
        gasUnitsMeasured: "180000",
        maxFeePerGasWei: "30000000000",
        maxPriorityFeePerGasWei: "1000000000",
      },
      protectedAdmission: {
        reservationId: "res_1",
        intentId: "intent_1",
        replayed: false,
      },
    });
    assert.equal(withIdentity.quoteRecord?.routeConfigDigest, "a".repeat(64));
    assert.equal(withIdentity.quoteRecord?.quotedBlockNumber, "20000000");
    assert.equal(withIdentity.protectedAdmission?.reservationId, "res_1");
    assert.equal(withIdentity.protectedAdmission?.replayed, false);
    // Drift guard, not duplication: the mirror must name exactly the nine
    // v3 fields the authoritative SwapQuoteRecord declares.
    const mirrorFields = Object.keys(FORGE_EXECUTION_QUOTE_V3_FIELDS).sort();
    assert.deepEqual(mirrorFields, [
      "gasUnitsMeasured",
      "maxFeePerGasWei",
      "maxPriorityFeePerGasWei",
      "quotedAmountOutRaw",
      "quotedBlockHash",
      "quotedBlockNumber",
      "quoterCodeHash",
      "routeConfigDigest",
      "targetCodeHash",
    ]);
  });

  it("decodes a pre-P5.4 forge result unchanged, and the execution views when present", () => {
    // The old payload: no execution fields, byte-identical decode.
    const legacy = decodeResult({
      outcome: "accepted",
      action: "status",
      proposals: [],
    });
    assert.isUndefined(legacy.quoteRecord);
    assert.isUndefined(legacy.envelopeView);
    assert.isUndefined(legacy.policyEvaluation);
    assert.isUndefined(legacy.swapIntent);
    assert.isUndefined(legacy.envelopeId);

    const decoded = decodeResult({
      outcome: "accepted",
      action: "swap",
      envelopeId: "env_1",
      quoteRecord: {
        quoteId: "sq_1",
        chainId: "11155111",
        routeId: "weth-usdc-500",
        tokenIn: "0xaaa",
        tokenOut: "0xbbb",
        amountInRaw: "1000000",
        minAmountOutRaw: "900000",
        gasEstimateWei: "1",
        quotedAtMs: 1,
        expiresAtMs: 2,
        basis: "eth_call",
      },
      envelopeView: {
        envelope: {
          envelopeId: "env_1",
          environmentId: "env-1",
          revision: 1,
          status: "approved",
          expiresAtMs: 9_000,
          approvedVia: "local-operator",
          candidates: [
            {
              candidateId: "cand_1",
              chainId: "11155111",
              tokenIn: "0xaaa",
              tokenOut: "0xbbb",
              recipient: "0xccc",
            },
          ],
          inputCapTotalRaw: "1500000",
          inputCapPerSwapRaw: "2000000",
          remainingInputCapRaw: "1500000",
        },
        proposals: [
          {
            proposalId: "pprop_1",
            kind: "swap",
            status: "proposed",
            stageKey: "entry",
            amountInRaw: "1000000",
            proposedAtMs: 1_000,
          },
        ],
        intents: [
          {
            intentId: "sint_1",
            proposalId: "pprop_1",
            quoteId: "sq_1",
            routeId: "weth-usdc-500",
            tokenIn: "0xaaa",
            tokenOut: "0xbbb",
            amountInRaw: "1000000",
            minAmountOutRaw: "900000",
            status: "submit-refused",
            preparedAtMs: 2_000,
            attemptAtMs: 2_000,
            refusalReason: "broadcaster-missing: no signer",
          },
        ],
      },
      policyEvaluation: {
        status: "refused",
        refusal: "bundle-changed",
        detail: "hash differs",
      },
      swapIntent: {
        intentId: "sint_1",
        proposalId: "pprop_1",
        quoteId: "sq_1",
        routeId: "weth-usdc-500",
        tokenIn: "0xaaa",
        tokenOut: "0xbbb",
        amountInRaw: "1000000",
        minAmountOutRaw: "900000",
        status: "submit-refused",
        preparedAtMs: 2_000,
        refusalReason: "broadcaster-missing: no signer",
      },
    });
    assert.equal(decoded.quoteRecord?.basis, "eth_call");
    assert.equal(decoded.envelopeView?.envelope.remainingInputCapRaw, "1500000");
    assert.equal(decoded.envelopeView?.proposals[0]?.status, "proposed");
    assert.equal(decoded.envelopeView?.intents[0]?.refusalReason, "broadcaster-missing: no signer");
    assert.equal(decoded.policyEvaluation?.refusal, "bundle-changed");
    assert.equal(decoded.swapIntent?.status, "submit-refused");

    // Foreign statuses refuse: the view vocabularies are closed.
    assert.throws(() =>
      decodeResult({
        outcome: "accepted",
        action: "swap",
        swapIntent: {
          intentId: "sint_1",
          proposalId: "pprop_1",
          quoteId: "sq_1",
          routeId: "r",
          tokenIn: "0xaaa",
          tokenOut: "0xbbb",
          amountInRaw: "1",
          minAmountOutRaw: "1",
          status: "draft",
          preparedAtMs: 2_000,
        },
      }),
    );
  });
});
