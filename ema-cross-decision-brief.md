# ema_cross decision brief

Written 2026-08-19 ~01:40 UTC. Question: what to do with `TRADING_POLICY_V1`'s
ema_cross playbook, given that its entry signal measured statistically flat.

Sources: `ema-cross-frequency-audit.md` Parts 1–3 (15.6 days of 5m ETH testnet
candles, scripts in `scratch/`); the GLM5.3 monitor's interim verdict of
01:26 UTC (mission 06f01ed5, 9 cycles, 2 round trips); read-only queries
against `~/.t3/userdata/state.sqlite` run for this brief. Testnet only —
nothing here measures mainnet fees, fills, or liquidity.

## The evidence in five sentences

1. **Frequency is fine.** The 0.15 ATR separation gate opens ~9.8×/day on 5m;
   the live mission's sub-gate streak was an 8.8%-probability quiet stretch
   (Part 1).
2. **The entry is ~random.** Gate-passing crosses average +0.44 bps gross at
   the playbook's 3:1 exit (t = 0.24, n = 153), where 25% hit rate is
   break-even and 27.5% was measured (Part 1).
3. **No exit rescues it.** Twelve exit structures (fixed, trailing, time);
   the 3:1 reference was already the best; only two cells positive at all,
   both t < 0.25 (Part 2).
4. **No regime filter rescues it.** Fourteen filter cells; best positive
   t = 0.77 vs a Bonferroni bar of 2.97; the only bar-clearing cell is an
   n=4 negative anecdote; the least-bad cells select against volume (Part 3).
5. **Execution is no longer the confound.** Entry legs are validated live
   (one maker fill at 0 bps drift / 1.5 bps, one designed 90 s escalation at
   +7.8 bps drift / 4.5 bps); fee reconciliation is exact; the runtime's
   discipline checks pass (interim verdict).

## What the lab's own ledger says (all 15 missions, 35 round trips)

| era                 | missions | RTs    | gross       | fees       | net         |
| ------------------- | -------- | ------ | ----------- | ---------- | ----------- |
| pre-fix (Aug 14)    | 4        | 16     | −$54.86     | $24.46     | −$79.32     |
| fix era (Aug 17–19) | 11       | 19     | +$2.60      | $8.99      | −$6.41      |
| **total**           | **15**   | **35** | **−$52.26** | **$33.45** | **−$85.72** |

The fix era's gross is statistically flat — the live lab reproduces the
offline verdict independently. Losses are no longer made on price; they are
made on fees applied to a zero-edge signal. No mission has ever finished net
positive.

## Option A — retire ema_cross (versioned V2 removes/disables it)

**For (strongest):** three independent measurements — exit sweep, filter
sweep, and the fix-era live ledger — agree the entry carries no information;
keeping it live spends attention and fees on a known-flat signal.
**Against (strongest):** it is the only playbook with full instrumentation
and a complete evidence chain; retiring it before the exit-leg execution
questions close (0 maker exits, 0 resting targets observed; checks i/j/k
ungraded) throws away the cheapest available vehicle for finishing execution
validation. Other playbooks have almost no evidence base: range_reversion has
planned but never triggered an entry in the current mission, and the
pre-Aug-17 momentum missions predate the fixed runtime, so their heavy losses
measure the old runtime, not the playbook.
**Reversal cost:** low — versioned policy; V1 remains in history and the
audit scripts remain reproducible.
**Next action if chosen:** author policy V2 with ema_cross disabled, replay
comparison per the versioning convention, then decide what signal replaces it
before starting another edge-seeking mission.

## Option B — re-spec the entry (V2 with a modified/filtered signal)

**For (strongest):** the trailing-exit result (hit rate doubles, variance
drops, mean unchanged) shows the machinery can reshape outcomes precisely —
if a real signal existed, this stack could trade it well.
**Against (strongest):** Part 3 closed the cheap version — no measurable
regime condition on existing data selects a positive subset, and the honest
statistical framing says a null grid of this size _expects_ a +2.2 bps
maximum. A serious re-spec needs either new signal families or new data, and
testnet retains only ~5000 candles per interval (the 1m span is 3.5 days),
so offline discovery is data-starved by construction.
**Reversal cost:** the cost is incurred up front — design and validation
effort with a documented prior of failure on this data.
**Next action if chosen:** define the new entry hypothesis _before_ touching
policy, source data beyond testnet retention (or accept live-forward testing
at ~10 signals/day), and pre-register the acceptance bar.

## Option C — hold V1, run the lab for execution only

**For (strongest):** the soak's remaining open items are execution facts the
offline audit cannot produce — maker-exit frequency, resting-target
mechanics, post-note discipline (i/j/k), escalation rate beyond n=2 — and
the mission collects them passively at ~zero attention cost in passive-mode
monitoring.
**Against (strongest):** it cannot ever produce a net-positive result
(+0.44 bps gross vs ≥3 bps best-case cost), and at the fix-era trade rate
(~1 RT/hour when signals pass, most declined) the execution sample grows
slowly; every additional round trip costs ~$0.30–0.75 in fees to learn
execution facts a few trades would settle.
**Reversal cost:** none — this is the default of doing nothing.
**Next action if chosen:** let the passive monitor run until the first 2–3
post-note round trips grade (i)/(j)/(k) and the first maker exit is observed
or refuted, then stop the mission; the execution chapter is then closed too.

## Comparison

|                               | A retire                    | B re-spec                          | C execution lab                          |
| ----------------------------- | --------------------------- | ---------------------------------- | ---------------------------------------- |
| answers the edge question     | already answered (negative) | re-opens it, data-starved          | ignores it                               |
| finishes execution validation | no — abandons it            | no — defers it                     | yes, slowly                              |
| ongoing cost                  | none                        | high up-front effort               | ~$0.30–0.75/RT fees + passive monitoring |
| reversibility                 | easy (versioned)            | effort already sunk                | free                                     |
| what it cannot do             | close exit-leg questions    | escape the null prior on this data | ever net positive                        |

A and C are not exclusive: C for a bounded window (until i/j/k grade and the
maker-exit question closes), then A, is a coherent sequence with no conflict.
B conflicts with nothing but competes for the same effort budget.

## Decision

**2026-08-19: Option A taken — ema_cross retired.**

`TRADING_POLICY_V3` (`packages/trading-contracts/src/policy.ts`) sets
`emaCross.enabled = false` and is now `ACTIVE_TRADING_POLICY`. `playbook.ts`
stops serving the ema_cross procedure to missions (`PLAYBOOKS` filters it out
of `ALL_PLAYBOOKS`) and `mode.ts` stops accepting it as an execute-mode
mandate (`EXECUTABLE_STRATEGIES`). The EMA fields on the market structure
read (`ema.direction`, `separationAtr`, `barsSinceCross`, `EMA_FAST_PERIOD`/
`EMA_SLOW_PERIOD`) are untouched — they serve any strategy, not only the
retired one — and every execution-side mechanism (patient entries, the 90s
escalation, cost lines, target floor gate, watch machinery) is unchanged.

Evidence: `ema-cross-frequency-audit.md` Parts 1-3 — no gross edge
unconditionally (+0.44 bps, t = 0.24, n = 153), under any of twelve exit
rules, or under any of fourteen regime filters — plus the fix-era live ledger
above, which reproduces the same flat result independently. `TRADING_POLICY_V1`
and the ema_cross numbers (`maxCrossAgeBars`, `minSpreadAtrRatio`,
`targetAtrMultiple`) stay in code, unchanged, should a future re-spec want a
starting point; the version numbered V2 in this brief's option analysis
shipped as V3 in code, because V2 was already taken by the unrelated
entry-size-floor change (plan 29).

## Open questions no current data answers

- Maker EXIT leg frequency and resting-target mechanics (zero observations).
- Whether the 01:19:03Z corrective note changes realized exit behavior
  (checks i/j/k — pending a post-note position).
- True escalation rate (n=2; offline scenario (c) assumed 0.5).
- Mainnet transferability of everything fee- and fill-related: mainnet fee
  tiers, real queue depth at the touch, and real adverse selection are all
  unmeasured here.
- Whether any playbook other than ema_cross has edge — none has been tested
  on the fixed runtime with served evidence.
- Whether 5m ETH testnet price action resembles any market worth trading —
  the audit measured this venue, not markets in general.
