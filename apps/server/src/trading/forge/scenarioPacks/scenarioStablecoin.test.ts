/**
 * SCENARIO B — "USDX stablecoin report" (issuer attestation + depeg
 * observation), the second of the two P7 generality packs.
 *
 * WHAT THIS SCENARIO PROVES
 *
 * A fictional issuer ("usdx-labs/usdx") publishes reserve-attestation
 * documents with a MATERIALLY DIFFERENT shape than scenario A's releases —
 * tagless entries (document identity keys on the numeric id, the occurrence
 * carries no label), restated content (a real revision chain), and finally a
 * retraction (the GitHub family never retracts itself; the retraction rides
 * the external source store's public insert surface, which is where any
 * non-GitHub feed family enters). A fictional USDX/USDC pool dataset shows a
 * price that has fallen 3.5% below peg inside its window.
 *
 * The SAME engines scenario A used — connector, import service, event
 * service, builder, capability store, fact window, reactor, run store,
 * execution-policy service — run a DIFFERENT detector relation (a price-level
 * depeg observation instead of an activity threshold) and a DIFFERENT policy
 * shape (single stage with a stop-future-actions path instead of two stages):
 *
 *   attestation captured + imported (tagless shape)
 *     → fixture-authored v2 bundle validated by the REAL builder, installed,
 *       ARMED
 *     → matched depeg evaluation → single "convert" proposal under an
 *       approved envelope
 *     → the CORRECTED attestation surfaces: the fact window resolves the
 *       chain HEAD (the corrected revision's id is in the sealed sources),
 *       the pre-correction evaluation is NOT silently reused — a NEW
 *       evaluation commits — and the policy answers the second matched
 *       evaluation with stop-future-actions, never a second conversion
 *     → the RETRACTED attestation is absence: the detector's result is
 *       unknown with the source named, and the host refuses to run the
 *       policy at all (no-proposal).
 *
 * THE NO-CORE-CHANGES PROOF
 *
 * This file imports ONLY the public service layers and their existing test
 * seams, exactly as scenarioLaunch.test.ts does. The core-service diff for
 * adding this scenario to the same engine is empty: every difference lives
 * in fixtures (document shapes, dataset content, detector/policy programs,
 * envelope) — which is the P7 generality claim made executable.
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
  compileScenarioPrograms,
  DEPEG_PUBLICATION_MS,
  DEPEG_WINDOW_END_MS,
  DEPEG_WINDOW_START_MS,
  detectorManifest,
  depegDetectorSource,
  depegPolicySource,
  depegTestSource,
  flipTransport,
  makeScenarioRunner,
  mirrorDepegDetect,
  mirrorDepegPropose,
  reuseOnlyGraphSource,
  seedGraphDataset,
  syntheticSwap,
  withScenarioWorld,
} from "./scenarioFixtures.ts";

// ---------------------------------------------------------------------------
// The synthetic fixture world (all fictional, all labeled)
// ---------------------------------------------------------------------------

const ENV_B = "env_scenario_depeg";
const THREAD_B = "thread_scenario_depeg";
const CAP_B = "depeg-observation-detector";
const SET_NAME = "usdx attestations (synthetic)";
const POOL_B: `0x${string}` = `0x${"de".repeat(20)}`;
const DEPLOYMENT_B = "QmscenarioB";
const BLOCK_B = 19_000_002;
const BLOCK_HASH_B = `0x${"ef".repeat(32)}`;

const B1 = Date.parse("2026-08-24T12:05:00Z"); // first sighting of the attestation
const B2 = Date.parse("2026-08-25T09:00:00Z"); // the issuer restates the figures
const B3 = Date.parse("2026-08-26T08:00:00Z"); // the issuer retracts the attestation

const ATTESTATION_URL = "https://github.com/usdx-labs/usdx/releases/attestation-2026-08";

/** One synthetic tagless attestation entry as the fake GitHub page serves it. */
const attestation = (overrides?: Record<string, unknown>) => ({
  id: 9001,
  tag_name: null,
  name: "USDX reserve attestation 2026-08",
  body: "reserves 1.02x (synthetic fixture)",
  published_at: "2026-08-24T12:00:00Z",
  html_url: ATTESTATION_URL,
  ...overrides,
});

const DOC_IDENTITY_B = "github-release:usdx-labs/usdx:9001";
const ATTESTATION_SOURCE_ID = `external:github-releases:${DOC_IDENTITY_B}`;

const unixSeconds = (ms: number): number => Math.floor(ms / 1000);

/** Synthetic USDX swaps drifting from the peg to 3.5% below inside the window. */
const depegWindowObservations = [
  syntheticSwap({
    seq: 101,
    timestamp: unixSeconds(Date.parse("2026-08-22T14:00:00Z")),
    poolId: POOL_B,
    priceMicros: 999_000,
    volumeMicros: 400_000,
  }),
  syntheticSwap({
    seq: 102,
    timestamp: unixSeconds(Date.parse("2026-08-22T20:00:00Z")),
    poolId: POOL_B,
    priceMicros: 997_000,
    volumeMicros: 350_000,
  }),
  syntheticSwap({
    seq: 103,
    timestamp: unixSeconds(Date.parse("2026-08-23T10:00:00Z")),
    poolId: POOL_B,
    priceMicros: 994_000,
    volumeMicros: 500_000,
  }),
  syntheticSwap({
    seq: 104,
    timestamp: unixSeconds(Date.parse("2026-08-24T13:00:00Z")),
    poolId: POOL_B,
    priceMicros: 985_000,
    volumeMicros: 900_000,
  }),
  syntheticSwap({
    seq: 105,
    timestamp: unixSeconds(Date.parse("2026-08-25T11:00:00Z")),
    poolId: POOL_B,
    priceMicros: 972_000,
    volumeMicros: 1_300_000,
  }),
  syntheticSwap({
    seq: 106,
    timestamp: unixSeconds(Date.parse("2026-08-26T06:00:00Z")),
    poolId: POOL_B,
    priceMicros: 965_000,
    volumeMicros: 1_500_000,
  }),
];

/** The envelope a human approves for the depeg capability (synthetic caps). */
const depegEnvelope = (detectorSha: string, policySha: string): ExecutionEnvelope => ({
  revision: 1,
  environmentId: ENV_B,
  accountId: "acct-scenario-depeg",
  expiresAtMs: 4_102_444_800_000,
  detectorBundleSha256: detectorSha,
  policyBundleSha256: policySha,
  candidates: [
    {
      candidateId: "cand_usdx_usdc_convert",
      chainId: "11155111",
      tokenIn: `0x${"dd".repeat(20)}`,
      tokenOut: `0x${"ee".repeat(20)}`,
      recipient: `0x${"ff".repeat(20)}`,
      label: "synthetic USDX->USDC conversion (scenario B)",
    },
  ],
  inputCapTotalRaw: "600000000",
  inputCapPerSwapRaw: "600000000",
  maxGasWei: "200000000000000",
  maxSlippageBps: 30,
  maxTransactions: 2,
  maxConcurrentIntents: 1,
});

// ---------------------------------------------------------------------------
// Host-authored acceptance cases for the builder (sealed synthetic inputs)
// ---------------------------------------------------------------------------

const CASE_AS_OF_B = 1_756_060_000_000;

const caseEvidenceB = (id: string, sourceId: string) => ({
  id,
  environmentId: ENV_B,
  sourceId,
  mode: "fixture" as const,
  contentSha256: "a".repeat(64),
  eventAtMs: 1_756_000_000_000,
  availableAtMs: 1_756_000_000_000,
  availabilityBasis: "recorded" as const,
  timePrecision: "second" as const,
  capturedAtMs: 1_756_000_000_000,
  expiresAtMs: 1_756_060_000_000,
  sourceRevision: "rev_case",
});

const caseSourceB = (sourceId: string, evidenceId: string) => ({
  sourceId,
  evidenceId,
  mode: "fixture" as const,
  contentSha256: "b".repeat(64),
  complete: true,
  availabilityBasis: "recorded" as const,
});

const decimalCaseFactB = (id: string, sourceId: string, key: string, value: string) => ({
  id,
  key,
  entityId: POOL_B,
  value: { kind: "decimal" as const, value, unit: "case" },
  evidence: [caseEvidenceB("ev_case_graph", sourceId)],
});

const depegAcceptanceCases = (datasetSourceId: string): ReadonlyArray<ForgeAcceptanceCaseV2> => {
  const graphFacts = (lastPrice: string) => [
    decimalCaseFactB("cf_price", datasetSourceId, "graph.pool.last-price-micros", lastPrice),
    decimalCaseFactB(
      "cf_start",
      datasetSourceId,
      "graph.pool.trade-window-start-ms",
      String(DEPEG_WINDOW_START_MS),
    ),
    decimalCaseFactB(
      "cf_end",
      datasetSourceId,
      "graph.pool.trade-window-end-ms",
      String(DEPEG_WINDOW_END_MS),
    ),
  ];
  const publishedFact = {
    id: "cf_pub",
    key: "external.document.published",
    entityId: DOC_IDENTITY_B,
    value: { kind: "boolean" as const, value: true },
    evidence: [caseEvidenceB("ev_case_doc", ATTESTATION_SOURCE_ID)],
  };
  const publicationFact = decimalCaseFactB(
    "cf_pubms",
    ATTESTATION_SOURCE_ID,
    "external.document.publication-ms",
    String(DEPEG_PUBLICATION_MS),
  );
  const matchedFacts = [...graphFacts("965000"), publishedFact, publicationFact];
  return [
    {
      name: "matched-when-price-below-band-and-attestation-corroborated",
      input: {
        programSchemaVersion: 2 as const,
        asOfMs: CASE_AS_OF_B,
        inputDigest: "d".repeat(64),
        facts: matchedFacts,
        sources: [
          caseSourceB(datasetSourceId, "ev_case_graph"),
          caseSourceB(ATTESTATION_SOURCE_ID, "ev_case_doc"),
        ],
        priorState: { stateSchemaVersion: 1, state: { runs: 2, lastPriceMicros: 999_000 } },
      },
      expected: {
        result: {
          status: "matched",
          occurrenceKey: `depeg-observation:${DEPEG_PUBLICATION_MS}:965000`,
          evidenceIds: ["ev_case_graph", "ev_case_doc"],
          facts: matchedFacts,
          validUntilMs: CASE_AS_OF_B + 3_600_000,
        },
        nextState: { stateSchemaVersion: 1, state: { runs: 3, lastPriceMicros: 999_000 } },
      },
    },
    {
      name: "price-at-peg-is-not-matched",
      input: {
        programSchemaVersion: 2 as const,
        asOfMs: CASE_AS_OF_B,
        inputDigest: "d".repeat(64),
        facts: [...graphFacts("995000"), publishedFact, publicationFact],
        sources: [
          caseSourceB(datasetSourceId, "ev_case_graph"),
          caseSourceB(ATTESTATION_SOURCE_ID, "ev_case_doc"),
        ],
      },
      expected: {
        result: {
          status: "not-matched",
          evidenceIds: ["ev_case_graph", "ev_case_doc"],
          explanation: "last price 995000 micros is within the 3% depeg band of the peg",
        },
        nextState: { stateSchemaVersion: 1, state: { runs: 1 } },
      },
    },
    {
      name: "missing-attestation-source-is-unknown",
      input: {
        programSchemaVersion: 2 as const,
        asOfMs: CASE_AS_OF_B,
        inputDigest: "d".repeat(64),
        facts: [...graphFacts("965000")],
        sources: [caseSourceB(datasetSourceId, "ev_case_graph")],
      },
      expected: {
        result: {
          status: "unknown",
          missingSourceIds: [ATTESTATION_SOURCE_ID],
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

it("scenario B: tagless attestation → depeg detector → single convert → correction surfaces → retraction unknown", async () => {
  const stateRoot = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "scenario-depeg-state-"));
  const staging = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "scenario-depeg-stage-"));
  try {
    // The retained depeg-window dataset: seeded through the real source store
    // under the same content-formula id discipline (no study runs in this
    // scenario — the detector's fact window reads the row by id).
    const dataset = seedGraphDataset({
      environmentId: ENV_B,
      poolId: POOL_B,
      deployment: DEPLOYMENT_B,
      endpoint: "https://graph.example.test",
      blockNumber: BLOCK_B,
      blockHash: BLOCK_HASH_B,
      fromMs: DEPEG_WINDOW_START_MS,
      toMs: DEPEG_WINDOW_END_MS,
      fetchedAtMs: B3,
      observations: depegWindowObservations,
    });
    const datasetSourceId = `graph-dataset:${dataset.datasetId}`;

    const transport = flipTransport([attestation()]);
    const runner = makeScenarioRunner({
      detect: mirrorDepegDetect([datasetSourceId, ATTESTATION_SOURCE_ID], 970_000),
      propose: mirrorDepegPropose,
    });

    return await withScenarioWorld(
      {
        environmentId: ENV_B,
        stateRoot,
        sourceEnv: { T3_EXTERNAL_GITHUB_RELEASES: "usdx-labs/usdx" },
        transport,
        runner: runner.runner,
        graphSource: reuseOnlyGraphSource({
          poolId: POOL_B,
          deployment: DEPLOYMENT_B,
          latestBlock: BLOCK_B,
        }),
      },
      async (world) => {
        await Effect.runPromise(
          dataset.insert.pipe(Effect.provideService(ForgeSourceStore, world.graph)),
        );

        const importOnce = async (now: number) => {
          const result = await Effect.runPromise(
            world.importer.importExternalSource({
              environmentId: ENV_B,
              eventSetName: SET_NAME,
              now,
              threadId: THREAD_B,
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

        const evaluateOnce = async () => {
          await Effect.runPromise(
            world.reactor.enqueueEvaluation({
              environmentId: ENV_B,
              threadId: THREAD_B,
              capabilityId: CAP_B,
              programKind: 2,
            }),
          );
          await Effect.runPromise(world.reactor.drain());
          const jobs = await Effect.runPromise(world.reactor.listJobs({ environmentId: ENV_B }));
          assert.equal(jobs[0]?.status, "complete", jobs[0]?.detail ?? "job must complete");
          const evaluation = await Effect.runPromise(world.runs.latestEvaluation(ENV_B, CAP_B));
          assert.isNotNull(evaluation);
          return evaluation!;
        };

        // ---- Phase 1: the tagless attestation imports with a different shape --
        const import1 = await importOnce(B1);
        assert.equal(import1.correctionsObserved, 1);
        assert.equal(import1.eventSet.occurrences.length, 1);
        const occurrence = import1.eventSet.occurrences[0];
        assert.equal(occurrence?.label, undefined); // tagless: no label, unlike scenario A
        assert.equal(occurrence?.startAt, DEPEG_PUBLICATION_MS);
        assert.equal(occurrence?.source, ATTESTATION_URL);
        const attestationHead = await Effect.runPromise(
          world.external.latestRevision({
            environmentId: ENV_B,
            sourceKind: "github-releases",
            documentIdentity: DOC_IDENTITY_B,
          }),
        );
        assert.isNotNull(attestationHead);
        const originalRevisionId = attestationHead?.revision.revisionId ?? "";

        // ---- Phase 2: author, validate, install, and arm the depeg detector --
        const detectorSource = depegDetectorSource({
          datasetSourceId,
          attestationSourceId: ATTESTATION_SOURCE_ID,
        });
        const testSource = depegTestSource({
          datasetSourceId,
          attestationSourceId: ATTESTATION_SOURCE_ID,
        });
        const policySource = depegPolicySource;
        const manifestJson = detectorManifest({
          capabilityId: CAP_B,
          version: 1,
          semantics:
            "synthetic depeg-observation detector: price level below the 3% band plus a corroborated attestation",
          requiredSourceIds: [datasetSourceId, ATTESTATION_SOURCE_ID],
          outputFactKeys: ["depeg-observation"],
          detectorSource,
          testSource,
          policySource,
          createdAtMs: B1 + 60_000,
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
            environmentId: ENV_B,
            threadId: THREAD_B,
            capabilityId: CAP_B,
            requestedSemantics: "observe a corroborated USDX depeg below the 3% band",
            stagingDir: staging,
            manifestVersion: 2,
          }),
        );
        const checked = await Effect.runPromise(
          world.builder.check({
            buildId: prepared.build.buildId,
            environmentId: ENV_B,
            stagingDir: staging,
            acceptanceCases: [],
            acceptanceV2: depegAcceptanceCases(datasetSourceId),
          }),
        );
        assert.equal(checked.build.stage, "ready");
        assert.equal(checked.build.acceptance?.passed, 3);
        assert.equal(checked.staged?.contents["sdk.ts"], FORGE_SDK_SOURCE_V2);
        const installed = await Effect.runPromise(
          world.capabilities.install({
            environmentId: ENV_B,
            capabilityId: CAP_B,
            version: 1,
            bundleSha256: checked.staged?.version.bundleSha256 ?? "",
            expectedActiveVersion: null,
          }),
        );
        assert.equal(installed.status, "installed");
        assert.isTrue(
          await Effect.runPromise(
            world.capabilities.arm({ environmentId: ENV_B, capabilityId: CAP_B }),
          ),
        );
        const reactorDetectFrom = runner.detectorStdins.length;

        // ---- Phase 3: the corroborated depeg matches; the single convert ----
        const first = await evaluateOnce();
        assert.equal(first.result.status, "matched");
        if (first.result.status === "matched") {
          assert.equal(
            first.result.occurrenceKey,
            `depeg-observation:${DEPEG_PUBLICATION_MS}:965000`,
          );
          assert.deepEqual(first.result.evidenceIds, [dataset.datasetId, originalRevisionId]);
        }
        const firstInput = runner.detectorStdins[reactorDetectFrom];
        const priceFact = (firstInput?.facts ?? []).find(
          (fact) => fact.key === "graph.pool.last-price-micros",
        );
        assert.isDefined(priceFact);
        assert.equal(
          priceFact?.value.kind === "decimal" ? Number(priceFact.value.value) : null,
          965_000,
        );

        const proposed = await Effect.runPromise(
          world.policy.proposeEnvelope({
            environmentId: ENV_B,
            envelope: depegEnvelope(forgeSha256Hex(detectorSource), forgeSha256Hex(policySource)),
            now: Date.now(),
            proposedVia: "scenario-fixture",
            capabilityId: CAP_B,
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

        const convert = await Effect.runPromise(
          world.policy.evaluatePolicy({
            environmentId: ENV_B,
            capabilityId: CAP_B,
            now: Date.now(),
          }),
        );
        assert.equal(convert.status, "proposed");
        if (convert.status !== "proposed") throw new Error("unreachable");
        assert.equal(convert.proposal.kind, "swap");
        if (convert.proposal.kind === "swap") {
          assert.equal(convert.proposal.stageKey, "convert");
          assert.equal(convert.proposal.amountInRaw, "500000000");
          assert.equal(convert.proposal.detectorEvaluationId, first.evaluationId);
        }

        // ---- Phase 4: the CORRECTED attestation surfaces -----------------------
        transport.setPage([attestation({ body: "reserves 1.00x, restated (synthetic fixture)" })]);
        const import2 = await importOnce(B2);
        assert.equal(import2.correctionsObserved, 1);
        assert.equal(import2.eventSet.eventSetId, import1.eventSet.eventSetId);
        const correctedHead = await Effect.runPromise(
          world.external.latestRevision({
            environmentId: ENV_B,
            sourceKind: "github-releases",
            documentIdentity: DOC_IDENTITY_B,
          }),
        );
        const correctedRevisionId = correctedHead?.revision.revisionId ?? "";
        assert.notEqual(correctedRevisionId, originalRevisionId);
        assert.equal(correctedHead?.revision.correctionOf, originalRevisionId);

        const second = await evaluateOnce();
        assert.equal(second.result.status, "matched");
        // NOT a silent reuse: a NEW evaluation committed, and its evidence
        // cites the CORRECTED head — the pre-correction evaluation stands in
        // history untouched.
        assert.notEqual(second.evaluationId, first.evaluationId);
        if (second.result.status === "matched") {
          assert.deepEqual(second.result.evidenceIds, [dataset.datasetId, correctedRevisionId]);
        }
        const secondInput = runner.detectorStdins[runner.detectorStdins.length - 1];
        const externalSource = (secondInput?.sources ?? []).find(
          (source) => source.sourceId === ATTESTATION_SOURCE_ID,
        );
        assert.isDefined(externalSource);
        assert.equal(externalSource?.sourceRevision, correctedRevisionId);
        const listed = await Effect.runPromise(world.runs.listEvaluations(ENV_B, CAP_B));
        assert.equal(listed.length, 2);
        assert.deepEqual(
          listed.map((record) => record.evaluationId),
          [second.evaluationId, first.evaluationId],
        );

        // The single-stage policy STOPS instead of converting a second time.
        const policyRunsBefore = runner.policyStdins.length;
        const stop = await Effect.runPromise(
          world.policy.evaluatePolicy({
            environmentId: ENV_B,
            capabilityId: CAP_B,
            now: Date.now(),
          }),
        );
        assert.equal(stop.status, "proposed");
        if (stop.status !== "proposed") throw new Error("unreachable");
        assert.equal(stop.proposal.kind, "stop-future-actions");
        assert.equal(runner.policyStdins.length, policyRunsBefore + 1);
        const proposals = await Effect.runPromise(world.policy.listProposals({ envelopeId }));
        assert.deepEqual(
          proposals.map((record) =>
            record.proposal.kind === "swap" ? record.proposal.stageKey : record.proposal.kind,
          ),
          ["stop-future-actions", "convert"],
        );

        // ---- Phase 5: the RETRACTED attestation is absence → unknown --------
        // The GitHub connector never retracts; the retraction rides the
        // external source store's public insert surface, which is where any
        // other feed family's connector would write it.
        await Effect.runPromise(
          world.external.insert({
            revision: {
              revisionId: `extrev_${forgeSha256Hex(`${ENV_B}|${DOC_IDENTITY_B}|retraction`)}`,
              environmentId: ENV_B,
              sourceKind: "github-releases",
              documentIdentity: DOC_IDENTITY_B,
              sourceUrl: ATTESTATION_URL,
              contentSha256: forgeSha256Hex("retracted (synthetic fixture)"),
              publishedAtMs: null,
              timePrecision: "instant",
              firstObservedAtMs: B3,
              captureMs: B3,
              correctionOf: correctedRevisionId,
              retracted: true,
            },
            payloadJson: '{"retracted":true,"reason":"attestation withdrawn (synthetic fixture)"}',
          }),
        );
        const third = await evaluateOnce();
        assert.equal(third.result.status, "unknown");
        if (third.result.status === "unknown") {
          assert.deepEqual(third.result.missingSourceIds, [ATTESTATION_SOURCE_ID]);
        }
        assert.deepEqual(third.evidenceIds, [dataset.datasetId]);
        // The host refuses to run the policy at all on unknown evidence: a
        // named no-proposal, and NOT one more contained policy run.
        const policyRunsAfterRetraction = runner.policyStdins.length;
        const noProposal = await Effect.runPromise(
          world.policy.evaluatePolicy({
            environmentId: ENV_B,
            capabilityId: CAP_B,
            now: Date.now(),
          }),
        );
        assert.equal(noProposal.status, "no-proposal");
        if (noProposal.status === "no-proposal") {
          assert.include(noProposal.reason, "unknown");
        }
        assert.equal(runner.policyStdins.length, policyRunsAfterRetraction);
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

it("scenario B: the fixture bundle compiles under the runner's tsc flags and its generated tests pass", async () => {
  const detectorSource = depegDetectorSource({
    datasetSourceId: "graph-dataset:ds_scenariodepeg",
    attestationSourceId: "external:github-releases:github-release:usdx-labs/usdx:9001",
  });
  const compiled = await compileScenarioPrograms({
    detectorSource,
    testSource: depegTestSource({
      datasetSourceId: "graph-dataset:ds_scenariodepeg",
      attestationSourceId: "external:github-releases:github-release:usdx-labs/usdx:9001",
    }),
    policySource: depegPolicySource,
  });
  try {
    const testCount = await compiled.runGeneratedTests();
    assert.isAtLeast(testCount, 3);

    // The compiled sync entries behave exactly as the mirrors claim: the
    // single convert first, then stop-future-actions on a second matched
    // evaluation, and stop-future-actions on unknown evidence.
    const envelope = depegEnvelope(
      forgeSha256Hex(detectorSource),
      forgeSha256Hex(depegPolicySource),
    );
    const matchedEvaluation = {
      evaluationId: "dtev_depeg_1",
      asOfMs: CASE_AS_OF_B - 10_000,
      result: {
        status: "matched" as const,
        occurrenceKey: `depeg-observation:${DEPEG_PUBLICATION_MS}:965000`,
        validUntilMs: CASE_AS_OF_B + 3_600_000,
      },
    };
    const convert = compiled.propose({
      policySchemaVersion: 2,
      asOfMs: CASE_AS_OF_B,
      envelope,
      detectorEvaluation: matchedEvaluation,
      priorProposals: [],
      remainingInputCapRaw: "600000000",
    }) as { proposal: { kind: string; stageKey?: string } };
    assert.equal(convert.proposal.kind, "swap");
    assert.equal(convert.proposal.stageKey, "convert");

    const stop = compiled.propose({
      policySchemaVersion: 2,
      asOfMs: CASE_AS_OF_B + 1_000,
      envelope,
      detectorEvaluation: { ...matchedEvaluation, evaluationId: "dtev_depeg_2" },
      priorProposals: [
        {
          stageKey: "convert",
          kind: "swap" as const,
          amountInRaw: "500000000",
          occurredAtMs: CASE_AS_OF_B,
        },
      ],
      priorState: { stateSchemaVersion: 1, state: { runs: 1 } },
      remainingInputCapRaw: "600000000",
    }) as { proposal: { kind: string; reason?: string } };
    assert.equal(stop.proposal.kind, "stop-future-actions");
    assert.include(stop.proposal.reason ?? "", "already proposed");

    const stopUnknown = compiled.propose({
      policySchemaVersion: 2,
      asOfMs: CASE_AS_OF_B + 2_000,
      envelope,
      detectorEvaluation: {
        evaluationId: "dtev_depeg_3",
        asOfMs: CASE_AS_OF_B,
        result: { status: "unknown" as const, explanation: "attestation absent" },
      },
      priorProposals: [
        {
          stageKey: "convert",
          kind: "swap" as const,
          amountInRaw: "500000000",
          occurredAtMs: CASE_AS_OF_B,
        },
      ],
      priorState: { stateSchemaVersion: 1, state: { runs: 2 } },
      remainingInputCapRaw: "600000000",
    }) as { proposal: { kind: string; reason?: string } };
    assert.equal(stopUnknown.proposal.kind, "stop-future-actions");
    assert.include(stopUnknown.proposal.reason ?? "", "unknown");
  } finally {
    await compiled.cleanup();
  }
});
