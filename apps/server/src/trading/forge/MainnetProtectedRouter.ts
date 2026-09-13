/**
 * The protected mainnet router codec — Universal Router exact-input calldata
 * for the two demo directions over ONE verified v3 pool, with a decoder that
 * reconstructs every field so the completed bytes are compared against the
 * approved plan BEFORE anything can be signed.
 *
 * Semantics pinned from the deployed Universal Router v1.4.0 source (tag
 * v1.4.0; the interface SDK's mainnet deployment at 0x3fC9…, creation block
 * 17143817) and verified against the deployed runtime bytecode on 2026-09-13
 * (selector 0x3593564c present; see the worker-c artifact):
 *
 * - `execute(bytes commands, bytes[] inputs, uint256 deadline)` runs its
 *   `checkDeadline` modifier BEFORE dispatch: `block.timestamp > deadline`
 *   reverts TransactionDeadlinePassed. No command carries the
 *   allow-revert flag (0x80) — a failing command reverts the whole call.
 * - V3_SWAP_EXACT_IN (0x00) input: abi(address recipient, uint256 amountIn,
 *   uint256 amountOutMinimum, bytes path, bool payerIsUser). A literal
 *   recipient passes through `map()` unchanged; the CONTRACT_BALANCE
 *   sentinel (1<<255) as amountIn would swap the whole router balance and is
 *   never encoded.
 * - WRAP_ETH (0x0b) input: abi(address recipient, uint256 amount) — wraps
 *   msg.value; reverts InsufficientETH when amount exceeds the router's
 *   balance; recipient == the router keeps the WETH in the router.
 * - UNWRAP_WETH (0x0c) input: abi(address recipient, uint256 amountMinimum)
 *   — unwraps the router's whole WETH balance, requiring ≥ amountMinimum,
 *   and sends the ETH to the recipient.
 * - v3 path: tokenIn(20) + fee(3, big-endian) + tokenOut(20).
 *
 * The two protected flows this module will ever encode:
 *
 * - `native-in` (native ETH → ERC20): WRAP_ETH(router, amountIn) then
 *   V3_SWAP_EXACT_IN(recipient, amountIn, minOut, weth|fee|erc20,
 *   payerIsUser=false). The router pays the wrapped input from the wrap; the
 *   ERC20 output lands DIRECTLY on the literal recipient; tx value is
 *   exactly amountIn.
 * - `erc20-in-native-out` (ERC20 → native ETH): V3_SWAP_EXACT_IN(router,
 *   amountIn, minOut, erc20|fee|weth, payerIsUser=true) — the SENDER pays
 *   the ERC20 input through Permit2 — then UNWRAP_WETH(recipient, minOut).
 *   The WETH output stays in the router and is unwrapped to the literal
 *   recipient with the same strictly-positive floor; tx value is zero.
 *
 * No allow-revert, no subplans, no arbitrary calls, no sweeps, no permits
 * inside the calldata (the ERC20 direction relies on the funding setup's
 * durable USDC→Permit2→router allowances, established by the human, never
 * re-established per transaction by this code).
 *
 * Pure codecs and comparisons only: no RPC, no signer, no storage.
 *
 * @module MainnetProtectedRouter
 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

/** The deadline overload's selector — recompute independently in tests. */
export const UNIVERSAL_ROUTER_EXECUTE_DEADLINE_SIGNATURE = "execute(bytes,bytes[],uint256)";
export const UNIVERSAL_ROUTER_EXECUTE_DEADLINE_SELECTOR = "0x3593564c";

/** Command bytes (Universal Router v1.4.0 Commands.sol). */
export const UR_COMMAND_V3_SWAP_EXACT_IN = 0x00;
export const UR_COMMAND_WRAP_ETH = 0x0b;
export const UR_COMMAND_UNWRAP_WETH = 0x0c;
/** The allow-revert flag — a protected calldata NEVER sets it. */
export const UR_FLAG_ALLOW_REVERT = 0x80;
export const UR_COMMAND_TYPE_MASK = 0x3f;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EXACT_DECIMAL = /^(0|[1-9][0-9]*)$/;

const executeAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);

/** The approved plan one protected exact-input encodes. */
export interface ProtectedSwapPlan {
  /** "native-in": native ETH input. "erc20-in-native-out": ERC20 input, native ETH output. */
  readonly direction: "native-in" | "erc20-in-native-out";
  /** The one chain the protected lane executes on: Ethereum mainnet. */
  readonly chainId: 1;
  /** The Universal Router the transaction is addressed to. */
  readonly router: string;
  /** Canonical WETH9 — the pool's wrapped side. */
  readonly weth: string;
  /** The pool's ERC20 side (USDC on the demo route). */
  readonly erc20: string;
  /** The exact literal recipient — the approved account, never a sentinel. */
  readonly recipient: string;
  /** Exact input, raw units (wei for native-in; ERC20 raw for the other). */
  readonly amountInRaw: string;
  /** Strictly positive minimum output floor, raw units of the output asset. */
  readonly minAmountOutRaw: string;
  /** execute(deadline) value, unix seconds; block.timestamp must not exceed it. */
  readonly deadlineUnix: number;
  /** The v3 pool's fee tier (500 = 0.05%). */
  readonly feeTier: number;
}

/** Field-level refusals for a malformed plan; empty means encodable. */
export const protectedPlanRefusals = (plan: ProtectedSwapPlan): ReadonlyArray<string> => {
  const refusals: Array<string> = [];
  const addressField = (name: keyof ProtectedSwapPlan): boolean => {
    const value = plan[name];
    return typeof value === "string" && ADDRESS_RE.test(value);
  };
  if (plan.chainId !== 1) refusals.push("chainId must be 1 (Ethereum mainnet)");
  if (plan.direction !== "native-in" && plan.direction !== "erc20-in-native-out") {
    refusals.push(`unknown direction '${String(plan.direction)}'`);
  }
  for (const name of ["router", "weth", "erc20", "recipient"] as const) {
    if (!addressField(name)) refusals.push(`${String(name)} is not a 20-byte address`);
  }
  if (plan.weth.toLowerCase() === plan.erc20.toLowerCase()) {
    refusals.push("weth and erc20 must differ");
  }
  if (!EXACT_DECIMAL.test(plan.amountInRaw) || BigInt(plan.amountInRaw) <= 0n) {
    refusals.push("amountInRaw must be a positive exact decimal integer");
  }
  if (!EXACT_DECIMAL.test(plan.minAmountOutRaw) || BigInt(plan.minAmountOutRaw) <= 0n) {
    refusals.push("minAmountOutRaw must be a strictly positive exact decimal integer");
  }
  if (
    !Number.isSafeInteger(plan.deadlineUnix) ||
    plan.deadlineUnix <= 0 ||
    plan.deadlineUnix > 2 ** 32
  ) {
    refusals.push("deadlineUnix must be a safe unix-seconds integer");
  }
  if (!Number.isInteger(plan.feeTier) || plan.feeTier < 0 || plan.feeTier > 1_000_000) {
    refusals.push("feeTier must be an integer in [0, 1000000]");
  }
  return refusals;
};

/** The v3 path bytes: tokenIn(20) + fee(3, big-endian) + tokenOut(20). */
const v3Path = (tokenIn: string, fee: number, tokenOut: string): Hex =>
  `0x${tokenIn.toLowerCase().replace(/^0x/, "")}${fee
    .toString(16)
    .padStart(6, "0")}${tokenOut.toLowerCase().replace(/^0x/, "")}` as Hex;

/** One command's ABI-encoded input bytes. */
const wrapEthInput = (recipient: string, amount: bigint): Hex =>
  encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [recipient as Address, amount]);

const v3SwapExactInputInput = (input: {
  readonly recipient: string;
  readonly amountIn: bigint;
  readonly amountOutMinimum: bigint;
  readonly path: Hex;
  readonly payerIsUser: boolean;
}): Hex =>
  encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes" },
      { type: "bool" },
    ],
    [
      input.recipient as Address,
      input.amountIn,
      input.amountOutMinimum,
      input.path,
      input.payerIsUser,
    ],
  );

const unwrapWethInput = (recipient: string, amountMinimum: bigint): Hex =>
  encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [recipient as Address, amountMinimum],
  );

/** The encoded transaction: target, exact funded value, and calldata. */
export interface ProtectedCalldata {
  readonly to: string;
  readonly value: string;
  readonly data: Hex;
}

/** One command byte as exactly two hex characters (toHex drops leading zeros). */
const commandByte = (byte: number): string => byte.toString(16).padStart(2, "0");

/**
 * Encode the protected exact-input calldata for a validated plan. Pure and
 * total over plans that pass {@link protectedPlanRefusals}; an invalid plan
 * is a DEFECT (the caller validated first) and throws with the refusals.
 */
export const encodeProtectedExactInput = (plan: ProtectedSwapPlan): ProtectedCalldata => {
  const refusals = protectedPlanRefusals(plan);
  if (refusals.length > 0) {
    throw new Error(`protected plan is not encodable: ${refusals.join("; ")}`);
  }
  const amountIn = BigInt(plan.amountInRaw);
  const minOut = BigInt(plan.minAmountOutRaw);
  const router = plan.router.toLowerCase();
  const recipient = plan.recipient.toLowerCase();

  let commands: Hex;
  let inputs: ReadonlyArray<Hex>;
  let value: string;
  if (plan.direction === "native-in") {
    // WRAP_ETH keeps the WETH in the router; the swap pays it to the pool and
    // sends the ERC20 output DIRECTLY to the literal recipient.
    commands =
      `0x${commandByte(UR_COMMAND_WRAP_ETH)}${commandByte(UR_COMMAND_V3_SWAP_EXACT_IN)}` as Hex;
    inputs = [
      wrapEthInput(router, amountIn),
      v3SwapExactInputInput({
        recipient,
        amountIn,
        amountOutMinimum: minOut,
        path: v3Path(plan.weth, plan.feeTier, plan.erc20),
        payerIsUser: false,
      }),
    ];
    value = plan.amountInRaw;
  } else {
    // The sender pays the ERC20 input through Permit2; the WETH output stays
    // in the router and is unwrapped to the literal recipient with the same
    // strictly-positive floor.
    commands =
      `0x${commandByte(UR_COMMAND_V3_SWAP_EXACT_IN)}${commandByte(UR_COMMAND_UNWRAP_WETH)}` as Hex;
    inputs = [
      v3SwapExactInputInput({
        recipient: router,
        amountIn,
        amountOutMinimum: minOut,
        path: v3Path(plan.erc20, plan.feeTier, plan.weth),
        payerIsUser: true,
      }),
      unwrapWethInput(recipient, minOut),
    ];
    value = "0";
  }

  const data = encodeExecute(commands, inputs, plan.deadlineUnix);
  return { to: router, value, data };
};

/** execute(commands, inputs, deadline) calldata. */
export const encodeExecute = (commands: Hex, inputs: ReadonlyArray<Hex>, deadline: number): Hex =>
  encodeFunctionData({
    abi: executeAbi,
    functionName: "execute",
    args: [commands, [...inputs], BigInt(deadline)],
  });

// ---------------------------------------------------------------------------
// Decoding — reconstruct every field from the completed bytes
// ---------------------------------------------------------------------------

/** One decoded command input. */
export interface DecodedWrapEth {
  readonly kind: "wrap-eth";
  readonly recipient: string;
  readonly amount: string;
}
export interface DecodedV3SwapExactIn {
  readonly kind: "v3-swap-exact-in";
  readonly recipient: string;
  readonly amountIn: string;
  readonly amountOutMinimum: string;
  readonly pathTokenIn: string;
  readonly pathFee: number;
  readonly pathTokenOut: string;
  readonly payerIsUser: boolean;
}
export interface DecodedUnwrapWeth {
  readonly kind: "unwrap-weth";
  readonly recipient: string;
  readonly amountMinimum: string;
}

export interface DecodedProtectedCalldata {
  readonly selector: string;
  readonly deadlineUnix: string;
  /** Command bytes as masked types, in order. */
  readonly commandTypes: ReadonlyArray<number>;
  /** True where any command byte sets the allow-revert flag. */
  readonly anyAllowRevert: boolean;
  readonly wrapEth: DecodedWrapEth | null;
  readonly v3Swap: DecodedV3SwapExactIn | null;
  readonly unwrapWeth: DecodedUnwrapWeth | null;
}

const words = (data: string): ReadonlyArray<bigint> | null => {
  if (typeof data !== "string" || !data.startsWith("0x")) return null;
  const body = data.slice(2);
  if (body.length === 0 || body.length % 64 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) return null;
  const out: Array<bigint> = [];
  for (let offset = 0; offset < body.length; offset += 64) {
    out.push(BigInt(`0x${body.slice(offset, offset + 64)}`));
  }
  return out;
};

const addressOf = (word: bigint): string => `0x${word.toString(16).padStart(40, "0")}`;

/**
 * Read a `bytes` value whose LENGTH word sits at `lengthWordIndex` in the
 * argument heap: [length][data words…]. Null when the heap is too short.
 */
const bytesDataAt = (heap: ReadonlyArray<bigint>, lengthWordIndex: number): Hex | null => {
  const length = heap[lengthWordIndex];
  if (length === undefined || length < 0n) return null;
  const byteLength = Number(length);
  if (!Number.isSafeInteger(byteLength) || byteLength > 8192) return null;
  const lengthWords = Math.ceil(byteLength / 32);
  let hex = "";
  for (let i = 0; i < lengthWords; i += 1) {
    const word = heap[lengthWordIndex + 1 + i];
    if (word === undefined) return null;
    hex += word.toString(16).padStart(64, "0");
  }
  return `0x${hex.slice(0, byteLength * 2)}` as Hex;
};

const decodeWrapEthInput = (input: Hex): DecodedWrapEth | null => {
  const heap = words(input);
  if (heap === null || heap.length !== 2) return null;
  return { kind: "wrap-eth", recipient: addressOf(heap[0]!), amount: heap[1]!.toString(10) };
};

const decodeV3SwapInput = (input: Hex): DecodedV3SwapExactIn | null => {
  const heap = words(input);
  if (heap === null || heap.length !== 8) return null;
  // (address, uint256, uint256, bytes, bool): five head words with the bytes
  // offset at word 3 pointing past the head (0xa0 = 160), then the length
  // word and the 43-byte path.
  const bytesOffset = heap[3];
  if (bytesOffset !== 160n) return null;
  const path = bytesDataAt(heap, Number(bytesOffset) / 32);
  if (path === null || (path.length - 2) / 2 !== 43) return null;
  const body = path.slice(2);
  return {
    kind: "v3-swap-exact-in",
    recipient: addressOf(heap[0]!),
    amountIn: heap[1]!.toString(10),
    amountOutMinimum: heap[2]!.toString(10),
    pathTokenIn: `0x${body.slice(0, 40)}`,
    pathFee: Number.parseInt(body.slice(40, 46), 16),
    pathTokenOut: `0x${body.slice(46, 86)}`,
    payerIsUser: heap[4] === 1n,
  };
};

const decodeUnwrapInput = (input: Hex): DecodedUnwrapWeth | null => {
  const heap = words(input);
  if (heap === null || heap.length !== 2) return null;
  return {
    kind: "unwrap-weth",
    recipient: addressOf(heap[0]!),
    amountMinimum: heap[1]!.toString(10),
  };
};

/**
 * Decode completed `execute(commands, inputs, deadline)` calldata back into
 * its plan fields. Null — never a throw — on anything that is not exactly
 * this shape: wrong selector, ragged words, or an input that does not decode
 * into the known command vocabulary.
 *
 * Layout (the head of `(bytes, bytes[], uint256)` is three words):
 * `[commandsOffset, inputsOffset, deadline][commands body][inputs body]`
 * where a `bytes` body is `[length][data…]` and the `bytes[]` body is
 * `[length][elem offsets…][elem bodies…]` with element offsets relative to
 * the array's own base.
 */
export const decodeProtectedExactInput = (data: string): DecodedProtectedCalldata | null => {
  if (typeof data !== "string" || !data.startsWith(UNIVERSAL_ROUTER_EXECUTE_DEADLINE_SELECTOR)) {
    return null;
  }
  // Strip the selector before the whole-words split: the argument blob, not
  // the calldata, is word-aligned.
  const heap = words(`0x${data.slice(10)}`);
  if (heap === null || heap.length < 3) return null;
  const commandsOffset = heap[0]!;
  const inputsOffset = heap[1]!;
  const deadline = heap[2]!;
  if (commandsOffset < 96n || commandsOffset % 32n !== 0n) return null;
  if (inputsOffset < 96n || inputsOffset % 32n !== 0n) return null;
  const commandsLengthWord = Number(commandsOffset) / 32;
  const inputsLengthWord = Number(inputsOffset) / 32;

  const commands = bytesDataAt(heap, commandsLengthWord);
  if (commands === null || (commands.length - 2) / 2 === 0) return null;

  const inputsLength = heap[inputsLengthWord];
  if (inputsLength === undefined || inputsLength < 0n || inputsLength > 16n) return null;
  const inputs: Array<Hex> = [];
  for (let i = 0; i < Number(inputsLength); i += 1) {
    const elementOffset = heap[inputsLengthWord + 1 + i];
    if (elementOffset === undefined || elementOffset < 32n || elementOffset % 32n !== 0n)
      return null;
    // Element offsets are relative to the array's first offset slot (the
    // word after the length), per the standard ABI array encoding.
    const element = bytesDataAt(heap, inputsLengthWord + 1 + Number(elementOffset) / 32);
    if (element === null) return null;
    inputs.push(element);
  }

  const commandBytes: Array<number> = [];
  const commandTypes: Array<number> = [];
  let anyAllowRevert = false;
  const commandsBody = commands.slice(2);
  for (let i = 0; i < commandsBody.length / 2; i += 1) {
    const byte = Number.parseInt(commandsBody.slice(i * 2, i * 2 + 2), 16);
    commandBytes.push(byte);
    commandTypes.push(byte & UR_COMMAND_TYPE_MASK);
    if ((byte & UR_FLAG_ALLOW_REVERT) !== 0) anyAllowRevert = true;
  }
  if (commandBytes.length !== inputs.length) return null;

  let wrapEth: DecodedWrapEth | null = null;
  let v3Swap: DecodedV3SwapExactIn | null = null;
  let unwrapWeth: DecodedUnwrapWeth | null = null;
  for (let i = 0; i < commandBytes.length; i += 1) {
    const type = commandBytes[i]! & UR_COMMAND_TYPE_MASK;
    if (type === UR_COMMAND_WRAP_ETH) {
      if (wrapEth !== null) return null;
      wrapEth = decodeWrapEthInput(inputs[i]!);
      if (wrapEth === null) return null;
    } else if (type === UR_COMMAND_V3_SWAP_EXACT_IN) {
      if (v3Swap !== null) return null;
      v3Swap = decodeV3SwapInput(inputs[i]!);
      if (v3Swap === null) return null;
    } else if (type === UR_COMMAND_UNWRAP_WETH) {
      if (unwrapWeth !== null) return null;
      unwrapWeth = decodeUnwrapInput(inputs[i]!);
      if (unwrapWeth === null) return null;
    } else {
      // Any other command (sweep, transfer, permit, NFT market, subplan…)
      // makes this NOT the protected flow.
      return null;
    }
  }

  return {
    selector: UNIVERSAL_ROUTER_EXECUTE_DEADLINE_SELECTOR,
    deadlineUnix: deadline.toString(10),
    commandTypes,
    anyAllowRevert,
    wrapEth,
    v3Swap,
    unwrapWeth,
  };
};

// ---------------------------------------------------------------------------
// The pre-sign verification: completed bytes vs the approved plan
// ---------------------------------------------------------------------------

export type ProtectedVerification =
  | { readonly ok: true; readonly decoded: DecodedProtectedCalldata }
  | { readonly ok: false; readonly refusals: ReadonlyArray<string> };

/**
 * Compare EVERY field of the completed calldata against the approved plan —
 * the decode-back gate that runs before signing is even possible. Refusals
 * name each deviation: wrong target, wrong value, wrong deadline, wrong
 * command set, sentinel recipients, path tampering, minimum-output
 * weakening, payer flips, or any allow-revert flag.
 */
export const verifyProtectedCalldata = (
  plan: ProtectedSwapPlan,
  calldata: ProtectedCalldata,
): ProtectedVerification => {
  const refusals: ReadonlyArray<string> = protectedPlanRefusals(plan);
  if (refusals.length > 0) return { ok: false, refusals };
  const decoded = decodeProtectedExactInput(calldata.data);
  if (decoded === null) {
    return {
      ok: false,
      refusals: ["the calldata does not decode as execute(commands, inputs, deadline)"],
    };
  }
  const problems: Array<string> = [];
  if (calldata.to.toLowerCase() !== plan.router.toLowerCase()) {
    problems.push(`to mismatch: calldata ${calldata.to}, plan ${plan.router}`);
  }
  const expectedValue = plan.direction === "native-in" ? plan.amountInRaw : "0";
  if (calldata.value !== expectedValue) {
    problems.push(`value mismatch: calldata ${calldata.value}, plan ${expectedValue}`);
  }
  if (decoded.deadlineUnix !== BigInt(plan.deadlineUnix).toString(10)) {
    problems.push(`deadline mismatch: calldata ${decoded.deadlineUnix}, plan ${plan.deadlineUnix}`);
  }
  if (decoded.anyAllowRevert) {
    problems.push("a command carries the allow-revert flag; the protected flow never does");
  }
  if (BigInt(plan.minAmountOutRaw) <= 0n) {
    problems.push("minimum output is not strictly positive");
  }
  if (plan.direction === "native-in") {
    if (
      decoded.commandTypes.length !== 2 ||
      decoded.commandTypes[0] !== UR_COMMAND_WRAP_ETH ||
      decoded.commandTypes[1] !== UR_COMMAND_V3_SWAP_EXACT_IN
    ) {
      problems.push("native-in expects exactly WRAP_ETH then V3_SWAP_EXACT_IN");
    }
    const wrap = decoded.wrapEth;
    if (wrap === null) {
      problems.push("the WRAP_ETH input is missing");
    } else {
      if (wrap.recipient.toLowerCase() !== plan.router.toLowerCase()) {
        problems.push(`WRAP_ETH recipient must be the router itself, got ${wrap.recipient}`);
      }
      if (wrap.amount !== plan.amountInRaw) {
        problems.push(`WRAP_ETH amount mismatch: ${wrap.amount} vs ${plan.amountInRaw}`);
      }
    }
    const swap = decoded.v3Swap;
    if (swap === null) {
      problems.push("the V3_SWAP_EXACT_IN input is missing");
    } else {
      if (swap.recipient.toLowerCase() !== plan.recipient.toLowerCase()) {
        problems.push(`swap recipient mismatch: ${swap.recipient} vs ${plan.recipient}`);
      }
      if (swap.amountIn !== plan.amountInRaw) {
        problems.push(`swap amountIn mismatch: ${swap.amountIn} vs ${plan.amountInRaw}`);
      }
      if (swap.amountOutMinimum !== plan.minAmountOutRaw) {
        problems.push(
          `swap amountOutMinimum mismatch: ${swap.amountOutMinimum} vs ${plan.minAmountOutRaw}`,
        );
      }
      if (
        swap.pathTokenIn.toLowerCase() !== plan.weth.toLowerCase() ||
        swap.pathTokenOut.toLowerCase() !== plan.erc20.toLowerCase() ||
        swap.pathFee !== plan.feeTier
      ) {
        problems.push("swap path mismatch: expected weth|feeTier|erc20");
      }
      if (swap.payerIsUser) {
        problems.push("native-in must have the ROUTER pay (payerIsUser false)");
      }
    }
    if (decoded.unwrapWeth !== null) {
      problems.push("native-in must not unwrap WETH");
    }
  } else {
    if (
      decoded.commandTypes.length !== 2 ||
      decoded.commandTypes[0] !== UR_COMMAND_V3_SWAP_EXACT_IN ||
      decoded.commandTypes[1] !== UR_COMMAND_UNWRAP_WETH
    ) {
      problems.push("erc20-in-native-out expects exactly V3_SWAP_EXACT_IN then UNWRAP_WETH");
    }
    const swap = decoded.v3Swap;
    if (swap === null) {
      problems.push("the V3_SWAP_EXACT_IN input is missing");
    } else {
      if (swap.recipient.toLowerCase() !== plan.router.toLowerCase()) {
        problems.push(`swap recipient must be the router itself, got ${swap.recipient}`);
      }
      if (swap.amountIn !== plan.amountInRaw) {
        problems.push(`swap amountIn mismatch: ${swap.amountIn} vs ${plan.amountInRaw}`);
      }
      if (swap.amountOutMinimum !== plan.minAmountOutRaw) {
        problems.push(
          `swap amountOutMinimum mismatch: ${swap.amountOutMinimum} vs ${plan.minAmountOutRaw}`,
        );
      }
      if (
        swap.pathTokenIn.toLowerCase() !== plan.erc20.toLowerCase() ||
        swap.pathTokenOut.toLowerCase() !== plan.weth.toLowerCase() ||
        swap.pathFee !== plan.feeTier
      ) {
        problems.push("swap path mismatch: expected erc20|feeTier|weth");
      }
      if (!swap.payerIsUser) {
        problems.push("erc20-in-native-out must have the SENDER pay (payerIsUser true)");
      }
    }
    const unwrap = decoded.unwrapWeth;
    if (unwrap === null) {
      problems.push("the UNWRAP_WETH input is missing");
    } else {
      if (unwrap.recipient.toLowerCase() !== plan.recipient.toLowerCase()) {
        problems.push(`unwrap recipient mismatch: ${unwrap.recipient} vs ${plan.recipient}`);
      }
      if (unwrap.amountMinimum !== plan.minAmountOutRaw) {
        problems.push(
          `unwrap amountMinimum mismatch: ${unwrap.amountMinimum} vs ${plan.minAmountOutRaw}`,
        );
      }
    }
    if (decoded.wrapEth !== null) {
      problems.push("erc20-in-native-out must not wrap ETH");
    }
  }
  return problems.length === 0
    ? { ok: true, decoded }
    : { ok: false, refusals: [...refusals, ...problems] };
};

// ---------------------------------------------------------------------------
// Slippage + price-impact bounds (pure arithmetic, exact integer math)
// ---------------------------------------------------------------------------

/**
 * The host-computed minimum output from the quoted output and the approved
 * slippage allowance: `expected * (10_000 - bps) / 10_000`, truncated. A
 * non-positive floor, or bps outside [0, 10_000), is the
 * `invalid-protection` refusal of the 03 illustrative arithmetic. The caller
 * (never the policy) owns bps, and the FUNDED gate enforces the much smaller
 * human-approved demo cap on top.
 */
export const minimumOutFromQuote = (
  quotedAmountOutRaw: string,
  slippageBps: number,
):
  | { readonly ok: true; readonly minAmountOutRaw: string }
  | { readonly ok: false; readonly refusal: string } => {
  if (!EXACT_DECIMAL.test(quotedAmountOutRaw) || BigInt(quotedAmountOutRaw) <= 0n) {
    return {
      ok: false,
      refusal: "invalid-protection: the quoted output is not a positive exact integer",
    };
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    return {
      ok: false,
      refusal: `invalid-protection: slippageBps ${slippageBps} is outside [0, 10000)`,
    };
  }
  const minOut = (BigInt(quotedAmountOutRaw) * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOut <= 0n) {
    return { ok: false, refusal: "invalid-protection: slippage rounds minimum output to zero" };
  }
  return { ok: true, minAmountOutRaw: minOut.toString(10) };
};

/**
 * The price-impact bound's default tolerance, bps: the quote's implied
 * execution price may deviate from the independently timestamped TWAP
 * reference by at most this much. minOut bounds deviation from the QUOTE;
 * this bounds the QUOTE's own fairness against a manipulated pool.
 */
export const PROTECTED_PRICE_IMPACT_MAX_BPS_DEFAULT = 200;

/**
 * Bound the quote's implied execution price against a reference output for
 * the same input (a TWAP-implied amount for the same pool, read at an
 * independently timestamped block). Deviation beyond `maxBps` in either
 * direction refuses. Pure arithmetic over exact integers; the reference's
 * OWN freshness is the caller's responsibility (a missing or old reference
 * refuses before this comparison runs).
 */
export const priceImpactRefusal = (
  quotedAmountOutRaw: string,
  referenceAmountOutRaw: string,
  maxBps: number,
):
  | { readonly ok: true; readonly deviationBps: number }
  | { readonly ok: false; readonly refusal: string } => {
  if (!EXACT_DECIMAL.test(quotedAmountOutRaw) || BigInt(quotedAmountOutRaw) <= 0n) {
    return {
      ok: false,
      refusal: "price-impact: the quoted output is not a positive exact integer",
    };
  }
  if (!EXACT_DECIMAL.test(referenceAmountOutRaw) || BigInt(referenceAmountOutRaw) <= 0n) {
    return {
      ok: false,
      refusal: "price-impact: the TWAP reference is missing or not a positive exact integer",
    };
  }
  if (!Number.isInteger(maxBps) || maxBps <= 0) {
    return { ok: false, refusal: "price-impact: the tolerance must be a positive integer bps" };
  }
  const quoted = BigInt(quotedAmountOutRaw);
  const reference = BigInt(referenceAmountOutRaw);
  const deviationBps = Number(
    ((quoted - reference >= 0n ? quoted - reference : reference - quoted) * 10_000n) / reference,
  );
  if (deviationBps > maxBps) {
    return {
      ok: false,
      refusal: `price-impact: the quote deviates ${deviationBps} bps from the TWAP reference, beyond the ${maxBps} bps bound`,
    };
  }
  return { ok: true, deviationBps };
};

/**
 * The keccak256 digest of the calldata bytes — the immutable content
 * identity the signing snapshot and receipts pin.
 */
export const protectedCalldataDigest = (calldata: ProtectedCalldata): string =>
  keccak256(calldata.data);
