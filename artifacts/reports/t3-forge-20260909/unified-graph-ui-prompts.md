# The chart becomes the work surface — execution prompts

Authoritative plan: unified-graph-ui-plan.html

## U0 — Verify and complete the post-Forge UI handoff

You are implementing T3 Forge for ETHOnline in /Users/george/Workspace/t3trade. This is a hackathon build scoped to September 9–11, 2026. Read AGENTS.md and the authoritative artifacts/reports/t3-forge-20260909/implementation-plan.html, plus the independent unified-graph-ui-plan.html. The user's current Forge direction supersedes the older continuity/fork-rehearsal, broad-polish, no-Uniswap and obsolete Luna-development mandates only where explicitly stated. Do not execute those old campaigns.

Use GPT/GLM for development and direct focused checks; the in-app provider is used only to exercise the product's real agent capability. Read .repos/effect-smol/LLMS.md before Effect-heavy changes. Preserve unrelated checkout changes and stage only intended paths. The reviewed baseline is 0c8304eb3; resolve symbols in the actual post-Forge checkout rather than assuming line numbers are stable. No PR, push, production deployment or mainnet signing. Public mainnet reads are allowed; only the configured Uniswap public testnet may be written. Do not repurpose Hyperliquid signers or weaken any existing trading guard.

All product numbers and transaction evidence must be real. Fixtures belong only to automated tests. Authentic historical windows are explicitly historical and cannot drive live fee policy. Missing access/data produces a named unavailable state. No Node vm/host import fallback for generated code. No model-authored unrestricted Solidity. One approved fixed hook only.

Use the phase's listed file ownership; treat new names as intended targets, verify the actual repository seams. Existing shared schemas/RPCs must be updated across server, web, desktop and client-runtime; mobile only as needed to avoid broken shared compilation. Add focused tests and targeted package checks. For user-visible changes follow test-t3-app using one retained isolated stack/browser for the entire campaign, owned by the designated tester. Do not test development by asking the application to modify this repository.

Write progress/evidence under /tmp/t3-forge-20260909/U0/ with exact checkout, tested SHA, commands/cwds/exits, actual receipts, redacted screenshots and open failures. Record 'implemented', 'automated verified', 'real-data verified' and 'human accepted' separately. Never mark a phase accepted yourself. When checks pass, commit only the phase implementation and durable behavior docs (not temporary evidence). Return the concrete human verification steps and wait for the human's actual pass/fail before beginning any dependent phase. If the gate fails, repair this phase and repeat its relevant checks. An elapsed timeout is not approval.

Review boundary: this plan was corrected through static code/image inspection without starting a server. That does not satisfy future implementation browser gates. Do not start any server if the user still prohibits runtime work when executing this prompt; complete independent work and explicitly leave browser acceptance pending.

U0 — Verify and complete the post-Forge UI handoff
Sequence: after F1–F3; first part of F4, or catch-up after the main pack. Depends on backend outputs, not just an F0 visual approval.

Owned files: narrowly missing Forge read-model/contracts/server/client-runtime APIs and their tests; new UI selection/state types. No layout implementation yet. One owner handles shared schema registrations. Progress: /tmp/t3-forge-20260909/U0/.

Read the UI plan's Code audit, Required handoff and Preservation contract. Inspect the actual completed F1–F3 code and evidence. Build a checklist mapping each required DTO/command to its implemented symbol, route, schema, test and evidence. Do not accept a phase label as evidence. Required inputs: source/build discovery with threadMarket=null; pre-install real pool series; complete source provenance/health/coverage; immutable build/test/install/version receipts; aligned bounded chart samples; categorical observations; installed-vs-confirmed pool policy/tx snapshot; direct pause/revoke/withdraw APIs. F5 comparison records may still be unavailable at this point; expose that state honestly.

Add only missing bridge work: getForgeThreadContext/getForgeInstrument/getForgeEvidence/getForgePool or existing equivalent names, matching runtime schemas, ws/RPC/ipc/client-runtime registrations, environment/thread authorization and cache identities. Define maxPoints<=720, explicit UTC domain, <=24h available real coverage, per-pool quote units, provenance references, source status and paginated details. Pool chart points must come from real observations, never coerce them into HL candles. Source access must work with no HL market focus and while account/provider/signing is unavailable.

If diagnostics are absent, update the SDK/test/read model contract so generated readings or sealed evaluation evidence expose real qualifying/excluded counts, volume, anchors and trade IDs. Older modules without diagnostics display 'detail unavailable'; do not fabricate fields. Do not hand-edit a supposedly agent-generated detector or repeat successful public deployments. For already-built main-pack outputs, reuse actual artifacts/receipts and repair only missing prerequisites.

Inspect legacy chart network attribution at the source: do not infer mainnet/testnet from a screenshot. Plan and implement only metadata needed for labels if absent, keeping candle source and current snapshot source distinguishable. Freeze focus/source state keyed by environment+thread+instrument. Draft hero and HL mission authority remain unchanged.

Required checks: focused source-series/diagnostic/schema/auth tests, same-input normalized output, gaps and missing anchor, pagination/cap, cross-environment refusal, late result isolation, no-HL-focus discovery, installed/confirmed mismatch. Targeted checks only for changed packages. No browser is needed for this backend gate; no live external writes to obtain duplicate evidence.

Expected result:
A checked handoff manifest with exact implemented names, sample real recorded response references and no missing required U1 fields. The legacy graph remains untouched. Comparison explicitly unavailable until F5 provides it.

Human verification, then stop:
George reviews the input/output mapping and a real recorded source response; confirms existing weekly graph remains an independent source, the source/instrument read resolves without an HL mission, and unavailable fields are honest. Approve U0 or identify a missing prerequisite. Do not proceed with U1 dependent work while the bridge is incomplete.

---

## U1 — Mount one focused instrument without breaking the existing graph

You are implementing T3 Forge for ETHOnline in /Users/george/Workspace/t3trade. This is a hackathon build scoped to September 9–11, 2026. Read AGENTS.md and the authoritative artifacts/reports/t3-forge-20260909/implementation-plan.html, plus the independent unified-graph-ui-plan.html. The user's current Forge direction supersedes the older continuity/fork-rehearsal, broad-polish, no-Uniswap and obsolete Luna-development mandates only where explicitly stated. Do not execute those old campaigns.

Use GPT/GLM for development and direct focused checks; the in-app provider is used only to exercise the product's real agent capability. Read .repos/effect-smol/LLMS.md before Effect-heavy changes. Preserve unrelated checkout changes and stage only intended paths. The reviewed baseline is 0c8304eb3; resolve symbols in the actual post-Forge checkout rather than assuming line numbers are stable. No PR, push, production deployment or mainnet signing. Public mainnet reads are allowed; only the configured Uniswap public testnet may be written. Do not repurpose Hyperliquid signers or weaken any existing trading guard.

All product numbers and transaction evidence must be real. Fixtures belong only to automated tests. Authentic historical windows are explicitly historical and cannot drive live fee policy. Missing access/data produces a named unavailable state. No Node vm/host import fallback for generated code. No model-authored unrestricted Solidity. One approved fixed hook only.

Use the phase's listed file ownership; treat new names as intended targets, verify the actual repository seams. Existing shared schemas/RPCs must be updated across server, web, desktop and client-runtime; mobile only as needed to avoid broken shared compilation. Add focused tests and targeted package checks. For user-visible changes follow test-t3-app using one retained isolated stack/browser for the entire campaign, owned by the designated tester. Do not test development by asking the application to modify this repository.

Write progress/evidence under /tmp/t3-forge-20260909/U1/ with exact checkout, tested SHA, commands/cwds/exits, actual receipts, redacted screenshots and open failures. Record 'implemented', 'automated verified', 'real-data verified' and 'human accepted' separately. Never mark a phase accepted yourself. When checks pass, commit only the phase implementation and durable behavior docs (not temporary evidence). Return the concrete human verification steps and wait for the human's actual pass/fail before beginning any dependent phase. If the gate fails, repair this phase and repeat its relevant checks. An elapsed timeout is not approval.

Review boundary: this plan was corrected through static code/image inspection without starting a server. That does not satisfy future implementation browser gates. Do not start any server if the user still prohibits runtime work when executing this prompt; complete independent work and explicitly leave browser acceptance pending.

U1 — Mount one focused instrument without breaking the existing graph
Sequence: after U0; remainder of F4 or catch-up. F5 is not required to mount v1. Progress: /tmp/t3-forge-20260909/U1/.

Owned files: bounded ChatView layout integration; ThreadMarketCard/ThreadMarketPanel composition; new ThreadInstrumentPanel/PoolActivityChart/ForgeSignalLane/ForgeBuildReceipt/ForgePoolInspector/ForgeVersionDiff and focused state; tradingMarketChartState.ts refresh fix; focus-specific trading.css; focused tests. Do not refactor the entire ChatView or implement a new chat editor.

Implement focus as an instrument slot beside the existing chat-column subtree. Keep MessagesTimeline and ChatComposer mounted with their existing refs, send paths, approval/input banners, attachments, provider controls and timeline measurements. In focus mode suppress the drawer chart and both companion mount locations. Do not leave hidden duplicate charts/polls. Preserve draft hero and normal coding/right-panel/terminal workflows.

Instrument selection is HL Research, HL Position when applicable, or Forge pools. Retain MarketChartPanel/MissionPriceChart for HL Research with real candles, volume, EMA, study markers, scene selector/count/Open and all existing range/recipe semantics. HL Position uses the existing mission chart and controls; do not blend actual orders with research geometry. Forge pools use their own small real-data SVG + signal lane with an explicit shared time mapping and gutters, bounded source history and no HL arm-at-price/stop-drag handlers. No new chart library or fake candles. The current renderer has no general zoom API; preserve actual range/bars/source/selection, not an invented zoom system.

Lift/persist only the state needed across reflow/source selection: range,bars,view,selectedSceneId and once-per-scene fit/monthly-promotion state per context. Respect explicit Open on graph refit, manual range changes and clearing scenes. Keep global HL candle/EMA preferences unchanged. One chart body mounts at a time; one hook owns each live refresh. Fix the existing maxBars refresh mismatch by refreshing the captured atom (or matching every input parameter), and display chart.stale with last successful timestamp. Add a direct timer/retry identity test; do not just test the pure range resolver.

Chart/account loading are independent. A null account read is unknown, not no exposure. Keep existing AccountPositionsPanel/manual close and useMissionControls paths available for all selected-environment positions/working orders even when pools are selected. Avoid mounting MissionLivePanel parts=market merely to obtain its positions. Mission status/agent log and plan remain accessible; collapse large plan content in focus mode without hiding safety banners or changing commands.

Use available container width: >=920px supports instrument+360px conversation; smaller uses Chart/Conversation focus within the same workspace, keeping draft and controls accessible. Inspector opens inline only when the plot retains >=520px; otherwise a keyboard-accessible drawer. Existing RightPanelTabs or terminal may trigger compact layout. Composer observer measures its own actual height after chart removal; never subtract a magic number or let external chart height become timeline end padding. Pass focus-specific sizing; do not globally change Trade-home chart height classes.

Render receipt-backed build progress and real v1 source/lane/pool status. F5 diagnostics unavailable means a disabled comparison with reason, not mock v2. Distinguish installed detector, submitted intent and confirmed/effective pool state as of a chain read. Stale/expiry while offline is 'last confirmed / expected baseline', not fresh confirmation. Implement light/dark, text status, accessible evidence list and reduced motion without continuous animation.

Required checks: new ThreadInstrumentPanel.test.tsx and forgeInstrumentState.test.ts; new tradingMarketChartState.test.ts timer/manual refresh identity + stale/key-reset cases; affected MarketChartPanel.test.tsx, ThreadMarketCard.test.tsx, threadMarketPanelState.test.ts, researchScenePresentation.test.ts, missionChartGeometry.test.ts, marketChartOverlays.test.ts, ChatView.logic.test.ts/composerFooterLayout.test.ts and rightPanelStore.test.ts only where touched. Add stateful mounting/resize/selection assertions; existing static-render stubs alone cannot prove preserved state or geometry. Run targeted web/client-runtime checks, not repository-wide tests.

Expected result:
One executable chart-first workspace retaining the screenshot's real weekly/EMA/event scene, and a distinct new real-pool instrument. One chart/poll owner, one composer, no unprovided DTO assumptions. v2 comparison may await F5.

Human verification, then stop:
Using the sole retained test-t3-app stack only when runtime is authorized, George checks the legacy ETH Live/All/1-week chart, EMA/candle toggles, published count/scene/Open/Calendar/Event-aligned/source links; switches to real pools and back with state retained; opens focus with no HL market; checks Graph/account failures independently. Confirm last message/composer/attachments/pending user input at wide and compact widths with terminal/right panel open, active positions still controllable, no duplicate charts/requests. If runtime is prohibited, report this gate pending rather than accepted.

---

## U2 — Verify unification after revision and close the demo

You are implementing T3 Forge for ETHOnline in /Users/george/Workspace/t3trade. This is a hackathon build scoped to September 9–11, 2026. Read AGENTS.md and the authoritative artifacts/reports/t3-forge-20260909/implementation-plan.html, plus the independent unified-graph-ui-plan.html. The user's current Forge direction supersedes the older continuity/fork-rehearsal, broad-polish, no-Uniswap and obsolete Luna-development mandates only where explicitly stated. Do not execute those old campaigns.

Use GPT/GLM for development and direct focused checks; the in-app provider is used only to exercise the product's real agent capability. Read .repos/effect-smol/LLMS.md before Effect-heavy changes. Preserve unrelated checkout changes and stage only intended paths. The reviewed baseline is 0c8304eb3; resolve symbols in the actual post-Forge checkout rather than assuming line numbers are stable. No PR, push, production deployment or mainnet signing. Public mainnet reads are allowed; only the configured Uniswap public testnet may be written. Do not repurpose Hyperliquid signers or weaken any existing trading guard.

All product numbers and transaction evidence must be real. Fixtures belong only to automated tests. Authentic historical windows are explicitly historical and cannot drive live fee policy. Missing access/data produces a named unavailable state. No Node vm/host import fallback for generated code. No model-authored unrestricted Solidity. One approved fixed hook only.

Use the phase's listed file ownership; treat new names as intended targets, verify the actual repository seams. Existing shared schemas/RPCs must be updated across server, web, desktop and client-runtime; mobile only as needed to avoid broken shared compilation. Add focused tests and targeted package checks. For user-visible changes follow test-t3-app using one retained isolated stack/browser for the entire campaign, owned by the designated tester. Do not test development by asking the application to modify this repository.

Write progress/evidence under /tmp/t3-forge-20260909/U2/ with exact checkout, tested SHA, commands/cwds/exits, actual receipts, redacted screenshots and open failures. Record 'implemented', 'automated verified', 'real-data verified' and 'human accepted' separately. Never mark a phase accepted yourself. When checks pass, commit only the phase implementation and durable behavior docs (not temporary evidence). Return the concrete human verification steps and wait for the human's actual pass/fail before beginning any dependent phase. If the gate fails, repair this phase and repeat its relevant checks. An elapsed timeout is not approval.

Review boundary: this plan was corrected through static code/image inspection without starting a server. That does not satisfy future implementation browser gates. Do not start any server if the user still prohibits runtime work when executing this prompt; complete independent work and explicitly leave browser acceptance pending.

U2 — Verify unification after revision and close the demo
Sequence: after U1 and actual F5 v2/evidence outputs; part of F6 or post-main-pack catch-up. Progress: /tmp/t3-forge-20260909/U2/.

Owned files: focused repairs to the U1 slice and its tests; no new feature families. Read original acceptance and the full preservation/state matrices. Reuse actual main-pack source/contract/artifact outputs; do not blindly rerun deployments or consume another grant.

Verify identical real source window for v1/v2, true exclusion diagnostics with actual transaction links, immutable version history, and return-to-Live using a fresh current read. Confirm selected historical evidence cannot create a policy intent. Confirm installed/confirmed version mismatch during submitted or failed tx, actual swap LP/total fee attribution, snapshot as-of/expiry wording and no fake fee update. Two real fee outcomes are still a backend/demo gate, not something UI can manufacture.

Run focused regression checks for refresh key, source switching, late results, stale display, single chart ownership, no-HL-focus entry, per-thread focus/state restoration and study publication/clear/auto-fit. Cover all UI states: disconnected, loading, empty, real success, failed tests, awaiting data, historical, stale, no signer/provider/Docker, reverted/unknown tx, local/on-chain paused/revoked. Use isolated fault injection for errors only; success uses actual source and chain receipts.

Future integrated acceptance follows test-t3-app with exactly one retained isolated stack/browser, only when authorized. Inspect 1920x1080 and 1440x900 plus 1024px with project sidebar/right panel/terminal both open and closed; width is measured within content. Verify keyboard navigation/drawer escape-return focus/evidence alternatives and reduced motion; retain draft, send/stop/approval controls and last timeline message. Confirm current HL positions/working orders remain discoverable with source or account errors, controls work without provider, and ordinary coding/Trade home/completed-mission review are not relaid out by global styles.

Expected result:
The legacy real-data graph and newly generated pool capability coexist in a single usable thread workspace with correct source/view identity, stable state and complete evidence. Passing static/component checks is separate from passing the actual user experience.

Human verification, then stop:
George repeats the legacy screenshot flow and the two-request Forge demo. Identify source network, view/time domain, installed version, confirmed policy, data age and actual receipt without narration. Switch source and environment, open a scene, inspect a qualifying/excluded swap, stop the provider and still pause policy. Approve the full unification only after runtime evidence exists; if no-server instruction still applies, leave this human runtime gate pending. Reverify final F7 demo after any late UI fix, without fabricating fresh pool creation or generation.
