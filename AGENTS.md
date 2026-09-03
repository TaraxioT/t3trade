# T3 Trade

T3 Trade is an agentic trading environment built from T3 Code. It keeps the coding-agent workspace and adds supervised, budgeted trading on Hyperliquid testnet. Treat the trading system—not the upstream product—as the center of this repository.

## Priorities

1. Correctness: preserve declared behavior, validate boundaries, handle failures, and test non-trivial changes.
2. Clarity: prefer explicit, local code that another engineer can debug quickly.
3. Restraint: make the smallest complete change; avoid speculative abstractions and dependencies.

Trading safety outranks convenience. Never weaken an execution guard, loss budget, protection requirement, authority check, idempotency boundary, or reconciliation rule to make an agent or UI flow pass.

## Product boundaries

- Hyperliquid testnet is the only execution target. Do not introduce a mainnet path implicitly.
- The exchange is authoritative for positions, orders, and fills. Local state records T3 Trade's decisions and actions.
- Every confirmed exposure increase must have exchange-native protection. Failure paths must not leave a position silently unprotected.
- Signing is local and deterministic. Never log, expose, copy unnecessarily, or commit signer material.
- Research mode is a real product mode: market data, charts, alerts, backtests, validations, missions, and wakes must work without a signer. Only signing-dependent actions should refuse.
- User controls such as pause, cancel, reduce, close, and revoke must work without the agent provider running.
- The active product surfaces are web and desktop. Mobile is inherited upstream code, not a current fork development target. Do not add fork features or spend verification time there unless explicitly requested; avoid breaking shared contracts where practical.

## Architecture

Clients send typed WebSocket requests. The server converts requests into commands, a pure decider emits persisted events, and projectors build the read model. Queue-backed reactors perform side effects and emit typed receipts. Provider adapters translate Codex, Claude, Cursor, Grok, and OpenCode protocols at the boundary.

Trading follows the same rule: typed contracts and deterministic services own policy; the UI presents state and sends intent. Keep exchange calls and provider-specific complexity at adapters. Never move safety decisions into prompt prose or client state.

Key locations:

- `apps/server/src/trading` — trading services, execution, reconciliation, missions, watches, and archive runtime.
- `packages/trading-contracts` — shared trading types and pure policy/accounting logic.
- `apps/server` — orchestration, providers, persistence, and WebSocket server. Read `.repos/effect-smol/LLMS.md` before editing Effect-heavy code.
- `apps/web` — active React/Vite client. `apps/desktop` wraps it and adds Electron behavior.
- `packages/contracts` — wire contracts. A schema change must be handled by every active producer and consumer.
- `packages/client-runtime` — client logic shared across surfaces.
- `infra/relay` — hosted T3 Connect control plane.
- `.repos` — vendored, read-only references. Never edit or import from them.

Put durable architecture in `docs/internals`, operational procedures in `docs/operations`, and shipped behavior in `docs/user`. Do not commit plans, scratch notes, or PR-only evidence.

## Fork identity

T3 Trade may be installed beside upstream T3 Code. Shared names cause silent database and single-instance-lock collisions.

- Fork-owned paths and identifiers live in `packages/shared/src/forkPaths.ts`; import them instead of repeating literals.
- Preserve `~/.t3trade`, Electron `t3trade` / `t3trade-dev`, URL schemes, bundle identifiers, service names, desktop entries, askpass names, and WSL markers through upstream merges.
- `T3CODE_HOME` remains the application-state override used by inherited server and desktop paths.
- `T3TRADE_HOME` is the separate trading signer-base override. It resolves the interim key beneath `secrets`; it is not the general application-state override.
- An upstream sync that restores `t3code` names or paths is a regression unless explicitly approved.

## Relay and production infrastructure

The relay is T3 Connect's hosted control plane for account/environment linking, managed endpoint discovery, short-lived credentials, and relay diagnostics. Normal API and WebSocket traffic goes directly between the client and environment after connection; the relay is not the steady-state data path.

Repository code is not the complete source of truth for production infrastructure. Before diagnosing or changing relay behavior, inspect all three layers:

1. `infra/relay` for the Alchemy stack, Worker, contracts, migrations, and deployment code.
2. `ssh georges-instance` for the Postgres origin and `cloudflared` host state.
3. The Cloudflare API MCP and Wrangler for deployed Workers, custom domains, DNS, Access, tunnels, Hyperdrive, queues, and logs.

Current production shape, which must be re-verified rather than assumed:

- `relay.athelstan.xyz` is the relay Worker custom domain. The physical Worker name is generated by Alchemy and may change.
- `relaydb.athelstan.xyz` is protected by Cloudflare Access and reaches a Cloudflare Tunnel.
- `georges-instance` runs `cloudflared` and the `t3relay-postgres` container from `/opt/t3relay-db`; Postgres is bound to `127.0.0.1:5432`, not the public network.
- Hyperdrive reaches the runtime database through the protected tunnel. Runtime credentials must not gain schema-owner/DDL authority.

Start with read-only inspection. Use the Cloudflare API MCP to discover exact resources and current configuration; use Wrangler for supported Worker commands and logs. Never print `.env` files, tunnel tokens, service tokens, database passwords, signer keys, or Worker secrets. Do not deploy, migrate, rotate credentials, edit DNS/Access, restart services, or mutate production unless the user explicitly requests it.

Relay contract changes must stay aligned across `infra/relay`, `packages/contracts`, `packages/client-runtime`, and the server/client call sites. Read `docs/internals/environment-auth.md` before changing authentication or credential behavior and `docs/operations/relay-observability.md` before changing diagnostics.

APNs and mobile-notification code remains for upstream compatibility, not as an active fork feature target. Do not expand or verify it unless explicitly requested; keep required deployment configuration parseable.

## Development safety

Never kill by process-name or path pattern. Do not use `pkill -f`, `pgrep | kill`, or a PID found from a fuzzy match. Stop only a PID captured when you started it, or identify a port owner and confirm its working directory first. Vite and server children can outlive their runner.

Never allow two writers on one SQLite database.

- Installed app state: `~/.t3trade/userdata`.
- Main-checkout development state: `~/.t3trade/dev`.
- Worktree development state: `<worktree>/.t3/userdata`.
- An explicit `--home-dir` uses that directory's `userdata`; do not point it at live state casually.
- Before testing against or copying live state, create a consistent SQLite snapshot with `VACUUM INTO`. Never copy an active database file alone, never symlink test state, and never delete or reset shared state.

Use `vp i` to install and `vp run dev` to start server and web. Read actual ports, base directory, and pairing URL from the dev-runner output; ports can shift. Never set `VITE_HTTP_URL` or `VITE_WS_URL` for development because Vite provides the single-origin proxies.

For tailnet sharing, use `vp run dev --share` and hand the user the complete pairing URL including its one-time token. Do not assemble Tailscale routing manually or consume a pairing URL meant for someone else.

## ZCode subagent workflow

ZCode currently loads custom subagents from the user-level `~/.zcode/agents` directory.
This repository keeps the reviewed source templates in `.zcode/agents`, but those
workspace files are not themselves an installation. After changing a template, copy
it to `~/.zcode/agents` as a regular file, use the refresh button in Settings >
Subagents, and start a new ZCode task. ZCode's discovery does not follow symlinks.
ZCode Settings can then enable, disable, edit, or delete the installed copy. Custom
subagents inherit this workspace `AGENTS.md` and the current model by default. Use the
built-in `Explore` role for read-only codebase discovery; do not recreate or override
ZCode's reserved `general-purpose` or `Explore` names.

Install or refresh the complete T3 Trade profile set from the repository root:

```sh
mkdir -p ~/.zcode/agents
cp .zcode/agents/*.md ~/.zcode/agents/
```

The installed reusable profiles are:

| Profile                      | Use it for                                                                       | Boundary                                                                |
| ---------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `implementation-worker`      | One independently editable implementation slice                                  | One writer per file; no shared runtime unless explicitly assigned       |
| `focused-verifier`           | Focused tests, typechecks, lint, and acceptance checks                           | Independent and read-only; never repairs its own findings               |
| `change-reviewer`            | Diff review for correctness, regressions, and test gaps                          | Read-only; reports actionable findings with file and line evidence      |
| `documentation-researcher`   | Current official library, SDK, API, CLI, or cloud documentation                  | Read-only; separates sourced facts from inference                       |
| `t3-app-tester`              | Integrated T3 Trade web testing with `test-t3-app`                               | Sole owner of one retained isolated stack, state directory, and browser |
| `t3-trading-safety-reviewer` | Trading execution, accounting, signer, reconciliation, and protection invariants | Read-only; testnet-only; never weakens a guard                          |
| `t3-contract-auditor`        | Wire/shared-contract producer-consumer coverage                                  | Read-only; checks every active boundary and reverse action              |
| `t3-relay-inspector`         | Relay diagnosis across repo, host, and Cloudflare                                | Read-only unless production mutation is separately authorized           |

Choose specialists by the work, not by habit. These profiles allow background
execution, so ask ZCode to launch independent specialists together when their results
are not mutually dependent. A normal development loop is:

1. Use one or more built-in `Explore` workers in parallel for wide discovery when the
   call chain or impact surface is unknown.
2. Give each `implementation-worker` a self-contained prompt and exclusive file or
   module ownership. Never assign two writers to the same file in one batch.
3. Name exactly one `t3-app-tester` when the app must run. No other worker may start a
   dev stack, drive its browser, consume its pairing URL, or write its SQLite state.
4. Run independent review and verification after implementation. Use
   `t3-trading-safety-reviewer` or `t3-contract-auditor` in addition to
   `change-reviewer` when those boundaries are affected.
5. Return failures to the original implementer when practical; it already holds the
   relevant context. Re-run the independent verifier after the repair.

Every delegation prompt must include the exact checkout, a bounded mission, original
acceptance criteria, owned files, allowed side effects, relevant commands or skills,
a progress artifact path, and the required evidence. Parallelize independent reads and
disjoint writes; serialize dependent work and all access to singleton resources.
Subagent reports are claims until the coordinator or an independent verifier checks
them against the repository and artifacts.

## Verification

Use the `test-t3-app` skill for every user-visible web change. It defines the required isolated state, pairing, controlled-browser, server-retention, and teardown workflow. Reuse one dev server, state directory, and authenticated browser for the full iteration. Do not launch competing stacks from subagents.

### Model roles and test orchestration

The normal local workflow deliberately separates implementation from verification:

- **GLM 5.3 MAX is the user's external development workhorse for this repository.** It inspects, writes, repairs, and may orchestrate development and verification while building T3 Trade. GLM is not part of the T3 Trade product runtime, does not drive the deployed application, and must not be described as a product dependency.
- **GPT is the reviewer, prompt architect, and correctness auditor.** It inspects claims against the repository, identifies architectural or product deviations, challenges unsafe assumptions, writes precise execution and verification prompts for the other roles, and may apply small, indisputable local patches. In the prompt-led workflow, GPT should not silently take over a large implementation assigned to GLM or spend itself on routine test execution. It owns pushback when committing, testing, or scope would be premature or unsafe.
- **T3 Trade is provider-agnostic.** It must work with every supported AI provider through the provider-adapter boundary; no product workflow may depend specifically on GLM or Luna.
- **Luna Medium is the user's current, inexpensive T3 Trade verification provider.** The user is presently testing T3 Trade exclusively with Luna through the product's Codex harness. Use Luna only for T3 Trade work: focused tests, targeted typechecks or lint, and in-product trading/research verification. This is a verification policy, not a product dependency or permanent product default. Do not treat Luna as a general implementation model or use it for unrelated repositories and tasks. Do not spend a larger model on routine T3 Trade verification unless the user explicitly overrides this rule.
- **Luna lives inside T3 Trade through the Codex harness.** A builder that cannot find `gpt-5.6-luna` in its own subagent registry has not proved Luna unavailable. When the builder can launch and operate T3 Trade, it should create or continue the Luna task inside the app and supervise it there.
- Use an explicit **Coding task** for Luna when it needs to read the checkout or run verification commands. Market-research mode is intentionally fenced from repository mutation and is the wrong context for code verification.
- Use a separate **Market research** conversation when verifying the trading-agent experience itself. The supervising implementation model may drive the controlled browser, collect evidence, diagnose failures, and apply repairs; Luna remains the model executing the requested tests and the in-product trading conversation.
- Point Luna's Coding task at the exact checkout containing the changes under test. An uncommitted main checkout is not present in a fresh worktree. The checkout path is source code; the isolated `test-t3-app` home under `/tmp` is disposable runtime state. Never confuse or merge the two.
- Prefer one supervising builder, one retained isolated app stack, and Luna tasks inside that app. Do not recursively launch competing dev stacks or ask a T3 Trade instance to restart the same instance that is hosting its verifier.
- Before and after Luna verification, compare Git state. A read-only verifier must not change the source checkout. Give any Coding-mode mutation proof a disposable fixture under `/tmp`, never a protected dirty repository.
- If Luna cannot be reached through the running T3 Trade Codex harness, report the exact blocker and stop executable verification. Do not silently substitute GLM, GPT, or a larger model.

Prove the changed behavior with the smallest relevant checks:

- Run focused tests with `vp test run <files>` plus targeted typecheck or lint for the changed package.
- Backend behavior changes require focused tests.
- Trading accounting and policy changes require direct invariant/property coverage where applicable.
- Wait on receipts and worker drains in async tests; do not use sleeps or polling to make them pass.
- Do not run `vp check`, repository-wide tests, or repository-wide typecheck unless explicitly requested. CI owns the full suite.
- UI work is complete only after an integrated `test-t3-app` browser pass covering loading, empty, success, and error/refusal states that apply.

Before finishing, consider every affected boundary: server, web, desktop wrapper, providers, wire contracts, local versus remote/relay connections, multi-environment behavior, and reverse actions. Mobile applies only when explicitly requested or when a shared-contract change would otherwise leave it uncompilable.

## Working rules

- Preserve unrelated user changes in a dirty worktree.
- Preserving a dirty tree is a temporary safety strategy, not a completion goal. After verification is green, commit the intended implementation. A tightly coupled cross-package feature may use one atomic commit; unrelated configuration, prompts, editor files, and media must be classified and committed separately or left untouched rather than swept into the feature commit.
- Keep controllers and route handlers thin; keep business rules in focused services.
- Use strict TypeScript, explicit boundary types, `unknown` with narrowing, and no `any`.
- Keep comments for intent and constraints, not narration.
- Avoid continuous repainting animation and unnecessary WebSocket payload growth.
- Make state transitions, validation, permissions, storage writes, side effects, external calls, loading, empty, and error states explicit.
- Update tests and durable documentation with behavior changes.
- Never create a pull request unless explicitly asked.
