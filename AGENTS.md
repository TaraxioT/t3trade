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

ZCode loads user profiles from `~/.zcode/agents` and workspace profiles from
`.zcode/agents`. Do not keep an installed profile under both roots: ZCode gives the
workspace copy precedence by name, then hides that copy when Settings is filtered to
User. This repository therefore keeps reviewed, non-discoverable source templates in
`.zcode/agent-templates`. After changing a template, copy it to `~/.zcode/agents` as
a regular file, use the refresh button in Settings > Subagents, and start a new ZCode
task. ZCode's discovery does not follow symlinks. ZCode Settings can then enable,
disable, edit, or delete the installed copy. Custom subagents inherit this workspace
`AGENTS.md` and the current model by default. Use the built-in `Explore` role for
read-only codebase discovery; do not recreate or override ZCode's reserved
`general-purpose` or `Explore` names.

Install or refresh the complete T3 Trade profile set from the repository root:

```sh
mkdir -p ~/.zcode/agents
cp .zcode/agent-templates/*.md ~/.zcode/agents/
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

Development work and product-experience testing are separate activities:

- **GPT and GLM are the development agents.** Either may inspect, implement, review, debug, and directly execute focused tests, typechecks, lint, and other development commands in the checkout. Development-purpose coding and verification tasks belong only to GPT or GLM, including any delegated development workers. Do not assign them to Luna or another product provider.
- **Do not route repository development through T3 Trade.** There is no requirement to create an in-app Coding task, use the Codex harness, or keep the application running to execute unit tests or development checks. Run those checks directly from the external development environment against the exact checkout containing the changes.
- **Use the app when testing the app experience.** Integrated browser checks still follow `test-t3-app`. In-app trading/research conversations exercise the product's supported providers. An in-app coding task is appropriate only when explicitly testing that product capability, using a disposable fixture repository; it is not a vehicle for developing or verifying T3 Trade's own source.
- **T3 Trade remains provider-agnostic and may write or execute code as a product capability.** This development-workflow rule does not disable that capability or make GPT, GLM, or Luna a product dependency. Select a product-test provider according to the specific test or the user's instruction; Luna is not a mandatory development verifier.
- **Verification quality comes from evidence.** Record exact commands, working directory, exit codes, relevant output, and tested Git state. Review against the original acceptance criteria. Independent GPT/GLM review is useful where warranted, but a different model running a command is not itself proof of correctness. Existing test evidence is not invalid merely because Luna executed it under the previous policy.
- Preserve unrelated changes and compare Git state before and after read-only checks. Keep source checkout paths separate from disposable runtime homes under `/tmp`. Never use a fresh worktree as proof of uncommitted changes in another checkout.
- Keep one supervising owner, one retained isolated app stack, and one authenticated browser for integrated product testing. Do not launch competing stacks or ask an app instance to restart itself as part of development verification.
- If an in-app provider is unavailable, record the affected product-experience check as blocked. Continue direct development checks with GPT or GLM; provider availability is not a prerequisite for repository testing. Respect actual tool permissions without inventing a requirement to weaken a sandbox.

This policy supersedes earlier prompt packs and instructions requiring Luna Medium inside T3 Trade to execute development tests. The user clarified this boundary on 2026-09-06.

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
