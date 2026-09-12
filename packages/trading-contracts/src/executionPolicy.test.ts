/**
 * Execution-policy contracts, held to their own rules.
 *
 * Round trips for every schema; discriminator refusals (wrong `kind`
 * literal, a DetectionResult-shaped payload is not a proposal); the
 * envelope's candidate-uniqueness, distinct-token, count, and cap-bound
 * refusals at their exact boundaries; the quote expiry ordering; the quote
 * content identity (deterministic, component-sensitive, and agreeing with
 * Web Crypto over the canonical serialization); the fail-closed budget math;
 * the refusal vocabulary's type/array agreement; and the smoke that the
 * neighboring detector vocabularies still decode.
 *
 * @module TradingExecutionPolicy.test
 */
import { assert, describe, it } from "@effect/vitest";

import { Schema } from "effect";

import { DetectorEvaluationRecordV2, detectorEvaluationId } from "./detectorProgram.ts";
import { EvidenceRef } from "./researchEvidence.ts";
import {
  DetectorResultForPolicy,
  EXECUTION_ENVELOPE_CANDIDATES_MAX,
  EXECUTION_ENVELOPE_MAX_CONCURRENT_INTENTS,
  EXECUTION_ENVELOPE_MAX_SLIPPAGE_BPS,
  EXECUTION_REFUSALS,
  ExecutionEnvelope,
  ExecutionEnvelopeStatus,
  ExecutionIntentStatus,
  ExecutionProposal,
  type ExecutionRefusal,
  PersistedProposalRecord,
  PersistedProposalStatus,
  POLICY_EXPLANATION_MAX_CHARS,
  POLICY_PRIOR_PROPOSALS_MAX,
  PolicyProgramInputV2,
  PolicyProgramOutputV2,
  PersistedProposalSummary,
  proposalId,
  serializeProposalIdentity,
  SwapCandidate,
  SwapIntentRecord,
  SwapIntentStatus,
  SwapQuoteRecord,
  remainingInputBudget,
  serializeSwapIntentIdentity,
  serializeSwapQuoteIdentity,
  swapIntentId,
  swapQuoteId,
  withinInputBudget,
} from "./executionPolicy.ts";

const decode = <A>(schema: Schema.Schema<A>, input: unknown): boolean => Schema.is(schema)(input);

const hex64 = (char: string): string => char.repeat(64);

/** `0x` + 40 hex characters — a well-formed 20-byte address. */
const addr = (char: string): string => `0x${char.repeat(40)}`;

const weth = addr("a");
const usdc = addr("b");
const recipient = addr("c");

const candidate = {
  candidateId: "cand_weth_usdc",
  chainId: "11155111",
  tokenIn: weth,
  tokenOut: usdc,
  recipient,
  label: "WETH -> USDC",
} as const;

const envelope = {
  revision: 1,
  environmentId: "env-1",
  accountId: "acct-1",
  expiresAtMs: 1_700_000_600_000,
  detectorBundleSha256: hex64("a"),
  policyBundleSha256: hex64("b"),
  candidates: [candidate],
  inputCapTotalRaw: "1000000000000000000",
  inputCapPerSwapRaw: "100000000000000000",
  maxGasWei: "200000000000000000",
  maxSlippageBps: 50,
  maxTransactions: 4,
  maxConcurrentIntents: 2,
} as const;

const quoteIdentity = {
  chainId: "11155111",
  routeId: "v4-quoter-single",
  tokenIn: weth,
  tokenOut: usdc,
  amountInRaw: "1000000000000000",
  minAmountOutRaw: "900000000",
  quotedAtMs: 1_700_000_000_000,
} as const;

const quote = {
  quoteId: swapQuoteId(quoteIdentity),
  ...quoteIdentity,
  gasEstimateWei: "150000000000000",
  expiresAtMs: 1_700_000_030_000,
  basis: "eth_call",
} as const;

const proposals = {
  wait: { kind: "wait" },
  price: { kind: "price", candidateId: "cand_weth_usdc", reason: "spread widened" },
  swap: {
    kind: "swap",
    candidateId: "cand_weth_usdc",
    amountInRaw: "1000000000000000",
    quoteId: swapQuoteId(quoteIdentity),
    occurrenceKey: "occ-1",
    stageKey: "entry",
    detectorEvaluationId: "dtev_1",
  },
  stop: { kind: "stop-future-actions", reason: "depeg signal" },
  complete: { kind: "complete", summary: "rebalance finished" },
} as const;

describe("swap candidates", () => {
  it("round-trips with and without a label", () => {
    assert.isTrue(decode(SwapCandidate, candidate));
    // Decode (not just validate): struct decode strips excess properties, so
    // only a decoded-value check proves the schema itself carries the field.
    const decoded = Schema.decodeSync(SwapCandidate)(candidate);
    assert.strictEqual(decoded.recipient, recipient);
    assert.strictEqual(decoded.tokenIn, weth);
    const { label: _label, ...unlabeled } = candidate;
    assert.isTrue(decode(SwapCandidate, unlabeled));
  });

  it("refuses empty ids, non-decimal chain ids, and empty labels", () => {
    assert.isFalse(decode(SwapCandidate, { ...candidate, candidateId: "" }));
    assert.isFalse(decode(SwapCandidate, { ...candidate, chainId: "0" }));
    assert.isFalse(decode(SwapCandidate, { ...candidate, chainId: "sepolia" }));
    assert.isFalse(decode(SwapCandidate, { ...candidate, label: "" }));
  });

  it("refuses addresses that are not exactly 0x + 40 hex", () => {
    // The loose primitives `EvmAddress` (`0x${string}`) would accept these;
    // the execution vocabulary may not, because routing keys on them.
    assert.isFalse(decode(SwapCandidate, { ...candidate, tokenIn: "0xabc" }));
    assert.isFalse(decode(SwapCandidate, { ...candidate, tokenOut: `0x${"d".repeat(41)}` }));
    assert.isFalse(decode(SwapCandidate, { ...candidate, recipient: `0x${"e".repeat(39)}` }));
    assert.isFalse(decode(SwapCandidate, { ...candidate, recipient: "not-an-address" }));
  });
});

describe("the execution envelope", () => {
  it("round-trips a two-candidate envelope", () => {
    assert.isTrue(
      decode(ExecutionEnvelope, {
        ...envelope,
        candidates: [
          candidate,
          { ...candidate, candidateId: "cand_usdc_weth", tokenIn: usdc, tokenOut: weth },
        ],
      }),
    );
  });

  it("refuses non-positive or non-integer revisions", () => {
    assert.isFalse(decode(ExecutionEnvelope, { ...envelope, revision: 0 }));
    assert.isFalse(decode(ExecutionEnvelope, { ...envelope, revision: 1.5 }));
  });

  it("accepts 1 and 16 candidates, refuses 0 and 17", () => {
    const candidateAt = (index: number) => ({ ...candidate, candidateId: `cand_${index}` });
    const withCount = (count: number) => ({
      ...envelope,
      candidates: Array.from({ length: count }, (_, index) => candidateAt(index)),
    });
    assert.isTrue(decode(ExecutionEnvelope, withCount(1)));
    assert.isTrue(decode(ExecutionEnvelope, withCount(EXECUTION_ENVELOPE_CANDIDATES_MAX)));
    assert.isFalse(decode(ExecutionEnvelope, withCount(0)));
    assert.isFalse(decode(ExecutionEnvelope, withCount(EXECUTION_ENVELOPE_CANDIDATES_MAX + 1)));
  });

  it("enforces slippage and concurrency bounds at their exact boundaries", () => {
    assert.isTrue(decode(ExecutionEnvelope, { ...envelope, maxSlippageBps: 0 }));
    assert.isTrue(
      decode(ExecutionEnvelope, {
        ...envelope,
        maxSlippageBps: EXECUTION_ENVELOPE_MAX_SLIPPAGE_BPS,
      }),
    );
    assert.isFalse(
      decode(ExecutionEnvelope, {
        ...envelope,
        maxSlippageBps: EXECUTION_ENVELOPE_MAX_SLIPPAGE_BPS + 1,
      }),
    );
    assert.isFalse(decode(ExecutionEnvelope, { ...envelope, maxSlippageBps: -1 }));

    assert.isTrue(decode(ExecutionEnvelope, { ...envelope, maxConcurrentIntents: 1 }));
    assert.isTrue(
      decode(ExecutionEnvelope, {
        ...envelope,
        maxConcurrentIntents: EXECUTION_ENVELOPE_MAX_CONCURRENT_INTENTS,
      }),
    );
    assert.isFalse(
      decode(ExecutionEnvelope, {
        ...envelope,
        maxConcurrentIntents: EXECUTION_ENVELOPE_MAX_CONCURRENT_INTENTS + 1,
      }),
    );
    assert.isFalse(decode(ExecutionEnvelope, { ...envelope, maxConcurrentIntents: 0 }));

    assert.isFalse(decode(ExecutionEnvelope, { ...envelope, maxTransactions: 0 }));
  });

  it("refuses malformed bundle digests and non-exact cap strings", () => {
    assert.isFalse(decode(ExecutionEnvelope, { ...envelope, detectorBundleSha256: "abc" }));
    assert.isFalse(decode(ExecutionEnvelope, { ...envelope, policyBundleSha256: hex64("z") }));
    for (const field of ["inputCapTotalRaw", "inputCapPerSwapRaw", "maxGasWei"] as const) {
      assert.isFalse(decode(ExecutionEnvelope, { ...envelope, [field]: "-5" }));
      assert.isFalse(decode(ExecutionEnvelope, { ...envelope, [field]: "1.5" }));
      assert.isFalse(decode(ExecutionEnvelope, { ...envelope, [field]: "01" }));
    }
  });

  it("refuses duplicate candidate ids", () => {
    assert.isFalse(
      decode(ExecutionEnvelope, {
        ...envelope,
        candidates: [candidate, { ...candidate, tokenIn: usdc, tokenOut: addr("d") }],
      }),
    );
  });

  it("refuses a candidate whose tokens are the same address", () => {
    assert.isFalse(
      decode(ExecutionEnvelope, {
        ...envelope,
        candidates: [{ ...candidate, tokenOut: weth }],
      }),
    );
  });
});

describe("execution proposals", () => {
  it("round-trips every member of the union", () => {
    for (const proposal of Object.values(proposals)) {
      assert.isTrue(decode(ExecutionProposal, proposal));
    }
  });

  it("refuses wrong discriminator literals and foreign vocabularies", () => {
    assert.isFalse(decode(ExecutionProposal, { kind: "execute" }));
    assert.isFalse(decode(ExecutionProposal, { kind: "swop", candidateId: "cand_weth_usdc" }));
    // A detection result is the DETECTOR's vocabulary, not the policy's output.
    assert.isFalse(
      decode(ExecutionProposal, {
        status: "matched",
        occurrenceKey: "occ-1",
        evidenceIds: [],
        facts: [],
        validUntilMs: 1,
      }),
    );
  });

  it("refuses swap proposals with missing bindings or inexact amounts", () => {
    const { quoteId: _quoteId, ...withoutQuote } = proposals.swap;
    assert.isFalse(decode(ExecutionProposal, withoutQuote));
    assert.isFalse(decode(ExecutionProposal, { ...proposals.swap, amountInRaw: "1.5" }));
    assert.isFalse(decode(ExecutionProposal, { ...proposals.swap, occurrenceKey: "" }));
    assert.isFalse(decode(ExecutionProposal, { ...proposals.swap, detectorEvaluationId: "" }));
  });

  it("refuses empty reasons and summaries on the textual members", () => {
    assert.isFalse(decode(ExecutionProposal, { ...proposals.price, reason: "" }));
    assert.isFalse(decode(ExecutionProposal, { ...proposals.stop, reason: "" }));
    assert.isFalse(decode(ExecutionProposal, { ...proposals.complete, summary: "" }));
  });
});

describe("the swap quote record", () => {
  it("round-trips with its content-derived id", () => {
    assert.isTrue(decode(SwapQuoteRecord, quote));
  });

  it("refuses quotes that do not expire strictly after they were taken", () => {
    assert.isFalse(decode(SwapQuoteRecord, { ...quote, expiresAtMs: quote.quotedAtMs }));
    assert.isFalse(decode(SwapQuoteRecord, { ...quote, expiresAtMs: quote.quotedAtMs - 1 }));
  });

  it("refuses unnamed bases and malformed fields", () => {
    assert.isFalse(decode(SwapQuoteRecord, { ...quote, basis: "simulation" }));
    assert.isFalse(decode(SwapQuoteRecord, { ...quote, basis: "eth_call-simulated" }));
    assert.isFalse(decode(SwapQuoteRecord, { ...quote, routeId: "" }));
    assert.isFalse(decode(SwapQuoteRecord, { ...quote, minAmountOutRaw: "-1" }));
    assert.isFalse(decode(SwapQuoteRecord, { ...quote, tokenIn: "0xabc" }));
  });
});

describe("the quote content identity", () => {
  it("is deterministic and sq_-shaped", () => {
    assert.strictEqual(swapQuoteId(quoteIdentity), swapQuoteId(quoteIdentity));
    assert.match(swapQuoteId(quoteIdentity), /^sq_[0-9a-f]{24}$/);
  });

  it("changes when any identity component changes", () => {
    const baseline = swapQuoteId(quoteIdentity);
    // The identity input shape, widened off the `as const` fixture's literals.
    type QuoteIdentity = Parameters<typeof swapQuoteId>[0];
    const changed = (patch: Partial<QuoteIdentity>): string =>
      swapQuoteId({ ...quoteIdentity, ...patch });
    assert.notStrictEqual(changed({ chainId: "1" }), baseline);
    assert.notStrictEqual(changed({ routeId: "v4-quoter-multi" }), baseline);
    assert.notStrictEqual(changed({ tokenIn: addr("f") }), baseline);
    assert.notStrictEqual(changed({ tokenOut: addr("e") }), baseline);
    assert.notStrictEqual(changed({ amountInRaw: "1000000000000001" }), baseline);
    assert.notStrictEqual(changed({ minAmountOutRaw: "900000001" }), baseline);
    assert.notStrictEqual(changed({ quotedAtMs: quoteIdentity.quotedAtMs + 1 }), baseline);
  });

  it("agrees with the platform SHA-256 over the canonical identity serialization", async () => {
    // Web Crypto is the reference (no node builtin import — this package
    // keeps node out of its type environment); varied lengths cross the
    // single-block/multi-block padding boundaries of the pure implementation.
    const referenceSha256Hex = async (value: string): Promise<string> => {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      );
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const samples = [
      quoteIdentity,
      {
        chainId: "1",
        routeId: "r",
        tokenIn: addr("1"),
        tokenOut: addr("2"),
        amountInRaw: "1",
        minAmountOutRaw: "0",
        quotedAtMs: 0,
      },
      {
        chainId: "11155111",
        routeId: "a-route-identifier-of-considerable-length-for-padding-boundaries",
        tokenIn: addr("c"),
        tokenOut: addr("d"),
        amountInRaw: "123456789012345678901234567890",
        minAmountOutRaw: "987654321098765432109876543210",
        quotedAtMs: 1_799_999_999_999,
      },
    ];
    for (const sample of samples) {
      const expected = `sq_${(await referenceSha256Hex(serializeSwapQuoteIdentity(sample))).slice(0, 24)}`;
      assert.strictEqual(swapQuoteId(sample), expected);
    }
  });
});

describe("the input budget math", () => {
  it("admits a positive amount within both caps, including exactly at them", () => {
    assert.isTrue(withinInputBudget({ proposedRaw: "5", perSwapCapRaw: "10", remainingRaw: "50" }));
    assert.isTrue(
      withinInputBudget({ proposedRaw: "10", perSwapCapRaw: "10", remainingRaw: "10" }),
    );
    // Exactness survives beyond Number.MAX_SAFE_INTEGER.
    assert.isTrue(
      withinInputBudget({
        proposedRaw: "1000000000000000000",
        perSwapCapRaw: "1000000000000000000",
        remainingRaw: "1000000000000000000",
      }),
    );
  });

  it("refuses zero, over-cap, and over-remaining proposals", () => {
    assert.isFalse(
      withinInputBudget({ proposedRaw: "0", perSwapCapRaw: "10", remainingRaw: "50" }),
    );
    assert.isFalse(
      withinInputBudget({ proposedRaw: "11", perSwapCapRaw: "10", remainingRaw: "50" }),
    );
    assert.isFalse(withinInputBudget({ proposedRaw: "5", perSwapCapRaw: "10", remainingRaw: "4" }));
  });

  it("refuses malformed inputs without throwing, fail closed", () => {
    const malformed = ["", "-1", "1.5", "0x10", "01", "1e3", " 1"];
    for (const value of malformed) {
      assert.isFalse(
        withinInputBudget({ proposedRaw: value, perSwapCapRaw: "10", remainingRaw: "50" }),
      );
      assert.isFalse(
        withinInputBudget({ proposedRaw: "5", perSwapCapRaw: value, remainingRaw: "50" }),
      );
      assert.isFalse(
        withinInputBudget({ proposedRaw: "5", perSwapCapRaw: "10", remainingRaw: value }),
      );
    }
    // A JavaScript caller passing a number: still false, never a throw.
    assert.isFalse(
      withinInputBudget({
        proposedRaw: 5 as unknown as string,
        perSwapCapRaw: "10",
        remainingRaw: "50",
      }),
    );
  });
});

describe("the remaining budget math", () => {
  it("subtracts settled and in-flight spend exactly", () => {
    assert.strictEqual(
      remainingInputBudget({ capTotalRaw: "1000", settledRaw: "300", inFlightRaw: "200" }),
      "500",
    );
    assert.strictEqual(
      remainingInputBudget({
        capTotalRaw: "1000000000000000000000",
        settledRaw: "1",
        inFlightRaw: "0",
      }),
      "999999999999999999999",
    );
  });

  it("floors at zero on exact depletion and on over-subscription", () => {
    assert.strictEqual(
      remainingInputBudget({ capTotalRaw: "100", settledRaw: "100", inFlightRaw: "0" }),
      "0",
    );
    assert.strictEqual(
      remainingInputBudget({ capTotalRaw: "100", settledRaw: "100", inFlightRaw: "1" }),
      "0",
    );
    assert.strictEqual(
      remainingInputBudget({ capTotalRaw: "0", settledRaw: "0", inFlightRaw: "0" }),
      "0",
    );
  });

  it("returns 0 on malformed inputs without throwing, fail closed", () => {
    const malformed = ["", "-1", "1.5", "0x10", "01", "1e3", " 1"];
    for (const value of malformed) {
      assert.strictEqual(
        remainingInputBudget({ capTotalRaw: value, settledRaw: "1", inFlightRaw: "1" }),
        "0",
      );
      assert.strictEqual(
        remainingInputBudget({ capTotalRaw: "10", settledRaw: value, inFlightRaw: "1" }),
        "0",
      );
      assert.strictEqual(
        remainingInputBudget({ capTotalRaw: "10", settledRaw: "1", inFlightRaw: value }),
        "0",
      );
    }
    assert.strictEqual(
      remainingInputBudget({
        capTotalRaw: 10 as unknown as string,
        settledRaw: "1",
        inFlightRaw: "1",
      }),
      "0",
    );
  });
});

describe("statuses", () => {
  it("decodes every envelope status and refuses foreign ones", () => {
    for (const status of ["draft", "proposed", "approved", "revoked", "expired"] as const) {
      assert.isTrue(decode(ExecutionEnvelopeStatus, status));
    }
    assert.isFalse(decode(ExecutionEnvelopeStatus, "active"));
    assert.isFalse(decode(ExecutionEnvelopeStatus, "unknown"));
  });

  it("decodes every intent status and refuses the Forge legacy ones", () => {
    for (const status of [
      "proposed",
      "quoted",
      "admitted",
      "prepared",
      "submitted",
      "confirmed",
      "reverted",
      "refused",
      "expired",
      "cancelled-before-submission",
      "unknown",
    ] as const) {
      assert.isTrue(decode(ExecutionIntentStatus, status));
    }
    // The Forge intent statuses are a separate vocabulary; they must not
    // leak into execution intents.
    assert.isFalse(decode(ExecutionIntentStatus, "draft"));
    assert.isFalse(decode(ExecutionIntentStatus, "settled"));
  });
});

describe("the refusal vocabulary", () => {
  // One entry per union member: the record fails to compile if a member is
  // added to ExecutionRefusal without a key here, and the loop below fails
  // if the array does not cover the record exactly.
  const coverage: Record<ExecutionRefusal, true> = {
    "envelope-revoked": true,
    "envelope-expired": true,
    "envelope-not-approved": true,
    "budget-exhausted": true,
    "stale-evidence": true,
    "stale-quote": true,
    "occurrence-already-executed": true,
    "stage-already-executed": true,
    "bundle-changed": true,
    "route-unapproved": true,
    unconfigured: true,
    paused: true,
    "broadcaster-missing": true,
  };

  it("is the exact frozen vocabulary, in the declared order, without duplicates", () => {
    assert.isTrue(Object.isFrozen(EXECUTION_REFUSALS));
    assert.strictEqual(new Set(EXECUTION_REFUSALS).size, EXECUTION_REFUSALS.length);
    assert.deepStrictEqual(EXECUTION_REFUSALS, [
      "envelope-revoked",
      "envelope-expired",
      "envelope-not-approved",
      "budget-exhausted",
      "stale-evidence",
      "stale-quote",
      "occurrence-already-executed",
      "stage-already-executed",
      "bundle-changed",
      "route-unapproved",
      "unconfigured",
      "paused",
      "broadcaster-missing",
    ]);
  });

  it("the array and the type cover exactly the same members", () => {
    for (const refusal of EXECUTION_REFUSALS) {
      assert.strictEqual(coverage[refusal], true);
    }
    assert.strictEqual(EXECUTION_REFUSALS.length, Object.keys(coverage).length);
  });
});

describe("legacy compatibility", () => {
  it("the neighboring detector vocabularies still decode beside the execution contracts", () => {
    // Additive-only change: these schemas have their own suites; this is the
    // smoke that the execution contracts did not disturb them.
    assert.isTrue(
      decode(EvidenceRef, {
        id: "ev_1",
        environmentId: "env-1",
        sourceId: "src_graph_1",
        mode: "live",
        contentSha256: hex64("a"),
        eventAtMs: 1_700_000_000_000,
        availableAtMs: 1_700_000_001_000,
        availabilityBasis: "recorded",
        timePrecision: "second",
        capturedAtMs: 1_700_000_002_000,
        expiresAtMs: 1_700_000_600_000,
        sourceRevision: "rev-1",
      }),
    );

    const evaluationIdentity = {
      environmentId: "env-1",
      capabilityId: "net-flow-detector",
      version: 3,
      stateRevision: 7,
      inputDigest: hex64("b"),
    } as const;
    assert.isTrue(
      decode(DetectorEvaluationRecordV2, {
        manifestVersion: 2,
        evaluationId: detectorEvaluationId(evaluationIdentity),
        ...evaluationIdentity,
        asOfMs: 1_700_000_060_000,
        result: {
          status: "not-matched",
          evidenceIds: ["ev_1"],
          explanation: "flow below threshold",
        },
        state: { stateSchemaVersion: 1, state: { high: 0 } },
        evidenceIds: ["ev_1"],
        committedAtMs: 1_700_000_061_000,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Sealed policy-program I/O and persisted proposal records (P5.3)
// ---------------------------------------------------------------------------

/** A minimal matched-evaluation summary for the policy input fixtures. */
const matchedEvaluation = {
  evaluationId: "dtev_1",
  asOfMs: 1_700_000_060_000,
  result: {
    status: "matched",
    occurrenceKey: "occ-1",
    validUntilMs: 1_700_000_120_000,
  },
} as const;

const priorProposal = {
  stageKey: "entry",
  kind: "swap",
  amountInRaw: "1000000000000000",
  occurredAtMs: 1_700_000_100_000,
} as const;

const policyInput = {
  policySchemaVersion: 2,
  asOfMs: 1_700_000_150_000,
  envelope,
  detectorEvaluation: matchedEvaluation,
  priorProposals: [priorProposal],
  remainingInputCapRaw: "900000000000000000",
} as const;

describe("the detector result mirror for policy input", () => {
  it("decodes all three shapes", () => {
    assert.isTrue(decode(DetectorResultForPolicy, matchedEvaluation.result));
    assert.isTrue(
      decode(DetectorResultForPolicy, { status: "not-matched", explanation: "flag not set" }),
    );
    assert.isTrue(
      decode(DetectorResultForPolicy, { status: "unknown", explanation: "source lagging" }),
    );
  });

  it("bounds the authoritative full result and refuses over-long explanations", () => {
    // The authoritative DetectionResult carries facts and evidence arrays the
    // mirror must not pass through: decoding the full result yields exactly
    // the bounded shape (structural decode drops what the mirror does not
    // declare), so nothing beyond the bound can cross this boundary.
    const fullResult: unknown = {
      status: "matched",
      occurrenceKey: "occ-1",
      evidenceIds: ["ev_1"],
      facts: [
        {
          id: "fact_1",
          key: "flag",
          entityId: "pool-a",
          value: { kind: "boolean", value: true },
          evidence: [],
        },
      ],
      validUntilMs: 1,
    };
    const bounded = Schema.decodeUnknownSync(DetectorResultForPolicy)(fullResult);
    assert.deepStrictEqual(bounded, { status: "matched", occurrenceKey: "occ-1", validUntilMs: 1 });
    // A shape the mirror does not declare at all still refuses.
    assert.isFalse(decode(DetectorResultForPolicy, { status: "matched", occurrenceKey: "occ-1" }));
    const exactly = "x".repeat(POLICY_EXPLANATION_MAX_CHARS);
    assert.isTrue(decode(DetectorResultForPolicy, { status: "unknown", explanation: exactly }));
    assert.isFalse(
      decode(DetectorResultForPolicy, {
        status: "not-matched",
        explanation: `${exactly}x`,
      }),
    );
  });
});

describe("the sealed policy program input", () => {
  it("round-trips with and without a prior state", () => {
    assert.isTrue(decode(PolicyProgramInputV2, policyInput));
    assert.isTrue(
      decode(PolicyProgramInputV2, {
        ...policyInput,
        priorState: { stateSchemaVersion: 1, state: { count: 2 } },
      }),
    );
  });

  it("refuses the wrong schema generation and a non-2 literal", () => {
    assert.isFalse(decode(PolicyProgramInputV2, { ...policyInput, policySchemaVersion: 1 }));
    assert.isFalse(decode(PolicyProgramInputV2, { ...policyInput, policySchemaVersion: 3 }));
  });

  it("bounds the prior-proposals window at exactly 20", () => {
    const window = (count: number) => ({
      ...policyInput,
      priorProposals: Array.from({ length: count }, (_, index) => ({
        stageKey: `stage-${index}`,
        kind: "swap" as const,
        amountInRaw: "1",
        occurredAtMs: 1,
      })),
    });
    assert.isTrue(decode(PolicyProgramInputV2, window(POLICY_PRIOR_PROPOSALS_MAX)));
    assert.isFalse(decode(PolicyProgramInputV2, window(POLICY_PRIOR_PROPOSALS_MAX + 1)));
  });

  it("refuses malformed envelopes, remaining caps, and summaries", () => {
    assert.isFalse(
      decode(PolicyProgramInputV2, {
        ...policyInput,
        envelope: { ...envelope, revision: 0 },
      }),
    );
    assert.isFalse(decode(PolicyProgramInputV2, { ...policyInput, remainingInputCapRaw: "1.5" }));
    // A summary's amount must be exact when present, and its kind is closed.
    assert.isFalse(
      decode(PolicyProgramInputV2, {
        ...policyInput,
        priorProposals: [{ ...priorProposal, amountInRaw: "0.5" }],
      }),
    );
    assert.isFalse(
      decode(PolicyProgramInputV2, {
        ...policyInput,
        priorProposals: [{ ...priorProposal, kind: "swop" }],
      }),
    );
  });
});

describe("the policy program output", () => {
  it("round-trips a swap proposal with its next state", () => {
    assert.isTrue(
      decode(PolicyProgramOutputV2, {
        proposal: proposals.swap,
        nextState: { stateSchemaVersion: 1, state: { stages: 1 } },
      }),
    );
  });

  it("refuses a detection result where a proposal belongs", () => {
    assert.isFalse(
      decode(PolicyProgramOutputV2, {
        proposal: matchedEvaluation.result,
        nextState: null,
      }),
    );
    assert.isFalse(decode(PolicyProgramOutputV2, { proposal: { kind: "wait" } }));
  });
});

describe("the persisted proposal record", () => {
  const record = {
    proposalId: "pprop_1",
    envelopeRevision: 1,
    environmentId: "env-1",
    capabilityId: "net-flow-detector",
    detectorEvaluationId: "dtev_1",
    proposal: proposals.swap,
    proposedAtMs: 1_700_000_150_000,
    status: "proposed",
  } as const;

  it("round-trips, and decodes every status", () => {
    assert.isTrue(decode(PersistedProposalRecord, record));
    for (const status of ["proposed", "rejected", "executing", "executed", "superseded"] as const) {
      assert.isTrue(decode(PersistedProposalStatus, status));
    }
    assert.isFalse(decode(PersistedProposalStatus, "confirmed"));
    assert.isFalse(decode(PersistedProposalStatus, "quoted"));
  });

  it("requires the capability id pattern and a positive revision", () => {
    assert.isFalse(
      decode(PersistedProposalRecord, { ...record, capabilityId: "not a capability id" }),
    );
    assert.isFalse(decode(PersistedProposalRecord, { ...record, envelopeRevision: 0 }));
  });
});

describe("the proposal content identity", () => {
  const identity = {
    envelopeRevision: 1,
    capabilityId: "net-flow-detector",
    detectorEvaluationId: "dtev_1",
    stageKey: "entry",
    proposedAtMs: 1_700_000_150_000,
  } as const;

  it("is deterministic and pprop_-shaped", () => {
    assert.strictEqual(proposalId(identity), proposalId(identity));
    assert.match(proposalId(identity), /^pprop_[0-9a-f]{24}$/);
  });

  it("changes when any identity component changes, and null is a distinct stage slot", () => {
    const baseline = proposalId(identity);
    type ProposalIdentity = Parameters<typeof proposalId>[0];
    const changed = (patch: Partial<ProposalIdentity>): string =>
      proposalId({ ...identity, ...patch });
    assert.notStrictEqual(changed({ envelopeRevision: 2 }), baseline);
    assert.notStrictEqual(changed({ capabilityId: "other-detector" }), baseline);
    assert.notStrictEqual(changed({ detectorEvaluationId: "dtev_2" }), baseline);
    assert.notStrictEqual(changed({ stageKey: "exit" }), baseline);
    assert.notStrictEqual(changed({ proposedAtMs: identity.proposedAtMs + 1 }), baseline);
    // A non-swap proposal's null stage is its own identity, never equal to a
    // named stage (and never a string "null").
    const nullStage = changed({ stageKey: null });
    assert.notStrictEqual(nullStage, baseline);
    assert.notStrictEqual(nullStage, changed({ stageKey: "null" }));
  });

  it("agrees with the platform SHA-256 over the canonical identity serialization", async () => {
    const referenceSha256Hex = async (value: string): Promise<string> => {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      );
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const samples: Array<Parameters<typeof proposalId>[0]> = [
      identity,
      {
        envelopeRevision: 12,
        capabilityId: "a-rather-longer-capability-identifier",
        detectorEvaluationId: "dtev_abcdefghijklmnopqrstuvwxyz0123456789",
        stageKey: null,
        proposedAtMs: 1_799_999_999_999,
      },
      {
        envelopeRevision: 1,
        capabilityId: "x",
        detectorEvaluationId: "d",
        stageKey: "a-stage-key-of-considerable-length-for-padding-boundaries",
        proposedAtMs: 0,
      },
    ];
    for (const sample of samples) {
      const expected = `pprop_${(await referenceSha256Hex(serializeProposalIdentity(sample))).slice(0, 24)}`;
      assert.strictEqual(proposalId(sample), expected);
    }
  });
});

describe("the swap intent record", () => {
  const record = {
    intentId: "sint_1",
    environmentId: "env-1",
    envelopeId: "env_1",
    proposalId: "pprop_1",
    quoteId: "sq_1",
    routeId: "weth-usdc-500",
    tokenIn: weth,
    tokenOut: usdc,
    amountInRaw: "1000000",
    minAmountOutRaw: "900000",
    recipient,
    swapTargetAddress: "0x9b6b46e2c869aa39918db7f52f5557fe577b6eee",
    preparedTxJson:
      '{"chainId":11155111,"data":"0x","gasWei":"1","nonce":null,"to":"0x1","value":"0"}',
    status: "prepared",
    preparedAtMs: 1_700_000_200_000,
  } as const;

  it("round-trips, and decodes every status of the one-way machine", () => {
    assert.isTrue(decode(SwapIntentRecord, record));
    for (const status of [
      "prepared",
      "submit-refused",
      "submitted",
      "confirmed",
      "reverted",
      "unknown",
    ] as const) {
      assert.isTrue(decode(SwapIntentStatus, status));
    }
    // Foreign vocabularies refuse: the F0 intent statuses and the general
    // ExecutionIntentStatus are NOT swap-intent statuses.
    assert.isFalse(decode(SwapIntentStatus, "draft"));
    assert.isFalse(decode(SwapIntentStatus, "admitted"));
    assert.isFalse(decode(SwapIntentStatus, "refused"));
  });

  it("round-trips the optional attempt fields and refuses malformed ones", () => {
    assert.isTrue(
      decode(SwapIntentRecord, {
        ...record,
        attemptAtMs: 1_700_000_201_000,
        refusalReason: "broadcaster-missing: no signer is wired",
      }),
    );
    // Amounts stay exact decimal strings and addresses stay 20-byte hex.
    assert.isFalse(decode(SwapIntentRecord, { ...record, amountInRaw: "1.5" }));
    assert.isFalse(decode(SwapIntentRecord, { ...record, recipient: "0x1234" }));
    assert.isFalse(decode(SwapIntentRecord, { ...record, preparedTxJson: "" }));
  });
});

describe("the swap intent content identity", () => {
  const identity = {
    proposalId: "pprop_1",
    quoteId: "sq_1",
    preparedTxJson: '{"to":"0x1","data":"0x"}',
  } as const;

  it("is deterministic and sint_-shaped", () => {
    assert.strictEqual(swapIntentId(identity), swapIntentId(identity));
    assert.match(swapIntentId(identity), /^sint_[0-9a-f]{24}$/);
  });

  it("changes when the proposal, the quote, or the prepared bytes change", () => {
    const baseline = swapIntentId(identity);
    type IntentIdentity = Parameters<typeof swapIntentId>[0];
    const changed = (patch: Partial<IntentIdentity>): string =>
      swapIntentId({ ...identity, ...patch });
    // A changed quote (the superseded-quote rule) and changed prepared
    // transaction bytes (any field of the canonical tx) both mint new ids.
    assert.notStrictEqual(changed({ quoteId: "sq_2" }), baseline);
    assert.notStrictEqual(changed({ preparedTxJson: '{"to":"0x2","data":"0x"}' }), baseline);
    assert.notStrictEqual(
      changed({ proposalId: "pprop_other" }),
      changed({ proposalId: "pprop_third" }),
    );
  });

  it("agrees with the platform SHA-256 over the canonical identity serialization", async () => {
    const referenceSha256Hex = async (value: string): Promise<string> => {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      );
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const sample = {
      proposalId: "pprop_abcdefghijklmnopqrstuvwxyz",
      quoteId: "sq_0123456789abcdef",
      preparedTxJson:
        '{"chainId":11155111,"data":"0x1234567890","gasWei":"40000000000000000","nonce":null,"to":"0x9b6b46e2c869aa39918db7f52f5557fe577b6eee","value":"0"}',
    };
    const expected = `sint_${(await referenceSha256Hex(serializeSwapIntentIdentity(sample))).slice(0, 24)}`;
    assert.strictEqual(swapIntentId(sample), expected);
  });
});
