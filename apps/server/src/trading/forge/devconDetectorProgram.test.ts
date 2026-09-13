/**
 * devconDetectorProgram — the REAL builder flow for the Devcon entry
 * detector: prepare → authored artifacts → check with host acceptance cases
 * → staged bundle, twice (v1, and the v2 semantic revision that tightens the
 * calendar arm), plus the G4 flip proof on IDENTICAL sealed evidence through
 * the existing sandbox seam.
 *
 * The container is the scripted runner at the ForgeContainerRunner seam (the
 * CapabilityBuilder.test.ts / scenarioFixtures precedent), but the authored
 * bytes genuinely COMPILE under the runner's exact tsc flags
 * (compileScenarioPrograms) and the compiled `detect` genuinely runs — the
 * acceptance and flip results below are the real program's outputs, not
 * fixtures.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off preferSchemaOverJson:off - temp workspaces, the tsc compile probe, console reporting of the retained bundle hashes, and the scripted container's JSON stdin codec (the parse IS the fixture).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import type {
  CapturedFact,
  ForgeAcceptanceCaseV2,
  SealedSourceRecord,
} from "@t3tools/trading-contracts";

import {
  DETECTOR_SDK_SCHEMA_VERSION,
  FORGE_RUNNER_EVALUATE_V2,
  FORGE_RUNNER_TEST,
  FORGE_RUNNER_TYPECHECK,
  FORGE_SDK_SOURCE_V2,
  forgeDetectorBundleSha256,
  makeForgeCapabilityBuilder,
  type ForgeCapabilityBuilderShape,
} from "./CapabilityBuilder.ts";
import {
  ForgeCapabilitySandbox,
  ForgeContainerRunner,
  ForgeSandboxConfig,
  forgeSha256Hex,
  makeForgeCapabilitySandbox,
  type ForgeContainerRunnerShape,
} from "./CapabilitySandbox.ts";
import {
  ForgeCapabilityStore,
  ForgeCapabilityStoreConfig,
  makeForgeCapabilityStore,
} from "./CapabilityStore.ts";
import { compileScenarioPrograms, launchPolicySource } from "./scenarioPacks/scenarioFixtures.ts";
import {
  DEVCON_CALENDAR_SOURCE_ID,
  DEVCON_DETECTOR_CAPABILITY_ID,
  DEVCON_ENTRY_WINDOW_END_MS,
  DEVCON_ENTRY_WINDOW_START_MS,
  DEVCON_OCCURRENCE_KEY,
  DEVCON_REVISED_ENTRY_WINDOW_START_MS,
  DEVCON_STREAM_SOURCE_ID,
  devconDetectorSourceV1,
  devconDetectorSourceV2,
  devconDetectorTestSource,
} from "./devconDetectorProgram.ts";

const ENV = "env_devcon_detector";
/** Pinned so both staged bundle hashes are deterministic and retainable. */
const MANIFEST_CREATED_AT_MS = 1_790_000_000_000;
const IMAGE = "registry.local/forge-runner@sha256:" + "ab".repeat(32);

// -- the sealed evidence vocabulary -------------------------------------------

const calendarSource = (): SealedSourceRecord => ({
  sourceId: DEVCON_CALENDAR_SOURCE_ID,
  evidenceId: "rev_devcon8_calendar",
  mode: "live",
  contentSha256: forgeSha256Hex("calendar"),
  complete: true,
  eventAtMs: Date.parse("2026-01-20T00:00:00Z"),
  availableAtMs: Date.parse("2026-01-20T00:01:00Z"),
  availabilityBasis: "recorded",
  expiresAtMs: DEVCON_ENTRY_WINDOW_END_MS + 86_400_000,
  sourceRevision: "rev_devcon8_calendar",
});

const streamSource = (input?: { readonly complete?: boolean }): SealedSourceRecord => ({
  sourceId: DEVCON_STREAM_SOURCE_ID,
  evidenceId: "sev_streamwindow",
  mode: "live",
  contentSha256: forgeSha256Hex("stream"),
  complete: input?.complete ?? true,
  eventAtMs: Date.parse("2026-10-15T12:00:00Z"),
  availableAtMs: Date.parse("2026-10-15T12:00:45Z"),
  availabilityBasis: "recorded",
  expiresAtMs: Date.parse("2026-10-16T12:00:00Z"),
  sourceRevision: "pkg-module-params-1",
});

const calendarFact = (source: SealedSourceRecord): CapturedFact => ({
  id: "dfact_calendar",
  key: "external.document.published",
  entityId: "devcon-8-mumbai-2026",
  value: { kind: "boolean", value: true },
  evidence: [
    {
      id: source.evidenceId,
      environmentId: ENV,
      sourceId: DEVCON_CALENDAR_SOURCE_ID,
      mode: "live",
      contentSha256: source.contentSha256,
      eventAtMs: source.eventAtMs ?? 0,
      availableAtMs: source.availableAtMs ?? 0,
      availabilityBasis: "recorded",
      timePrecision: "second",
      capturedAtMs: source.availableAtMs ?? 0,
      expiresAtMs: source.expiresAtMs ?? 0,
      sourceRevision: "rev_devcon8_calendar",
    },
  ],
});

/** net-amount1-raw is the POOL's signed delta; negative = pool lost WETH =
 * traders net bought. -2.5e18 raw → traders net +2.5e18 wei WETH. */
const streamFact = (source: SealedSourceRecord, netPoolRaw: string): CapturedFact => ({
  id: "dfact_netflow",
  key: "stream.window.net-amount1-raw",
  entityId: "weth-usdc-005",
  value: { kind: "decimal", value: netPoolRaw, unit: "token1-raw" },
  evidence: [
    {
      id: source.evidenceId,
      environmentId: ENV,
      sourceId: "weth-usdc-005",
      mode: "live",
      contentSha256: source.contentSha256,
      eventAtMs: source.eventAtMs ?? 0,
      availableAtMs: source.availableAtMs ?? 0,
      availabilityBasis: "recorded",
      timePrecision: "second",
      capturedAtMs: source.availableAtMs ?? 0,
      expiresAtMs: source.expiresAtMs ?? 0,
      sourceRevision: "pkg-module-params-1",
    },
  ],
});

const sealedInput = (input: {
  readonly asOfMs: number;
  readonly calendar: boolean;
  readonly streamComplete: boolean;
  readonly netPoolRaw: string;
}) => {
  const calendar = calendarSource();
  const stream = streamSource({ complete: input.streamComplete });
  const facts = [
    ...(input.calendar ? [calendarFact(calendar)] : []),
    ...(input.streamComplete ? [streamFact(stream, input.netPoolRaw)] : []),
  ];
  return {
    programSchemaVersion: 2 as const,
    asOfMs: input.asOfMs,
    inputDigest: forgeSha256Hex(`${input.asOfMs}:${input.netPoolRaw}`),
    facts,
    sources: [...(input.calendar ? [calendar] : []), stream],
    priorState: null,
  };
};

// -- the scripted container runner over GENUINELY compiled programs ----------

interface CompiledDetect {
  readonly detect: (input: unknown) => { readonly result: unknown; readonly nextState: unknown };
  readonly cleanup: () => Promise<void>;
}

const compileDetector = async (detectorSource: string): Promise<CompiledDetect> => {
  const program = await compileScenarioPrograms({
    detectorSource,
    testSource: devconDetectorTestSource(),
    policySource: launchPolicySource,
  });
  return { detect: program.detect, cleanup: program.cleanup };
};

const runnerOver = (
  compiledByDetectorSource: Map<string, CompiledDetect>,
): ForgeContainerRunnerShape => ({
  available: Effect.succeed(true),
  run: (request) =>
    Effect.sync(() => {
      const head = request.entrypoint[0];
      if (head === FORGE_RUNNER_TYPECHECK[0] || head === FORGE_RUNNER_TEST[0]) {
        // The genuine tsc compile happened at Map-build time; these heads
        // answer with the compile's own outcome (it threw on failure).
        return { exitCode: 0, stdout: "", stderr: "", killed: null };
      }
      if (head === FORGE_RUNNER_EVALUATE_V2[0]) {
        const detectorFile = request.files.find((file) => file.path === "detector.ts");
        const compiled =
          detectorFile === undefined
            ? undefined
            : compiledByDetectorSource.get(detectorFile.content);
        if (compiled === undefined) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "no compiled program for this bundle",
            killed: null,
          };
        }
        const output = compiled.detect(JSON.parse(request.stdin ?? "{}"));
        return { exitCode: 0, stdout: JSON.stringify(output), stderr: "", killed: null };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown entrypoint", killed: null };
    }),
});

const builderWith = async (
  runner: ForgeContainerRunnerShape,
  stateRoot: string,
): Promise<ForgeCapabilityBuilderShape> => {
  const sandbox = await Effect.runPromise(
    makeForgeCapabilitySandbox.pipe(
      Effect.provideService(ForgeSandboxConfig, {
        imageRef: IMAGE,
        buildBudgetMs: 30_000,
        evaluationBudgetMs: 2_000,
      }),
      Effect.provideService(ForgeContainerRunner, runner),
    ),
  );
  const store = await Effect.runPromise(
    makeForgeCapabilityStore.pipe(Effect.provideService(ForgeCapabilityStoreConfig, { stateRoot })),
  );
  return Effect.runPromise(
    makeForgeCapabilityBuilder.pipe(
      Effect.provideService(ForgeCapabilitySandbox, sandbox),
      Effect.provideService(ForgeCapabilityStore, store),
    ),
  );
};

// -- manifest + staging --------------------------------------------------------

const manifestJsonFor = (version: number, detectorSource: string): string =>
  JSON.stringify({
    manifestVersion: 2,
    capabilityId: DEVCON_DETECTOR_CAPABILITY_ID,
    version,
    semantics:
      "Devcon entry detector: verified next-Devcon calendar window AND study-frozen net WETH accumulation over a complete Substreams window",
    requiredSourceIds: [DEVCON_CALENDAR_SOURCE_ID, DEVCON_STREAM_SOURCE_ID],
    outputFactKeys: ["stream.window.net-amount1-raw"],
    artifacts: [
      { role: "sdk", path: "sdk.ts", sha256: forgeSha256Hex(FORGE_SDK_SOURCE_V2) },
      { role: "detector", path: "detector.ts", sha256: forgeSha256Hex(detectorSource) },
      {
        role: "acceptance",
        path: "detector.test.ts",
        sha256: forgeSha256Hex(devconDetectorTestSource()),
      },
    ],
    createdAtMs: MANIFEST_CREATED_AT_MS,
  });

const writeStaging = async (
  stagingDir: string,
  version: number,
  detectorSource: string,
): Promise<void> => {
  await NodeFs.mkdir(stagingDir, { recursive: true });
  await NodeFs.writeFile(NodePath.join(stagingDir, "detector.ts"), detectorSource, "utf8");
  await NodeFs.writeFile(
    NodePath.join(stagingDir, "detector.test.ts"),
    devconDetectorTestSource(),
    "utf8",
  );
  await NodeFs.writeFile(
    NodePath.join(stagingDir, "manifest.json"),
    manifestJsonFor(version, detectorSource),
    "utf8",
  );
};

describe("devconDetectorProgram builder flow", () => {
  it("stages v1 and the tightened v2 revision through prepare/check; identical evidence flips matched to not-matched", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "devcon-detector-"));
    try {
      const v1Source = devconDetectorSourceV1();
      const v2Source = devconDetectorSourceV2();
      assert.notEqual(v1Source, v2Source);
      assert.include(
        v2Source,
        `const entryWindowStartMs = ${DEVCON_REVISED_ENTRY_WINDOW_START_MS};`,
      );

      // The authored bytes genuinely compile under the runner's flags first.
      const v1 = await compileDetector(v1Source);
      const v2 = await compileDetector(v2Source);
      try {
        const runner = runnerOver(
          new Map([
            [v1Source, v1],
            [v2Source, v2],
          ]),
        );
        const builder = await builderWith(runner, root);
        const staging = NodePath.join(root, "staging");

        // -- v1: prepare, author, check with host acceptance cases. ----------
        const prepared1 = await Effect.runPromise(
          builder.prepare({
            environmentId: ENV,
            capabilityId: DEVCON_DETECTOR_CAPABILITY_ID,
            requestedSemantics:
              "detect the verified pre-Devcon-8 entry window together with study-frozen net WETH accumulation on the WETH/USDC pool",
            stagingDir: staging,
            manifestVersion: 2,
          }),
        );
        await writeStaging(staging, 1, v1Source);

        const inWindow = sealedInput({
          asOfMs: Date.parse("2026-10-15T12:00:00Z"),
          calendar: true,
          streamComplete: true,
          netPoolRaw: "-2500000000000000000",
        });
        const checked1 = await Effect.runPromise(
          builder.check({
            buildId: prepared1.build.buildId,
            environmentId: ENV,
            stagingDir: staging,
            acceptanceCases: [],
            acceptanceV2: [
              {
                name: "matched-inside-entry-window-with-net-accumulation",
                input: inWindow,
                expected: {
                  result: {
                    status: "matched",
                    occurrenceKey: DEVCON_OCCURRENCE_KEY,
                    evidenceIds: ["rev_devcon8_calendar", "sev_streamwindow"],
                    facts: [inWindow.facts[1]!],
                    validUntilMs: DEVCON_ENTRY_WINDOW_END_MS,
                  },
                  nextState: { stateSchemaVersion: 1, state: { evaluations: 1 } },
                },
              },
              {
                name: "not-matched-outside-entry-window",
                input: sealedInput({
                  asOfMs: Date.parse("2026-09-13T00:00:00Z"),
                  calendar: true,
                  streamComplete: true,
                  netPoolRaw: "-2500000000000000000",
                }),
                expected: {
                  result: {
                    status: "not-matched",
                    evidenceIds: ["rev_devcon8_calendar"],
                    explanation: `outside the research-fixed Devcon entry window [${DEVCON_ENTRY_WINDOW_START_MS}, ${DEVCON_ENTRY_WINDOW_END_MS})`,
                  },
                  nextState: { stateSchemaVersion: 1, state: { evaluations: 1 } },
                },
              },
              {
                name: "not-matched-below-study-frozen-threshold",
                input: sealedInput({
                  asOfMs: Date.parse("2026-10-15T12:00:00Z"),
                  calendar: true,
                  streamComplete: true,
                  netPoolRaw: "-500000000000000000",
                }),
                expected: {
                  result: {
                    status: "not-matched",
                    evidenceIds: ["sev_streamwindow"],
                    explanation:
                      "trader net WETH acquisition 500000000000000000 raw is below the study-frozen threshold 1000000000000000000",
                  },
                  nextState: { stateSchemaVersion: 1, state: { evaluations: 1 } },
                },
              },
              {
                name: "unknown-on-incomplete-stream-window",
                input: sealedInput({
                  asOfMs: Date.parse("2026-10-15T12:00:00Z"),
                  calendar: true,
                  streamComplete: false,
                  netPoolRaw: "-2500000000000000000",
                }),
                expected: {
                  result: {
                    status: "unknown",
                    missingSourceIds: [DEVCON_STREAM_SOURCE_ID],
                    explanation:
                      "the calendar evidence or the substreams window is unavailable or incomplete",
                  },
                  nextState: { stateSchemaVersion: 1, state: { evaluations: 1 } },
                },
              },
            ],
          }),
        );
        assert.equal(checked1.build.stage, "ready");
        assert.isDefined(checked1.staged);
        assert.equal(checked1.staged?.version.version, 1);
        const v1Hash = checked1.staged?.version.bundleSha256;
        assert.isDefined(v1Hash);
        // Deterministic: the pinned manifest clock makes the hash retainable.
        assert.equal(
          v1Hash,
          forgeDetectorBundleSha256({
            "detector.ts": v1Source,
            "detector.test.ts": devconDetectorTestSource(),
            "manifest.json": manifestJsonFor(1, v1Source),
            "sdk.ts": FORGE_SDK_SOURCE_V2,
          }),
        );
        console.log("Devcon detector v1 bundle sha256:", v1Hash);

        // -- v2: the semantic revision, same flow, tightened calendar. -------
        const prepared2 = await Effect.runPromise(
          builder.prepare({
            environmentId: ENV,
            capabilityId: DEVCON_DETECTOR_CAPABILITY_ID,
            requestedSemantics:
              "revision: tighten the Devcon entry calendar to the final week before the event; the onchain condition is unchanged",
            stagingDir: staging,
            manifestVersion: 2,
          }),
        );
        await writeStaging(staging, 2, v2Source);
        const lateWindow = sealedInput({
          asOfMs: Date.parse("2026-10-28T12:00:00Z"),
          calendar: true,
          streamComplete: true,
          netPoolRaw: "-2500000000000000000",
        });
        const checked2 = await Effect.runPromise(
          builder.check({
            buildId: prepared2.build.buildId,
            environmentId: ENV,
            stagingDir: staging,
            acceptanceCases: [],
            acceptanceV2: [
              // The flip case: identical calendar+flow evidence, asOf inside
              // the 30d window but outside the tightened 7d one.
              {
                name: "revision-flips-to-not-matched-inside-30d-but-outside-7d",
                input: inWindow,
                expected: {
                  result: {
                    status: "not-matched",
                    evidenceIds: ["rev_devcon8_calendar"],
                    explanation: `outside the research-fixed Devcon entry window [${DEVCON_REVISED_ENTRY_WINDOW_START_MS}, ${DEVCON_ENTRY_WINDOW_END_MS})`,
                  },
                  nextState: { stateSchemaVersion: 1, state: { evaluations: 1 } },
                },
              },
              // And the tightened rule still matches inside its own window.
              {
                name: "revision-matches-inside-the-tightened-window",
                input: lateWindow,
                expected: {
                  result: {
                    status: "matched",
                    occurrenceKey: DEVCON_OCCURRENCE_KEY,
                    evidenceIds: ["rev_devcon8_calendar", "sev_streamwindow"],
                    facts: [lateWindow.facts[1]!],
                    validUntilMs: DEVCON_ENTRY_WINDOW_END_MS,
                  },
                  nextState: { stateSchemaVersion: 1, state: { evaluations: 1 } },
                },
              },
            ],
          }),
        );
        assert.equal(checked2.build.stage, "ready");
        const v2Hash = checked2.staged?.version.bundleSha256;
        assert.isDefined(v2Hash);
        assert.notEqual(v1Hash, v2Hash);
        console.log("Devcon detector v2 (tightened calendar) bundle sha256:", v2Hash);

        // -- the G4 flip proof on IDENTICAL sealed evidence, no host branches.
        const v1Output = v1.detect(inWindow) as { result: { status: string } };
        const v2Output = v2.detect(inWindow) as { result: { status: string } };
        assert.equal(v1Output.result.status, "matched");
        assert.equal(v2Output.result.status, "not-matched");
      } finally {
        await v1.cleanup();
        await v2.cleanup();
      }
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });
});
