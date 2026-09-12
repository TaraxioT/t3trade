// Trusted image entrypoint. This file runs only inside the sealed container.
//
// Modes (one per installed shim):
//   typecheck        — tsc --strict over every *.ts file in /work (test files included)
//   test             — same compile, then run the authored test file through the
//                      SDK harness; at least one registered test must run
//   evaluate         — compile without the *.test.ts files, read a v1 SignalInput
//                      JSON from stdin, call the synchronous readSignal export
//   evaluate-v2      — same compile rule, read a DetectorProgramInputV2 JSON from
//                      stdin, call the synchronous detect export of detector.ts
//   evaluate-policy  — same compile rule, read a PolicyProgramInputV2 JSON from
//                      stdin, call the synchronous propose export of policy.ts
//
// The compile set is DISCOVERED from /work (flat, sorted): the host stages the
// run's file set into the container, so the runner stays data-driven instead
// of naming a bundle's files. Three entry names remain contractual because the
// host's mode dispatch pins them — the v1 entry signal.js, the v2 entry
// detector.js, and the execution-policy entry policy.js (plus whichever
// *.test.js file the bundle authored).
//
// Required as a module, this file exports runMode so the local unit test can
// exercise the dispatch against a real tsc without Docker; nothing executes
// unless this file is the main script.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MODES = ["typecheck", "test", "evaluate", "evaluate-v2", "evaluate-policy"];
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * The flat *.ts files one mode compiles. Evaluate modes exclude the authored
 * test file exactly as the v1 runner did; typecheck and test compile all of
 * it. Sorted, so the compile set is a function of the staged file names.
 */
function discoverTypeScriptFiles(workDir, includeTests) {
  return fs
    .readdirSync(workDir)
    .filter((name) => name.endsWith(".ts") && (includeTests || !name.endsWith(".test.ts")))
    .map((name) => path.join(workDir, name))
    .sort();
}

/**
 * The authored test entry to require after compiling: v1 bundles name it
 * signal.test.ts, detector-program bundles detector.test.ts — dispatch on
 * what /work actually holds, so both bundle generations share one shim.
 */
function testEntry(workDir, outDir) {
  const name = fs.existsSync(path.join(workDir, "detector.test.ts"))
    ? "detector.test.js"
    : "signal.test.js";
  return path.join(outDir, name);
}

/** Evaluate input: the harness-injected string, else the real stdin fd. */
function readStdinUtf8(harness) {
  if (typeof harness.stdin === "string") return harness.stdin;
  return fs.readFileSync(0, "utf8");
}

/** JSON-stringify one mode's result under the output cap — the v1 contract. */
function writeJsonOutput(harness, output) {
  const serialized = JSON.stringify(output);
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_OUTPUT_BYTES)
    throw new Error("invalid output size");
  harness.stdout(serialized);
}

function runMode(mode, harness) {
  if (!MODES.includes(mode)) throw new Error("unknown runner mode");
  const includeTests = mode === "typecheck" || mode === "test";
  const files = discoverTypeScriptFiles(harness.workDir, includeTests);
  if (files.length === 0) throw new Error("no TypeScript files to compile");
  const checked = spawnSync(
    harness.nodePath,
    [
      harness.tscPath,
      "--strict",
      "--target",
      "ES2022",
      "--lib",
      "ES2022",
      "--module",
      "commonjs",
      "--moduleResolution",
      "node",
      "--ignoreDeprecations",
      "6.0",
      "--skipLibCheck",
      "--outDir",
      harness.outDir,
      ...files,
    ],
    // cwd is the run's own workdir — the container's WORKDIR /work — so a
    // stray ancestor tsconfig.json (tsc 6 refuses CLI files beside one) can
    // never change what compiles.
    { encoding: "utf8", maxBuffer: 64 * 1024, env: harness.env, cwd: harness.workDir },
  );
  if (checked.error) throw checked.error;
  if (checked.status !== 0) {
    harness.stderr(checked.stdout + checked.stderr);
    process.exitCode = checked.status ?? 1;
    return;
  }
  if (mode === "test") {
    require(testEntry(harness.workDir, harness.outDir));
    require(path.join(harness.outDir, "sdk.js"))
      .runRegisteredTests()
      .then((count) => {
        if (count < 1) throw new Error("no generated tests ran");
        harness.stdout(JSON.stringify({ testsPassed: count }));
      })
      .catch((error) => {
        harness.stderr(String(error));
        process.exitCode = 1;
      });
  } else if (mode === "evaluate") {
    const input = readStdinUtf8(harness);
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error("input limit");
    const output = require(path.join(harness.outDir, "signal.js")).readSignal(JSON.parse(input));
    if (output && typeof output.then === "function")
      throw new Error("readSignal must be synchronous");
    writeJsonOutput(harness, output);
  } else if (mode === "evaluate-v2") {
    const input = readStdinUtf8(harness);
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error("input limit");
    const program = require(path.join(harness.outDir, "detector.js"));
    if (typeof program.detect !== "function") throw new Error("detect export missing");
    const output = program.detect(JSON.parse(input));
    if (output && typeof output.then === "function") throw new Error("detect must be synchronous");
    writeJsonOutput(harness, output);
  } else if (mode === "evaluate-policy") {
    const input = readStdinUtf8(harness);
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error("input limit");
    const program = require(path.join(harness.outDir, "policy.js"));
    if (typeof program.propose !== "function") throw new Error("propose export missing");
    const output = program.propose(JSON.parse(input));
    if (output && typeof output.then === "function") throw new Error("propose must be synchronous");
    writeJsonOutput(harness, output);
  }
}

if (require.main === module) {
  try {
    runMode(process.argv[2], {
      workDir: "/work",
      outDir: "/tmp/compiled",
      tscPath: "/opt/forge/node_modules/typescript/bin/tsc",
      nodePath: process.execPath,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  } catch (error) {
    // A named refusal: the host turns the nonzero exit into a typed failure.
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { MODES, discoverTypeScriptFiles, runMode };
