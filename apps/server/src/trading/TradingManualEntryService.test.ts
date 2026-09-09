/**
 * TradingManualEntryService — the manual ticket's prepare path.
 *
 * What is worth pinning here: the mandatory stop (refused before any read),
 * the D4 manual-side exclusivity refusal with the mission named, the prepared
 * shape (manual owner token, feasible-size readout, the stop on the intent),
 * and the account envelope clamping a size the ticket asked too big.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import type {
  MarketBestBidOffer,
  OrderBook,
  ResolvedMarket,
} from "@t3tools/trading-contracts/market";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { IocSlippageConfigLive } from "./IocSlippageConfig.ts";
import { TradingCostEstimator } from "./TradingCostEstimator.ts";
import { TradingMissionServiceLive } from "./TradingMissionService.ts";
import {
  manualOwnerMissionToken,
  TradingManualEntryService,
  TradingManualEntryServiceLive,
} from "./TradingManualEntryService.ts";

const ethMarket = {
  symbol: "ETH",
  assetIndex: 1,
  szDecimals: 3,
  maxLeverage: 20,
  available: true,
} as unknown as ResolvedMarket;

const bbo: MarketBestBidOffer = {
  bidPrice: 3000,
  bidSize: 1,
  askPrice: 3001,
  askSize: 1,
  freshness: { observedAt: 0, source: "info_api", staleAfterMillis: 2_000 },
};

const orderBook = {
  market: "ETH",
  bids: [{ price: 3000, size: 1 }],
  asks: [{ price: 3001, size: 1 }],
  bestBidOffer: bbo,
  freshness: { observedAt: 0, source: "info_api", staleAfterMillis: 2_000 },
} as OrderBook;

const stubGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: () => Effect.succeed(ethMarket),
  getOrderBook: () => Effect.succeed(orderBook),
  getUserFeeRatesBps: () => Effect.succeed({ takerFeeBps: 5, makerFeeBps: 2 }),
  getAccountSnapshot: () =>
    Effect.succeed({
      address: "0xmaster",
      accountValue: 1_000,
      marginUsed: 0,
      withdrawable: 1_000,
      positions: [],
      freshness: { observedAt: 0, source: "info_api", staleAfterMillis: 5_000 },
    }),
} as unknown as HyperliquidGateway["Service"]);

const stubEstimator = Layer.succeed(TradingCostEstimator, {
  estimate: () =>
    Effect.succeed({
      roundTripUsd: 0.42,
    }),
} as unknown as TradingCostEstimator["Service"]);

const layer = it.layer(
  TradingManualEntryServiceLive.pipe(
    Layer.provideMerge(TradingMissionServiceLive),
    Layer.provide(stubGateway),
    Layer.provide(stubEstimator),
    Layer.provide(IocSlippageConfigLive),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_mission_markets`;
  yield* sql`DELETE FROM trading_execution_records`;
  yield* sql`DELETE FROM trading_position_snapshots`;
  yield* sql`DELETE FROM trading_orders`;
  yield* sql`DELETE FROM trading_accounts`;
  // The account the ticket names, with the master wallet the reads use.
  yield* sql`
    INSERT INTO trading_accounts (
      account_id, user_id, environment,
      master_wallet_json, execution_wallet_json, status, created_at, updated_at
    ) VALUES (
      'acct_1', 'local', 'testnet',
      '{"privyWalletId":"pw_1","address":"0xmaster","ownership":"user"}',
      '{"privyWalletId":"pw_1","address":"0xmaster","hyperliquidAgentName":"t3","ownership":"service"}',
      'active', 0, 0
    )
  `;
});

const request = {
  accountId: "acct_1",
  market: "ETH",
  side: "buy" as const,
  stopPrice: 2950,
  sizeEth: 0.05,
};

layer("TradingManualEntryService", (it) => {
  it.effect("refuses without a positive stop, before any read", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingManualEntryService;
      const refused = yield* service.prepare({ ...request, stopPrice: 0 });
      assert.equal(refused.outcome, "refused");
      assert.equal(refused.outcome === "refused" && refused.reason, "valid_stop_defined");
    }),
  );

  /**
   * A mission plus its held rows. Since migration 079 the held set
   * (`trading_mission_markets`) is the authority record, so a fixture mission
   * is invisible to D4 without its rows (06B).
   */
  const seedMission = (
    missionId: string,
    status: string,
    heldMarkets: ReadonlyArray<{ readonly market: string; readonly released: boolean }>,
    userId = "local",
  ) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO trading_missions (
          mission_id, user_id, trading_account_id, instruction, market,
          harness_json, status, control_json, authority_version, version,
          created_at, updated_at
        ) VALUES (
          ${missionId}, ${userId}, 'acct_1', 'trade', 'ETH', '{}', ${status},
          '{}', 1, 1, 1, 1
        )
      `;
      for (const held of heldMarkets) {
        yield* sql`
          INSERT INTO trading_mission_markets (
            mission_id, user_id, venue, market, bound_at, released_at
          ) VALUES (
            ${missionId}, ${userId}, 'hyperliquid', ${held.market}, 1,
            ${held.released ? 1 : null}
          )
        `;
      }
    });

  it.effect("refuses a market an active mission holds, naming the mission (D4)", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission("m_eth", "position_open", [{ market: "ETH", released: false }]);
      const service = yield* TradingManualEntryService;
      const refused = yield* service.prepare(request);
      assert.equal(refused.outcome, "refused");
      if (refused.outcome === "refused") {
        assert.equal(refused.reason, "market_owned_by_mission");
        assert.ok(refused.detail.includes("m_eth"));
      }
    }),
  );

  it.effect("refuses a held SECONDARY market, not just the mission's primary (06B)", () =>
    Effect.gen(function* () {
      // Primary ETH, held ETH and BTC: a manual ticket on BTC refuses even
      // though trading_missions.market says ETH.
      yield* migrated;
      yield* seedMission("m_multi", "position_open", [
        { market: "ETH", released: false },
        { market: "BTC", released: false },
      ]);
      const service = yield* TradingManualEntryService;
      const refused = yield* service.prepare({ ...request, market: "BTC" });
      assert.equal(refused.outcome, "refused");
      if (refused.outcome === "refused") {
        assert.equal(refused.reason, "market_owned_by_mission");
        assert.ok(refused.detail.includes("m_multi"));
        assert.ok(refused.detail.includes("BTC"));
      }
    }),
  );

  it.effect("a released secondary market is tradeable again (06B)", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedMission("m_released", "position_open", [
        { market: "ETH", released: false },
        { market: "BTC", released: true },
      ]);
      const service = yield* TradingManualEntryService;
      const prepared = yield* service.prepare({ ...request, market: "BTC" });
      assert.equal(
        prepared.outcome,
        "prepared",
        prepared.outcome === "refused" ? `${prepared.reason}: ${prepared.detail}` : "",
      );
    }),
  );

  it.effect("a terminal mission holds nothing (06B)", () =>
    Effect.gen(function* () {
      // Completed missions release their rows; nothing refuses here.
      yield* migrated;
      yield* seedMission("m_done", "completed", [{ market: "ETH", released: true }]);
      const service = yield* TradingManualEntryService;
      const prepared = yield* service.prepare(request);
      assert.equal(
        prepared.outcome,
        "prepared",
        prepared.outcome === "refused" ? `${prepared.reason}: ${prepared.detail}` : "",
      );
    }),
  );

  it.effect("another active holder still refuses regardless of user (06B)", () =>
    Effect.gen(function* () {
      // The refusal scope stays conservative: any live held row refuses,
      // whatever user owns it.
      yield* migrated;
      yield* seedMission("m_other", "position_open", [{ market: "ETH", released: false }], "other");
      const service = yield* TradingManualEntryService;
      const refused = yield* service.prepare(request);
      assert.equal(refused.outcome, "refused");
      if (refused.outcome === "refused") assert.equal(refused.reason, "market_owned_by_mission");
    }),
  );

  it.effect("a failed ownership read refuses the ticket before any network read (06B)", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      // The read itself fails — the held-set table is gone. That must not be
      // answered as "nobody holds it". The layer (and its database) is shared
      // across this file, so the table is restored afterwards.
      yield* sql`DROP TABLE trading_mission_markets`;
      const service = yield* TradingManualEntryService;
      const refused = yield* service.prepare(request);
      yield* sql`
        CREATE TABLE IF NOT EXISTS trading_mission_markets (
          mission_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          venue TEXT NOT NULL,
          market TEXT NOT NULL,
          bound_at INTEGER NOT NULL,
          released_at INTEGER,
          PRIMARY KEY (mission_id, venue, market)
        )
      `;
      assert.equal(refused.outcome, "refused");
      if (refused.outcome === "refused") {
        assert.equal(refused.reason, "market_data_unavailable");
        assert.ok(
          refused.detail.includes("held-market ownership could not be read"),
          refused.detail,
        );
      }
    }),
  );

  // R6-2: the account's per-asset leverage (isolated 10x here, left behind by
  // a mission era) is read from the last persisted snapshot; the mandatory
  // stop must clear the conservative liquidation estimate that implies.
  // At entry ~3001, 10x, maxLeverage 20 (mmf = 1/40): long liq ≈ 2775.9,
  // short liq ≈ 3225 off the 3000 bid.
  const seedInheritedLeverage = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_position_snapshots (
        mission_id, market, size, entry_price, unrealised_pnl, margin_used,
        protected_size, observed_at, leverage, account_id, venue, asset
      ) VALUES (NULL, 'ETH', 0, NULL, 0, 0, 0, 5, 10, 'acct_1', 'hyperliquid', 'ETH')
    `;
  });

  it.effect("refuses a long whose stop sits at or below the estimated liquidation", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedInheritedLeverage;
      const service = yield* TradingManualEntryService;
      const refused = yield* service.prepare({ ...request, stopPrice: 2_700 });
      assert.equal(refused.outcome, "refused");
      if (refused.outcome !== "refused") return;
      assert.equal(refused.reason, "stop_beyond_liquidation");
      assert.ok(refused.detail.includes("10x"), refused.detail);
      assert.ok(refused.detail.includes("2775"), refused.detail);
    }),
  );

  it.effect("refuses a short whose stop sits at or above the estimated liquidation", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedInheritedLeverage;
      const service = yield* TradingManualEntryService;
      const refused = yield* service.prepare({
        ...request,
        side: "sell",
        stopPrice: 3_300,
      });
      assert.equal(refused.outcome, "refused");
      if (refused.outcome !== "refused") return;
      assert.equal(refused.reason, "stop_beyond_liquidation");
      assert.ok(refused.detail.includes("3225"), refused.detail);
    }),
  );

  it.effect("passes a protective stop through even at inherited leverage", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedInheritedLeverage;
      const service = yield* TradingManualEntryService;
      // 2950 is above the ~2775.9 long estimate: the stop fires before the
      // exchange takes the position, so the ticket prices normally.
      const prepared = yield* service.prepare({ ...request, stopPrice: 2_950 });
      assert.equal(
        prepared.outcome,
        "prepared",
        prepared.outcome === "refused" ? `${prepared.reason}: ${prepared.detail}` : "",
      );
      // And the short mirror: 3100 is below the ~3225 short estimate.
      const short = yield* service.prepare({ ...request, side: "sell", stopPrice: 3_100 });
      assert.equal(
        short.outcome,
        "prepared",
        short.outcome === "refused" ? `${short.reason}: ${short.detail}` : "",
      );
    }),
  );

  it.effect("prepares a sized ticket under the manual owner token, stop attached", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingManualEntryService;
      const prepared = yield* service.prepare(request);
      if (prepared.outcome === "refused") {
        assert.fail(`refused: ${prepared.reason} — ${prepared.detail}`);
      }
      if (prepared.outcome !== "prepared") return;
      assert.equal(prepared.intent.missionId, manualOwnerMissionToken("acct_1"));
      assert.equal(prepared.intent.stop?.stopPrice, 2950);
      assert.equal(prepared.size, 0.05);
      assert.equal(prepared.constrainedBy, "requested");
      // The live readout: the largest size every account ceiling allows.
      assert.ok(prepared.feasibleSize > prepared.size);
      assert.ok(prepared.plannedLossAtStopUsd > 0);
      assert.equal(prepared.estimatedRoundTripCostUsd, 0.42);
      // Preview mode allocates no sequence.
      assert.equal(prepared.intent.executionSequence, 0);
    }),
  );

  it.effect("clamps a size the account envelope cannot fund, and says which rule", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingManualEntryService;
      // 100 ETH at ~$3,001 is ~$300k against a $1,000 account.
      const prepared = yield* service.prepare({ ...request, sizeEth: 100 });
      assert.equal(prepared.outcome, "prepared");
      if (prepared.outcome !== "prepared") return;
      assert.notEqual(prepared.constrainedBy, "requested");
      assert.ok(prepared.size < 100);
      assert.ok(prepared.notes.length > 0);
    }),
  );

  it.effect("allocates a real, advancing sequence only when asked to commit", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingManualEntryService;
      const first = yield* service.prepare(request, { allocateSequence: true });
      const second = yield* service.prepare(request, { allocateSequence: true });
      assert.equal(first.outcome, "prepared");
      assert.equal(second.outcome, "prepared");
      if (first.outcome !== "prepared" || second.outcome !== "prepared") return;
      assert.ok(second.intent.executionSequence > first.intent.executionSequence);
    }),
  );
  // The keyless install: no signer armed, so `TradingAccountBootstrap` wrote no
  // `trading_accounts` row. Preview is a pure read and used to die here on a
  // generic RPC error, which told the user nothing about why.
  it.effect("degrades the preview to an honest quote when there is no signer", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM trading_accounts`;

      const service = yield* TradingManualEntryService;
      const refused = yield* service.prepare(request);
      assert.equal(refused.outcome, "refused");
      if (refused.outcome !== "refused") return;
      assert.equal(refused.reason, "no_trading_signer");
      // What is wrong, and that everything else still works.
      assert.include(refused.detail, "no trading signer is configured");
      assert.include(refused.detail, "backtests and validations all work");
      // And the public book still says where this ticket would fill: a buy
      // takes the ask.
      assert.include(refused.detail, "bid 3000 ask 3001");
      assert.include(refused.detail, "fill near 3001");
    }),
  );
});
