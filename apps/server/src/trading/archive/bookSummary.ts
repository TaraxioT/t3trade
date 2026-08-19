/**
 * Order book summary: the top of book and how much is stacked behind it.
 *
 * The full L2 book is twenty levels a side, changes constantly, and would
 * dominate the archive's size for very little analytical return. What is
 * worth keeping once a minute is the spread and the shape immediately behind
 * it — best bid/ask with their sizes, and the summed size over the top five
 * levels, which is the crude liquidity measure a slippage estimate wants.
 *
 * @module trading/archive/bookSummary
 */
import type { ArchiveDatabase } from "./db.ts";
import { asArray, asNumber, asRecord } from "./wire.ts";

/** Levels per side folded into the depth figures. */
export const BOOK_DEPTH_LEVELS = 5;

export interface BookSummaryRow {
  readonly coin: string;
  readonly ts: number;
  readonly bidPx: number;
  readonly bidSz: number;
  readonly askPx: number;
  readonly askSz: number;
  readonly bidDepth5: number;
  readonly askDepth5: number;
}

interface BookLevel {
  readonly px: number;
  readonly sz: number;
}

function parseLevels(raw: unknown): ReadonlyArray<BookLevel> {
  const entries = asArray(raw);
  if (entries === null) {
    return [];
  }
  const levels: BookLevel[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const px = asNumber(record?.["px"]);
    const sz = asNumber(record?.["sz"]);
    if (px !== null && sz !== null) {
      levels.push({ px, sz });
    }
  }
  return levels;
}

const sumSizes = (levels: ReadonlyArray<BookLevel>): number =>
  levels.slice(0, BOOK_DEPTH_LEVELS).reduce((total, level) => total + level.sz, 0);

/**
 * Fold an `l2Book` response into one row, or `null` when either side is
 * empty — a book with no bid has no top of book to record, and writing zeros
 * would read later as a real quote of zero.
 */
export function summariseBook(raw: unknown, coin: string, ts: number): BookSummaryRow | null {
  const sides = asArray(asRecord(raw)?.["levels"]);
  const bids = parseLevels(sides?.[0]);
  const asks = parseLevels(sides?.[1]);
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (bestBid === undefined || bestAsk === undefined) {
    return null;
  }
  return {
    coin,
    ts,
    bidPx: bestBid.px,
    bidSz: bestBid.sz,
    askPx: bestAsk.px,
    askSz: bestAsk.sz,
    bidDepth5: sumSizes(bids),
    askDepth5: sumSizes(asks),
  };
}

const UPSERT_BOOK_SQL =
  "INSERT INTO book_summary " +
  "(coin, ts, bid_px, bid_sz, ask_px, ask_sz, bid_depth5, ask_depth5) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(coin, ts) DO UPDATE SET " +
  "bid_px = excluded.bid_px, bid_sz = excluded.bid_sz, " +
  "ask_px = excluded.ask_px, ask_sz = excluded.ask_sz, " +
  "bid_depth5 = excluded.bid_depth5, ask_depth5 = excluded.ask_depth5";

export function upsertBookSummaries(
  db: ArchiveDatabase,
  rows: ReadonlyArray<BookSummaryRow>,
): number {
  if (rows.length === 0) {
    return 0;
  }
  return db.transaction(() => {
    for (const row of rows) {
      db.run(
        UPSERT_BOOK_SQL,
        row.coin,
        row.ts,
        row.bidPx,
        row.bidSz,
        row.askPx,
        row.askSz,
        row.bidDepth5,
        row.askDepth5,
      );
    }
    return rows.length;
  });
}
