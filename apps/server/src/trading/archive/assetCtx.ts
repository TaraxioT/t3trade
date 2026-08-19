/**
 * Derivatives context: open interest, premium, oracle and mark, 24h volume,
 * and the predicted funding rate.
 *
 * `metaAndAssetCtxs` reports these for the current moment only — there is no
 * historical endpoint for any of them. Sampled once a minute and written
 * down, they become the open-interest and premium series that otherwise does
 * not exist, which is the single most valuable thing this process produces.
 *
 * The response is two parallel arrays: `universe[i]` names the coin whose
 * context is `contexts[i]`. The index is not stable across listings, so it is
 * resolved by name on every poll rather than cached.
 *
 * @module trading/archive/assetCtx
 */
import type { ArchiveDatabase } from "./db.ts";
import { asArray, asNumber, asRecord, asString } from "./wire.ts";

export interface AssetCtxRow {
  readonly coin: string;
  readonly ts: number;
  readonly openInterest: number;
  readonly premium: number;
  readonly oraclePx: number;
  readonly markPx: number;
  readonly dayNtlVolume: number;
  readonly funding: number;
}

/**
 * Pull the tracked coins out of a `metaAndAssetCtxs` response.
 *
 * `ts` is supplied by the caller (the poll's minute-aligned timestamp) rather
 * than read from the response, which carries no time of its own.
 */
export function parseAssetContexts(
  raw: unknown,
  coins: ReadonlyArray<string>,
  ts: number,
): ReadonlyArray<AssetCtxRow> {
  const pair = asArray(raw);
  const meta = asRecord(pair?.[0]);
  const contexts = asArray(pair?.[1]);
  const universe = asArray(meta?.["universe"]);
  if (universe === null || contexts === null) {
    return [];
  }

  const indexByCoin = new Map<string, number>();
  universe.forEach((entry, index) => {
    const name = asString(asRecord(entry)?.["name"]);
    if (name !== null && !indexByCoin.has(name)) {
      indexByCoin.set(name, index);
    }
  });

  const rows: AssetCtxRow[] = [];
  for (const coin of coins) {
    const index = indexByCoin.get(coin);
    const context = index === undefined ? null : asRecord(contexts[index]);
    if (context === null) {
      continue;
    }
    const openInterest = asNumber(context["openInterest"]);
    const premium = asNumber(context["premium"]);
    const oraclePx = asNumber(context["oraclePx"]);
    const markPx = asNumber(context["markPx"]);
    const dayNtlVolume = asNumber(context["dayNtlVlm"]);
    const funding = asNumber(context["funding"]);
    if (
      openInterest === null ||
      premium === null ||
      oraclePx === null ||
      markPx === null ||
      dayNtlVolume === null ||
      funding === null
    ) {
      continue;
    }
    rows.push({ coin, ts, openInterest, premium, oraclePx, markPx, dayNtlVolume, funding });
  }
  return rows;
}

const UPSERT_ASSET_CTX_SQL =
  "INSERT INTO asset_ctx " +
  "(coin, ts, open_interest, premium, oracle_px, mark_px, day_ntl_volume, funding) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(coin, ts) DO UPDATE SET " +
  "open_interest = excluded.open_interest, premium = excluded.premium, " +
  "oracle_px = excluded.oracle_px, mark_px = excluded.mark_px, " +
  "day_ntl_volume = excluded.day_ntl_volume, funding = excluded.funding";

export function upsertAssetContexts(db: ArchiveDatabase, rows: ReadonlyArray<AssetCtxRow>): number {
  if (rows.length === 0) {
    return 0;
  }
  return db.transaction(() => {
    for (const row of rows) {
      db.run(
        UPSERT_ASSET_CTX_SQL,
        row.coin,
        row.ts,
        row.openInterest,
        row.premium,
        row.oraclePx,
        row.markPx,
        row.dayNtlVolume,
        row.funding,
      );
    }
    return rows.length;
  });
}
