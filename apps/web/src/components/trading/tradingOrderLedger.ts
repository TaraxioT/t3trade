// ---------------------------------------------------------------------------
// The order ledger — plan 39 phase 2: one row per order the mission placed.
// ---------------------------------------------------------------------------

/**
 * Where an order is in its life, as the positions card words it.
 *
 * `planned` is the ghost row: the plan commits an entry no live order covers
 * yet. The rest map the execution-record statuses, with `partial` and `open`
 * split out because a part-filled working order and a filled opening leg that
 * is now the position are the two rows the operator watches hardest.
 */
export type OrderLedgerState =
  | "planned"
  | "queued"
  | "working"
  | "partial"
  | "open"
  | "closed"
  | "cancelled"
  | "rejected";

/** One row of the positions card: a single order leg, whole. */
export interface OrderLedgerRow {
  /** Stable across polls, so React does not remount a row every 3s. */
  readonly key: string;
  readonly state: OrderLedgerState;
  /**
   * True for a closing leg. Carried visually as the hollow state token,
   * reusing the chart's own convention (open = filled circle, close = hollow).
   */
  readonly isClose: boolean;
  /** The direction of the position this leg opens or closes. */
  readonly direction: "long" | "short";
  /** Asset units: what filled once anything has, the request until then. */
  readonly sizeUnits: number | null;
  /** The same size as USD notional at the leg's price (mark as fallback). */
  readonly sizeUsd: number | null;
  /** The leg's one price: limit while working, size-weighted fill after. */
  readonly price: number | null;
  /** Fill progress in 0..1 while partially filled; null otherwise. */
  readonly filledFraction: number | null;
  /**
   * The leg's money outcome, net of fees: live unrealised minus fees while
   * the leg is open, realised net once closed. Null while queued/working.
   */
  readonly valueUsd: number | null;
  /** Fees this leg has paid so far. Null when none recorded. */
  readonly feeUsd: number | null;
  readonly atMillis: number;
  /** True when the time column ticks as a live age rather than a clock time. */
  readonly isLive: boolean;
  readonly orderRef: string | null;
}

/** The order actions that close or reduce a position rather than open one. */
const CLOSING_ACTIONS = new Set(["close", "reduce", "reduce_only_exit"]);

/** Below this many units a fill sum is float noise, not a partial. */
const ORDER_FILL_DUST = 1e-9;

/**
 * One row per order the mission has placed, newest first, merging the order
 * list with the live position for the leg that is still open.
 *
 * This retires the round-trip pairing from the positions view: an order is the
 * atomic thing the exchange acts on, and a filled opening order IS the
 * position it created, so one row per leg is the only model that holds pending
 * orders, partial fills and positions in one column. An open leg and a close
 * leg are two rows, never one `entry → exit` cell.
 */
export function deriveOrderLedger(input: {
  readonly orders: ReadonlyArray<{
    readonly executionId: string;
    readonly actionType: string;
    readonly side: "buy" | "sell";
    readonly size: number;
    readonly limitPrice: number;
    readonly reduceOnly: boolean;
    readonly status: string;
    readonly filledSize: number;
    readonly avgFillPrice: number | null;
    readonly feeUsd: number;
    readonly closedPnl: number;
    readonly orderId?: number | undefined;
    readonly updatedAt: string;
  }>;
  readonly position: {
    readonly size: number;
    readonly unrealisedPnl: number;
  } | null;
  readonly markPrice: number | null;
  /**
   * The plan's committed entry, for the `planned` ghost row: a mission waiting
   * on a trigger has no resting order, and an empty card while $892 of size is
   * committed would be the card lying by omission. Null when no plan commits
   * an entry (planning, stand-aside).
   */
  readonly plannedEntry: {
    readonly sizeUsd: number;
    readonly price: number | null;
    readonly direction: "long" | "short";
  } | null;
}): ReadonlyArray<OrderLedgerRow> {
  const position = input.position !== null && input.position.size !== 0 ? input.position : null;

  // Which opening legs the live position is still made of, completed or still
  // filling: the units an order has filled sit in the position whether or not
  // the rest of it has landed yet. A scaled-in
  // position is several of them, so walk newest-first taking each leg's filled
  // size until they cover the position: anything older than that has already
  // been closed out by a reduce leg and is genuinely settled. The units taken
  // from each leg are what still sits in the position, and are how the
  // aggregate unrealised P&L is split across the rows below.
  const openLegUnits = new Map<string, number>();
  if (position !== null) {
    let uncovered = Math.abs(position.size);
    for (const order of input.orders) {
      if (uncovered <= ORDER_FILL_DUST) break;
      // A leg that has filled part of its size and still rests on the book has
      // those units in the position exactly like a completed leg does, so it
      // holds live exposure and carries its share of the unrealised P&L. Only
      // its own fills count, never the size it is still waiting on.
      const holdsUnits =
        order.status === "filled" ||
        ((order.status === "accepted" || order.status === "submitted") &&
          order.filledSize > ORDER_FILL_DUST);
      if (
        !holdsUnits ||
        order.reduceOnly ||
        CLOSING_ACTIONS.has(order.actionType) ||
        (order.side === "buy") !== position.size > 0
      ) {
        continue;
      }
      const held = Math.min(order.filledSize, uncovered);
      if (held <= ORDER_FILL_DUST) continue;
      openLegUnits.set(order.executionId, held);
      uncovered -= held;
    }
  }
  const openUnitsTotal = [...openLegUnits.values()].reduce((sum, units) => sum + units, 0);

  const rows: OrderLedgerRow[] = input.orders.map((order) => {
    const isClose = order.reduceOnly || CLOSING_ACTIONS.has(order.actionType);
    const direction: "long" | "short" = isClose
      ? order.side === "sell"
        ? "long"
        : "short"
      : order.side === "buy"
        ? "long"
        : "short";
    const filled = order.filledSize > ORDER_FILL_DUST;
    const atMillis = Date.parse(order.updatedAt);

    const state: OrderLedgerState =
      // Everything before the exchange has been asked is queued: `previewed`
      // and `signed` are pending statuses on the way to `submitted`, and
      // reading them as settled would drop them out of the live band before
      // they have done anything.
      order.status === "reserved" || order.status === "previewed" || order.status === "signed"
        ? "queued"
        : order.status === "submitted" || order.status === "accepted"
          ? filled
            ? "partial"
            : "working"
          : order.status === "filled"
            ? openLegUnits.has(order.executionId)
              ? "open"
              : "closed"
            : order.status === "cancelled"
              ? "cancelled"
              : order.status === "rejected" || order.status === "failed"
                ? "rejected"
                : "closed";

    // What the row is sized on: the units an open leg still holds (a reduce
    // may have taken part of it back, and the card states live exposure, not
    // what the leg once filled), the fill for a settled or partial leg, the
    // request until anything has filled.
    const heldUnits = openLegUnits.get(order.executionId) ?? 0;
    const sizeUnits = state === "open" ? heldUnits : filled ? order.filledSize : order.size;
    // The one price this leg executed at — the limit while working, the
    // size-weighted fill once anything has filled.
    const price =
      state === "queued"
        ? null
        : filled
          ? (order.avgFillPrice ?? order.limitPrice)
          : order.limitPrice;
    const priceForNotional = price ?? input.markPrice;
    const sizeUsd = priceForNotional === null ? null : sizeUnits * priceForNotional;

    // An open leg carries its share of the position's unrealised P&L, split by
    // the units it still holds, so a scaled-in position reads as several live
    // legs that sum to the header figure, not one leg holding all of it.
    const openShare = openUnitsTotal > 0 ? heldUnits / openUnitsTotal : 1;
    const valueUsd =
      (state === "open" || state === "partial") && position !== null && heldUnits > 0
        ? position.unrealisedPnl * openShare - order.feeUsd
        : state === "closed"
          ? order.closedPnl - order.feeUsd
          : null;

    return {
      key: order.executionId,
      state,
      isClose,
      direction,
      sizeUnits,
      sizeUsd,
      price,
      filledFraction:
        state === "partial" && order.size > 0 ? Math.min(1, order.filledSize / order.size) : null,
      valueUsd,
      feeUsd: order.feeUsd > 0 ? order.feeUsd : null,
      atMillis: Number.isNaN(atMillis) ? 0 : atMillis,
      isLive: state === "queued" || state === "working" || state === "partial" || state === "open",
      orderRef: order.orderId === undefined ? null : String(order.orderId),
    };
  });

  // The planned ghost: the plan commits an entry that no live order covers.
  // Once any live band exists — a working order or the open leg — the plan's
  // commitment is embodied there and the ghost would double-count it.
  const hasLiveBand = rows.some((row) => row.isLive);
  if (input.plannedEntry !== null && !hasLiveBand && position === null) {
    const priceForNotional = input.plannedEntry.price ?? input.markPrice;
    rows.unshift({
      key: "planned-entry",
      state: "planned",
      isClose: false,
      direction: input.plannedEntry.direction,
      sizeUnits:
        priceForNotional === null || priceForNotional === 0
          ? null
          : input.plannedEntry.sizeUsd / priceForNotional,
      sizeUsd: input.plannedEntry.sizeUsd,
      price: input.plannedEntry.price,
      filledFraction: null,
      valueUsd: null,
      feeUsd: null,
      atMillis: 0,
      isLive: true,
      orderRef: null,
    });
  }

  return rows;
}
