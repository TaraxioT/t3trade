/**
 * SubstreamsSourceStore — the durable, committed-only boundary for Substreams
 * chain data (frozen A→B interface from the parallel checkpoint).
 *
 * One source is one namespaced stream identity — environment + chain +
 * package SHA-256 + module + module digest (module + params + schema
 * version) — so a cursor is never reused after module semantics change.
 * Everything a detector can see is COMMITTED data: blocks and events land in
 * ONE transaction beside the cursor advance and the outbox notification, so
 * crash-before-commit replays a batch and crash-after-commit replays it
 * duplicate-safely. Block envelopes include zero-swap blocks (event_count
 * 0), which is what makes an empty interval provable rather than inferred
 * from silence.
 *
 * The store is SQL only: no provider, no network, no signer. Input records
 * are validated (hex/decimal vocabularies) before any write; a batch that
 * fails validation refuses WHOLLY. Health is data, never aspirational: the
 * state machine (starting/healthy/stale/unhealthy) and its reason are
 * committed beside the watermark they describe.
 *
 * @module SubstreamsSourceStore
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";

// ---------------------------------------------------------------------------
// The frozen committed-read contracts (A→B; shapes are binding)
// ---------------------------------------------------------------------------

export interface SubstreamsCommittedBlocks {
  readonly blocks: ReadonlyArray<{
    readonly number: string;
    readonly hash: string;
    readonly timestampMs: number;
    readonly eventCount: number;
  }>;
}

export interface SubstreamsSourceHealth {
  readonly state: "healthy" | "stale" | "unhealthy";
  readonly reason: string;
  readonly finalWatermarkBlock: string;
  readonly finalWatermarkTimestampMs: number;
  readonly lastCommitAtMs: number;
  readonly cursor: string | null;
  readonly packageSha256: string;
  readonly moduleDigest: string;
}

export interface SubstreamsPoolEventRow {
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly pool: string;
  readonly amount0Raw: string;
  readonly amount1Raw: string;
  readonly sqrtPriceX96: string;
  readonly sender: string;
  readonly recipient: string;
}

// ---------------------------------------------------------------------------
// Input contracts (provider-side records, validated before any write)
// ---------------------------------------------------------------------------

/** One normalized Swap record as the stream client decodes it. */
export interface SubstreamsPoolEventInput {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly pool: string;
  readonly amount0Raw: string;
  readonly amount1Raw: string;
  readonly sqrtPriceX96: string;
  readonly sender: string;
  readonly recipient: string;
}

export interface SubstreamsBlockInput {
  /** Decimal string; uint64 identity never rides a JS number. */
  readonly number: string;
  readonly hash: string;
  readonly timestampMs: number;
  readonly events: ReadonlyArray<SubstreamsPoolEventInput>;
}

export interface SubstreamsSourceIdentity {
  readonly environmentId: string;
  readonly chainId: string;
  readonly network: string;
  readonly packageSha256: string;
  readonly moduleName: string;
  /** Raw params string exactly as the stream is parameterized. */
  readonly params: string;
  readonly schemaVersion: number;
}

export type CommitBatchOutcome =
  | {
      readonly status: "committed";
      readonly sourceId: string;
      readonly blocks: number;
      readonly replayed: number;
    }
  | { readonly status: "gap"; readonly reason: string }
  | { readonly status: "conflict"; readonly reason: string }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "unknown_source"; readonly reason: string };

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

const DECIMAL_U64_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const HASH64_PATTERN = /^0x[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const SIGNED_DECIMAL_PATTERN = /^(0|-?[1-9][0-9]*)$/;
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

const blockNumberToInteger = (number: string): number | null => {
  if (!DECIMAL_U64_PATTERN.test(number)) return null;
  const value = Number(number);
  return Number.isSafeInteger(value) ? value : null;
};

/** Validate one block envelope and its events; null reason = valid. */
export function validateBlockInput(block: SubstreamsBlockInput): string | null {
  if (!DECIMAL_U64_PATTERN.test(block.number)) {
    return `block number ${JSON.stringify(block.number)} is not a decimal uint64 string`;
  }
  if (!HASH64_PATTERN.test(block.hash)) {
    return `block ${block.number} hash is not 0x + 64 lowercase hex`;
  }
  if (!Number.isSafeInteger(block.timestampMs) || block.timestampMs <= 0) {
    return `block ${block.number} timestampMs is not a positive safe integer`;
  }
  const seenEventKeys = new Set<string>();
  for (let index = 0; index < block.events.length; index += 1) {
    const event = block.events[index];
    if (event === undefined) continue;
    const label = `block ${block.number} event ${index}`;
    if (!HASH64_PATTERN.test(event.transactionHash))
      return `${label} transactionHash is not 0x + 64 lowercase hex`;
    if (!Number.isSafeInteger(event.logIndex) || event.logIndex < 0)
      return `${label} logIndex is not a non-negative safe integer`;
    if (!ADDRESS_PATTERN.test(event.pool)) return `${label} pool is not 0x + 40 lowercase hex`;
    if (!ADDRESS_PATTERN.test(event.sender)) return `${label} sender is not 0x + 40 lowercase hex`;
    if (!ADDRESS_PATTERN.test(event.recipient))
      return `${label} recipient is not 0x + 40 lowercase hex`;
    if (!SIGNED_DECIMAL_PATTERN.test(event.amount0Raw))
      return `${label} amount0Raw is not a signed decimal integer string`;
    if (!SIGNED_DECIMAL_PATTERN.test(event.amount1Raw))
      return `${label} amount1Raw is not a signed decimal integer string`;
    if (!UNSIGNED_DECIMAL_PATTERN.test(event.sqrtPriceX96))
      return `${label} sqrtPriceX96 is not a decimal integer string`;
    const key = `${event.transactionHash}:${event.logIndex}`;
    if (seenEventKeys.has(key))
      return `${label} duplicates transaction/log identity ${key} within the block`;
    seenEventKeys.add(key);
  }
  return null;
}

/** sha256 of the module digest inputs; the namespace a cursor belongs to. */
export const deriveModuleDigest = (input: {
  readonly moduleName: string;
  readonly params: string;
  readonly schemaVersion: number;
}): string =>
  NodeCrypto.createHash("sha256")
    .update(`${input.moduleName}\n${input.params}\n${input.schemaVersion}`, "utf8")
    .digest("hex");

/** sha256 of the full namespace tuple; the sourceId everything keys on. */
export const deriveSourceId = (identity: SubstreamsSourceIdentity, moduleDigest: string): string =>
  `sub_${NodeCrypto.createHash("sha256")
    .update(
      [
        identity.environmentId,
        identity.chainId,
        identity.network,
        identity.packageSha256,
        identity.moduleName,
        moduleDigest,
        String(identity.schemaVersion),
      ].join("\n"),
      "utf8",
    )
    .digest("hex")}`;

// ---------------------------------------------------------------------------
// The store service
// ---------------------------------------------------------------------------

export interface SubstreamsOutboxRow {
  readonly outboxId: string;
  readonly sourceId: string;
  readonly environmentId: string;
  readonly fromBlockNum: number;
  readonly toBlockNum: number;
  readonly toTimestampMs: number;
  readonly createdAtMs: number;
  readonly processedAtMs: number | null;
}

export interface SubstreamsSourceStoreShape {
  /**
   * Idempotently register the namespaced source and return its derived
   * sourceId. Re-registering the identical identity is a no-op; the UNIQUE
   * constraint keeps one row per namespace tuple.
   */
  readonly ensureSource: (input: {
    readonly identity: SubstreamsSourceIdentity;
    readonly now: number;
  }) => Effect.Effect<
    { readonly sourceId: string; readonly moduleDigest: string },
    PersistenceSqlError
  >;

  /**
   * Commit ONE batch of strictly contiguous blocks in a single transaction:
   * block envelopes (zero-event blocks included), normalized events, the
   * forward-only watermark, the cursor, and one coalesced outbox notification
   * keyed by the batch's closing block. Duplicate-safe on replay: identical
   * bytes for an already-committed block are counted as replayed; a different
   * hash for a committed number is a conflict (fork past finality), a hole in
   * the sequence is a gap, and either refuses the whole batch.
   */
  readonly commitBatch: (input: {
    readonly sourceId: string;
    readonly environmentId: string;
    readonly blocks: ReadonlyArray<SubstreamsBlockInput>;
    readonly cursor: string;
    readonly now: number;
  }) => Effect.Effect<CommitBatchOutcome, PersistenceSqlError>;

  /** The frozen A→B reads. */
  readonly committedWatermark: (
    environmentId: string,
    sourceId: string,
  ) => Effect.Effect<
    { readonly finalWatermarkBlock: string; readonly finalWatermarkTimestampMs: number } | null,
    PersistenceSqlError
  >;
  readonly readBlockEnvelopes: (input: {
    readonly environmentId: string;
    readonly sourceId: string;
    readonly fromBlock: string;
    readonly toBlock: string;
  }) => Effect.Effect<SubstreamsCommittedBlocks, PersistenceSqlError>;
  readonly readPoolEvents: (input: {
    readonly environmentId: string;
    readonly sourceId: string;
    readonly fromBlock: string;
    readonly toBlock: string;
  }) => Effect.Effect<ReadonlyArray<SubstreamsPoolEventRow>, PersistenceSqlError>;
  readonly sourceHealth: (
    environmentId: string,
    sourceId: string,
  ) => Effect.Effect<SubstreamsSourceHealth, PersistenceSqlError>;
  readonly sourceRevision: (
    environmentId: string,
    sourceId: string,
  ) => Effect.Effect<string, PersistenceSqlError>;

  /** The committed cursor the stream resumes from. */
  readonly resumeCursor: (
    environmentId: string,
    sourceId: string,
  ) => Effect.Effect<
    {
      readonly cursor: string | null;
      readonly state: SubstreamsSourceHealth["state"];
      readonly finalWatermarkBlockNum: number | null;
    } | null,
    PersistenceSqlError
  >;

  /** Health transitions. Committing a batch marks the source healthy. */
  readonly markStale: (input: {
    readonly environmentId: string;
    readonly sourceId: string;
    readonly reason: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly markUnhealthy: (input: {
    readonly environmentId: string;
    readonly sourceId: string;
    readonly reason: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;

  /** Outbox drain (B's scheduler): oldest-first pending rows, then durable ack. */
  readonly claimPendingOutbox: (input: {
    readonly environmentId: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<SubstreamsOutboxRow>, PersistenceSqlError>;
  readonly ackOutbox: (input: {
    readonly outboxId: string;
    readonly now: number;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
}

export class SubstreamsSourceStore extends Context.Service<
  SubstreamsSourceStore,
  SubstreamsSourceStoreShape
>()("t3/trading/forge/SubstreamsSourceStore") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`SubstreamsSourceStore.${operation}`);

// The params string is persisted as a JSON string value; the schema codec is
// the house JSON boundary (same encode shape ExternalSourceConnector uses).
const encodeJsonText = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

interface SourceRow {
  readonly source_id: string;
  readonly environment_id: string;
  readonly chain_id: string;
  readonly network: string;
  readonly package_sha256: string;
  readonly module_name: string;
  readonly module_digest: string;
  readonly params_json: string;
  readonly schema_version: number;
  readonly cursor: string | null;
  readonly state: string;
  readonly state_reason: string;
  readonly final_watermark_block: string | null;
  readonly final_watermark_block_num: number | null;
  readonly final_watermark_timestamp_ms: number | null;
  readonly last_commit_at_ms: number | null;
}

const toHealth = (row: SourceRow): SubstreamsSourceHealth => ({
  // 'starting' reads as stale: the source has committed nothing yet, which
  // is incompleteness (unknown to a detector), never a fault.
  state:
    row.state === "healthy" || row.state === "stale"
      ? row.state
      : row.state === "starting"
        ? "stale"
        : "unhealthy",
  reason: row.state_reason,
  finalWatermarkBlock: row.final_watermark_block ?? "0",
  finalWatermarkTimestampMs: row.final_watermark_timestamp_ms ?? 0,
  lastCommitAtMs: row.last_commit_at_ms ?? 0,
  cursor: row.cursor,
  packageSha256: row.package_sha256,
  moduleDigest: row.module_digest,
});

const unknownHealth = (sourceId: string): SubstreamsSourceHealth => ({
  state: "unhealthy",
  reason: `no substreams source ${JSON.stringify(sourceId)} is registered for this environment`,
  finalWatermarkBlock: "0",
  finalWatermarkTimestampMs: 0,
  lastCommitAtMs: 0,
  cursor: null,
  packageSha256: "",
  moduleDigest: "",
});

export const makeSubstreamsSourceStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const loadSource = (environmentId: string, sourceId: string) =>
    sql<SourceRow>`
      SELECT source_id, environment_id, chain_id, network, package_sha256, module_name, module_digest,
             params_json, schema_version, cursor, state, state_reason, final_watermark_block,
             final_watermark_block_num, final_watermark_timestamp_ms, last_commit_at_ms
      FROM substreams_sources
      WHERE environment_id = ${environmentId} AND source_id = ${sourceId}
    `.pipe(
      Effect.mapError(sqlFail("loadSource")),
      Effect.map((rows): SourceRow | null => rows[0] ?? null),
    );

  const ensureSource: SubstreamsSourceStoreShape["ensureSource"] = ({ identity, now }) =>
    Effect.gen(function* () {
      if (!/^[1-9][0-9]*$/.test(identity.chainId)) {
        return yield* new PersistenceSqlError({
          operation: "SubstreamsSourceStore.ensureSource",
          detail: "chainId must be a decimal string",
        });
      }
      if (!/^[0-9a-f]{64}$/.test(identity.packageSha256)) {
        return yield* new PersistenceSqlError({
          operation: "SubstreamsSourceStore.ensureSource",
          detail: "packageSha256 must be a 64-hex sha256",
        });
      }
      if (
        identity.moduleName.trim() === "" ||
        !Number.isSafeInteger(identity.schemaVersion) ||
        identity.schemaVersion <= 0
      ) {
        return yield* new PersistenceSqlError({
          operation: "SubstreamsSourceStore.ensureSource",
          detail: "moduleName must be non-empty and schemaVersion a positive integer",
        });
      }
      const moduleDigest = deriveModuleDigest({
        moduleName: identity.moduleName,
        params: identity.params,
        schemaVersion: identity.schemaVersion,
      });
      const sourceId = deriveSourceId(identity, moduleDigest);
      yield* sql`
        INSERT INTO substreams_sources (
          source_id, environment_id, chain_id, network, package_sha256, module_name, module_digest,
          params_json, schema_version, cursor, state, state_reason, created_at_ms
        ) VALUES (
          ${sourceId}, ${identity.environmentId}, ${identity.chainId}, ${identity.network},
          ${identity.packageSha256}, ${identity.moduleName}, ${moduleDigest},
          ${encodeJsonText(identity.params)}, ${identity.schemaVersion}, NULL, 'starting',
          'registered; no batch committed yet', ${now}
        )
        ON CONFLICT (source_id) DO NOTHING
      `.pipe(Effect.asVoid, Effect.mapError(sqlFail("ensureSource")));
      return { sourceId, moduleDigest };
    });

  const commitBatch: SubstreamsSourceStoreShape["commitBatch"] = ({
    sourceId,
    environmentId,
    blocks,
    cursor,
    now,
  }) =>
    Effect.gen(function* () {
      if (blocks.length === 0) {
        return {
          status: "invalid",
          reason: "a commit batch must carry at least one block envelope",
        } as const;
      }
      // Whole-batch validation before anything writes.
      for (const block of blocks) {
        const invalid = validateBlockInput(block);
        if (invalid !== null) return { status: "invalid", reason: invalid } as const;
      }
      // Within the batch, blocks are consecutive: strictly +1 steps, no
      // duplicates and no intra-batch holes.
      const numbers = blocks.map((block) => blockNumberToInteger(block.number)!);
      for (let index = 1; index < numbers.length; index += 1) {
        if (numbers[index]! !== numbers[index - 1]! + 1) {
          return {
            status: "gap",
            reason: `batch block numbers are not consecutive at position ${index}`,
          } as const;
        }
      }

      const outcome = yield* sql.withTransaction(
        Effect.gen(function* () {
          const source = yield* loadSource(environmentId, sourceId);
          if (source === null) {
            return {
              status: "unknown_source",
              reason: `no substreams source '${sourceId}' in this environment`,
            } as const;
          }
          // Contiguity against the committed watermark: the first batch sets
          // the baseline; a later batch either continues the watermark
          // exactly (first block = watermark + 1) or REPLAYS committed
          // history (first block <= watermark, every overlapped block
          // verified identical below before anything new writes), so
          // envelope coverage over any committed range stays provable.
          const watermarkNum = source.final_watermark_block_num ?? null;
          if (
            watermarkNum !== null &&
            numbers[0]! > watermarkNum &&
            numbers[0]! !== watermarkNum + 1
          ) {
            return {
              status: "gap",
              reason: `first block ${blocks[0]!.number} does not continue the committed watermark ${watermarkNum}`,
            } as const;
          }

          let replayed = 0;
          for (let index = 0; index < blocks.length; index += 1) {
            const block = blocks[index]!;
            const blockNum = numbers[index]!;
            const existing = yield* sql<{
              readonly block_hash: string;
              readonly event_count: number;
            }>`
              SELECT block_hash, event_count FROM substreams_blocks
              WHERE source_id = ${sourceId} AND block_number = ${block.number}
            `;
            const prior = existing[0];
            if (prior !== undefined) {
              if (prior.block_hash !== block.hash || prior.event_count !== block.events.length) {
                return {
                  status: "conflict",
                  reason: `block ${block.number} is committed with hash ${prior.block_hash} (${prior.event_count} events); the batch carries ${block.hash} (${block.events.length}) — a fork past committed finality`,
                } as const;
              }
              replayed += 1;
              continue;
            }
            yield* sql`
              INSERT INTO substreams_blocks (
                source_id, environment_id, block_number, block_num, block_hash, timestamp_ms,
                event_count, committed_at_ms
              ) VALUES (
                ${sourceId}, ${environmentId}, ${block.number}, ${blockNum}, ${block.hash},
                ${block.timestampMs}, ${block.events.length}, ${now}
              )
            `;
            for (const event of block.events) {
              yield* sql`
                INSERT INTO substreams_pool_events (
                  environment_id, chain_id, module_digest, block_number, block_num, block_hash,
                  transaction_hash, log_index, pool, amount0_raw, amount1_raw, sqrt_price_x96,
                  sender, recipient, committed_at_ms
                ) VALUES (
                  ${environmentId}, ${source.chain_id}, ${source.module_digest}, ${block.number},
                  ${blockNum}, ${block.hash}, ${event.transactionHash}, ${event.logIndex},
                  ${event.pool}, ${event.amount0Raw}, ${event.amount1Raw}, ${event.sqrtPriceX96},
                  ${event.sender}, ${event.recipient}, ${now}
                )
                ON CONFLICT DO NOTHING
              `;
            }
          }

          const lastBlock = blocks[blocks.length - 1]!;
          const lastNum = numbers[numbers.length - 1]!;
          const firstNum = numbers[0]!;
          // One coalesced notification per closing block: a replayed batch
          // maps to the same outbox id, so crash-after-commit replays do not
          // duplicate detector work.
          const outboxId = `subout_${sourceId.slice(4)}_${lastNum}`;
          yield* sql`
            INSERT INTO substreams_outbox (
              outbox_id, source_id, environment_id, from_block_num, to_block_num, to_timestamp_ms,
              created_at_ms
            ) VALUES (
              ${outboxId}, ${sourceId}, ${environmentId}, ${firstNum}, ${lastNum},
              ${lastBlock.timestampMs}, ${now}
            )
            ON CONFLICT (outbox_id) DO NOTHING
          `;
          // A pure replay never regresses the watermark or rewrites the
          // cursor; the advance only happens for genuinely new height.
          if (watermarkNum === null || lastNum > watermarkNum) {
            yield* sql`
              UPDATE substreams_sources SET
                cursor = ${cursor},
                state = 'healthy',
                state_reason = '',
                final_watermark_block = ${lastBlock.number},
                final_watermark_block_num = ${lastNum},
                final_watermark_timestamp_ms = ${lastBlock.timestampMs},
                last_commit_at_ms = ${now}
              WHERE environment_id = ${environmentId} AND source_id = ${sourceId}
            `;
          } else {
            yield* sql`
              UPDATE substreams_sources SET
                state = 'healthy',
                state_reason = '',
                last_commit_at_ms = ${now}
              WHERE environment_id = ${environmentId} AND source_id = ${sourceId}
            `;
          }
          return { status: "committed", sourceId, blocks: blocks.length, replayed } as const;
        }),
      );
      return outcome;
    }).pipe(Effect.mapError(sqlFail("commitBatch")));

  const committedWatermark: SubstreamsSourceStoreShape["committedWatermark"] = (
    environmentId,
    sourceId,
  ) =>
    loadSource(environmentId, sourceId).pipe(
      Effect.map((row) =>
        row === null ||
        row.final_watermark_block === null ||
        row.final_watermark_timestamp_ms === null
          ? null
          : {
              finalWatermarkBlock: row.final_watermark_block,
              finalWatermarkTimestampMs: row.final_watermark_timestamp_ms,
            },
      ),
    );

  const readBlockEnvelopes: SubstreamsSourceStoreShape["readBlockEnvelopes"] = ({
    environmentId,
    sourceId,
    fromBlock,
    toBlock,
  }) =>
    Effect.gen(function* () {
      const from = blockNumberToInteger(fromBlock);
      const to = blockNumberToInteger(toBlock);
      if (from === null || to === null || from > to) {
        return yield* new PersistenceSqlError({
          operation: "SubstreamsSourceStore.readBlockEnvelopes",
          detail: "fromBlock/toBlock must be decimal uint64 strings with from <= to",
        });
      }
      const rows = yield* sql<{
        readonly block_number: string;
        readonly block_hash: string;
        readonly timestamp_ms: number;
        readonly event_count: number;
      }>`
        SELECT block_number, block_hash, timestamp_ms, event_count FROM substreams_blocks
        WHERE source_id = ${sourceId} AND environment_id = ${environmentId}
          AND block_num >= ${from} AND block_num <= ${to}
        ORDER BY block_num ASC
      `.pipe(Effect.mapError(sqlFail("readBlockEnvelopes")));
      return {
        blocks: rows.map((row) => ({
          number: row.block_number,
          hash: row.block_hash,
          timestampMs: row.timestamp_ms,
          eventCount: row.event_count,
        })),
      };
    });

  const readPoolEvents: SubstreamsSourceStoreShape["readPoolEvents"] = ({
    environmentId,
    sourceId,
    fromBlock,
    toBlock,
  }) =>
    Effect.gen(function* () {
      const from = blockNumberToInteger(fromBlock);
      const to = blockNumberToInteger(toBlock);
      if (from === null || to === null || from > to) {
        return yield* new PersistenceSqlError({
          operation: "SubstreamsSourceStore.readPoolEvents",
          detail: "fromBlock/toBlock must be decimal uint64 strings with from <= to",
        });
      }
      // Range reads resolve the source row first so events are always keyed
      // by the source's own module digest, never by caller guesswork.
      const source = yield* loadSource(environmentId, sourceId);
      if (source === null) return [];
      const rows = yield* sql<{
        readonly block_number: string;
        readonly block_hash: string;
        readonly transaction_hash: string;
        readonly log_index: number;
        readonly pool: string;
        readonly amount0_raw: string;
        readonly amount1_raw: string;
        readonly sqrt_price_x96: string;
        readonly sender: string;
        readonly recipient: string;
      }>`
        SELECT block_number, block_hash, transaction_hash, log_index, pool, amount0_raw, amount1_raw,
               sqrt_price_x96, sender, recipient
        FROM substreams_pool_events
        WHERE environment_id = ${environmentId} AND module_digest = ${source.module_digest}
          AND block_num >= ${from} AND block_num <= ${to}
        ORDER BY block_num ASC, log_index ASC
      `.pipe(Effect.mapError(sqlFail("readPoolEvents")));
      return rows.map((row): SubstreamsPoolEventRow => ({
        blockNumber: row.block_number,
        blockHash: row.block_hash,
        transactionHash: row.transaction_hash,
        logIndex: row.log_index,
        pool: row.pool,
        amount0Raw: row.amount0_raw,
        amount1Raw: row.amount1_raw,
        sqrtPriceX96: row.sqrt_price_x96,
        sender: row.sender,
        recipient: row.recipient,
      }));
    });

  const sourceHealth: SubstreamsSourceStoreShape["sourceHealth"] = (environmentId, sourceId) =>
    loadSource(environmentId, sourceId).pipe(
      Effect.map((row) => (row === null ? unknownHealth(sourceId) : toHealth(row))),
    );

  const sourceRevision: SubstreamsSourceStoreShape["sourceRevision"] = (environmentId, sourceId) =>
    loadSource(environmentId, sourceId).pipe(
      Effect.map((row) =>
        row === null ? `unknown:${sourceId}` : `${row.package_sha256}/${row.module_digest}`,
      ),
    );

  const resumeCursor: SubstreamsSourceStoreShape["resumeCursor"] = (environmentId, sourceId) =>
    loadSource(environmentId, sourceId).pipe(
      Effect.map((row) =>
        row === null
          ? null
          : {
              cursor: row.cursor,
              state: toHealth(row).state,
              finalWatermarkBlockNum: row.final_watermark_block_num,
            },
      ),
    );

  const setHealthState = (
    environmentId: string,
    sourceId: string,
    state: "stale" | "unhealthy",
    reason: string,
  ) =>
    // Verify by readback (house style): the UPDATE's own result shape is not
    // part of the SQL layer's contract here, the committed row is.
    Effect.gen(function* () {
      yield* sql`
        UPDATE substreams_sources SET state = ${state}, state_reason = ${reason}
        WHERE environment_id = ${environmentId} AND source_id = ${sourceId}
          AND state != 'unhealthy'
      `.pipe(
        Effect.asVoid,
        Effect.mapError(sqlFail(state === "stale" ? "markStale" : "markUnhealthy")),
      );
      const after = yield* loadSource(environmentId, sourceId);
      return after !== null && after.state === state && after.state_reason === reason;
    });

  const markStale: SubstreamsSourceStoreShape["markStale"] = ({
    environmentId,
    sourceId,
    reason,
  }) => setHealthState(environmentId, sourceId, "stale", reason);

  const markUnhealthy: SubstreamsSourceStoreShape["markUnhealthy"] = ({
    environmentId,
    sourceId,
    reason,
  }) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE substreams_sources SET state = 'unhealthy', state_reason = ${reason}
        WHERE environment_id = ${environmentId} AND source_id = ${sourceId}
      `.pipe(Effect.asVoid, Effect.mapError(sqlFail("markUnhealthy")));
      const after = yield* loadSource(environmentId, sourceId);
      return after !== null && after.state === "unhealthy" && after.state_reason === reason;
    });

  const claimPendingOutbox: SubstreamsSourceStoreShape["claimPendingOutbox"] = ({
    environmentId,
    limit,
  }) =>
    sql<{
      readonly outbox_id: string;
      readonly source_id: string;
      readonly environment_id: string;
      readonly from_block_num: number;
      readonly to_block_num: number;
      readonly to_timestamp_ms: number;
      readonly created_at_ms: number;
      readonly processed_at_ms: number | null;
    }>`
      SELECT outbox_id, source_id, environment_id, from_block_num, to_block_num, to_timestamp_ms,
             created_at_ms, processed_at_ms
      FROM substreams_outbox
      WHERE environment_id = ${environmentId} AND processed_at_ms IS NULL
      ORDER BY created_at_ms ASC, outbox_id ASC
      LIMIT ${Math.min(Math.max(limit, 1), 500)}
    `.pipe(
      Effect.mapError(sqlFail("claimPendingOutbox")),
      Effect.map((rows) =>
        rows.map((row): SubstreamsOutboxRow => ({
          outboxId: row.outbox_id,
          sourceId: row.source_id,
          environmentId: row.environment_id,
          fromBlockNum: row.from_block_num,
          toBlockNum: row.to_block_num,
          toTimestampMs: row.to_timestamp_ms,
          createdAtMs: row.created_at_ms,
          processedAtMs: row.processed_at_ms,
        })),
      ),
    );

  const ackOutbox: SubstreamsSourceStoreShape["ackOutbox"] = ({ outboxId, now }) =>
    // Durable ack verified by readback; acking an already-acked row is a
    // successful no-op.
    Effect.gen(function* () {
      yield* sql`
        UPDATE substreams_outbox SET processed_at_ms = ${now}
        WHERE outbox_id = ${outboxId} AND processed_at_ms IS NULL
      `.pipe(Effect.asVoid, Effect.mapError(sqlFail("ackOutbox")));
      const after = yield* sql<{ readonly processed_at_ms: number | null }>`
        SELECT processed_at_ms FROM substreams_outbox WHERE outbox_id = ${outboxId}
      `.pipe(Effect.mapError(sqlFail("ackOutbox")));
      return after[0]?.processed_at_ms !== null && after[0]?.processed_at_ms !== undefined;
    });

  return {
    ensureSource,
    commitBatch,
    committedWatermark,
    readBlockEnvelopes,
    readPoolEvents,
    sourceHealth,
    sourceRevision,
    resumeCursor,
    markStale,
    markUnhealthy,
    claimPendingOutbox,
    ackOutbox,
  } satisfies SubstreamsSourceStoreShape;
});

export const SubstreamsSourceStoreLive = Layer.effect(
  SubstreamsSourceStore,
  makeSubstreamsSourceStore,
);
