# Forge acceptance fixtures — host-reviewed setup data

`ForgeAcceptance` (apps/server/src/trading/forge/ForgeAcceptance.ts) reads acceptance
cases from `<stateDir>/forge/acceptance/<capabilityId>/v<version>.json` ONLY. A missing
file is a hard refusal ("host-reviewed acceptance cases are not configured"), which is
the honest state: nothing installs without host expectations.

These JSON files are that setup data. They are **not** imported by server source — the
eth-coordination expectations travel in reviewed setup files and the demo's request
text, never in host source (the builder stays generic). Install them into a state dir
before the first capability build:

```sh
infra/forge-acceptance/install.sh <stateDir>
```

## Where the v1 expectations come from

The authoritative implementation plan's detector-semantics section (reference
implementation) defines version 1 exactly:

- Input gate: exactly three distinct pools, else `{kind:"insufficient", reason:"need_three_distinct_pools"}`.
- Eligible pool: `tradeCount > 0 && quoteVolumeMicros >= minPoolQuoteMicros`, floors at
  zero in v1 — v1 counts every valid trade.
- Moving pool: eligible with `|moveBps| >= 2` (movement below 2 bps is ignored); a null
  `moveBps` (missing anchor) is never moving.
- `coordinated`: ≥2 moving pools in one direction; `isolated`: exactly one moving pool;
  `quiet`: none; otherwise `{kind:"insufficient", reason:"opposing_moves"}`.
- `agreement`: dominant-direction count over ALL THREE pools — `max(up,down)/3` when
  coordinated, `1/3` when isolated, `0` when quiet.

`forge-swap-signal/v1.json` pins one case per outcome (coordinated 2-up, isolated one
mover, quiet, opposing without majority, wrong pool count). The same rules ride in the
demo's pasted request so the authoring brief carries them; the acceptance file checks
the result. Version 2 floors (per-trade and per-pool) are the agent's justified choice
at revision time — the host then authors v2 cases into the stateDir override, never here.

## Reviewing changes

A change to these files is a host review: the expectations must stay derivable from the
plan's semantics section (or a recorded F0 tuning decision) and decode against
`ForgeAcceptanceCase`. The unit test in `ForgeAcceptance.test.ts` re-decodes the shipped
file so a broken fixture cannot slip in silently.
