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
  EXECUTION_ENVELOPE_CANDIDATES_MAX,
  EXECUTION_ENVELOPE_MAX_CONCURRENT_INTENTS,
  EXECUTION_ENVELOPE_MAX_SLIPPAGE_BPS,
  EXECUTION_REFUSALS,
  ExecutionEnvelope,
  ExecutionEnvelopeStatus,
  ExecutionIntentStatus,
  ExecutionProposal,
  type ExecutionRefusal,
  SwapCandidate,
  SwapQuoteRecord,
  remainingInputBudget,
  serializeSwapQuoteIdentity,
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
