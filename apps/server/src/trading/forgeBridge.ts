/**
 * forgeBridge — the U0 server↔client bridge for T3 Forge.
 *
 * The WS handlers in `ws.ts` are thin wrappers; every wire shape is assembled
 * here from the Forge services' own read results, so the mapping is unit
 * testable without a socket. The mapping rules this module owns:
 *
 * - An unavailable service answer becomes a named unavailable state, never
 *   zeros and never a failed RPC.
 * - Older evaluation evidence without diagnostics surfaces
 *   `detailUnavailable`; counts are not reconstructed or invented.
 * - v2 detector summaries ride their own optional thread-context slot,
 *   scoped by the preparing thread the installed bundle's build receipt
 *   records — never a fabricated scope, and never rendered into the v1
 *   evaluation slot the record cannot honestly fill.
 * - The same-window v1/v2 comparison is explicitly unavailable until F5
 *   produces revision records.
 * - Expiry judgements stand on the chain snapshot's own block time; a client
 *   clock is never evidence.
 * - The LP share of a swap fee stays null until transaction-order evidence
 *   exists — the decoded receipt's Swap event carries the TOTAL fee only.
 *
 * @module forgeBridge
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  ForgeControlResult,
  ForgeDetectorEvaluationsView,
  ForgeDetectorEvaluationSummary,
  ForgeEvidenceDetail,
  ForgeFreshlyConfirmedExpiry,
  ForgeLatestEvaluationSummary,
  ForgePoolStateChain,
  ForgePoolStatePosition,
  ForgePoolStateProposal,
  ForgePoolStatePublication,
  ForgePoolStateTransaction,
  ForgePoolStateTransactions,
  ForgePoolStateView,
  ForgePoolSeriesView,
  ForgeRevisionComparison,
  ForgeThreadContextView,
  OrchestrationGetForgeEvidenceResult,
  OrchestrationGetForgePoolSeriesInput,
} from "@t3tools/contracts";
import {
  FORGE_BRIDGE_TX_PAGE,
  FORGE_DETECTOR_SUMMARY_MAX_EVIDENCE,
  OrchestrationGetSnapshotError,
} from "@t3tools/contracts";
import type {
  DetectorEvaluationRecordV2,
  ForgeCapabilityCatalogEntry,
  ForgeEvaluationEvidence,
} from "@t3tools/trading-contracts";
import { toForgeDetectorResultSummary } from "@t3tools/trading-contracts";

// Re-exported beside the mapper that produces it: the wire summary type this
// module owns the composition of.
export type { ForgeDetectorEvaluationSummary };

import {
  ForgeSourceReads,
  type ForgePoolSeriesRead,
  type ForgePoolSeriesReadInput,
} from "./forge/ForgeSourceReads.ts";
import {
  FeePolicyService,
  type ForgeDirectControlsRead,
  type ForgeOperationResult,
  type ForgePolicyStateRead,
  type ForgePoolProposalRead,
  type ForgePositionStateRead,
} from "./forge/FeePolicyService.ts";
import {
  ForgeCapabilityStore,
  versionProgramKind,
  type ForgeCapabilityStoreShape,
} from "./forge/CapabilityStore.ts";
import { DetectorRunStore } from "./forge/DetectorRunStore.ts";
import type { ForgeIntentRecord } from "./forge/UniswapTestnetAdapter.ts";

/** The honest comparison answer until F5 ships revision evidence. */
export const FORGE_COMPARISON_UNAVAILABLE: ForgeRevisionComparison = {
  status: "unavailable",
  reason: "v2 revision evidence does not exist yet (F5 pending)",
};

/** Reason served when the capability store is not wired into the runtime. */
const STORE_UNWIRED_REASON = "the Forge capability store is not wired into this runtime";

/** Reason served when the detector run store is not wired into the runtime —
 * the same wording the `trading_forge` status tool serves for the same fact. */
export const DETECTOR_RUNS_UNWIRED_REASON = "the detector run store is not wired into this runtime";

/** Reason served for retained evidence that predates per-pool diagnostics. */
const DIAGNOSTICS_UNAVAILABLE_REASON =
  "the retained evaluation predates per-pool diagnostics; counts were not recorded";

/** Reason served for a v2 capability that is installed (possibly armed) but
 * has never committed a run: armed gates whether the detector may stand, it
 * never claims a reading exists. */
const NO_COMMITTED_EVALUATION_REASON =
  "the installed detector program has not committed an evaluation yet";

const toSnapshotError = (message: string, cause: unknown) =>
  new OrchestrationGetSnapshotError({ message, cause });

// ---------------------------------------------------------------------------
// Pure mappers
// ---------------------------------------------------------------------------

const mapLatestEvaluation = (evidence: ForgeEvaluationEvidence): ForgeLatestEvaluationSummary => {
  const base = {
    evaluationId: evidence.evaluationId,
    capabilityId: evidence.capabilityId,
    capabilityVersion: evidence.capabilityVersion,
    bundleSha256: evidence.bundleSha256,
    outcome: evidence.status,
    historical: evidence.historical,
    window: { ...evidence.window },
    createdAtMs: evidence.createdAtMs,
    completedAtMs: evidence.completedAtMs ?? null,
  };
  // Diagnostics are the capability's recorded per-pool rows. Their absence on
  // older evidence is a named gap — the counts exist nowhere to read.
  return evidence.diagnostics === undefined
    ? { status: "detailUnavailable", ...base, reason: DIAGNOSTICS_UNAVAILABLE_REASON }
    : { status: "available", ...base, pools: [...evidence.diagnostics] };
};

const mapEvidenceDetail = (evidence: ForgeEvaluationEvidence): ForgeEvidenceDetail => ({
  evaluationId: evidence.evaluationId,
  capabilityId: evidence.capabilityId,
  capabilityVersion: evidence.capabilityVersion,
  bundleSha256: evidence.bundleSha256,
  outcome: evidence.status,
  historical: evidence.historical,
  window: { ...evidence.window },
  createdAtMs: evidence.createdAtMs,
  completedAtMs: evidence.completedAtMs ?? null,
  evidenceIds: [...evidence.evidenceIds],
  pools:
    evidence.diagnostics === undefined
      ? { status: "detailUnavailable", reason: DIAGNOSTICS_UNAVAILABLE_REASON }
      : { status: "available", rows: [...evidence.diagnostics] },
});

/**
 * Map one committed v2 detector record onto the wire summary: matched /
 * not-matched / unknown with the occurrence key or the program's own bounded
 * "why", the run's own clock (`asOfMs`), the committed state revision, the
 * sealed input's content digest, and the armed standing the install log folds
 * to. `evidenceIds` are bounded to the wire cap — the full list stays on the
 * record, reachable through the run store and the status tool. v2 records
 * carry no per-pool diagnostics and no v1-style window; those v1 slot fields
 * are absent, never invented.
 */
export const mapDetectorEvaluation = (
  record: DetectorEvaluationRecordV2,
  armed: boolean,
): ForgeDetectorEvaluationSummary => ({
  status: "available",
  capabilityId: record.capabilityId,
  version: record.version,
  armed,
  stateRevision: record.stateRevision,
  evaluationId: record.evaluationId,
  asOfMs: record.asOfMs,
  inputDigest: record.inputDigest,
  result: toForgeDetectorResultSummary(record.result),
  evidenceIds: record.evidenceIds.slice(0, FORGE_DETECTOR_SUMMARY_MAX_EVIDENCE),
});

export const mapPoolSeriesRead = (read: ForgePoolSeriesRead): ForgePoolSeriesView =>
  read.status === "unavailable"
    ? { status: "unavailable", reason: read.reason }
    : {
        status: "ok",
        series: read.series,
        domainIso: {
          from: DateTime.formatIso(DateTime.makeUnsafe(read.series.domainUtcMs.start)),
          to: DateTime.formatIso(DateTime.makeUnsafe(read.series.domainUtcMs.end)),
        },
        // The reads fold the fetch's own state into `health`: a fetch that
        // could not serve its pinned block entirely reports stale/unavailable.
        // Only a healthy source claims completeness.
        complete: read.series.health.status === "healthy",
      };

const mapProposal = (read: ForgePoolProposalRead): ForgePoolStateProposal =>
  read.status === "unavailable"
    ? { status: "unavailable", reason: read.reason }
    : {
        status: "ok",
        chainId: read.target.chainId,
        chainName: read.target.chainName,
        addresses: { ...read.target.addresses },
        poolKey: { ...read.target.poolKey },
        bindingId: read.target.bindingId,
        fullPoolId: read.target.fullPoolId,
        grant:
          read.grant.status === "approved"
            ? {
                status: "approved",
                grantId: read.grant.grant.grantId,
                operatorAddress: read.grant.grant.operatorAddress,
                expiresAtUnix: read.grant.grant.expiresAtUnix,
                perSwapMaxQuoteRaw: read.grant.grant.perSwapMaxQuoteRaw,
                aggregateGasBudgetWei: read.grant.grant.aggregateGasBudgetWei,
                tokenCaps: read.grant.grant.tokenCaps.map((cap) => ({
                  token: cap.token,
                  maxAmountRaw: cap.maxAmountRaw,
                })),
              }
            : { status: "missing", reason: read.grant.missingReason },
      };

const mapPosition = (read: ForgePositionStateRead): ForgePoolStatePosition =>
  read.status === "unavailable"
    ? { status: "unavailable", reason: read.reason ?? "position state unavailable" }
    : {
        status: "ok",
        position: {
          state: read.position.status,
          positionId: read.position.positionId,
          tickLower: read.position.tickLower,
          tickUpper: read.position.tickUpper,
          liquidity: read.position.liquidity,
          note: read.position.note,
        },
      };

const mapControls = (read: ForgeDirectControlsRead): ForgePoolStateView["controls"] => ({
  localPause: read.localPause,
  controls: read.controls.map((control) => ({
    name: control.name,
    availableUnderLocalPause: control.availableUnderLocalPause,
    blockedBy: control.blockedBy,
  })),
  note: read.note,
});

const mapPublication = (read: ForgePolicyStateRead): ForgePoolStatePublication => ({
  status: read.status,
  ...(read.status === "unavailable" && read.reason !== undefined ? { reason: read.reason } : {}),
  policy:
    read.local.policy === null
      ? null
      : {
          policyId: read.local.policy.policyId,
          status: read.local.policy.status,
          detectionFeeHundredthsBps: read.local.policy.detectionFeeHundredthsBps,
          expiresAtUnix: read.local.policy.expiresAtUnix ?? null,
          txHash: read.local.policy.txHash ?? null,
          publishedAtMs: read.local.policy.publishedAtMs ?? null,
          createdAtMs: read.local.policy.createdAtMs,
        },
  pendingConfirmation: read.local.pendingConfirmation,
  lastIntentId: read.local.lastIntentId,
});

const mapChain = (read: ForgePolicyStateRead): ForgePoolStateChain => {
  const snapshot = read.chain.snapshot;
  return {
    snapshot:
      snapshot === null
        ? null
        : {
            asOfBlockNumber: snapshot.asOfBlockNumber,
            asOfTimeUnix: snapshot.asOfBlockTimestampUnix,
            policyActive: snapshot.policyActive,
            paused: snapshot.paused,
            revision: snapshot.policy.revision,
            expiryUnix: snapshot.policy.expiryUnix,
            evidenceDigest: snapshot.policy.evidenceDigest,
            effectiveFeeHundredthsBps: snapshot.effectiveFeeHundredthsBps,
            fetchedAtMs: snapshot.fetchedAtMs,
          },
    stale: read.chain.stale,
    ...(read.chain.staleReason === undefined ? {} : { staleReason: read.chain.staleReason }),
  };
};

/**
 * The expiry judgement stands on the chain snapshot's own block timestamp —
 * the only clock this carries. Unknown whenever no snapshot proves it; an
 * expiry of zero means the hook itself reports no live policy.
 */
const mapFreshlyConfirmedExpiry = (read: ForgePolicyStateRead): ForgeFreshlyConfirmedExpiry => {
  const snapshot = read.chain.snapshot;
  if (snapshot === null) {
    return {
      status: "unknown",
      reason:
        read.status === "unavailable" && read.reason !== undefined
          ? read.reason
          : "chain policy snapshot unavailable",
    };
  }
  const expiryUnix = Number(snapshot.policy.expiryUnix);
  if (!Number.isSafeInteger(expiryUnix) || expiryUnix <= 0) {
    return { status: "unknown", reason: "the hook reports no live policy expiry" };
  }
  return {
    status: "chainConfirmed",
    expiryUnix,
    asOfUnix: snapshot.asOfBlockTimestampUnix,
    expired: snapshot.asOfBlockTimestampUnix >= expiryUnix,
  };
};

/**
 * One intent as the pool-state list serves it. The decoded receipt's Swap
 * event carries the TOTAL fee for our pool; the LP share requires
 * transaction-order evidence this read does not perform, so it stays null.
 * A receipt with more than one Swap event in our pool is ambiguous — null,
 * never a pick.
 */
export const mapPoolStateTransaction = (
  record: ForgeIntentRecord,
  ourPoolId: string | null,
): ForgePoolStateTransaction => {
  // Exactly one decoded Swap in our pool names the total fee; zero or several
  // leave it null.
  const swapFees =
    record.receipt === undefined || ourPoolId === null
      ? []
      : record.receipt.poolEvents.flatMap((event) =>
          event.kind === "Swap" && event.poolId.toLowerCase() === ourPoolId
            ? [event.totalSwapFeeHundredthsBps]
            : [],
        );
  return {
    intentId: record.intentId,
    kind: record.kind,
    status: record.status,
    createdAtMs: record.createdAtMs,
    txHash: record.txHash ?? null,
    submittedAtMs: record.submittedAtMs ?? null,
    gasCostWei: record.gasCostWei ?? null,
    totalSwapFeeHundredthsBps: swapFees.length === 1 ? (swapFees[0] ?? null) : null,
    lpFeeHundredthsBps: null,
    summary: record.summary,
  };
};

export const mapPoolState = (input: {
  readonly proposal: ForgePoolProposalRead;
  readonly position: ForgePositionStateRead;
  readonly controls: ForgeDirectControlsRead;
  readonly policyState: ForgePolicyStateRead;
  readonly intents: ReadonlyArray<ForgeIntentRecord>;
}): ForgePoolStateView => {
  const proposal = mapProposal(input.proposal);
  const ourPoolId = proposal.status === "ok" ? proposal.fullPoolId.toLowerCase() : null;
  const served = input.intents.slice(0, FORGE_BRIDGE_TX_PAGE);
  const transactions: ForgePoolStateTransactions = {
    items: served.map((record) => mapPoolStateTransaction(record, ourPoolId)),
    moreAvailable: input.intents.length > FORGE_BRIDGE_TX_PAGE,
  };
  return {
    proposal,
    position: mapPosition(input.position),
    controls: mapControls(input.controls),
    publication: mapPublication(input.policyState),
    chain: mapChain(input.policyState),
    moduleHash: { ...input.policyState.moduleHash },
    transactions,
    freshlyConfirmedExpiry: mapFreshlyConfirmedExpiry(input.policyState),
  };
};

export const mapControlResult = (result: ForgeOperationResult): ForgeControlResult => {
  if (result.status === "refused") {
    return { status: "refused", reason: result.reason, detail: result.detail };
  }
  const record = result.record;
  // The three controls can only produce these kinds; anything else is a
  // service contract break worth refusing loudly rather than re-labelling.
  if (record.kind !== "pause" && record.kind !== "unpause" && record.kind !== "revoke-policy") {
    return {
      status: "refused",
      reason: "unexpected-intent-kind",
      detail: `the fee-policy service returned an intent of kind ${record.kind}`,
    };
  }
  return {
    status: "ok",
    intent: {
      intentId: record.intentId,
      idempotencyKey: record.idempotencyKey,
      kind: record.kind,
      status: record.status,
      createdAtMs: record.createdAtMs,
      unsigned: {
        chainId: record.unsigned.chainId,
        to: record.unsigned.to,
        valueWei: record.unsigned.valueWei,
        data: record.unsigned.data,
      },
      summary: record.summary,
    },
  };
};

// ---------------------------------------------------------------------------
// Pagination (opaque, exclusive cursor over newest-first evaluations)
// ---------------------------------------------------------------------------

const cursorKey = (evaluation: ForgeEvaluationEvidence): string =>
  `${evaluation.createdAtMs}:${evaluation.evaluationId}`;

const isBeforeCursor = (evaluation: ForgeEvaluationEvidence, cursor: string): boolean => {
  const separator = cursor.indexOf(":");
  if (separator <= 0) return true;
  const cursorMs = Number(cursor.slice(0, separator));
  const cursorId = cursor.slice(separator + 1);
  if (!Number.isSafeInteger(cursorMs)) return true;
  return (
    evaluation.createdAtMs < cursorMs ||
    (evaluation.createdAtMs === cursorMs && evaluation.evaluationId < cursorId)
  );
};

export const pageEvaluations = (
  evaluations: ReadonlyArray<ForgeEvaluationEvidence>,
  limit: number,
  cursor: string | undefined,
): {
  readonly items: ReadonlyArray<ForgeEvidenceDetail>;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
} => {
  const sorted = [...evaluations].sort((left, right) => {
    const byTime = right.createdAtMs - left.createdAtMs;
    return byTime !== 0 ? byTime : left.evaluationId < right.evaluationId ? 1 : -1;
  });
  const remaining =
    cursor === undefined
      ? sorted
      : sorted.filter((evaluation) => isBeforeCursor(evaluation, cursor));
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;
  // The cursor keys the LAST SERVED row, so the next page serves strictly
  // older evaluations — no row is skipped and none is served twice.
  const last = page[page.length - 1];
  return {
    items: page.map(mapEvidenceDetail),
    hasMore,
    nextCursor: hasMore && last !== undefined ? cursorKey(last) : null,
  };
};

// ---------------------------------------------------------------------------
// Service-backed reads (the handlers in ws.ts call these directly)
// ---------------------------------------------------------------------------

/**
 * Thread-context discovery: sources, installed capabilities, the newest
 * sealed v1 evaluation, the in-scope v2 detector summaries, and the
 * comparison — all with `threadMarket = null`. Degrades to an honest
 * named absence when the capability store is not wired; the source listing is
 * independent of it and is always served.
 */
export const forgeThreadContextView = (input: {
  readonly environmentId: string;
  readonly threadId: string | undefined;
}): Effect.Effect<ForgeThreadContextView, OrchestrationGetSnapshotError, ForgeSourceReads> =>
  Effect.gen(function* () {
    const reads = yield* ForgeSourceReads;
    const sourcesRead = yield* reads.listSources;
    const storeOption = yield* Effect.serviceOption(ForgeCapabilityStore);
    const catalog = Option.isSome(storeOption)
      ? yield* storeOption.value
          .listCatalog(input.environmentId)
          .pipe(
            Effect.mapError((cause) =>
              toSnapshotError("Failed to read the Forge capability catalog", cause),
            ),
          )
      : [];
    const newest = Option.isSome(storeOption)
      ? yield* newestThreadEvaluation(
          storeOption.value,
          input.environmentId,
          catalog.map((entry) => entry.capabilityId),
          input.threadId,
        ).pipe(
          Effect.mapError((cause) =>
            toSnapshotError("Failed to read the latest Forge evaluation", cause),
          ),
        )
      : null;
    const detectorEvaluations = Option.isSome(storeOption)
      ? yield* detectorEvaluationsView({
          store: storeOption.value,
          environmentId: input.environmentId,
          threadId: input.threadId,
          catalog,
        })
      : { status: "unavailable" as const, reason: STORE_UNWIRED_REASON };
    return {
      sources:
        sourcesRead.status === "unavailable"
          ? { status: "unavailable" as const, reason: sourcesRead.reason }
          : { status: "ok" as const, listing: sourcesRead.listing },
      capabilities: [...catalog],
      latestEvaluation:
        newest === null
          ? {
              status: "none" as const,
              reason: !Option.isSome(storeOption)
                ? STORE_UNWIRED_REASON
                : catalog.length === 0
                  ? "no capability is installed; the catalog is the honest empty list"
                  : input.threadId === undefined
                    ? "no evaluation has been committed for the installed capabilities"
                    : "no evaluation has been committed for this thread",
            }
          : mapLatestEvaluation(newest),
      detectorEvaluations,
      comparison: FORGE_COMPARISON_UNAVAILABLE,
    };
  });

/**
 * The v2 detector half of the thread-context view, one summary per installed
 * detector-program capability in the request's scope.
 *
 * THREAD SCOPING — resolved, not guessed: a v2 evaluation record carries no
 * thread (the scheduler and any evaluate call cause it), but the build
 * receipt that prepared the installed bundle does (`ForgeBuildReceipt.threadId`,
 * recorded by `startBuild` from the preparing thread's workspace). A v2
 * capability is therefore in a thread's scope iff some build of the ACTIVE
 * bundle (stage `installed`, matching `capabilityId` and `bundleSha256`)
 * carries that thread id — the same provenance the `trading_forge` tool
 * enforces on builds. Environment-scoped requests (no threadId) include every
 * installed v2 capability; builds with no thread never match a thread filter,
 * exactly as v1 environment-scoped evaluation rows never do. A builds-read
 * failure fails the read rather than fabricating "out of scope".
 */
const detectorEvaluationsView = (input: {
  readonly store: ForgeCapabilityStoreShape;
  readonly environmentId: string;
  readonly threadId: string | undefined;
  readonly catalog: ReadonlyArray<ForgeCapabilityCatalogEntry>;
}): Effect.Effect<ForgeDetectorEvaluationsView, OrchestrationGetSnapshotError> =>
  Effect.gen(function* () {
    const scoped: Array<{ capabilityId: string; version: number; armed: boolean }> = [];
    for (const entry of input.catalog) {
      // The bundle's own hash-verified manifest bytes discriminate the
      // program kind — the same discriminator the store and the forge tool
      // dispatch on. A manifest that cannot be read decodes as v1: fail
      // closed, no v2 claim without the bytes proving it.
      const manifestJson = yield* input.store
        .readArtifact({
          environmentId: input.environmentId,
          capabilityId: entry.capabilityId,
          version: entry.version,
          path: "manifest.json",
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (manifestJson === null || versionProgramKind(manifestJson) !== "v2") continue;
      const active = yield* input.store
        .activeState({ environmentId: input.environmentId, capabilityId: entry.capabilityId })
        .pipe(Effect.orElseSucceed(() => null));
      // The catalog just listed this capability; a null state here is a
      // mid-read store race, and a capability we cannot honestly state is
      // one we do not summarize.
      if (active === null) continue;
      if (input.threadId !== undefined) {
        const builds = yield* input.store
          .listBuilds({
            environmentId: input.environmentId,
            capabilityId: entry.capabilityId,
          })
          .pipe(
            Effect.mapError((cause) =>
              toSnapshotError("Failed to read the Forge build provenance", cause),
            ),
          );
        // Note the store's listing is bounded to its newest 50 builds; the
        // scope stands on the provenance the listing serves.
        const inScope = builds.some(
          (build) =>
            build.stage === "installed" &&
            build.capabilityId === entry.capabilityId &&
            build.bundleSha256 === entry.bundleSha256 &&
            build.threadId === input.threadId,
        );
        if (!inScope) continue;
      }
      scoped.push({
        capabilityId: entry.capabilityId,
        version: active.version,
        armed: active.armed,
      });
    }
    if (scoped.length === 0) {
      // The honest empty list — including when only v1 capabilities are
      // installed, where no run store is ever consulted.
      return { status: "ok" as const, items: [] };
    }
    const runsOption = yield* Effect.serviceOption(DetectorRunStore);
    if (!Option.isSome(runsOption)) {
      return { status: "unavailable" as const, reason: DETECTOR_RUNS_UNWIRED_REASON };
    }
    const items: Array<ForgeDetectorEvaluationSummary> = [];
    for (const capability of scoped) {
      const latest = yield* runsOption.value
        .latestEvaluation(input.environmentId, capability.capabilityId)
        .pipe(
          Effect.mapError((cause) =>
            toSnapshotError("Failed to read the Forge detector evaluations", cause),
          ),
        );
      items.push(
        latest === null
          ? {
              status: "noEvaluation" as const,
              capabilityId: capability.capabilityId,
              version: capability.version,
              armed: capability.armed,
              reason: NO_COMMITTED_EVALUATION_REASON,
            }
          : mapDetectorEvaluation(latest, capability.armed),
      );
    }
    return { status: "ok" as const, items };
  });

/**
 * The newest v1 evaluation across the installed capabilities, thread-filtered
 * by the evidence's own job provenance.
 *
 * v2 detector records (DetectorRunStore rows) are DELIBERATELY not picked
 * here, in either scope:
 *
 * - Thread scope keys on the v1 evidence's `threadId` — the conversation
 *   whose install job caused the evaluation. A v2 record carries no thread
 *   (the scheduler and any evaluate call cause it), so a thread filter can
 *   never honestly match one.
 * - The v1 slot's own shape (`ForgeLatestEvaluationSummary` in
 *   packages/contracts) has no detector variant and keeps none: rendering a
 *   v2 record into it would require inventing `window`, `bundleSha256`,
 *   `historical`, and pool diagnostics the record does not carry. v2 records
 *   ride the separate `detectorEvaluations` slot instead
 *   ({@link detectorEvaluationsView}), scoped by build provenance.
 */
const newestThreadEvaluation = (
  store: ForgeCapabilityStoreShape,
  environmentId: string,
  capabilityIds: ReadonlyArray<string>,
  threadId: string | undefined,
): Effect.Effect<ForgeEvaluationEvidence | null> =>
  Effect.gen(function* () {
    let newest: ForgeEvaluationEvidence | null = null;
    for (const capabilityId of capabilityIds) {
      const evaluation = yield* store
        .latestEvaluation({ environmentId, capabilityId })
        .pipe(Effect.orElseSucceed(() => null));
      if (evaluation === null) continue;
      // A thread-scoped read only sees evaluations the conversation caused;
      // environment-scoped rows (no thread) do not match a thread filter.
      if (threadId !== undefined && evaluation.threadId !== threadId) continue;
      if (newest === null || evaluation.createdAtMs > newest.createdAtMs) newest = evaluation;
    }
    return newest;
  });

/** The bounded per-pool series read; unavailable is a named state, never zeros. */
export const forgePoolSeriesView = (
  input: OrchestrationGetForgePoolSeriesInput,
): Effect.Effect<ForgePoolSeriesView, never, ForgeSourceReads> =>
  Effect.gen(function* () {
    const reads = yield* ForgeSourceReads;
    const readInput: ForgePoolSeriesReadInput = {
      poolId: input.poolId,
      ...(input.points === undefined ? {} : { maxPoints: input.points }),
      ...(input.domain === undefined
        ? {}
        : { startUtcMs: input.domain.fromUtcMs, endUtcMs: input.domain.toUtcMs }),
    };
    const read = yield* reads.readPoolSeries(readInput);
    return mapPoolSeriesRead(read);
  });

/** Paginated evaluation-evidence detail over every installed capability. */
export const forgeEvidenceView = (input: {
  readonly environmentId: string;
  readonly evaluationId: string | undefined;
  readonly limit: number | undefined;
  readonly cursor: string | undefined;
}): Effect.Effect<
  OrchestrationGetForgeEvidenceResult,
  OrchestrationGetSnapshotError,
  ForgeCapabilityStore
> =>
  Effect.gen(function* () {
    const store = yield* ForgeCapabilityStore;
    const catalog = yield* store
      .listCatalog(input.environmentId)
      .pipe(
        Effect.mapError((cause) =>
          toSnapshotError("Failed to read the Forge capability catalog", cause),
        ),
      );
    const collected: ForgeEvaluationEvidence[] = [];
    for (const entry of catalog) {
      const rows = yield* store
        .listEvaluations({
          environmentId: input.environmentId,
          capabilityId: entry.capabilityId,
          limit: 500,
        })
        .pipe(
          Effect.mapError((cause) =>
            toSnapshotError("Failed to read retained Forge evaluations", cause),
          ),
        );
      collected.push(...rows);
    }
    if (input.evaluationId !== undefined) {
      const match = collected.find((evaluation) => evaluation.evaluationId === input.evaluationId);
      return {
        items: match === undefined ? [] : [mapEvidenceDetail(match)],
        hasMore: false,
        nextCursor: null,
      };
    }
    const paged = pageEvaluations(collected, input.limit ?? 20, input.cursor);
    return { items: [...paged.items], hasMore: paged.hasMore, nextCursor: paged.nextCursor };
  });

/**
 * The F3 pool-state handoff: proposal/grant, position, controls, publication,
 * chain snapshot, module-hash comparison, and the bounded intent list. All
 * five reads come off the one fee-policy service call surface.
 */
export const forgePoolStateView = (): Effect.Effect<ForgePoolStateView, never, FeePolicyService> =>
  Effect.gen(function* () {
    const feePolicy = yield* FeePolicyService;
    const [proposal, position, controls, policyState, intents] = yield* Effect.all([
      feePolicy.readPoolProposal,
      feePolicy.readPositionState,
      feePolicy.readDirectControls,
      feePolicy.readPolicyState,
      feePolicy.listIntents(FORGE_BRIDGE_TX_PAGE + 1),
    ]);
    return mapPoolState({ proposal, position, controls, policyState, intents });
  });

/**
 * A direct control: builds an UNSIGNED intent through the fee-policy service
 * with no agent provider in the loop. The service mints a fresh idempotency
 * key per call, so every attempt is its own operation identity.
 */
export const forgeControlView = (
  control: "pause" | "unpause" | "revoke",
  environmentId: string,
): Effect.Effect<ForgeControlResult, never, FeePolicyService> =>
  Effect.gen(function* () {
    const feePolicy = yield* FeePolicyService;
    const result =
      control === "pause"
        ? yield* feePolicy.requestPause({ environmentId })
        : control === "unpause"
          ? yield* feePolicy.requestUnpause({ environmentId })
          : yield* feePolicy.requestRevoke({ environmentId });
    return mapControlResult(result);
  });
