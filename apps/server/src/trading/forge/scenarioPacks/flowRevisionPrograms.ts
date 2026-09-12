/** Synthetic P7 revision: the same retained pool evidence, gross turnover versus
 * net buying. Thresholds are pool quote-token raw units, never USD. */
export const flowRevisionDetectorSource = (
  sourceId: string,
  metric: "gross" | "net",
  thresholdRaw: string,
): string => `import type { Detect } from "./sdk";
const sourceId = ${JSON.stringify(sourceId)};
const key = ${JSON.stringify(`graph.pool.${metric}-flow-quote-raw`)};
const threshold = BigInt(${JSON.stringify(thresholdRaw)});
export const detect: Detect = (input) => {
  const nextState = { stateSchemaVersion: 1, state: null };
  const source = input.sources.find((row) => row.sourceId === sourceId);
  const fact = input.facts.find((row) => row.key === key &&
    row.evidence.some((evidence) => evidence.sourceId === sourceId));
  if (!source || !source.complete || !fact || fact.value.kind !== "decimal" ||
      fact.value.unit !== "quote-token-raw")
    return { result: { status: "unknown", missingSourceIds: [sourceId],
      explanation: "required flow evidence is unavailable" }, nextState };
  const evidenceIds = [source.evidenceId];
  if (BigInt(fact.value.value) <= threshold)
    return { result: { status: "not-matched", evidenceIds,
      explanation: key + " does not exceed the raw-unit threshold" }, nextState };
  return { result: { status: "matched", occurrenceKey: source.evidenceId + ":" + key,
    evidenceIds, facts: [fact], validUntilMs: input.asOfMs + 1000 }, nextState };
};`;
