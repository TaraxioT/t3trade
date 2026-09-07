# Continuity baseline

Status of the `continuity-base-20260907` baseline: what the merged main
carries, what it inherits, and what stays open. This is shipped scope
documentation for the Continuity campaign that follows it, not a release
certificate.

## Preserved baseline features

- Trading correctness repairs RC01–RC06 (mission authority finalization,
  cancellation acknowledgement semantics, cancellation/block-write
  truthfulness, emergency-close result propagation, latched environment
  destination, durable operator-visible control outcomes).
- Focused regression suites over
  `TradingControlService`, `TradingEmergencyCloseService`,
  `RestingIncreasingOrders`, `TradingMissionReactor`,
  `TradingMissionProjection` (144 tests green at the tagged merge).
- Desktop single-instance hardening (RC12 case 1): the desktop app takes
  Electron's single-instance lock itself on every platform, keyed on the
  resolved `userData` path, before the Clerk bridge and long before the
  backend pool starts; a lock-losing instance exits via `app.exit(0)`
  before bootstrap can acquire the state directory. The Clerk SDK only
  acquires this lock on Windows and Linux, which is why a second direct
  binary launch on macOS previously started a second embedded backend
  against the same `T3CODE_HOME/userdata`. Unit-tested with lifecycle
  receipts; see the desktop disposition below for what remains
  unverifiable on packaged darwin.

## Inherited work

- All pre-campaign product behavior of T3 Trade (web + desktop) from the
  readiness-repair campaign and before, including the site/documentation
  commits up to `62001606e`.

## Deferred issues (explicit, not waived)

- RC06 integrated browser matrix (blocked on a mission fixture): focused
  server/contract evidence retained; the browser pass is not claimed as
  passed.
- RC10-F1: mission cards and Mission history not rendering on live
  stacks; TRADE.md matrix cells blocked on the same anomaly. No repair
  campaign in this milestone.
- RC09-F1: focus lands on BODY when a panel closes; old visual/zoom
  findings. Deferred by the user. The earlier CDP page-scaling evidence
  wording stands; it is not proof of ordinary browser zoom.
- RC12 native cases 2–9 (deep link, disconnect/reconnect, credentials,
  wrong environment, delayed switch, incompatible version, update
  failure/retry, artifact preview/focus).
- The old RC13 full product-release review was superseded for this
  milestone by the scoped closeout and remains unexecuted as a full
  readiness review.

## Desktop disposition

`DESKTOP_QUARANTINED` for the Continuity campaign.

- Retained and unit-tested: the desktop app takes Electron's
  single-instance lock itself (keyed on the resolved `userData` path,
  before the Clerk bridge and before the backend pool can start), and a
  lock-losing instance exits via `app.exit(0)` before bootstrap. This is
  correct wherever Electron's singleton engages — including the
  Windows/Linux identity the Clerk SDK already covered.
- Not verifiable on packaged darwin: reproduced on an unsigned arm64
  fixture, a direct-binary duplicate launch either parked indefinitely
  before the lock resolved or treated a live holder's lock as stale, took
  it over, and started a second embedded backend against the same
  `T3CODE_HOME/userdata` (RC12's failure, on the fixed build). A `SIGTERM`
  to a fixture main can also leave its embedded backend child orphaned and
  writing. Electron's macOS singleton in this launch configuration cannot
  be relied on for writer exclusion.
- Contained, not fixed: Electron scopes its lock to `userData`, so two
  instances with **distinct** `userData` paths that point at one shared
  `T3CODE_HOME` state directory (for example a dev run and a packaged run
  sharing `T3CODE_HOME`) also race for the same SQLite files, and the
  server has no cross-process state-ownership guard (it opens
  `state.sqlite` directly). Making this safe needs a new cross-process
  locking design plus a darwin launch-path investigation, both out of
  scope for this baseline.
- Consequence: the packaged desktop app must not be distributed or used
  for the Continuity demo. Web/server integration is unaffected and may
  proceed; the normal single-server web workflow has no shared-storage
  defect. Normal single-instance desktop launches and independent
  disposable identities continue to work.

## Research/local-rehearsal boundary for the next campaign

The Continuity campaign (see its prompt beside this file's origin) adds
web research surfaces and local rehearsal on top of this baseline. Its
execution target remains Hyperliquid testnet only; research mode must
keep working without a signer; user controls must work without the agent
provider. Nothing in this baseline authorizes packaged desktop
distribution or a mainnet path.
