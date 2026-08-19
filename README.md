<div align="center">

# T3 Trade

**An Agentic Trading Environment (ATE)** for running coding agents on perpetual
futures markets with a defined strategy, loss budget, and deterministic controls.

[![License: MIT](https://img.shields.io/badge/license-MIT-0f766e?style=flat-square)](./LICENSE)
[![Network: Hyperliquid testnet](https://img.shields.io/badge/network-hyperliquid%20testnet-10b981?style=flat-square)](https://app.hyperliquid-testnet.xyz)
[![Status: alpha](https://img.shields.io/badge/status-alpha-eab308?style=flat-square)](https://github.com/0xgeorgemathew/t3trade/releases)
[![Platform: macOS + web](https://img.shields.io/badge/platform-macOS%20%2B%20web-52525b?style=flat-square)](#running-it)

**[t3trade.pages.dev](https://t3trade.pages.dev)** · [Releases](https://github.com/0xgeorgemathew/t3trade/releases) · [Docs](./docs/user/install.md)

<img src="docs/media/t3trade-mission.png" alt="T3 Trade showing an ETH mission: the agent's reasoning, its fills, an open position with entry, stop and target, and three armed market watches" width="920" />

<sub>One ETH mission: the agent's reasoning, its fills, the open position with
its stop and target, and the watches that will wake it.</sub>

</div>

---

T3 Trade is a fork of [T3 Code](https://github.com/pingdotgg/t3code), Ping
Labs' open-source interface for coding agents. It keeps T3 Code's repository
workflows and adds typed, restricted tools for a Hyperliquid testnet account.

The agent reads market data, creates a plan, and explains its actions. T3 Trade
enforces the mission rules. Every proposed order must pass a deterministic
checklist, every confirmed position increase requires an exchange-native stop,
and you can pause, close, or revoke a mission without the agent running.

```
  your mandate  ->  agent plan  ->  17-check preview  ->  local signature
                         ^                                      |
                         |                                      v
                    watch fires  <-  armed watches  <-  position + stop
```

The loop only advances when every check passes. It stops the moment the loss
budget is spent, and the controls below the chart work whether or not the agent
is running.

> [!CAUTION]
> This alpha software places real orders on Hyperliquid testnet. It supports
> **testnet only** and has no mainnet configuration. Read the
> [safety model](#safety-model) before running anything.

## What it does today

A **mission** connects one agent thread to one market with a written strategy,
a maximum-loss budget, and an expiry. T3 Trade then handles the following:

- **Event-driven agent runs.** The agent can register watches for a price cross,
  an unrealised-PnL level, or a candle close. When a watch fires, the agent
  receives current account, position, order, and budget data.
- **A 17-check order preview.** Before signing, T3 Trade checks the mission,
  leverage, notional, exchange minimums, price bands, order-book freshness,
  risk reservations, and the required stop-loss. Any failed check rejects the
  order.
- **Required position protection.** Every confirmed position increase must
  have an exchange-native reduce-only stop. The stop size is reconciled against
  the position size reported by the exchange.
- **Controls that work without the agent.** Pause, resume, cancel entries,
  reduce by 25/50/75/100%, close, revoke, and close-and-revoke work even when
  the agent provider is stopped.
- **Idempotent order submission.** A deterministic client order ID and local
  idempotency key prevent a retry from placing the same order twice.
- **Tested loss accounting.** Property tests cover budget, reservation, and
  exhaustion calculations. An exhausted budget blocks new exposure without
  removing stops from open positions.

T3 Trade reads positions, orders, and fills from the exchange. Its database
stores its own actions, while exchange data remains the source of truth.

### What it does not do

T3 Trade does not choose strategies, promise returns, or support unattended
trading with real funds. It is built for supervised, budgeted testnet
experiments.

## Running it

You need Node.js (`^22.16 || ^23.11 || >=24.10`), the `vp` command, and at
least one coding-agent CLI installed and authenticated.

```bash
curl -fsSL https://vite.plus | bash
```

```bash
vp i
```

```bash
pnpm dev
```

`pnpm dev` starts the server and web app locally. A packaged macOS
(Apple Silicon) desktop build is available from
[GitHub Releases](https://github.com/0xgeorgemathew/t3trade/releases); other
platforms run from source.

Supported agent providers (install and log in to at least one):

| Provider   | CLI                                                   | Sign in               | Trading missions |
| ---------- | ----------------------------------------------------- | --------------------- | ---------------- |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude auth login`   | yes              |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex login`         | yes              |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode auth login` | yes              |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `agent login`         | coding only      |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok login`          | coding only      |

Without a signer key, T3 Trade runs in **read-only mode**. You can create
missions, watch markets, and review the agent's proposed actions, but T3 Trade
will not sign or submit orders.

## The interim signer key

Hyperliquid requires every order to be signed by a key that controls the
account. T3 Trade does not yet include wallet onboarding or scoped agent-key
management. Testnet execution currently uses one **interim signer key** that
you provide. The presence of this key enables order execution:

- Place it at `~/.t3trade/secrets/hyperliquid-interim-signer-key.bin`. You can
  override the base directory with `T3TRADE_HOME` or set
  `T3_TRADES_INTERIM_SIGNER_KEY`. The dev server, worktrees, and packaged
  desktop app all use this location.
- **With the key, the server can place testnet orders. Without the key, the
  server is read-only.** There is no additional execution flag.
- The key never appears in logs, reports, or the database, and must never be
  committed. Use a testnet-funded key only.

This alpha uses one key and one configuration path. Expanded key management is
not yet available.

## The market archive

The Hyperliquid Info API is a window, not a history: every candle interval is
capped at roughly the most recent 5000 bars, so a 1m series reaches back about
three and a half days and nothing older is ever served again. Open interest and
premium have no historical endpoint at all. The archiver is a standalone
process that writes all of it down as it goes by, so the lab owns the history
the exchange will not hand over.

**Its value compounds with uptime.** There is no catching up later: a day not
recorded is a day gone. It should simply always be running.

```bash
bun run --cwd apps/server archive
```

The command runs on Node like the rest of the repo — `bun run` invokes the
package script, which is what makes `bun:sqlite` unnecessary and keeps the
archiver's code path identical under test.

It reads mainnet public data only (`POST https://api.hyperliquid.xyz/info`),
never authenticates, and never touches an order endpoint or an account read.

### Where it lives

`~/.t3/userdata/market-archive.sqlite` — its own file, its own tiny schema, its
own version row in a `meta` table. It shares nothing with `state.sqlite` and is
not part of the application's migration chain.

### What it records

For BTC, ETH, and SOL:

| Table          | Cadence      | What it holds                                                         |
| -------------- | ------------ | --------------------------------------------------------------------- |
| `candles`      | every 60s    | OHLCV at 1m, 5m, 15m, 1h, 4h, 1d (`t` open, `t_close` close)          |
| `funding`      | every 30 min | Realised funding rate and premium per hour, back to 2023-05-12        |
| `asset_ctx`    | every 60s    | Open interest, premium, oracle, mark, 24h volume, predicted funding   |
| `book_summary` | every 60s    | Best bid/ask with sizes, and summed size over the top five levels     |
| `known_gaps`   | on startup   | Stretches that fell out of the API window while nothing was recording |

Startup always begins with a backfill of the full servable window for every
series, so killing the process and starting it again is a supported way to
operate it rather than an incident: every write is an idempotent upsert, and
the bar that was in progress when it died is overwritten with its final values.
A gap older than the API window can never be repaired, so it is recorded in
`known_gaps` instead of retried forever. A heartbeat line once a minute reports
rows written per table and how far behind each interval's newest bar is.

### Adding a coin

Add it to `ARCHIVE_COINS` in
[`apps/server/src/trading/archive/config.ts`](./apps/server/src/trading/archive/config.ts)
and restart. The schema needs no change, and the next startup backfills that
coin's full window.

### Reading it back

[`apps/server/src/trading/archive/read.ts`](./apps/server/src/trading/archive/read.ts)
holds pure read helpers — latest candle, candles in a range, trailing mean
funding, latest open interest and book. Nothing in the application imports them
yet; they exist so the toolkit has one place to ask. The file is in WAL mode,
so reading it while the archiver writes is safe.

## Safety model

- **Testnet only.** No mainnet configuration exists.
- **The signer key enables order execution.** See above.
- **`T3_TRADES_LIVE_EXECUTION=1` enables live smoke tests only.** The
  `packages/hyperliquid` test suite reads it; the server does not.
- **Leave the account with no open exposure.** After a live run, close the
  position and cancel resting orders.

## Layout

| Path                                     | What lives there                                           |
| ---------------------------------------- | ---------------------------------------------------------- |
| `packages/trading-contracts`             | Schemas and rules for order previews, protection, and risk |
| `packages/hyperliquid`                   | The exchange client: signing, info reads, WebSocket        |
| `apps/server/src/trading`                | Mission state machine, execution, reconciliation, controls |
| `apps/server/src/trading/archive`        | The standing mainnet market-data archiver                  |
| `apps/web/src/components/trading`        | Mission workspace and risk controls                        |
| `apps/marketing`                         | The T3 Trade site                                          |
| `docs/architecture/trading-execution.md` | Design notes for the execution path                        |
| `docs/upstream/`                         | Upstream baseline, patch ledger, and sync runbook          |

Code outside these paths comes from T3 Code and stays close to upstream to
reduce sync work. See
[`docs/upstream/PATCH_LEDGER.md`](./docs/upstream/PATCH_LEDGER.md) for each
intentional difference.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Trading execution and reconciliation](./docs/architecture/trading-execution.md)
- [Architecture overview](./docs/internals/overview.md)
- [Upstream baseline and sync runbook](./docs/upstream/SYNC_RUNBOOK.md)
- [Glossary](./docs/internals/glossary.md)

## Upstream

T3 Trade tracks `pingdotgg/t3code` at the commit listed in
[`docs/upstream/BASELINE.md`](./docs/upstream/BASELINE.md). The `upstream`
remote is fetch-only. For non-trading features, use T3 Code's README, install
instructions, and support channels. This fork does not accept contributions
that belong in the upstream project.
