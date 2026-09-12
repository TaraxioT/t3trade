// Trusted image entrypoint. This file runs only inside the sealed container.
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const mode = process.argv[2];
if (!["typecheck", "test", "evaluate"].includes(mode)) throw new Error("unknown runner mode");
const files = ["/work/sdk.ts", "/work/signal.ts"];
if (mode !== "evaluate") files.push("/work/signal.test.ts");
const checked = spawnSync(
  process.execPath,
  [
    "/opt/forge/node_modules/typescript/bin/tsc",
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
    "/tmp/compiled",
    ...files,
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } },
);
if (checked.error) throw checked.error;
if (checked.status !== 0) {
  process.stderr.write(checked.stdout + checked.stderr);
  process.exit(checked.status ?? 1);
}
if (mode === "test") {
  require("/tmp/compiled/signal.test.js");
  require("/tmp/compiled/sdk.js")
    .runRegisteredTests()
    .then((count) => {
      if (count < 1) throw new Error("no generated tests ran");
      process.stdout.write(JSON.stringify({ testsPassed: count }));
    })
    .catch((error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
    });
} else if (mode === "evaluate") {
  const input = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error("input limit");
  const output = require("/tmp/compiled/signal.js").readSignal(JSON.parse(input));
  if (output && typeof output.then === "function")
    throw new Error("readSignal must be synchronous");
  const serialized = JSON.stringify(output);
  if (serialized === undefined || Buffer.byteLength(serialized) > 64 * 1024)
    throw new Error("invalid output size");
  process.stdout.write(serialized);
}
