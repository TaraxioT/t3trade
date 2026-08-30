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
because "after Devcon" means after the whole thing. An instantaneous event,
like a network upgrade switching on, is recorded as the exact moment it
happened: the same instant for its start and its end, so the study anchors on
the second it activated rather than on a whole day it did not span. Recording
the same name again replaces the dates, which is how a wrong date is corrected.
A set can be retired when you are done with it: new ideas refuse to use it, but
ideas that already use it keep working.

Each occurrence carries exactly one source link: the one place the date is
authoritatively stated. When the research turned up several pages, the extra
ones are read back to you in the answer instead, because a source field holding
two web addresses joined together renders as one broken link.

Dates that have not happened yet are first class. Recording next year's Devcon
before it happens is the point, not a mistake.

## Ask what price actually did

> Study that on ETH, daily bars, over the thirty bars after each one.

The study answers the question directly: for every occurrence, the return from
its entry bar to a horizon later, next to the same measurement taken at every
bar of the window, so you can see whether the event did anything the market was
not doing anyway.

The entry rule is stated with the numbers and is part of the recipe. By default
the entry is the close of the first bar that closed after the event, and the
exit is the close a full horizon of bars later: an ordinary close-to-close
measurement, which is what a moment like an activation asks for. A study can
instead enter on the open of the first bar at or after the event ended, the
older convention; whichever basis a study used is recorded with it, and an
older study keeps explaining itself in its own terms.

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

## See it on the graph

Ask for the study and it does not stay a paragraph. Say:

> Study that on ETH, daily bars, over the thirty bars after each one, and put
> it on the graph.

The graph above the conversation offers Live, Calendar, and Event aligned
views. In Calendar, every occurrence gets its own window: the activation as a
named vertical rule at the instant it happened, the entry and the exit as
markers pinned to the exact prices they were measured at, the signed return
drawn between them, and the source the date came from, one link each. These
markers are historical measurements, not trades: nothing filled, nothing
ordered, and the label beside them says so. An occurrence the recorded history
cannot reach says why instead of quietly disappearing, and one that ran out of
bars before the horizon says that too.

In Event aligned, every measured occurrence is rebased to its own entry, so
the question changes from what happened next to whether the shapes resemble
each other. The count, the baseline over the same horizon, the requested and
served windows, the recording start and every gap sit beside the picture, with
a dollar figure beside the traces by default: an illustration on a $1,000
notional you can change, and any money figure is labelled as the historical
gross change on that notional, before costs. It is never shown as profit,
never as a balance.

Every scene carries the same line: historical research, no order placed, not
a forecast. Seeing the study needs nothing armed and nothing funded. You can
ask for a cost-aware backtest or a separate forward validation when either
answers your next question. Neither places an order; execution still requires
its own explicit ask and the normal protections.

On the live chart, the occurrences draw as vertical bands behind the price,
on every timeframe, with the next upcoming date visible in the space to the
right of now.

## What to keep in mind

A handful of occurrences is a small sample, and the study says so rather than
dressing it up. The numbers are worth having; they are just not evidence, and
the sentence with them never claims otherwise.

The calendar is yours, not the market's. If a date is wrong, the study is
wrong, which is why every occurrence carries its source and re-recording the
set is one sentence away.
