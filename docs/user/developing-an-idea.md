# Developing an idea

Most trading ideas do not arrive finished. You notice something, you say it out
loud, it turns out to be almost right, and the version that is actually worth
anything is the third or fourth one. T3 Trade keeps that whole arc in one place,
so a week later you can ask what happened to an idea and get an answer instead
of a scroll through old messages.

An idea you have saved is called a hypothesis. It has a title, a rule, a version
history, every backtest ever run against it, and whatever forward validations
are or were running on it.

## Talk it through

Start where you always start, in ordinary words:

> ETH keeps snapping back after it pokes above the 20-period EMA on five minute
> bars. I think fading that is worth something.

The agent will write the idea back to you as a rule: which market, which
timeframe, which direction, what has to be true to get in, and how you get out.
That written-back rule is the thing everything else measures. If it is not what
you meant, say so before anything is tested.

## Save it

Once the rule is right, ask for it to be kept:

> Save that as an idea. Call it the ETH EMA fade.

You get a card with the title, the rule, and its status. A freshly saved idea is
**exploring**: written down, not yet tested.

## Backtest it

> Backtest that idea over the last month.

The run is filed against the idea at the version it tested, and the idea moves
to **testing**. Every run is kept, so the card grows a line per backtest with
the version it belongs to on the left. That column is the point: it is where you
can see whether the refinements are actually improving anything.

Backtests you run without saving an idea first are kept too. They just are not
attached to anything, which is fine for a question you asked once.

## Say more than a price

An idea can compare more than the price and the usual indicators.

> Buy when funding has gone negative and the bar traded twice its recent
> volume.

Funding is the 8h rate the exchange charged at the moment the bar closed, with
its sign, and volume can be read either as the bar's own volume or as a ratio
against the previous twenty bars. Two means the bar traded at twice its recent
pace.

Ideas often have an order to them, and that can be said directly:

> After funding flips negative, buy the first close above 3,900, as long as it
> happens within twelve bars.

The "after" part is checked on the closed bars before the entry, never on the
entry bar itself. If the thing you were waiting for and the entry happen on the
same bar, that is not a sequence, and it will not fire.

Two things to know. Funding history is only recorded for some markets; asking
for a funding rule on a market with none is refused rather than quietly
returning no trades, because no trades would read as "the idea does not work".
And the "after" window reaches back at most a hundred bars, which on any
interval is long enough that further back stops being a sequence and starts
being a market regime you should say outright.

## Revise it

When the numbers suggest a change, revise rather than starting over:

> The target is inside the spread. Widen it to three times the ATR and try
> again.

That writes version 2. Version 1 keeps its own thesis and its own backtest
numbers forever, because a measurement belongs to the rule that produced it.
The revision also carries a short note saying why it exists, so the history
reads as an argument rather than a list.

If the idea had already been concluded or shelved, revising picks it back up:
the verdict is dropped, because a verdict about a rule that has since changed is
worse than no verdict at all.

## Validate it forward

A backtest is the cheap question. When a version looks good, watch it on bars
nobody has seen yet:

> Validate the current version forward for two weeks.

That runs on paper, at real fees, and never places an order. See
[Validating a trading idea](validating-an-idea.md) for how forward validation
works and what its report says.

One idea at a time runs per market and timeframe. There is one exception, and it
is the one you want: if you revise an idea and validate the new version on the
same market and timeframe, the earlier version's run is ended and marked
superseded, and the new one takes its place in the same breath. A different
idea competing for the same slot is still refused, because that really would be
two rules watching the same bars.

When a validation finishes, its report arrives as an alert. Open the alert in
the Alerts panel to read the full report rather than the one-line summary.

## Conclude it

Ideas should end. Say what the evidence showed:

> That one does not work. The edge disappears once you pay the spread.

The idea becomes **not supported**, with your sentence recorded against it. An
idea proven wrong is a real result and is not marked as a failure anywhere in
the product; it is the cheapest thing this tool can give you.

If it does hold up, conclude it **supported** instead. Nothing is traded by
concluding. Trading a supported idea is the ordinary flow, and you still have to
ask for it:

> This one is working. Let us trade it.

And if you simply lose interest, shelve it. That is an honest ending too, and
revising it later picks it straight back up.

## Finding them again

> What ideas am I working on?

You get everything from the current conversation, newest first, with each one's
status and version. Ask for everything on the machine if you want ideas from
other conversations too, and ask to show a particular one to get its whole
history back.
