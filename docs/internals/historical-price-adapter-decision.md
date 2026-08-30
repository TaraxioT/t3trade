# Historical price adapter: decision record (open)

Status: NOT DECIDED. No second price source is implemented, and none may be
added by a prompt or a session; this record is the required artifact before
any such adapter exists.

## Why this record exists

The archive hydrates from exactly one source: Hyperliquid, within the window
`candleSnapshot` still serves (about the most recent 5,000 bars per
market/interval; daily reach is bounded by the venue's own listing history,
roughly 2023 for the majors). Event studies regularly name older dates
(Devcon Bogota, October 2022) that this source cannot serve. The system's
answer today is an explicit `source_window_exhausted`: the occurrence is
reported unmeasured with the reason, never fabricated continuity and never a
silent crawl. Mixing a second vendor's candles into the same series as
execution prices is a data-provenance decision, not a fetch.

## Required fields for any candidate

| Field                       | Question it must answer                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate source            | Named vendor and specific product/endpoint (e.g. "CryptoCompare daily spot OHLC v2 histoday", or an exchange's public candles API)                                                                      |
| Market definition           | Exactly which instrument: spot, index, or perpetual; the study's claim is about "ETH", the adapter serves one concrete series and the scene must say which                                              |
| Coverage                    | First date served for the assets T3 Trade studies; the pre-2023 Devcon windows are the motivating case                                                                                                  |
| Interval                    | Smallest and largest bars served; whether daily closes are the native granularity or derived                                                                                                            |
| Adjustments                 | Corporate/token actions (ETH proof-of-stake merge, chain splits, redenominations) and how the vendor handles them; an unadjusted series beside an execution venue's adjusted series is not a comparison |
| Rate limits and cost        | Requests per minute/day, licensing tier, whether attribution is required                                                                                                                                |
| Licensing and attribution   | Terms for a desktop product republishing derived numbers; where the attribution string renders                                                                                                          |
| Provenance                  | What the adapter records per bar so a scene can label its source per occurrence (vendor, instrument, fetch time)                                                                                        |
| Distinctness from execution | Hyperliquid remains the only execution venue; the adapter's prices are reference data and must never be presented as achievable fills; the scene label must keep them distinguishable                   |

## Standing rules while this remains open

1. Price bars enter only through a typed market-data adapter approved by this
   record; event dates may come from ordinary provider web research, candles
   never do.
2. A mixed-source study names the price source per occurrence and refuses to
   aggregate incompatible series (different instrument classes, adjusted vs
   unadjusted) without an explicit, tested normalization rule.
3. On-demand hydration stays bounded: one writer, coalesced requests, venue
   isolation, explicit outcomes. A second adapter widens the source set; it
   does not widen the write path.
