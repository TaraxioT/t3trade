/**
 * SCENARIO A — "atlas launch" (conference/release adoption), the first of the
 * two P7 generality packs.
 *
 * WHAT THIS SCENARIO PROVES
 *
 * One fictional GitHub-style project ("atlas-labs/atlas") ships three
 * releases over a month; a fictional WETH/USDC pool shows a swap surge around
 * the launch. The full local chain runs over synthetic fixtures through the
 * SAME engines the stablecoin scenario (scenarioStablecoin.test.ts) uses:
 *
 *   external documents captured (real connector over a fake transport)
 *     → event set imported (real import + event services)
 *     → graph research reuses the seeded retained dataset (real research
 *       service over a fake source; the study's dataset id IS the detector's
 *       required source id — the research lineage tie)
 *     → a fixture-authored detector-program v2 bundle validated by the REAL
 *       builder (acceptance, determinism, hashes), installed and ARMED
 *       through the real store
 *     → evaluated over retained evidence by the REAL reactor and fact window
 *     → a two-stage entry/exit swap proposal under an approved envelope
 *       (real execution-policy service).
 *
 * Different evidence, different behavior on the same engine: before the
 * launch is dated the detector is NOT-MATCHED; around the dated launch it
 * MATCHES (policy: entry, then exit on a new evaluation); after the launch
 * date is withdrawn it is NOT-MATCHED again (policy: no-proposal).
 *
 * THE NO-CORE-CHANGES PROOF
 *
 * This file imports ONLY the public service layers — the connector, the
 * import service, the event service, the graph research service, the builder,
 * the capability store, the reactor, the run store, the execution-policy
 * service — plus the test seams those services already expose (the HTTP
 * transport and the container runner) and the shared-contract types. No
 * core engine file was edited to make this scenario run; the diff that added
 * scenario B to this same engine is empty by construction.
 *
 * Every fixture is synthetic and labeled. No live source, no Docker, no
 * network, no signer, no chain.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off - the authoring workspace and state root are real files under temp roots; the scripted container parses the sealed JSON stdin it was handed; envelope and evaluation clocks are wall-clock data the scenarios pass explicitly.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ExecutionEnvelope, ForgeAcceptanceCaseV2 } from "@t3tools/trading-contracts";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { forgeSha256Hex } from "../CapabilitySandbox.ts";
import { FORGE_SDK_SOURCE_V2 } from "../CapabilityBuilder.ts";
import { ForgeSourceStore } from "../ForgeSourceStore.ts";
import {
  withScenarioWorld,
  candleFeatures,
  compileScenarioPrograms,
  detectorManifest,
  flipTransport,
  LAUNCH_WINDOW_END_MS,
  LAUNCH_WINDOW_START_MS,
  launchDetectorSource,
  launchPolicySource,
  launchTestSource,
  makeScenarioRunner,
  mirrorLaunchDetect,
  mirrorLaunchPropose,
  reuseOnlyGraphSource,
  seedGraphDataset,
  studyBounds,
  syntheticSwap,
  type MirrorDetectorInput,
} from "./scenarioFixtures.ts";

// ---------------------------------------------------------------------------
// The synthetic fixture world (all fictional, all labeled)
// ---------------------------------------------------------------------------

const ENV_A = "env_scenario_launch";
const THREAD_A = "thread_scenario_launch";
const CAP_A = "launch-surge-detector";
const SET_NAME = "atlas releases (synthetic)";
const POOL_A: `0x${string}` = `0x${"ab".repeat(20)}`;
const DEPLOYMENT_A = "QmscenarioA";
const BLOCK_A = 19_000_001;
const BLOCK_HASH_A = `0x${"cd".repeat(32)}`;
const DAY = 86_400_000;

const T_V090 = Date.parse("2026-07-01T12:00:00Z");
const T_LAUNCH = Date.parse("2026-07-10T01:30:00Z");
const T_V110 = Date.parse("2026-07-28T12:00:00Z");
const C1 = Date.parse("2026-07-09T10:00:00Z"); // before the launch ships
const C2 = Date.parse("2026-07-10T02:00:00Z"); // just after the launch ships
const C3 = Date.parse("2026-07-28T13:00:00Z"); // v1.1.0 appears
const C4 = Date.parse("2026-07-30T09:00:00Z"); // the launch date is withdrawn
const STUDY_NOW = Date.parse("2026-07-31T00:00:00Z");

const RELEASE_URL = "https://github.com/atlas-labs/atlas/releases/tag";

/** One synthetic release entry as the fake GitHub page serves it. */
const release = (overrides?: Record<string, unknown>) => ({
  id: 100,
  tag_name: "v1.0.0",
  name: "Atlas 1.0.0",
  body: "synthetic fixture",
  published_at: "2026-07-10T01:30:00Z",
  html_url: `${RELEASE_URL}/v1.0.0`,
  ...overrides,
});

const V090 = release({
  id: 90,
  tag_name: "v0.9.0",
  name: "Atlas 0.9.0",
  body: "quiet patch (synthetic fixture)",
  published_at: "2026-07-01T12:00:00Z",
  html_url: `${RELEASE_URL}/v0.9.0`,
});
const V100_UNDATED = release({
  name: "Atlas 1.0.0 (preview)",
  body: "launch preview, not yet dated (synthetic fixture)",
  published_at: null,
});
const V100_DATED = release({
  name: "Atlas 1.0.0",
  body: "launch notes (synthetic fixture)",
  published_at: "2026-07-10T01:30:00Z",
});
const V100_WITHDRAWN = release({
  name: "Atlas 1.0.0 (date withdrawn)",
  body: "launch date withdrawn by the issuer (synthetic fixture)",
  published_at: null,
});
const V110 = release({
  id: 110,
  tag_name: "v1.1.0",
  name: "Atlas 1.1.0",
  body: "follow-up patch (synthetic fixture)",
  published_at: "2026-07-28T12:00:00Z",
  html_url: `${RELEASE_URL}/v1.1.0`,
});

const DOC_IDENTITY_V100 = "github-release:atlas-labs/atlas:v1.0.0";
const RELEASE_SOURCE_ID = `external:github-releases:${DOC_IDENTITY_V100}`;

const unixSeconds = (ms: number): number => Math.floor(ms / 1000);

/** Synthetic swaps rising around the launch: quiet Jul 9, surging Jul 10. */
const launchMonthObservations = [
  syntheticSwap({
    seq: 1,
    timestamp: unixSeconds(Date.parse("2026-07-09T20:00:00Z")),
    poolId: POOL_A,
    priceMicros: 2_000_000_000,
    volumeMicros: 100_000,
  }),
  syntheticSwap({
    seq: 2,
    timestamp: unixSeconds(Date.parse("2026-07-09T21:00:00Z")),
    poolId: POOL_A,
    priceMicros: 2_001_000_000,
    volumeMicros: 100_000,
  }),
  syntheticSwap({
    seq: 3,
    timestamp: unixSeconds(Date.parse("2026-07-09T22:00:00Z")),
    poolId: POOL_A,
    priceMicros: 2_000_500_000,
    volumeMicros: 100_000,
  }),
  syntheticSwap({
    seq: 4,
    timestamp: unixSeconds(Date.parse("2026-07-09T23:00:00Z")),
    poolId: POOL_A,
    priceMicros: 2_002_000_000,
    volumeMicros: 100_000,
  }),
  syntheticSwap({
    seq: 5,
    timestamp: unixSeconds(Date.parse("2026-07-10T01:35:00Z")),
    poolId: POOL_A,
    priceMicros: 2_005_000_000,
    volumeMicros: 800_000,
  }),
  syntheticSwap({
    seq: 6,
    timestamp: unixSeconds(Date.parse("2026-07-10T01:40:00Z")),
    poolId: POOL_A,
    priceMicros: 2_010_000_000,
    volumeMicros: 900_000,
  }),
  syntheticSwap({
    seq: 7,
    timestamp: unixSeconds(Date.parse("2026-07-10T01:45:00Z")),
    poolId: POOL_A,
    priceMicros: 2_018_000_000,
    volumeMicros: 1_100_000,
  }),
  syntheticSwap({
    seq: 8,
    timestamp: unixSeconds(Date.parse("2026-07-10T01:50:00Z")),
    poolId: POOL_A,
    priceMicros: 2_024_000_000,
    volumeMicros: 1_200_000,
  }),
  syntheticSwap({
    seq: 9,
    timestamp: unixSeconds(Date.parse("2026-07-10T02:00:00Z")),
    poolId: POOL_A,
    priceMicros: 2_032_000_000,
    volumeMicros: 1_400_000,
  }),
  syntheticSwap({
    seq: 10,
    timestamp: unixSeconds(Date.parse("2026-07-10T02:15:00Z")),
    poolId: POOL_A,
    priceMicros: 2_043_000_000,
    volumeMicros: 1_600_000,
  }),
  syntheticSwap({
    seq: 11,
    timestamp: unixSeconds(Date.parse("2026-07-10T02:30:00Z")),
    poolId: POOL_A,
    priceMicros: 2_052_000_000,
    volumeMicros: 1_800_000,
  }),
  syntheticSwap({
    seq: 12,
    timestamp: unixSeconds(Date.parse("2026-07-10T03:00:00Z")),
    poolId: POOL_A,
    priceMicros: 2_060_000_000,
    volumeMicros: 2_000_000,
  }),
];

/** The envelope a human approves for the launch capability (synthetic caps). */
const launchEnvelope = (detectorSha: string, policySha: string): ExecutionEnvelope => ({
  revision: 1,
  environmentId: ENV_A,
  accountId: "acct-scenario-launch",
  expiresAtMs: 4_102_444_800_000,
  detectorBundleSha256: detectorSha,
  policyBundleSha256: policySha,
  candidates: [
    {
      candidateId: "cand_weth_usdc_launch",
      chainId: "11155111",
      tokenIn: `0x${"aa".repeat(20)}`,
      tokenOut: `0x${"bb".repeat(20)}`,
      recipient: `0x${"cc".repeat(20)}`,
      label: "synthetic WETH->USDC (scenario A)",
    },
  ],
  inputCapTotalRaw: "3000000",
  inputCapPerSwapRaw: "2000000",
  maxGasWei: "200000000000000",
  maxSlippageBps: 50,
  maxTransactions: 4,
  maxConcurrentIntents: 2,
});

// ---------------------------------------------------------------------------
// Host-authored acceptance cases for the builder (sealed synthetic inputs)
// ---------------------------------------------------------------------------

const CASE_AS_OF = 1_752_060_000_000;

const caseEvidence = (id: string, sourceId: string) => ({
  id,
  environmentId: ENV_A,
  sourceId,
  mode: "fixture" as const,
  contentSha256: "a".repeat(64),
  eventAtMs: 1_752_000_000_000,
  availableAtMs: 1_752_000_000_000,
  availabilityBasis: "recorded" as const,
  timePrecision: "second" as const,
  capturedAtMs: 1_752_000_000_000,
  expiresAtMs: 1_752_060_000_000,
  sourceRevision: "rev_case",
});

const caseSource = (sourceId: string, evidenceId: string) => ({
  sourceId,
  evidenceId,
  mode: "fixture" as const,
  contentSha256: "b".repeat(64),
  complete: true,
  availabilityBasis: "recorded" as const,
});

const decimalCaseFact = (id: string, sourceId: string, key: string, value: string) => ({
  id,
  key,
  entityId: POOL_A,
  value: { kind: "decimal" as const, value, unit: "case" },
  evidence: [caseEvidence("ev_case_graph", sourceId)],
});

const WINDOW_START_MS = LAUNCH_WINDOW_START_MS;
const WINDOW_END_MS = LAUNCH_WINDOW_END_MS;

const launchAcceptanceCases = (datasetSourceId: string): ReadonlyArray<ForgeAcceptanceCaseV2> => {
  const graphFacts = (count: string) => [
    decimalCaseFact("cf_count", datasetSourceId, "graph.pool.observation-count", count),
    decimalCaseFact(
      "cf_start",
      datasetSourceId,
      "graph.pool.trade-window-start-ms",
      String(WINDOW_START_MS),
    ),
    decimalCaseFact(
      "cf_end",
      datasetSourceId,
      "graph.pool.trade-window-end-ms",
      String(WINDOW_END_MS),
    ),
  ];
  const publishedFact = {
    id: "cf_pub",
    key: "external.document.published",
    entityId: DOC_IDENTITY_V100,
    value: { kind: "boolean" as const, value: true },
    evidence: [caseEvidence("ev_case_doc", RELEASE_SOURCE_ID)],
  };
  const publicationFact = decimalCaseFact(
    "cf_pubms",
    RELEASE_SOURCE_ID,
    "external.document.publication-ms",
    String(T_LAUNCH),
  );
  const matchedFacts = [...graphFacts("12"), publishedFact, publicationFact];
  return [
    {
      name: "matched-when-dated-release-and-surge",
      input: {
        programSchemaVersion: 2 as const,
        asOfMs: CASE_AS_OF,
        inputDigest: "d".repeat(64),
        facts: matchedFacts,
        sources: [
          caseSource(datasetSourceId, "ev_case_graph"),
          caseSource(RELEASE_SOURCE_ID, "ev_case_doc"),
        ],
        priorState: { stateSchemaVersion: 1, state: { runs: 2 } },
      },
      expected: {
        result: {
          status: "matched",
          occurrenceKey: `launch-surge:${T_LAUNCH}`,
          evidenceIds: ["ev_case_graph", "ev_case_doc"],
          facts: matchedFacts,
          validUntilMs: CASE_AS_OF + 3_600_000,
        },
        nextState: { stateSchemaVersion: 1, state: { runs: 3 } },
      },
    },
    {
      name: "undated-release-is-not-matched",
      input: {
        programSchemaVersion: 2 as const,
        asOfMs: CASE_AS_OF,
        inputDigest: "d".repeat(64),
        facts: [...graphFacts("12"), publishedFact],
        sources: [
          caseSource(datasetSourceId, "ev_case_graph"),
          caseSource(RELEASE_SOURCE_ID, "ev_case_doc"),
        ],
      },
      expected: {
        result: {
          status: "not-matched",
          evidenceIds: ["ev_case_graph", "ev_case_doc"],
          explanation: "the launch release carries no dated publication instant",
        },
        nextState: { stateSchemaVersion: 1, state: { runs: 1 } },
      },
    },
    {
      name: "missing-dataset-source-is-unknown",
      input: {
        programSchemaVersion: 2 as const,
        asOfMs: CASE_AS_OF,
        inputDigest: "d".repeat(64),
        facts: [publishedFact, publicationFact],
        sources: [caseSource(RELEASE_SOURCE_ID, "ev_case_doc")],
      },
      expected: {
        result: {
          status: "unknown",
          missingSourceIds: [datasetSourceId],
          explanation: "a required source is absent from the sealed window",
        },
        nextState: { stateSchemaVersion: 1, state: { runs: 1 } },
      },
    },
  ];
};

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

it("scenario A: launch capture → import → research lineage → v2 detector → two-stage policy", async () => {
  const stateRoot = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "scenario-launch-state-"));
  const staging = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "scenario-launch-stage-"));
  try {
    // The retained launch-month dataset: seeded through the real source
    // store, id minted under the research service's own formula so the study
    // below can reuse it by explicit lineage.
    const bounds = studyBounds([T_V090, T_LAUNCH, T_V110], {
      intervalMs: DAY,
      horizonBars: 1,
      now: STUDY_NOW,
      entryBasis: "first_closed_bar_after_event",
    });
    assert.equal(bounds.fromMs, WINDOW_START_MS);
    assert.equal(bounds.toMs, WINDOW_END_MS);
    const dataset = seedGraphDataset({
      environmentId: ENV_A,
      poolId: POOL_A,
      deployment: DEPLOYMENT_A,
      endpoint: "https://graph.example.test",
      blockNumber: BLOCK_A,
      blockHash: BLOCK_HASH_A,
      fromMs: bounds.fromMs,
      toMs: bounds.toMs,
      fetchedAtMs: C4,
      observations: launchMonthObservations,
    });
    const datasetSourceId = `graph-dataset:${dataset.datasetId}`;

    const transport = flipTransport([V100_UNDATED, V090]);
    const runner = makeScenarioRunner({
      detect: mirrorLaunchDetect([datasetSourceId, RELEASE_SOURCE_ID], 8),
      propose: mirrorLaunchPropose,
    });
    return await withScenarioWorld(
      {
        environmentId: ENV_A,
        stateRoot,
        sourceEnv: { T3_EXTERNAL_GITHUB_RELEASES: "atlas-labs/atlas" },
        transport,
        runner: runner.runner,
        graphSource: reuseOnlyGraphSource({
          poolId: POOL_A,
          deployment: DEPLOYMENT_A,
          latestBlock: BLOCK_A,
        }),
      },
      async (world) => {
        await Effect.runPromise(
          dataset.insert.pipe(Effect.provideService(ForgeSourceStore, world.graph)),
        );

        const importOnce = async (now: number) => {
          const result = await Effect.runPromise(
            world.importer.importExternalSource({
              environmentId: ENV_A,
              eventSetName: SET_NAME,
              now,
              threadId: THREAD_A,
            }),
          );
          assert.equal(
            result.outcome,
            "ok",
            `the synthetic import must succeed: ${result.outcome === "refused" ? result.reason : ""}`,
          );
          if (result.outcome !== "ok") throw new Error("unreachable");
          return result;
        };

        const latestEvaluation = async () =>
          Effect.runPromise(world.runs.latestEvaluation(ENV_A, CAP_A));

        const evaluateOnce = async () => {
          await Effect.runPromise(
            world.reactor.enqueueEvaluation({
              environmentId: ENV_A,
              threadId: THREAD_A,
              capabilityId: CAP_A,
              programKind: 2,
            }),
          );
          await Effect.runPromise(world.reactor.drain());
          const jobs = await Effect.runPromise(world.reactor.listJobs({ environmentId: ENV_A }));
          assert.equal(jobs[0]?.status, "complete", jobs[0]?.detail ?? "job must complete");
          const evaluation = await latestEvaluation();
          assert.isNotNull(evaluation);
          return evaluation!;
        };

        // ---- Phase 1: capture before the launch; the release exists undated ----
        const import1 = await importOnce(C1);
        assert.equal(import1.skippedUnpublished, 1);
        assert.equal(import1.correctionsObserved, 2);
        assert.deepEqual(
          import1.eventSet.occurrences.map((occurrence) => occurrence.label),
          ["v0.9.0"],
        );
        assert.equal(import1.eventSet.occurrences[0]?.startAt, T_V090);
        assert.equal(import1.firstObservedFromMs, C1);
        assert.equal(import1.firstObservedToMs, C1);
        assert.include(import1.availabilityNote, "not availability times");
        const undatedHead = await Effect.runPromise(
          world.external.latestRevision({
            environmentId: ENV_A,
            sourceKind: "github-releases",
            documentIdentity: DOC_IDENTITY_V100,
          }),
        );
        assert.isNotNull(undatedHead);
        assert.isNull(undatedHead?.revision.correctionOf);

        // ---- Phase 2: author, validate, install, and arm the detector ---------
        const detectorSource = launchDetectorSource({
          datasetSourceId,
          releaseSourceId: RELEASE_SOURCE_ID,
        });
        const testSource = launchTestSource({
          datasetSourceId,
          releaseSourceId: RELEASE_SOURCE_ID,
        });
        const policySource = launchPolicySource;
        const manifestJson = detectorManifest({
          capabilityId: CAP_A,
          version: 1,
          semantics:
            "synthetic launch-surge detector: activity threshold plus a dated in-window release",
          requiredSourceIds: [datasetSourceId, RELEASE_SOURCE_ID],
          outputFactKeys: ["launch-surge"],
          detectorSource,
          testSource,
          policySource,
          createdAtMs: C2 - 60_000,
        });
        for (const [name, content] of Object.entries({
          "detector.ts": detectorSource,
          "detector.test.ts": testSource,
          "policy.ts": policySource,
          "manifest.json": manifestJson,
        })) {
          await NodeFs.writeFile(NodePath.join(staging, name), content, "utf8");
        }
        const prepared = await Effect.runPromise(
          world.builder.prepare({
            environmentId: ENV_A,
            threadId: THREAD_A,
            capabilityId: CAP_A,
            requestedSemantics: "detect a launch surge around the dated atlas 1.0.0 release",
            stagingDir: staging,
            manifestVersion: 2,
          }),
        );
        const checked = await Effect.runPromise(
          world.builder.check({
            buildId: prepared.build.buildId,
            environmentId: ENV_A,
            stagingDir: staging,
            acceptanceCases: [],
            acceptanceV2: launchAcceptanceCases(datasetSourceId),
          }),
        );
        assert.equal(checked.build.stage, "ready");
        assert.isDefined(checked.staged);
        assert.equal(checked.build.acceptance?.passed, 3);
        // The staged bundle mounts the exact host SDK bytes.
        assert.equal(checked.staged?.contents["sdk.ts"], FORGE_SDK_SOURCE_V2);

        const installed = await Effect.runPromise(
          world.capabilities.install({
            environmentId: ENV_A,
            capabilityId: CAP_A,
            version: 1,
            bundleSha256: checked.staged?.version.bundleSha256 ?? "",
            expectedActiveVersion: null,
          }),
        );
        assert.equal(installed.status, "installed");
        assert.isTrue(
          await Effect.runPromise(
            world.capabilities.arm({ environmentId: ENV_A, capabilityId: CAP_A }),
          ),
        );
        const reactorDetectFrom = runner.detectorStdins.length;

        // ---- Phase 3: BEFORE — the undated launch is a decisive negative -------
        const before = await evaluateOnce();
        assert.equal(before.result.status, "not-matched");
        if (before.result.status === "not-matched") {
          assert.include(before.result.explanation, "no dated publication instant");
        }
        const beforeInput = runner.detectorStdins[reactorDetectFrom] as
          | MirrorDetectorInput
          | undefined;
        assert.isDefined(beforeInput);
        assert.deepEqual(
          (beforeInput?.sources ?? []).map((source) => source.sourceId),
          [datasetSourceId, RELEASE_SOURCE_ID],
        );
        // The sealed window carried the published boolean but NO publication-ms
        // fact: the undated document cannot anchor the launch instant.
        assert.isTrue(
          (beforeInput?.facts ?? []).some(
            (fact) =>
              fact.key === "external.document.published" &&
              fact.value.kind === "boolean" &&
              fact.value.value,
          ),
        );
        assert.isFalse(
          (beforeInput?.facts ?? []).some(
            (fact) => fact.key === "external.document.publication-ms",
          ),
        );

        // ---- Phase 4: the launch ships; the dated correction flips the match ---
        transport.setPage([V100_DATED, V090]);
        const import2 = await importOnce(C2);
        assert.equal(import2.correctionsObserved, 1);
        assert.deepEqual(
          import2.eventSet.occurrences.map((occurrence) => occurrence.label),
          ["v0.9.0", "v1.0.0"],
        );
        assert.equal(import2.eventSet.occurrences[1]?.startAt, T_LAUNCH);
        assert.equal(import2.firstObservedFromMs, C1);
        assert.equal(import2.firstObservedToMs, C2);
        const datedHead = await Effect.runPromise(
          world.external.latestRevision({
            environmentId: ENV_A,
            sourceKind: "github-releases",
            documentIdentity: DOC_IDENTITY_V100,
          }),
        );
        assert.isNotNull(datedHead);
        assert.isNull(datedHead?.retraction);
        // The dated document is a genuine revision-chain step over the undated one.
        assert.equal(datedHead?.revision.correctionOf, undatedHead?.revision.revisionId);

        const around = await evaluateOnce();
        assert.equal(around.result.status, "matched");
        if (around.result.status === "matched") {
          assert.equal(around.result.occurrenceKey, `launch-surge:${T_LAUNCH}`);
          // The matched evaluation cites the dataset and the DATED revision.
          assert.deepEqual(around.result.evidenceIds, [
            dataset.datasetId,
            datedHead?.revision.revisionId,
          ]);
        }
        const aroundInput = runner.detectorStdins[runner.detectorStdins.length - 1];
        const publicationFact = (aroundInput?.facts ?? []).find(
          (fact) => fact.key === "external.document.publication-ms",
        );
        assert.isDefined(publicationFact);
        assert.equal(
          publicationFact?.value.kind === "decimal" ? Number(publicationFact.value.value) : null,
          T_LAUNCH,
        );

        // ---- Phase 5: the policy — entry, idempotent re-run --------------------
        const proposed = await Effect.runPromise(
          world.policy.proposeEnvelope({
            environmentId: ENV_A,
            envelope: launchEnvelope(forgeSha256Hex(detectorSource), forgeSha256Hex(policySource)),
            now: Date.now(),
            proposedVia: "scenario-fixture",
            capabilityId: CAP_A,
          }),
        );
        assert.equal(proposed.status, "proposed");
        const approved = await Effect.runPromise(
          world.policy.approveEnvelope({
            envelopeId: proposed.status === "proposed" ? proposed.envelopeId : "",
            now: Date.now(),
            approvedVia: "local-operator",
          }),
        );
        assert.equal(approved.status, "approved");
        const envelopeId = proposed.status === "proposed" ? proposed.envelopeId : "";

        const entry = await Effect.runPromise(
          world.policy.evaluatePolicy({
            environmentId: ENV_A,
            capabilityId: CAP_A,
            now: Date.now(),
          }),
        );
        assert.equal(entry.status, "proposed");
        if (entry.status !== "proposed") throw new Error("unreachable");
        assert.equal(entry.proposal.kind, "swap");
        if (entry.proposal.kind === "swap") {
          assert.equal(entry.proposal.stageKey, "entry");
          assert.equal(entry.proposal.amountInRaw, "1000000");
          assert.equal(entry.proposal.detectorEvaluationId, around.evaluationId);
          assert.equal(entry.proposal.occurrenceKey, `launch-surge:${T_LAUNCH}`);
        }
        const replay = await Effect.runPromise(
          world.policy.evaluatePolicy({
            environmentId: ENV_A,
            capabilityId: CAP_A,
            now: Date.now(),
          }),
        );
        assert.equal(replay.status, "already-proposed");
        if (replay.status === "already-proposed") assert.equal(replay.proposalId, entry.proposalId);

        // ---- Phase 6: a NEW matched evaluation proposes the exit stage ---------
        const aroundAgain = await evaluateOnce();
        assert.equal(aroundAgain.result.status, "matched");
        assert.notEqual(aroundAgain.evaluationId, around.evaluationId);
        const exit = await Effect.runPromise(
          world.policy.evaluatePolicy({
            environmentId: ENV_A,
            capabilityId: CAP_A,
            now: Date.now(),
          }),
        );
        assert.equal(exit.status, "proposed");
        if (exit.status !== "proposed") throw new Error("unreachable");
        assert.equal(exit.proposal.kind, "swap");
        if (exit.proposal.kind === "swap") {
          assert.equal(exit.proposal.stageKey, "exit");
          assert.equal(exit.proposal.detectorEvaluationId, aroundAgain.evaluationId);
        }
        const listed = await Effect.runPromise(world.policy.listProposals({ envelopeId }));
        assert.deepEqual(
          listed.map((record) =>
            record.proposal.kind === "swap" ? record.proposal.stageKey : record.proposal.kind,
          ),
          ["exit", "entry"],
        );

        // ---- Phase 7: the graph research path, over the imported event set -----
        transport.setPage([V110, V100_DATED, V090]);
        const import3 = await importOnce(C3);
        assert.equal(import3.correctionsObserved, 1);
        assert.equal(import3.eventSet.occurrences.length, 3);
        const study = await Effect.runPromise(
          world.research.loadStudyDataset({
            environmentId: ENV_A,
            poolId: POOL_A,
            market: "ETH",
            entryBasis: "first_closed_bar_after_event",
            occurrences: import3.eventSet.occurrences,
            intervalMs: DAY,
            horizonBars: 1,
            now: STUDY_NOW,
            datasetId: dataset.datasetId,
          }),
        );
        assert.equal(study.status, "ok", study.status === "unavailable" ? study.reason : "");
        if (study.status !== "ok") throw new Error("unreachable");
        assert.isTrue(study.dataset.reused);
        // THE LINEAGE TIE: the study served exactly the dataset the detector's
        // manifest names as its required graph source.
        assert.equal(study.dataset.manifest.id, dataset.datasetId);
        const buckets = candleFeatures(study.dataset.candles);
        assert.equal(buckets.length, 2);
        assert.equal(buckets[0]?.trades, 4);
        assert.equal(buckets[1]?.trades, 8);
        assert.isTrue((buckets[1]?.close ?? 0) > (buckets[1]?.open ?? 0));
        assert.isTrue((buckets[1]?.close ?? 0) > (buckets[0]?.close ?? 0));
        assert.isTrue((buckets[1]?.volume ?? 0) > (buckets[0]?.volume ?? 0));

        // ---- Phase 8: AFTER — the withdrawn date is a decisive negative again --
        transport.setPage([V110, V100_WITHDRAWN, V090]);
        const import4 = await importOnce(C4);
        assert.equal(import4.skippedUnpublished, 1);
        assert.deepEqual(
          import4.eventSet.occurrences.map((occurrence) => occurrence.label),
          ["v0.9.0", "v1.1.0"],
        );
        const after = await evaluateOnce();
        assert.equal(after.result.status, "not-matched");
        if (after.result.status === "not-matched") {
          assert.include(after.result.explanation, "no dated publication instant");
        }
        const noProposal = await Effect.runPromise(
          world.policy.evaluatePolicy({
            environmentId: ENV_A,
            capabilityId: CAP_A,
            now: Date.now(),
          }),
        );
        assert.equal(noProposal.status, "no-proposal");
        if (noProposal.status === "no-proposal") {
          assert.include(noProposal.reason, "not-matched");
        }

        // The whole chain ran through the scripted container: builds (typecheck +
        // generated tests) plus detector evaluations and policy evaluations.
        assert.deepEqual(runner.buildHeads, ["forge-typecheck", "forge-test"]);
        assert.isAtLeast(runner.detectorStdins.length, reactorDetectFrom + 4);
        assert.isAtLeast(runner.policyStdins.length, 3);
      },
    );
  } finally {
    await NodeFs.rm(stateRoot, { recursive: true, force: true });
    await NodeFs.rm(staging, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The compile-and-run probe: the faked typecheck/test steps, made honest
// ---------------------------------------------------------------------------

it("scenario A: the fixture bundle compiles under the runner's tsc flags and its generated tests pass", async () => {
  const detectorSource = launchDetectorSource({
    datasetSourceId: "graph-dataset:ds_scenariolaunch",
    releaseSourceId: "external:github-releases:github-release:atlas-labs/atlas:v1.0.0",
  });
  const compiled = await compileScenarioPrograms({
    detectorSource,
    testSource: launchTestSource({
      datasetSourceId: "graph-dataset:ds_scenariolaunch",
      releaseSourceId: "external:github-releases:github-release:atlas-labs/atlas:v1.0.0",
    }),
    policySource: launchPolicySource,
  });
  try {
    const testCount = await compiled.runGeneratedTests();
    assert.isAtLeast(testCount, 3);

    // The compiled sync entries behave exactly as the mirrors claim.
    const matched = compiled.detect({
      programSchemaVersion: 2,
      asOfMs: CASE_AS_OF,
      inputDigest: "d".repeat(64),
      facts: [
        {
          id: "f1",
          key: "graph.pool.observation-count",
          entityId: POOL_A,
          value: { kind: "decimal", value: "12", unit: "observations" },
          evidence: [],
        },
        {
          id: "f2",
          key: "graph.pool.trade-window-start-ms",
          entityId: POOL_A,
          value: { kind: "decimal", value: String(WINDOW_START_MS), unit: "ms" },
          evidence: [],
        },
        {
          id: "f3",
          key: "graph.pool.trade-window-end-ms",
          entityId: POOL_A,
          value: { kind: "decimal", value: String(WINDOW_END_MS), unit: "ms" },
          evidence: [],
        },
        {
          id: "f4",
          key: "external.document.published",
          entityId: DOC_IDENTITY_V100,
          value: { kind: "boolean", value: true },
          evidence: [],
        },
        {
          id: "f5",
          key: "external.document.publication-ms",
          entityId: DOC_IDENTITY_V100,
          value: { kind: "decimal", value: String(T_LAUNCH), unit: "ms" },
          evidence: [],
        },
      ],
      sources: [
        {
          sourceId: "graph-dataset:ds_scenariolaunch",
          evidenceId: "ev_graph",
          mode: "fixture",
          contentSha256: "b".repeat(64),
          complete: true,
          availabilityBasis: "recorded",
        },
        {
          sourceId: "external:github-releases:github-release:atlas-labs/atlas:v1.0.0",
          evidenceId: "ev_doc",
          mode: "fixture",
          contentSha256: "c".repeat(64),
          complete: true,
          availabilityBasis: "recorded",
        },
      ],
    }) as { result: { status: string; occurrenceKey?: string } };
    assert.equal(matched.result.status, "matched");
    assert.equal(matched.result.occurrenceKey, `launch-surge:${T_LAUNCH}`);

    const envelope = launchEnvelope(
      forgeSha256Hex(detectorSource),
      forgeSha256Hex(launchPolicySource),
    );
    const policyInput = (evaluationId: string) => ({
      policySchemaVersion: 2,
      asOfMs: CASE_AS_OF,
      envelope,
      detectorEvaluation: {
        evaluationId,
        asOfMs: CASE_AS_OF - 10_000,
        result: {
          status: "matched",
          occurrenceKey: `launch-surge:${T_LAUNCH}`,
          validUntilMs: CASE_AS_OF + 3_600_000,
        },
      },
      priorProposals: [],
      remainingInputCapRaw: "3000000",
    });
    const entry = compiled.propose(policyInput("dtev_entry")) as {
      proposal: { kind: string; stageKey?: string };
    };
    assert.equal(entry.proposal.kind, "swap");
    assert.equal(entry.proposal.stageKey, "entry");
    const exit = compiled.propose({
      ...policyInput("dtev_exit"),
      priorProposals: [
        {
          stageKey: "entry",
          kind: "swap" as const,
          amountInRaw: "1000000",
          occurredAtMs: CASE_AS_OF,
        },
      ],
      priorState: { stateSchemaVersion: 1, state: { runs: 1, entryFor: "dtev_entry" } },
    }) as { proposal: { kind: string; stageKey?: string } };
    assert.equal(exit.proposal.kind, "swap");
    assert.equal(exit.proposal.stageKey, "exit");
  } finally {
    await compiled.cleanup();
  }
});
