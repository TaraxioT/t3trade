# Studying events

Some ideas are not about the market at all. They are about the calendar:
what ETH did after Devcon, what SOL did after Breakpoint, what happens around
an upgrade. No indicator carries a conference in it, so those ideas used to
have nowhere to live. Now they do.

## Record the dates

Say the idea out loud, the way you always do:

> Every time after Devcon, ETH goes up about ten percent.

The agent will look the dates up and read them back to you: which Devcon, when
it started, when it ended. Check them. The dates are recorded with the source
each one came from, so any number that rests on them can be traced back to
where it came from. If you already know the dates, dictate them and they are
recorded as coming from you.

Nothing is invented. A date without a source is refused rather than recorded,
because a made-up date is a number every later number silently rests on.

The recorded thing is called an event set: a name ("Devcon") and its dated
occurrences. A multi-day event is one occurrence anchored on its last day,
because "after Devcon" means after the whole thing. Recording the same name
again replaces the dates, which is how a wrong date is corrected. A set can be
retired when you are done with it: new ideas refuse to use it, but ideas that
already use it keep working.

Dates that have not happened yet are first class. Recording next year's Devcon
before it happens is the point, not a mistake.

## Ask what price actually did

> Study that on ETH, daily bars, over the thirty bars after each one.

The study answers the question directly: for every occurrence, the return from
the first bar after the event ended to thirty bars later, next to the same
measurement taken at every bar of the window, so you can see whether the event
did anything the market was not doing anyway.

Two honesties are built in. No fees, no stops, no position: this is a
description of what happened, and anything about what you could have made is a
backtest's job, which you can run on the same idea. And coverage is stated
plainly: an occurrence older than your recorded history, or still in the
future, is listed as such rather than quietly dropped. A mean of the survivors
of a silent filter is the most misleading number a study could produce, so the
verdict says something like "1 of 2 occurrences fall inside archived data" and
never claims more than that.

## Anchor an idea on it

Once the dates are recorded, they become part of the rule vocabulary:

> Buy ETH when the bars since Devcon ended are under thirty and price crosses
> above the 20 EMA.

The "bars since" reading starts at zero on the first bar after the event ends,
so "under thirty" means the first thirty closed bars after it. Before the event
has ended, the rule reads nothing at all rather than zero: nothing has
happened yet, and a rule that fires on a calendar that is still empty would be
firing on nothing. Everything else works on an anchored idea exactly as it
does on any other: backtests, sweeps over how wide the window should be, and
forward validation.

This is where a future date earns its keep. Save the idea, validate it forward,
and the rule sits there reading nothing, day after day, until the recorded
date passes. Then the window opens on live bars and the validation is watching
the real thing, which is a far better test than any amount of history.

On the chart, the occurrences draw as vertical bands behind the price, on every
timeframe, with the next upcoming date visible in the space to the right of
now. An anchored idea is something you can point at.

## What to keep in mind

A handful of occurrences is a small sample, and the study says so rather than
dressing it up. The numbers are worth having; they are just not evidence, and
the sentence with them never claims otherwise.

The calendar is yours, not the market's. If a date is wrong, the study is
wrong, which is why every occurrence carries its source and re-recording the
set is one sentence away.
