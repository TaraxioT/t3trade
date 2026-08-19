/**
 * Funding history: the one series the API will hand over in full.
 *
 * `fundingHistory` pages backwards to 2023 and returns 500 rows a call, so a
 * cold start walks the whole record once and every run after that only asks
 * for what happened since the stored high-water mark. Hourly rows for three
 * coins over three years is a few hundred thousand rows — small, and worth
 * owning locally so a carry study never waits on the network.
 *
 * @module trading/archive/funding
 */
import type { ArchiveDatabase } from "./db.ts";
import { asArray, asInteger, asNumber, asRecord, asString } from "./wire.ts";

export interface FundingRow {
  readonly coin: string;
  readonly time: number;
  readonly fundingRate: number;
  readonly premium: number;
}

/** Decode a `fundingHistory` response, dropping rows for other coins. */
export function parseFunding(raw: unknown, coin: string): ReadonlyArray<FundingRow> {
  const rows = asArray(raw);
  if (rows === null) {
    return [];
  }

  const parsed: FundingRow[] = [];
  for (const entry of rows) {
    const record = asRecord(entry);
    if (record === null || asString(record["coin"]) !== coin) {
      continue;
    }
    const time = asInteger(record["time"]);
    const fundingRate = asNumber(record["fundingRate"]);
    const premium = asNumber(record["premium"]);
    if (time === null || fundingRate === null || premium === null) {
      continue;
    }
    parsed.push({ coin, time, fundingRate, premium });
  }
  return parsed;
}

const UPSERT_FUNDING_SQL =
  "INSERT INTO funding (coin, time, funding_rate, premium) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(coin, time) DO UPDATE SET " +
  "funding_rate = excluded.funding_rate, premium = excluded.premium";

export function upsertFunding(db: ArchiveDatabase, rows: ReadonlyArray<FundingRow>): number {
  if (rows.length === 0) {
    return 0;
  }
  return db.transaction(() => {
    for (const row of rows) {
      db.run(UPSERT_FUNDING_SQL, row.coin, row.time, row.fundingRate, row.premium);
    }
    return rows.length;
  });
}

/** Newest stored funding timestamp for a coin, or `null` on a cold start. */
export function latestFundingTime(db: ArchiveDatabase, coin: string): number | null {
  const rows = db.all<{ latest: number | null }>(
    "SELECT MAX(time) AS latest FROM funding WHERE coin = ?",
    coin,
  );
  return rows[0]?.latest ?? null;
}
