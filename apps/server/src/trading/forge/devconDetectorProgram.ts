/**
 * devconDetectorProgram — the Devcon entry detector's authored program
 * content (Worker B, direction 07-direction-supersession.md).
 *
 * The detector combines:
 *
 * 1. A CALENDAR arm — the verified next-Devcon dates (Devcon 8: 3–6 November
 *    2026, Mumbai; fetched from devcon.org on 2026-09-13) as research-frozen
 *    program constants, gated by LIVE external calendar evidence retained
 *    through the generated calendar capability's revision chain
 *    (`external:devcon-calendar:...`). The gate is presence-and-current, not
 *    a date read from free text: the DetectorFactWindow's external facts
 *    carry only publication booleans/instants (the P3 discipline), so the
 *    dates themselves come from the retained STUDY the constants cite. A
 *    retracted or missing calendar document is unknown, never matched.
 * 2. An ONCHAIN arm — exact-integer net WETH acquisition by traders over one
 *    complete Substreams window of the WETH/USDC pool, against a threshold
 *    FIXED FROM THE STUDY, never retuned after arming.
 *
 * Smallest honest design recorded: the calendar side consumes the existing
 * `external:` evidence branch as its presence gate and pins the entry window
 * as program constants cited to the retained study. It does NOT invent a new
 * calendar-fact vocabulary, and no substreams-independent date fact is added
 * to the window service.
 *
 * PLACEHOLDER FREEZE NOTICE: the constants below were authored against the
 * study DESIGN (pre-30d entry lead, daily bars, close basis). At integration
 * the real retained study (GraphEventWindowStudyService, `ges_…` id recorded
 * in the artifact) re-freezes them; the detector logic does not change, and
 * the thresholds are not retuned to make any particular day qualify.
 *
 * Authored content only — the builder-flow staging (prepare → author → check
 * with host acceptance cases) and the semantic-revision proof live in
 * devconDetectorProgram.test.ts. Nothing here runs outside containment.
 *
 * @module devconDetectorProgram
 */

/** The capability's stable id (FORGE_CAPABILITY_ID_PATTERN shape). */
export const DEVCON_DETECTOR_CAPABILITY_ID = "devcon-entry-detector";

/** Worker A's generated calendar adapter's retained document identity. */
export const DEVCON_CALENDAR_SOURCE_ID = "external:devcon-calendar:devcon-8-mumbai-2026";

/** The onchain arm's stream binding: 1h windows of the WETH/USDC 0.05% pool. */
export const DEVCON_STREAM_SOURCE_ID = "substreams:weth-usdc-005:3600000";

/** Research-frozen entry window (UTC ms): 30 days before Devcon 8 starts. */
export const DEVCON_ENTRY_WINDOW_START_MS = Date.parse("2026-10-04T00:00:00Z");
export const DEVCON_ENTRY_WINDOW_END_MS = Date.parse("2026-11-03T00:00:00Z");

/**
 * The semantic revision's tightened calendar: the last 7 days before the
 * event. IDENTICAL evidence inside the 30d window but outside the 7d one
 * flips matched → not-matched — the G4 proof, no host branches.
 */
export const DEVCON_REVISED_ENTRY_WINDOW_START_MS = Date.parse("2026-10-27T00:00:00Z");

/**
 * Onchain threshold: trader net WETH acquisition over one complete 1h window,
 * exact raw wei. Placeholder research freeze (1 WETH = 1e18) — replaced by
 * the study's measured entry-window flow statistics at integration.
 */
export const DEVCON_NET_WETH_THRESHOLD_RAW = "1000000000000000000";

/** One logical occurrence: the pre-Devcon-8 entry window, fired at most once. */
export const DEVCON_OCCURRENCE_KEY = "devcon-8-entry-window";

/**
 * The v1 detector source. Exact-integer arithmetic only: the flow comparison
 * is BigInt over the sealed decimal fact; no float, no USD conversion, no
 * inference from unsigned volume.
 */
export const devconDetectorSourceV1 = (): string => `import type {
  Detect,
  DetectorProgramInput,
  DetectorProgramOutput,
} from "./sdk";

// Research-frozen constants. Cited study: the Devcon event-window study
// (GraphEventWindowStudyService; entry lead 30d, daily bars, close basis).
// These are NEVER retuned after arming; a revision that changes semantics is
// a new program version with new acceptance, not an edit here in place.
const calendarSourceId = ${JSON.stringify(DEVCON_CALENDAR_SOURCE_ID)};
const streamSourceId = ${JSON.stringify(DEVCON_STREAM_SOURCE_ID)};
const calendarDocument = "devcon-8-mumbai-2026";
const entryWindowStartMs = ${DEVCON_ENTRY_WINDOW_START_MS};
const entryWindowEndMs = ${DEVCON_ENTRY_WINDOW_END_MS};
// token1 of this pool is WETH: the pool's signed net token1 delta, negated,
// is the traders' net WETH acquisition (positive = net buying).
const netWethThresholdRaw = BigInt(${JSON.stringify(DEVCON_NET_WETH_THRESHOLD_RAW)});
const occurrenceKey = ${JSON.stringify(DEVCON_OCCURRENCE_KEY)};

export const detect: Detect = (input: DetectorProgramInput): DetectorProgramOutput => {
  const prior = (input.priorState ?? {}) as { evaluations?: number };
  const nextState = {
    stateSchemaVersion: 1,
    state: { evaluations: (prior.evaluations ?? 0) + 1 },
  };

  const calendar = input.sources.find((row) => row.sourceId === calendarSourceId);
  const stream = input.sources.find((row) => row.sourceId === streamSourceId);
  const missingSourceIds: string[] = [];
  if (calendar === undefined || !calendar.complete) missingSourceIds.push(calendarSourceId);
  if (stream === undefined || !stream.complete) missingSourceIds.push(streamSourceId);
  if (missingSourceIds.length > 0) {
    return {
      result: {
        status: "unknown",
        missingSourceIds,
        explanation:
          "the calendar evidence or the substreams window is unavailable or incomplete",
      },
      nextState,
    };
  }

  // Calendar presence gate: the retained Devcon-8 calendar document must be
  // published and current (a retracted latest resolves as absence above).
  const calendarPublished = input.facts.some(
    (fact) =>
      fact.key === "external.document.published" &&
      fact.entityId === calendarDocument &&
      fact.value.kind === "boolean" &&
      fact.value.value === true &&
      fact.evidence.some((ref) => ref.sourceId === calendarSourceId),
  );
  if (!calendarPublished) {
    return {
      result: {
        status: "unknown",
        missingSourceIds: [calendarSourceId],
        explanation:
          "the calendar document is present but its publication fact did not resolve",
      },
      nextState,
    };
  }

  // Calendar arm: the host clock inside the research-frozen entry window.
  if (input.asOfMs < entryWindowStartMs || input.asOfMs >= entryWindowEndMs) {
    return {
      result: {
        status: "not-matched",
        evidenceIds: [calendar!.evidenceId],
        explanation:
          "outside the research-fixed Devcon entry window [" +
          entryWindowStartMs +
          ", " +
          entryWindowEndMs +
          ")",
      },
      nextState,
    };
  }

  // Onchain arm: exact signed net token1 (WETH) flow over the complete window.
  const netFact = input.facts.find(
    (fact) =>
      fact.key === "stream.window.net-amount1-raw" &&
      fact.value.kind === "decimal" &&
      fact.value.unit === "token1-raw" &&
      fact.evidence.some((ref) => ref.id === stream!.evidenceId),
  );
  if (netFact === undefined || netFact.value.kind !== "decimal") {
    return {
      result: {
        status: "unknown",
        missingSourceIds: [streamSourceId],
        explanation: "the sealed window's net-flow fact failed its schema or unit contract",
      },
      nextState,
    };
  }
  const traderNetWethRaw = -BigInt(netFact.value.value);
  if (traderNetWethRaw < netWethThresholdRaw) {
    return {
      result: {
        status: "not-matched",
        evidenceIds: [stream!.evidenceId],
        explanation:
          "trader net WETH acquisition " +
          traderNetWethRaw.toString() +
          " raw is below the study-frozen threshold " +
          netWethThresholdRaw.toString(),
      },
      nextState,
    };
  }

  return {
    result: {
      status: "matched",
      occurrenceKey,
      evidenceIds: [calendar!.evidenceId, stream!.evidenceId],
      facts: [netFact],
      validUntilMs: entryWindowEndMs,
    },
    nextState,
  };
};`;

/**
 * The v2 SEMANTIC REVISION: the calendar arm tightened to the final 7 days
 * before Devcon 8. Everything else is byte-identical logic, so on identical
 * sealed evidence inside the 30d window but outside the 7d one, v1 matches
 * and v2 does not — a justified flip from program semantics alone.
 */
export const devconDetectorSourceV2 = (): string =>
  devconDetectorSourceV1().replace(
    `const entryWindowStartMs = ${DEVCON_ENTRY_WINDOW_START_MS};`,
    `const entryWindowStartMs = ${DEVCON_REVISED_ENTRY_WINDOW_START_MS};`,
  );

/** The generated test file (the `acceptance` role) both versions carry. */
export const devconDetectorTestSource =
  (): string => `import { describe, expect, test } from "./sdk";
import { detect } from "./detector";

describe("devcon entry detector", () => {
  test("detect is exported and total", () => {
    expect(detect).toBeDefined();
  });
});
`;
