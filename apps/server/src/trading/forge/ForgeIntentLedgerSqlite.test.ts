/**
 * What the durable Forge intent ledger claims, held to its contract.
 *
 * One in-memory SQLite per layer, migrated through the real runner — the
 * same engine production uses, only the database is disposable. The claim
 * tests prove atomicity (exactly one winner), fail-closed gas rules
 * (unenforceable reservations refuse; unknown submissions stay reserved),
 * and that settlement releases budget exactly once.
 *
 * @module ForgeIntentLedgerSqlite.test
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { SEPOLIA_CHAIN_ID } from "./SepoliaTarget.ts";
import {
  makeForgeGrantGuard,
  makeForgeIntentLedgerSqlite,
  type ForgeIntentLedgerSqliteShape,
} from "./ForgeIntentLedgerSqlite.ts";
import type { ForgeGrantGuardShape } from "./UniswapTestnetAdapter.ts";
import type { ForgeIntentRecord } from "./UniswapTestnetAdapter.ts";
import type { ForgeSpendGrant } from "./SepoliaTarget.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

// The layer is shared across the cases below, so each starts from empty
// forge tables (migrations themselves are idempotent).
const migrated = Effect.gen(function* () {
  yield* runMigrations({});
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM forge_intents`;
  yield* sql`DELETE FROM forge_control_state`;
  yield* sql`DELETE FROM forge_grant_approvals`;
});

const HOOK = `0x${"ab".repeat(19)}80`;
const C0 = `0x${"11".repeat(20)}`;
const C1 = `0x${"22".repeat(20)}`;

const record = (over: Partial<ForgeIntentRecord> = {}): ForgeIntentRecord => ({
  intentId: "forge_intent_1",
  idempotencyKey: "key-1",
  kind: "pause",
  environmentId: "env-1",
  createdAtMs: 1_000,
  unsigned: {
    chainId: SEPOLIA_CHAIN_ID,
    to: HOOK,
    data: "0x8456cb59",
    valueWei: "0",
    gasLimit: "100000",
    maxFeePerGasWei: "2000000000",
  },
  spend: {},
  status: "draft",
  gasAccounted: false,
  params: { targetFingerprint: "tf-1" },
  summary: "test record",
  ...over,
});

const grant = (over: Partial<ForgeSpendGrant> = {}): ForgeSpendGrant => ({
  grantId: "f0-grant",
  chainId: SEPOLIA_CHAIN_ID,
  hookAddress: HOOK,
  tokenCaps: [
    { token: C0, maxAmountRaw: "1000" },
    { token: C1, maxAmountRaw: "2000" },
  ],
  perSwapMaxQuoteRaw: "500",
  aggregateGasBudgetWei: "1000000000000",
  operatorAddress: `0x${"77".repeat(20)}`,
  expiresAtUnix: 1_900_000_000,
  ...over,
});

layer("ForgeIntentLedgerSqlite", (it) => {
  it.effect("round-trips records with receipts, refusals, and spend", () =>
    Effect.gen(function* () {
      yield* migrated;
      const ledger = yield* makeForgeIntentLedgerSqlite;
      const full = record({
        status: "confirmed",
        txHash: "0x" + "aa".repeat(32),
        submittedAtMs: 2_000,
        settledAtBlockNumber: 42,
        gasCostWei: "150000000000",
        gasAccounted: true,
        receipt: {
          txHash: "0x" + "aa".repeat(32),
          status: "confirmed",
          blockNumber: 42,
          gasUsedUnits: "100000",
          effectiveGasPriceWei: "1500000000",
          gasCostWei: "150000000000",
          hookEvents: [],
          poolEvents: [],
        },
        lastRefusal: { reason: "grant-missing", detail: "before approval", refusedAtMs: 1_500 },
        spend: { deposits: [{ token: C0, amountRaw: "7" }], swapQuoteAmountRaw: "9" },
      });
      yield* ledger.upsert(full);
      const read = yield* ledger.find(full.intentId);
      assert.deepEqual(read, full);
      assert.deepEqual(yield* ledger.findByIdempotencyKey("key-1"), full);
      assert.equal(yield* ledger.totalAccountedGasWei, "150000000000");
      // Upsert is idempotent for the same id.
      yield* ledger.upsert({ ...full, summary: "again" });
      assert.equal((yield* ledger.find(full.intentId))?.summary, "again");
    }),
  );

  it.effect("lists newest-first with the presentation cap on listRecent", () =>
    Effect.gen(function* () {
      yield* migrated;
      const ledger = yield* makeForgeIntentLedgerSqlite;
      for (let index = 0; index < 5; index += 1) {
        yield* ledger.upsert(
          record({
            intentId: `forge_intent_${index}`,
            idempotencyKey: `key-${index}`,
            createdAtMs: index,
          }),
        );
      }
      const all = yield* ledger.listAll;
      assert.deepEqual(
        all.map((entry) => entry.intentId),
        ["forge_intent_4", "forge_intent_3", "forge_intent_2", "forge_intent_1", "forge_intent_0"],
      );
      const recent = yield* ledger.listRecent(3);
      assert.equal(recent.length, 3);
      assert.equal(recent[0]?.intentId, "forge_intent_4");
    }),
  );

  it.effect("claim atomically marks unknown, reserves gas, and admits once", () =>
    Effect.gen(function* () {
      yield* migrated;
      const ledger = yield* makeForgeIntentLedgerSqlite;
      yield* ledger.upsert(record());
      // gasLimit 100000 x maxFeePerGas 2 gwei = 2e14 wei reserved.
      const claimed = yield* ledger.durableAdmission.claim(
        record(),
        "f0-grant",
        "1000000000000000",
      );
      assert.equal(claimed, true);
      // The durable claim persists `unknown` before any side effect.
      const stored = yield* ledger.find("forge_intent_1");
      assert.equal(stored?.status, "unknown");
      assert.equal(yield* ledger.totalReservedGasWei, "200000000000000");
      // A second claimant loses.
      const again = yield* ledger.durableAdmission.claim(record(), "f0-grant", "1000000000000000");
      assert.equal(again, false);
    }),
  );

  it.effect("concurrent claims admit exactly one winner", () =>
    Effect.gen(function* () {
      yield* migrated;
      const ledger = yield* makeForgeIntentLedgerSqlite;
      yield* ledger.upsert(record());
      const results = yield* Effect.all(
        [
          ledger.durableAdmission.claim(record(), "f0-grant", "1000000000000000"),
          ledger.durableAdmission.claim(record(), "f0-grant", "1000000000000000"),
          ledger.durableAdmission.claim(record(), "f0-grant", "1000000000000000"),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((won) => won).length, 1);
      assert.equal(yield* ledger.totalReservedGasWei, "200000000000000");
    }),
  );

  it.effect("claim refuses unknown records, non-drafts, and unenforceable gas", () =>
    Effect.gen(function* () {
      yield* migrated;
      const ledger = yield* makeForgeIntentLedgerSqlite;
      // Not persisted at all.
      assert.equal(
        yield* ledger.durableAdmission.claim(record(), "f0-grant", "1000000000000"),
        false,
      );
      // Claimed once already.
      yield* ledger.upsert(record());
      yield* ledger.durableAdmission.claim(record(), "f0-grant", "1000000000000");
      assert.equal(
        yield* ledger.durableAdmission.claim(record(), "f0-grant", "1000000000000"),
        false,
      );
      // No gas fields: an unenforceable reservation is worse than none.
      yield* ledger.upsert(
        record({
          intentId: "forge_intent_noGas",
          idempotencyKey: "key-noGas",
          unsigned: { chainId: SEPOLIA_CHAIN_ID, to: HOOK, data: "0x8456cb59", valueWei: "0" },
        }),
      );
      assert.equal(
        yield* ledger.durableAdmission.claim(
          record({
            intentId: "forge_intent_noGas",
            idempotencyKey: "key-noGas",
            unsigned: { chainId: SEPOLIA_CHAIN_ID, to: HOOK, data: "0x8456cb59", valueWei: "0" },
          }),
          "f0-grant",
          "1000000000000",
        ),
        false,
      );
      // Legacy gas price is equally enforceable.
      yield* ledger.upsert(
        record({
          intentId: "forge_intent_legacy",
          idempotencyKey: "key-legacy",
          unsigned: {
            chainId: SEPOLIA_CHAIN_ID,
            to: HOOK,
            data: "0x8456cb59",
            valueWei: "0",
            gasLimit: "3",
            gasPriceWei: "5",
          },
        }),
      );
      assert.equal(
        yield* ledger.durableAdmission.claim(
          record({
            intentId: "forge_intent_legacy",
            idempotencyKey: "key-legacy",
            unsigned: {
              chainId: SEPOLIA_CHAIN_ID,
              to: HOOK,
              data: "0x8456cb59",
              valueWei: "0",
              gasLimit: "3",
              gasPriceWei: "5",
            },
          }),
          "f0-grant",
          "1000000000000",
        ),
        true,
      );
    }),
  );

  it.effect("reservations bound the budget until settled; unknown stays reserved", () =>
    Effect.gen(function* () {
      yield* migrated;
      const ledger = yield* makeForgeIntentLedgerSqlite;
      // Each reservation is 2e14 wei; the budget admits one at a time and
      // one more only after the first settles at an actual cost of 1e14.
      yield* ledger.upsert(record());
      assert.equal(
        yield* ledger.durableAdmission.claim(record(), "f0-grant", "350000000000000"),
        true,
      );
      // A second reservation of the same size cannot fit the same budget.
      yield* ledger.upsert(
        record({ intentId: "forge_intent_2", idempotencyKey: "key-2", createdAtMs: 2_000 }),
      );
      assert.equal(
        yield* ledger.durableAdmission.claim(
          record({ intentId: "forge_intent_2", idempotencyKey: "key-2", createdAtMs: 2_000 }),
          "f0-grant",
          "350000000000000",
        ),
        false,
      );
      // Settling releases the reservation (actual cost recorded by the
      // settled record's upsert); the same size now fits again.
      yield* ledger.upsert({
        ...record(),
        status: "confirmed",
        gasCostWei: "100000000000000",
        gasAccounted: true,
      });
      yield* ledger.settleGas("forge_intent_1", "100000000000000");
      assert.equal(yield* ledger.totalReservedGasWei, "0");
      assert.equal(
        yield* ledger.durableAdmission.claim(
          record({ intentId: "forge_intent_2", idempotencyKey: "key-2", createdAtMs: 2_000 }),
          "f0-grant",
          "350000000000000",
        ),
        true,
      );
      // Unknown submissions never release: the budget stays conservative.
      const tiny = record({
        intentId: "forge_intent_3",
        idempotencyKey: "key-3",
        createdAtMs: 3_000,
        unsigned: {
          chainId: SEPOLIA_CHAIN_ID,
          to: HOOK,
          data: "0x8456cb59",
          valueWei: "0",
          gasLimit: "1",
          gasPriceWei: "1",
        },
      });
      yield* ledger.upsert(tiny);
      yield* ledger.durableAdmission.claim(tiny, "f0-grant", "350000000000000");
      assert.equal(yield* ledger.totalReservedGasWei, "200000000000001");
      // settleGas is idempotent.
      yield* ledger.settleGas("forge_intent_1", "100000000000000");
      assert.equal(yield* ledger.totalAccountedGasWei, "100000000000000");
    }),
  );

  it.effect("settleGas is storage-gated on a terminal receipt status", () =>
    Effect.gen(function* () {
      yield* migrated;
      const ledger = yield* makeForgeIntentLedgerSqlite;
      // A claimed intent still in `unknown` holds its reservation; calling
      // settleGas on it must be a no-op — the terminal predicate lives in
      // the UPDATE, not in caller convention.
      yield* ledger.upsert(record());
      assert.equal(
        yield* ledger.durableAdmission.claim(record(), "f0-grant", "300000000000000"),
        true,
      );
      yield* ledger.settleGas("forge_intent_1", "1");
      assert.equal(yield* ledger.totalReservedGasWei, "200000000000000");
      assert.equal(yield* ledger.totalAccountedGasWei, "0");
      // A draft that was never claimed cannot release or account anything.
      yield* ledger.upsert(
        record({ intentId: "forge_intent_draft", idempotencyKey: "key-d", createdAtMs: 2_000 }),
      );
      yield* ledger.settleGas("forge_intent_draft", "7");
      assert.equal(yield* ledger.totalAccountedGasWei, "0");
      // A reverted receipt is terminal exactly like a confirmed one.
      yield* ledger.upsert({
        ...record(),
        status: "reverted",
        gasCostWei: "150000000000000",
        gasAccounted: true,
      });
      yield* ledger.settleGas("forge_intent_1", "150000000000000");
      assert.equal(yield* ledger.totalReservedGasWei, "0");
      assert.equal(yield* ledger.totalAccountedGasWei, "150000000000000");
    }),
  );

  it.effect("paused control state is scoped and durable", () =>
    Effect.gen(function* () {
      yield* migrated;
      const ledger = yield* makeForgeIntentLedgerSqlite;
      assert.equal(yield* ledger.readPaused("scope-a"), false);
      yield* ledger.writePaused("scope-a", true);
      assert.equal(yield* ledger.readPaused("scope-a"), true);
      assert.equal(yield* ledger.readPaused("scope-b"), false);
      yield* ledger.writePaused("scope-a", false);
      assert.equal(yield* ledger.readPaused("scope-a"), false);
      // A fresh ledger instance over the same database reads the same state.
      const reread = yield* makeForgeIntentLedgerSqlite;
      yield* reread.writePaused("scope-a", true);
      assert.equal(yield* ledger.readPaused("scope-a"), true);
    }),
  );

  it.effect("grant guard records once, verifies identical, and refuses retargets", () =>
    Effect.gen(function* () {
      yield* migrated;
      const guard: ForgeGrantGuardShape = yield* makeForgeGrantGuard;
      assert.equal((yield* guard.recordOrVerify(grant())).status, "recorded");
      assert.equal((yield* guard.recordOrVerify(grant())).status, "verified");
      // Case-insensitive address and cap order are not binding differences.
      assert.equal(
        (yield* guard.recordOrVerify(
          grant({
            tokenCaps: [
              { token: C1.toUpperCase(), maxAmountRaw: "2000" },
              { token: C0, maxAmountRaw: "1000" },
            ],
          }),
        )).status,
        "verified",
      );
      // Every binding field mismatch is a retarget, never an update.
      for (const mutated of [
        grant({ hookAddress: `0x${"99".repeat(20)}` }),
        grant({ operatorAddress: `0x${"88".repeat(20)}` }),
        grant({ perSwapMaxQuoteRaw: "501" }),
        grant({ aggregateGasBudgetWei: "1000000000001" }),
        grant({ expiresAtUnix: 1_900_000_001 }),
        grant({ tokenCaps: [{ token: C0, maxAmountRaw: "1001" }] }),
      ]) {
        const verdict = yield* guard.recordOrVerify(mutated);
        assert.equal(verdict.status, "retarget", `expected retarget for ${mutated.grantId}`);
        if (verdict.status === "retarget") assert.include(verdict.detail, "refusing to retarget");
      }
      // The approvals row was never rewritten: the original still verifies.
      assert.equal((yield* guard.recordOrVerify(grant())).status, "verified");
      // A different grantId starts its own immutable record.
      assert.equal(
        (yield* guard.recordOrVerify(grant({ grantId: "f0-other" }))).status,
        "recorded",
      );
    }),
  );

  it.effect("exposes the reservation-aware seam the adapter shape requires", () =>
    Effect.gen(function* () {
      yield* migrated;
      const ledger: ForgeIntentLedgerSqliteShape = yield* makeForgeIntentLedgerSqlite;
      // The durable admission is present, not optional, on this ledger.
      assert.notEqual(ledger.durableAdmission, undefined);
      assert.notEqual(ledger.settleGas, undefined);
      assert.notEqual(ledger.readPaused, undefined);
      assert.notEqual(ledger.writePaused, undefined);
      assert.equal(yield* ledger.totalReservedGasWei, "0");
    }),
  );
});
