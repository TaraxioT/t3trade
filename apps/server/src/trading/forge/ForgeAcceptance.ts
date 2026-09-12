import { Context, Effect, Layer, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ForgeAcceptanceCase } from "@t3tools/trading-contracts";
import { ServerConfig } from "../../config.ts";

/** Expectations are host-reviewed setup, never an agent tool argument. */
export class ForgeAcceptance extends Context.Service<
  ForgeAcceptance,
  {
    readonly read: (
      capabilityId: string,
      version: number,
    ) => Effect.Effect<ReadonlyArray<ForgeAcceptanceCase>, string>;
  }
>()("t3/trading/forge/ForgeAcceptance") {}

export const ForgeAcceptanceLive = Layer.effect(
  ForgeAcceptance,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    return ForgeAcceptance.of({
      read: (capabilityId, version) =>
        Effect.gen(function* () {
          if (
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(capabilityId) ||
            capabilityId.includes("..") ||
            !Number.isSafeInteger(version) ||
            version < 1
          )
            return yield* Effect.fail("invalid acceptance identity");
          const filename = path.join(
            config.stateDir,
            "forge",
            "acceptance",
            capabilityId,
            `v${version}.json`,
          );
          const stat = yield* fs
            .stat(filename)
            .pipe(
              Effect.mapError(
                () => "host-reviewed acceptance cases are not configured for this version",
              ),
            );
          if (stat.size > 2 * 1024 * 1024)
            return yield* Effect.fail("acceptance file exceeds its size limit");
          const raw = yield* fs
            .readFileString(filename)
            .pipe(Effect.mapError(() => "could not read host acceptance cases"));
          return yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Array(ForgeAcceptanceCase).check(
                Schema.isMinLength(1),
                Schema.isMaxLength(32),
              ),
            ),
          )(raw).pipe(Effect.mapError(() => "host acceptance file is invalid"));
        }),
    });
  }),
);
