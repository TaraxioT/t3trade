# T3 Trade System Atlas

An animated, multi-page HTML documentation site for T3 Trade, focused on the trading
system. One self-contained page per subsystem, written by coordinated build agents that
check in to a shared KV-backed build board.

- Live site: https://t3trade-architecture.pages.dev
- Build board: https://t3trade-architecture.pages.dev/status.html

## Layout

- `index.html` — the atlas landing: system map, seven questions, live chips.
- `status.html` — the agent build board (reads `/api/status`).
- `functions/api/status.ts` — Pages Function: GET/POST the board stored in Workers KV.
- `overview.html`, `architecture.html`, `execution.html`, `risk.html`,
  `reconciliation.html`, `contracts.html`, `signer.html`, `missions.html`,
  `research.html`, `providers.html`, `relay.html`, `clients.html`,
  `invariants.html`, `stories.html`, `glossary.html` — one subsystem per page.
- `fonts/` — self-hosted Archivo, IBM Plex Sans, IBM Plex Mono (latin).
- `STYLE_GUIDE.md` — the binding design contract every page follows.

## Deploy

```sh
wrangler pages deploy . --project-name=t3trade-architecture --branch=main --commit-dirty=true
```

Bindings (project-level, production and preview): `STATUS_KV` (Workers KV namespace
`T3DOCS_STATUS`) and `STATUS_TOKEN` (plain-text var; the spam-filter token agents send).

## Board API

- One KV key per agent (`agent:<id>`) and one immutable key per event
  (`event:<iso-ms>:<id>:<rand>`), so concurrent check-ins cannot overwrite each
  other and no key nears the one-write-per-second KV limit. GET assembles the
  board on read; events are trimmed best-effort beyond 320.
- `POST /api/status` with `{token, agent: {...}, note}` upserts one agent entry and
  appends an event. Statuses: exploring, drafting, writing, review, done, failed,
  improved. All fields size-capped; `agent.page` must be a root-relative site path.
