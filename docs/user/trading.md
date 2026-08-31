# Trading with the agent

A trading conversation is not a chat bot with a trading persona bolted on. It is
the full native coding agent you use everywhere else in T3 Trade — Claude Code,
Codex, or another provider, with its own instructions, shell, file tools, web
access, and skills — with T3 Trade's trading tools added and a short grounding
block appended to the first turn. Nothing about the agent's native surface is
replaced. See [Permission Modes](permission-modes.md) for how much it does on
its own and when it stops to ask you; the same mode model applies here.

The agent reads the market through typed tools (`trading_look`, backtests,
validations, watches), reasons in prose, and acts through one more typed tool:
`trading_enter` for new exposure, `trading_exit` for reducing, closing, and
managing protection. Everything the venue sees goes through those tools. The
server — not the prompt — enforces testnet-only, per-market authority, loss
budgets, mandatory protective stops, idempotency, and reconciliation. A refusal
from the server is authoritative; the agent is told so.

## TRADE.md

TRADE.md is to a trading workspace what AGENTS.md is to a coding one: a plain
Markdown document in the workspace root that states, in your words, what this
workspace trades for and how. The agent writes and reads it with its native
file tools — the server never writes it. Nothing in it is ever parsed into an
order. It is context the agent interprets; the typed tools are the only
execution path.

The document starts from a four-section skeleton the agent creates for you:

- **Mandate** — objectives, horizon, risk appetite.
- **Strategies** — the named playbooks in play and what each waits for.
- **Global Controls** — ceilings that override any single setup: max size, max
  leverage, loss budgets, forbidden markets or times.
- **Change Log** — one line per deliberate change: date, what changed, why.

Plain Markdown on purpose: no frontmatter, no required grammar. The file must
stay under 64 KiB — the largest the server will read.

### Activation

A TRADE.md that merely exists does not govern anything. To run a persistent
strategy, the agent activates it: `trading_plan_document` with `activate` and
the content hash of the revision it just read. The server pins that one
revision by SHA-256 hash. The hash is an optimistic-concurrency token — if the
file changed since the caller read it, activation refuses with `stale_hash` and
nothing is written. Read the file, then activate what you read.

Activation states, shown beside the conversation:

- **none** — no file at the workspace root (an activated revision whose file
  went missing still fences, as Drift below explains).
- **draft** — the file exists but was never activated.
- **active** — the file on disk matches the activated revision.
- **drifted** — the file changed after activation.

Every activation is persisted as a snapshot with an append-only revision audit
row (the `changeNote` you pass at activation is the row's half of that trail;
the Change Log section is the human half), so background execution reads the
pinned revision server-side even if the live file moves under it.

There is one TRADE.md pin per workspace root. Two checkouts of the same
repository — the main checkout and a worktree, say — each have their own
document and their own activation, and they are never merged.

### Drift

Editing TRADE.md after activation does not change what the running strategy
does: the activated revision still governs. What drift changes is new
exposure. While the state is `drifted`, `trading_enter` refuses with
`plan_document_drifted` until the agent reads the current file and re-activates
it. A deleted or renamed TRADE.md fences the same way — the file is the
document, and a missing one is an absence the fence treats as unreadable
rather than as consent.

Managing the risk already open is never blocked: reduce, close, cancel,
tightening or repairing a stop, pause, and revoke all remain available. Drift
pauses taking on risk; it does not trap you in a position.

### Pause and resume

Pausing the strategy stands the activated revision down — the pin is released
with an audit row, and the file stays on disk untouched. Resuming is
re-activation: read the current file, activate its hash. A pause during drift
is often the cleaner answer than re-activating something you have not read.

## Direct orders

"BUY 0.01 BTC" in a trading conversation does not require a TRADE.md and never
activates a stale one. A direct order binds to the market as a generated
direct-order runtime record — the mission is labelled as such in the UI, and
it is never filed as a TRADE.md strategy. The one exception: if the thread's
workspace has a TRADE.md that is pinned and current, an entry there is that
plan being executed, not a bare order, and it is not labelled as one.

## Without a trading key

Everything above about reading, planning, and publishing works in
[research mode](research-mode.md), with no signer configured. An entry — direct
or plan-backed — refuses deterministically with `needs_trading_account` before
anything is priced or sent. Reducing, closing, and revoking are operator
actions that do not depend on the provider running at all.
