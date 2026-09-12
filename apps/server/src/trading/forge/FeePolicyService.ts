// @effect-diagnostics preferSchemaOverJson:off - canonical serialization is hashed to bind retained provenance.
/**
 * FeePolicyService — the policy lifecycle on top of the testnet adapter.
 *
 * Layers, kept strictly apart because they answer different questions:
 *
 * - LOCAL state is what T3 Trade decided: the retained intent records in the
 *   ledger (publish/pause/revoke/liquidity), their tx states, and the local
 *   pause flag that stops new chain-affecting intents.
 * - CHAIN state is what Sepolia says, read as a pinned snapshot with its own
 *   as-of block and timestamp. Freshness is computed chain-side (snapshot
 *   block vs latest head); a client clock is never evidence that a policy is
 *   still confirmed or already expired.
 *
 * Every publish is built from installed-capability evaluation evidence
 * (digest + source-derived expiry), never from an agent's say-so. Historical
 * evidence cannot drive live policy. Direct pause/revoke/remove controls are
 * user operations on this service — they build intents with no agent
 * provider in the loop at all, and broadcasting anything still passes the
 * adapter's grant gate.
 *
 * These are typed service results for the UI handoff (U0 owns wire
 * registration); nothing here registers an RPC.
 *
 * @module FeePolicyService
 */
import { randomUUID, createHash } from "node:crypto";
import * as Option from "effect/Option";
import { ForgeCapabilityStore } from "./CapabilityStore.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Layer } from "effect";
import type { PersistenceSqlError } from "../../persistence/Errors.ts";

import {
  FORGE_EXECUTION_CHAIN,
  type ForgePolicy,
  type ForgePolicyStatus,
} from "@t3tools/trading-contracts";

import {
  forgeBindingId,
  forgeFullPoolId,
  immutableTargetFingerprint,
} from "./UniswapTestnetAdapter.ts";
import {
  UniswapTestnetAdapter,
  ForgeIntentLedger,
  type ForgeIntentRecord,
  type ForgeSwapFeeEvidenceRead,
  type ForgeBroadcastRefusalReason,
  type ForgeHookState,
} from "./UniswapTestnetAdapter.ts";
import type { ForgeSpendGrant } from "./SepoliaTarget.ts";
import { ForgeSourceStore } from "./ForgeSourceStore.ts";

/**
 * The detection fee this service may ever publish: the hook's fixed
 * POLICY_FEE (500 = 0.05%). The contract decides the number; the service
 * refuses anything else.
 */
export const FORGE_DETECTION_FEE_HUNDREDTHS_BPS = 500;

/** How long a published policy outlives the end of its source window. */
export const DEFAULT_POLICY_DURATION_SECONDS = 900;

/** Snapshot older than this many blocks behind the head is `stale`. */
export const DEFAULT_SNAPSHOT_MAX_LAG_BLOCKS = 6;

/**
 * The durable scope of this service's local-pause brake. The control is
 * service-global today (setLocalPause carries no environment); the ledger's
 * control state is scope-keyed so a future per-environment control adopts the
 * same table without a migration.
 */
export const FORGE_LOCAL_PAUSE_SCOPE = "forge-fee-policy-service";

/** Result of the restart-safe open-intent reconciliation sweep. */
export interface ForgeOpenReconciliationRead {
  /** Current-target intents reconciled this pass (terminal or still open). */
  readonly reconciled: ReadonlyArray<ForgeIntentRecord>;
  /** Open intents that belong to another (or no) target — left untouched. */
  readonly skippedCrossTarget: ReadonlyArray<{
    readonly intentId: string;
    readonly kind: string;
    readonly status: string;
  }>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FeePolicySettings {
  readonly policyDurationSeconds: number;
  readonly snapshotMaxLagBlocks: number;
}

export class FeePolicyConfig extends Context.Service<
  FeePolicyConfig,
  { readonly resolve: Effect.Effect<FeePolicySettings> }
>()("t3/trading/forge/FeePolicyService/FeePolicyConfig") {}

const toPositiveIntOr = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Env knobs (per-call resolution, so a change takes effect without a
 * restart): `T3_FORGE_POLICY_DURATION_SECONDS`,
 * `T3_FORGE_SNAPSHOT_MAX_LAG_BLOCKS`.
 */
export const resolveFeePolicySettings = (
  env: {
    readonly T3_FORGE_POLICY_DURATION_SECONDS?: string | undefined;
    readonly T3_FORGE_SNAPSHOT_MAX_LAG_BLOCKS?: string | undefined;
  } & Record<string, string | undefined>,
): FeePolicySettings => ({
  policyDurationSeconds: toPositiveIntOr(
    env.T3_FORGE_POLICY_DURATION_SECONDS,
    DEFAULT_POLICY_DURATION_SECONDS,
  ),
  snapshotMaxLagBlocks: toPositiveIntOr(
    env.T3_FORGE_SNAPSHOT_MAX_LAG_BLOCKS,
    DEFAULT_SNAPSHOT_MAX_LAG_BLOCKS,
  ),
});

export const FeePolicyConfigLive = Layer.succeed(
  FeePolicyConfig,
  FeePolicyConfig.of({
    resolve: Effect.sync(() =>
      resolveFeePolicySettings(process.env as Record<string, string | undefined>),
    ),
  }),
);

// ---------------------------------------------------------------------------
// Result types (the UI-handoff shapes U0 wires)
// ---------------------------------------------------------------------------

/** The exact pool proposal and the state of the grant that would fund it. */
export type ForgePoolProposalRead =
  | {
      readonly status: "ok";
      readonly target: {
        readonly chainId: number;
        readonly chainName: "sepolia";
        readonly addresses: {
          readonly hook: string;
          readonly poolManager: string;
          readonly positionManager: string;
          readonly swapRoute: string;
        };
        readonly poolKey: {
          readonly currency0: string;
          readonly currency1: string;
          readonly fee: number;
          readonly tickSpacing: number;
          readonly hookAddress: string;
        };
        readonly bindingId: string;
        readonly fullPoolId: string;
      };
      readonly grant:
        | { readonly status: "approved"; readonly grant: ForgeSpendGrant }
        | { readonly status: "missing"; readonly missingReason: string };
    }
  | { readonly status: "unavailable"; readonly reason: string };

/** Local publication state vs the chain-confirmed snapshot, never conflated. */
export interface ForgePolicyStateRead {
  readonly status: "ok" | "unavailable";
  readonly reason?: string;
  readonly local: {
    readonly policy: ForgePolicy | null;
    /** A publish intent exists whose chain outcome is not settled. */
    readonly pendingConfirmation: boolean;
    readonly lastIntentId: string | null;
  };
  readonly chain: {
    readonly snapshot: ForgeHookState | null;
    /** Null when the latest head could not be read (freshness unknown). */
    readonly stale: boolean | null;
    readonly staleReason?: string;
  };
  /** Installed bundle hash versus the bundle bound by retained chain evidence. */
  readonly moduleHash: {
    readonly installed: string | null;
    readonly confirmedOnChain: string | null;
    readonly match: boolean | null;
  };
  /** Chain-truth effective fee for the bound pool (500/3000), or null. */
  readonly effectiveFeeHundredthsBps: number | null;
}

/** Honest position/liquidity state until the live pass mines real receipts. */
export interface ForgePositionStateRead {
  readonly status: "ok" | "unavailable";
  readonly reason?: string;
  readonly position: {
    readonly status: "none" | "proposed" | "pending" | "confirmed" | "removal-pending";
    /**
     * The PositionManager derives position ids from owner/range/salt on
     * chain; null until a confirmed receipt gives us something real.
     */
    readonly positionId: string | null;
    readonly tickLower: number | null;
    readonly tickUpper: number | null;
    /** Net liquidity across confirmed ModifyLiquidity receipts, raw. */
    readonly liquidity: string | null;
    readonly note: string;
  };
}

/** The direct controls and what, if anything, blocks each. */
export interface ForgeDirectControlsRead {
  readonly localPause: boolean;
  readonly controls: ReadonlyArray<{
    readonly name: "pause" | "unpause" | "revoke" | "remove-liquidity";
    /** Safety-reducing controls stay available under local pause. */
    readonly availableUnderLocalPause: boolean;
    readonly blockedBy: "local-pause" | "grant" | null;
  }>;
  readonly note: string;
}

export type ForgeOperationResult =
  | { readonly status: "ok"; readonly record: ForgeIntentRecord }
  | { readonly status: "refused"; readonly reason: string; readonly detail: string };

export type ForgeBroadcastResult =
  | { readonly status: "submitted"; readonly record: ForgeIntentRecord }
  | {
      readonly status: "refused";
      readonly refusal: {
        readonly reason: ForgeBroadcastRefusalReason | "locally-paused" | "not-found" | "rpc-error";
        readonly detail: string;
      };
    };

export interface FeePolicyServiceShape {
  // -- UI-handoff reads -----------------------------------------------------
  readonly readPoolProposal: Effect.Effect<ForgePoolProposalRead>;
  readonly readPolicyState: Effect.Effect<ForgePolicyStateRead>;
  readonly readPositionState: Effect.Effect<ForgePositionStateRead>;
  readonly readDirectControls: Effect.Effect<ForgeDirectControlsRead>;
  readonly listIntents: (limit?: number) => Effect.Effect<ReadonlyArray<ForgeIntentRecord>>;
  readonly readSwapFeeEvidence: (txHash: string) => Effect.Effect<ForgeSwapFeeEvidenceRead>;

  // -- lifecycle: build unsigned intents -------------------------------------
  readonly publishFromEvidence: (input: {
    readonly environmentId: string;
    readonly threadId?: string;
    readonly evidenceId: string;
    readonly sourceEvaluationId: string;
    readonly capabilityId?: string;
    readonly capabilityVersion?: number;
    readonly policyDurationSeconds?: number;
  }) => Effect.Effect<ForgeOperationResult, PersistenceSqlError>;
  readonly requestRevoke: (input: {
    readonly environmentId: string;
  }) => Effect.Effect<ForgeOperationResult>;
  readonly requestPause: (input: {
    readonly environmentId: string;
  }) => Effect.Effect<ForgeOperationResult>;
  readonly requestUnpause: (input: {
    readonly environmentId: string;
  }) => Effect.Effect<ForgeOperationResult>;
  readonly requestRemoveLiquidity: (input: {
    readonly environmentId: string;
    readonly tickLower: number;
    readonly tickUpper: number;
    readonly liquidity: string;
    readonly salt?: string;
    readonly tokenId: string;
    readonly minAmount0Raw?: string;
    readonly minAmount1Raw?: string;
  }) => Effect.Effect<ForgeOperationResult>;
  readonly requestInitializePool: (input: {
    readonly environmentId: string;
    readonly sqrtPriceX96: string;
  }) => Effect.Effect<ForgeOperationResult>;
  readonly requestAddLiquidity: (input: {
    readonly environmentId: string;
    readonly tickLower: number;
    readonly tickUpper: number;
    readonly liquidity: string;
    readonly salt?: string;
    readonly deposits: ReadonlyArray<{ readonly token: string; readonly amountRaw: string }>;
    readonly tokenId?: string;
    readonly ownerAddress?: string;
  }) => Effect.Effect<ForgeOperationResult>;
  readonly requestBoundedSwap: (input: {
    readonly environmentId: string;
    readonly zeroForOne: boolean;
    readonly amountSpecifiedRaw: string;
    readonly sqrtPriceLimitX96: string;
    readonly quoteAmountRaw: string;
  }) => Effect.Effect<ForgeOperationResult>;

  // -- broadcast through the grant gate, and reconcile -----------------------
  readonly broadcast: (intentId: string) => Effect.Effect<ForgeBroadcastResult>;
  readonly reconcile: (
    intentId?: string,
  ) => Effect.Effect<ReadonlyArray<ForgeIntentRecord>, string>;
  /**
   * Restart-safe sweep: reconcile every open intent for the CURRENT target,
   * settle gas reservations from receipts, and report (never decode) open
   * intents that belong to another target. Safe to call repeatedly.
   */
  readonly reconcileOpenIntents: Effect.Effect<ForgeOpenReconciliationRead>;

  /** Local kill switch: stops NEW chain-affecting intents; safety ops pass. */
  readonly setLocalPause: (paused: boolean) => Effect.Effect<ForgeDirectControlsRead>;
}

export class FeePolicyService extends Context.Service<FeePolicyService, FeePolicyServiceShape>()(
  "t3/trading/forge/FeePolicyService",
) {}

/** Intent kinds a local pause blocks. Safety-reducing ops never appear here. */
const LOCALLY_PAUSED_BLOCKED_KINDS = new Set([
  "publish-policy",
  "unpause",
  "initialize-pool",
  "add-liquidity",
  "bounded-swap",
]);

const refused = (
  reason: string,
  detail: string,
): { readonly status: "refused"; readonly reason: string; readonly detail: string } => ({
  status: "refused",
  reason,
  detail,
});

export const makeFeePolicyService = Effect.gen(function* () {
  const adapter = yield* UniswapTestnetAdapter;
  const ledger = yield* ForgeIntentLedger;
  const store = yield* ForgeSourceStore;
  const feeConfig = yield* FeePolicyConfig;
  const capabilityStore = yield* Effect.serviceOption(ForgeCapabilityStore);

  // Local pause: the instant in-process brake. When the ledger persists
  // control state, construction reads it back (a restart must not forget a
  // pause) and every write goes through; an unreadable persisted pause reads
  // as SET — fail closed, exposure blocked, safety controls unaffected.
  const readPausedOnce = ledger.readPaused;
  let localPause = false;
  if (readPausedOnce !== undefined) {
    localPause = yield* readPausedOnce(FORGE_LOCAL_PAUSE_SCOPE).pipe(
      Effect.catch(() => Effect.succeed(true)),
    );
  }

  const readPoolProposal: FeePolicyServiceShape["readPoolProposal"] = Effect.gen(function* () {
    const resolved = yield* adapter.settings;
    if (!resolved.configured || resolved.target === undefined) {
      return {
        status: "unavailable" as const,
        reason: resolved.reason ?? "forge sepolia target not configured",
      };
    }
    const target = resolved.target;
    return {
      status: "ok" as const,
      target: {
        chainId: target.chainId,
        chainName: "sepolia" as const,
        addresses: {
          hook: target.hookAddress,
          poolManager: target.poolManager,
          positionManager: target.positionManager,
          swapRoute: target.swapRoute,
        },
        poolKey: target.poolKey,
        bindingId: forgeBindingId(target.poolKey),
        fullPoolId: forgeFullPoolId(target.poolKey),
      },
      grant:
        resolved.grant !== undefined
          ? { status: "approved" as const, grant: resolved.grant }
          : {
              status: "missing" as const,
              missingReason: resolved.grantMissingReason ?? "no approved forge spend grant",
            },
    };
  });

  const recordsForTarget = Effect.gen(function* () {
    const settings = yield* adapter.settings;
    if (settings.target === undefined) return [];
    const targetFingerprint = immutableTargetFingerprint(settings.target);
    return (yield* ledger.listAll).filter(
      (record) => record.params.targetFingerprint === targetFingerprint,
    );
  });

  const policyIntentsOf = (): Effect.Effect<ReadonlyArray<ForgeIntentRecord>> =>
    Effect.map(recordsForTarget, (records) =>
      records.filter(
        (record) => record.kind === "publish-policy" || record.kind === "revoke-policy",
      ),
    );

  /** Local ForgePolicy from the newest publish intent, status chain-derived. */
  const localPolicyOf = (
    publish: ForgeIntentRecord,
    snapshot: ForgeHookState | null,
  ): ForgePolicy => {
    const expiryUnix = Number(publish.params["expiryUnix"] ?? "0");
    let status: ForgePolicyStatus;
    switch (publish.status) {
      case "draft":
        status = "draft";
        break;
      case "submitted":
      case "unknown":
        status = "submitted";
        break;
      case "confirmed":
        // Expiry is judged by the CHAIN snapshot's own block time, never a
        // client clock: an expired policy means baseline fee.
        status =
          snapshot !== null && expiryUnix > 0 && snapshot.asOfBlockTimestampUnix >= expiryUnix
            ? "expired"
            : "confirmed";
        break;
      case "reverted":
        status = "failed";
        break;
    }
    return {
      policyId: publish.intentId,
      environmentId: publish.environmentId,
      ...(publish.params["threadId"] === undefined ? {} : { threadId: publish.params["threadId"] }),
      executionChain: FORGE_EXECUTION_CHAIN,
      // Records always carry 0x addresses by construction; the contract
      // schema wants the literal template form.
      hookAddress: publish.unsigned.to as `0x${string}`,
      detectionFeeHundredthsBps: FORGE_DETECTION_FEE_HUNDREDTHS_BPS,
      status,
      ...(publish.params["sourceEvaluationId"] === undefined
        ? {}
        : { sourceEvaluationId: publish.params["sourceEvaluationId"] }),
      ...(publish.params["evidenceDigest"] === undefined
        ? {}
        : { observationDigest: publish.params["evidenceDigest"] }),
      ...(expiryUnix > 0 ? { expiresAtUnix: expiryUnix } : {}),
      ...(publish.status === "confirmed" && publish.submittedAtMs !== undefined
        ? { publishedAtMs: publish.submittedAtMs }
        : {}),
      ...(publish.txHash === undefined ? {} : { txHash: publish.txHash }),
      createdAtMs: publish.createdAtMs,
    };
  };

  const readPolicyState: FeePolicyServiceShape["readPolicyState"] = Effect.gen(function* () {
    const resolved = yield* adapter.settings;
    if (!resolved.configured || resolved.target === undefined) {
      return {
        status: "unavailable" as const,
        reason: resolved.reason ?? "forge sepolia target not configured",
        local: { policy: null, pendingConfirmation: false, lastIntentId: null },
        chain: { snapshot: null, stale: null },
        moduleHash: { installed: null, confirmedOnChain: null, match: null },
        effectiveFeeHundredthsBps: null,
      };
    }

    const [snapshotRead, head] = yield* Effect.all([adapter.readHookState, adapter.readChainHead]);
    const snapshot = snapshotRead.status === "ok" ? snapshotRead.state : null;

    // Freshness from chain data only: snapshot block vs latest head.
    let stale: boolean | null = null;
    let staleReason: string | undefined;
    if (snapshot !== null) {
      if (head.status === "ok") {
        const { snapshotMaxLagBlocks } = yield* feeConfig.resolve;
        stale = head.blockNumber - snapshot.asOfBlockNumber > snapshotMaxLagBlocks;
        if (stale) {
          staleReason = `snapshot pinned to block ${snapshot.asOfBlockNumber}; head is ${head.blockNumber} (max lag ${snapshotMaxLagBlocks})`;
        }
      } else {
        stale = null;
        staleReason = `cannot prove freshness: ${head.reason}`;
      }
    }

    const policyIntents = yield* policyIntentsOf();
    if (new Set(policyIntents.map((record) => record.environmentId)).size > 1) {
      return {
        status: "unavailable" as const,
        reason: "multiple environments have policy history; a scoped policy read is required",
        local: { policy: null, pendingConfirmation: false, lastIntentId: null },
        chain: { snapshot, stale },
        moduleHash: { installed: null, confirmedOnChain: null, match: null },
        effectiveFeeHundredthsBps: snapshot?.effectiveFeeHundredthsBps ?? null,
      };
    }
    const newestRecord = policyIntents[0] ?? null;
    let localPolicy: ForgePolicy | null = null;
    let pendingConfirmation = false;
    if (newestRecord !== null && newestRecord.kind === "publish-policy") {
      localPolicy = localPolicyOf(newestRecord, snapshot);
      pendingConfirmation =
        newestRecord.status === "submitted" || newestRecord.status === "unknown";
    } else if (newestRecord !== null && newestRecord.kind === "revoke-policy") {
      // A revoke intent dominates the local view. Only a CONFIRMED revoke
      // means no policy; before that the last publish is still the claim,
      // with confirmation pending.
      const lastPublish = policyIntents.find((record) => record.kind === "publish-policy") ?? null;
      if (newestRecord.status === "confirmed") {
        localPolicy =
          lastPublish === null
            ? null
            : { ...localPolicyOf(lastPublish, snapshot), status: "failed" };
      } else if (lastPublish !== null) {
        localPolicy = localPolicyOf(lastPublish, snapshot);
        pendingConfirmation =
          newestRecord.status === "submitted" || newestRecord.status === "unknown";
      }
    }

    const publishRecord = policyIntents.find((record) => record.kind === "publish-policy");
    const capabilityId = publishRecord?.params.capabilityId;
    const active =
      Option.isSome(capabilityStore) && publishRecord !== undefined && capabilityId !== undefined
        ? yield* capabilityStore.value
            .activeState({ environmentId: publishRecord.environmentId, capabilityId })
            .pipe(Effect.catch(() => Effect.succeed(null)))
        : null;
    const installed = active?.status === "installed" ? active.bundleSha256 : null;
    // The hook stores composite provenance, not a module hash. Only a matching
    // retained publication lets us identify the module bound by that digest.
    const confirmedOnChain =
      snapshot !== null && publishRecord?.params.evidenceDigest === snapshot.policy.evidenceDigest
        ? (publishRecord.params.bundleSha256 ?? null)
        : null;

    return {
      status: "ok" as const,
      local: {
        policy: localPolicy,
        pendingConfirmation,
        lastIntentId: newestRecord?.intentId ?? null,
      },
      chain: { snapshot, stale, ...(staleReason === undefined ? {} : { staleReason }) },
      moduleHash: {
        installed,
        confirmedOnChain,
        match:
          installed !== null && confirmedOnChain !== null ? installed === confirmedOnChain : null,
      },
      effectiveFeeHundredthsBps: snapshot?.effectiveFeeHundredthsBps ?? null,
    };
  });

  const readPositionState: FeePolicyServiceShape["readPositionState"] = Effect.gen(function* () {
    const resolved = yield* adapter.settings;
    if (!resolved.configured || resolved.target === undefined) {
      return {
        status: "unavailable" as const,
        reason: resolved.reason ?? "forge sepolia target not configured",
        position: {
          status: "none" as const,
          positionId: null,
          tickLower: null,
          tickUpper: null,
          liquidity: null,
          note: "forge sepolia target not configured",
        },
      };
    }
    const ourPoolId = forgeFullPoolId(resolved.target.poolKey).toLowerCase();
    const records = (yield* recordsForTarget).filter(
      (record) => record.kind === "add-liquidity" || record.kind === "remove-liquidity",
    );
    if (records.length === 0) {
      return {
        status: "ok" as const,
        position: {
          status: "none" as const,
          positionId: null,
          tickLower: null,
          tickUpper: null,
          liquidity: null,
          note: "no liquidity intents recorded",
        },
      };
    }

    const unavailable = (reason: string): ForgePositionStateRead => ({
      status: "unavailable",
      reason,
      position: {
        status: "none",
        positionId: null,
        tickLower: null,
        tickUpper: null,
        liquidity: null,
        note: reason,
      },
    });
    if (new Set(records.map((record) => record.environmentId)).size > 1) {
      return unavailable(
        "multiple environments have liquidity history; a scoped position read is required",
      );
    }
    const positions = new Map<
      string,
      { tickLower: number; tickUpper: number; salt: string; liquidity: bigint }
    >();
    const seenEvents = new Set<string>();
    for (const record of records) {
      if (record.status !== "confirmed" || record.receipt === undefined) continue;
      let matched = false;
      for (const event of record.receipt.poolEvents) {
        if (event.kind !== "ModifyLiquidity" || event.poolId.toLowerCase() !== ourPoolId) continue;
        matched = true;
        const eventId = `${record.receipt.txHash}:${event.logIndex}`;
        if (seenEvents.has(eventId)) continue;
        seenEvents.add(eventId);
        const key = `${event.sender}:${event.tickLower}:${event.tickUpper}:${event.salt}`;
        const position = positions.get(key) ?? {
          tickLower: event.tickLower,
          tickUpper: event.tickUpper,
          salt: event.salt,
          liquidity: 0n,
        };
        position.liquidity += BigInt(event.liquidityDelta);
        positions.set(key, position);
      }
      if (!matched)
        return unavailable("confirmed liquidity intent has no matching pool receipt evidence");
    }
    if ([...positions.values()].some((position) => position.liquidity < 0n)) {
      return unavailable(
        "liquidity receipts have a negative balance; position history is incomplete",
      );
    }
    const active = [...positions.values()].filter((position) => position.liquidity > 0n);
    if (active.length > 1)
      return unavailable(
        "multiple owner/range/salt positions cannot be represented as one position",
      );
    const pending = records.filter(
      (record) => record.status === "submitted" || record.status === "unknown",
    );
    const drafts = records.filter((record) => record.status === "draft");
    const outstanding = pending.length > 0 ? pending : active.length === 0 ? drafts : [];
    const candidate = active[0];
    const ranges = new Set(
      outstanding.map(
        (record) =>
          `${record.params.tickLower}:${record.params.tickUpper}:${record.params.salt ?? `0x${"0".repeat(64)}`}`,
      ),
    );
    if (candidate !== undefined)
      ranges.add(`${candidate.tickLower}:${candidate.tickUpper}:${candidate.salt}`);
    if (ranges.size > 1)
      return unavailable(
        "multiple pending or proposed liquidity ranges cannot be represented as one position",
      );
    const proposal = outstanding[0];
    const tickLower =
      candidate?.tickLower ?? (proposal === undefined ? null : Number(proposal.params.tickLower));
    const tickUpper =
      candidate?.tickUpper ?? (proposal === undefined ? null : Number(proposal.params.tickUpper));
    const status: ForgePositionStateRead["position"]["status"] =
      pending.length > 0
        ? pending.some((record) => record.kind === "remove-liquidity")
          ? "removal-pending"
          : "pending"
        : candidate !== undefined
          ? "confirmed"
          : drafts.length > 0 && positions.size === 0
            ? "proposed"
            : "none";
    return {
      status: "ok" as const,
      position: {
        status,
        positionId: null,
        tickLower,
        tickUpper,
        liquidity: candidate?.liquidity.toString(10) ?? (positions.size > 0 ? "0" : null),
        note: "liquidity is reconstructed from deduplicated receipts for one owner, range and salt; no NFT position id has been verified",
      },
    };
  });

  const readDirectControls: FeePolicyServiceShape["readDirectControls"] = Effect.gen(function* () {
    const resolved = yield* adapter.settings;
    const grantPresent = resolved.grant !== undefined;
    return {
      localPause,
      controls: [
        { name: "pause", availableUnderLocalPause: true, blockedBy: grantPresent ? null : "grant" },
        {
          name: "unpause",
          availableUnderLocalPause: false,
          blockedBy: localPause ? "local-pause" : grantPresent ? null : "grant",
        },
        {
          name: "revoke",
          availableUnderLocalPause: true,
          blockedBy: grantPresent ? null : "grant",
        },
        {
          name: "remove-liquidity",
          availableUnderLocalPause: true,
          blockedBy: grantPresent ? null : "grant",
        },
      ] as const,
      note: "direct controls run without any agent provider; broadcasting additionally requires the approved F0 grant and the grant-controlled signer",
    };
  });

  // ---------------------------------------------------------------- lifecycle

  const publishFromEvidence: FeePolicyServiceShape["publishFromEvidence"] = (input) =>
    Effect.gen(function* () {
      const resolved = yield* adapter.settings;
      if (!resolved.configured || resolved.target === undefined) {
        return refused("unconfigured", resolved.reason ?? "forge sepolia target not configured");
      }
      if (localPause) {
        return refused(
          "locally-paused",
          "local pause is set; new chain-affecting intents are stopped",
        );
      }

      const evidence = yield* store.readObservations(input.evidenceId);
      if (evidence === null) {
        return refused("evidence-not-found", `no retained evidence ${input.evidenceId}`);
      }
      if (evidence.record.historical) {
        return refused(
          "historical-evidence",
          `evidence ${input.evidenceId} is a retained historical window and cannot drive live fee policy`,
        );
      }
      if (evidence.record.environmentId !== input.environmentId) {
        return refused("evidence-environment", "evidence belongs to another environment");
      }
      if (
        Option.isNone(capabilityStore) ||
        input.capabilityId === undefined ||
        input.capabilityVersion === undefined
      ) {
        return refused(
          "installed-evaluation-required",
          "publishing requires the installed capability store and exact capability version",
        );
      }
      const scope = { environmentId: input.environmentId, capabilityId: input.capabilityId };
      const verification = yield* Effect.all([
        capabilityStore.value.activeState(scope),
        capabilityStore.value.latestEvaluation(scope),
      ]).pipe(Effect.catch(() => Effect.succeed(null)));
      if (verification === null)
        return refused("evaluation-unavailable", "cannot verify installed evaluation");
      const [active, evaluation] = verification;
      if (
        active === null ||
        active.status !== "installed" ||
        active.version !== input.capabilityVersion ||
        evaluation === null ||
        evaluation.evaluationId !== input.sourceEvaluationId ||
        evaluation.environmentId !== input.environmentId ||
        evaluation.capabilityId !== input.capabilityId ||
        evaluation.capabilityVersion !== active.version ||
        evaluation.bundleSha256 !== active.bundleSha256 ||
        evaluation.status !== "complete" ||
        evaluation.historical ||
        evaluation.reading?.kind !== "ready" ||
        evaluation.reading.regime !== "coordinated" ||
        !evaluation.evidenceIds.includes(input.evidenceId) ||
        evaluation.window.endedAt !== evidence.record.windowEnd * 1000
      ) {
        return refused(
          "evaluation-mismatch",
          "only the current installed, completed coordinated evaluation for this exact source window can publish",
        );
      }
      const sourceDigests: string[] = [];
      for (const evidenceId of evaluation.evidenceIds) {
        const source = yield* store.readRecord(evidenceId);
        if (
          source === null ||
          source.environmentId !== input.environmentId ||
          source.historical ||
          source.windowStart * 1000 !== evaluation.window.startedAt ||
          source.windowEnd * 1000 !== evaluation.window.endedAt ||
          source.pinnedBlock !== evaluation.pinnedBlock ||
          !/^[0-9a-f]{64}$/i.test(source.digest)
        ) {
          return refused(
            "source-provenance-mismatch",
            "every evaluation source must be retained in the same environment, pinned block and window",
          );
        }
        sourceDigests.push(source.digest);
      }
      const aggregateDigest = createHash("sha256")
        .update(JSON.stringify(sourceDigests))
        .digest("hex");
      if (aggregateDigest !== evaluation.sourceDigest)
        return refused(
          "source-digest-mismatch",
          "evaluation source aggregate does not match retained evidence",
        );
      const digest = createHash("sha256")
        .update(
          JSON.stringify({
            environmentId: input.environmentId,
            evaluationId: evaluation.evaluationId,
            bundleSha256: active.bundleSha256,
            sourceDigest: aggregateDigest,
          }),
        )
        .digest("hex");
      if (!/^[0-9a-fA-F]{64}$/.test(digest)) {
        return refused("evidence-digest", `evidence ${input.evidenceId} carries no sha-256 digest`);
      }
      const { policyDurationSeconds } = yield* feeConfig.resolve;
      const duration = input.policyDurationSeconds ?? policyDurationSeconds;
      if (
        !Number.isSafeInteger(duration) ||
        duration <= 0 ||
        duration > DEFAULT_POLICY_DURATION_SECONDS
      ) {
        return refused("invalid-duration", "policy duration must be 1..900 seconds");
      }
      // Source-derived expiry: the policy outlives the END OF THE WINDOW the
      // evidence describes, not the moment of publication.
      const expiryUnix = evidence.record.windowEnd + duration;

      // The hook reverts `ExpiryNotFuture`; judge it by chain time here so
      // the refusal is named before an intent ever exists.
      const head = yield* adapter.readChainHead;
      if (head.status !== "ok") {
        return refused(
          "chain-time-unavailable",
          `cannot judge expiry against chain time: ${head.reason}`,
        );
      }
      if (evidence.record.windowEnd > head.timestampUnix || expiryUnix <= head.timestampUnix) {
        return refused(
          "expiry-not-future",
          `derived expiry ${expiryUnix} is not in the future of chain block timestamp ${head.timestampUnix}`,
        );
      }

      // Revision must strictly increase against BOTH the chain's high-water
      // mark and any local publish already recorded. Without a readable
      // chain snapshot the safe answer is to refuse, not to guess.
      const snapshotRead = yield* adapter.readHookState;
      if (snapshotRead.status !== "ok") {
        return refused(
          "chain-state-unavailable",
          `cannot read the hook policy high-water mark: ${snapshotRead.reason}`,
        );
      }
      const chainRevision = BigInt(snapshotRead.state.policy.revision);
      let localRevision = 0n;
      for (const record of yield* recordsForTarget) {
        if (record.kind !== "publish-policy") continue;
        const revision = BigInt(record.params["revision"] ?? "0");
        if (revision > localRevision) localRevision = revision;
      }
      const revision = (chainRevision > localRevision ? chainRevision : localRevision) + 1n;

      const built = yield* adapter
        .buildIntent({
          kind: "publish-policy",
          environmentId: input.environmentId,
          bindingId: forgeBindingId(resolved.target.poolKey),
          revision: revision.toString(10),
          expiryUnix,
          evidenceDigest: `0x${digest}`,
          idempotencyKey: `publish:${input.environmentId}:${input.evidenceId}:${revision.toString(10)}`,
        })
        .pipe(
          Effect.map((record): ForgeOperationResult => ({ status: "ok", record })),
          Effect.catchTag("ForgeIntentBuildError", (cause) =>
            Effect.succeed(refused("build-failed", cause.detail)),
          ),
        );
      if (built.status !== "ok") return built;
      // Carry the provenance params the ledger record itself cannot encode.
      const enriched: ForgeIntentRecord = {
        ...built.record,
        params: {
          ...built.record.params,
          evidenceId: input.evidenceId,
          bundleSha256: active.bundleSha256,
          sourceEvaluationId: input.sourceEvaluationId,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input.capabilityId === undefined ? {} : { capabilityId: input.capabilityId }),
          ...(input.capabilityVersion === undefined
            ? {}
            : { capabilityVersion: String(input.capabilityVersion) }),
        },
      };
      yield* ledger.upsert(enriched);
      return { status: "ok" as const, record: enriched };
    });

  const requestRevoke: FeePolicyServiceShape["requestRevoke"] = ({ environmentId }) =>
    Effect.gen(function* () {
      const resolved = yield* adapter.settings;
      if (!resolved.configured || resolved.target === undefined) {
        return refused("unconfigured", resolved.reason ?? "forge sepolia target not configured");
      }
      const record = yield* adapter.buildIntent({
        kind: "revoke-policy",
        environmentId,
        bindingId: forgeBindingId(resolved.target.poolKey),
        idempotencyKey: randomUUID(),
      });
      return { status: "ok" as const, record };
    }).pipe(
      Effect.catchTag("ForgeIntentBuildError", (cause) =>
        Effect.succeed(refused("build-failed", cause.detail)),
      ),
    );

  const requestPause: FeePolicyServiceShape["requestPause"] = ({ environmentId }) =>
    Effect.gen(function* () {
      const record = yield* adapter.buildIntent({
        kind: "pause",
        environmentId,
        idempotencyKey: randomUUID(),
      });
      return { status: "ok" as const, record };
    }).pipe(
      Effect.catchTag("ForgeIntentBuildError", (cause) =>
        Effect.succeed(refused("build-failed", cause.detail)),
      ),
    );

  const requestUnpause: FeePolicyServiceShape["requestUnpause"] = ({ environmentId }) =>
    Effect.gen(function* () {
      if (localPause) {
        return refused(
          "locally-paused",
          "local pause is set; unpause is blocked until it is cleared",
        );
      }
      const record = yield* adapter.buildIntent({
        kind: "unpause",
        environmentId,
        idempotencyKey: randomUUID(),
      });
      return { status: "ok" as const, record };
    }).pipe(
      Effect.catchTag("ForgeIntentBuildError", (cause) =>
        Effect.succeed(refused("build-failed", cause.detail)),
      ),
    );

  const requestRemoveLiquidity: FeePolicyServiceShape["requestRemoveLiquidity"] = (input) =>
    Effect.gen(function* () {
      const record = yield* adapter.buildIntent({
        kind: "remove-liquidity",
        idempotencyKey: randomUUID(),
        environmentId: input.environmentId,
        tickLower: input.tickLower,
        tickUpper: input.tickUpper,
        liquidity: input.liquidity,
        tokenId: input.tokenId,
        ...(input.salt === undefined ? {} : { salt: input.salt }),
        ...(input.minAmount0Raw === undefined ? {} : { minAmount0Raw: input.minAmount0Raw }),
        ...(input.minAmount1Raw === undefined ? {} : { minAmount1Raw: input.minAmount1Raw }),
      });
      return { status: "ok" as const, record };
    }).pipe(
      Effect.catchTag("ForgeIntentBuildError", (cause) =>
        Effect.succeed(refused("build-failed", cause.detail)),
      ),
    );

  const requestInitializePool: FeePolicyServiceShape["requestInitializePool"] = ({
    environmentId,
    sqrtPriceX96,
  }) =>
    Effect.gen(function* () {
      if (localPause) {
        return refused(
          "locally-paused",
          "local pause is set; new chain-affecting intents are stopped",
        );
      }
      const record = yield* adapter.buildIntent({
        kind: "initialize-pool",
        environmentId,
        sqrtPriceX96,
      });
      return { status: "ok" as const, record };
    }).pipe(
      Effect.catchTag("ForgeIntentBuildError", (cause) =>
        Effect.succeed(refused("build-failed", cause.detail)),
      ),
    );

  const requestAddLiquidity: FeePolicyServiceShape["requestAddLiquidity"] = (input) =>
    Effect.gen(function* () {
      if (localPause) {
        return refused(
          "locally-paused",
          "local pause is set; new chain-affecting intents are stopped",
        );
      }
      const record = yield* adapter.buildIntent({
        kind: "add-liquidity",
        idempotencyKey: randomUUID(),
        environmentId: input.environmentId,
        tickLower: input.tickLower,
        tickUpper: input.tickUpper,
        liquidity: input.liquidity,
        ...(input.salt === undefined ? {} : { salt: input.salt }),
        deposits: input.deposits,
        ...(input.tokenId === undefined ? {} : { tokenId: input.tokenId }),
        ...(input.ownerAddress === undefined ? {} : { ownerAddress: input.ownerAddress }),
      });
      return { status: "ok" as const, record };
    }).pipe(
      Effect.catchTag("ForgeIntentBuildError", (cause) =>
        Effect.succeed(refused("build-failed", cause.detail)),
      ),
    );

  const requestBoundedSwap: FeePolicyServiceShape["requestBoundedSwap"] = (input) =>
    Effect.gen(function* () {
      if (localPause) {
        return refused(
          "locally-paused",
          "local pause is set; new chain-affecting intents are stopped",
        );
      }
      const record = yield* adapter.buildIntent({
        kind: "bounded-swap",
        idempotencyKey: randomUUID(),
        environmentId: input.environmentId,
        zeroForOne: input.zeroForOne,
        amountSpecifiedRaw: input.amountSpecifiedRaw,
        sqrtPriceLimitX96: input.sqrtPriceLimitX96,
        quoteAmountRaw: input.quoteAmountRaw,
      });
      return { status: "ok" as const, record };
    }).pipe(
      Effect.catchTag("ForgeIntentBuildError", (cause) =>
        Effect.succeed(refused("build-failed", cause.detail)),
      ),
    );

  // ------------------------------------------------------------- broadcast

  const broadcast: FeePolicyServiceShape["broadcast"] = (intentId) =>
    Effect.gen(function* () {
      const record = yield* ledger.find(intentId);
      if (record === null) {
        return {
          status: "refused" as const,
          refusal: { reason: "not-found" as const, detail: `no intent ${intentId}` },
        };
      }
      if (localPause && LOCALLY_PAUSED_BLOCKED_KINDS.has(record.kind)) {
        return {
          status: "refused" as const,
          refusal: {
            reason: "locally-paused" as const,
            detail: `local pause is set; ${record.kind} intents are stopped (safety controls stay available)`,
          },
        };
      }
      if (record.kind === "publish-policy") {
        // The capability may have been paused/replaced since this draft was built.
        if (Option.isNone(capabilityStore) || record.params.capabilityId === undefined) {
          return {
            status: "refused" as const,
            refusal: {
              reason: "execution-unavailable" as const,
              detail: "installed capability verification unavailable",
            },
          };
        }
        const active = yield* capabilityStore.value
          .activeState({
            environmentId: record.environmentId,
            capabilityId: record.params.capabilityId,
          })
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const head = yield* adapter.readChainHead;
        if (
          active === null ||
          active.status !== "installed" ||
          String(active.version) !== record.params.capabilityVersion ||
          active.bundleSha256 !== record.params.bundleSha256 ||
          head.status !== "ok" ||
          Number(record.params.expiryUnix) <= head.timestampUnix
        ) {
          return {
            status: "refused" as const,
            refusal: {
              reason: "execution-unavailable" as const,
              detail: "publication evidence expired or installed capability changed",
            },
          };
        }
      }
      const sent = yield* adapter.broadcastIntent({ intent: record });
      return { status: "submitted" as const, record: sent.record };
    }).pipe(
      Effect.catchTag("ForgeBroadcastRefused", (refusal) =>
        Effect.succeed({
          status: "refused" as const,
          refusal: { reason: refusal.reason, detail: refusal.detail },
        }),
      ),
      Effect.catch((cause) =>
        Effect.succeed({
          status: "refused" as const,
          refusal: { reason: "rpc-error" as const, detail: String(cause) },
        }),
      ),
    );

  const reconcile: FeePolicyServiceShape["reconcile"] = (intentId) =>
    Effect.gen(function* () {
      if (intentId !== undefined) {
        const record = yield* adapter.reconcileIntent(intentId);
        return record === null ? [] : [record];
      }
      const open = (yield* recordsForTarget).filter(
        (record) => record.status === "submitted" || record.status === "unknown",
      );
      const reconciled: Array<ForgeIntentRecord> = [];
      for (const record of open) {
        const next = yield* adapter.reconcileIntent(record.intentId);
        if (next !== null) reconciled.push(next);
      }
      return reconciled;
    });

  const setLocalPause: FeePolicyServiceShape["setLocalPause"] = (paused) =>
    Effect.gen(function* () {
      if (ledger.writePaused === undefined) {
        // No durable control state (in-memory ledger): the brake stays
        // process-local, exactly the reviewed behavior.
        localPause = paused;
        return yield* readDirectControls;
      }
      if (paused) {
        // Set the brake in memory FIRST, then persist. A failed write leaves
        // the pause on in this process — the safe direction.
        localPause = true;
        yield* ledger
          .writePaused(FORGE_LOCAL_PAUSE_SCOPE, true)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning(`forge local pause persisted write failed: ${String(cause)}`),
            ),
          );
      } else {
        // Clearing must be durable BEFORE the in-memory flag drops: a failed
        // write leaves the brake on.
        yield* ledger
          .writePaused(FORGE_LOCAL_PAUSE_SCOPE, false)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning(`forge local unpause persisted write failed: ${String(cause)}`),
            ),
          );
        const readBack = ledger.readPaused;
        if (readBack !== undefined) {
          const persisted = yield* readBack(FORGE_LOCAL_PAUSE_SCOPE).pipe(
            Effect.catch(() => Effect.succeed(true)),
          );
          if (!persisted) localPause = false;
        }
      }
      return yield* readDirectControls;
    });

  /**
   * The restart-safe sweep. Open intents for the CURRENT configured target
   * are reconciled through the adapter's uncertain-broadcast state machine
   * (which also settles gas reservations from receipts); open intents bound
   * to another target are reported, never decoded against this deployment.
   * Terminal intents get an idempotent gas-settle backstop so a crash between
   * settlement and reservation release cannot strand budget forever.
   */
  const reconcileOpenIntents: FeePolicyServiceShape["reconcileOpenIntents"] = Effect.gen(
    function* () {
      const settings = yield* adapter.settings;
      const targetFingerprint =
        settings.target === undefined ? null : immutableTargetFingerprint(settings.target);
      const all = yield* ledger.listAll;
      const open = all.filter(
        (record) => record.status === "submitted" || record.status === "unknown",
      );
      const skippedCrossTarget: Array<{
        readonly intentId: string;
        readonly kind: string;
        readonly status: string;
      }> = [];
      const reconciled: Array<ForgeIntentRecord> = [];
      for (const record of open) {
        if (targetFingerprint === null || record.params.targetFingerprint !== targetFingerprint) {
          skippedCrossTarget.push({
            intentId: record.intentId,
            kind: record.kind,
            status: record.status,
          });
          continue;
        }
        // Non-fatal per intent: one unreadable receipt must not block the
        // rest of the sweep (the startup wiring logs and continues).
        const next = yield* adapter
          .reconcileIntent(record.intentId)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                `forge open intent ${record.intentId} reconcile failed: ${cause}`,
              ).pipe(Effect.as(record)),
            ),
          );
        if (next !== null) reconciled.push(next);
      }
      if (ledger.settleGas !== undefined) {
        const terminal = all.filter(
          (record) =>
            (record.status === "confirmed" || record.status === "reverted") && record.gasAccounted,
        );
        for (const record of terminal) {
          if (record.gasCostWei === undefined) continue;
          yield* ledger
            .settleGas(record.intentId, record.gasCostWei)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  `forge intent ${record.intentId} reservation settle failed: ${String(cause)}`,
                ),
              ),
            );
        }
      }
      return { reconciled, skippedCrossTarget };
    },
  );

  return FeePolicyService.of({
    readPoolProposal,
    readPolicyState,
    readPositionState,
    readDirectControls,
    listIntents: (limit) => ledger.listRecent(limit),
    readSwapFeeEvidence: (txHash) => adapter.readSwapFeeEvidence(txHash),
    publishFromEvidence,
    requestRevoke,
    requestPause,
    requestUnpause,
    requestRemoveLiquidity,
    requestInitializePool,
    requestAddLiquidity,
    requestBoundedSwap,
    broadcast,
    reconcile,
    reconcileOpenIntents,
    setLocalPause,
  });
});

/** Open about its dependencies; the wiring point composes them. */
export const FeePolicyServiceLive = Layer.effect(FeePolicyService, makeFeePolicyService);
