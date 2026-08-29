/**
 * Reading a trading tool result, for the cards that render one.
 *
 * The backtest, validation and hypothesis cards each grew this reader by
 * hand, identically, because each was built against the same transport and
 * the same posture: a hand-parse rather than a schema decode, so a result
 * that gained a field this build does not know about still renders. It lives
 * here once now, with the tiny unknown-readers the cards parse with.
 *
 * @module cardPayload
 */

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

export const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** The tone a signed dollar figure carries, for colouring a stat line. */
export const signedTone = (value: number): "positive" | "negative" | "neutral" =>
  value > 0 ? "positive" : value < 0 ? "negative" : "neutral";

/** JSON, or null when the text is a summary line rather than a payload. */
export function parseCardJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Truncated or not JSON at all. The ordinary tool row still renders it.
    return null;
  }
}

/**
 * The result out of a tool call, through whichever shape the transport used.
 *
 * The ACP adapters name the tool bare in `tool`; the Claude adapter names it
 * MCP-qualified in `toolName` (`mcp__t3-trade__trading_backtest`). Matching
 * the suffix covers both without caring which server mounted it.
 *
 * The transport wraps every result as `content: [{type: "text", text}]` with
 * the JSON inside the text, so it is unwrapped one level and parsed. A result
 * that is already an object is taken as it is, because that is what the
 * handler returns before the transport touches it and what the tests build.
 */
export function readTradingCardResult(toolData: unknown, toolName: string): unknown {
  const item = asRecord(toolData);
  if (item === null) return null;
  const name = typeof item.tool === "string" ? item.tool : item.toolName;
  if (typeof name !== "string" || !name.endsWith(toolName)) return null;
  const result = asRecord(item.result);
  if (result === null) return null;

  // The server's activity projection collapses an MCP result to `{content:
  // "<text>"}` on the way to a client. For the card-bearing tools it keeps the
  // whole text rather than a one-line summary (see `MCP_RESULTS_KEPT_WHOLE`),
  // so the string case is the one that actually arrives over the wire; the
  // array case is the raw transport shape, and the bare object is what the
  // handler returns before either touches it.
  const content = result.content;
  if (typeof content === "string") return parseCardJson(content);
  if (!Array.isArray(content)) return result;
  for (const entry of content) {
    const text = asRecord(entry)?.text;
    if (typeof text !== "string") continue;
    return parseCardJson(text);
  }
  return null;
}
