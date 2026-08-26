/**
 * Shared primitive schemas for the trading domain.
 *
 * The published contracts on the T3 Trade spec site declare plain `string` and
 * `number` for identifiers, timestamps, and money. These primitives preserve
 * those declared types exactly and only add runtime validation that the spec
 * already implies (non-empty identifiers, non-negative epoch millis, positive
 * money and leverage).
 *
 * @module TradingPrimitives
 */
import { Effect, Schema, SchemaTransformation } from "effect";

const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);

/** A durable record identifier. Declared type: `string`. */
export const TradingId = TrimmedString.check(Schema.isNonEmpty());
export type TradingId = typeof TradingId.Type;

/**
 * A market symbol as the exchange reports it. Declared type: `string`.
 *
 * `TradingMarket` is the mandate — the one market a mission is authorized to
 * act on. A wallet's contents are not a mandate: the master wallet can hold a
 * position or a resting order in any market, left by faucet play or an earlier
 * session, and a snapshot schema that admits only "ETH" cannot represent the
 * wallet at all. One BTC position used to make the whole account snapshot
 * undecodable, which killed every wakeup that carried it.
 *
 * Use this for what the exchange reports back; use `TradingMarket` for what the
 * mission asks for. They are the same shape now that assets are opaque; the
 * distinction that remains is intent, and the names carry it.
 */
export const ExchangeMarket = TrimmedString.check(Schema.isNonEmpty());
export type ExchangeMarket = typeof ExchangeMarket.Type;

/** Free-form narrative supplied by the harness. Declared type: `string`. */
export const TradingText = Schema.String;
export type TradingText = typeof TradingText.Type;

/** Epoch milliseconds. Declared type: `number`. */
export const UnixMillis = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
export type UnixMillis = typeof UnixMillis.Type;

/** A USD amount that may be zero. Declared type: `number`. */
export const UsdAmount = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
export type UsdAmount = typeof UsdAmount.Type;

/** A USD amount that must be strictly positive. Declared type: `number`. */
export const PositiveUsdAmount = Schema.Number.check(Schema.isGreaterThan(0));
export type PositiveUsdAmount = typeof PositiveUsdAmount.Type;

/** A price quoted by the exchange. Declared type: `number`. */
export const Price = Schema.Number.check(Schema.isGreaterThan(0));
export type Price = typeof Price.Type;

/**
 * An EVM address. Declared type: `` `0x${string}` `` — modeled as a template
 * literal so the runtime schema matches the published type rather than
 * widening it to `string`.
 */
export const EvmAddress = Schema.TemplateLiteral(["0x", Schema.String]);
export type EvmAddress = typeof EvmAddress.Type;

/**
 * A venue T3 Trade can trade on. Declared type: `"hyperliquid"`.
 *
 * One member, and the axis exists anyway: every market identity carries its
 * venue so that adding a second one is a data question rather than a rewrite.
 * No venue abstraction is built until there is a second venue to abstract
 * over — the literal union is the whole of it.
 */
export const TradingVenue = Schema.Literals(["hyperliquid"]);
export type TradingVenue = typeof TradingVenue.Type;

/** The venue every market belongs to until a second one arrives. */
export const DEFAULT_TRADING_VENUE: TradingVenue = "hyperliquid";

/**
 * An asset id, in whatever form its venue names it. Declared type: `string`.
 *
 * This used to be `"ETH" | "BTC"`, which was the whole of what a mission could
 * be mandated to trade — two literals standing in for a universe of nearly two
 * hundred. Validation moved to where the answer actually lives: Hyperliquid's
 * `MarketResolver` already resolves the live universe, so it decides whether an
 * asset exists, and shared code treats the id as opaque. A future venue names
 * its assets its own way (a chain and a token address, say) without this schema
 * having an opinion.
 */
export const TradingMarket = TrimmedString.check(Schema.isNonEmpty());
export type TradingMarket = typeof TradingMarket.Type;

/** The asset a mission trades when none was chosen at creation. */
export const DEFAULT_TRADING_MARKET: TradingMarket = "ETH";

/**
 * Which asset on which venue — the identity every market-scoped row, contract,
 * and read model carries.
 *
 * Persisted as two columns rather than one composite string, so a query can
 * ask about a venue or an asset without parsing. The pair is the identity: two
 * venues may well name an asset the same thing and mean different markets.
 */
export const MarketRef = Schema.Struct({
  venue: TradingVenue,
  asset: TradingMarket,
});
export type MarketRef = typeof MarketRef.Type;

/** The `MarketRef` for an asset on the default venue. */
export const marketRef = (asset: TradingMarket): MarketRef => ({
  venue: DEFAULT_TRADING_VENUE,
  asset,
});

/**
 * Read a `MarketRef` out of persisted JSON that may predate the venue axis.
 *
 * Wakes, plans, and watches carry market strings written before venues
 * existed; a bare `"ETH"` means Hyperliquid, because that is the only venue
 * there has ever been. New payloads carry the pair and decode unchanged.
 */
export const decodeMarketRef = (value: unknown): MarketRef | null => {
  if (typeof value === "string" && value.trim().length > 0) return marketRef(value.trim());
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const asset = record["asset"];
  if (typeof asset !== "string" || asset.trim().length === 0) return null;
  const venue = record["venue"];
  return {
    venue: venue === undefined ? DEFAULT_TRADING_VENUE : (venue as TradingVenue),
    asset: asset.trim(),
  };
};

/** `venue:asset`, for a log line or a map key. Never for storage. */
export const formatMarketRef = (ref: MarketRef): string => `${ref.venue}:${ref.asset}`;

/** Whether two refs name the same market. */
export const sameMarket = (left: MarketRef, right: MarketRef): boolean =>
  left.venue === right.venue && left.asset === right.asset;
