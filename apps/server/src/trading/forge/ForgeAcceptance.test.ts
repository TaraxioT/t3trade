/**
 * ForgeAcceptance — the stateDir contract and refusal rules for host
 * acceptance cases, plus a decode guarantee for the reviewed setup fixtures
 * shipped under infra/forge-acceptance (installed into stateDir by
 * infra/forge-acceptance/install.sh; the running host never imports them).
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off - real files under temp roots and the reviewed setup JSON are the fixture; JSON is the storage codec under test.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ForgeAcceptanceCase } from "@t3tools/trading-contracts";

import { ServerConfig } from "../../config.ts";
import { ForgeAcceptance, ForgeAcceptanceLive } from "./ForgeAcceptance.ts";

const CAPABILITY = "forge-swap-signal";

const layerFor = (baseDir: string) =>
  ForgeAcceptanceLive.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

/** The acceptance service plus its stateDir, over one isolated temp root. */
const withAcceptance = async <A>(
  body: (
    acceptance: {
      readonly read: (
        capabilityId: string,
        version: number,
      ) => Effect.Effect<ReadonlyArray<ForgeAcceptanceCase>, string>;
    },
    stateDir: string,
  ) => Promise<A>,
): Promise<A> => {
  const baseDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-acceptance-"));
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const acceptance = yield* ForgeAcceptance;
        const { stateDir } = yield* ServerConfig;
        return yield* Effect.promise(() => body(acceptance, stateDir));
      }).pipe(Effect.scoped, Effect.provide(layerFor(baseDir))),
    );
  } finally {
    await NodeFs.rm(baseDir, { recursive: true, force: true });
  }
};

const overridePath = (stateDir: string, capabilityId: string, version: number): string =>
  NodePath.join(stateDir, "forge", "acceptance", capabilityId, `v${version}.json`);

const writeOverride = async (path: string, content: string): Promise<void> => {
  await NodeFs.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFs.writeFile(path, content, "utf8");
};

/** A minimal schema-valid case a stateDir file can carry. */
const STATE_CASE = JSON.stringify([
  {
    name: "installed-case",
    input: {
      evidence: {
        mode: "live",
        provider: "the-graph",
        deploymentId: "dep",
        blockNumber: "1",
        blockHash: "0x" + "cd".repeat(32),
        fetchedAtMs: 1_000,
        windowEndMs: 900,
        querySha256: "q",
        responseSha256: "r",
        complete: true,
      },
      pools: [],
    },
    expected: { kind: "insufficient", reason: "installed" },
  },
]);

describe("ForgeAcceptance", () => {
  it("refuses when no stateDir file is configured", async () => {
    await withAcceptance(async (acceptance) => {
      const outcome = await Effect.runPromise(Effect.exit(acceptance.read(CAPABILITY, 1)));
      assert.isTrue(outcome._tag === "Failure");
      if (outcome._tag === "Failure") {
        assert.include(String(outcome.cause), "not configured");
      }
    });
  });

  it("serves a stateDir file that decodes", async () => {
    await withAcceptance(async (acceptance, stateDir) => {
      await writeOverride(overridePath(stateDir, CAPABILITY, 1), STATE_CASE);
      const cases = await Effect.runPromise(acceptance.read(CAPABILITY, 1));
      assert.equal(cases.length, 1);
      assert.equal(cases[0]?.name, "installed-case");
    });
  });

  it("a malformed stateDir file refuses", async () => {
    await withAcceptance(async (acceptance, stateDir) => {
      await writeOverride(overridePath(stateDir, CAPABILITY, 1), "not json at all");
      const outcome = await Effect.runPromise(Effect.exit(acceptance.read(CAPABILITY, 1)));
      assert.isTrue(outcome._tag === "Failure");
      if (outcome._tag === "Failure") {
        assert.include(String(outcome.cause), "invalid");
      }
    });
  });

  it("an oversized stateDir file refuses", async () => {
    await withAcceptance(async (acceptance, stateDir) => {
      await writeOverride(overridePath(stateDir, CAPABILITY, 1), "x".repeat(2 * 1024 * 1024 + 1));
      const outcome = await Effect.runPromise(Effect.exit(acceptance.read(CAPABILITY, 1)));
      assert.isTrue(outcome._tag === "Failure");
      if (outcome._tag === "Failure") {
        assert.include(String(outcome.cause), "size limit");
      }
    });
  });

  it("an empty case array refuses", async () => {
    await withAcceptance(async (acceptance, stateDir) => {
      await writeOverride(overridePath(stateDir, CAPABILITY, 1), "[]");
      const outcome = await Effect.runPromise(Effect.exit(acceptance.read(CAPABILITY, 1)));
      assert.isTrue(outcome._tag === "Failure");
    });
  });

  it("refuses invalid identities before touching the filesystem", async () => {
    await withAcceptance(async (acceptance) => {
      const traversal = await Effect.runPromise(Effect.exit(acceptance.read("../escape", 1)));
      assert.isTrue(traversal._tag === "Failure");
      if (traversal._tag === "Failure") {
        assert.include(String(traversal.cause), "invalid acceptance identity");
      }
      const zero = await Effect.runPromise(Effect.exit(acceptance.read(CAPABILITY, 0)));
      assert.isTrue(zero._tag === "Failure");
    });
  });

  it("the shipped setup fixture decodes against the same schema the builder uses", async () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../../../../..");
    const shipped = await NodeFs.readFile(
      NodePath.join(repoRoot, "infra", "forge-acceptance", CAPABILITY, "v1.json"),
      "utf8",
    );
    const cases = await Effect.runPromise(
      Effect.mapError(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Array(ForgeAcceptanceCase).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
          ),
        )(shipped),
        () => "shipped fixture failed schema decode",
      ),
    );
    // Structure only — the expectations themselves are reviewed data, not
    // re-asserted here: one case per outcome family the v1 plan defines.
    assert.equal(cases.length, 5);
    for (const example of cases) {
      assert.isNotNull(example.input.evidence);
      assert.isTrue(Array.isArray(example.input.pools));
      assert.isNotNull(example.expected);
    }
  });
});
