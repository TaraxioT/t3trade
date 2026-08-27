import { formatPrice, humanizeLiteral } from "./tradingFormat";
// ---------------------------------------------------------------------------
// harness wakeup messages
// ---------------------------------------------------------------------------
//
// A resumed run's turn begins with the wakeup snapshot injected as the user
// message text (§12.4). Nothing rendered it, so a mission thread read as a wall
// of JSON blobs — one per wake, several a minute at times — with the operator's
// own messages lost between them. The card below is the one-line rendering; the
// payload stays available behind an expander, because the JSON is still the
// authoritative thing the harness was handed.

/** The one line a wakeup message is rendered as. */
export interface WakeupCard {
  /** The §11.2 run cause, humanized. */
  readonly causeLabel: string;
  /**
   * The same cause, verbatim — `market_watch_triggered`, `mission_created`.
   *
   * The label is prose for the reader; this is what the timeline keys its icon
   * and its tone off. A mission wakes several times a minute, and only the
   * event wakes earn the amber accent, so the beacon has to match on the
   * literal rather than on a humanized string that exists to be read.
   */
  readonly cause: string;
  /**
   * The kind of watch that woke the run, when a watch did — `price_cross`,
   * `pnl_above`, `candle_close`. Null when the cause was not a watch, or when
   * the payload did not name one.
   *
   * The cause alone says "a watch fired" but not which sort, and a P&L floor
   * being hit and a price level being crossed are different enough events to
   * be worth different icons.
   */
  readonly triggeringWatchType: string | null;
  /**
   * When the wake happened, in epoch millis. Null when the payload carried no
   * readable timestamp.
   *
   * The timeline uses it to tell a wakeup that has just landed from the
   * hundred a thread opens with, so only the arrival animates. Mount order
   * cannot answer that — opening a thread mounts the whole scrollback at once,
   * and every row would read as new.
   */
  readonly occurredAtMillis: number | null;
  /** True for the `mission_created` bootstrap, which carries no snapshot. */
  readonly bootstrap: boolean;
  /** "ETH · 3,142.50" while a snapshot is present; null on the bootstrap. */
  readonly marketLabel: string | null;
  /** How many coalesced inbox events the run was started with. */
  readonly pendingEventCount: number;
  /** The raw payload, pretty-printed for the expander. */
  readonly rawJson: string;
}

const readString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Read a card out of the flat key=value rendering the server switched the
 * wakeup to (`TradingWakeupComposer.renderWakeup`): a `trading-harness-wakeup`
 * first line, `section:` headers at column 0, and indented `key=value` pairs
 * beneath them. The JSON branch above stays for older persisted messages.
 *
 * Same posture as the JSON parse: every field optional, only the first line
 * decides, and a shape this build does not fully understand still renders as a
 * card over the raw text.
 */
function deriveFlatWakeupCard(text: string): WakeupCard | null {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  if (firstLine.trim() !== "trading-harness-wakeup") return null;

  /** The scalar rendered on its own indented line under a top-level `name:`. */
  const sectionScalar = (name: string): string | null => {
    const match = text.match(new RegExp(`^${name}:\\n\\s+(\\S+)`, "m"));
    return match?.[1] ?? null;
  };
  /** The first `key=value` pair anywhere in the payload. */
  const pairValue = (key: string): string | null => {
    const match = text.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
    return match?.[1] ?? null;
  };
  /** The indented body of a top-level section, or null when absent. */
  const sectionBody = (name: string): string | null => {
    const match = text.match(new RegExp(`^${name}:\\n((?:[ ].*(?:\\n|$))*)`, "m"));
    return match?.[1] ?? null;
  };

  const marketName = pairValue("market");
  const markPriceRaw = pairValue("markPrice");
  const markPrice = markPriceRaw === null ? null : readNumber(Number(markPriceRaw));

  const eventsBody = sectionBody("pendingEvents");
  const pendingEventCount =
    eventsBody === null ? 0 : (eventsBody.match(/^\s*\[\d+\]/gm) ?? []).length;

  const cause = sectionScalar("cause") ?? "wakeup";
  // The `type=` pair inside the triggering watch's own section, so a `type=`
  // belonging to some other section cannot be read as the watch's.
  const watchBody = sectionBody("triggeringWatch");
  const triggeringWatchType = watchBody?.match(/(?:^|\s)type=([^\s]+)/)?.[1] ?? null;

  const occurredAtRaw = sectionScalar("occurredAt");

  return {
    causeLabel: humanizeLiteral(cause),
    cause,
    triggeringWatchType,
    occurredAtMillis: occurredAtRaw === null ? null : readNumber(Number(occurredAtRaw)),
    bootstrap: false,
    marketLabel:
      marketName === null
        ? null
        : markPrice === null
          ? marketName
          : `${marketName} · ${formatPrice(markPrice)}`,
    pendingEventCount,
    rawJson: text,
  };
}

/**
 * Read a wakeup card out of a message's text, or `null` when the text is not a
 * wakeup at all.
 *
 * Deliberately a hand-parse rather than a schema decode: the timeline renders
 * whatever the server sent, and a wakeup that gained a field the web build does
 * not know about must still render as a card rather than falling back to raw
 * JSON. Every field is optional here; only `kind` decides.
 */
export function deriveWakeupCard(text: string): WakeupCard | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("trading-harness-wakeup")) return deriveFlatWakeupCard(trimmed);
  if (!trimmed.startsWith("{") || !trimmed.includes("trading-harness-wakeup")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const payload = parsed as Record<string, unknown>;
  if (payload["kind"] !== "trading-harness-wakeup") return null;

  const market = payload["marketSnapshot"];
  const marketFields =
    typeof market === "object" && market !== null ? (market as Record<string, unknown>) : null;
  const marketName = marketFields === null ? null : readString(marketFields["market"]);
  const markPrice = marketFields === null ? null : readNumber(marketFields["markPrice"]);

  const pendingEvents = payload["pendingEvents"];

  const cause = readString(payload["cause"]) ?? "wakeup";
  const triggeringWatch = payload["triggeringWatch"];
  const watchFields =
    typeof triggeringWatch === "object" && triggeringWatch !== null
      ? (triggeringWatch as Record<string, unknown>)
      : null;
  // The persisted wrapper carries the predicate under `watch`; older payloads
  // put the type on the wrapper itself. Both are read rather than guessed at.
  const watchInner = watchFields?.["watch"];
  const innerFields =
    typeof watchInner === "object" && watchInner !== null
      ? (watchInner as Record<string, unknown>)
      : null;

  return {
    causeLabel: humanizeLiteral(cause),
    cause,
    triggeringWatchType:
      (innerFields === null ? null : readString(innerFields["type"])) ??
      (watchFields === null ? null : readString(watchFields["type"])),
    occurredAtMillis: readNumber(payload["occurredAt"]),
    bootstrap: payload["bootstrap"] === true,
    marketLabel:
      marketName === null
        ? null
        : markPrice === null
          ? marketName
          : `${marketName} · ${formatPrice(markPrice)}`,
    pendingEventCount: Array.isArray(pendingEvents) ? pendingEvents.length : 0,
    rawJson: JSON.stringify(parsed, null, 2),
  };
}
