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

## Get the timing exactly right

A date is exact, and the record says which kind of exact it was given. There
are three kinds, and every occurrence written now carries one:

A date is a date. When the research established whole days — the conference
ran November 12 through 15 — that is one occurrence spanning those UTC days
and nothing finer. Nobody pretended to know what time of day it started.

An instant is an instant. A network upgrade that switched on at 06:42:42 UTC
is recorded as that exact second: the same moment for its start and its end,
and the study anchors on the second it activated, never on a day it did not
span.

A window is a window. An event that began at one known time and ended at
another is recorded with both times.

The tool refuses to guess in between. A time of day with no end is refused
rather than padded out to whatever day it happens to sit in: that padding is
how twenty fork activations once became twenty invented 24-hour spans, and a
study anchored on those inherited the invention. If you know the moment, give
the moment; if you only know the day, give the day and it is recorded as a
day. A date paired with a time, or a claimed precision the dates contradict,
is refused with the reason rather than quietly reinterpreted. Everything is
UTC, and a time is never converted to or from your local clock.

Sets recorded before these distinctions existed are still there and still
work. Their occurrences were written as spans, and that is what they say they
are: they carry no timing claim, and nothing guesses one back from the
numbers after the fact.

## Read it back before it is written

Recording twenty dates in one call is a transcription, and transcription
errors are silent: a row swapped, a digit slipped, one source pasted over
another all decode as perfectly good dates. A bulk record can be asked to
prove it transcribed cleanly.

The agent previews first. It calls the tool with the dates it is about to
record, and the answer reads the parsed dates back in order — each with its
timing, its label, and its source — plus a confirmation digest: a
fingerprint of exactly that list, in that order. Then the record call carries
that digest and `requireReadBack: true`, and it writes only if the dates are
the very ones that were read back. If anything moved — an occurrence
reordered, a timestamp nudged, a source, a label, or the set's name changed —
the call is refused and told to preview again. The digest works only in the
conversation that previewed it, and only once: replaying a confirmation the
record already used is refused too.

None of this is required. A plain record works the way it always has; the
read-back is there for the moment when twenty dates, one call, and nobody
checking is exactly the risk.

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

The horizon is a span of bar intervals on an unbroken grid, never a row count.
Three rules follow from that, and each is the study refusing to invent a
number:

- The entry bar is a specific bar. If the archive is missing the bar the entry
  belongs to, the occurrence is reported as behind a recording gap — never
  measured from a later candle that would silently move the entry.
- A gap in the middle of a horizon truncates the measurement at the gap. The
  row keeps what it could measure, says it was cut short and why, and does not
  stretch a "thirty days" over later bars that are more than thirty days away.
- Nothing forming is read. The study measures as of a cutoff: a bar that has
  not closed yet has provisional prices, and no entry, exit, extreme, or
  baseline number may depend on a price that can still change.

And one more split, because a partial window answers a different question than
a complete one. Rows are counted three ways — covered occurrences that
measured the full horizon, covered occurrences whose window stopped short, and
occurrences the archive could not measure at all — and the mean, median, hit
rate, best and worst come from complete horizons only. A truncated row keeps
its numbers for inspection; it never quietly joins a mean of full-horizon
measurements, and a study where nothing completed reports no mean at all
rather than a number over a shorter window.

Two honesties are built in. No fees, no stops, no position: this is a
description of what happened, and anything about what you could have made is a
backtest's job, which you can run on the same idea. And coverage is stated
plainly: an occurrence older than your recorded history, still in the future,
or behind a gap is listed as such rather than quietly dropped. A mean of the
survivors of a silent filter is the most misleading number a study could
produce, so the verdict says something like "1 of 2 occurrences fall inside
archived data; 1 of those completed the full 30-bar horizon" and never claims
more than that.

## The lowest point, not just the ending

> What was the lowest ETH got in the four weeks after each fork, and what
> would a $2,000 short have made?

That question is not about the close thirty days later. It is about the path
in between, and a terminal return cannot answer it. Say "lowest point" (or
highest) and the study measures a second thing: for every covered occurrence,
the lowest low — or highest high — after the entry, inside the horizon, with
the moment it printed. After the entry means after it on the entry basis: on
the default close basis, the entry price is the entry bar's close, so that
bar's own wick printed before the entry existed and never counts — only bars
that closed after the entry do. On the open basis the entry bar counts, its
open being the entry. The moment is the bar, too: a low prints somewhere
inside its candle, and the study claims the bar, never a tick it cannot know.
Both numbers ride the same row, always: the excursion to that extreme, and the
plain close-to-close return, because the honest way to read a best point is
right next to what holding to the end actually did. An excursion can be
adverse — a short whose price only rose reads a positive (money-losing)
excursion exactly as measured, never clamped into a gain.

The dollar figures are arithmetic on those percentages, and they say so. Each
event is illustrated on the full amount independently — one fork, one $2,000,
never a running balance that compounds one event into the next. There are no
fees, no funding, no slippage, no liquidation, and two figures, never one:
what a short closed at the lowest point would have made, labelled
hindsight-perfect, because nobody knew the lowest point in advance and nobody
exits every window at its best tick; and what closing at the horizon's end
would have made. A short profits when price falls, loses when it rises, and
the signs you see follow that rule exactly.

An occurrence the archive cannot reach gets no extremum, only its reason, the
same as always: an invented low is worse than none.

## Why the four-week study is daily bars

The archive does not start everywhere at once. The fine intervals — one
minute, fifteen minutes, four hours — begin recording later than the daily
ones, so a study that asks for 4h bars about events from before the 4h
recorder began can only shrug at them: uncovered, with the reason. The same
events on daily bars are covered and measured.

That is why a four-week study is interval "1d", horizonBars 28: twenty-eight
daily bars are twenty-eight whole days, and the daily archive reaches furthest
back. Ask for the coarsest interval that covers your horizon, and the study
will see the most events it possibly can. The verdict tells you how many it
saw, and the rest are listed, not lost.

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

Putting it on the graph is one call: publish. It measures the set and
publishes the scene in the same breath — there is no second step to forget,
and the scene it hands back, with its id, is the proof it is shown. A study
that was only run stays text in the conversation; its answer even ends by
naming the publish call, so the last sentence points at the graph. And if a
publish fails, it fails out loud: the answer is a refusal with the reason,
never a picture that did not happen.

Publishing does not take the graph over. It stays on Live, and the study's
occurrences arrive right there: each one a named marker at the exact instant
it happened — an upgrade that switched on at one moment is a vertical rule at
that exact millisecond, with its name and UTC time, and the one link the date
is authoritatively stated at; a multi-day event is a band across its span. The
next upcoming date stands in the space to the right of now, waiting. Once, the
graph fits itself so the study is actually in view — a study whose
occurrences run back years resolves to the All range on 1 week bars (and steps
up to 1 month bars when the archive holds more weeks than the chart has room
for) — and then it never moves your range again. If an occurrence is older
than your recorded history, it says so in a note under the chart instead of
drawing a marker where no data exists.

The Range control and the Bars control are separate, because "how much
history" and "how wide is each bar" are different questions: pick 1Y of
history and let the bars be automatic, or name the bars yourself — 1 min
through 1 month, spelled out. A bar width that cannot honestly serve the
range you picked (one week of history on one-week bars is a single bar) falls
back to automatic and says so beside the chart. The label there always names
what is actually drawn.

The graph offers Live, Calendar, and Event aligned as tabs over one frame:
switching views changes the picture, never the layout. In Calendar, one
occurrence at a time fills the chart — the activation as a named vertical rule
at the instant it happened, the entry and the exit as markers pinned to the
exact prices they were measured at, the signed return drawn between them, and
the source the date came from, one link each. In the inspector, each
occurrence's row says when it happened and what kind of when that is — an
exact instant, an exact window, a whole day, or a span recorded before those
distinctions existed, which says exactly that and nothing finer. A
lowest-point study adds its own line per occurrence: the entry, the named
extreme ("lowest low") with its date, the excursion and the terminal return
each beside its money figure on the notional, and under the notional control
the one assumptions sentence those figures ride. The other occurrences, the
study's fine print, and its provenance scroll in the inspector below the
chart, so reading them never pushes the graph around. These markers are
historical measurements, not trades: nothing filled, nothing ordered, and the
label beside them says so. An occurrence the recorded history cannot reach
says why instead of quietly disappearing, and one that ran out of bars before
the horizon says that too.

In Event aligned, the aggregate comes first: the mean event path across every
measured occurrence, drawn heavy, against a dashed Baseline mean reference
line — what the same horizon did at every bar of the window, not just after
the event. Event mean, baseline mean, and the difference between them are
labelled beside the picture, with the horizon and how many occurrences were
covered; the baseline's own median and sample count stay in the detail text,
with the caveat that its windows overlap, which makes it a center-of-mass
comparison, not a significance test. When the served window was too short to
measure a baseline at all, the graph says "Baseline unavailable for this
served window" and draws nothing in its place. Each occurrence's rebased
trace — every path as a percentage of its own entry — sits in the inspector,
so you can ask whether the shapes resemble each other. A dollar figure rides
the traces by default: an illustration on a $1,000 notional you can change,
and any money figure is labelled as the historical gross change on that
notional, before costs. It is never shown as profit, never as a balance.

Every scene carries the same line: historical research, no order placed, not
a forecast. Seeing the study needs nothing armed and nothing funded. You can
ask for a cost-aware backtest or a separate forward validation when either
answers your next question. Neither places an order; execution still requires
its own explicit ask and the normal protections.

## A number needs its threshold

"Did ETH dip massively after each upgrade?" hides a number inside an
adjective, and the study refuses to pick that number for you. Without a
recorded threshold, the tool reports each occurrence's measured excursion —
the distribution — and no hit rate at all, and the honest next step is to
agree on the number out loud: twenty percent? fifteen? Once a threshold is
recorded it travels with the results: the percentage itself (negative for a
dip, positive for a spike), the hit count, the denominator — complete
horizons only, because a window that ran out of bars is not evidence either
way — and, when the threshold was picked only after the results were already
on screen, that fact too, recorded rather than implied. A threshold chosen
after seeing the numbers is a legitimate question to explore; it is just not
a pre-registered expectation, and the report says which it was.

If you ask whether the dips were unusual for the market, the comparison is
matched: the same excursion, measured over every bar of the window, counted
against the same threshold. A dip frequency is never read against terminal
returns — that is a different question with a different label, and both stay
labelled.

## Turn it into an idea, honestly

The moment a study becomes a strategy, the hindsight has to leave. "Short to
the lowest point" cannot be an exit rule: nobody knows the lowest point in
advance, and the tool will refuse to build a rule around it. To take an
event study into a backtest or a forward validation, name a prospective exit
— a stop, a target, or a bar limit — and the idea keeps its event anchor (it
still knows which calendar it was born from) while the exits become rules a
real position could have followed. The per-notional figures along the way
were illustrations on each event independently: one thousand dollars per
event, never a running balance, never a portfolio return, and never a
forecast. A cost-aware replay is where execution realism begins, and it is a
separate question with its own numbers.

## What to keep in mind

A handful of occurrences is a small sample, and the study says so rather than
dressing it up. The numbers are worth having; they are just not evidence, and
the sentence with them never claims otherwise.

Scenes computed before the study's time and coverage semantics were repaired
are still there and still render the numbers they were computed with — but
they say which calculation version they predate, and the honest way to bring
one current is to publish the same recipe again, which writes a new scene.
Nothing is silently recalculated under an old scene's name.

The calendar is yours, not the market's. If a date is wrong, the study is
wrong, which is why every occurrence carries its source and re-recording the
set is one sentence away.
