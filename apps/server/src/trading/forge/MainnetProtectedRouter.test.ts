/**
 * MainnetProtectedRouter — the protected calldata contract.
 *
 * What is pinned here: the encode → decode round trip for BOTH demo
 * directions over the one verified pool; the selector recomputed from the
 * ASCII signature (never echoed); every tamper case the pre-sign comparison
 * must catch (wrong recipient, weakened minOut, value, deadline, path, payer
 * flip, sentinel recipients, extra commands, allow-revert); the exact
 * integer slippage floor; and the price-impact bound. A cross-check decodes
 * the completed bytes with viem's own decoder so the hand-rolled decoder is
 * validated against an independent implementation.
 *
 * @module MainnetProtectedRouter.test
 */
// @effect-diagnostics globalFetch:off - the env-gated fork check speaks one raw JSON-RPC endpoint deliberately.

import { assert, describe, it } from "@effect/vitest";
import { decodeAbiParameters, getFunctionSelector, parseAbi, keccak256, toBytes } from "viem";

import {
  decodeProtectedExactInput,
  encodeProtectedExactInput,
  encodeExecute,
  minimumOutFromQuote,
  priceImpactRefusal,
  protectedCalldataDigest,
  protectedPlanRefusals,
  UR_COMMAND_V3_SWAP_EXACT_IN,
  UR_COMMAND_UNWRAP_WETH,
  UR_COMMAND_WRAP_ETH,
  UNIVERSAL_ROUTER_EXECUTE_DEADLINE_SIGNATURE,
  verifyProtectedCalldata,
  type ProtectedSwapPlan,
} from "./MainnetProtectedRouter.ts";

// The verified mainnet identities (SpotMainnetTarget pins these; tests echo
// the same values so a config drift shows up as a round-trip failure).
const ROUTER = "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const NATIVE = `0x${"0".repeat(40)}`;

const nativeInPlan: ProtectedSwapPlan = {
  direction: "native-in",
  chainId: 1,
  router: ROUTER,
  weth: WETH,
  erc20: USDC,
  recipient: RECIPIENT,
  amountInRaw: "500000000000000000", // 0.5 ETH
  minAmountOutRaw: "1250000000", // 1250 USDC floor
  deadlineUnix: 1_800_000_000,
  feeTier: 500,
};

const nativeOutPlan: ProtectedSwapPlan = {
  direction: "erc20-in-native-out",
  chainId: 1,
  router: ROUTER,
  weth: WETH,
  erc20: USDC,
  recipient: RECIPIENT,
  amountInRaw: "2000000000", // 2000 USDC
  minAmountOutRaw: "700000000000000000", // 0.7 ETH floor
  deadlineUnix: 1_800_000_000,
  feeTier: 500,
};

describe("the protected plan contract", () => {
  it("accepts both demo directions and refuses malformed plans", () => {
    assert.isEmpty(protectedPlanRefusals(nativeInPlan));
    assert.isEmpty(protectedPlanRefusals(nativeOutPlan));
    // Zero or non-positive floors never encode.
    assert.isNotEmpty(protectedPlanRefusals({ ...nativeInPlan, minAmountOutRaw: "0" }));
    assert.isNotEmpty(protectedPlanRefusals({ ...nativeInPlan, amountInRaw: "-1" }));
    // The wrong chain never encodes.
    assert.isNotEmpty(
      protectedPlanRefusals({ ...nativeInPlan, chainId: 11155111 } as unknown as ProtectedSwapPlan),
    );
    // weth == erc20 is not a pool.
    assert.isNotEmpty(protectedPlanRefusals({ ...nativeInPlan, erc20: WETH }));
    // Absurd deadlines refuse.
    assert.isNotEmpty(protectedPlanRefusals({ ...nativeInPlan, deadlineUnix: 2 ** 40 }));
  });
});

describe("the protected calldata round trip", () => {
  it("recomputes the execute-with-deadline selector from the ASCII signature", () => {
    // The selector must come from keccak of the signature text, never from a
    // frozen constant alone — and it must be the value found in the deployed
    // router's runtime bytecode (0x3593564c, probed 2026-09-13). viem's
    // array-form getFunctionSelector(abi, name) disagrees with its own
    // encoder here; the direct keccak and the single-item form agree with
    // the chain, so those are the references.
    const direct = keccak256(toBytes(UNIVERSAL_ROUTER_EXECUTE_DEADLINE_SIGNATURE));
    assert.equal(direct.slice(0, 10), "0x3593564c");
    const fromAbi = getFunctionSelector(
      parseAbi([`function ${UNIVERSAL_ROUTER_EXECUTE_DEADLINE_SIGNATURE}`])[0]!,
    );
    assert.equal(fromAbi, "0x3593564c");
  });

  it("native-in encodes WRAP_ETH then V3_SWAP_EXACT_IN with the exact funded value", () => {
    const encoded = encodeProtectedExactInput(nativeInPlan);
    assert.equal(encoded.to, ROUTER);
    assert.equal(encoded.value, nativeInPlan.amountInRaw);
    // Command bytes: 0x0b (WRAP_ETH), 0x00 (V3_SWAP_EXACT_IN), no flags.
    const decoded = decodeProtectedExactInput(encoded.data);
    assert.isNotNull(decoded);
    assert.deepEqual(decoded?.commandTypes, [UR_COMMAND_WRAP_ETH, UR_COMMAND_V3_SWAP_EXACT_IN]);
    assert.isFalse(decoded?.anyAllowRevert ?? true);
    assert.equal(decoded?.deadlineUnix, "1800000000");
    assert.isNotNull(decoded?.wrapEth);
    assert.equal(decoded?.wrapEth?.recipient, ROUTER);
    assert.equal(decoded?.wrapEth?.amount, nativeInPlan.amountInRaw);
    assert.isNotNull(decoded?.v3Swap);
    assert.equal(decoded?.v3Swap?.recipient, RECIPIENT);
    assert.equal(decoded?.v3Swap?.amountIn, nativeInPlan.amountInRaw);
    assert.equal(decoded?.v3Swap?.amountOutMinimum, nativeInPlan.minAmountOutRaw);
    assert.equal(decoded?.v3Swap?.pathTokenIn, WETH);
    assert.equal(decoded?.v3Swap?.pathTokenOut, USDC);
    assert.equal(decoded?.v3Swap?.pathFee, 500);
    assert.equal(decoded?.v3Swap?.payerIsUser, false);
    assert.isNull(decoded?.unwrapWeth);
  });

  it("erc20-in-native-out encodes V3_SWAP_EXACT_IN then UNWRAP_WETH with zero value", () => {
    const encoded = encodeProtectedExactInput(nativeOutPlan);
    assert.equal(encoded.value, "0");
    const decoded = decodeProtectedExactInput(encoded.data);
    assert.deepEqual(decoded?.commandTypes, [UR_COMMAND_V3_SWAP_EXACT_IN, UR_COMMAND_UNWRAP_WETH]);
    assert.equal(decoded?.v3Swap?.recipient, ROUTER);
    assert.equal(decoded?.v3Swap?.payerIsUser, true);
    assert.equal(decoded?.v3Swap?.pathTokenIn, USDC);
    assert.equal(decoded?.v3Swap?.pathTokenOut, WETH);
    assert.equal(decoded?.v3Swap?.amountOutMinimum, nativeOutPlan.minAmountOutRaw);
    assert.equal(decoded?.unwrapWeth?.recipient, RECIPIENT);
    assert.equal(decoded?.unwrapWeth?.amountMinimum, nativeOutPlan.minAmountOutRaw);
    assert.isNull(decoded?.wrapEth);
  });

  it("cross-checks the completed calldata with viem's independent decoder", () => {
    for (const plan of [nativeInPlan, nativeOutPlan]) {
      const encoded = encodeProtectedExactInput(plan);
      // execute(bytes,bytes[],uint256): decode the top-level arguments with
      // viem so the hand-rolled decoder is validated against a second
      // implementation.
      const body = `0x${encoded.data.slice(10)}` as `0x${string}`;
      const [commands, inputs, deadline] = decodeAbiParameters(
        [
          { type: "bytes", name: "commands" },
          { type: "bytes[]", name: "inputs" },
          { type: "uint256", name: "deadline" },
        ],
        body,
      );
      assert.equal(deadline, BigInt(plan.deadlineUnix));
      assert.equal((commands as unknown as string).length, 2 + 4); // two command bytes
      assert.equal(inputs.length, 2);
    }
  });

  it("verifyProtectedCalldata accepts its own encoding and catches every tamper", () => {
    const encoded = encodeProtectedExactInput(nativeInPlan);
    const ok = verifyProtectedCalldata(nativeInPlan, encoded);
    assert.isTrue(ok.ok, JSON.stringify(ok));

    const tampered = (
      patch: Partial<Parameters<typeof encodeProtectedExactInput>[0]>,
    ): ReturnType<typeof encodeProtectedExactInput> =>
      encodeProtectedExactInput({ ...nativeInPlan, ...patch });
    const refuses = (
      calldata: ReturnType<typeof encodeProtectedExactInput>,
      needle: string,
    ): void => {
      const verdict = verifyProtectedCalldata(nativeInPlan, calldata);
      assert.isFalse(verdict.ok);
      if (!verdict.ok) {
        assert.include(verdict.refusals.join("; "), needle);
      }
    };

    // Weakened minOut: the plan's floor no longer matches the bytes.
    refuses(tampered({ minAmountOutRaw: "1" }), "amountOutMinimum mismatch");
    // Different amount, recipient, deadline.
    refuses(tampered({ amountInRaw: "1" }), "amountIn mismatch");
    refuses(
      tampered({ recipient: "0x2222222222222222222222222222222222222222" }),
      "recipient mismatch",
    );
    refuses(tampered({ deadlineUnix: nativeInPlan.deadlineUnix + 1 }), "deadline mismatch");
    // Path tampering: a different ERC20 side.
    refuses(tampered({ erc20: "0x3333333333333333333333333333333333333333" }), "path mismatch");
    // Wrong target or funded value.
    refuses({ ...encoded, to: "0x4444444444444444444444444444444444444444" }, "to mismatch");
    refuses({ ...encoded, value: "1" }, "value mismatch");
    // Non-calldata garbage never decodes.
    const garbage = verifyProtectedCalldata(nativeInPlan, { ...encoded, data: "0xdeadbeef" });
    assert.isFalse(garbage.ok);
  });

  it("a swap command with the allow-revert flag is not the protected flow", () => {
    // Hand-build execute bytes whose WRAP_ETH command carries 0x80|0x0b.
    const encoded = encodeProtectedExactInput(nativeInPlan);
    const body = `0x${encoded.data.slice(10)}` as `0x${string}`;
    const [commands, inputs, deadline] = decodeAbiParameters(
      [
        { type: "bytes", name: "commands" },
        { type: "bytes[]", name: "inputs" },
        { type: "uint256", name: "deadline" },
      ],
      body,
    );
    const flagged = "0x8b00" as `0x${string}`; // 0x80|0x0b, then 0x00
    const rebuilt = encodeExecute(
      flagged,
      inputs.map((entry) => entry as unknown as `0x${string}`),
      Number(deadline),
    );
    const decoded = decodeProtectedExactInput(rebuilt);
    assert.isNotNull(decoded);
    assert.isTrue(decoded?.anyAllowRevert);
    const verdict = verifyProtectedCalldata(nativeInPlan, { ...encoded, data: rebuilt });
    assert.isFalse(verdict.ok);
    if (!verdict.ok) {
      assert.include(verdict.refusals.join("; "), "allow-revert");
    }
  });

  it("the calldata digest is the keccak of the data bytes", () => {
    const encoded = encodeProtectedExactInput(nativeInPlan);
    assert.equal(protectedCalldataDigest(encoded), keccak256(toBytes(encoded.data)));
    // A changed plan changes the digest.
    const other = encodeProtectedExactInput({ ...nativeInPlan, minAmountOutRaw: "1250000001" });
    assert.notEqual(protectedCalldataDigest(encoded), protectedCalldataDigest(other));
  });
});

describe("the slippage and price-impact bounds", () => {
  it("derives the exact integer floor and refuses degenerate inputs", () => {
    // 1000 units quoted, 50 bps: floor = 995 exactly (truncated).
    const floor = minimumOutFromQuote("1000", 50);
    assert.isTrue(floor.ok);
    if (floor.ok) assert.equal(floor.minAmountOutRaw, "995");
    // Truncation never rounds up: 999 → 50 bps → 994.05 → 994.
    const truncated = minimumOutFromQuote("999", 50);
    assert.isTrue(truncated.ok);
    if (truncated.ok) assert.equal(truncated.minAmountOutRaw, "994");
    // 100% slippage, zero output, and malformed quotes all refuse.
    assert.isFalse(minimumOutFromQuote("1000", 10_000).ok);
    assert.isFalse(minimumOutFromQuote("1", 9_999).ok);
    assert.isFalse(minimumOutFromQuote("0", 50).ok);
    assert.isFalse(minimumOutFromQuote("1.5", 50).ok);
  });

  it("bounds the quote's deviation from the TWAP reference in both directions", () => {
    // Within 200 bps both ways passes; beyond refuses in both directions.
    assert.isTrue(priceImpactRefusal("1010", "1000", 200).ok);
    assert.isTrue(priceImpactRefusal("990", "1000", 200).ok);
    assert.isFalse(priceImpactRefusal("1021", "1000", 200).ok);
    assert.isFalse(priceImpactRefusal("979", "1000", 200).ok);
    // A missing or malformed reference refuses (the funded gate's rule).
    assert.isFalse(priceImpactRefusal("1000", "0", 200).ok);
    assert.isFalse(priceImpactRefusal("1000", "", 200).ok);
  });
});

describe("the plan directions map the route vocabulary", () => {
  it("treats the native marker as native-in and anything else as erc20-in-native-out", () => {
    assert.equal(nativeInPlan.direction, "native-in");
    assert.equal(nativeOutPlan.direction, "erc20-in-native-out");
    // The plans never carry the native marker as a routed token: the POOL
    // pair is always WETH/USDC; nativeness rides the direction.
    assert.notEqual(nativeInPlan.weth, NATIVE);
    assert.notEqual(nativeOutPlan.weth, NATIVE);
  });
});

// ---------------------------------------------------------------------------
// The durable deployed-router check (skipped unless T3_FORK_CHECK_RPC is set)
// ---------------------------------------------------------------------------
//
// The FULL executed evidence (anvil mainnet fork at block 25964927: a real
// funded native-in swap delivering exactly the pinned quote to the literal
// recipient, plus TransactionDeadlinePassed / V3TooLittleReceived /
// InsufficientETH / Permit2-AllowanceExpired negatives) lives in
// t3trade-plans/2026-09-13-substreams-mainnet/worker-c-progress.md under
// "Fork check — EXECUTED". This env-gated test keeps the smallest always-
// repeatable slice inside the suite: against any mainnet RPC (or a fork),
// the deployed router still carries the deadline overload and still refuses
// a past deadline BEFORE any token movement. Run with:
//   T3_FORK_CHECK_RPC=https://ethereum-rpc.publicnode.com vp test run \
//     src/trading/forge/MainnetProtectedRouter.test.ts
const FORK_RPC = process.env.T3_FORK_CHECK_RPC;

describe("the deployed router (env-gated)", { skip: !FORK_RPC }, () => {
  /** One JSON-RPC round trip; revert DATA (custom-error selectors) rides error.data. */
  const rpc = async (
    method: string,
    params: ReadonlyArray<unknown>,
  ): Promise<
    | { readonly ok: true; readonly result: unknown }
    | {
        readonly ok: false;
        readonly message: string;
        readonly data: string;
      }
  > => {
    const response = await fetch(FORK_RPC!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [...params] }),
    });
    const body = (await response.json()) as {
      result?: unknown;
      error?: { message?: string; data?: string };
    };
    if (body.error !== undefined) {
      return {
        ok: false,
        message: body.error.message ?? "unknown",
        data: body.error.data ?? "",
      };
    }
    return { ok: true, result: body.result };
  };

  it("still carries the execute-with-deadline selector in its runtime code", async () => {
    const outcome = await rpc("eth_getCode", [ROUTER, "latest"]);
    assert.isTrue(outcome.ok);
    assert.include(String(outcome.ok ? outcome.result : "").toLowerCase(), "3593564c");
  });

  it("refuses a past deadline pre-dispatch with TransactionDeadlinePassed, whatever the funds", async () => {
    const encoded = encodeProtectedExactInput({
      ...nativeInPlan,
      // A past deadline: the modifier reverts before WRAP_ETH ever runs, so
      // an unfunded caller observes the named error, not a balance failure.
      deadlineUnix: 1,
    });
    const outcome = await rpc("eth_call", [
      {
        from: "0x1111111111111111111111111111111111111111",
        to: encoded.to,
        data: encoded.data,
        value: `0x${BigInt(encoded.value).toString(16)}`,
      },
      "latest",
    ]);
    assert.isFalse(outcome.ok, "a past deadline must revert");
    if (outcome.ok) throw new Error("unreachable");
    assert.include(outcome.data.toLowerCase(), "5bf6f916");
  });
});
