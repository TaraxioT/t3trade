/**
 * Entering — the server-owned half of an execution, derived rather than asked
 * for.
 *
 * `trading_execute` used to ask the harness for the whole identity of an order:
 * the strategy version, the authority version, the harness run that owns the
 * decision lease, a monotonic `executionSequence`, a limit price that crosses,
 * a size within four separate ceilings, and precision the exchange accepts.
 * None of those are things a language model is in a position to know, and every
 * one of them is a refusal if it is wrong — so a correct read of the market
 * routinely died on the way to an order.
 *
 * `trading_enter` inverts that. The harness names what it wants in the
 * vocabulary it actually has — a market, a side, a stop, and optionally a size
 * — and the server derives everything else from state it already owns, checks
 * the result against the same §16.3 preview the execution runs, and submits
 * it. One call, because the intermediate token the harness used to carry
 * between two calls was never anything the harness could act on: it could read
 * the size and the price, but the only thing it could DO with them was hand
 * them straight back.
 *
 * Everything the two-step derived is still derived here. What is gone is the
 * round trip, and the four ways it could die between the two halves — an
 * expired quote, a lease that moved on, a mission mismatch, a token that was
 * never cut.
 *
 * @module TradingEntry
 */
import { Effect, Schema } from "effect";
import { TradingOrderSide } from "./execution.ts";
import { Price, TradingId, TradingMarket } from "./primitives.ts";
import { OrderPreference, TradingUrgency } from "./strategy.ts";

export const TRADING_ENTER_TOOL = "trading_enter";

/**
 * How long an entry's pricing context stays recognisably the market.
 *
 * The BBO a limit price is derived from stops describing the book after about
 * this long. The preview's own BBO freshness window is two seconds and binds
 * the pricing itself; this coarser bound is what a patient order's owner
 * measures its wait against — beyond it, the market the entry was approved
 * against is gone and the choice is cross or abandon.
 */
export const ENTRY_PRICING_VALIDITY_MILLIS = 90_000;

/** The two position-increasing actions an entry can be taken for. */
export const EntryActionType = Schema.Literals(["open", "scale_in"]);
export type EntryActionType = typeof EntryActionType.Type;

/**
 * Which ceiling decided the size, when the size is not the one that was asked
 * for.
 *
 * `requested` means nothing bound — the harness got the size it named, and a
 * size it named is never exceeded. The others are the five ceilings and the two
 * hard failures, and naming which one bound is the difference between "ask for
 * less" and "this mission cannot trade right now".
 */
export const EntrySizeConstraint = Schema.Literals([
  "requested",
  "gross_notional",
  "leverage",
  /**
   * The exchange account cannot fund the position at its configured leverage
   * — plan 34 step 7.1.
   *
   * The four ceilings above are the MANDATE's: what the mission is allowed to
   * take. This one is the account's: what it can actually take. They were
   * allowed to disagree by a factor of eight, and an IOC sized off the mandate
   * filled 12% of the request with `status: "filled"` and no warning, leaving
   * the plan's risk arithmetic written against a position that never existed.
   */
  "account_margin",
  "planned_loss_ceiling",
  "loss_budget",
  "below_exchange_minimum",
  "stop_on_wrong_side",
]);
export type EntrySizeConstraint = typeof EntrySizeConstraint.Type;

export const TradingEnterInput = Schema.Struct({
  /** Optional — omit to act on the mission this session is bound to. */
  missionId: Schema.optional(TradingId),
  market: TradingMarket,
  side: TradingOrderSide,
  /** Reduce-only trigger price on the losing side of the entry. */
  stopPrice: Price,
  /**
   * The size to take, in base units. Omit and the server takes the largest
   * size every ceiling allows — which is usually not the size to trade, but is
   * always the honest upper bound to size down from.
   */
  sizeEth: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** The same request in USD of notional, converted at the entry price. */
  notionalUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** Defaults to `open`. */
  actionType: Schema.optional(EntryActionType),
  /**
   * How urgently the entry should land. Defaults to `now`, which crosses the
   * spread immediately; `patient` rests at the near side as a maker order that
   * may never fill. The harness never names a time-in-force — the server maps
   * urgency to one and the execution result reports what went out.
   */
  urgency: TradingUrgency.pipe(Schema.withDecodingDefault(Effect.succeed("now"))),
}).check(
  Schema.makeFilter(
    (input) =>
      input.sizeEth === undefined ||
      input.notionalUsd === undefined ||
      "Give either sizeEth or notionalUsd, not both.",
  ),
);
export type TradingEnterInput = typeof TradingEnterInput.Type;

// ---------------------------------------------------------------------------
// Sizing — pure arithmetic, so the ceilings are testable without an exchange
// ---------------------------------------------------------------------------

export interface EntrySizingInput {
  readonly side: "buy" | "sell";
  /** The price the entry would be filled at. */
  readonly entryPrice: number;
  readonly stopPrice: number;
  /** Size in base units the harness asked for. Omit to take the largest feasible. */
  readonly requestedSize?: number | undefined;
  /** Base-unit precision the exchange accepts for this market. */
  readonly szDecimals: number;
  /** Gross notional already open on this mission. */
  readonly existingNotionalUsd: number;
  /**
   * The price the aggregate ceilings will be measured at, when it is not
   * `entryPrice`.
   *
   * A crossing entry is FILLED at `entryPrice` (the far side) but goes out at a
   * padded limit, and preview checks `size * limitPrice` against the ceilings.
   * Sizing at the fill price therefore proposes a size whose own preview
   * refuses it by the width of the pad — invisible while the mission is flat,
   * because the ceiling is nowhere near, and immediate the moment something
   * else already claims part of it. Which is every second entry in a turn.
   *
   * Defaults to `entryPrice`, so a caller that does not pad is unaffected.
   * Never used for the risk arithmetic: planned loss is measured against the
   * price the order actually fills at.
   */
  readonly ceilingPriceUsd?: number | undefined;
  readonly allocatedCapitalUsd: number;
  readonly maximumLeverage: number;
  readonly maximumGrossNotionalUsd: number;
  /**
   * Gross notional the exchange account itself can carry: free collateral at
   * the leverage the account has this market configured at.
   *
   * Omitted when either half is unknown, and then it binds nothing — an
   * unknown capacity is not a zero one. Present, it is a HARD bound: no
   * mandate ceiling can make an account fund a position it has no margin for.
   */
  readonly accountMarginCapacityUsd?: number | undefined;
  readonly maximumPlannedRiskPerPositionUsd: number;
  readonly remainingCumulativeLossUsd: number;
  readonly takerFeeBpsPerSide: number;
  readonly stopSlippageReserveBps: number;
  readonly minimumNotionalUsd: number;
  /**
   * The notional the plan's profit target needs to be reachable after costs,
   * from `notionalForProfitTarget`. Omitted when no target or no expected move
   * was readable.
   *
   * Read only to answer {@link EntrySizing.fundsTarget}; it never moves the
   * size. It used to be a floor the sizing lifted a too-small request up to,
   * and that made an explicit request unable to reduce anything: a harness
   * asking for 500 USD of notional against a plan whose target needed more got
   * the account's whole margin capacity — 857 USD — and had no way left to
   * de-risk except to publish a different plan. A target the size cannot pay is
   * reported through `fundsTarget` and re-cut at the next publish; it is not a
   * mandate to hold more than was asked for.
   */
  readonly targetNotionalUsd?: number | undefined;
}

export interface EntrySizing {
  readonly size: number;
  readonly requestedSize: number;
  /**
   * The largest size every ceiling allows, whatever was asked for.
   *
   * The risk policy expressed as a number: a size at or near it is the size
   * the mission approved. Reported so the server can say when the size asked for
   * is a small fraction of the trade the mandate actually permits.
   */
  readonly ceilingSize: number;
  readonly notionalUsd: number;
  readonly plannedLossAtStopUsd: number;
  readonly reservedRiskUsd: number;
  readonly constrainedBy: EntrySizeConstraint;
  /** False when no size clears; `constrainedBy` says which rule made it so. */
  readonly feasible: boolean;
  readonly detail: string;
  /**
   * Whether the notional is large enough to pay the plan's target after
   * costs. True when no target notional was supplied — there is nothing to
   * fall short of.
   */
  readonly fundsTarget: boolean;
}

/** Truncate toward zero at the exchange's base-unit precision. */
function truncateSize(size: number, szDecimals: number): number {
  const factor = 10 ** Math.max(0, Math.trunc(szDecimals));
  return Math.floor(size * factor) / factor;
}

/**
 * The largest size that clears every ceiling, and which one bound it.
 *
 * The four ceilings are the same ones preview items 12–15 test, expressed as
 * sizes instead of as verdicts, so the server proposes the trade the mission is
 * actually allowed to take rather than refusing the one it asked for. The
 * caller passes the ceilings in; nothing here reads configuration.
 */
export function deriveFeasibleSize(input: EntrySizingInput): EntrySizing {
  const stopDistance = Math.abs(input.entryPrice - input.stopPrice);
  const stopIsOnLosingSide =
    input.side === "buy" ? input.stopPrice < input.entryPrice : input.stopPrice > input.entryPrice;

  if (!stopIsOnLosingSide || stopDistance <= 0) {
    return {
      size: 0,
      requestedSize: input.requestedSize ?? 0,
      ceilingSize: 0,
      notionalUsd: 0,
      plannedLossAtStopUsd: 0,
      reservedRiskUsd: 0,
      constrainedBy: "stop_on_wrong_side",
      feasible: false,
      fundsTarget: false,
      detail:
        `a ${input.side} entry at ${input.entryPrice} needs its stop ` +
        `${input.side === "buy" ? "below" : "above"} that price; got ${input.stopPrice}`,
    };
  }

  // Every ceiling as a size in base units. The smallest one wins.
  const ceilingPrice =
    input.ceilingPriceUsd !== undefined && input.ceilingPriceUsd > 0
      ? input.ceilingPriceUsd
      : input.entryPrice;
  const notionalHeadroom = (ceiling: number): number =>
    Math.max(0, ceiling - input.existingNotionalUsd) / ceilingPrice;
  const feeAndSlip = (2 * input.takerFeeBpsPerSide + input.stopSlippageReserveBps) / 10_000;
  const reservedRiskPerUnit = stopDistance + input.entryPrice * feeAndSlip;

  const caps: ReadonlyArray<{ readonly by: EntrySizeConstraint; readonly size: number }> = [
    { by: "gross_notional", size: notionalHeadroom(input.maximumGrossNotionalUsd) },
    ...(input.accountMarginCapacityUsd === undefined
      ? []
      : [
          {
            by: "account_margin" as const,
            size: notionalHeadroom(input.accountMarginCapacityUsd),
          },
        ]),
    {
      by: "leverage",
      size: notionalHeadroom(input.maximumLeverage * input.allocatedCapitalUsd),
    },
    {
      by: "planned_loss_ceiling",
      size: input.maximumPlannedRiskPerPositionUsd / stopDistance,
    },
    {
      by: "loss_budget",
      // Preview item 15 reserves the stop loss plus the certain round-trip
      // fees and the stop-slippage reserve. Size against that same whole
      // reservation so a budget-bound entry clears its own preview.
      size: Math.max(0, input.remainingCumulativeLossUsd) / reservedRiskPerUnit,
    },
  ];

  const binding = caps.reduce((tightest, cap) => (cap.size < tightest.size ? cap : tightest));
  const requestedSize = input.requestedSize ?? binding.size;

  // A size that was asked for is a CEILING, not a suggestion. Nothing below
  // raises it — not the plan's target, not the account's spare margin. The
  // harness's only lever for taking less risk than the mandate allows is the
  // number it puts in this field, and for a while that lever did nothing.
  const allowed = Math.min(requestedSize, binding.size);
  const size = truncateSize(allowed, input.szDecimals);
  const ceilingSize = truncateSize(binding.size, input.szDecimals);

  const notionalUsd = size * input.entryPrice;
  const plannedLossAtStopUsd = size * stopDistance;
  const reservedRiskUsd = plannedLossAtStopUsd + notionalUsd * feeAndSlip;
  const fundsTarget =
    input.targetNotionalUsd === undefined || notionalUsd >= input.targetNotionalUsd;

  // `requested` only when the harness's own number survived untouched,
  // otherwise the rule that cut it, so "ask for less" and "this mission cannot
  // trade" read differently. An omitted size is always ceiling-bound: there is
  // no request for it to have survived.
  const constrainedBy: EntrySizeConstraint =
    allowed < requestedSize || input.requestedSize === undefined ? binding.by : "requested";

  if (notionalUsd < input.minimumNotionalUsd) {
    return {
      size,
      requestedSize,
      ceilingSize,
      notionalUsd,
      plannedLossAtStopUsd,
      reservedRiskUsd,
      constrainedBy: "below_exchange_minimum",
      feasible: false,
      fundsTarget,
      detail:
        `the largest size ${binding.by} allows is ${size} ($${notionalUsd.toFixed(2)} notional), ` +
        `below the $${input.minimumNotionalUsd} exchange minimum`,
    };
  }

  return {
    size,
    requestedSize,
    ceilingSize,
    notionalUsd,
    plannedLossAtStopUsd,
    reservedRiskUsd,
    constrainedBy,
    feasible: true,
    fundsTarget,
    detail:
      constrainedBy === "requested"
        ? `size ${size} clears every ceiling`
        : `size ${size} is what ${constrainedBy} allows` +
          (input.requestedSize === undefined ? "" : ` of the ${input.requestedSize} requested`),
  };
}

/**
 * The limit price to enter at, from a live book.
 *
 * `marketable_ioc` has to cross, so it takes the far side plus the slippage
 * allowance the executor itself uses; `resting_limit` and `post_only` sit at
 * the near side. The server prices this rather than the harness because a
 * limit that does not cross is refused at preview and reads to a model as
 * "the market refused".
 */
export function deriveEntryLimitPrice(input: {
  readonly side: "buy" | "sell";
  readonly orderPreference: OrderPreference;
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly slippageBps: number;
}): number {
  const allowance = 1 + input.slippageBps / 10_000;
  switch (input.orderPreference) {
    case "marketable_ioc":
      return input.side === "buy" ? input.bestAsk * allowance : input.bestBid / allowance;
    case "resting_limit":
    case "post_only":
      // A post-only order prices at the near side like a resting limit: ALO
      // is the exchange-side guarantee that it rests, and the near side is
      // the local best effort at never pricing through the book.
      return input.side === "buy" ? input.bestBid : input.bestAsk;
  }
}
