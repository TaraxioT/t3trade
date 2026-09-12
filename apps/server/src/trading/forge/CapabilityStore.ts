/**
 * CapabilityStore — the durable, immutable installation boundary for Forge
 * capabilities.
 *
 * File-based on purpose: bundles are write-once artifacts under the
 * environment's application state, and the install history is an append-only
 * log replayed on open — a restart discovers everything, and nothing needs a
 * database migration to exist. The store NEVER writes under the trading
 * signer base: capability bytes and signer material are separated at the path
 * level, asserted in tests.
 *
 * Everything here is a direct user-service operation. No provider, no agent,
 * no network, no exchange, no signing — pause/resume/uninstall work with
 * every provider stopped.
 *
 * @module CapabilityStore
 */
// @effect-diagnostics nodeBuiltinImport:off - the store is a file store: fs/path/crypto are the implementation, and atomic write-then-rename has no Effect equivalent here.
// @effect-diagnostics globalDate:off globalDateInEffect:off - install/build receipts are wall-clock instants persisted as data.
// @effect-diagnostics preferSchemaOverJson:off - the history and bundle files are round-tripped through schemas on read; JSON is the storage codec.
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Layer from "effect/Layer";
import * as NodePath from "node:path";
import { randomUUID } from "node:crypto";
import * as NodeCrypto from "node:crypto";

import {
  CapabilityManifestV2,
  detectorArtifactPaths,
  FORGE_CAPABILITY_ARTIFACT_PATHS,
  FORGE_MAX_LISTED_ITEMS,
  ForgeBuildReceipt,
  ForgeCapabilityCatalogEntry,
  ForgeCapabilityVersion,
  ForgeEvaluationEvidence,
  ForgePoolProposal,
  ForgePolicyBinding,
  type ForgeCapabilityStatus,
} from "@t3tools/trading-contracts";

// ---------------------------------------------------------------------------
// Errors and refusals
// ---------------------------------------------------------------------------

/** An IO or integrity failure the store cannot serve through. */
export class ForgeStoreError extends Data.TaggedError("ForgeStoreError")<{
  readonly reason: string;
}> {
  constructor(reason: string) {
    super({ reason });
  }

  override get message(): string {
    return `forge capability store: ${this.reason}`;
  }
}

/** A value-level refusal: the caller's next move depends on which rule held. */
export interface ForgeInstallRefusal {
  readonly status: "refused";
  readonly reason:
    | "unknown_version"
    | "hash_mismatch"
    | "active_version_mismatch"
    | "not_installed"
    | "already_installed";
  readonly detail: string;
}

export type ForgeInstallOutcome =
  | { readonly status: "installed"; readonly capabilityId: string; readonly version: number }
  | ForgeInstallRefusal;

export type ForgeStageOutcome =
  | { readonly status: "staged"; readonly capabilityId: string; readonly version: number }
  | ForgeStageRefusal;

export interface ForgeStageRefusal {
  readonly status: "refused";
  /** `tampered` — the version identity already exists with different bytes. */
  readonly reason: "tampered" | "invalid_version";
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Configuration and path separation
// ---------------------------------------------------------------------------

export interface ForgeCapabilityStoreSettings {
  /** The environment-application-state root the store writes under. */
  readonly stateRoot: string;
}

export class ForgeCapabilityStoreConfig extends Context.Service<
  ForgeCapabilityStoreConfig,
  ForgeCapabilityStoreSettings
>()("t3/trading/forge/CapabilityStore/ForgeCapabilityStoreConfig") {}

const envOrNull = (name: string): string | null => {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
};

/**
 * Where Forge capability state lives by default: the application-state home
 * (`T3CODE_HOME`, else `~/.t3trade`), never the signer base. The signer base
 * override (`T3TRADE_HOME`, else `~/.t3trade`) only ever resolves signing
 * material under `secrets`.
 */
export const defaultForgeStateRoot = (homeDir: string): string =>
  NodePath.join(envOrNull("T3CODE_HOME") ?? NodePath.join(homeDir, ".t3trade"), "forge");

/**
 * The signer base's secret material directory, for the separation guard.
 * `T3TRADE_HOME` is the signer-base override; its `secrets` tree is where
 * signing keys live.
 */
export const forgeSignerSecretsRoot = (homeDir: string): string =>
  NodePath.join(envOrNull("T3TRADE_HOME") ?? NodePath.join(homeDir, ".t3trade"), "secrets");

/**
 * Refuse a state root that would put capability bytes under (or beside, in
 * the same tree as) signer material. Path-level separation, enforced at
 * construction and pinned by tests.
 */
export const ensureForgeStateOutsideSignerBase = (
  stateRoot: string,
  signerSecretsRoot: string,
): void => {
  const normalizedRoot = NodePath.resolve(stateRoot);
  const normalizedSecrets = NodePath.resolve(signerSecretsRoot);
  const inside = (child: string, parent: string) =>
    child === parent || child.startsWith(parent + NodePath.sep);
  if (inside(normalizedRoot, normalizedSecrets)) {
    throw new ForgeStoreError(
      `refusing to store capability bundles under the signer secrets tree ${normalizedSecrets}`,
    );
  }
};

/** A safe path segment: flat, no traversal, no separators. */
const isSafeSegment = (segment: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment) && !segment.includes("..");

/**
 * Join under root, refusing anything that could escape it. Every store path
 * is built through here.
 */
export const safeJoinStorePath = (root: string, segments: ReadonlyArray<string>): string => {
  for (const segment of segments) {
    if (!isSafeSegment(segment)) {
      throw new ForgeStoreError(`refusing unsafe store path segment ${JSON.stringify(segment)}`);
    }
  }
  const resolved = NodePath.resolve(root, ...segments);
  const normalizedRoot = NodePath.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + NodePath.sep)) {
    throw new ForgeStoreError(`refusing store path outside ${normalizedRoot}`);
  }
  return resolved;
};

export const ForgeCapabilityStoreConfigFromEnv = Layer.effect(
  ForgeCapabilityStoreConfig,
  Effect.promise(async (): Promise<ForgeCapabilityStoreSettings> => {
    const os = await import("node:os");
    const stateRoot =
      envOrNull("T3_FORGE_CAPABILITY_STATE_ROOT") ?? defaultForgeStateRoot(os.homedir());
    ensureForgeStateOutsideSignerBase(stateRoot, forgeSignerSecretsRoot(os.homedir()));
    return { stateRoot };
  }),
);

// ---------------------------------------------------------------------------
// Durable shapes
// ---------------------------------------------------------------------------

/** The immutable on-disk version record: the exact tested bytes, write-once. */
export const ForgeStoredVersion = Schema.Struct({
  version: ForgeCapabilityVersion,
  /** Artifact contents by name — what evaluation later runs, byte-exact. */
  contents: Schema.Record(Schema.String, Schema.String),
  storedAtMs: Schema.Number,
});
export type ForgeStoredVersion = typeof ForgeStoredVersion.Type;

/** One lifecycle event on the install log, replayed to derive current state. */
export interface ForgeInstallEvent {
  readonly environmentId: string;
  readonly capabilityId: string;
  readonly version: number;
  readonly bundleSha256: string;
  /**
   * `arm`/`disarm` gate the detector's standing, independent of pause:
   * pausing pauses evaluation of an installed capability, arming says the
   * installed version is allowed to stand as a detector at all. An uninstall
   * resets armed — a reinstall must be re-armed deliberately.
   */
  readonly kind: "install" | "pause" | "resume" | "uninstall" | "arm" | "disarm";
  readonly atMs: number;
}

interface HistoryFile {
  readonly builds: Array<ForgeBuildReceipt>;
  readonly installLog: Array<ForgeInstallEvent>;
  readonly evaluations: Array<ForgeEvaluationEvidence>;
  readonly proposals: Array<ForgePoolProposal>;
  readonly policies: Array<ForgePolicyBinding>;
}

/** A fresh empty history — never a shared instance: the missing-file path is
 * the normal first-read path, and a caller mutates what it reads. */
const emptyHistory = (): HistoryFile => ({
  builds: [],
  installLog: [],
  evaluations: [],
  proposals: [],
  policies: [],
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface ForgeCapabilityStoreShape {
  // -- builds (the host's receipt trail) --------------------------------
  readonly startBuild: (input: {
    readonly environmentId: string;
    readonly threadId?: string | undefined;
    readonly capabilityId?: string | undefined;
    readonly requestedSemantics: string;
  }) => Effect.Effect<ForgeBuildReceipt, ForgeStoreError>;
  readonly appendBuildStage: (input: {
    readonly buildId: string;
    readonly stage: ForgeBuildReceipt["stage"];
    readonly detail?: string | undefined;
    readonly patch?: Partial<
      Pick<
        ForgeBuildReceipt,
        | "checks"
        | "acceptance"
        | "artifactSha256"
        | "bundleSha256"
        | "capabilityId"
        | "failureReason"
      >
    >;
  }) => Effect.Effect<ForgeBuildReceipt, ForgeStoreError>;
  readonly getBuild: (buildId: string) => Effect.Effect<ForgeBuildReceipt | null, ForgeStoreError>;
  readonly listBuilds: (input: {
    readonly environmentId: string;
    readonly capabilityId?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<ForgeBuildReceipt>, ForgeStoreError>;

  readonly nextVersion: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
  }) => Effect.Effect<number, ForgeStoreError>;

  // -- versions (immutable bundles) --------------------------------------
  /**
   * Write-once: same identity + same bytes is idempotent; different bytes is
   * tampering and refuses. `contents` are the exact tested bytes, keyed by
   * artifact name.
   */
  readonly stageVersion: (
    environmentId: string,
    version: ForgeCapabilityVersion,
    contents: Readonly<Record<string, string>>,
  ) => Effect.Effect<ForgeStageOutcome, ForgeStoreError>;
  readonly readVersion: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
    readonly version: number;
  }) => Effect.Effect<ForgeCapabilityVersion | null, ForgeStoreError>;
  /** Sanitized artifact read: flat artifact names only, contents by version. */
  readonly readArtifact: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
    readonly version: number;
    readonly path: string;
  }) => Effect.Effect<string | null, ForgeStoreError>;

  // -- installation (CAS) --------------------------------------------------
  readonly install: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
    readonly version: number;
    readonly bundleSha256: string;
    /** The active version the caller read; null means "must not be active". */
    readonly expectedActiveVersion: number | null;
    readonly buildId?: string;
  }) => Effect.Effect<ForgeInstallOutcome, ForgeStoreError>;
  readonly activeState: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
  }) => Effect.Effect<
    {
      readonly version: number;
      readonly bundleSha256: string;
      readonly status: ForgeCapabilityStatus;
      /** Detector standing; false by default — installation never arms. */
      readonly armed: boolean;
    } | null,
    ForgeStoreError
  >;
  readonly pause: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
  }) => Effect.Effect<boolean, ForgeStoreError>;
  readonly resume: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
  }) => Effect.Effect<boolean, ForgeStoreError>;
  readonly uninstall: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
  }) => Effect.Effect<boolean, ForgeStoreError>;
  /**
   * Arm the installed capability's detector standing. Refuses (false) unless
   * an active installed version exists: uninstalled cannot arm, paused CAN —
   * pausing pauses evaluation, arming gates the standing, and they compose.
   * Idempotent: arming an armed capability is a no-op success. Arming does
   * NOT evaluate anything; scheduling belongs to the reactor.
   */
  readonly arm: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
  }) => Effect.Effect<boolean, ForgeStoreError>;
  /** Disarm: always allowed while the capability is actively installed. Idempotent. */
  readonly disarm: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
  }) => Effect.Effect<boolean, ForgeStoreError>;
  readonly listCatalog: (
    environmentId: string,
  ) => Effect.Effect<ReadonlyArray<ForgeCapabilityCatalogEntry>, ForgeStoreError>;

  // -- evaluations -----------------------------------------------------------
  readonly recordEvaluation: (
    evaluation: ForgeEvaluationEvidence,
  ) => Effect.Effect<void, ForgeStoreError>;
  readonly latestEvaluation: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
  }) => Effect.Effect<ForgeEvaluationEvidence | null, ForgeStoreError>;
  readonly listEvaluations: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<ForgeEvaluationEvidence>, ForgeStoreError>;

  // -- pool proposals (approval is a human act, never the agent's) ----------
  readonly proposePool: (input: {
    readonly environmentId: string;
    readonly poolId: string;
    readonly threadId?: string | undefined;
    readonly reason?: string | undefined;
  }) => Effect.Effect<ForgePoolProposal, ForgeStoreError>;
  /** Direct user-service path; deliberately NOT reachable from the agent tool. */
  readonly approvePool: (input: {
    readonly environmentId: string;
    readonly proposalId: string;
  }) => Effect.Effect<ForgePoolProposal | null, ForgeStoreError>;
  readonly rejectPool: (input: {
    readonly environmentId: string;
    readonly proposalId: string;
  }) => Effect.Effect<ForgePoolProposal | null, ForgeStoreError>;
  readonly findApprovedPool: (input: {
    readonly environmentId: string;
    readonly poolId: string;
  }) => Effect.Effect<ForgePoolProposal | null, ForgeStoreError>;
  readonly listProposals: (
    environmentId: string,
  ) => Effect.Effect<ReadonlyArray<ForgePoolProposal>, ForgeStoreError>;

  // -- policy bindings (records only; no chain, no signing in F2) -----------
  readonly bindPolicy: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
    readonly capabilityVersion: number;
    readonly bundleSha256: string;
    readonly poolId: string;
    readonly detectionFeeHundredthsBps: 500 | 3000;
    readonly sourceEvaluationId?: string | undefined;
  }) => Effect.Effect<ForgePolicyBinding, ForgeStoreError>;
  readonly revokePolicy: (input: {
    readonly environmentId: string;
    readonly policyId: string;
  }) => Effect.Effect<ForgePolicyBinding | null, ForgeStoreError>;
  readonly listPolicies: (
    environmentId: string,
  ) => Effect.Effect<ReadonlyArray<ForgePolicyBinding>, ForgeStoreError>;
}

export class ForgeCapabilityStore extends Context.Service<
  ForgeCapabilityStore,
  ForgeCapabilityStoreShape
>()("t3/trading/forge/CapabilityStore/ForgeCapabilityStore") {}

const decodeBuild = (value: unknown): ForgeBuildReceipt | null => {
  try {
    return Schema.decodeUnknownSync(ForgeBuildReceipt)(value);
  } catch {
    return null;
  }
};

const decodeEvaluation = (value: unknown): ForgeEvaluationEvidence | null => {
  try {
    return Schema.decodeUnknownSync(ForgeEvaluationEvidence)(value);
  } catch {
    return null;
  }
};

const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

// -- detector-program (v2) read support --------------------------------------

/**
 * The bundle's authoritative v2 manifest, decoded from the stored
 * `contents["manifest.json"]` (staged byte-exact by the builder), or null.
 * The `manifestVersion === 2` literal in the schema IS the discriminator:
 * v1 bundles decode to null here and keep the v1 read vocabulary.
 */
const decodeDetectorManifest = (
  contents: Readonly<Record<string, string>>,
): CapabilityManifestV2 | null => {
  const raw = contents["manifest.json"];
  if (raw === undefined) return null;
  try {
    return Schema.decodeUnknownSync(CapabilityManifestV2)(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

/**
 * Discriminate a stored version's program kind from its `manifest.json`
 * bytes — the same discriminator `readArtifact` dispatches on. Callers pass
 * the contents' manifest bytes (the v1-typed version header cannot carry it:
 * its `schemaVersion` is pinned to 1 by the staging shape).
 */
export function versionProgramKind(manifestJson: string | undefined | null): "v1" | "v2" {
  if (manifestJson === undefined || manifestJson === null) return "v1";
  try {
    const parsed: unknown = JSON.parse(manifestJson);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>)["manifestVersion"] === 2
    ) {
      return "v2";
    }
  } catch {
    // Not JSON: the v1 four-artifact vocabulary.
  }
  return "v1";
}

/**
 * Hash re-verification on read. The v1 record and the v2 staging shape both
 * carry the four required paths in `version.artifacts` with bytes+sha256; a
 * v2 OPTIONAL path (transform, state-schema, query, policy) is declared only
 * in the bundle's v2 manifest, which pins its sha256. A path with no
 * declaration at all, or bytes that no longer match, is a tampered store.
 */
const readVerifiedArtifact = (
  stored: ForgeStoredVersion,
  path: string,
  detectorManifest: CapabilityManifestV2 | undefined,
): string => {
  const content = stored.contents[path];
  if (content === undefined) {
    throw new ForgeStoreError("stored artifact no longer matches its checked hash");
  }
  const digest = NodeCrypto.createHash("sha256").update(content).digest("hex");
  const artifact = stored.version.artifacts.find((candidate) => candidate.path === path);
  if (artifact !== undefined) {
    if (Buffer.byteLength(content, "utf8") !== artifact.bytes || digest !== artifact.sha256) {
      throw new ForgeStoreError("stored artifact no longer matches its checked hash");
    }
    return content;
  }
  const declared = detectorManifest?.artifacts.find((candidate) => candidate.path === path);
  if (declared === undefined || digest !== declared.sha256) {
    throw new ForgeStoreError("stored artifact no longer matches its checked hash");
  }
  return content;
};

export const makeForgeCapabilityStore = Effect.gen(function* () {
  const { stateRoot } = yield* ForgeCapabilityStoreConfig;
  const fs = yield* Effect.promise(() => import("node:fs/promises"));

  const historyPath = (environmentId: string): string =>
    safeJoinStorePath(stateRoot, [environmentId, "history.json"]);
  const versionPath = (environmentId: string, capabilityId: string, version: number): string =>
    safeJoinStorePath(stateRoot, [environmentId, "bundles", capabilityId, `v${version}.json`]);

  let operations: Promise<unknown> = Promise.resolve();
  const io = <A>(label: string, work: () => Promise<A>): Effect.Effect<A, ForgeStoreError> =>
    Effect.tryPromise({
      try: () => {
        const next = operations.then(work, work);
        operations = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
      catch: (error) =>
        new ForgeStoreError(`${label}: ${error instanceof Error ? error.message : String(error)}`),
    });

  /** Atomic write: temp file in the same directory, then rename over. */
  const writeAtomic = async (path: string, contents: string): Promise<void> => {
    await fs.mkdir(NodePath.dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, contents, "utf8");
    await fs.rename(temp, path);
  };

  const readHistory = (environmentId: string): Promise<HistoryFile> =>
    fs
      .readFile(historyPath(environmentId), "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as Partial<HistoryFile>;
        return {
          builds: (parsed.builds ?? []).flatMap((build) => {
            const decoded = decodeBuild(build);
            return decoded === null ? [] : [decoded];
          }),
          installLog: parsed.installLog ?? [],
          evaluations: (parsed.evaluations ?? []).flatMap((evaluation) => {
            const decoded = decodeEvaluation(evaluation);
            return decoded === null ? [] : [decoded];
          }),
          proposals: parsed.proposals ?? [],
          policies: parsed.policies ?? [],
        } satisfies HistoryFile;
      })
      .catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return emptyHistory();
        throw error;
      });

  const writeHistory = (environmentId: string, history: HistoryFile): Promise<void> =>
    writeAtomic(historyPath(environmentId), JSON.stringify(history));

  // -- builds ---------------------------------------------------------------

  const startBuild: ForgeCapabilityStoreShape["startBuild"] = ({
    environmentId,
    threadId,
    capabilityId,
    requestedSemantics,
  }) =>
    io("startBuild", async () => {
      const history = await readHistory(environmentId);
      const atMs = Date.now();
      const buildId = `fbuild_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const receipt: ForgeBuildReceipt = {
        buildId,
        environmentId,
        ...(threadId === undefined ? {} : { threadId }),
        ...(capabilityId === undefined ? {} : { capabilityId }),
        requestedSemantics,
        stage: "requested",
        stages: [{ stage: "requested", atMs }],
        createdAtMs: atMs,
        updatedAtMs: atMs,
      };
      history.builds.push(receipt);
      await writeHistory(environmentId, history);
      return receipt;
    });

  const appendBuildStage: ForgeCapabilityStoreShape["appendBuildStage"] = ({
    buildId,
    stage,
    detail,
    patch,
  }) =>
    io("appendBuildStage", async () => {
      for (const environmentId of await listEnvironmentIds()) {
        const history = await readHistory(environmentId);
        const index = history.builds.findIndex((candidate) => candidate.buildId === buildId);
        if (index < 0) continue;
        const atMs = Date.now();
        const prior = history.builds[index]!;
        if (["cancelled", "failed", "installed"].includes(prior.stage)) {
          if (stage === prior.stage) return prior;
          throw new ForgeStoreError(`build ${buildId} is terminal (${prior.stage})`);
        }
        const updated: ForgeBuildReceipt = {
          ...prior,
          ...(patch ?? {}),
          capabilityId: patch?.capabilityId ?? prior.capabilityId,
          stage,
          stages: [...prior.stages, { stage, atMs, ...(detail === undefined ? {} : { detail }) }],
          updatedAtMs: atMs,
        };
        history.builds[index] = updated;
        await writeHistory(environmentId, history);
        return updated;
      }
      throw new ForgeStoreError(`no build ${buildId}`);
    });

  const listEnvironmentIds = (): Promise<Array<string>> =>
    fs
      .readdir(stateRoot)
      .then((entries) => entries.filter((entry) => isSafeSegment(entry)))
      .catch(() => []);

  const getBuild: ForgeCapabilityStoreShape["getBuild"] = (buildId) =>
    io("getBuild", async () => {
      for (const environmentId of await listEnvironmentIds()) {
        const history = await readHistory(environmentId);
        const found = history.builds.find((candidate) => candidate.buildId === buildId);
        if (found !== undefined) return found;
      }
      return null;
    });

  const listBuilds: ForgeCapabilityStoreShape["listBuilds"] = ({ environmentId, capabilityId }) =>
    io("listBuilds", async () => {
      const history = await readHistory(environmentId);
      const builds =
        capabilityId === undefined
          ? history.builds
          : history.builds.filter((build) => build.capabilityId === capabilityId);
      return builds.slice(-FORGE_MAX_LISTED_ITEMS).reverse();
    });

  // -- versions ---------------------------------------------------------------

  const stageVersion: ForgeCapabilityStoreShape["stageVersion"] = (
    environmentId,
    version,
    contents,
  ) =>
    io("stageVersion", async () => {
      if (version.artifacts.length !== FORGE_CAPABILITY_ARTIFACT_PATHS.length) {
        return {
          status: "refused" as const,
          reason: "invalid_version" as const,
          detail: `a version carries exactly the four artifacts, got ${version.artifacts.length}`,
        };
      }
      const path = versionPath(environmentId, version.capabilityId, version.version);
      const existing = await readStoredVersion(
        environmentId,
        version.capabilityId,
        version.version,
      );
      if (existing !== null) {
        if (existing.version.bundleSha256 === version.bundleSha256) {
          return {
            status: "staged" as const,
            capabilityId: version.capabilityId,
            version: version.version,
          };
        }
        return {
          status: "refused" as const,
          reason: "tampered" as const,
          detail: `version ${version.version} of ${version.capabilityId} already exists with a different bundle hash; versions are immutable`,
        };
      }
      await writeAtomic(
        path,
        JSON.stringify({ version, contents, storedAtMs: Date.now() } satisfies ForgeStoredVersion),
      );
      return {
        status: "staged" as const,
        capabilityId: version.capabilityId,
        version: version.version,
      };
    });

  // Raw reader for the promise callbacks below; the Effect wrapper serves the
  // outside world.
  const readStoredVersion = (
    environmentId: string,
    capabilityId: string,
    version: number,
  ): Promise<ForgeStoredVersion | null> =>
    fs
      .readFile(versionPath(environmentId, capabilityId, version), "utf8")
      .then((raw) => Schema.decodeUnknownSync(ForgeStoredVersion)(JSON.parse(raw) as unknown))
      .catch((error: unknown) => {
        if (isMissingFile(error)) return null;
        throw error;
      });

  const nextVersion: ForgeCapabilityStoreShape["nextVersion"] = ({ environmentId, capabilityId }) =>
    io("nextVersion", async () => {
      const directory = NodePath.dirname(versionPath(environmentId, capabilityId, 1));
      const names = await fs.readdir(directory).catch((error: unknown) => {
        if (isMissingFile(error)) return [] as string[];
        throw error;
      });
      let latest = 0;
      for (const name of names) {
        const match = /^v([1-9][0-9]*)\.json$/.exec(name);
        if (match === null) continue;
        const version = Number(match[1]);
        if (!Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER)
          throw new Error("version counter exhausted");
        latest = Math.max(latest, version);
      }
      return latest + 1;
    });

  const readVersion: ForgeCapabilityStoreShape["readVersion"] = ({
    environmentId,
    capabilityId,
    version,
  }) =>
    io("readVersion", async () => {
      const stored = await readStoredVersion(environmentId, capabilityId, version);
      return stored === null ? null : stored.version;
    });

  const readArtifact: ForgeCapabilityStoreShape["readArtifact"] = ({
    environmentId,
    capabilityId,
    version,
    path,
  }) =>
    io("readArtifact", async () => {
      const stored = await readStoredVersion(environmentId, capabilityId, version);
      if (stored === null) return null;
      // The bundle's own manifest.json decides the vocabulary: a
      // detector-program v2 manifest widens the allowed set to its declared
      // role paths (plus manifest.json itself); everything else — including a
      // bundle whose v2 manifest no longer decodes — keeps the exact v1
      // four-path allowlist, which refuses v2 paths. Fail closed.
      const detectorManifest = decodeDetectorManifest(stored.contents);
      if (detectorManifest === null) {
        if (!(FORGE_CAPABILITY_ARTIFACT_PATHS as readonly string[]).includes(path)) return null;
        return readVerifiedArtifact(stored, path, undefined);
      }
      const paths = detectorArtifactPaths(detectorManifest);
      if ("refusal" in paths) {
        throw new ForgeStoreError(`stored detector manifest is invalid: ${paths.refusal}`);
      }
      if (![...paths.paths, "manifest.json"].includes(path)) return null;
      return readVerifiedArtifact(stored, path, detectorManifest);
    });

  // -- installation -------------------------------------------------------------

  const replayActive = (
    installLog: ReadonlyArray<ForgeInstallEvent>,
    capabilityId: string,
  ): ForgeInstallEvent | null => {
    const events = installLog.filter((event) => event.capabilityId === capabilityId);
    let active: ForgeInstallEvent | null = null;
    for (const event of events) {
      if (event.kind === "install") active = event;
      else if (event.kind === "uninstall" && active !== null) active = null;
    }
    return active;
  };

  const paused = (installLog: ReadonlyArray<ForgeInstallEvent>, capabilityId: string): boolean => {
    const events = installLog.filter((event) => event.capabilityId === capabilityId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.kind === "pause") return true;
      if (event.kind === "resume" || event.kind === "install") return false;
    }
    return false;
  };

  /**
   * Whether the detector standing is armed, folded from the install log in
   * order. `arm`/`disarm` flip it; an `uninstall` resets it to false — an
   * uninstalled capability has no standing, so armed never survives as the
   * default of a later reinstall. Armed is false by default: installation
   * and arming are separate human acts.
   */
  const armed = (installLog: ReadonlyArray<ForgeInstallEvent>, capabilityId: string): boolean => {
    const events = installLog.filter((event) => event.capabilityId === capabilityId);
    let value = false;
    for (const event of events) {
      if (event.kind === "arm") value = true;
      else if (event.kind === "disarm" || event.kind === "uninstall") value = false;
    }
    return value;
  };

  const install: ForgeCapabilityStoreShape["install"] = ({
    environmentId,
    capabilityId,
    version,
    bundleSha256,
    expectedActiveVersion,
    buildId,
  }) =>
    io("install", async () => {
      const stored = await readStoredVersion(environmentId, capabilityId, version);
      if (stored === null) {
        return {
          status: "refused" as const,
          reason: "unknown_version" as const,
          detail: `version ${version} of ${capabilityId} was never staged ready`,
        };
      }
      if (stored.version.bundleSha256 !== bundleSha256) {
        return {
          status: "refused" as const,
          reason: "hash_mismatch" as const,
          detail:
            "the requested bundle hash is not the staged version's hash; only the exact tested bytes install",
        };
      }
      for (const artifact of stored.version.artifacts) {
        const content = stored.contents[artifact.path];
        if (
          content === undefined ||
          Buffer.byteLength(content, "utf8") !== artifact.bytes ||
          NodeCrypto.createHash("sha256").update(content).digest("hex") !== artifact.sha256
        ) {
          return {
            status: "refused" as const,
            reason: "hash_mismatch" as const,
            detail: "stored artifact bytes no longer match the checked hashes",
          };
        }
      }
      const history = await readHistory(environmentId);
      if (buildId !== undefined) {
        const build = history.builds.find((candidate) => candidate.buildId === buildId);
        if (
          build?.stage !== "ready" ||
          build.capabilityId !== capabilityId ||
          build.bundleSha256 !== bundleSha256
        ) {
          return {
            status: "refused" as const,
            reason: "unknown_version" as const,
            detail: "build is not ready for this exact bundle",
          };
        }
        const atMs = Date.now();
        history.builds[history.builds.indexOf(build)] = {
          ...build,
          stage: "installed",
          updatedAtMs: atMs,
          stages: [...build.stages, { stage: "installed", atMs }],
        };
      }
      const current = replayActive(history.installLog, capabilityId);
      if (current !== null && current.version === version) {
        return {
          status: "refused" as const,
          reason: "already_installed" as const,
          detail: `version ${version} of ${capabilityId} is already the active version`,
        };
      }
      if (expectedActiveVersion === null && current !== null) {
        return {
          status: "refused" as const,
          reason: "active_version_mismatch" as const,
          detail: `${capabilityId} is already active at v${current.version}; pass expectedActiveVersion to revise`,
        };
      }
      if (
        expectedActiveVersion !== null &&
        (current === null || current.version !== expectedActiveVersion)
      ) {
        return {
          status: "refused" as const,
          reason: "active_version_mismatch" as const,
          detail: `expected active v${expectedActiveVersion} but found ${current === null ? "none" : `v${current.version}`}; a stale candidate cannot overwrite a newer installation`,
        };
      }
      history.installLog.push({
        environmentId,
        capabilityId,
        version,
        bundleSha256,
        kind: "install",
        atMs: Date.now(),
      });
      await writeHistory(environmentId, history);
      return { status: "installed" as const, capabilityId, version };
    });

  const activeState: ForgeCapabilityStoreShape["activeState"] = ({ environmentId, capabilityId }) =>
    io("activeState", async () => {
      const history = await readHistory(environmentId);
      const current = replayActive(history.installLog, capabilityId);
      if (current === null) return null;
      return {
        version: current.version,
        bundleSha256: current.bundleSha256,
        status: (paused(history.installLog, capabilityId)
          ? "paused"
          : "installed") as ForgeCapabilityStatus,
        armed: armed(history.installLog, capabilityId),
      };
    });

  const lifecycleEvent =
    (kind: "pause" | "resume" | "uninstall"): ForgeCapabilityStoreShape["pause"] =>
    ({ environmentId, capabilityId }) =>
      io(kind, async () => {
        const history = await readHistory(environmentId);
        const current = replayActive(history.installLog, capabilityId);
        if (current === null) return false;
        if (kind === "uninstall") {
          history.installLog.push({
            environmentId,
            capabilityId,
            version: current.version,
            bundleSha256: current.bundleSha256,
            kind: "uninstall",
            atMs: Date.now(),
          });
        } else {
          if (paused(history.installLog, capabilityId) === (kind === "pause")) return true;
          history.installLog.push({
            environmentId,
            capabilityId,
            version: current.version,
            bundleSha256: current.bundleSha256,
            kind,
            atMs: Date.now(),
          });
        }
        await writeHistory(environmentId, history);
        return true;
      });

  const pause = lifecycleEvent("pause");
  const resume = lifecycleEvent("resume");
  const uninstall = lifecycleEvent("uninstall");

  /**
   * The arming gate, on the same append-only log pause/resume use. Refuses
   * (false) without an active installation; a paused capability CAN arm —
   * the two gates are independent and both must open for evaluation later.
   */
  const standingEvent =
    (kind: "arm" | "disarm"): ForgeCapabilityStoreShape["arm"] =>
    ({ environmentId, capabilityId }) =>
      io(kind, async () => {
        const history = await readHistory(environmentId);
        const current = replayActive(history.installLog, capabilityId);
        if (current === null) return false;
        if (armed(history.installLog, capabilityId) === (kind === "arm")) return true;
        history.installLog.push({
          environmentId,
          capabilityId,
          version: current.version,
          bundleSha256: current.bundleSha256,
          kind,
          atMs: Date.now(),
        });
        await writeHistory(environmentId, history);
        return true;
      });

  const arm = standingEvent("arm");
  const disarm = standingEvent("disarm");

  const listCatalog: ForgeCapabilityStoreShape["listCatalog"] = (environmentId) =>
    io("listCatalog", async () => {
      const history = await readHistory(environmentId);
      const byCapability = new Map<string, ForgeInstallEvent>();
      for (const event of history.installLog) {
        if (event.kind === "install") byCapability.set(event.capabilityId, event);
        else if (event.kind === "uninstall") byCapability.delete(event.capabilityId);
      }
      const entries: Array<ForgeCapabilityCatalogEntry> = [];
      for (const [capabilityId, event] of byCapability) {
        const stored = await readStoredVersion(environmentId, capabilityId, event.version);
        if (stored === null) continue;
        entries.push({
          capabilityId,
          version: event.version,
          bundleSha256: event.bundleSha256,
          description: stored.version.manifest.description,
          status: paused(history.installLog, capabilityId) ? "paused" : "installed",
          installedAtMs: event.atMs,
        });
      }
      return entries.sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
    });

  // -- evaluations ---------------------------------------------------------------

  const recordEvaluation: ForgeCapabilityStoreShape["recordEvaluation"] = (evaluation) =>
    io("recordEvaluation", async () => {
      const history = await readHistory(evaluation.environmentId);
      // Deterministic id dedup: the same sealed window replays as one record.
      if (history.evaluations.some((prior) => prior.evaluationId === evaluation.evaluationId))
        return;
      history.evaluations.push(evaluation);
      await writeHistory(evaluation.environmentId, history);
    });

  const listEvaluations: ForgeCapabilityStoreShape["listEvaluations"] = ({
    environmentId,
    capabilityId,
    limit,
  }) =>
    io("listEvaluations", async () => {
      const history = await readHistory(environmentId);
      const scoped = history.evaluations.filter(
        (evaluation) => evaluation.capabilityId === capabilityId,
      );
      return scoped.slice(-(limit ?? FORGE_MAX_LISTED_ITEMS)).reverse();
    });

  const latestEvaluation: ForgeCapabilityStoreShape["latestEvaluation"] = ({
    environmentId,
    capabilityId,
  }) =>
    io("latestEvaluation", async () => {
      const history = await readHistory(environmentId);
      const scoped = history.evaluations.filter(
        (evaluation) => evaluation.capabilityId === capabilityId,
      );
      return scoped[scoped.length - 1] ?? null;
    });

  // -- pool proposals ---------------------------------------------------------------

  const proposePool: ForgeCapabilityStoreShape["proposePool"] = ({
    environmentId,
    poolId,
    threadId,
    reason,
  }) =>
    io("proposePool", async () => {
      const history = await readHistory(environmentId);
      const proposalId = `fpool_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const proposal: ForgePoolProposal = {
        proposalId,
        environmentId,
        poolId,
        ...(threadId === undefined ? {} : { proposedByThreadId: threadId }),
        ...(reason === undefined ? {} : { reason }),
        status: "proposed",
        proposedAtMs: Date.now(),
      };
      history.proposals.push(proposal);
      await writeHistory(environmentId, history);
      return proposal;
    });

  const decidePool =
    (decision: "approved" | "rejected"): ForgeCapabilityStoreShape["approvePool"] =>
    ({ environmentId, proposalId }) =>
      io(decision, async () => {
        const history = await readHistory(environmentId);
        const index = history.proposals.findIndex(
          (proposal) =>
            proposal.proposalId === proposalId && proposal.environmentId === environmentId,
        );
        if (index < 0) return null;
        const prior = history.proposals[index]!;
        if (prior.status !== "proposed") return prior;
        const decided: ForgePoolProposal = {
          ...prior,
          status: decision,
          decidedAtMs: Date.now(),
        };
        history.proposals[index] = decided;
        await writeHistory(environmentId, history);
        return decided;
      });

  const approvePool = decidePool("approved");
  const rejectPool = decidePool("rejected");

  const findApprovedPoolRaw = async (
    environmentId: string,
    poolId: string,
  ): Promise<ForgePoolProposal | null> => {
    const history = await readHistory(environmentId);
    return (
      history.proposals.find(
        (proposal) =>
          proposal.environmentId === environmentId &&
          proposal.poolId === poolId &&
          proposal.status === "approved",
      ) ?? null
    );
  };

  const findApprovedPool: ForgeCapabilityStoreShape["findApprovedPool"] = ({
    environmentId,
    poolId,
  }) =>
    io("findApprovedPool", async () => {
      const history = await readHistory(environmentId);
      return (
        history.proposals.find(
          (proposal) =>
            proposal.environmentId === environmentId &&
            proposal.poolId === poolId &&
            proposal.status === "approved",
        ) ?? null
      );
    });

  const listProposals: ForgeCapabilityStoreShape["listProposals"] = (environmentId) =>
    io("listProposals", async () => {
      const history = await readHistory(environmentId);
      return history.proposals.slice(-FORGE_MAX_LISTED_ITEMS);
    });

  // -- policy bindings ------------------------------------------------------------

  const bindPolicy: ForgeCapabilityStoreShape["bindPolicy"] = (input) =>
    io("bindPolicy", async () => {
      const approved = await findApprovedPoolRaw(input.environmentId, input.poolId);
      if (approved === null) {
        throw new ForgeStoreError(
          `pool ${input.poolId} has no approved human proposal; a policy binding requires one`,
        );
      }
      const history = await readHistory(input.environmentId);
      const policyId = `fpol_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const binding: ForgePolicyBinding = {
        policyId,
        environmentId: input.environmentId,
        capabilityId: input.capabilityId,
        capabilityVersion: input.capabilityVersion,
        bundleSha256: input.bundleSha256,
        poolId: input.poolId,
        detectionFeeHundredthsBps: input.detectionFeeHundredthsBps,
        status: "draft",
        ...(input.sourceEvaluationId === undefined
          ? {}
          : { sourceEvaluationId: input.sourceEvaluationId }),
        createdAtMs: Date.now(),
      };
      history.policies.push(binding);
      await writeHistory(input.environmentId, history);
      return binding;
    });

  const revokePolicy: ForgeCapabilityStoreShape["revokePolicy"] = ({ environmentId, policyId }) =>
    io("revokePolicy", async () => {
      const history = await readHistory(environmentId);
      const index = history.policies.findIndex(
        (policy) => policy.policyId === policyId && policy.environmentId === environmentId,
      );
      if (index < 0) return null;
      const prior = history.policies[index]!;
      if (prior.status === "revoked") return prior;
      const revoked: ForgePolicyBinding = { ...prior, status: "revoked", revokedAtMs: Date.now() };
      history.policies[index] = revoked;
      await writeHistory(environmentId, history);
      return revoked;
    });

  const listPolicies: ForgeCapabilityStoreShape["listPolicies"] = (environmentId) =>
    io("listPolicies", async () => {
      const history = await readHistory(environmentId);
      return history.policies.slice(-FORGE_MAX_LISTED_ITEMS);
    });

  return {
    startBuild,
    appendBuildStage,
    getBuild,
    listBuilds,
    nextVersion,
    stageVersion,
    readVersion,
    readArtifact,
    install,
    activeState,
    pause,
    resume,
    uninstall,
    arm,
    disarm,
    listCatalog,
    recordEvaluation,
    latestEvaluation,
    listEvaluations,
    proposePool,
    approvePool,
    rejectPool,
    findApprovedPool,
    listProposals,
    bindPolicy,
    revokePolicy,
    listPolicies,
  } satisfies ForgeCapabilityStoreShape;
});

export const ForgeCapabilityStoreLive = Layer.effect(
  ForgeCapabilityStore,
  makeForgeCapabilityStore,
);
