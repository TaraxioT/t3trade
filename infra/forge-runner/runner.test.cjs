// Local unit test for runner.cjs mode dispatch — no Docker involved.
//
// Compiles real TypeScript fixtures with the workspace's own tsc (the same
// 6.0.x line the container image pins) and drives the exported runMode
// directly through a harness, so the v2 shim logic is testable outside the
// sealed image:
//
//   node infra/forge-runner/runner.test.cjs
//
// Run from anywhere; paths resolve from this file's location.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const { MODES, discoverTypeScriptFiles, runMode } = require("./runner.cjs");

// Resolve the local tsc JS entry (runnable by node) across npm and pnpm
// layouts. The container installs npm-style under /opt/forge; the dev
// workspace uses pnpm's .pnpm store.
const resolveTsc = () => {
  const direct = path.join(root, "node_modules", "typescript", "bin", "tsc");
  if (fs.existsSync(direct)) return direct;
  const pnpm = path.join(root, "node_modules", ".pnpm");
  if (fs.existsSync(pnpm)) {
    const entry = fs.readdirSync(pnpm).find((name) => /^typescript@/.test(name));
    if (entry !== undefined) {
      const candidate = path.join(pnpm, entry, "node_modules", "typescript", "bin", "tsc");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
};

const tscPath = resolveTsc();
if (tscPath === null) {
  console.error("runner.test.cjs: no local typescript compiler found under the repo root");
  process.exit(1);
}

// -- fixtures -----------------------------------------------------------------

const V2_SDK = `export type FactValue = { readonly kind: "boolean"; readonly value: boolean };
export type EvidenceRef = { readonly id: string; readonly sourceId: string };
export type CapturedFact = {
  readonly id: string;
  readonly key: string;
  readonly entityId: string;
  readonly value: FactValue;
  readonly evidence: ReadonlyArray<EvidenceRef>;
};
export type SealedSourceRecord = { readonly sourceId: string; readonly complete: boolean };
export type DetectorProgramInput = {
  readonly programSchemaVersion: 2;
  readonly asOfMs: number;
  readonly inputDigest: string;
  readonly facts: ReadonlyArray<CapturedFact>;
  readonly sources: ReadonlyArray<SealedSourceRecord>;
  readonly priorState?: unknown;
};
export type DetectionResult =
  | { readonly status: "matched"; readonly occurrenceKey: string; readonly evidenceIds: ReadonlyArray<string>; readonly facts: ReadonlyArray<CapturedFact>; readonly validUntilMs: number }
  | { readonly status: "not-matched"; readonly evidenceIds: ReadonlyArray<string>; readonly explanation: string }
  | { readonly status: "unknown"; readonly missingSourceIds: ReadonlyArray<string>; readonly explanation: string };
export type DetectorProgramOutput = { readonly result: DetectionResult; readonly nextState: unknown };
export type Detect = (input: DetectorProgramInput) => DetectorProgramOutput;
const registeredTests: Array<() => void | Promise<void>> = [];
export function test(_name: string, body: () => void | Promise<void>): void {
  registeredTests.push(body);
}
export async function runRegisteredTests(): Promise<number> {
  for (const body of registeredTests) await body();
  return registeredTests.length;
}
`;

const V2_DETECTOR = `import type { Detect, DetectorProgramInput, DetectorProgramOutput } from "./sdk";
export const detect: Detect = (input: DetectorProgramInput): DetectorProgramOutput => {
  const prior = input.priorState as { count?: number } | null | undefined;
  const count = ((prior === null || prior === undefined ? 0 : prior.count) ?? 0) + 1;
  return {
    result: { status: "not-matched", evidenceIds: [], explanation: "fixture detector" },
    nextState: { count },
  };
};
`;

const V2_TEST = `import { test } from "./sdk";
import { detect } from "./detector";
test("fixture detect exists", () => {
  if (detect === undefined) throw new Error("detect missing");
});
`;

const V1_SIGNAL = `import type { ReadSignal, SignalInput, SignalOutput } from "./sdk";
export const readSignal: ReadSignal = (input: SignalInput): SignalOutput => ({
  reading: { kind: "insufficient", reason: "fixture" },
  diagnostics: [],
});
`;

const V1_TEST = `import { test } from "./sdk";
import { readSignal } from "./signal";
test("fixture readSignal exists", () => {
  if (readSignal === undefined) throw new Error("readSignal missing");
});
`;

// The v1 sdk needs just enough shape for the v1 fixtures to typecheck.
const V1_SDK = `export type SignalInput = { readonly evidence: unknown; readonly pools: ReadonlyArray<unknown> };
export type SignalReading =
  | { readonly kind: "ready"; readonly regime: "quiet"; readonly agreement: number; readonly eligiblePoolIds: ReadonlyArray<string> }
  | { readonly kind: "insufficient"; readonly reason: string };
export type SignalOutput = { readonly reading: SignalReading; readonly diagnostics: ReadonlyArray<unknown> };
export type ReadSignal = (input: SignalInput) => SignalOutput;
const registeredTests: Array<() => void | Promise<void>> = [];
export function test(_name: string, body: () => void | Promise<void>): void {
  registeredTests.push(body);
}
export async function runRegisteredTests(): Promise<number> {
  for (const body of registeredTests) await body();
  return registeredTests.length;
}
`;

const v2Input = (priorState) =>
  JSON.stringify({
    programSchemaVersion: 2,
    asOfMs: 1_700_000_060_000,
    inputDigest: "b".repeat(64),
    facts: [],
    sources: [{ sourceId: "src_graph_1", complete: true }],
    ...(priorState === undefined ? {} : { priorState }),
  });

const makeWorkdir = async (files) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forge-runner-test-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.promises.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
};

const drive = async (mode, files, stdin) => {
  const workDir = await makeWorkdir(files);
  const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forge-runner-out-"));
  const stdout = [];
  const stderr = [];
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  let error = undefined;
  try {
    runMode(mode, {
      workDir,
      outDir,
      tscPath,
      nodePath: process.execPath,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      ...(stdin === undefined ? {} : { stdin }),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    // The test mode's harness result arrives on a promise tick.
    await new Promise((resolve) => setImmediate(resolve));
  } catch (caught) {
    error = caught;
  }
  const exitCode = process.exitCode;
  process.exitCode = previousExit;
  await fs.promises.rm(workDir, { recursive: true, force: true });
  await fs.promises.rm(outDir, { recursive: true, force: true });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), error };
};

const tests = [];
const test = (name, body) => tests.push([name, body]);

// -- the data-driven compile set ------------------------------------------------

test("discoverTypeScriptFiles includes tests only when asked, sorted", async () => {
  const dir = await makeWorkdir({
    "sdk.ts": "",
    "detector.ts": "",
    "detector.test.ts": "",
    "manifest.json": "",
    "query.graphql": "",
  });
  try {
    assert.deepEqual(discoverTypeScriptFiles(dir, true), [
      path.join(dir, "detector.test.ts"),
      path.join(dir, "detector.ts"),
      path.join(dir, "sdk.ts"),
    ]);
    assert.deepEqual(discoverTypeScriptFiles(dir, false), [
      path.join(dir, "detector.ts"),
      path.join(dir, "sdk.ts"),
    ]);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("unknown modes refuse by name", async () => {
  const run = await drive("evaluate-v3", { "sdk.ts": V2_SDK, "detector.ts": V2_DETECTOR });
  assert.ok(run.error instanceof Error);
  assert.equal(run.error.message, "unknown runner mode");
  assert.deepEqual(MODES, ["typecheck", "test", "evaluate", "evaluate-v2", "evaluate-policy"]);
});

// -- shared modes over both bundle generations ---------------------------------

test("typecheck compiles the v2 file set including the authored test", async () => {
  const run = await drive("typecheck", {
    "sdk.ts": V2_SDK,
    "detector.ts": V2_DETECTOR,
    "detector.test.ts": V2_TEST,
  });
  assert.equal(run.error, undefined);
  assert.equal(run.exitCode, undefined);
});

test("typecheck refuses a bundle that does not compile under --strict", async () => {
  const run = await drive("typecheck", {
    "sdk.ts": V2_SDK,
    "detector.ts": 'export const detect: number = "not a number";\n',
  });
  assert.equal(run.error, undefined);
  // tsc's own nonzero status propagates (v1 used process.exit(checked.status)
  // with the same value; 2 is tsc's compile-error exit code).
  assert.ok(typeof run.exitCode === "number" && run.exitCode !== 0);
  assert.match(run.stderr, /TS2322|error/);
});

test("test mode runs the v2 authored test through the sdk harness", async () => {
  const run = await drive("test", {
    "sdk.ts": V2_SDK,
    "detector.ts": V2_DETECTOR,
    "detector.test.ts": V2_TEST,
  });
  assert.equal(run.error, undefined);
  assert.deepEqual(JSON.parse(run.stdout), { testsPassed: 1 });
});

test("test mode still runs the v1 signal.test.ts branch", async () => {
  const run = await drive("test", {
    "sdk.ts": V1_SDK,
    "signal.ts": V1_SIGNAL,
    "signal.test.ts": V1_TEST,
  });
  assert.equal(run.error, undefined);
  assert.deepEqual(JSON.parse(run.stdout), { testsPassed: 1 });
});

// -- evaluate-v2 ----------------------------------------------------------------

test("evaluate-v2 runs the sync detect export and echoes { result, nextState }", async () => {
  const first = await drive(
    "evaluate-v2",
    { "sdk.ts": V2_SDK, "detector.ts": V2_DETECTOR, "detector.test.ts": V2_TEST },
    v2Input(undefined),
  );
  assert.equal(first.error, undefined);
  assert.equal(first.exitCode, undefined);
  assert.deepEqual(JSON.parse(first.stdout), {
    result: { status: "not-matched", evidenceIds: [], explanation: "fixture detector" },
    nextState: { count: 1 },
  });

  // The evaluate compile set excludes the authored test file; priorState flows through.
  const second = await drive(
    "evaluate-v2",
    { "sdk.ts": V2_SDK, "detector.ts": V2_DETECTOR, "detector.test.ts": V2_TEST },
    v2Input({ count: 41 }),
  );
  assert.deepEqual(JSON.parse(second.stdout).nextState, { count: 42 });
});

test("evaluate-v2 refuses an async detect by name", async () => {
  const asyncDetector = `${V2_DETECTOR.replace("export const detect: Detect", "const detectImpl: Detect")}`;
  const asyncWrap = `${asyncDetector}\nexport const detect = async (input: Parameters<Detect>[0]) => detectImpl(input);\nexport type Detect2 = typeof detect;\n`;
  const run = await drive(
    "evaluate-v2",
    {
      "sdk.ts": V2_SDK,
      "detector.ts": asyncWrap,
    },
    v2Input(undefined),
  );
  assert.ok(run.error instanceof Error, "the async guard must throw");
  assert.equal(run.error.message, "detect must be synchronous");
});

test("evaluate-v2 refuses a detector without the detect export by name", async () => {
  const run = await drive(
    "evaluate-v2",
    { "sdk.ts": V2_SDK, "detector.ts": "export const notDetect = 1;\n" },
    v2Input(undefined),
  );
  assert.ok(run.error instanceof Error, "the missing-export guard must throw");
  assert.equal(run.error.message, "detect export missing");
});

test("evaluate-v2 still guards the stdin and stdout caps", async () => {
  const oversizeInput = await drive(
    "evaluate-v2",
    { "sdk.ts": V2_SDK, "detector.ts": V2_DETECTOR },
    " ".repeat(2 * 1024 * 1024 + 1),
  );
  assert.ok(oversizeInput.error instanceof Error);
  assert.equal(oversizeInput.error.message, "input limit");

  const floodingDetector = `import type { Detect } from "./sdk";
export const detect: Detect = () => ({ result: { status: "not-matched", evidenceIds: [], explanation: "x".repeat(65 * 1024) }, nextState: null });
`;
  const oversizeOutput = await drive(
    "evaluate-v2",
    { "sdk.ts": V2_SDK, "detector.ts": floodingDetector },
    v2Input(undefined),
  );
  assert.ok(oversizeOutput.error instanceof Error);
  assert.equal(oversizeOutput.error.message, "invalid output size");
});

// -- evaluate-policy ------------------------------------------------------------

// The policy-side SDK additions the generated policy imports from ./sdk. The
// detector-side types are shared, so this fixture extends V2_SDK with the
// policy vocabulary (envelope opaque to the runner; the host validates it).
const POLICY_SDK = `${V2_SDK}
export type DetectorResultForPolicy =
  | { readonly status: "matched"; readonly occurrenceKey: string; readonly validUntilMs: number }
  | { readonly status: "not-matched"; readonly explanation: string }
  | { readonly status: "unknown"; readonly explanation: string };
export type PersistedProposalSummary = {
  readonly stageKey: string;
  readonly kind: "wait" | "price" | "swap" | "stop-future-actions" | "complete";
  readonly amountInRaw?: string;
  readonly occurredAtMs: number;
};
export type PolicyInput = {
  readonly policySchemaVersion: 2;
  readonly asOfMs: number;
  readonly envelope: unknown;
  readonly detectorEvaluation: {
    readonly evaluationId: string;
    readonly asOfMs: number;
    readonly result: DetectorResultForPolicy;
  };
  readonly priorProposals: ReadonlyArray<PersistedProposalSummary>;
  readonly remainingInputCapRaw: string;
  readonly priorState?: unknown;
};
export type PolicyOutput = { readonly proposal: unknown; readonly nextState: unknown };
export type Propose = (input: PolicyInput) => PolicyOutput;
`;

const V2_POLICY = `import type { PolicyInput, PolicyOutput, Propose } from "./sdk";
export const propose: Propose = (input: PolicyInput): PolicyOutput => {
  const prior = input.priorState as { runs?: number } | null | undefined;
  const runs = ((prior === null || prior === undefined ? 0 : prior.runs) ?? 0) + 1;
  const evaluation = input.detectorEvaluation;
  if (evaluation.result.status !== "matched") return { proposal: { kind: "wait" }, nextState: { runs } };
  return {
    proposal: {
      kind: "swap",
      candidateId: "cand_1",
      amountInRaw: "1000000",
      quoteId: "sq_1",
      occurrenceKey: evaluation.result.occurrenceKey,
      stageKey: "entry",
      detectorEvaluationId: evaluation.evaluationId,
    },
    nextState: { runs },
  };
};
`;

const policyInput = (priorState, stageKeys) =>
  JSON.stringify({
    policySchemaVersion: 2,
    asOfMs: 1_700_000_060_000,
    envelope: { revision: 1 },
    detectorEvaluation: {
      evaluationId: "dtev_1",
      asOfMs: 1_700_000_050_000,
      result: { status: "matched", occurrenceKey: "occ-1", validUntilMs: 1_700_000_120_000 },
    },
    priorProposals: (stageKeys ?? []).map((stageKey) => ({
      stageKey,
      kind: "swap",
      amountInRaw: "1000000",
      occurredAtMs: 1_700_000_055_000,
    })),
    remainingInputCapRaw: "9000000",
    ...(priorState === undefined ? {} : { priorState }),
  });

test("evaluate-policy runs the sync propose export and echoes { proposal, nextState }", async () => {
  const first = await drive(
    "evaluate-policy",
    { "sdk.ts": POLICY_SDK, "policy.ts": V2_POLICY },
    policyInput(undefined, []),
  );
  assert.equal(first.error, undefined);
  assert.equal(first.exitCode, undefined);
  assert.deepEqual(JSON.parse(first.stdout), {
    proposal: {
      kind: "swap",
      candidateId: "cand_1",
      amountInRaw: "1000000",
      quoteId: "sq_1",
      occurrenceKey: "occ-1",
      stageKey: "entry",
      detectorEvaluationId: "dtev_1",
    },
    nextState: { runs: 1 },
  });

  // priorState flows through: the second run carries the first's counter.
  const second = await drive(
    "evaluate-policy",
    { "sdk.ts": POLICY_SDK, "policy.ts": V2_POLICY },
    policyInput({ runs: 41 }, []),
  );
  assert.deepEqual(JSON.parse(second.stdout).nextState, { runs: 42 });
});

test("evaluate-policy refuses an async propose by name", async () => {
  const asyncPolicy = `${V2_POLICY.replace("export const propose: Propose", "const proposeImpl: Propose")}`;
  const asyncWrap = `${asyncPolicy}\nexport const propose = async (input: Parameters<Propose>[0]) => proposeImpl(input);\nexport type Propose2 = typeof propose;\n`;
  const run = await drive(
    "evaluate-policy",
    {
      "sdk.ts": POLICY_SDK,
      "policy.ts": asyncWrap,
    },
    policyInput(undefined, []),
  );
  assert.ok(run.error instanceof Error, "the async guard must throw");
  assert.equal(run.error.message, "propose must be synchronous");
});

test("evaluate-policy refuses a policy without the propose export by name", async () => {
  const run = await drive(
    "evaluate-policy",
    { "sdk.ts": POLICY_SDK, "policy.ts": "export const notPropose = 1;\n" },
    policyInput(undefined, []),
  );
  assert.ok(run.error instanceof Error, "the missing-export guard must throw");
  assert.equal(run.error.message, "propose export missing");
});

// -- v1 evaluate unchanged -------------------------------------------------------

test("evaluate still runs the v1 signal entry", async () => {
  const run = await drive(
    "evaluate",
    {
      "sdk.ts": V1_SDK,
      "signal.ts": V1_SIGNAL,
      "signal.test.ts": V1_TEST,
    },
    JSON.stringify({ evidence: {}, pools: [] }),
  );
  assert.equal(run.error, undefined);
  assert.deepEqual(JSON.parse(run.stdout), {
    reading: { kind: "insufficient", reason: "fixture" },
    diagnostics: [],
  });
});

// -- run -------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const [name, body] of tests) {
    try {
      await body();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(`  ${error && error.stack ? error.stack : error}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} runner mode tests passed`);
  process.exit(failed === 0 ? 0 : 1);
})();
