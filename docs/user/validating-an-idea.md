# Validating a trading idea

A backtest tells you what an idea would have done on bars that already exist. It
is the cheap question, and almost every idea that was tuned until it looked good
passes it. The expensive question is whether the same rule still works on bars
nobody has seen yet.

Forward validation asks that question. You describe an idea in one sentence, T3
Trade watches it on live bars for as long as you asked, and records every trade
the rule would have taken — at the fees and funding a real trade would have
paid. Nothing is ever sent to the exchange.

## Starting one

Say what the idea is and how long to watch it:

> On ETH one-minute bars, buy whenever price crosses above the 20-period EMA,
> stop 0.2% below entry, target 0.3% above, and give up after 30 bars if neither
> hits. Watch this for two weeks and tell me if it works.

The agent writes the idea back to you as a rule before it starts, so you can see
exactly what it is about to test. It usually runs a backtest at the same time —
that becomes the number the live run is later compared against.

Ideas can be validated on 1m, 3m, 5m, 15m and 1h bars. Longer timeframes are not
offered: a fortnight of daily bars is fourteen observations, which is not enough
to conclude anything from.

One idea at a time per market and timeframe. To test a variation, end the
running one first or test it on another timeframe.

## Watching it

On the chart above the composer, a validated idea shows a badge naming it, and
its paper trades appear as markers as bars close — a dashed ring where the rule
would have bought, and another where it would have closed, coloured by what the
trade made or lost after fees.

The markers are drawn as dashed rings, never as solid ones, because nothing
happened to your account. If the chart is on a different timeframe than the
idea, the badge tells you which one to switch to and draws no markers, rather
than putting marks at times the rule never fired.

## Asking how it is doing

Ask at any time:

> How is my thesis doing?

You get the paper trades taken so far, the hit rate, what each trade made or
lost on average after fees, the worst drawdown, and how all of that compares to
the backtest from when it started.

Under twenty paper trades there is no verdict. The numbers are still shown —
withholding them would be its own kind of dishonesty — but nothing calls them
evidence, because a handful of trades cannot tell a real edge from a lucky
week.

## Having it narrated while it runs

Asking is one way. The other is to have the agent tell you, unprompted, as the
run moves:

> Watch this one for me and tell me what you see.

That turns the chat into a watcher. It wakes whenever the validation opens a
paper trade, closes one, changes its verdict, or expires, and writes one honest
sentence about what the event means for the idea — confirming it, contradicting
it, or noise, and why. A single paper trade in either direction is usually
noise, and it will say so rather than reading a story into it.

A watcher cannot trade. It holds no authority on any market, it has no way to
publish a plan or place an order, and asking it to do either gets a refusal
rather than a position. It also does not lock the market it is watching: you can
still trade that market from another chat while the watcher reports on it.

The events show up in three places: as rows in the agent log, as ticks on the
chart's timeline where you can hover to read what happened, and as the agent's
own notes in the conversation.

If a fast idea starts producing events every few bars, the watcher folds them
together rather than narrating each one, and says in its own words that it is
summarising. You can pause it, resume it, or stand it down like any other
mission, and it survives a restart.

A chat that is already trading a market gets these events too, on its ordinary
wakes, and answers them the same way — one sentence about what it means, and
back to the position it was managing.

## Being told when the setup is forming

The validation watches every bar, but you do not. If you want a nudge when the
idea's entry starts lining up:

> Alert me when that setup is forming.

What can be armed is armed, as an alert only: it lands in your feed, it wakes
nothing, and it can never place an order.

Not every rule can become an alert, and the reply says which could not and why.
Price levels, funding thresholds and the volume pace all translate. An indicator
reading does not, raw bar volume does not, and neither does the ordering in an
"after" clause, because an alert has no memory of what came before it. Those
parts are not lost: the paper validation is evaluating all of them on every
closed bar, which is what the reply points you back to.

One thing worth being clear about. If the entry has several conditions, you get
one alert per condition, and they fire independently. Getting all of them is not
the same as the entry firing, because they may have happened days apart. The
validation is the thing that decides a setup actually fired; the alerts just
tell you to look.

## Pausing, resuming and stopping

- **Pause** stops evaluation and keeps everything: the idea, its trades so far,
  and the backtest it is being compared against. Bars that pass while it is
  paused are simply bars it did not watch, which the report says.
- **Resume** carries on the same record.
- **End** stops it and gives you the final report.
- Otherwise it ends itself when the time you asked for runs out, and the final
  report arrives as an alert.

Ask for any of these in plain words, or ask "what am I validating?" to see
everything currently running.

## Keeping the history

A validation on its own is one measurement. To keep the whole arc of an idea -
its versions, every backtest against each one, and every validation that has run
on it - save it as an idea first and validate that. See
[Developing an idea](developing-an-idea.md).

Saving also buys the one exception to the one-per-market-and-timeframe rule: a
revised version of the same idea supersedes its own earlier run rather than
being refused.

## Trading a validated idea

Nothing is automatic. If an idea holds up and you want to trade it, say so:

> This one is working. Trade it.

That is an ordinary trade from there — the same plan, the same stop, the same
confirmation as any other — with the validation record as the evidence behind
the decision. There is no switch that turns a validation into a live position,
by design.
