/**
 * scenarioFixtures — the shared fixture vocabulary for the P7 two-scenario
 * generality proof (scenarioLaunch.test.ts / scenarioStablecoin.test.ts).
 *
 * Everything here is SYNTHETIC and labeled as such: fictional projects
 * ("atlas-labs/atlas", "usdx-labs/usdx"), fictional pools, fictional
 * documents, and fixture-authored detector/policy programs. Nothing reaches a
 * live source, a signer, an exchange, or a mainnet path. The container is the
 * scripted fake at the `ForgeContainerRunner` seam (the ForgeReactor.test.ts /
 * CapabilityBuilder.test.ts harness precedent); the fixture programs'
 * TypeScript genuinely compiles under the pinned runner flags inside the
 * scenario tests (see `compileScenarioPrograms`), so the faked typecheck step
 * is backed by a real compile-and-run.
 *
 * The generality proof itself lives in the two test files' imports: they use
 * ONLY the public service layers (connector, import service, event service,
 * graph research, builder, store, fact window, reactor, run store, policy
 * service) plus the seams those services already expose for tests. Adding a
 * scenario required NO core-engine edit — this file is new code, not a patch.
 *
 * @module scenarioFixtures
 */
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - temp workspaces and the tsc compile probe are node's own fs/path/child_process; the scripted container parses the sealed JSON stdin it was handed (the parse IS the fixture).
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as NodeFsSync from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { ForgeSwapObservation, MarketCandle } from "@t3tools/trading-contracts";
import { eventStudyReadWindow } from "@t3tools/trading-contracts/eventSets";

import { runMigrations } from "../../../persistence/Migrations.ts";
import {
  makeTradingEventService,
  TradingEventService,
  type TradingEventServiceShape,
} from "../../TradingEventService.ts";
import {
  ExternalSourceConfig,
  ExternalSourceConnector,
  ExternalSourceTransport,
  makeExternalSourceConnector,
  resolveExternalSourceSettings,
  type ExternalSourceHttpResponse,
  type ExternalSourceTransportShape,
} from "../../research/ExternalSourceConnector.ts";
import {
  makeExternalSourceStore,
  ExternalSourceStore,
  type ExternalSourceStoreShape,
} from "../../research/ExternalSourceStore.ts";
import {
  makeExternalEventImportService,
  ExternalEventImportService,
  type ExternalEventImportServiceShape,
} from "../../research/ExternalEventImportService.ts";
import {
  makeGraphResearchService,
  type GraphResearchServiceShape,
} from "../../research/GraphResearchService.ts";
import { ForgeGraphSource, FORGE_SWAPS_QUERY, type ForgeGraphSourceShape } from "../GraphSource.ts";
import {
  makeForgeSourceStore,
  ForgeSourceStore,
  type ForgeSourceStoreShape,
} from "../ForgeSourceStore.ts";
import {
  FORGE_RUNNER_EVALUATE_POLICY,
  ForgeCapabilitySandbox,
  ForgeContainerRunner,
  ForgeSandboxConfig,
  forgeSha256Hex,
  makeForgeCapabilitySandbox,
  type ForgeContainerRunnerShape,
} from "../CapabilitySandbox.ts";
import {
  FORGE_RUNNER_EVALUATE_V2,
  FORGE_RUNNER_TEST,
  FORGE_RUNNER_TYPECHECK,
  FORGE_SDK_SOURCE_V2,
  makeForgeCapabilityBuilder,
  type ForgeCapabilityBuilderShape,
} from "../CapabilityBuilder.ts";
import {
  ForgeCapabilityStore,
  ForgeCapabilityStoreConfig,
  ForgeCapabilityStoreLive,
  type ForgeCapabilityStoreShape,
} from "../CapabilityStore.ts";
import {
  ForgeSourceWindowProvider,
  makeForgeReactor,
  type ForgeReactorShape,
} from "../ForgeReactor.ts";
import {
  makeDetectorRunStore,
  DetectorRunStore,
  type DetectorRunStoreShape,
} from "../DetectorRunStore.ts";
import { makeDetectorFactWindow, DetectorFactWindow } from "../DetectorFactWindow.ts";
import {
  makeExecutionPolicyService,
  type ExecutionPolicyServiceShape,
} from "../ExecutionPolicyService.ts";

/** A digest-pinned fixture image ref — never pulled, the runner is faked. */
export const SCENARIO_IMAGE = "registry.local/forge-runner@sha256:" + "ab".repeat(32);

// The scenario clocks, as ms instants, shared by the authored test sources,
// the acceptance cases, and the scenario tests (all fictional 2026 dates).
export const LAUNCH_WINDOW_START_MS = Date.parse("2026-07-01T00:00:00Z");
export const LAUNCH_WINDOW_END_MS = Date.parse("2026-07-30T00:00:00Z");
export const LAUNCH_PUBLICATION_MS = Date.parse("2026-07-10T01:30:00Z");
export const DEPEG_WINDOW_START_MS = Date.parse("2026-08-20T00:00:00Z");
export const DEPEG_WINDOW_END_MS = Date.parse("2026-08-27T00:00:00Z");
export const DEPEG_PUBLICATION_MS = Date.parse("2026-08-24T12:00:00Z");

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// External transport (the one seam the connector's credential crosses)
// ---------------------------------------------------------------------------

/** One synthetic JSON page as the fake HTTP transport serves it. */
export const jsonResponse = (body: unknown): ExternalSourceHttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  bodyBytes: new TextEncoder().encode(JSON.stringify(body)),
});

/** The transport answer is state the scenario flips between captures. */
export interface FlipTransport extends ExternalSourceTransportShape {
  setPage(body: unknown): void;
}

export const flipTransport = (initialPage: unknown): FlipTransport => {
  let page = jsonResponse(initialPage);
  return {
    setPage: (body) => {
      page = jsonResponse(body);
    },
    get: () => Effect.succeed(page),
  };
};

// ---------------------------------------------------------------------------
// Synthetic retained Graph evidence
// ---------------------------------------------------------------------------

/** One synthetic mainnet-style swap observation (the GraphSource.test.ts shape). */
export const syntheticSwap = (input: {
  readonly seq: number;
  readonly timestamp: number;
  readonly poolId: `0x${string}`;
  readonly priceMicros: number;
  readonly volumeMicros: number;
}): ForgeSwapObservation => ({
  chain: "ethereum-mainnet",
  poolId: input.poolId,
  observationId: `0x${String(input.seq).padStart(4, "0").repeat(16)}:${input.seq}`,
  transactionHash: `0x${sha256Hex(`scenario-swap-${input.seq}`).slice(0, 64)}`,
  logIndex: input.seq,
  timestamp: input.timestamp,
  sender: `0x${"1a".repeat(20)}`,
  recipient: `0x${"2b".repeat(20)}`,
  amount0: String(input.volumeMicros),
  amount1: "-1000",
  sqrtPriceX96: "79228162514264337593543950336",
  tick: 0,
  baseIsToken1: true,
  priceQuotePerBase: { numerator: String(input.priceMicros), denominator: "1000000" },
  priceQuotePerBaseMicros: input.priceMicros,
  quoteVolumeRaw: String(input.volumeMicros),
  quoteVolumeMicros: input.volumeMicros,
});

/**
 * The study bounds GraphResearchService derives, mirrored from the public
 * `eventStudyReadWindow` plus the service's own grid alignment (the
 * GraphResearchService.test.ts `studyBounds` precedent). Instant occurrences:
 * start = end = the publication instant the import projects.
 */
export const studyBounds = (
  occurrenceEnds: ReadonlyArray<number>,
  input: {
    readonly intervalMs: number;
    readonly horizonBars: number;
    readonly now: number;
    readonly entryBasis: "first_closed_bar_after_event" | "first_bar_open_after_event";
  },
): { readonly fromMs: number; readonly toMs: number } => {
  const bounds = eventStudyReadWindow(
    occurrenceEnds.map((endAt) => ({ startAt: endAt, endAt, source: "synthetic" })),
    input,
  );
  const fromMs = Math.max(0, Math.ceil(bounds.fromT / input.intervalMs) * input.intervalMs);
  const toMs = Math.min(
    input.now,
    Math.floor(bounds.toT / input.intervalMs) * input.intervalMs + input.intervalMs,
  );
  return { fromMs, toMs };
};

/** The insert a dataset seed performs (resolved against the world's store). */
export type SeedDatasetInsert = Effect.Effect<void, never, ForgeSourceStore>;

/**
 * Mint one retained research dataset under GraphResearchService's own content
 * formula — the `ds_` id the real research service can REUSE by explicit
 * lineage and the detector fact window resolves by id. The caller runs the
 * returned insert against the scenario world's store.
 */
export const seedGraphDataset = (input: {
  readonly environmentId: string;
  readonly poolId: string;
  readonly deployment: string;
  readonly endpoint: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly fetchedAtMs: number;
  readonly observations: ReadonlyArray<ForgeSwapObservation>;
}): { readonly datasetId: string; readonly insert: SeedDatasetInsert } => {
  const contentSha256 = sha256Hex(JSON.stringify(input.observations));
  const variables = [
    {
      pool: input.poolId,
      first: 100,
      cursor: "",
      block: input.blockNumber,
      from: String(Math.floor(input.fromMs / 1000) - 300),
      to: String(Math.floor((input.toMs - 1) / 1000)),
    },
  ];
  const variablesSha256 = sha256Hex(JSON.stringify(variables));
  const datasetId = `ds_${sha256Hex(
    JSON.stringify({
      environmentId: input.environmentId,
      poolId: input.poolId,
      deployment: input.deployment,
      blockHash: input.blockHash,
      fromMs: input.fromMs,
      toMs: input.toMs,
      contentSha256,
      variablesSha256,
      capturedAtMs: input.fetchedAtMs,
    }),
  ).slice(0, 24)}`;
  return {
    datasetId,
    insert: Effect.flatMap(ForgeSourceStore, (store) =>
      Effect.orDie(
        store.insert({
          record: {
            evidenceId: datasetId,
            environmentId: input.environmentId,
            poolId: input.poolId,
            historical: true,
            endpoint: input.endpoint,
            deployment: input.deployment,
            pinnedBlock: input.blockNumber,
            pinnedBlockHash: input.blockHash,
            windowStart: Math.floor(input.fromMs / 1000),
            windowEnd: Math.floor((input.toMs - 1) / 1000),
            fetchedAtMs: input.fetchedAtMs,
            digest: contentSha256,
            observationCount: input.observations.length,
          },
          observations: input.observations,
          queryCapture: { query: FORGE_SWAPS_QUERY, variables },
        }),
      ),
    ),
  };
};

/**
 * The fake vetted Graph source for the research path: configured for the
 * synthetic pool, and every fetch REFUSES loudly — the study must serve the
 * retained dataset by explicit lineage, never fall through to a capture.
 */
export const reuseOnlyGraphSource = (input: {
  readonly poolId: `0x${string}`;
  readonly deployment: string;
  readonly latestBlock: number;
}): ForgeGraphSourceShape =>
  ForgeGraphSource.of({
    settings: Effect.succeed({
      configured: true,
      source: {
        kind: "uniswap-v3-graph",
        endpoint: "https://graph.example.test",
        deployment: input.deployment,
        indexingEndpoint: "https://indexing.example.test",
        maxLagBlocks: 6,
        pageSize: 100,
        maxSwapsPerFetch: 500,
        pools: [
          {
            chain: "ethereum-mainnet",
            poolId: input.poolId,
            feeTierHundredthsBps: 500,
            label: "USDC/WETH (synthetic)",
            baseIsToken1: true,
            token0: { address: `0x${"2".repeat(40)}`, symbol: "USDC", decimals: 6 },
            token1: { address: `0x${"3".repeat(40)}`, symbol: "WETH", decimals: 18 },
          },
        ],
      },
    }),
    probeHealth: Effect.sync(() => ({
      status: "healthy" as const,
      latestBlock: input.latestBlock,
      probedAtMs: 0,
    })),
    fetchWindow: () =>
      Effect.die("the scenario study must reuse the retained dataset, never fetch"),
    fetchAllPools: () => Effect.die("not used by the scenario"),
  });

/** Candle features for the surge assertion: per-bucket close/open/trades/volume. */
export const candleFeatures = (
  candles: ReadonlyArray<MarketCandle>,
): ReadonlyArray<{
  readonly open: number;
  readonly close: number;
  readonly trades: number;
  readonly volume: number;
}> =>
  candles.map((candle) => ({
    open: candle.open,
    close: candle.close,
    trades: candle.trades ?? 0,
    volume: candle.volume,
  }));

// ---------------------------------------------------------------------------
// Fixture-authored detector-program (v2) bundles
// ---------------------------------------------------------------------------

/** The manifest for a fixture bundle that declares a detector + tests + policy. */
export const detectorManifest = (input: {
  readonly capabilityId: string;
  readonly version: number;
  readonly semantics: string;
  readonly requiredSourceIds: ReadonlyArray<string>;
  readonly outputFactKeys: ReadonlyArray<string>;
  readonly detectorSource: string;
  readonly testSource: string;
  readonly policySource: string;
  readonly createdAtMs: number;
}): string =>
  JSON.stringify({
    manifestVersion: 2,
    capabilityId: input.capabilityId,
    version: input.version,
    semantics: input.semantics,
    requiredSourceIds: input.requiredSourceIds,
    outputFactKeys: input.outputFactKeys,
    artifacts: [
      { role: "sdk", path: "sdk.ts", sha256: forgeSha256Hex(FORGE_SDK_SOURCE_V2) },
      { role: "detector", path: "detector.ts", sha256: forgeSha256Hex(input.detectorSource) },
      { role: "acceptance", path: "detector.test.ts", sha256: forgeSha256Hex(input.testSource) },
      { role: "execution-policy", path: "policy.ts", sha256: forgeSha256Hex(input.policySource) },
    ],
    createdAtMs: input.createdAtMs,
  });

// -- Scenario A: the launch-surge detector and its two-stage policy ---------

/** The authored detector.ts for the launch scenario (compiles under the runner's tsc). */
export const launchDetectorSource = (input: {
  readonly datasetSourceId: string;
  readonly releaseSourceId: string;
}): string =>
  [
    'import type { CapturedFact, Detect, DetectorProgramInput, DetectorProgramOutput } from "./sdk";',
    "",
    "// Fixture-authored for the synthetic 'atlas launch' scenario (P7 generality",
    "// proof). Relation, deliberately different from the stablecoin scenario: an",
    "// ACTIVITY threshold. Matches when the retained launch-month dataset holds",
    "// more than LAUNCH_SURGE_MIN_OBSERVATIONS swaps AND the launch release",
    "// document is published with a dated instant inside the dataset's window.",
    "const LAUNCH_SURGE_MIN_OBSERVATIONS = 8;",
    `const REQUIRED_SOURCE_IDS: ReadonlyArray<string> = ["${input.datasetSourceId}", "${input.releaseSourceId}"];`,
    "",
    "const decimalFact = (facts: ReadonlyArray<CapturedFact>, key: string): number | null => {",
    "  const fact = facts.find((candidate) => candidate.key === key);",
    '  if (fact === undefined || fact.value.kind !== "decimal") return null;',
    "  const parsed = Number(fact.value.value);",
    "  return Number.isFinite(parsed) ? parsed : null;",
    "};",
    "",
    "export const detect: Detect = (input: DetectorProgramInput): DetectorProgramOutput => {",
    "  const prior = input.priorState as { state?: { runs?: number } } | null | undefined;",
    "  const nextState = { stateSchemaVersion: 1, state: { runs: (prior?.state?.runs ?? 0) + 1 } };",
    "  const missing = REQUIRED_SOURCE_IDS.filter(",
    "    (id) => !input.sources.some((source) => source.sourceId === id),",
    "  );",
    "  if (missing.length > 0)",
    '    return { result: { status: "unknown", missingSourceIds: missing, explanation: "a required source is absent from the sealed window" }, nextState };',
    "  const evidenceIds = input.sources.map((source) => source.evidenceId);",
    '  const count = decimalFact(input.facts, "graph.pool.observation-count");',
    "  const published = input.facts.some(",
    '    (fact) => fact.key === "external.document.published" && fact.value.kind === "boolean" && fact.value.value,',
    "  );",
    '  const publicationMs = decimalFact(input.facts, "external.document.publication-ms");',
    "  if (!published || publicationMs === null)",
    '    return { result: { status: "not-matched", evidenceIds, explanation: "the launch release carries no dated publication instant" }, nextState };',
    '  const windowStartMs = decimalFact(input.facts, "graph.pool.trade-window-start-ms");',
    '  const windowEndMs = decimalFact(input.facts, "graph.pool.trade-window-end-ms");',
    "  if (count === null || windowStartMs === null || windowEndMs === null)",
    '    return { result: { status: "not-matched", evidenceIds, explanation: "the dataset facts are incomplete" }, nextState };',
    "  if (count <= LAUNCH_SURGE_MIN_OBSERVATIONS)",
    '    return { result: { status: "not-matched", evidenceIds, explanation: `observation count ${count} does not exceed ${LAUNCH_SURGE_MIN_OBSERVATIONS}` }, nextState };',
    "  if (publicationMs < windowStartMs || publicationMs > windowEndMs)",
    '    return { result: { status: "not-matched", evidenceIds, explanation: "the launch release falls outside the dataset window" }, nextState };',
    "  return {",
    "    result: {",
    '      status: "matched",',
    "      occurrenceKey: `launch-surge:${publicationMs}`,",
    "      evidenceIds,",
    "      facts: input.facts,",
    "      validUntilMs: input.asOfMs + 3_600_000,",
    "    },",
    "    nextState,",
    "  };",
    "};",
  ].join("\n");

/** The authored policy.ts for the launch scenario: the P5.3 two-stage pattern. */
export const launchPolicySource = [
  'import type { DetectorStateEnvelope, PolicyInput, PolicyOutput, Propose } from "./sdk";',
  "",
  "// Fixture-authored for the synthetic 'atlas launch' scenario (P7 generality",
  '// proof): the P5.3 two-stage pattern. Stage "entry" swaps on the FIRST',
  "// matched evaluation; a re-run of the SAME evaluation re-emits the identical",
  "// swap (the host collapses it onto the existing stage, never double-proposing);",
  '// a NEW matched evaluation proposes stage "exit". Changing evidence changes',
  "// the proposal; nothing here signs or spends.",
  "export const propose: Propose = (input: PolicyInput): PolicyOutput => {",
  "  const envelope = input.priorState as DetectorStateEnvelope | null | undefined;",
  "  const prior = (envelope === null || envelope === undefined ? {} : envelope.state) as {",
  "    entryFor?: string;",
  "    runs?: number;",
  "  };",
  "  const runs = (prior.runs ?? 0) + 1;",
  "  const carry = { ...prior, runs };",
  "  const evaluation = input.detectorEvaluation;",
  "  const result = evaluation.result;",
  '  if (result.status !== "matched")',
  '    return { proposal: { kind: "wait" }, nextState: { stateSchemaVersion: 1, state: carry } };',
  "  const candidate = input.envelope.candidates[0];",
  "  if (candidate === undefined)",
  '    return { proposal: { kind: "wait" }, nextState: { stateSchemaVersion: 1, state: carry } };',
  '  const hasEntry = input.priorProposals.some((proposal) => proposal.stageKey === "entry");',
  "  const swap = (stageKey: string) => ({",
  '    kind: "swap" as const,',
  "    candidateId: candidate.candidateId,",
  '    amountInRaw: "1000000",',
  '    quoteId: "sq_scenario_fixture",',
  "    occurrenceKey: result.occurrenceKey,",
  "    stageKey,",
  "    detectorEvaluationId: evaluation.evaluationId,",
  "  });",
  "  if (!hasEntry)",
  "    return {",
  '      proposal: swap("entry"),',
  "      nextState: { stateSchemaVersion: 1, state: { ...carry, entryFor: evaluation.evaluationId } },",
  "    };",
  "  if (prior.entryFor === evaluation.evaluationId)",
  '    return { proposal: swap("entry"), nextState: { stateSchemaVersion: 1, state: carry } };',
  "  return {",
  '    proposal: swap("exit"),',
  "    nextState: {",
  "      stateSchemaVersion: 1,",
  "      state: { ...carry, entryFor: prior.entryFor, exitFor: evaluation.evaluationId },",
  "    },",
  "  };",
  "};",
].join("\n");

// -- Scenario B: the depeg detector and its single-stage policy -------------

/** The authored detector.ts for the stablecoin scenario. */
export const depegDetectorSource = (input: {
  readonly datasetSourceId: string;
  readonly attestationSourceId: string;
}): string =>
  [
    'import type { CapturedFact, Detect, DetectorProgramInput, DetectorProgramOutput } from "./sdk";',
    "",
    "// Fixture-authored for the synthetic 'USDX stablecoin report' scenario (P7",
    "// generality proof). Materially different relation from the launch detector:",
    "// no activity threshold — the dataset's LAST PRICE is judged against the",
    "// stablecoin peg. The bounded fact vocabulary exposes one price per dataset",
    "// (graph.pool.last-price-micros), so 'moved down beyond a threshold' is",
    "// evaluated against the 1.000000 peg in micros, and the dataset's window",
    "// bounds participate through the attestation-containment check.",
    "const DEPEG_MAX_MICROS = 970_000;",
    `const REQUIRED_SOURCE_IDS: ReadonlyArray<string> = ["${input.datasetSourceId}", "${input.attestationSourceId}"];`,
    "",
    "const decimalFact = (facts: ReadonlyArray<CapturedFact>, key: string): number | null => {",
    "  const fact = facts.find((candidate) => candidate.key === key);",
    '  if (fact === undefined || fact.value.kind !== "decimal") return null;',
    "  const parsed = Number(fact.value.value);",
    "  return Number.isFinite(parsed) ? parsed : null;",
    "};",
    "",
    "export const detect: Detect = (input: DetectorProgramInput): DetectorProgramOutput => {",
    "  const prior = input.priorState as",
    "    | { state?: { runs?: number; lastPriceMicros?: number } }",
    "    | null",
    "    | undefined;",
    "  const lastSeen = prior?.state?.lastPriceMicros;",
    "  const nextState = {",
    "    stateSchemaVersion: 1,",
    "    state: {",
    "      runs: (prior?.state?.runs ?? 0) + 1,",
    "      ...(lastSeen === undefined ? {} : { lastPriceMicros: lastSeen }),",
    "    },",
    "  };",
    "  const missing = REQUIRED_SOURCE_IDS.filter(",
    "    (id) => !input.sources.some((source) => source.sourceId === id),",
    "  );",
    "  if (missing.length > 0)",
    '    return { result: { status: "unknown", missingSourceIds: missing, explanation: "a required source is absent from the sealed window" }, nextState };',
    "  const evidenceIds = input.sources.map((source) => source.evidenceId);",
    "  const published = input.facts.some(",
    '    (fact) => fact.key === "external.document.published" && fact.value.kind === "boolean" && fact.value.value,',
    "  );",
    '  const publicationMs = decimalFact(input.facts, "external.document.publication-ms");',
    "  if (!published || publicationMs === null)",
    '    return { result: { status: "not-matched", evidenceIds, explanation: "the attestation carries no dated publication instant" }, nextState };',
    '  const lastPriceMicros = decimalFact(input.facts, "graph.pool.last-price-micros");',
    '  const windowStartMs = decimalFact(input.facts, "graph.pool.trade-window-start-ms");',
    '  const windowEndMs = decimalFact(input.facts, "graph.pool.trade-window-end-ms");',
    "  if (lastPriceMicros === null || windowStartMs === null || windowEndMs === null)",
    '    return { result: { status: "not-matched", evidenceIds, explanation: "the dataset facts are incomplete" }, nextState };',
    "  if (lastPriceMicros > DEPEG_MAX_MICROS)",
    '    return { result: { status: "not-matched", evidenceIds, explanation: `last price ${lastPriceMicros} micros is within the 3% depeg band of the peg` }, nextState };',
    "  if (publicationMs < windowStartMs || publicationMs > windowEndMs)",
    '    return { result: { status: "not-matched", evidenceIds, explanation: "the attestation falls outside the dataset window" }, nextState };',
    "  return {",
    "    result: {",
    '      status: "matched",',
    "      occurrenceKey: `depeg-observation:${publicationMs}:${lastPriceMicros}`,",
    "      evidenceIds,",
    "      facts: input.facts,",
    "      validUntilMs: input.asOfMs + 3_600_000,",
    "    },",
    "    nextState,",
    "  };",
    "};",
  ].join("\n");

/** The authored policy.ts for the stablecoin scenario: single stage + stop. */
export const depegPolicySource = [
  'import type { DetectorStateEnvelope, PolicyInput, PolicyOutput, Propose } from "./sdk";',
  "",
  "// Fixture-authored for the synthetic 'USDX stablecoin report' scenario (P7",
  "// generality proof): a bounded SINGLE-stage conversion, deliberately not the",
  "// two-stage launch pattern. One matched depeg evaluation proposes the",
  '// "convert" swap once; any later matched evaluation stops future actions —',
  "// re-converting on every new evaluation would spend the envelope one block",
  "// at a time (the plan's occurrence/idempotency drift example). Unknown",
  "// evidence stops too: the host never runs the policy on a non-matched",
  "// evaluation, and the branch is the program's own defense in depth.",
  "export const propose: Propose = (input: PolicyInput): PolicyOutput => {",
  "  const envelope = input.priorState as DetectorStateEnvelope | null | undefined;",
  "  const prior = (envelope === null || envelope === undefined ? {} : envelope.state) as {",
  "    runs?: number;",
  "  };",
  "  const nextState = { stateSchemaVersion: 1, state: { runs: (prior.runs ?? 0) + 1 } };",
  "  const result = input.detectorEvaluation.result;",
  '  if (result.status === "unknown")',
  "    return {",
  '      proposal: { kind: "stop-future-actions", reason: "the depeg evidence is unknown; stopping future actions under this envelope" },',
  "      nextState,",
  "    };",
  '  if (result.status !== "matched")',
  '    return { proposal: { kind: "wait" }, nextState };',
  "  const candidate = input.envelope.candidates[0];",
  '  const converted = input.priorProposals.some((proposal) => proposal.stageKey === "convert");',
  "  if (candidate !== undefined && !converted) {",
  "    return {",
  "      proposal: {",
  '        kind: "swap" as const,',
  "        candidateId: candidate.candidateId,",
  '        amountInRaw: "500000000",',
  '        quoteId: "sq_scenario_fixture",',
  "        occurrenceKey: result.occurrenceKey,",
  '        stageKey: "convert",',
  "        detectorEvaluationId: input.detectorEvaluation.evaluationId,",
  "      },",
  "      nextState,",
  "    };",
  "  }",
  "  return {",
  '    proposal: { kind: "stop-future-actions", reason: "the single approved conversion is already proposed; stopping future actions under this envelope" },',
  "    nextState,",
  "  };",
  "};",
].join("\n");

// -- Authored generated tests (run under the SDK harness in the real image) --

/** The shared fixture vocabulary the authored test files build inputs from. */
const authoredTestPrelude = [
  'import { describe, expect, test } from "./sdk";',
  'import type { CapturedFact, DetectorProgramInput, EvidenceRef, SealedSourceRecord } from "./sdk";',
].join("\n");

/** The authored detector.test.ts for the launch scenario. */
export const launchTestSource = (input: {
  readonly datasetSourceId: string;
  readonly releaseSourceId: string;
}): string =>
  [
    authoredTestPrelude,
    'import { detect } from "./detector";',
    "",
    "// Fixture-authored generated tests for the synthetic 'atlas launch'",
    "// detector. They run under the SDK's own harness inside the real runner",
    "// image; here they also execute in the scenario's compile-and-run probe.",
    "const evidence = (id: string): ReadonlyArray<EvidenceRef> => [",
    '  { id, environmentId: "env_fixture", sourceId: "src_fixture", mode: "fixture",',
    `    contentSha256: "${"a".repeat(64)}", eventAtMs: 1_752_000_000_000, availableAtMs: 1_752_000_000_000,`,
    '    availabilityBasis: "recorded", timePrecision: "second", capturedAtMs: 1_752_000_000_000,',
    '    expiresAtMs: 1_752_060_000_000, sourceRevision: "rev_fixture" },',
    "];",
    "const decimalFact = (id: string, key: string, value: string): CapturedFact => ({",
    '  id, key, entityId: "pool_fixture",',
    '  value: { kind: "decimal", value, unit: "fixture" }, evidence: evidence("ev_graph"),',
    "});",
    "const publishedFact: CapturedFact = {",
    '  id: "fact_published", key: "external.document.published", entityId: "doc_fixture",',
    '  value: { kind: "boolean", value: true }, evidence: evidence("ev_doc"),',
    "};",
    "const sources: ReadonlyArray<SealedSourceRecord> = [",
    `  { sourceId: "${input.datasetSourceId}", evidenceId: "ev_graph", mode: "fixture", contentSha256: "${"b".repeat(64)}", complete: true, availabilityBasis: "recorded" },`,
    `  { sourceId: "${input.releaseSourceId}", evidenceId: "ev_doc", mode: "fixture", contentSha256: "${"c".repeat(64)}", complete: true, availabilityBasis: "recorded" },`,
    "];",
    "const input = (facts: ReadonlyArray<CapturedFact>): DetectorProgramInput => ({",
    "  programSchemaVersion: 2,",
    "  asOfMs: 1_752_060_000_000,",
    `  inputDigest: "${"d".repeat(64)}",`,
    "  facts,",
    "  sources,",
    "});",
    "",
    'describe("launch-surge-detector", () => {',
    '  test("a dated release inside a surging window matches", () => {',
    "    const output = detect(input([",
    '      decimalFact("f_count", "graph.pool.observation-count", "12"),',
    `      decimalFact("f_start", "graph.pool.trade-window-start-ms", "${LAUNCH_WINDOW_START_MS}"),`,
    `      decimalFact("f_end", "graph.pool.trade-window-end-ms", "${LAUNCH_WINDOW_END_MS}"),`,
    "      publishedFact,",
    `      decimalFact("f_pub", "external.document.publication-ms", "${LAUNCH_PUBLICATION_MS}"),`,
    "    ]));",
    '    expect(output.result.status).toBe("matched");',
    "  });",
    '  test("an undated release is not matched", () => {',
    "    const output = detect(input([",
    '      decimalFact("f_count", "graph.pool.observation-count", "12"),',
    `      decimalFact("f_start", "graph.pool.trade-window-start-ms", "${LAUNCH_WINDOW_START_MS}"),`,
    `      decimalFact("f_end", "graph.pool.trade-window-end-ms", "${LAUNCH_WINDOW_END_MS}"),`,
    "      publishedFact,",
    "    ]));",
    '    expect(output.result.status).toBe("not-matched");',
    "  });",
    '  test("a quiet dataset is not matched even with a dated release", () => {',
    "    const output = detect(input([",
    '      decimalFact("f_count", "graph.pool.observation-count", "4"),',
    `      decimalFact("f_start", "graph.pool.trade-window-start-ms", "${LAUNCH_WINDOW_START_MS}"),`,
    `      decimalFact("f_end", "graph.pool.trade-window-end-ms", "${LAUNCH_WINDOW_END_MS}"),`,
    "      publishedFact,",
    `      decimalFact("f_pub", "external.document.publication-ms", "${LAUNCH_PUBLICATION_MS}"),`,
    "    ]));",
    '    expect(output.result.status).toBe("not-matched");',
    "  });",
    "});",
  ].join("\n");

/** The authored detector.test.ts for the stablecoin scenario. */
export const depegTestSource = (input: {
  readonly datasetSourceId: string;
  readonly attestationSourceId: string;
}): string =>
  [
    authoredTestPrelude,
    'import { detect } from "./detector";',
    "",
    "// Fixture-authored generated tests for the synthetic 'USDX stablecoin",
    "// report' detector — the same harness, a materially different relation.",
    "const evidence = (id: string): ReadonlyArray<EvidenceRef> => [",
    '  { id, environmentId: "env_fixture", sourceId: "src_fixture", mode: "fixture",',
    `    contentSha256: "${"a".repeat(64)}", eventAtMs: 1_756_000_000_000, availableAtMs: 1_756_000_000_000,`,
    '    availabilityBasis: "recorded", timePrecision: "second", capturedAtMs: 1_756_000_000_000,',
    '    expiresAtMs: 1_756_060_000_000, sourceRevision: "rev_fixture" },',
    "];",
    "const decimalFact = (id: string, key: string, value: string): CapturedFact => ({",
    '  id, key, entityId: "pool_fixture",',
    '  value: { kind: "decimal", value, unit: "fixture" }, evidence: evidence("ev_graph"),',
    "});",
    "const publishedFact: CapturedFact = {",
    '  id: "fact_published", key: "external.document.published", entityId: "doc_fixture",',
    '  value: { kind: "boolean", value: true }, evidence: evidence("ev_doc"),',
    "};",
    "const sources = (withDoc: boolean): ReadonlyArray<SealedSourceRecord> => [",
    `  { sourceId: "${input.datasetSourceId}", evidenceId: "ev_graph", mode: "fixture", contentSha256: "${"b".repeat(64)}", complete: true, availabilityBasis: "recorded" },`,
    "  ...(withDoc",
    `    ? [{ sourceId: "${input.attestationSourceId}", evidenceId: "ev_doc", mode: "fixture" as const, contentSha256: "${"c".repeat(64)}", complete: true, availabilityBasis: "recorded" as const }]`,
    "    : []),",
    "];",
    "const input = (facts: ReadonlyArray<CapturedFact>, withDoc: boolean): DetectorProgramInput => ({",
    "  programSchemaVersion: 2,",
    "  asOfMs: 1_756_060_000_000,",
    `  inputDigest: "${"d".repeat(64)}",`,
    "  facts,",
    "  sources: sources(withDoc),",
    "});",
    "",
    'describe("depeg-observation-detector", () => {',
    '  test("a price below the depeg band with a corroborated attestation matches", () => {',
    "    const output = detect(input([",
    '      decimalFact("f_price", "graph.pool.last-price-micros", "965000"),',
    `      decimalFact("f_start", "graph.pool.trade-window-start-ms", "${DEPEG_WINDOW_START_MS}"),`,
    `      decimalFact("f_end", "graph.pool.trade-window-end-ms", "${DEPEG_WINDOW_END_MS}"),`,
    "      publishedFact,",
    `      decimalFact("f_pub", "external.document.publication-ms", "${DEPEG_PUBLICATION_MS}"),`,
    "    ], true));",
    '    expect(output.result.status).toBe("matched");',
    "  });",
    '  test("a price at the peg is not matched", () => {',
    "    const output = detect(input([",
    '      decimalFact("f_price", "graph.pool.last-price-micros", "995000"),',
    `      decimalFact("f_start", "graph.pool.trade-window-start-ms", "${DEPEG_WINDOW_START_MS}"),`,
    `      decimalFact("f_end", "graph.pool.trade-window-end-ms", "${DEPEG_WINDOW_END_MS}"),`,
    "      publishedFact,",
    `      decimalFact("f_pub", "external.document.publication-ms", "${DEPEG_PUBLICATION_MS}"),`,
    "    ], true));",
    '    expect(output.result.status).toBe("not-matched");',
    "  });",
    '  test("a missing attestation source is unknown", () => {',
    "    const output = detect(input([",
    '      decimalFact("f_price", "graph.pool.last-price-micros", "965000"),',
    `      decimalFact("f_start", "graph.pool.trade-window-start-ms", "${DEPEG_WINDOW_START_MS}"),`,
    `      decimalFact("f_end", "graph.pool.trade-window-end-ms", "${DEPEG_WINDOW_END_MS}"),`,
    "    ], false));",
    '    expect(output.result.status).toBe("unknown");',
    "  });",
    "});",
  ].join("\n");

// ---------------------------------------------------------------------------
// The JS mirrors — what the scripted container computes for the authored bytes
// ---------------------------------------------------------------------------

/** The sealed-input slices the mirrors read (structural, not schema-decoded). */
export interface MirrorFact {
  readonly key: string;
  readonly entityId: string;
  readonly value:
    | { readonly kind: "boolean"; readonly value: boolean }
    | { readonly kind: "decimal"; readonly value: string; readonly unit: string }
    | { readonly kind: "text"; readonly value: string };
  readonly evidence: ReadonlyArray<{ readonly id: string }>;
}

export interface MirrorSource {
  readonly sourceId: string;
  readonly evidenceId: string;
  readonly complete: boolean;
  readonly sourceRevision?: string | undefined;
}

export interface MirrorDetectorInput {
  readonly asOfMs: number;
  readonly facts: ReadonlyArray<MirrorFact>;
  readonly sources: ReadonlyArray<MirrorSource>;
  readonly priorState?: unknown;
}

export interface MirrorPolicyInput {
  readonly asOfMs: number;
  readonly envelope: { readonly candidates: ReadonlyArray<{ readonly candidateId: string }> };
  readonly detectorEvaluation: {
    readonly evaluationId: string;
    readonly asOfMs: number;
    readonly result:
      | {
          readonly status: "matched";
          readonly occurrenceKey: string;
          readonly validUntilMs: number;
        }
      | { readonly status: "not-matched" | "unknown"; readonly explanation: string };
  };
  readonly priorProposals: ReadonlyArray<{ readonly stageKey: string }>;
  readonly remainingInputCapRaw: string;
  readonly priorState?: unknown;
}

export interface MirrorProgramOutput {
  readonly result: unknown;
  readonly nextState: unknown;
}

export interface MirrorPolicyOutput {
  readonly proposal: unknown;
  readonly nextState: unknown;
}

const mirrorDecimalFact = (facts: ReadonlyArray<MirrorFact>, key: string): number | null => {
  const fact = facts.find((candidate) => candidate.key === key);
  if (fact === undefined || fact.value.kind !== "decimal") return null;
  const parsed = Number(fact.value.value);
  return Number.isFinite(parsed) ? parsed : null;
};

const mirrorRequired = (
  input: MirrorDetectorInput,
  requiredSourceIds: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  requiredSourceIds.filter((id) => !input.sources.some((source) => source.sourceId === id));

/** The JS interpretation of `launchDetectorSource` (what the fake runner runs). */
export const mirrorLaunchDetect =
  (requiredSourceIds: ReadonlyArray<string>, minObservations: number) =>
  (input: MirrorDetectorInput): MirrorProgramOutput => {
    const prior = (input.priorState ?? null) as { state?: { runs?: number } } | null;
    const nextState = { stateSchemaVersion: 1, state: { runs: (prior?.state?.runs ?? 0) + 1 } };
    const missing = mirrorRequired(input, requiredSourceIds);
    if (missing.length > 0) {
      return {
        result: {
          status: "unknown",
          missingSourceIds: missing,
          explanation: "a required source is absent from the sealed window",
        },
        nextState,
      };
    }
    const evidenceIds = input.sources.map((source) => source.evidenceId);
    const count = mirrorDecimalFact(input.facts, "graph.pool.observation-count");
    const published = input.facts.some(
      (fact) =>
        fact.key === "external.document.published" &&
        fact.value.kind === "boolean" &&
        fact.value.value,
    );
    const publicationMs = mirrorDecimalFact(input.facts, "external.document.publication-ms");
    if (!published || publicationMs === null) {
      return {
        result: {
          status: "not-matched",
          evidenceIds,
          explanation: "the launch release carries no dated publication instant",
        },
        nextState,
      };
    }
    const windowStartMs = mirrorDecimalFact(input.facts, "graph.pool.trade-window-start-ms");
    const windowEndMs = mirrorDecimalFact(input.facts, "graph.pool.trade-window-end-ms");
    if (count === null || windowStartMs === null || windowEndMs === null) {
      return {
        result: {
          status: "not-matched",
          evidenceIds,
          explanation: "the dataset facts are incomplete",
        },
        nextState,
      };
    }
    if (count <= minObservations) {
      return {
        result: {
          status: "not-matched",
          evidenceIds,
          explanation: `observation count ${count} does not exceed ${minObservations}`,
        },
        nextState,
      };
    }
    if (publicationMs < windowStartMs || publicationMs > windowEndMs) {
      return {
        result: {
          status: "not-matched",
          evidenceIds,
          explanation: "the launch release falls outside the dataset window",
        },
        nextState,
      };
    }
    return {
      result: {
        status: "matched",
        occurrenceKey: `launch-surge:${publicationMs}`,
        evidenceIds,
        facts: input.facts,
        validUntilMs: input.asOfMs + 3_600_000,
      },
      nextState,
    };
  };

/** The JS interpretation of `depegDetectorSource` (what the fake runner runs). */
export const mirrorDepegDetect =
  (requiredSourceIds: ReadonlyArray<string>, depegMaxMicros: number) =>
  (input: MirrorDetectorInput): MirrorProgramOutput => {
    const prior = (input.priorState ?? null) as {
      state?: { runs?: number; lastPriceMicros?: number };
    } | null;
    const lastSeen = prior?.state?.lastPriceMicros;
    const nextState = {
      stateSchemaVersion: 1,
      state: {
        runs: (prior?.state?.runs ?? 0) + 1,
        ...(lastSeen === undefined ? {} : { lastPriceMicros: lastSeen }),
      },
    };
    const missing = mirrorRequired(input, requiredSourceIds);
    if (missing.length > 0) {
      return {
        result: {
          status: "unknown",
          missingSourceIds: missing,
          explanation: "a required source is absent from the sealed window",
        },
        nextState,
      };
    }
    const evidenceIds = input.sources.map((source) => source.evidenceId);
    const published = input.facts.some(
      (fact) =>
        fact.key === "external.document.published" &&
        fact.value.kind === "boolean" &&
        fact.value.value,
    );
    const publicationMs = mirrorDecimalFact(input.facts, "external.document.publication-ms");
    if (!published || publicationMs === null) {
      return {
        result: {
          status: "not-matched",
          evidenceIds,
          explanation: "the attestation carries no dated publication instant",
        },
        nextState,
      };
    }
    const lastPriceMicros = mirrorDecimalFact(input.facts, "graph.pool.last-price-micros");
    const windowStartMs = mirrorDecimalFact(input.facts, "graph.pool.trade-window-start-ms");
    const windowEndMs = mirrorDecimalFact(input.facts, "graph.pool.trade-window-end-ms");
    if (lastPriceMicros === null || windowStartMs === null || windowEndMs === null) {
      return {
        result: {
          status: "not-matched",
          evidenceIds,
          explanation: "the dataset facts are incomplete",
        },
        nextState,
      };
    }
    if (lastPriceMicros > depegMaxMicros) {
      return {
        result: {
          status: "not-matched",
          evidenceIds,
          explanation: `last price ${lastPriceMicros} micros is within the 3% depeg band of the peg`,
        },
        nextState,
      };
    }
    if (publicationMs < windowStartMs || publicationMs > windowEndMs) {
      return {
        result: {
          status: "not-matched",
          evidenceIds,
          explanation: "the attestation falls outside the dataset window",
        },
        nextState,
      };
    }
    return {
      result: {
        status: "matched",
        occurrenceKey: `depeg-observation:${publicationMs}:${lastPriceMicros}`,
        evidenceIds,
        facts: input.facts,
        validUntilMs: input.asOfMs + 3_600_000,
      },
      nextState,
    };
  };

/** The JS interpretation of `launchPolicySource`. */
export const mirrorLaunchPropose = (input: MirrorPolicyInput): MirrorPolicyOutput => {
  const envelope = (input.priorState ?? null) as {
    state?: { entryFor?: string; runs?: number };
  } | null;
  const prior = envelope?.state ?? {};
  const runs = (prior.runs ?? 0) + 1;
  const carry = { ...prior, runs };
  const evaluation = input.detectorEvaluation;
  const result = evaluation.result;
  if (result.status !== "matched") {
    return { proposal: { kind: "wait" }, nextState: { stateSchemaVersion: 1, state: carry } };
  }
  const candidate = input.envelope.candidates[0];
  if (candidate === undefined) {
    return { proposal: { kind: "wait" }, nextState: { stateSchemaVersion: 1, state: carry } };
  }
  const hasEntry = input.priorProposals.some((proposal) => proposal.stageKey === "entry");
  const swap = (stageKey: string) => ({
    kind: "swap",
    candidateId: candidate.candidateId,
    amountInRaw: "1000000",
    quoteId: "sq_scenario_fixture",
    occurrenceKey: result.occurrenceKey,
    stageKey,
    detectorEvaluationId: evaluation.evaluationId,
  });
  if (!hasEntry) {
    return {
      proposal: swap("entry"),
      nextState: { stateSchemaVersion: 1, state: { ...carry, entryFor: evaluation.evaluationId } },
    };
  }
  if (prior.entryFor === evaluation.evaluationId) {
    return { proposal: swap("entry"), nextState: { stateSchemaVersion: 1, state: carry } };
  }
  return {
    proposal: swap("exit"),
    nextState: {
      stateSchemaVersion: 1,
      state: { ...carry, entryFor: prior.entryFor, exitFor: evaluation.evaluationId },
    },
  };
};

/** The JS interpretation of `depegPolicySource`. */
export const mirrorDepegPropose = (input: MirrorPolicyInput): MirrorPolicyOutput => {
  const envelope = (input.priorState ?? null) as { state?: { runs?: number } } | null;
  const prior = envelope?.state ?? {};
  const nextState = { stateSchemaVersion: 1, state: { runs: (prior.runs ?? 0) + 1 } };
  const result = input.detectorEvaluation.result;
  if (result.status === "unknown") {
    return {
      proposal: {
        kind: "stop-future-actions",
        reason: "the depeg evidence is unknown; stopping future actions under this envelope",
      },
      nextState,
    };
  }
  if (result.status !== "matched") {
    return { proposal: { kind: "wait" }, nextState };
  }
  const candidate = input.envelope.candidates[0];
  const converted = input.priorProposals.some((proposal) => proposal.stageKey === "convert");
  if (candidate !== undefined && !converted) {
    return {
      proposal: {
        kind: "swap",
        candidateId: candidate.candidateId,
        amountInRaw: "500000000",
        quoteId: "sq_scenario_fixture",
        occurrenceKey: result.occurrenceKey,
        stageKey: "convert",
        detectorEvaluationId: input.detectorEvaluation.evaluationId,
      },
      nextState,
    };
  }
  return {
    proposal: {
      kind: "stop-future-actions",
      reason:
        "the single approved conversion is already proposed; stopping future actions under this envelope",
    },
    nextState,
  };
};

// ---------------------------------------------------------------------------
// The scripted container
// ---------------------------------------------------------------------------

/** The fake container: build steps pass, evaluate heads answer from mirrors. */
export const makeScenarioRunner = (programs: {
  readonly detect: (input: MirrorDetectorInput) => MirrorProgramOutput;
  readonly propose: (input: MirrorPolicyInput) => MirrorPolicyOutput;
}) => {
  const detectorStdins: Array<MirrorDetectorInput> = [];
  const policyStdins: Array<MirrorPolicyInput> = [];
  const buildHeads: Array<string> = [];
  const runner: ForgeContainerRunnerShape = {
    available: Effect.succeed(true),
    run: (request) =>
      Effect.sync(() => {
        const head = request.entrypoint[0];
        if (head === FORGE_RUNNER_TYPECHECK[0] || head === FORGE_RUNNER_TEST[0]) {
          buildHeads.push(head);
          return { exitCode: 0, stdout: "", stderr: "", killed: null };
        }
        if (head === FORGE_RUNNER_EVALUATE_V2[0]) {
          const input = JSON.parse(request.stdin ?? "{}") as MirrorDetectorInput;
          detectorStdins.push(input);
          return {
            exitCode: 0,
            stdout: JSON.stringify(programs.detect(input)),
            stderr: "",
            killed: null,
          };
        }
        if (head === FORGE_RUNNER_EVALUATE_POLICY[0]) {
          const input = JSON.parse(request.stdin ?? "{}") as MirrorPolicyInput;
          policyStdins.push(input);
          return {
            exitCode: 0,
            stdout: JSON.stringify(programs.propose(input)),
            stderr: "",
            killed: null,
          };
        }
        return { exitCode: 1, stdout: "", stderr: `unknown entrypoint ${head}`, killed: null };
      }),
  };
  return { runner, detectorStdins, policyStdins, buildHeads };
};

// ---------------------------------------------------------------------------
// The scenario world — every real service over one in-memory SQLite client
// ---------------------------------------------------------------------------

export interface ScenarioWorld {
  readonly events: TradingEventServiceShape;
  readonly importer: ExternalEventImportServiceShape;
  readonly external: ExternalSourceStoreShape;
  readonly graph: ForgeSourceStoreShape;
  readonly research: GraphResearchServiceShape;
  readonly builder: ForgeCapabilityBuilderShape;
  readonly capabilities: ForgeCapabilityStoreShape;
  readonly reactor: ForgeReactorShape;
  readonly runs: DetectorRunStoreShape;
  readonly policy: ExecutionPolicyServiceShape;
}

const scenarioBaseLayer = Layer.mergeAll(NodeSqliteClient.layerMemory(), NodeServices.layer);

/**
 * Run `body` with the full scenario world alive: the REAL connector, import
 * service, event service, source stores, graph research, builder, capability
 * store, fact window, reactor, run store, and execution-policy service — over
 * one in-memory SQLite client, one file-backed capability store under
 * `stateRoot`, and the two fake seams (HTTP transport, container runner) those
 * services already expose for tests. The v1 window provider is an inert
 * refusal: a detector-program (v2) scenario never touches the pool-window
 * path. The world (and its database) lives exactly as long as `body`.
 */
export const withScenarioWorld = async <A>(
  input: {
    readonly environmentId: string;
    readonly stateRoot: string;
    readonly sourceEnv: Record<string, string | undefined>;
    readonly transport: ExternalSourceTransportShape;
    readonly runner: ForgeContainerRunnerShape;
    readonly graphSource: ForgeGraphSourceShape;
  },
  body: (world: ScenarioWorld) => Promise<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations({});
      const external = yield* makeExternalSourceStore;
      const connector = yield* makeExternalSourceConnector.pipe(
        Effect.provideService(ExternalSourceStore, external),
        Effect.provideService(
          ExternalSourceConfig,
          ExternalSourceConfig.of({
            resolve: Effect.succeed(resolveExternalSourceSettings(input.sourceEnv)),
          }),
        ),
        Effect.provideService(ExternalSourceTransport, ExternalSourceTransport.of(input.transport)),
      );
      const events = yield* makeTradingEventService;
      const importer = yield* makeExternalEventImportService.pipe(
        Effect.provideService(ExternalSourceConnector, ExternalSourceConnector.of(connector)),
        Effect.provideService(ExternalSourceStore, external),
        Effect.provideService(TradingEventService, TradingEventService.of(events)),
      );
      const graph = yield* makeForgeSourceStore;
      const research = yield* makeGraphResearchService.pipe(
        Effect.provideService(ForgeGraphSource, input.graphSource),
        Effect.provideService(ForgeSourceStore, graph),
      );
      const runs = yield* makeDetectorRunStore;
      const factWindow = yield* makeDetectorFactWindow.pipe(
        Effect.provideService(ForgeSourceStore, graph),
        Effect.provideService(ExternalSourceStore, external),
      );
      const sandbox = yield* makeForgeCapabilitySandbox.pipe(
        Effect.provideService(ForgeSandboxConfig, {
          imageRef: SCENARIO_IMAGE,
          buildBudgetMs: 30_000,
          evaluationBudgetMs: 2_000,
        }),
        Effect.provideService(ForgeContainerRunner, input.runner),
      );
      const capabilities = yield* ForgeCapabilityStore.pipe(
        Effect.provide(
          ForgeCapabilityStoreLive.pipe(
            Layer.provide(
              Layer.succeed(ForgeCapabilityStoreConfig, { stateRoot: input.stateRoot }),
            ),
          ),
        ),
      );
      const builder = yield* makeForgeCapabilityBuilder.pipe(
        Effect.provideService(ForgeCapabilityStore, capabilities),
        Effect.provideService(ForgeCapabilitySandbox, sandbox),
      );
      const reactor = yield* makeForgeReactor.pipe(
        Effect.provideService(ForgeCapabilityStore, capabilities),
        Effect.provideService(ForgeCapabilitySandbox, sandbox),
        Effect.provideService(ForgeSourceWindowProvider, {
          currentWindow: () =>
            Effect.fail({ reason: "the v1 pool-window path is not part of this scenario" }),
        }),
        Effect.provideService(ForgeCapabilityStoreConfig, { stateRoot: input.stateRoot }),
        Effect.provideService(DetectorRunStore, runs),
        Effect.provideService(DetectorFactWindow, factWindow),
      );
      const policy = yield* makeExecutionPolicyService.pipe(
        Effect.provideService(ForgeCapabilityStore, capabilities),
        Effect.provideService(ForgeCapabilitySandbox, sandbox),
        Effect.provideService(DetectorRunStore, runs),
      );
      const world: ScenarioWorld = {
        events,
        importer,
        external,
        graph,
        research,
        builder,
        capabilities,
        reactor,
        runs,
        policy,
      };
      return yield* Effect.promise(() => body(world));
    }).pipe(Effect.provide(scenarioBaseLayer)),
  );

// ---------------------------------------------------------------------------
// The compile-and-run probe — the faked typecheck, made honest
// ---------------------------------------------------------------------------

/** The compiled fixture programs, loaded from the tsc output directory. */
export interface CompiledScenarioPrograms {
  readonly detect: (input: unknown) => { readonly result: unknown; readonly nextState: unknown };
  readonly propose: (input: unknown) => { readonly proposal: unknown; readonly nextState: unknown };
  /** Runs the authored detector.test.ts suite through the SDK harness;
   *  resolves to the number of registered tests that ran. */
  readonly runGeneratedTests: () => Promise<number>;
  readonly cleanup: () => Promise<void>;
}

// Resolves the workspace's own tsc (the same 6.0.x line the image pins)
// across npm and pnpm layouts; the CapabilityBuilder.test.ts precedent.
const resolveTsc = (): string | null => {
  const root = NodePath.resolve(process.cwd(), "../..");
  const direct = NodePath.join(root, "node_modules", "typescript", "bin", "tsc");
  if (NodeFsSync.existsSync(direct)) return direct;
  const pnpm = NodePath.join(root, "node_modules", ".pnpm");
  if (NodeFsSync.existsSync(pnpm)) {
    const entry = NodeFsSync.readdirSync(pnpm).find((name) => /^typescript@/.test(name));
    if (entry !== undefined) {
      const candidate = NodePath.join(pnpm, entry, "node_modules", "typescript", "bin", "tsc");
      if (NodeFsSync.existsSync(candidate)) return candidate;
    }
  }
  return null;
};

/**
 * Compile the fixture bundle's sdk.ts + detector.ts + detector.test.ts +
 * policy.ts under the pinned runner's EXACT tsc flags, then load the compiled
 * entries. This is what makes the faked `forge-typecheck` / `forge-test`
 * container steps honest: the authored bytes really do compile and the
 * generated tests really do pass under the runner's own harness.
 */
export const compileScenarioPrograms = async (input: {
  readonly detectorSource: string;
  readonly testSource: string;
  readonly policySource: string;
}): Promise<CompiledScenarioPrograms> => {
  const resolved = resolveTsc();
  if (resolved === null)
    throw new Error("a local typescript compiler must exist for the scenario probe");
  const tscPath = resolved;
  const workDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "scenario-bundle-"));
  const outDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "scenario-bundle-out-"));
  try {
    await NodeFs.writeFile(NodePath.join(workDir, "sdk.ts"), FORGE_SDK_SOURCE_V2, "utf8");
    await NodeFs.writeFile(NodePath.join(workDir, "detector.ts"), input.detectorSource, "utf8");
    await NodeFs.writeFile(NodePath.join(workDir, "detector.test.ts"), input.testSource, "utf8");
    await NodeFs.writeFile(NodePath.join(workDir, "policy.ts"), input.policySource, "utf8");
    const compiled = spawnSync(
      process.execPath,
      [
        tscPath,
        "--strict",
        "--target",
        "ES2022",
        "--lib",
        "ES2022",
        "--module",
        "commonjs",
        "--moduleResolution",
        "node",
        "--ignoreDeprecations",
        "6.0",
        "--skipLibCheck",
        "--outDir",
        outDir,
        NodePath.join(workDir, "sdk.ts"),
        NodePath.join(workDir, "detector.ts"),
        NodePath.join(workDir, "detector.test.ts"),
        NodePath.join(workDir, "policy.ts"),
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024, cwd: workDir },
    );
    if (compiled.status !== 0) {
      throw new Error(
        `the fixture bundle must compile under the runner's flags: ${compiled.stdout}${compiled.stderr}`,
      );
    }
    // The compiled modules are CommonJS: load them through a require anchored
    // in the output directory so the test module and the SDK share ONE module
    // instance (an ESM import would facade a second copy with its own empty
    // test registry).
    const requireFromOutDir = createRequire(pathToFileURL(NodePath.join(outDir, "probe.js")).href);
    const detectorModule = requireFromOutDir("./detector.js") as {
      readonly detect?: (input: unknown) => {
        readonly result: unknown;
        readonly nextState: unknown;
      };
      readonly default?: {
        readonly detect: (input: unknown) => {
          readonly result: unknown;
          readonly nextState: unknown;
        };
      };
    };
    const policyModule = requireFromOutDir("./policy.js") as {
      readonly propose?: (input: unknown) => {
        readonly proposal: unknown;
        readonly nextState: unknown;
      };
      readonly default?: {
        readonly propose: (input: unknown) => {
          readonly proposal: unknown;
          readonly nextState: unknown;
        };
      };
    };
    const sdkModule = requireFromOutDir("./sdk.js") as {
      readonly runRegisteredTests?: () => Promise<number>;
    };
    // Requiring the compiled test module registers its tests on the SAME
    // compiled SDK instance the runner's test head would run them through.
    requireFromOutDir("./detector.test.js");
    const detect = detectorModule.detect ?? detectorModule.default?.detect;
    const propose = policyModule.propose ?? policyModule.default?.propose;
    const runRegisteredTests = sdkModule.runRegisteredTests;
    if (detect === undefined || propose === undefined || runRegisteredTests === undefined) {
      throw new Error(
        "the compiled fixture bundle must export detect, propose, and runRegisteredTests",
      );
    }
    return {
      detect,
      propose,
      runGeneratedTests: runRegisteredTests,
      cleanup: async () => {
        await NodeFs.rm(workDir, { recursive: true, force: true });
        await NodeFs.rm(outDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await NodeFs.rm(workDir, { recursive: true, force: true });
    await NodeFs.rm(outDir, { recursive: true, force: true });
    throw error;
  }
};
