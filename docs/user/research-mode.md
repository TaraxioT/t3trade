# Research mode: T3 Trade without a trading key

T3 Trade signs orders with a Hyperliquid key you supply. If you have not
supplied one, the app does not stop at the door. Everything that reads the
market keeps working, and only signing refuses.

The trade home says so in one line under the market-recording line:

> Research mode: no trading key is configured. Observation, backtests and
> validations work; orders will be refused.

The same sentence is on Settings, under Trading.

## What works without a key

All of this reads public Hyperliquid market data, which needs no account and no
credential:

- **Charts** for any listed market, on every timeframe.
- **The watchlist** and the asset search over the venue's whole universe.
- **Price alerts**, time alerts, and alerts on measured metrics. They arm and
  they fire.
- **Backtests.** An idea is tested against bars that already exist, at the fees
  and funding a real trade would have paid.
- **Forward validation.** An idea is watched on live bars for as long as you
  asked, and every paper trade is recorded. See
  [Validating a trading idea](validating-an-idea.md).
- **Missions.** You can start one, it wakes on its triggers, it reads the market
  and the archive, it publishes plans, and it keeps its journal.
- **Plans.** A published plan is recorded and drawn on the chart. Its stop and
  target are your declared levels; without a key nothing is placed on the venue,
  and the agent is told so on every publish.

## What refuses, and how

Anything that would send an order:

- **Placing an order by hand.** The ticket previews: it quotes the book and
  where the order would fill, and says the order itself would be refused.
- **The agent's own entries and exits.** Refused, with the reason named.
- **Position-scoped alerts** (profit, give-back, and fill alerts) are refused
  when you arm them, rather than armed and left permanently silent. An alert
  that can never fire is worse than no alert, because silence reads as "the
  level was not reached".

## What the agent is told

A mission running without a key sees one line on every wake saying that no
trading account is attached, that sizing is unavailable, and that orders will be
refused. It is not left to discover this from a failed order.

Its mandate is likewise not presented as a real number. A mission's capital is
normally read from the account balance; with no account there is nothing to
read, so the mandate shown is a documented stand-in and is labelled as one.

## Turning execution on

Supply the key and restart the server. See the interim signer key section of the
README. Nothing else changes: the research surfaces behave identically, and the
research-mode line disappears.
