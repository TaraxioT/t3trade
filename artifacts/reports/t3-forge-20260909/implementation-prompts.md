# T3 Forge: build the missing capability — execution prompts

Authoritative plan: implementation-plan.html

## F0 — Prove feasibility and freeze the demo contract

You are implementing T3 Forge for ETHOnline in /Users/george/Workspace/t3trade. This is a hackathon build scoped to September 9–11, 2026. Read AGENTS.md and the authoritative artifacts/reports/t3-forge-20260909/implementation-plan.html, plus the independent unified-graph-ui-plan.html. The user's current Forge direction supersedes the older continuity/fork-rehearsal, broad-polish, no-Uniswap and obsolete Luna-development mandates only where explicitly stated. Do not execute those old campaigns.

Use GPT/GLM for development and direct focused checks; the in-app provider is used only to exercise the product's real agent capability. Read .repos/effect-smol/LLMS.md before Effect-heavy changes. Current upstream-merge work is unrelated: preserve it, avoid compatibility archaeology, stage only your intended paths. No PR, push, production deployment or mainnet signing. Public mainnet reads are allowed; only the configured Uniswap public testnet may be written. Do not repurpose Hyperliquid signers or weaken any existing trading guard.

All product numbers and transaction evidence must be real. Fixtures belong only to automated tests. Authentic historical windows are explicitly historical and cannot drive live fee policy. Missing access/data produces a named unavailable state. No Node vm/host import fallback for generated code. No model-authored unrestricted Solidity. One approved fixed hook only.

Use the phase's listed file ownership; treat new names as intended targets, verify the actual repository seams. Existing shared schemas/RPCs must be updated across server, web, desktop and client-runtime; mobile only as needed to avoid broken shared compilation. Add focused tests and targeted package checks. For user-visible changes follow test-t3-app using one retained isolated stack/browser for the entire campaign, owned by the designated tester. Do not test development by asking the application to modify this repository.

Write progress/evidence under /tmp/t3-forge-20260909/F0/ with exact checkout, tested SHA, commands/cwds/exits, actual receipts, redacted screenshots and open failures. Record 'implemented', 'automated verified', 'real-data verified' and 'human accepted' separately. Never mark a phase accepted yourself. When checks pass, commit only the phase implementation and durable behavior docs (not temporary evidence). Return the concrete human verification steps and wait for the human's actual pass/fail before beginning any dependent phase. If the gate fails, repair this phase and repeat its relevant checks. An elapsed timeout is not approval.

F0 — Prove feasibility and freeze the demo contract
Schedule: Sep 9, 09:00–10:30
Owned files/scope: No product changes required. Own only a redacted local feasibility record; if setup config is needed, use new Forge-specific files and no secrets.

Inspect the existing catalog/chart/transport seams and the prior continuity plan. Confirm no target detector is already installed; capture an empty catalog/installation result. Obtain a real authenticated Graph response from a current supported Uniswap v3 deployment, introspect the actual schema, verify three WETH/USDC pool/token identities and swap ordering fields, retain query/meta/source digest. Check two indexed heads to measure progress/lag; pin one block across all pool samples. Verify an anchor/window query is possible; query errors must not be ignored.
Read current official Uniswap docs via Context7 (or official sources if unavailable); pin contracts/compiler/SDK versions and the Ethereum Sepolia chain/PoolManager/periphery addresses. Read chain ID and code, verify test token balances and native gas balance without printing secrets. Choose the exact owner/operator addresses, token deposit caps, per-swap max, aggregate gas budget and grant expiry; ask the human to approve these concrete values at this phase gate before future signing. This planning prompt alone contains no usable monetary grant.
Verify Docker is usable on the actual demo machine; build/pin a trusted runner image and execute a tiny contained typed function with network/filesystem probes. Select one supported already-configured in-app provider and measure a small artifact-producing turn in a disposable fixture, not this checkout. Agree the UI direction in U0. Record actual endpoint identifiers, schema differences, three pool IDs, thresholds/window/freshness settings, testnet config and remaining blockers. Freeze defaults rather than proliferating options. Do not deploy a pool yet.
If Graph access/pinning or sandbox is not working by 10:30, mark the core path blocked and continue only independent typed contracts/tests or fixed-hook preparation; do not substitute fake data or claim the three-day promise is secured.

Required automated/live evidence:
Real query + meta + hash and one transaction link; deployed code/chain reads; contained runner exit codes; provider availability proof; no values from .env or keys in evidence.

Expected result:
A runnable dependency checklist with real Graph evidence, verified testnet targets, approved spend limits and the primary instrument layout. No feature or deployment is falsely marked complete.

Human verification — perform after this phase, then stop:
George opens one captured Graph swap in an explorer and compares pool/token identities; checks block timestamp/lag; sees a sandbox isolation result; confirms the detector is absent. Review actual testnet chain/token/owner/operator/spend limits and explicitly accept or amend them. Inspect U0 layout. Record F0 PASS with the concrete parameters, or list blockers. Later signing remains disabled without this grant.

---

## F1 — Build the real Graph source and narrow Forge contracts

You are implementing T3 Forge for ETHOnline in /Users/george/Workspace/t3trade. This is a hackathon build scoped to September 9–11, 2026. Read AGENTS.md and the authoritative artifacts/reports/t3-forge-20260909/implementation-plan.html, plus the independent unified-graph-ui-plan.html. The user's current Forge direction supersedes the older continuity/fork-rehearsal, broad-polish, no-Uniswap and obsolete Luna-development mandates only where explicitly stated. Do not execute those old campaigns.

Use GPT/GLM for development and direct focused checks; the in-app provider is used only to exercise the product's real agent capability. Read .repos/effect-smol/LLMS.md before Effect-heavy changes. Current upstream-merge work is unrelated: preserve it, avoid compatibility archaeology, stage only your intended paths. No PR, push, production deployment or mainnet signing. Public mainnet reads are allowed; only the configured Uniswap public testnet may be written. Do not repurpose Hyperliquid signers or weaken any existing trading guard.

All product numbers and transaction evidence must be real. Fixtures belong only to automated tests. Authentic historical windows are explicitly historical and cannot drive live fee policy. Missing access/data produces a named unavailable state. No Node vm/host import fallback for generated code. No model-authored unrestricted Solidity. One approved fixed hook only.

Use the phase's listed file ownership; treat new names as intended targets, verify the actual repository seams. Existing shared schemas/RPCs must be updated across server, web, desktop and client-runtime; mobile only as needed to avoid broken shared compilation. Add focused tests and targeted package checks. For user-visible changes follow test-t3-app using one retained isolated stack/browser for the entire campaign, owned by the designated tester. Do not test development by asking the application to modify this repository.

Write progress/evidence under /tmp/t3-forge-20260909/F1/ with exact checkout, tested SHA, commands/cwds/exits, actual receipts, redacted screenshots and open failures. Record 'implemented', 'automated verified', 'real-data verified' and 'human accepted' separately. Never mark a phase accepted yourself. When checks pass, commit only the phase implementation and durable behavior docs (not temporary evidence). Return the concrete human verification steps and wait for the human's actual pass/fail before beginning any dependent phase. If the gate fails, repair this phase and repeat its relevant checks. An elapsed timeout is not approval.

F1 — Build the real Graph source and narrow Forge contracts
Schedule: Sep 9, 10:30–14:00
Owned files/scope: packages/trading-contracts/src/forge.ts + exports/tests; new apps/server/src/trading/forge/GraphSource.ts and tests; application owner alone handles package manifests/migrations and Forge transport registrations.

Implement the pinned-block adapter and exact token normalization from the plan. Host selects endpoint/credentials/three approved pools; validated query artifact defines allowed source operations. Do not use Hyperliquid data as Graph input. Implement bounded cursor pagination, deduplication, anchor coverage, exact quote micros, source block/hash/digest, and explicit complete/empty/stale/unavailable states. Keep credentials out of URLs and tool output.
Introduce runtime-validated Forge source/evaluation/job/policy schemas, with environment/thread identity and separate observation/execution chain labels. Keep TradingVenue hyperliquid-only. Add the small persistent evidence/observation boundary using existing migration conventions; raw evidence is accessed by ID through authenticated transport, not stuffed into every event. Ensure source-only reads do not call Hyperliquid or require a signer.
Read a current window and retain one authentic bounded historical window that is useful for the eventual v1/v2 comparison. Label it historical and store its original block/time. Do not author or install the finished detector in this phase. Host normalization utilities are allowed; semantic detector logic must be produced at runtime.

Required automated/live evidence:
Focused GraphSource/schema tests for pagination, decimals/inversion, ordering, duplicate logs, empty/partial/errors, lag and reorg; targeted trading-contracts/server checks; actual authenticated query read-back. Gate includes real proof, not unit fixtures alone.

Expected result:
Three real, normalized pool inputs with proof of source and freshness; a working signer-free source-read path. The finished detector is still absent.

Human verification — perform after this phase, then stop:
George inspects all three pool identities, selects a raw swap and checks its quote-volume normalization, verifies one pinned source block across pages, then temporarily removes Graph access using the isolated test configuration. The result must become unavailable, not zero or a fixture. Restore access and verify current data recovers. Confirm detector catalog is still empty.

---

## F2 — Make the agent build, test and install a capability

You are implementing T3 Forge for ETHOnline in /Users/george/Workspace/t3trade. This is a hackathon build scoped to September 9–11, 2026. Read AGENTS.md and the authoritative artifacts/reports/t3-forge-20260909/implementation-plan.html, plus the independent unified-graph-ui-plan.html. The user's current Forge direction supersedes the older continuity/fork-rehearsal, broad-polish, no-Uniswap and obsolete Luna-development mandates only where explicitly stated. Do not execute those old campaigns.

Use GPT/GLM for development and direct focused checks; the in-app provider is used only to exercise the product's real agent capability. Read .repos/effect-smol/LLMS.md before Effect-heavy changes. Current upstream-merge work is unrelated: preserve it, avoid compatibility archaeology, stage only your intended paths. No PR, push, production deployment or mainnet signing. Public mainnet reads are allowed; only the configured Uniswap public testnet may be written. Do not repurpose Hyperliquid signers or weaken any existing trading guard.

All product numbers and transaction evidence must be real. Fixtures belong only to automated tests. Authentic historical windows are explicitly historical and cannot drive live fee policy. Missing access/data produces a named unavailable state. No Node vm/host import fallback for generated code. No model-authored unrestricted Solidity. One approved fixed hook only.

Use the phase's listed file ownership; treat new names as intended targets, verify the actual repository seams. Existing shared schemas/RPCs must be updated across server, web, desktop and client-runtime; mobile only as needed to avoid broken shared compilation. Add focused tests and targeted package checks. For user-visible changes follow test-t3-app using one retained isolated stack/browser for the entire campaign, owned by the designated tester. Do not test development by asking the application to modify this repository.

Write progress/evidence under /tmp/t3-forge-20260909/F2/ with exact checkout, tested SHA, commands/cwds/exits, actual receipts, redacted screenshots and open failures. Record 'implemented', 'automated verified', 'real-data verified' and 'human accepted' separately. Never mark a phase accepted yourself. When checks pass, commit only the phase implementation and durable behavior docs (not temporary evidence). Return the concrete human verification steps and wait for the human's actual pass/fail before beginning any dependent phase. If the gate fails, repair this phase and repeat its relevant checks. An elapsed timeout is not approval.

F2 — Make the agent build, test and install a capability
Schedule: Sep 9, 14:30–20:00
Owned files/scope: New forge CapabilityBuilder/CapabilitySandbox/CapabilityStore/ForgeReactor modules/tests; observation.ts and trading MCP tools/handlers; provider TradingSessionProfile; current runtime/persistence/transport seams.

Implement the generic four-artifact builder and sealed installation transaction. Reuse the supported product provider to write actual artifacts into a separate workspace. Give it the SDK, actual data schema, user's requested semantics and source inspection tools; do not give it a hidden completed detector or add a built-in eth-coordination branch. The human demo request is included in the plan's demo section.
Create trusted runner/container configuration as specified. Compile/typecheck, run generated tests, then independent host-owned acceptance cases and determinism checks. Validate exact tested bytes and artifact paths, input/output limits, schema version and installation CAS. The host computes the sealed report and hashes; printing a pass string is insufficient.
Add trading_forge bounded lifecycle commands and dynamic trading_look discovery/latest/history reads. Run first evaluation via persisted reactor job; update the catalog only after commit. Register tool permissions/policies and wire schema/client consumers. Separate provider job status from observed data status. Cancel/pause/resume/uninstall are direct user-service operations; no provider dependency. History survives restart, scope is environment/thread/capability. No on-chain action yet.
Execute the first real in-app natural-language request with no installed detector. Capture source inspection, file diff, actual tests and installed catalog output. No final chart polish is required yet; a plain truthful build receipt may expose this slice, with integrated browser verification if user-visible.

Required automated/live evidence:
Sandbox escape/timeout/output-limit/path tests; install CAS/hash tamper/restart/dedup tests; parser/menu size and provider policy tests; independent detector aggregation/classification cases; live provider + current Graph execution; package checks.

Expected result:
An actual provider-generated v1 exists only after the request; four files, test receipt, immutable manifest, installation event and a real current reading are inspectable. A second process restart still discovers it.

Human verification — perform after this phase, then stop:
George starts from the recorded empty installation, asks for the detector, watches receipt-backed stages and opens query/code/tests/manifest. Ask trading_look for its new catalog entry and current result. Cancel another build, force a failing test, and confirm neither becomes installed. Restart the isolated server and verify v1 remains. Pass only if this is real code execution, not model prose.

---

## F3 — Deploy the fixed hook and a usable public-testnet pool

You are implementing T3 Forge for ETHOnline in /Users/george/Workspace/t3trade. This is a hackathon build scoped to September 9–11, 2026. Read AGENTS.md and the authoritative artifacts/reports/t3-forge-20260909/implementation-plan.html, plus the independent unified-graph-ui-plan.html. The user's current Forge direction supersedes the older continuity/fork-rehearsal, broad-polish, no-Uniswap and obsolete Luna-development mandates only where explicitly stated. Do not execute those old campaigns.

Use GPT/GLM for development and direct focused checks; the in-app provider is used only to exercise the product's real agent capability. Read .repos/effect-smol/LLMS.md before Effect-heavy changes. Current upstream-merge work is unrelated: preserve it, avoid compatibility archaeology, stage only your intended paths. No PR, push, production deployment or mainnet signing. Public mainnet reads are allowed; only the configured Uniswap public testnet may be written. Do not repurpose Hyperliquid signers or weaken any existing trading guard.

All product numbers and transaction evidence must be real. Fixtures belong only to automated tests. Authentic historical windows are explicitly historical and cannot drive live fee policy. Missing access/data produces a named unavailable state. No Node vm/host import fallback for generated code. No model-authored unrestricted Solidity. One approved fixed hook only.

Use the phase's listed file ownership; treat new names as intended targets, verify the actual repository seams. Existing shared schemas/RPCs must be updated across server, web, desktop and client-runtime; mobile only as needed to avoid broken shared compilation. Add focused tests and targeted package checks. For user-visible changes follow test-t3-app using one retained isolated stack/browser for the entire campaign, owned by the designated tester. Do not test development by asking the application to modify this repository.

Write progress/evidence under /tmp/t3-forge-20260909/F3/ with exact checkout, tested SHA, commands/cwds/exits, actual receipts, redacted screenshots and open failures. Record 'implemented', 'automated verified', 'real-data verified' and 'human accepted' separately. Never mark a phase accepted yourself. When checks pass, commit only the phase implementation and durable behavior docs (not temporary evidence). Return the concrete human verification steps and wait for the human's actual pass/fail before beginning any dependent phase. If the gate fails, repair this phase and repeat its relevant checks. An elapsed timeout is not approval.

F3 — Deploy the fixed hook and a usable public-testnet pool
Schedule: Sep 10, 09:00–13:30; static contract/tests may prepare after F0
Owned files/scope: contracts/forge fixed Foundry project; apps/server/src/trading/forge/UniswapTestnetAdapter and FeePolicyService with tests; application owner handles shared config/contract integration.

Read the approved F0 grant before any signing. If missing concrete grant values, prepare complete unsigned intents and request that missing approval; do not invent budget or reuse HL authority. Implement and test the one fixed hook from the plan against pinned dependencies. Get exact beforeSwap address bits via CREATE2; never override validation. Fixed fees are 500/3000, baseline 3000; expiry/owner pause/operator revoke work without the agent.
Implement target-bound signing and durable intent/broadcast/receipt reconciliation. Establish one real Ethereum Sepolia v4 pool with verified test tokens, decimal-correct price/tick spacing, nonzero in-range liquidity and a retained LP position ID. Use supported official periphery/router operations and exact approvals. Initialize + bind + fund + authorize operator + resume in the required sequence; label incomplete steps honestly.
Use fresh installed-v1 evidence to publish a policy with source-derived expiry, confirm PolicyPublished and read back hook state. Execute one size-bounded real testnet swap and decode actual PoolManager Swap fee, preserving LP-vs-protocol fee distinction. No local fork/Anvil results count as this acceptance. A technical eth_call can preflight but is never called a mined swap.
Provide direct pause, revoke and withdraw/remove-liquidity controls or operator commands with typed receipts, usable with provider stopped. Stop new intents on local pause; show pending chain confirmation separately. Retain evidence for cleanup. Do not implement a general liquidity platform.

Required automated/live evidence:
Focused Foundry unit/fuzz tests on authorization, flags, pool binding, sequencing, expiry/pause/revoke; adapter idempotency/uncertain-broadcast tests; actual public-testnet receipts and state read-back; confirmed spend within F0 grant.

Expected result:
One real initialized and funded v4 pool with a fixed tested hook, confirmed policy and mined swap. Explorer links and exact fees are available. No claim yet that both regimes or v2 have passed.

Human verification — perform after this phase, then stop:
George verifies Sepolia and the approved token amounts, opens pool initialization/liquidity/policy/swap transaction receipts, compares fee units to displayed percentages, then pauses and confirms baseline behavior with a permitted real swap if budget permits. Resume needs fresh publication. Check that revoke and removal are available without the agent; F6 exercises full cleanup on a disposable position. Pass requires nonzero usable liquidity and actual swap evidence.

---

## F4 — Put Forge inside the premium unified graph

You are implementing T3 Forge for ETHOnline in /Users/george/Workspace/t3trade. This is a hackathon build scoped to September 9–11, 2026. Read AGENTS.md and the authoritative artifacts/reports/t3-forge-20260909/implementation-plan.html, plus the independent unified-graph-ui-plan.html. The user's current Forge direction supersedes the older continuity/fork-rehearsal, broad-polish, no-Uniswap and obsolete Luna-development mandates only where explicitly stated. Do not execute those old campaigns.

Use GPT/GLM for development and direct focused checks; the in-app provider is used only to exercise the product's real agent capability. Read .repos/effect-smol/LLMS.md before Effect-heavy changes. Current upstream-merge work is unrelated: preserve it, avoid compatibility archaeology, stage only your intended paths. No PR, push, production deployment or mainnet signing. Public mainnet reads are allowed; only the configured Uniswap public testnet may be written. Do not repurpose Hyperliquid signers or weaken any existing trading guard.

All product numbers and transaction evidence must be real. Fixtures belong only to automated tests. Authentic historical windows are explicitly historical and cannot drive live fee policy. Missing access/data produces a named unavailable state. No Node vm/host import fallback for generated code. No model-authored unrestricted Solidity. One approved fixed hook only.

Use the phase's listed file ownership; treat new names as intended targets, verify the actual repository seams. Existing shared schemas/RPCs must be updated across server, web, desktop and client-runtime; mobile only as needed to avoid broken shared compilation. Add focused tests and targeted package checks. For user-visible changes follow test-t3-app using one retained isolated stack/browser for the entire campaign, owned by the designated tester. Do not test development by asking the application to modify this repository.

Write progress/evidence under /tmp/t3-forge-20260909/F4/ with exact checkout, tested SHA, commands/cwds/exits, actual receipts, redacted screenshots and open failures. Record 'implemented', 'automated verified', 'real-data verified' and 'human accepted' separately. Never mark a phase accepted yourself. When checks pass, commit only the phase implementation and durable behavior docs (not temporary evidence). Return the concrete human verification steps and wait for the human's actual pass/fail before beginning any dependent phase. If the gate fails, repair this phase and repeat its relevant checks. An elapsed timeout is not approval.

F4 — Put Forge inside the premium unified graph
Schedule: Sep 10, 14:00–19:00
Owned files/scope: MarketChartPanel/MissionPriceChart/ThreadMarketCard/ThreadMarketPanel and bounded ChatView integration; new ForgeSignalLane/ForgeBuildReceipt/ForgePoolInspector/ForgeVersionDiff; web state + trading.css. Execute UI plan U1 here.

Use the independent UI plan as the visual acceptance contract. Make the graph the dominant instrument and conversation the adjacent command surface within the existing thread; do not add /continuity or a new dashboard. One market/source header, one time axis, one detector lane, one compact pool inspector. Keep app navigation and environment selection recognizable. Positions/close controls remain visible when real exposure exists.
Display real three-pool normalized price traces/quote volume with their source identity; label any optional HL context separately. Do not use HL candles as Uniswap data. Build progress reflects actual source/test/install events; generated source lives in an inspectable drawer. Installed signal automatically attaches after a first valid observation; show awaiting data when none exists. Never render fabricated samples while loading.
Separate installed revision / proposed policy / confirmed policy / effective fee, with historical/live status and last indexed time. Marker clicks open the exact evidence/receipt and select the same window in conversation. Keep Range and Bars coherent; do not reset zoom on every update. Move legacy Calendar/Event aligned behind Research view menu without changing their semantics.
Wire loading, no capability, building, test failed, awaiting data, live, stale, historical, unsigned, pending, confirmed, reverted, paused and revoked states. Use existing semantic tokens; no new chart dependency or permanent animation. Direct user actions use typed services. Cover responsive desktop/projector layouts and keyboard access.

Required automated/live evidence:
Focused component/state tests and affected chart/scene/environment regressions; targeted web/client-runtime checks; test-t3-app integrated real-source pass for applicable states; screenshots and actual click results, not a mock-only review.

Expected result:
The user sees the capability being created and then running in the chart they were already using. The pool attachment and current fee are understood without reading source code or scrolling through a transcript.

Human verification — perform after this phase, then stop:
George performs U1: first request → real build stages → lane appears → select pool source evidence → open module revision → inspect pool receipt. At 1440×900 and 1920×1080, chart/composer remain visible and stable. At 1024px, disclosure adapts without horizontal page scrolling. Switch environment and verify no old signal/pool leaks. Stop Graph and confirm an honest stale/unavailable state; restore it. Confirm an active HL position would keep its direct controls.

---

## F5 — Revise the detector and prove its live pool policy

You are implementing T3 Forge for ETHOnline in /Users/george/Workspace/t3trade. This is a hackathon build scoped to September 9–11, 2026. Read AGENTS.md and the authoritative artifacts/reports/t3-forge-20260909/implementation-plan.html, plus the independent unified-graph-ui-plan.html. The user's current Forge direction supersedes the older continuity/fork-rehearsal, broad-polish, no-Uniswap and obsolete Luna-development mandates only where explicitly stated. Do not execute those old campaigns.

Use GPT/GLM for development and direct focused checks; the in-app provider is used only to exercise the product's real agent capability. Read .repos/effect-smol/LLMS.md before Effect-heavy changes. Current upstream-merge work is unrelated: preserve it, avoid compatibility archaeology, stage only your intended paths. No PR, push, production deployment or mainnet signing. Public mainnet reads are allowed; only the configured Uniswap public testnet may be written. Do not repurpose Hyperliquid signers or weaken any existing trading guard.

All product numbers and transaction evidence must be real. Fixtures belong only to automated tests. Authentic historical windows are explicitly historical and cannot drive live fee policy. Missing access/data produces a named unavailable state. No Node vm/host import fallback for generated code. No model-authored unrestricted Solidity. One approved fixed hook only.

Use the phase's listed file ownership; treat new names as intended targets, verify the actual repository seams. Existing shared schemas/RPCs must be updated across server, web, desktop and client-runtime; mobile only as needed to avoid broken shared compilation. Add focused tests and targeted package checks. For user-visible changes follow test-t3-app using one retained isolated stack/browser for the entire campaign, owned by the designated tester. Do not test development by asking the application to modify this repository.

Write progress/evidence under /tmp/t3-forge-20260909/F5/ with exact checkout, tested SHA, commands/cwds/exits, actual receipts, redacted screenshots and open failures. Record 'implemented', 'automated verified', 'real-data verified' and 'human accepted' separately. Never mark a phase accepted yourself. When checks pass, commit only the phase implementation and durable behavior docs (not temporary evidence). Return the concrete human verification steps and wait for the human's actual pass/fail before beginning any dependent phase. If the gate fails, repair this phase and repeat its relevant checks. An elapsed timeout is not approval.

F5 — Revise the detector and prove its live pool policy
Schedule: Sep 11, 09:00–12:30
Owned files/scope: Forge revision/policy orchestration and focused tests; ForgeVersionDiff/lane/receipt presentation where needed. No new strategy families or hook code generation.

Use the second user request: ignore agreement caused by tiny trades; require meaningful volume. The real provider must modify the installed detector's filtering/aggregation source and tests, keeping v1 immutable. Have it inspect real volumes and explain proposed per-trade and per-pool floors; defaults are in the plan and any change is manifest-visible. Do not just set a hidden backend flag or change a fee badge.
Run generated + independent acceptance tests and compare v1/v2 on the same authentic pinned historical window. Show exactly which trades/pools are excluded and whether classification changes; display historical provenance. Publish/install v2 via expected-v1 CAS; confirm source/module hash difference. A failed revision leaves v1 live.
Evaluate v2 on a fresh current Graph window, gate it by source freshness and the active authority, and publish a monotonic on-chain policy revision with v2 module/observation hashes. Render v2-installed/v1-confirmed transition honestly. Confirm the policy tx, execute a bounded real subsequent swap and attribute its actual fee to chain-ordered policy/expiry. Demonstrate both numerical fee settings with authentic fresh observations and real swaps within grant. If market activity does not produce a difference, record that fact and leave the two-fee proof open; never relabel historical observations live.
Test stale v1 work finishing after v2, duplicate job receipts, two concurrent revision attempts, failed chain publish, expiry-before-swap and pause during queued update. Rollback is a new version referencing an old bundle, not overwritten history.

Required automated/live evidence:
Revision immutability/hash/CAS/race tests; tiny-trade and cumulative-floor boundary cases; live-vs-history policy guard; real provider revision; pinned real comparison; confirmed v2 policy + swap receipts and two-fee evidence or precise blocker.

Expected result:
v2 is a new executable capability version; comparison explains its changed result on actual data. Live policy points to its hash and a mined swap proves execution. Full two-fee proof is explicit pass or explicit open item.

Human verification — perform after this phase, then stop:
George makes the second request in the same conversation, sees code/test diff, checks one excluded tiny trade against its actual source and compares v1/v2 over the identical historical window. Return to Live, confirm current data, open the v2 PolicyPublished receipt and a later Swap receipt, and compare displayed fee with chain evidence. Confirm two different real fee outcomes; if absent, do not pass that criterion. Reject a deliberately failing revision and verify the installed version remains usable.

---

## F6 — Close failure paths and preserve the surrounding product

You are implementing T3 Forge for ETHOnline in /Users/george/Workspace/t3trade. This is a hackathon build scoped to September 9–11, 2026. Read AGENTS.md and the authoritative artifacts/reports/t3-forge-20260909/implementation-plan.html, plus the independent unified-graph-ui-plan.html. The user's current Forge direction supersedes the older continuity/fork-rehearsal, broad-polish, no-Uniswap and obsolete Luna-development mandates only where explicitly stated. Do not execute those old campaigns.

Use GPT/GLM for development and direct focused checks; the in-app provider is used only to exercise the product's real agent capability. Read .repos/effect-smol/LLMS.md before Effect-heavy changes. Current upstream-merge work is unrelated: preserve it, avoid compatibility archaeology, stage only your intended paths. No PR, push, production deployment or mainnet signing. Public mainnet reads are allowed; only the configured Uniswap public testnet may be written. Do not repurpose Hyperliquid signers or weaken any existing trading guard.

All product numbers and transaction evidence must be real. Fixtures belong only to automated tests. Authentic historical windows are explicitly historical and cannot drive live fee policy. Missing access/data produces a named unavailable state. No Node vm/host import fallback for generated code. No model-authored unrestricted Solidity. One approved fixed hook only.

Use the phase's listed file ownership; treat new names as intended targets, verify the actual repository seams. Existing shared schemas/RPCs must be updated across server, web, desktop and client-runtime; mobile only as needed to avoid broken shared compilation. Add focused tests and targeted package checks. For user-visible changes follow test-t3-app using one retained isolated stack/browser for the entire campaign, owned by the designated tester. Do not test development by asking the application to modify this repository.

Write progress/evidence under /tmp/t3-forge-20260909/F6/ with exact checkout, tested SHA, commands/cwds/exits, actual receipts, redacted screenshots and open failures. Record 'implemented', 'automated verified', 'real-data verified' and 'human accepted' separately. Never mark a phase accepted yourself. When checks pass, commit only the phase implementation and durable behavior docs (not temporary evidence). Return the concrete human verification steps and wait for the human's actual pass/fail before beginning any dependent phase. If the gate fails, repair this phase and repeat its relevant checks. An elapsed timeout is not approval.

F6 — Close failure paths and preserve the surrounding product
Schedule: Sep 11, 13:00–16:30
Owned files/scope: Focused repairs only in the changed Forge boundaries and affected existing chart/environment controls. Execute UI U2. docs/user concise Forge usage; rewrite contradictory trading-final-form scope during implementation.

Run one retained-stack integrated pass at the exact changed commit, never a different clean worktree. Verify fresh/historical/unavailable Graph states, provider missing, Docker down, no signer, wrong chain, insufficient gas, RPC timeout, transaction revert and unresolved receipt. Fault injection belongs to the isolated verification configuration; final runtime has no fixture default or simulation mode.
Restart while a build or tx is pending; reconcile persisted work once and expose uncertainty until confirmed. Reload/reconnect and environment switch; test direct pause/revoke/uninstall/rollback and remove liquidity on a disposable real testnet position within grant. Leave the final demo pool only in a state the human explicitly accepts; no unintended ongoing writes. Confirm host/source expiry yields baseline even if the model and worker are stopped.
Review that Graph signer-free reads work with HL offline, existing HL protection/authority code was not repurposed, active positions retain direct close/reduce access, legacy research views still report their own sources and paper labels, desktop wrapper accepts new schemas and no relay changes were introduced. Run affected existing focused tests; do not begin a broad readiness audit.
Document only shipped user behavior and the cross-boundary off-chain-trust/network distinction maintainers could misunderstand. Remove/update the old blanket no-Uniswap scope in its existing paragraph. Record final limits honestly: centralized operator, limited signal family, testnet only, actual measured indexing latency. Complete U2 visual/accessibility verification.

Required automated/live evidence:
Exact SHA + command/cwd/exit matrix, small changed-package tests/typechecks, Foundry regression after contract edits, real browser state checks, public-testnet reverse-action receipts, no secrets/synthetic sources in app config. Independent code/safety review may be delegated read-only on this exact diff.

Expected result:
Every required real-data/real-chain path and applicable failure/reverse action is evidenced. No fixture or simulation drives the final experience. Legacy features remain reachable and accurately labeled.

Human verification — perform after this phase, then stop:
George repeats the entire two-request flow, disconnects the provider and still pauses/revokes, sees expiry baseline, reloads version/history, switches environments and opens legacy research. Verify liquidity removal with actual balances/receipt on the test position and retain the intended demo pool. Review every incomplete item; human marks F6 PASS only when core live evidence and U2 checks pass.

---

## F7 — Freeze and rehearse the actual demonstration

You are implementing T3 Forge for ETHOnline in /Users/george/Workspace/t3trade. This is a hackathon build scoped to September 9–11, 2026. Read AGENTS.md and the authoritative artifacts/reports/t3-forge-20260909/implementation-plan.html, plus the independent unified-graph-ui-plan.html. The user's current Forge direction supersedes the older continuity/fork-rehearsal, broad-polish, no-Uniswap and obsolete Luna-development mandates only where explicitly stated. Do not execute those old campaigns.

Use GPT/GLM for development and direct focused checks; the in-app provider is used only to exercise the product's real agent capability. Read .repos/effect-smol/LLMS.md before Effect-heavy changes. Current upstream-merge work is unrelated: preserve it, avoid compatibility archaeology, stage only your intended paths. No PR, push, production deployment or mainnet signing. Public mainnet reads are allowed; only the configured Uniswap public testnet may be written. Do not repurpose Hyperliquid signers or weaken any existing trading guard.

All product numbers and transaction evidence must be real. Fixtures belong only to automated tests. Authentic historical windows are explicitly historical and cannot drive live fee policy. Missing access/data produces a named unavailable state. No Node vm/host import fallback for generated code. No model-authored unrestricted Solidity. One approved fixed hook only.

Use the phase's listed file ownership; treat new names as intended targets, verify the actual repository seams. Existing shared schemas/RPCs must be updated across server, web, desktop and client-runtime; mobile only as needed to avoid broken shared compilation. Add focused tests and targeted package checks. For user-visible changes follow test-t3-app using one retained isolated stack/browser for the entire campaign, owned by the designated tester. Do not test development by asking the application to modify this repository.

Write progress/evidence under /tmp/t3-forge-20260909/F7/ with exact checkout, tested SHA, commands/cwds/exits, actual receipts, redacted screenshots and open failures. Record 'implemented', 'automated verified', 'real-data verified' and 'human accepted' separately. Never mark a phase accepted yourself. When checks pass, commit only the phase implementation and durable behavior docs (not temporary evidence). Return the concrete human verification steps and wait for the human's actual pass/fail before beginning any dependent phase. If the gate fails, repair this phase and repeat its relevant checks. An elapsed timeout is not approval.

F7 — Freeze and rehearse the actual demonstration
Schedule: Sep 11, 16:30–18:00
Owned files/scope: Demo script and redacted evidence under /tmp; only necessary shipped usage corrections in source. No new functionality.

Prepare one clean Forge capability namespace so the detector is absent before the take, retaining prior rehearsal evidence separately. Reuse funded testnet infrastructure and trusted runner image; generic hook/template may already exist, but the installed detector and its generated source must genuinely be created during the demonstration. For the requested create-pool story, record the real proposal/initialization/liquidity sequence after the first request; if latency requires a cut, label it. Do not imply an old pool was created just now.
Run the exact two user prompts, capture the real generation/test/install/chart/pool/revision sequence, record actual durations and all evidence IDs/transaction hashes. A four-minute edited video may cut waits with a visible time cut; keep an uncut evidence run. Do not fake progress stages or provider responses. Historical v1/v2 comparison is visibly historical; live fee policy is current.
Prepare a recovery script for provider/Graph/RPC outage: show the timestamped authentic prior recording and identify it as a recorded run. That can preserve the presentation but does not pass missing live requirements. If live generation takes minutes, say so and use the honest time cut. Freeze the code; list any open proof as incomplete, not polish.
Check current ETHOnline sponsor rules and required repository/video/feedback/submission format against official event pages before preparing entries. Prize eligibility is not established by this plan. Produce ready-to-submit assets by Sep 11; account submission and any public publication are separate human actions unless explicitly authorized. No September 12/13 implementation tasks.

Required automated/live evidence:
Uncut authentic run, edited take with disclosed cuts, exact prompt/click script, measured timings, sanitized bundle hashes and public tx links, final commit/evidence index, human F7 verdict and sponsor-rule checklist from current official pages.

Expected result:
A truthful, visually coherent demo backed by real artifacts and chain receipts, ready by September 11. Full success requires both fees and v2 provenance; a recording alone does not turn an unmet criterion green.

Human verification — perform after this phase, then stop:
George watches the four-minute take without narration assistance, identifies the new capability, source network, execution network, two revisions and actual fee change. Follow one full source → artifact hash → installation → policy → swap chain of evidence. Check detector absence at opening and real pool creation timing. Approve demo freeze or name a failed criterion. Do not submit or deploy merely because this phase is accepted.
