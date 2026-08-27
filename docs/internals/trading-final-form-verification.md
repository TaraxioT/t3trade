# Trading final form — verification log

Iterative verification of the landed phases in `trading-final-form.md`, against
`main` only. Each round is one dated section; findings carry severity, repro,
and file pointers. Evidence (screenshots, DB dumps) lives under
`evidence/final-form/` at the repo root (local, not committed).

Method: a detached worktree at the verified commit (`t3trade-verify-main`),
its own `.t3` state, one dev server and one controlled browser for the whole
loop. Server-side facts read from the dev-runner log, the SQLite files, and
`ps`/`lsof`; UI facts read in the paired browser.

## Round 1 — 2026-08-27 — Archiver v2 (Phase 2)

Commit under test: `f103fc78e` (all of phases 0–7 are on `main`; 8–9 not
started). Fresh state boot (empty `.t3`), server 16320 / web 8280.

| Acceptance | Result | Evidence |
| --- | --- | --- |
| Fresh state boots the archiver | Pass | dev log `ArchiveSupervisor: archiver started {pid 81126}` at 17:41:10, 0s after listen; child `node …/trading/archive/main.ts` under server pid 80726 |
| kill -9 → respawn with backoff | Pass | `kill -9 81126` at 17:46:01 → `WARN archiver failed` (SIGKILL cause) 17:46:01.688 → `archiver started {pid 84682}` 17:46:03.697 — 2.0s, the `BACKOFF_BASE` after a run longer than `HEALTHY_AFTER`; UI later showed "restarted 1× since boot" |
| WS candles flowing | Pass | archiver child holds an ESTABLISHED TLS session to `api.hyperliquid.xyz` (CloudFront edge); fresh 1m bars land every minute (`MAX(t)` tracks wall clock); writer-lock lease heartbeat fresh within its 10s interval |
| Follow a new asset → backfill ≤ ~1 min | Pass | SOL added to watchlist 17:48:00 → follow file published 17:48:29 (`PUBLISH_INTERVAL_MS` 30s) → 32,174 bars across all 7 intervals by 17:48:46 (46s end to end) |
| Archive file is schema v2, venue populated | Pass | `meta.schema_version = "2"`; `candles(venue, coin, interval, t, …)` with `venue='hyperliquid'` on every row; cold start seeded BTC+ETH (~5k bars × 7 intervals each) |

Cold-start behavior matches the design: the server writes
`{"followed":[]}` and the archiver substitutes `DEFAULT_SEED_COINS`
(BTC/ETH) until a real follow set exists (`archive/config.ts:66-89`). After
SOL was followed, the follow file became the sole source and BTC/ETH stopped
being recorded — attention-driven, as specified.

### Findings

- **[Low] R1-1 — Archiver health changes ring no bell.** The trade home's
  account view refreshes only on the account doorbell
  (`apps/web/src/lib/tradingAccountState.ts:6-11`, "no poll intervals … by
  design"). A supervisor crash/respawn is not a trading event, so the health
  line stays stale indefinitely on an otherwise-idle account. Observed: the
  archiver was killed at 17:46:01; "Market recording is running (restarted
  1×)" only appeared at 17:48:0x after an unrelated watchlist edit rang the
  doorbell. The mission snapshot's 30s backstop does not cover the account
  view. Repro: fresh state → trade home → `kill -9` the archiver child →
  the health line never changes until a trading event occurs.
- **[Info] R1-2 — Signal deaths log as `failed`, not `exited`.** A SIGKILLed
  child makes `child.exitCode` throw, so the supervisor logs
  `WARN archiver failed {cause: … SIGKILL}` rather than
  `archiver exited {code}` (`apps/server/src/trading/ArchiveSupervisor.ts:152`).
  Handling is identical (restart + backoff); wording only.
- **[Medium] R1-3 — Phantom draft tab crashes on fresh state.** Within a
  minute of pairing on fresh state, a second tab appeared at
  `/draft/d0afc345-…` (title "T3 Trade (Alpha)") that I did not open, and it
  crashed ~18s in: error boundary "Base UI: SelectRootContext is missing.
  Select parts must be placed within <Select.Root>" in `<SelectTrigger>`,
  TanStack route match `__root__/`. Console log:
  `evidence/final-form/` (copy of `.playwright-mcp/console-2026-08-27T12-12-38-844Z.log`).
  What opened the tab is unidentified (no window.open on the draft path;
  `ChatView.tsx:1976-2013` only `navigate`s). Re-verified deliberately in
  Round 3 — see R3 findings before treating the opener as a bug.

### Verdict

Archiver v2 is solid: supervision, backoff, WS-first collection, follow-set
control, and the v2 schema all behave exactly as the plan describes, with
sub-minute backfill on a new follow. The one behavioral gap worth a look is
R1-1 (archiver health is not eventually-consistent in the UI); R1-3 is a
real crash waiting for a repro before it's actionable.
