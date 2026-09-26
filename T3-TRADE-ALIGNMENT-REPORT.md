# T3 Trade: execution, research, and chart alignment review

Date: 2026-09-14. Checkout: `/Users/george/Workspace/t3trade`.
Reviewed HEAD: `0d7c1a1162a47ec527e3fe95c4e74e3a462fd1b9`.

## Mandate and conclusion

The owner's direction is clear: trade execution is a central feature. Hyperliquid execution works for the owner, and Uniswap must become an equally usable execution venue. Research should support that workflow, including ordinary internet research and a visible, reusable graph. This review is a report for a future implementation agent; it authorizes no trades, history rewrites, or implementation in this turn.

**There is substantial product misalignment in the current tree.** The strongest evidence is an always-refusing broadcaster in the normal protected Uniswap runtime, a separate fixed-account demo execution path, and session instructions that prohibit external market-data fallback while claiming that the testnet archive is the only market-data source. These are concrete implementation and instruction conflicts, not evidence that individual authors oppose trading.

**Do not solve this with a bulk revert or a search-and-delete of “refuse,” “research,” or “no signer.”** Most suspect commits combine useful foundations with unfinished execution or outdated scope. Removing them wholesale would remove the very infrastructure needed to finish Uniswap. Replace the restrictive product assumptions, connect the protected execution path, and preserve transaction correctness.

## Scope and evidence limits

Reviewed the latest 100 commit subjects, targeted older history and blame, selected commit bodies/stats and the unprotected-broadcast change, current provider instructions, tool definitions/handlers, runtime composition, Hyperliquid execution/archive code, Graph acquisition/event studies, chart mounting/publication, and the demo transaction lifecycle. The starting tracked worktree was clean.

This is a targeted source/history audit, not a line-by-line audit of every repository file. No application, tests, chain transactions, or historical-data requests were run for this report. The user's screenshots and earlier failures are incident evidence; source inspection confirms several mechanisms below, but does not certify the current browser or on-chain state. No signer material or environment secrets were read. References below are relative to the checkout and refer to the reviewed HEAD.

## Findings, in priority order

### P0: normal protected Uniswap execution is deliberately unwired

Evidence:

- `apps/server/src/trading/runtimeLayer.ts:363–382` composes `SwapBroadcastLifecycleLive` with `SpotBroadcastSinkUnavailable`. Its comment explicitly says the shipped composition never replaces the refusing sink.
- `apps/server/src/trading/forge/SwapBroadcastLifecycle.ts:108–115` implements that sink with an unconditional `broadcaster-missing` failure. The signing path checks availability before reading a signer, around line 486.
- `apps/server/src/mcp/toolkits/trading/handlers.ts:6378–6440` exposes `protected_swap` as atomic admission only. The result says signing/broadcast require a separate funded lane.
- A source search found the `signAndBroadcast` implementation and interface, but no production caller outside its defining module. The service is present; a complete application execution workflow is not established by that presence.

Impact: an approved proposal can be admitted without a user-reachable path completing its swap. A key being present cannot overcome the runtime's missing broadcaster or missing orchestration. More permissive prompt wording alone cannot fix this.

Future work: finish an explicit, venue-scoped execution workflow through the existing protected router, reservation store, signer, broadcast lifecycle, and reconciliation. One approved operation should progress through preparation, necessary approvals, submission, and receipt settlement, with durable recovery independent of the agent staying alive. Expose status and actionable configuration requirements. Do not route mainnet swaps through the old unprotected draft builder.

Acceptance: an explicitly authorized swap on a configured Uniswap route reaches a verified swap receipt through the normal application interface; restart after signing or broadcasting cannot duplicate economic execution; unavailable authority yields a specific setup action, not a universal “Uniswap cannot trade” statement.

### P0: the demo succeeds through a different product path

Evidence:

- `apps/server/src/trading/demo/DemoSwap.ts:6–9` hardcodes one account, 10 USDC, a cumulative gas cap, and three stages.
- `DemoSwap.ts:49–145` advances one stage per call, checks receipts, persists signed bytes before broadcast, and permanently ends after the one swap.
- `apps/server/src/trading/demo/DemoSwapLive.ts:81–104` uses a separate, expiring thread grant. Its journal and exclusive file lock are separate from the normal SQL execution workflow.
- `apps/server/src/mcp/toolkits/trading/handlers.ts:2705` calls this demo implementation directly.
- `handlers.ts:2694–2702` rejects demo execution whenever a mission is present and tells the user to use a separate ordinary task. This is an explicit workflow restriction, even if the mission can execute Hyperliquid trades; its authority does not automatically cover Uniswap.
- `apps/server/src/mcp/toolkits/trading/tools.ts:412` describes the fixed one-off operation; `TradingSessionProfile.ts:56` advertises it as a narrow exception.

Impact: this is useful demo functionality, but does not establish general Uniswap parity, multi-trade operation, or detector-to-execution integration. The agent must currently keep calling status/execute to progress approvals. The previous “approval mined, no swap” incident is consistent with stopping between stages; approval success does not prove a later swap will succeed.

Future work: preserve the demo and its journal until a normal path replaces it. Move reusable transaction mechanics into the protected product workflow with explicit migration/compatibility decisions. Replace the ordinary-task-only restriction with explicit venue-specific authority where the product supports a mixed-venue task; do not simply treat Hyperliquid authority as permission to spend Ethereum funds. Do not delete the journal to unlock another operation. Give every new trade its own durable identity rather than converting the one-off journal into an implicitly repeatable executor. Scope and coordinate nonce ownership if multiple execution paths can use the same account.

Acceptance: existing demo receipts remain readable; a new normal authorized swap has an independent operation ID, amount/recipient/route binding, and end-to-end progress without requiring a special recording prompt.

### P0: the global market-data instruction contradicts the product

Evidence: `apps/server/src/provider/TradingSessionProfile.ts:80`, introduced by `d648450367`, says:

> Never replace a refused product-data call with a shell command or a public-endpoint fetch. The product archive is the only market-data source (testnet-only).

This prefix is delivered across sessions. The same application now exposes mainnet Graph sources and retained Graph studies. It also tells the agent to research event inventories from official internet sources. The Graph event-window service's header separately insists on “never a non-Graph price source” (`GraphEventWindowStudyService.ts:8–11`).

Impact: the agent is being instructed to stop where the owner expects it to find historical ETH prices elsewhere. Repeated user prompt adjustments cannot reliably compensate for this global contradiction.

Future work: remove the universal archive-only/testnet-only research claim. Distinguish:

1. Execution inputs: host-validated, fresh, venue-specific quotes and account data.
2. Historical research: supported external sources with retained source, timestamps, price convention, units, coverage, and calculation lineage.
3. A specifically requested Graph study: Graph-priced results retain that identity; an alternative source is a separately labeled dataset or comparison.

A website price must not silently become an executable quote. Conversely, an unavailable Graph query must not prohibit a clearly labeled external historical study. Persist external price data through a supported import/research boundary; event-date import alone is not that boundary.

Acceptance: a Devcon research question can obtain missing historical prices from an identified external source, retain them, compute results, and chart those results without pretending they are Graph data or authorizing execution.

### P1: repository policy is behind the shipped code and owner direction

`AGENTS.md:15` says Hyperliquid testnet is the only trading target, with only a fixed Sepolia fee-hook exception. `docs/user/trading.md:15` describes testnet-only enforcement. `TradingSessionProfile.ts:56` acknowledges mainnet only as a fixed demo. The tree nevertheless contains protected chain-1 routes and a real mainnet demo tool.

Future work: replace the obsolete venue scope with explicit product support: retain Hyperliquid's current testnet boundary unless separately expanded; support configured Uniswap execution under its own chain/account/route authority. Separate the Sepolia fee-hook capability from ordinary spot swaps. Update applicable reviewer profiles and user documentation to the same scope. Do not assume that enabling Uniswap mainnet authorizes Hyperliquid mainnet or arbitrary chains.

### P1: Graph's historical acquisition granularity is poorly matched to event research

Evidence:

- `forge/GraphSource.ts:114` defaults to 5,000 swaps per fetch. Around lines 879 and 918 it rejects overflow and asks for a narrower window.
- `packages/trading-contracts/src/forge.ts:74` caps one source window at 24 hours.
- `research/GraphResearchService.ts:23–35` sets 200 occurrences, 90 segments, 50,000 total rows, and a 120-second acquisition budget.
- `GraphResearchService.ts:109–115` plans fixed approximately daily time segments. It later converts retained raw observations into candles at the requested interval.
- `GraphEventWindowStudyService.ts` improves this by acquiring each measurable occurrence/variant separately. It does not remove a busy day's raw-swap overflow.

Impact: changing output candles from daily to hourly does not reduce the raw swaps fetched for each daily source segment. A busy Uniswap pool can make even a short, useful study unavailable. A single window spanning years is worse. This explains why “use coarser candles” did not resolve the incident.

Future work: decouple acquisition resolution from rendering resolution. Implement resumable/adaptive smaller time or block segments with stable ordering, boundary deduplication, pinned provenance, progress, cancellation, and bounded total cost. Investigate indexed aggregate candles for price-only research after verifying the actual schema and semantics. Keep raw swaps for claims that require exact flow. Do not blindly raise all caps or treat partial pages as complete history.

Acceptance: a test fixture exceeding 5,000 swaps in a day completes by bounded subdivision, preserves all rows exactly once, survives interruption, and exposes coverage. A price-only query should not need every swap merely to obtain daily prices when a verified aggregate source is available.

### P1: study retention and chart publication are disconnected

`handlers.ts:4679–4812` runs/reads `study_graph` and returns a retained `graphStudy`. It does not publish a chart scene. Its retained study contains per-occurrence dataset identities. `trading_chart` separately publishes event-study/replay/annotation scenes. A retained window-study ID is not a dataset ID and cannot be passed as one.

`188ea2840` already added a real Graph dataset candle reader and rendering path. The problem is therefore not “Graph cannot chart.” The missing user journey includes converting a completed multi-occurrence result into an appropriate saved scene without rerunning acquisition.

Future work: add an explicit publish/open operation that consumes a retained study ID, resolves its per-occurrence datasets, and persists a scene referencing those exact results. Support an occurrence selector/event-aligned comparison instead of fetching all intervening years. Saved results must be reusable during recording without repeating expensive queries.

Acceptance: research once, publish once, reopen after restart, switch occurrences, and show the same computed entry/exit/return and source. Reopening must issue no acquisition job.

### P1: a saved annotation does not establish the market focus needed to mount its chart

`handlers.ts:5255–5295` publishes annotations without calling `noteThreadMarket`. Other paths do call it, including `trading_look` at line 1268 and event-study publication around line 4877. `ChatView.tsx:1414–1423` derives the market from thread focus/mission state, and lines 7917–7918 omit the card when that market is null.

This explains how one task can report successful publication while another task shows a chart. It is a visibility/state problem, unrelated to whether the task has trading authority. Scenes are thread-scoped; `show` rejects another thread's scene.

Future work: make publication or an explicit open action establish/select the scene's market and view through the normal state boundary. Render scene availability even without a mission. Retain thread/environment isolation, but provide an intentional reuse/import flow if cross-task research reuse is supported.

Acceptance: in a fresh task with no mission or previous market read, publish an ETH annotation and open it in one action. No prerequisite `trading_look`, task switch, or refresh prompt should be required.

### P1: “Open on graph” lacks a complete tool-result-to-navigation contract

The tool returns structured `open: { kind: "open_scene", sceneId, threadId, market, view }`. A source search of `apps/web/src` and `packages/client-runtime/src` found no `open_scene` consumer or `t3://graph/scene` handler. Actual buttons exist in `MarketChartPanel.tsx:447` and `ResearchScenePanel.tsx:1718`.

The incident's prose link is therefore not evidence of a registered navigation action. Telling the model to repeat that link is not a UI fix.

Future work: implement a typed action renderer/dispatcher, or return only a navigation mechanism that the app actually handles. Validate environment/task/scene identity, select the scene and correct Live/Calendar/Event-aligned view, and bring the chart into view. A future dated annotation also needs a view that can expose its timestamp; pinning October in September's one-day window cannot make it visible.

Acceptance: click the actual action rendered from a tool result, including on a fresh task and an offscreen chart; verify selected scene and visible content. Test unknown, historical, cleared, and wrong-task IDs. Do not settle for asserting that the tool returned a label.

### P1: research semantics do not cover the requested questions consistently

- `GraphEventWindowStudyService.ts:94–102` exposes `pre-start` and `post-end` anchors. Post-end is not conference-start for a multi-day event. Add an explicit start anchor/offset rather than silently changing the official event span.
- `packages/trading-contracts/src/thesis.ts:112–153` has a restricted operand vocabulary; the event operand measures time since an ended event. The earlier proposed future pre-event breakout/rolling closing-high rule was outside that vocabulary. The model should inspect capabilities before proposing an executable rule.
- `TradingSessionProfile.ts:86` says a per-notional dollar illustration is “never a portfolio return.” Correct for independent illustrations, but too broad if treated as a prohibition on implementing an actual cash-flow portfolio study.
- The latest $2,000 question requires a precise purchase schedule: once on each conference's first day, or on every conference day. The previous prompt assumed the former. Preserve that distinction rather than treating it as settled user intent.

Future work: implement schedule-based hypothetical purchases with an explicit execution-time convention, investment per purchase, price source, valuation cutoff, costs, and holdings ledger. Separate seven-/thirty-day independent comparisons from aggregate buy-and-hold value. Record unsupported early dates and future events without fabricated fills. Research does not need a strategy replay or detector merely to calculate this portfolio.

Acceptance: a small deterministic fixture proves cash contributions, ETH quantities, overlapping holdings, missing dates, cost treatment, and final valuation. A chart shows the actual computed series/purchase markers. A planning annotation is never substituted for that series.

### P2: comments and tool copy describe unfinished project slices as permanent product policy

Examples include the long “honest end of this slice” introduction in `SwapExecutionService.ts`, “coordinator-held” funded-lane comments, and `tools.ts:385` stating that `swap` has no authorized signer and nothing executes. These accurately describe parts of today's implementation, but make temporary development staging look like the intended product.

Future work: replace milestone/worker/slice narratives with short explanations of current invariants and real runtime capabilities. Tool output should name the actual blocker and next action: missing grant, expired quote, unsupported route, pending approval, or unavailable runtime. Once execution is wired, remove assertions that it is universally unavailable. Keep read-only descriptions on genuine reads, and keep analyst/observe scope restrictions where the user selected those modes.

## Hyperliquid versus Uniswap / The Graph

The Graph is a data source; Uniswap is an execution venue. Comparing both to Hyperliquid requires separating those responsibilities.

| Dimension             | Hyperliquid implementation                                                                                      | Uniswap / Graph implementation                                                                  | Direction                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Execution entry       | Typed direct/manual and mission paths; direct orders explicitly require no TRADE.md                             | Forge proposal/admission path plus a separate fixed demo                                        | Support a direct, approved spot order without requiring detector authoring                          |
| Submission            | `HyperliquidExecutionService.ts` persists intent/reservation, signs, calls exchange, inspects per-order results | Protected lifecycle exists, but normal runtime sink refuses; demo broadcasts separately         | Finish orchestration and real configured sink                                                       |
| Protection            | Perpetual exposure, native stops, risk budgets, reduce-only exits                                               | Spot token transfers, minimum output, deadline, allowance, chain/recipient binding, gas budgets | Preserve venue-specific protections; do not impose a perpetual stop model on spot swaps             |
| Recovery              | Execution records, serialized nonce lane, reconciler, working-order loops                                       | Protected SQL lifecycle and separate file-backed demo recovery                                  | One visible operation status and account-wide nonce coordination                                    |
| Data acquisition      | `archive/archiver.ts`: candle snapshots, WebSocket feed, polling repair, startup backfill, hydration requests   | Graph raw-swap fetches plus a separate configured Substreams ingestion lane                     | Reuse the operational pattern of continuous/resumable collection, not exchange-specific assumptions |
| What 5,000 limits     | `archive/config.ts:196`: candle window bars                                                                     | `GraphSource.ts:114`: individual swaps per fetch                                                | These are not comparable history lengths; a busy day's swaps can exhaust Graph's limit              |
| Data persistence      | Venue-scoped candle/funding/context/book archive and known gaps                                                 | Immutable Graph datasets, study rows, separate Substreams facts/cursors                         | Unify coverage/discovery UX while preserving source identity                                        |
| Historical reach      | Limited by provider reach and what has been recorded; not automatically full ETH history                        | Limited by pool inception, indexer retention, schema, acquisition budget                        | Provide an explicit external historical price source for older research                             |
| Chart                 | Live market focus and archive window reads                                                                      | Retained dataset chart already exists; publication/focus/navigation gaps remain                 | Common chart shell, explicit source, saved-result reopening                                         |
| Freshness             | Live market and archive health                                                                                  | Snapshot pin/provenance and stream final watermark/health                                       | Display capture time versus live freshness distinctly                                               |
| Evidence to execution | Fresh venue/account inputs go through host checks                                                               | Detector evidence/envelopes and protected proposals exist; demo bypasses that research chain    | Historical insight can inform a decision; executable quotes and authority remain fresh host inputs  |

Substreams work in `5e2c8039d`, `23115e673`, and reconnect fix `0db2d5d60` is aligned with sustained collection. It is not proof that a configured stream currently covers past Devcons, or that the historical chart reads that stream. Do not conflate stream status, retained Graph datasets, and Hyperliquid live candles.

## Commit disposition

No whole implementation commit was established as safe to drop outright. Prefer forward repair on this already dependent history. “Remove” below means remove the identified obsolete behavior or wording, not erase all changes in its originating commit.

| Commit                                             | Recommendation                                                                 | Reason / dependency risk                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d648450367` tool-selection policy                 | Remove archive-only/testnet-only research hunk; revise policy tests            | Direct source of the external-data prohibition. Keep bounded keys, catalog discovery, and valid horizon guidance                                                       |
| `b175f1dcd` Sepolia-only exception                 | Supersede wording                                                              | Reverting restores an even narrower Hyperliquid-only rule; it does not enable Uniswap                                                                                  |
| `608b1093a` draft swap path                        | Replace its role as an execution endpoint; retain useful persistence/contracts | Introduced a terminal no-signer workflow, but also proposal/intent infrastructure and migration 107. Wholesale revert removes foundations                              |
| `7a12e6cb9` refuse unprotected broadcasts          | Keep protection fix; retire old draft endpoint after protected replacement     | Diff confirms it removed a broadcaster call for calldata without enforceable minimum-output/deadline protection. Reverting is not a valid shortcut to executable swaps |
| `aa4917abc` protected mainnet execution            | Keep and finish integration                                                    | Adds router verification, atomic reservations, signing/receipt lifecycle, migrations 110/111. It moves toward execution despite an unwired runtime                     |
| `f615d3b06`, `eb974d833` funded recovery/authority | Keep; review as part of integration                                            | Recovery and authority binding support reliable execution. Later work depends on nonce claims and host quote identity                                                  |
| `4aaa01c35` one-off demo                           | Keep as temporary compatibility; replace product role                          | It adds actual demo execution, not opposition to trading. Hardcoded account/amount and separate ledger are not a general product design                                |
| `0d7c1a116` fee floor/resume                       | Keep                                                                           | Positive tip and clear continuation improve the incident path. Larger gas limit provides headroom; priority/max fee affect inclusion, with no speed guarantee          |
| `3ab866ac2` refuse mismatched archive chart        | Keep source-integrity rule                                                     | Prevented Graph results being drawn over unrelated Hyperliquid prices; subsequent dataset chart work supplies the right replacement                                    |
| `188ea2840`, `17924d5ed` dataset charts/lineage    | Keep and connect to retained window studies                                    | These implement the correct source-aware chart path                                                                                                                    |
| `8eabb9d8b` segmented Graph acquisition            | Keep provenance/reuse; revise fixed segmentation                               | Useful acquisition foundation, insufficient for high-volume daily windows                                                                                              |
| `23115e673` Devcon studies / stream facts          | Keep; revise Graph-only research doctrine and expand semantics                 | Contains durable scheduler/occurrence work as well as event studies. Broad revert would damage unrelated working features                                              |
| `61b74d90c`, `dedb643b4` study tool/readback       | Keep and add chart publication by retained ID                                  | Reusing research for recording is exactly the desired direction                                                                                                        |
| `37500af58b` unified graph                         | Fix annotation focus/navigation; do not drop                                   | Core chart functionality; missing date was also an incorrect prompt, not a reason to remove date validation                                                            |
| `d02afde813` publication versus visibility         | Keep identity/visibility correctness; complete action wiring                   | Correct distinction, incomplete user journey. Removing the distinction would produce false success claims                                                              |
| `9a071ba521`, `f103fc78e` direct/manual trading    | Preserve                                                                       | Direct execution without forcing a research/plan ceremony is aligned with the owner's intent                                                                           |
| `edaa75c3e` scratch captures                       | Optional separate repository hygiene review                                    | No evidence it blocks execution. Not a reason to alter trading behavior                                                                                                |

Before any future revert: inspect the full diff and descendants, map schema consumers, preserve applied migrations and existing receipts, and prove the resulting behavior. Commit titles containing “refuse” are not adequate evidence for removal. This report makes no claim that rewriting shared history is appropriate.

## Wording to remove, revise, and preserve

Remove or replace as product policy:

- Universal “only Hyperliquid testnet” statements where describing all execution venues.
- “The product archive is the only market-data source.”
- “Never a non-Graph price source” when applied to general ETH research rather than an explicitly Graph-only study.
- Universal no-signer/no-execution assertions once runtime capability exists.
- “Never a portfolio return” as a blanket limit on new portfolio calculations.
- Development-stage narratives that imply execution permanently belongs outside the application.

Preserve, with concise and specific wording:

- Missing/expired authority, unsupported chain, stale quote, budget exhaustion, wrong recipient, and uncertain transaction state must stop the relevant action.
- Read-only research and analyst/observe modes remain usable without signing and do not accidentally gain authority.
- An approval transaction is not a swap; submitted, mined, finalized, and reverted are distinct states.
- A saved annotation is not calculated performance; a dataset from one venue is not another venue's price history.
- No fabricated historical data, retrospective best-price “strategy,” or unproven claim of causation.
- No exposed keys, duplicate orders, or automatic transaction replay with a new economic intent.

The target voice is operational: “Approval confirmed; swap is next,” “Grant expired; renew it to continue,” or “Dataset lacks this date; obtain another retained source.” Avoid repeated generic disclaimers while retaining the state the user needs to act.

## Implementation order for the future agent

1. **Align scope and discovery.** Update venue/research policy and provider prefixes together. Expose actual runtime capabilities, account/chain, and remaining setup. Test that a configured execution task is not globally described as unable to trade.
2. **Finish normal Uniswap execution.** Integrate the protected lifecycle, approval handling, real authorized broadcast transport, durable worker progression, status, and reconciliation. Keep the existing demo readable until replacement acceptance passes.
3. **Fix chart visibility and actions.** Annotation focus, structured action consumption, correct scene/view selection, offscreen navigation, empty/error handling. This is independent of trading authority.
4. **Make historical acquisition practical.** Adaptive/resumable segments, coverage-first planning, retained cache reuse, source-aware external price import, and appropriate price aggregates versus raw flow.
5. **Publish retained research directly.** Bridge saved multi-occurrence studies to chart scenes without recomputing. Add explicit start-based semantics and the $2,000 purchase schedule/portfolio calculation.
6. **Clean obsolete drafts and copy.** Remove superseded interfaces and milestone prose only after replacement paths work. Update tests that enshrine permanent unavailability; retain negative tests for actual unsafe inputs.

Required verification should remain focused. Backend changes need direct lifecycle and accounting tests covering successful completion as well as refusal, restart, timeout, concurrent admission, uncertain broadcast, and receipt mismatch. UI changes require the repository's `test-t3-app` workflow with one isolated state/stack and browser. Verify server/web/shared contracts, active provider adapters, desktop wrapper, local/remote environment scope, and reverse controls. Do not require a real-money trade as an automated development test; any live acceptance is a separately explicit operator action.

Final acceptance should reproduce the owner's complete journey: ask a historical investment question, obtain and save sourced calculations, see the matching graph, reopen it for recording without rerunning research, then independently authorize a supported Uniswap trade and see its verified completion. Research or detector construction must not become a prerequisite for a direct trade.

## Changes made by this review

Only this Markdown report was created. No implementation, tests, server state, grants, transactions, commits, or history were changed. Leave this handoff report uncommitted unless the owner requests its inclusion; the repository excludes plans and scratch evidence from implementation commits.
