/**
 * The one mission fixture every number in the cockpit replica traces to
 * (DESIGN-CONTRACT, "One mission state drives everything"). Every level, size,
 * dollar figure, time and count the replica renders lives here; the components
 * under src/components/replica hold no literal mission digits of their own.
 */
import {
  formatChangePercent,
  formatPrice,
  formatSignedPercent,
  formatSignedUsd,
} from "./format";
import type { BeatName } from "./beats";
import type { IconName } from "./icons";

/* ── The mission console ───────────────────────────────────────────────────
   Every level, size, and dollar figure below is a BTC range-break long whose
   target is the live spot the run was rewritten against ($76,763, Coinbase
   BTC-USD, 2026-08-21). The candles between those levels are drawn from a
   fixed seed at build time: the levels are the record, the shape between
   them is an illustration. */
export interface MissionFixture {
  readonly market: string;
  readonly leverage: string;
  readonly side: string;
  readonly size: number;
  readonly entry: number;
  readonly stop: number;
  readonly wake: number;
  readonly trigger: number;
  readonly mark: number;
  readonly target: number;
  readonly liquidation: number;
  readonly margin: number;
}

export const MISSION: MissionFixture = {
  market: "BTC",
  leverage: "20x",
  side: "Long",
  size: 0.0536,
  entry: 75810.4,
  stop: 75460.9,
  wake: 75634.5,
  trigger: 75778.7,
  mark: 76024.1,
  target: 76763,
  liquidation: 71614.9,
  margin: 206,
};

export const risk = (MISSION.entry - MISSION.stop) * MISSION.size; // 18.72
export const reward = (MISSION.target - MISSION.entry) * MISSION.size; // 51.06
export const open = (MISSION.mark - MISSION.entry) * MISSION.size; // 11.45
export const rr = reward / risk;

/* The drawdown the position has to survive on the way to the target. It comes
   within $222 of the stop without touching it, which is the whole argument
   for putting the stop on the exchange in the first place. */
export const DIP_PRICE = 75682.7;
export const dipPnl = (DIP_PRICE - MISSION.entry) * MISSION.size; // -6.84

/* The 24h change the chart header prints next to the price, computed from the
   same reel so the two figures can never disagree. */
export const DAY_OPEN = 75259.1;

export const CANDLE_COUNT = 48;
export const BREAK_INDEX = 33;

/* Anchored walk: a range, a shakeout under it, the reclaim, then the run. */
const ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 75715.3], [8, 75792.5], [14, 75682.8], [22, 75772.2], [27, 75548.8],
  [31, 75691.0], [33, 75782.8], [37, 75906.2], [41, 75963.1], [45, 76003.7], [47, 76024.1],
];

export interface MissionCandle {
  readonly open: number;
  readonly close: number;
  readonly high: number;
  readonly low: number;
  readonly up: boolean;
}

function missionSeries(): MissionCandle[] {
  let seed = 20260814;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const at = (index: number) => {
    for (let a = 0; a < ANCHORS.length - 1; a += 1) {
      const [i0, p0] = ANCHORS[a]!;
      const [i1, p1] = ANCHORS[a + 1]!;
      if (index <= i1) return p0 + ((p1 - p0) * (index - i0)) / (i1 - i0);
    }
    return ANCHORS[ANCHORS.length - 1]![1];
  };

  return Array.from({ length: CANDLE_COUNT }, (_, index) => {
    const openPrice = at(index) + (rand() - 0.5) * 20.3;
    const closePrice = at(index + 1) + (rand() - 0.5) * 20.3;
    return {
      open: openPrice,
      close: closePrice,
      high: Math.max(openPrice, closePrice) + rand() * 22.4,
      low: Math.min(openPrice, closePrice) - rand() * 22.4,
      up: closePrice >= openPrice,
    };
  });
}

export const candles = missionSeries();

/* Where the record stops and the plan starts. The mark is the last price the
   exchange actually reported; everything to its right is what the target and
   the stop commit the mission to, drawn dashed and labelled as a plan. */
/* The low sits at t = 0.5 so the wipe uncovers it on the same scroll step the
   PnL reel bottoms out. The number and the line hit their worst point
   together, which is the whole reason the drawdown is here. */
/* Neither half of the run is a straight line. On the way down two bounces
   fail before the low; on the way up the break is retested and the run pulls
   back twice before the target prints. */
export const PLAN: ReadonlyArray<readonly [number, number]> = [
  [0.0, MISSION.mark],
  [0.09, 75926.6],
  [0.18, 75999.7],
  [0.28, 75833.1],
  [0.37, 75922.5],
  [0.44, 75747.8],
  [0.5, DIP_PRICE],
  [0.57, 75869.7],
  [0.63, 75796.6],
  [0.71, 76105.3],
  [0.77, 76007.8],
  [0.85, 76393.7],
  [0.91, 76275.9],
  [1.0, MISSION.target],
];

/* The price rows the chart rules its frame with. */
export const GRID_PRICES: readonly number[] = [75400, 76000, 76600];

/* The interval pill docked on the chart's mark row. */
export const CHART_INTERVAL = "5m";

/* ── The PnL reel ───────────────────────────────────────────────────────────
   The PnL walks the whole arc on one reel: up to the open figure, down
   through the drawdown, then out to the target. Each stop on the reel carries
   its own colour, so the number goes red when the position is under water
   without any extra machinery. */
const ramp = (from: number, to: number, steps: number) =>
  Array.from({ length: steps }, (_, step) => from + ((to - from) * (step + 1)) / steps);

/* 10 + 8 + 14 = 32 steps, the figure the pnl-count keyframes and every
   reel's resting transform are written against. */
export const RUN_STEPS = 10;
export const DIP_STEPS = 8;
export const TARGET_STEPS = 14;

export const pnlArc: readonly number[] = [
  0,
  ...ramp(0, open, RUN_STEPS),
  ...ramp(open, dipPnl, DIP_STEPS),
  ...ramp(dipPnl, reward, TARGET_STEPS),
];

/* Progress toward the target, floored at zero. Below the entry there is no
   progress to report, and a negative percentage reads as a bug. */
export const pctArc: readonly number[] = pnlArc.map((value) =>
  Math.max(0, Math.round((value / reward) * 100)),
);

/* Return on the margin the position ties up, which is the second figure the
   app's header prints next to the dollar one. It is the same reel divided by
   the same margin, so the two numbers can never disagree. */
export const roiArc: readonly string[] = pnlArc.map((value) =>
  formatSignedPercent((value / MISSION.margin) * 100),
);

/* The mark the PnL implies, so the readout never claims a price and a profit
   that disagree. Step zero is the fill and the last step is the target. */
export const markArc: readonly string[] = pnlArc.map((value) =>
  formatPrice(MISSION.entry + value / MISSION.size),
);

/* The 24h change the chart header prints next to the price. */
export const chgArc: readonly string[] = pnlArc.map((value) =>
  formatChangePercent(((MISSION.entry + value / MISSION.size - DAY_OPEN) / DAY_OPEN) * 100),
);

/* The two figures the risk/reward strip prints, already formatted. */
export const riskLabel = formatSignedUsd(-risk);
export const rewardLabel = formatSignedUsd(reward);

/* ── The agent log ──────────────────────────────────────────────────────────
   The agent log, in the app's own row grammar: a tone glyph, a rail, the
   sentence, and a right-aligned figure with its time. Each row owns the same
   slice of the pinned scroll that its chart annotation owns, so the feed and
   the chart never disagree about what has happened yet. */
export type LogTone = "info" | "armed" | "fired" | "buy" | "stop" | "loss" | "check" | "win";

export interface LogRow {
  /* The beat the row lands in, and its slot (fraction) within that beat.
     Together they place the row on the one mission timeline; see beats.ts. */
  readonly at: BeatName;
  readonly slot: number;
  readonly time: string;
  readonly tone: LogTone;
  /* The lucide glyph the app's log token carries (rendered at 11px,
     strokeWidth 2, from src/lib/icons.ts - never a unicode character). */
  readonly glyph: IconName;
  readonly text: string;
  readonly value: string;
  readonly valueTone?: "up" | "down";
}

export const LOG: readonly LogRow[] = [
  { at: "survey", slot: 0, time: "01:44 PM", tone: "info", glyph: "Eye", text: "Looked at the market · overnight range intact, 75,460 defended", value: "75,593.5" },
  { at: "survey", slot: 0, time: "01:45 PM", tone: "fired", glyph: "AlarmClock", text: "Woke on a level · giveback alert from the last session", value: "$0.75" },
  { at: "survey", slot: 1 / 8, time: "01:46 PM", tone: "info", glyph: "CircleSlash", text: "Watch retired · giveback alert · replaced", value: "$0.75" },
  { at: "survey", slot: 1 / 8, time: "01:47 PM", tone: "info", glyph: "NotebookPen", text: "Journal note · flat overnight, costs re-checked", value: "-" },
  { at: "survey", slot: 1 / 8, time: "01:49 PM", tone: "info", glyph: "Eye", text: "Looked at the market · 15m compression under the range high", value: "75,650.3" },
  { at: "survey", slot: 2 / 8, time: "01:51 PM", tone: "armed", glyph: "Radar", text: "Watch armed · 1m close above the session high", value: "75,715.3" },
  { at: "survey", slot: 2 / 8, time: "01:53 PM", tone: "fired", glyph: "Zap", text: "Watch fired · thread woken with fresh data", value: "75,707.2" },
  { at: "survey", slot: 3 / 8, time: "01:53 PM", tone: "info", glyph: "Eye", text: "Stood aside · the pop failed the pullback gate", value: "-" },
  { at: "survey", slot: 3 / 8, time: "01:56 PM", tone: "info", glyph: "NotebookPen", text: "Journal note · ATR gate tightened one notch", value: "1.9×" },
  { at: "survey", slot: 3 / 8, time: "01:58 PM", tone: "info", glyph: "Eye", text: "Looked at the market · volume drying up into the range mid", value: "75,670.7" },
  { at: "survey", slot: 4 / 8, time: "02:00 PM", tone: "armed", glyph: "Radar", text: "Watch armed · mark crosses above the range high", value: "75,723.5" },
  { at: "survey", slot: 4 / 8, time: "02:01 PM", tone: "info", glyph: "CircleSlash", text: "Watch retired · 1m close watch · cancelled", value: "75,715.3" },
  { at: "survey", slot: 5 / 8, time: "02:01 PM", tone: "info", glyph: "Eye", text: "Looked at the market · 1m closes pinning the range floor", value: "75,682.8" },
  { at: "survey", slot: 5 / 8, time: "02:02 PM", tone: "info", glyph: "NotebookPen", text: "Journal note · taker only on the break, no chasing", value: "0.045%" },
  { at: "survey", slot: 6 / 8, time: "02:02 PM", tone: "info", glyph: "Eye", text: "Looked at the market · funding flat, no carry either way", value: "0.0013%" },
  { at: "survey", slot: 6 / 8, time: "02:02 PM", tone: "info", glyph: "Route", text: "Mission created · long only, 20x ceiling", value: "$50 budget" },
  { at: "survey", slot: 7 / 8, time: "02:03 PM", tone: "info", glyph: "NotebookPen", text: "Plan published: long the range break", value: `→ ${formatPrice(MISSION.target)}` },
  { at: "plan", slot: 0, time: "02:03 PM", tone: "info", glyph: "NotebookPen", text: "Journal note · risk capped at $50, budget untouched", value: "$50" },
  { at: "plan", slot: 1 / 9, time: "02:03 PM", tone: "info", glyph: "Eye", text: "Looked at the market · 1m closes pinning the range floor", value: "75,682.8" },
  { at: "plan", slot: 3 / 9, time: "02:03 PM", tone: "info", glyph: "Eye", text: "Stood aside · first push into the range failed the pullback gate", value: "-" },
  { at: "plan", slot: 6 / 9, time: "02:03 PM", tone: "armed", glyph: "Radar", text: "Watch armed · 15m close above the range high", value: "75,715.3" },
  { at: "watch-armed", slot: 0, time: "02:04 PM", tone: "armed", glyph: "Radar", text: "Watch armed · mark crosses above", value: formatPrice(MISSION.trigger) },
  { at: "watch-armed", slot: 4 / 14, time: "02:11 PM", tone: "fired", glyph: "AlarmClock", text: "Woke on a level · range high tagged, no entry yet", value: "75,723.5" },
  { at: "watch-armed", slot: 8 / 14, time: "02:18 PM", tone: "info", glyph: "Eye", text: "Looked at the market · break gone quiet, wait for the 15m close", value: "75,703.1" },
  { at: "watch-armed", slot: 11 / 14, time: "02:24 PM", tone: "info", glyph: "NotebookPen", text: "Journal note · ATR gate tightened one notch", value: "1.9×" },
  { at: "trigger-hit", slot: 0, time: "03:41 PM", tone: "fired", glyph: "Zap", text: "Watch fired · thread woken with fresh data", value: "75,784.4" },
  { at: "trigger-hit", slot: 4 / 15, time: "03:41 PM", tone: "info", glyph: "NotebookPen", text: "Stop moved · reduce-only bracket tightened to the entry", value: formatPrice(MISSION.stop) },
  { at: "trigger-hit", slot: 7 / 15, time: "03:41 PM", tone: "check", glyph: "ShieldCheck", text: "Preview passed · order signed locally", value: "14/14" },
  { at: "trigger-hit", slot: 12 / 15, time: "03:41 PM", tone: "armed", glyph: "Radar", text: "Watch armed · drawdown alert below the risk line", value: formatPrice(MISSION.stop) },
  { at: "entry", slot: 0, time: "03:41 PM", tone: "buy", glyph: "TrendingUp", text: `Bought to open ${MISSION.size} BTC`, value: formatPrice(MISSION.entry) },
  { at: "stop-placed", slot: 0, time: "03:42 PM", tone: "stop", glyph: "TrendingDown", text: "Reduce-only stop resting on-exchange", value: formatPrice(MISSION.stop) },
  { at: "stop-placed", slot: 4 / 6, time: "03:44 PM", tone: "armed", glyph: "Radar", text: "Watch armed · 5m close above the trigger confirms", value: formatPrice(MISSION.trigger) },
  { at: "wake-set", slot: 3 / 4, time: "04:02 PM", tone: "fired", glyph: "AlarmClock", text: "Woke on a level · confirmation close printed", value: "75,833.1" },
  /* The operator's follow-up, sent from the composer while the position
     holds the mark: the typed line and the send pop are the composer's own
     beat in Composer.astro; this row is the system's reply in the feed. */
  { at: "wedge-open", slot: 0.35, time: "04:20 PM", tone: "check", glyph: "Check", text: "Follow-up received · take-profit confirmed at the target", value: formatPrice(MISSION.target) },
  { at: "wedge-open", slot: 4 / 10, time: "04:31 PM", tone: "info", glyph: "NotebookPen", text: "Journal note · hold through the retest, stop untouched", value: "-" },
  { at: "drawdown", slot: 0, time: "04:58 PM", tone: "loss", glyph: "Activity", text: "Drawdown held · stop untouched, nothing sold", value: formatSignedUsd(dipPnl), valueTone: "down" },
  { at: "drawdown", slot: 6 / 8, time: "05:10 PM", tone: "info", glyph: "CircleSlash", text: "Watch retired · drawdown alert · cancelled", value: formatPrice(MISSION.stop) },
  { at: "stop-holds", slot: 4 / 7, time: "05:20 PM", tone: "info", glyph: "Eye", text: "Looked at the market · extension stretched, target next", value: formatPrice(MISSION.target) },
  { at: "target-hit", slot: 0, time: "05:24 PM", tone: "win", glyph: "Receipt", text: `Sold to close ${MISSION.size} BTC at ${formatPrice(MISSION.target)}`, value: formatSignedUsd(reward), valueTone: "up" },
];

/* The stream's settled tail line. */
export const EARLIER_TURNS = 51;

/* The sidebar and breadcrumb fixtures were removed with the surfaces
   themselves: the replica crops to the mission panel and the capsule, and
   carries no thread list, no search row, no project path. */

/* Quiet content behind the glass: soft colour pools and a muted
   transcript-like wash, so the card frost has something to refract instead of
   reading matte. */
export const BG_LINES: readonly string[] = [
  "gives back $0.40 on the push into 76,750",
  "15m close watch armed below 76,140",
  "the downside break is stale, buying pressure is weak",
  "scheduled reassessment in 15 minutes",
  "structure remains mixed, standing aside",
  `sold to close ${MISSION.size} BTC at 76,152.7`,
  "reduce-only stop resting on-exchange",
  "woke on a level, fresh data pulled",
  "the retest held, nothing to do",
];

export const BG_LINES_RIGHT: readonly string[] = [
  `Bought to open ${MISSION.size} BTC at 76,231.6`,
  `Sold to close ${MISSION.size} BTC at 76,152.7`,
  "Bought to close the short 0.0621 BTC",
  "Sold to open a short 0.0381 BTC",
  "watch fired, thread woken",
  "2 watches retired",
  "Wakeup scheduled reassessment · BTC",
  "no edge after costs, standing aside",
];

/* ── Positions card fixtures ──────────────────────────────────────────────── */
/* The open legs' clock stamps, in the card's right column. */
export const POS_TIMES = { open: "03:41 PM", stop: "03:42 PM" } as const;

export interface SettledPositionFixture {
  readonly side: "long" | "short";
  readonly leverage: string;
  readonly entry: number;
  readonly notional: string;
  readonly pnl: string;
  readonly time: string;
}

/* The settled history under the live narrative rows, present from scroll
   start like the app's waiting state. */
export const SETTLED_POSITIONS: readonly SettledPositionFixture[] = [
  { side: "short", leverage: "1x", entry: 76405.9, notional: "$500", pnl: "-$0.41", time: "06:51 PM" },
  { side: "short", leverage: "1x", entry: 76377.5, notional: "$500", pnl: "-$0.22", time: "06:50 PM" },
  { side: "long", leverage: "1x", entry: 76485.5, notional: "$500", pnl: "-$0.13", time: "06:04 PM" },
  { side: "long", leverage: "1x", entry: 76470.9, notional: "$500", pnl: "-$0.22", time: "05:58 PM" },
];

/* ── Status bar fixtures ──────────────────────────────────────────────────── */
export const STATUSBAR = {
  funding: "Funding 0.0013%/8h",
  targetBy: "5:24 PM",
} as const;

/* ── Composer fixtures ────────────────────────────────────────────────────── */
export const COMPOSER = {
  model: "GPT-5.6-Luna",
} as const;

/* ── The fourteen checks ────────────────────────────────────────────────────
   Source of truth: ENTRY_CHECKS in
   apps/server/src/trading/TradingPreviewService.ts (the 14 §16.3 entry
   items). If that list changes, this number changes with it in the same
   commit, along with Checks.astro's title, lede, verdict, and tally CSS. */
export const CHECK_COUNT = 14;

/* Six of the fourteen, named the way the preview tool names them. */
export interface PreviewCheckFixture {
  readonly label: string;
  readonly detail: string;
}

export const PREVIEW_CHECKS: readonly PreviewCheckFixture[] = [
  { label: "mission active, entries allowed", detail: "authority current" },
  { label: "market, side, and leverage allowed", detail: "within mandate" },
  { label: "account and order book fresh", detail: "live exchange data" },
  { label: "size, price, and minimum valid", detail: "exchange rules" },
  { label: "position and mission risk available", detail: "usd loss budget" },
  { label: "reduce-only stop attached", detail: "required" },
];

export const CONTROLS: readonly string[] = ["Pause", "Cancel entries", "Reduce 50%", "Close", "Revoke"];

/* ── Timing helpers shared by every scrubbed surface ──────────────────────── */

/* Scroll-slice timing now lives in beats.ts: one ordered list of named
   beats, and helpers that turn a beat (or a slice/span of beats) into the
   `--from`/`--to` pair the shared scroll layer reads. */

/* Headlines resolve one word at a time as the section scrolls past, so each
   word needs its own slice of the shared view timeline. */
export function kineticWords(sentence: string) {
  return sentence.split(" ").map((word, index) => ({
    word,
    range: `entry ${10 + index * 3}% cover ${36 + index * 3}%`,
  }));
}
