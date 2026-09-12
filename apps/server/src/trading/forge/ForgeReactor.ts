/**
 * ForgeReactor — the first evaluation as a persisted reactor job.
 *
 * An installed capability produces nothing by existing: its readings come
 * from evaluation jobs this reactor runs and receipts. A job is enqueued
 * persisted (`queued`), drained through one worker, and only its COMMIT — the
 * durable evaluation record in the store — makes the reading visible to
 * `trading_look`. Provider job status and observed-data status are separate
 * records: a failed job says so in the job; the data half says what the last
 * committed evaluation saw.
 *
 * The window comes from an injected provider port (the production adapter
 * reads the real Graph source; tests fix the window). The capability runs in
 * the sealed sandbox. There is NO on-chain action and NO signing anywhere in
 * this module.
 *
 * @module ForgeReactor
 */
// @effect-diagnostics nodeBuiltinImport:off - the jobs file is fs/path; the sequential queue is promise-chained by design.
// @effect-diagnostics globalDate:off globalDateInEffect:off - job/evaluation receipts are wall-clock instants persisted as data.
// @effect-diagnostics preferSchemaOverJson:off - the jobs file is round-tripped through a schema on read; JSON is the storage codec.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodePath from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  CapabilityManifestV2,
  DetectorEvaluationRecordV2,
  FORGE_CAPABILITY_ARTIFACT_PATHS,
  ForgeJobKind,
  ForgeJobStatus,
  ForgeSignalOutput,
  DetectorProgramInputV2,
  DetectorProgramOutputV2,
  DetectorStateEnvelope,
  detectorArtifactPaths,
  decodeDetectorState,
  detectorEvaluationId,
  encodeDetectorState,
  type ForgeEvaluationEvidence,
  type ForgePoolWindow,
  type ForgeSignalInput,
  type ForgeSourceEvidence,
  type ForgeSwapObservation,
} from "@t3tools/trading-contracts";
import { UnixMillis } from "@t3tools/trading-contracts/primitives";
import type { PersistenceSqlError } from "../../persistence/Errors.ts";

import {
  ForgeCapabilitySandbox,
  ForgeCapabilitySandboxLive,
  type ForgeCapabilitySandboxShape,
  type ForgeSandboxFile,
} from "./CapabilitySandbox.ts";
import {
  ForgeCapabilityStore,
  ForgeCapabilityStoreConfig,
  ForgeCapabilityStoreLive,
  versionProgramKind,
  type ForgeCapabilityStoreShape,
  type ForgeStoreError,
  safeJoinStorePath,
} from "./CapabilityStore.ts";
import {
  FORGE_RUNNER_EVALUATE,
  FORGE_RUNNER_EVALUATE_V2,
  FORGE_SDK_SOURCE,
  validateDiagnosticsAgainstInput,
} from "./CapabilityBuilder.ts";
import { validateForgeCapabilityQuery } from "./CapabilityQuery.ts";
import { DetectorFactWindow } from "./DetectorFactWindow.ts";
import { DetectorRunStore } from "./DetectorRunStore.ts";
import { forgeJsonEncode } from "./ForgeJsonEncode.ts";

// ---------------------------------------------------------------------------
// Host aggregation: observations in, exact pool windows out
// ---------------------------------------------------------------------------

/** `moveBps` between the window's last price and its anchor, exact integer bps. */
export function forgeMoveBps(input: {
  readonly anchorPriceMicros: number;
  readonly lastPriceMicros: number;
}): number {
  if (input.anchorPriceMicros <= 0) return 0;
  // (last - anchor) / anchor, in basis points, integer-truncated.
  return Math.trunc(
    ((input.lastPriceMicros - input.anchorPriceMicros) * 10_000) / input.anchorPriceMicros,
  );
}

/**
 * Aggregate one pool's normalized observations into a `ForgePoolWindow`.
 *
 * Host-owned math, exact at integer scale: the stable-quote volume is the
 * sum of absolute USDC legs in micro-units (BigInt, no float), the move is
 * basis points from the anchor price to the window's last price, and the
 * trade ids carry the provenance diagnostics must reference. Classification
 * is never here — that is the capability's own logic.
 */
export function forgeAggregatePoolWindow(input: {
  readonly poolId: string;
  readonly observations: ReadonlyArray<ForgeSwapObservation>;
  readonly anchorCandidates?: ReadonlyArray<ForgeSwapObservation>;
  readonly anchor?:
    | {
        readonly observationId: string;
        readonly priceQuotePerBaseMicros: number;
        readonly ageBeforeWindowSeconds: number;
      }
    | undefined;
}): ForgePoolWindow {
  const ordered = [...input.observations].sort(
    (a, b) => a.timestamp - b.timestamp || a.logIndex - b.logIndex,
  );
  let volumeMicros = 0n;
  for (const observation of ordered) {
    volumeMicros += BigInt(observation.quoteVolumeMicros);
  }
  const last = ordered[ordered.length - 1];
  const anchorPrice = input.anchor?.priceQuotePerBaseMicros ?? 0;
  const moveBps =
    last === undefined || anchorPrice <= 0
      ? null
      : forgeMoveBps({
          anchorPriceMicros: anchorPrice,
          lastPriceMicros: last.priceQuotePerBaseMicros,
        });
  return {
    poolId: input.poolId,
    moveBps,
    quoteVolumeMicros: volumeMicros.toString(10),
    tradeCount: ordered.length,
    observations: ordered,
    anchorCandidates: [...(input.anchorCandidates ?? [])],
    observationIds: ordered.map((observation) => observation.observationId),
    ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
  };
}

// ---------------------------------------------------------------------------
// The window provider port
// ---------------------------------------------------------------------------

/** One sealed window, ready to feed a capability. */
export interface ForgeEvaluationWindow {
  readonly evidence: ForgeSourceEvidence;
  readonly pools: ReadonlyArray<ForgePoolWindow>;
  /** Evidence rows the window came from, read back by id. */
  readonly evidenceIds: ReadonlyArray<string>;
  readonly window: { readonly startedAtMs: number; readonly endedAtMs: number };
  readonly historical: boolean;
  readonly pinnedBlock?: number | undefined;
  readonly sourceDigest?: string | undefined;
}

export type ForgeWindowFailure = { readonly reason: string };

export interface ForgeSourceWindowProviderShape {
  /**
   * The current sealed window across the approved pools, or a named refusal.
   * `query` carries the installed bundle's validated `query.graphql` bytes;
   * the provider executes them in place of the host constant and hashes the
   * executed bytes into the window's evidence.
   */
  readonly currentWindow: (input: {
    readonly environmentId: string;
    readonly query?: string;
  }) => Effect.Effect<ForgeEvaluationWindow, ForgeWindowFailure>;
}

export class ForgeSourceWindowProvider extends Context.Service<
  ForgeSourceWindowProvider,
  ForgeSourceWindowProviderShape
>()("t3/trading/forge/ForgeReactor/ForgeSourceWindowProvider") {}

/** The unconfigured default: a named refusal, never a fabricated window. */
export const ForgeSourceWindowProviderUnavailableLive = Layer.succeed(ForgeSourceWindowProvider, {
  currentWindow: () =>
    Effect.fail({ reason: "no Forge source window provider is configured for the reactor" }),
} satisfies ForgeSourceWindowProviderShape);

// ---------------------------------------------------------------------------
// Jobs persistence (file, restart-surviving)
// ---------------------------------------------------------------------------

/**
 * The persisted job record: the wire `ForgeJob` fields plus the capability
 * the job evaluates — the one field the wire shape does not carry, persisted
 * beside it so a restart still knows what each job was for.
 *
 * `programKind` is OPTIONAL on purpose (trap 8): an absent field is a v1
 * job, so every existing forge-jobs.json file keeps decoding after this
 * field exists. Only v2 enqueues ever write it.
 */
export const ForgeReactorJobRecord = Schema.Struct({
  jobId: Schema.String.check(Schema.isNonEmpty()),
  kind: ForgeJobKind,
  status: ForgeJobStatus,
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  threadId: Schema.optional(Schema.String),
  createdAtMs: UnixMillis,
  startedAtMs: Schema.optional(UnixMillis),
  completedAtMs: Schema.optional(UnixMillis),
  detail: Schema.optional(Schema.String),
  capabilityId: Schema.String.check(Schema.isNonEmpty()),
  programKind: Schema.optional(Schema.Literals([1, 2])),
});
export type ForgeReactorJobRecord = typeof ForgeReactorJobRecord.Type;

const JobsFile = Schema.Struct({
  jobs: Schema.Array(ForgeReactorJobRecord),
});

/** The one decoder a contained evaluation runs: the SDK's output contract. */
const decodeForgeSignalOutput = (value: unknown): unknown =>
  Schema.decodeUnknownSync(ForgeSignalOutput)(value);

/** The detector-program (v2) output decoder — module-level, outside generators. */
const decodeDetectorProgramOutput = (value: unknown): unknown =>
  Schema.decodeUnknownSync(DetectorProgramOutputV2)(value);

/**
 * The bundle's authoritative v2 manifest, decoded from the stored
 * `manifest.json` bytes, or null when they are not a v2 manifest. Same
 * discriminator as `versionProgramKind`: the `manifestVersion === 2` literal.
 */
const decodeDetectorManifestV2 = (raw: string): CapabilityManifestV2 | null => {
  try {
    return Schema.decodeUnknownSync(CapabilityManifestV2)(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

const jobsPath = (stateRoot: string, environmentId: string): string =>
  safeJoinStorePath(stateRoot, [environmentId, "forge-jobs.json"]);

// ---------------------------------------------------------------------------
// The sequential job queue
// ---------------------------------------------------------------------------

/**
 * A promise-chained sequential queue with a deterministic `drain`: each job
 * runs only after the previous one's receipts are durable. Deliberately not
 * the TxQueue-based worker: this service lives inside a Layer, and draining
 * by awaiting the chain tail keeps the guarantees (sequential, receipt-first,
 * no work skipped) without any scope machinery.
 */
export interface ForgeSequentialQueue {
  readonly enqueue: (job: ForgeReactorJobRecord) => void;
  readonly drain: () => Promise<void>;
}

const makeSequentialJobQueue = (
  process: (job: ForgeReactorJobRecord) => Effect.Effect<void>,
): ForgeSequentialQueue => {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue: (job) => {
      tail = tail.then(() => Effect.runPromise(Effect.exit(process(job))).then(() => undefined));
    },
    drain: () => tail,
  };
};

// ---------------------------------------------------------------------------
// The reactor
// ---------------------------------------------------------------------------

export interface ForgeReactorShape {
  /**
   * Enqueue the first (or next) evaluation of a capability. Persisted
   * immediately. `programKind: 2` enqueues a detector-program (v2) job;
   * absent means the v1 pool-window path. Install-time auto-enqueue stays
   * v1-only — arming a v2 detector is the user's step, and un-armed never
   * evaluates, so installation alone must never queue a v2 job.
   */
  readonly enqueueEvaluation: (input: {
    readonly environmentId: string;
    readonly threadId?: string | undefined;
    readonly capabilityId: string;
    readonly programKind?: 2 | undefined;
  }) => Effect.Effect<ForgeReactorJobRecord, never>;
  /** Wait for every queued job to finish (receipts are durable by then). */
  readonly drain: () => Effect.Effect<void>;
  /** Cancel a queued job. Running jobs finish; their receipts stand. */
  readonly cancel: (input: { readonly jobId: string }) => Effect.Effect<boolean>;
  /** Provider job records — deliberately separate from observed-data status. */
  readonly listJobs: (input: {
    readonly environmentId: string;
  }) => Effect.Effect<ReadonlyArray<ForgeReactorJobRecord>>;
  /** The last committed evaluation for a capability (the data half). */
  readonly observedStatus: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
  }) => Effect.Effect<ForgeEvaluationEvidence | null, ForgeStoreError>;
}

export class ForgeReactor extends Context.Service<ForgeReactor, ForgeReactorShape>()(
  "t3/trading/forge/ForgeReactor",
) {}

export const makeForgeReactor = Effect.gen(function* () {
  const store: ForgeCapabilityStoreShape = yield* ForgeCapabilityStore;
  const sandbox: ForgeCapabilitySandboxShape = yield* ForgeCapabilitySandbox;
  const windows = yield* ForgeSourceWindowProvider;
  const { stateRoot } = yield* ForgeCapabilityStoreConfig;
  const fs = yield* Effect.promise(() => import("node:fs/promises"));
  // The v2 job path's services, ambiently optional (the ForgeAcceptance
  // pattern): a wiring without them keeps every v1 job working, and a v2 job
  // fails named instead of silently skipping. One wiring provides the real
  // instances (see runtimeLayer), so no second store can fork the payload.
  const detectorRuns = yield* Effect.serviceOption(DetectorRunStore);
  const factWindows = yield* Effect.serviceOption(DetectorFactWindow);

  // One writer at a time per environment: enqueue and the running job's own
  // patches are both read-modify-write over the same file, and an interleaved
  // pair loses a row. A promise chain serializes them within this process,
  // which is the only writer a state root has.
  const jobsLocks = new Map<string, Promise<unknown>>();
  const withJobsLock = <A>(environmentId: string, work: () => Promise<A>): Promise<A> => {
    const prior = jobsLocks.get(environmentId) ?? Promise.resolve();
    const next = prior.then(work, work);
    jobsLocks.set(environmentId, next);
    return next;
  };

  const readJobs = async (environmentId: string): Promise<Array<ForgeReactorJobRecord>> => {
    try {
      const raw = await fs.readFile(jobsPath(stateRoot, environmentId), "utf8");
      const parsed = Schema.decodeUnknownSync(JobsFile)(JSON.parse(raw) as unknown);
      return [...parsed.jobs];
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
  };

  const writeJobs = async (
    environmentId: string,
    jobs: ReadonlyArray<ForgeReactorJobRecord>,
  ): Promise<void> => {
    const path = jobsPath(stateRoot, environmentId);
    await fs.mkdir(NodePath.dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ jobs }), "utf8");
    await fs.rename(temp, path);
  };

  /**
   * Patch one job. `from` makes the transition conditional — the guard races
   * (cancelled-vs-running, queued-vs-cancelled) resolve to "no transition",
   * never to an overwrite.
   */
  const patchJob = (
    environmentId: string,
    jobId: string,
    patch: Partial<ForgeReactorJobRecord>,
    options?: { readonly from?: ForgeReactorJobRecord["status"] },
  ): Promise<ForgeReactorJobRecord | null> =>
    withJobsLock(environmentId, async () => {
      const jobs = await readJobs(environmentId);
      const index = jobs.findIndex((job) => job.jobId === jobId);
      if (index < 0) return null;
      const prior = jobs[index]!;
      if (options?.from !== undefined && prior.status !== options.from) return prior;
      const updated = { ...prior, ...patch };
      jobs[index] = updated;
      await writeJobs(environmentId, jobs);
      return updated;
    });

  const evaluationIdFor = (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
    readonly version: number;
    readonly pinnedBlock?: number | undefined;
    readonly digest?: string | undefined;
  }): string => `feval_${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;

  // -- the detector-program (v2) job: armed gate → sealed input → contained
  //    run → validated output → atomic DetectorRunStore commit --------------

  /**
   * One v2 evaluation job. Reachable ONLY for a job whose record carries
   * `programKind: 2` AND whose installed bundle's manifest decodes as v2;
   * the armed gate has already held in `runJob` before this runs.
   *
   * Ordering discipline: the committed state is read BEFORE the window is
   * built and the program runs, and the commit's revision CAS is the only
   * write. Every refusal fails the job with a named reason — a v2 job never
   * silently skips.
   */
  const runDetectorProgramJob = (
    job: ForgeReactorJobRecord,
    active: { readonly version: number; readonly bundleSha256: string; readonly armed: boolean },
    failJob: (reason: string) => Effect.Effect<void>,
  ): Effect.Effect<void, ForgeStoreError | PersistenceSqlError> =>
    Effect.gen(function* () {
      if (Option.isNone(detectorRuns) || Option.isNone(factWindows)) {
        yield* failJob(
          "the detector v2 services (DetectorRunStore, DetectorFactWindow) are not wired; refusing to evaluate",
        );
        return;
      }
      const runStore = detectorRuns.value;
      const factWindow = factWindows.value;

      // The bundle's own manifest decides the read vocabulary and names the
      // required sources. Read it through the hash-verifying artifact path.
      const manifestJson = yield* store.readArtifact({
        environmentId: job.environmentId,
        capabilityId: job.capabilityId,
        version: active.version,
        path: "manifest.json",
      });
      if (manifestJson === null) {
        yield* failJob(`artifact manifest.json of v${active.version} is missing from the store`);
        return;
      }
      if (versionProgramKind(manifestJson) !== "v2") {
        yield* failJob(
          `the installed v${active.version} bundle of ${job.capabilityId} is not a detector-program v2 bundle`,
        );
        return;
      }
      const manifest = decodeDetectorManifestV2(manifestJson);
      if (manifest === null) {
        yield* failJob(`the installed v2 manifest of ${job.capabilityId} does not decode`);
        return;
      }
      const paths = detectorArtifactPaths(manifest);
      if ("refusal" in paths) {
        yield* failJob(`the installed v2 manifest is invalid: ${paths.refusal}`);
        return;
      }

      // The sandbox receives the bundle files exactly as the builder staged
      // them: every declared role path plus manifest.json, all hash-verified
      // reads over the widened v2 allowlist (sdk.ts included — the staged
      // bytes ARE the host SDK).
      const files: Array<ForgeSandboxFile> = [];
      for (const path of [...paths.paths, "manifest.json"]) {
        const content = yield* store.readArtifact({
          environmentId: job.environmentId,
          capabilityId: job.capabilityId,
          version: active.version,
          path,
        });
        if (content === null) {
          yield* failJob(`artifact ${path} of v${active.version} is missing from the store`);
          return;
        }
        files.push({ path, content });
      }

      // Prior state: the last committed envelope, or nothing on the first
      // run. A state row that no longer decodes is an operational failure —
      // named, never guessed past.
      const snapshot = yield* runStore.readState(job.environmentId, job.capabilityId);
      let priorState: unknown = undefined;
      if (snapshot !== null) {
        const decoded = decodeDetectorState(snapshot.stateBytes);
        if (!decoded.ok) {
          yield* failJob(
            `the committed detector state of ${job.capabilityId} does not decode (${decoded.failure})`,
          );
          return;
        }
        priorState = decoded.envelope;
      }
      const stateRevision = snapshot === null ? 0 : snapshot.stateRevision + 1;

      // The sealed input. asOfMs is the ONLY clock the program ever sees.
      const asOfMs = yield* Clock.currentTimeMillis;
      const window = yield* factWindow.buildWindow({
        environmentId: job.environmentId,
        requiredSourceIds: manifest.requiredSourceIds,
        asOfMs,
      });
      if (window.status === "unavailable") {
        yield* failJob(`the sealed fact window is unavailable: ${window.reason}`);
        return;
      }
      // The digest covers everything the program sees except itself: the
      // clock, the sealed facts and sources, and the prior state. Same
      // retained bytes at the same clock and revision reproduce it; any
      // change moves the evaluation identity.
      const inputDigest = createHash("sha256")
        .update(
          forgeJsonEncode({
            asOfMs,
            facts: window.facts,
            sources: window.sources,
            priorState,
          }),
        )
        .digest("hex");
      const programInput = {
        programSchemaVersion: 2 as const,
        asOfMs,
        inputDigest,
        facts: [...window.facts],
        sources: [...window.sources],
        ...(priorState === undefined ? {} : { priorState }),
      };
      // The frozen input schema is the boundary contract: an input that
      // fails it never crosses into containment.
      if (!Schema.is(DetectorProgramInputV2)(programInput)) {
        yield* failJob("the sealed detector input failed its own contract");
        return;
      }

      const run = yield* sandbox
        .runEvaluation({
          files,
          entrypoint: [...FORGE_RUNNER_EVALUATE_V2],
          stdinJson: forgeJsonEncode(programInput),
          decodeResult: decodeDetectorProgramOutput,
        })
        .pipe(Effect.exit);
      if (run._tag === "Failure") {
        const squashed = yield* Effect.sync(() => run.cause);
        yield* failJob(
          `the contained detector evaluation failed: ${String(squashed).slice(0, 300)}`,
        );
        return;
      }
      const output = run.value as DetectorProgramOutputV2;

      // The next state must be a valid envelope under the byte cap; the
      // record carries the envelope, the store the canonical bytes.
      if (!Schema.is(DetectorStateEnvelope)(output.nextState)) {
        yield* failJob("the detector's next state is not a state envelope");
        return;
      }
      const encoded = encodeDetectorState(output.nextState);
      if (!encoded.ok) {
        yield* failJob(
          `the detector's next state failed the envelope contract (${encoded.failure})`,
        );
        return;
      }

      const evaluationId = detectorEvaluationId({
        environmentId: job.environmentId,
        capabilityId: job.capabilityId,
        version: active.version,
        stateRevision,
        inputDigest,
      });
      const record: DetectorEvaluationRecordV2 = {
        manifestVersion: 2,
        evaluationId,
        environmentId: job.environmentId,
        capabilityId: job.capabilityId,
        version: active.version,
        stateRevision,
        inputDigest,
        asOfMs,
        result: output.result,
        state: output.nextState,
        evidenceIds: window.sources.map((source) => source.evidenceId),
        committedAtMs: Date.now(),
      };
      // The schema re-check pins the id to the identity fields one more time
      // before the commit; a mis-stated record can never be persisted.
      if (!Schema.is(DetectorEvaluationRecordV2)(record)) {
        yield* failJob("the assembled detector evaluation record failed its contract");
        return;
      }

      // COMMIT — DetectorRunStore.commitRun is the one atomic write: the
      // evaluation row and the state advance land together or not at all.
      // The committed record's evidenceIds + inputDigest ARE the durable
      // source watermark (plan 03:66): which retained bytes this detector
      // ran over at which revision is recoverable from the record alone,
      // with no second watermark to keep in sync.
      const commit = yield* runStore.commitRun({
        record,
        stateBytes: encoded.serialized,
      });
      if (commit.status === "refused") {
        // A revision conflict is recoverable by a later enqueue (the winner
        // advanced the state; the next job re-reads it); a collision is a
        // hard integrity failure. Both fail the job named.
        yield* failJob(`the detector commit was refused: ${commit.reason} (${commit.detail})`);
        return;
      }
      const detail =
        commit.status === "replayed"
          ? `evaluation ${evaluationId} already committed; replayed`
          : `evaluation ${evaluationId} committed at state revision ${stateRevision}`;
      yield* Effect.promise(() =>
        patchJob(job.environmentId, job.jobId, {
          status: "complete",
          completedAtMs: Date.now(),
          detail,
        }),
      );
    });

  // -- one job's work: bundle bytes → window → contained run → validation → commit
  const runJob = (job: ForgeReactorJobRecord): Effect.Effect<void> =>
    Effect.gen(function* () {
      // A cancelled job stays cancelled: the transition to `running` refuses
      // to overwrite it, and the worker simply drops the work.
      const current = yield* Effect.promise(() => readJobs(job.environmentId));

      const asQueued = current.find((candidate) => candidate.jobId === job.jobId);
      if (asQueued === undefined || asQueued.status === "cancelled") return;

      const started = yield* Effect.promise(() =>
        patchJob(
          job.environmentId,
          job.jobId,
          { status: "running", startedAtMs: Date.now() },
          { from: "queued" },
        ),
      );
      if (started === null || started.status !== "running") return;

      const active = yield* store.activeState({
        environmentId: job.environmentId,
        capabilityId: job.capabilityId,
      });
      if (active === null || active.status === "uninstalled") {
        yield* Effect.promise(() =>
          patchJob(job.environmentId, job.jobId, {
            status: "failed",
            completedAtMs: Date.now(),
            detail: `${job.capabilityId} is not installed; nothing to evaluate`,
          }),
        );
        return;
      }
      if (active.status === "paused") {
        yield* Effect.promise(() =>
          patchJob(job.environmentId, job.jobId, {
            status: "failed",
            completedAtMs: Date.now(),
            detail: `${job.capabilityId} is paused; evaluations refuse until resumed`,
          }),
        );
        return;
      }

      const failJob = (reason: string) =>
        Effect.promise(() =>
          patchJob(job.environmentId, job.jobId, {
            status: "failed",
            completedAtMs: Date.now(),
            detail: reason,
          }),
        );

      // The detector-program (v2) dispatch: an armed, installed v2 capability
      // rides its own job path below and returns before any v1 code runs.
      // The v1 branch below stays byte-identical to what it always was.
      if (job.programKind === 2) {
        // The reactor-level guarantee behind "un-armed capabilities never
        // evaluate": installation is not arming, and this gate holds before
        // any read, run, or write of the v2 path.
        if (!active.armed) {
          yield* failJob(
            `${job.capabilityId} is not armed; un-armed detector capabilities never evaluate`,
          );
          return;
        }
        yield* runDetectorProgramJob(job, active, failJob);
        return;
      }

      // The installed bundle's own bytes decide what this evaluation runs and
      // which query the window executes. Read them BEFORE fetching the
      // window: an invalid bundle query fails the job here — honestly,
      // without touching the source — and the host query is never a fallback.
      const contents: Record<string, string> = {};
      const files: Array<ForgeSandboxFile> = [{ path: "sdk.ts", content: FORGE_SDK_SOURCE }];
      for (const path of FORGE_CAPABILITY_ARTIFACT_PATHS) {
        const content = yield* store.readArtifact({
          environmentId: job.environmentId,
          capabilityId: job.capabilityId,
          version: active.version,
          path,
        });
        if (content === null) {
          yield* failJob(`artifact ${path} of v${active.version} is missing from the store`);
          return;
        }
        contents[path] = content;
        files.push({ path, content });
      }
      const bundleQuery = contents["query.graphql"] ?? "";
      const queryCheck = validateForgeCapabilityQuery(bundleQuery);
      if (!queryCheck.ok) {
        yield* failJob(
          `installed query.graphql failed validation (${queryCheck.reason}); refusing to fall back to the host query`,
        );
        return;
      }

      const window = yield* windows
        .currentWindow({
          environmentId: job.environmentId,
          // The bundle's validated query bytes: the window executes these and
          // hashes them into its evidence, so the executed query and its hash
          // always come from the installed bundle.
          query: bundleQuery,
        })
        .pipe(Effect.mapError((failure) => failure.reason));
      const evaluationId = evaluationIdFor({
        environmentId: job.environmentId,
        capabilityId: job.capabilityId,
        version: active.version,
        pinnedBlock: window.pinnedBlock,
        digest: window.sourceDigest ?? window.evidence.responseSha256,
      });
      const createdAt = Date.now();
      const prior = yield* store.latestEvaluation({
        environmentId: job.environmentId,
        capabilityId: job.capabilityId,
      });
      if (prior?.evaluationId === evaluationId) {
        yield* Effect.promise(() =>
          patchJob(job.environmentId, job.jobId, {
            status: "complete",
            completedAtMs: Date.now(),
            detail: `evaluation ${evaluationId} already committed; replayed`,
          }),
        );
        return;
      }
      // The window itself may be servable-but-labeled (stale); that is a
      // failed evaluation with a named reason, never a fabricated reading.
      if (!window.evidence.complete) {
        yield* failJob("the source window is incomplete; refusing to evaluate");
        return;
      }

      const signalInput: ForgeSignalInput = {
        evidence: window.evidence,
        pools: [...window.pools],
      };
      const run = yield* sandbox
        .runEvaluation({
          files,
          entrypoint: [...FORGE_RUNNER_EVALUATE],
          stdinJson: JSON.stringify(signalInput),
          decodeResult: decodeForgeSignalOutput,
        })
        .pipe(Effect.exit);
      if (run._tag === "Failure") {
        const squashed = yield* Effect.sync(() => run.cause);
        const reason = String(squashed).slice(0, 300);
        yield* failJob(`the contained evaluation failed: ${reason}`);
        return;
      }
      const output = run.value as ForgeSignalOutput;
      const referenceError = validateDiagnosticsAgainstInput(
        { reading: output.reading, diagnostics: output.diagnostics },
        signalInput,
      );
      if (referenceError !== null) {
        yield* failJob(
          `the capability's diagnostics referenced input it never had: ${referenceError}`,
        );
        return;
      }

      // COMMIT — the durable record that makes the reading visible.
      const evidence: ForgeEvaluationEvidence = {
        evaluationId,
        environmentId: job.environmentId,
        ...(job.threadId === undefined ? {} : { threadId: job.threadId }),
        capabilityId: job.capabilityId,
        capabilityVersion: active.version,
        bundleSha256: active.bundleSha256,
        window: {
          startedAt: window.window.startedAtMs,
          endedAt: window.window.endedAtMs,
        },
        historical: window.historical,
        ...(window.pinnedBlock === undefined ? {} : { pinnedBlock: window.pinnedBlock }),
        ...(window.sourceDigest === undefined ? {} : { sourceDigest: window.sourceDigest }),
        evidenceIds: [...window.evidenceIds],
        status: "complete",
        reading: output.reading,
        diagnostics: [...output.diagnostics],
        createdAtMs: createdAt,
        completedAtMs: Date.now(),
      };
      yield* store.recordEvaluation(evidence);
      yield* Effect.promise(() =>
        patchJob(job.environmentId, job.jobId, {
          status: "complete",
          completedAtMs: Date.now(),
          detail: `evaluation ${evaluationId} committed`,
        }),
      );
    }).pipe(
      Effect.catch((reason) =>
        Effect.promise(() =>
          patchJob(job.environmentId, job.jobId, {
            status: "failed",
            completedAtMs: Date.now(),
            detail: `the evaluation job failed: ${String(reason).slice(0, 300)}`,
          }),
        ),
      ),
      Effect.catchDefect((defect) =>
        Effect.promise(() =>
          patchJob(job.environmentId, job.jobId, {
            status: "failed",
            completedAtMs: Date.now(),
            detail: `the evaluation job died: ${String(defect).slice(0, 300)}`,
          }),
        ),
      ),
    );

  const worker = makeSequentialJobQueue(runJob);
  const environments = yield* Effect.promise(() =>
    fs.readdir(stateRoot).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return [] as string[];
      throw error;
    }),
  );
  for (const environmentId of environments.filter((entry) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry),
  )) {
    const jobs = yield* Effect.promise(() => readJobs(environmentId));
    for (const job of jobs) {
      if (job.status !== "queued" && job.status !== "running") continue;
      const recovered = yield* Effect.promise(() =>
        patchJob(environmentId, job.jobId, {
          status: "queued",
          detail: "recovered after server restart",
        }),
      );
      if (recovered !== null) worker.enqueue(recovered);
    }
  }

  const enqueueEvaluation: ForgeReactorShape["enqueueEvaluation"] = ({
    environmentId,
    threadId,
    capabilityId,
    programKind,
  }) =>
    Effect.gen(function* () {
      const job: ForgeReactorJobRecord = {
        jobId: `fjob_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        kind: "evaluation",
        status: "queued",
        environmentId,
        ...(threadId === undefined ? {} : { threadId }),
        createdAtMs: Date.now(),
        capabilityId,
        // Absent for v1 (the field decodes as undefined for every old record);
        // only a v2 enqueue ever writes 2.
        ...(programKind === undefined ? {} : { programKind }),
      };
      yield* Effect.promise(() =>
        withJobsLock(environmentId, async () => {
          const jobs = await readJobs(environmentId);
          await writeJobs(environmentId, [...jobs, job]);
        }),
      );
      // Onto the queue; callers await `drain` for the receipt. The queue
      // starts the job immediately — cancellation races are resolved by the
      // conditional job-record transitions, not by queue position.
      worker.enqueue(job);
      return job;
    });

  const drain: ForgeReactorShape["drain"] = () => Effect.promise(() => worker.drain());

  const cancel: ForgeReactorShape["cancel"] = ({ jobId }) =>
    Effect.promise(async () => {
      for (const environmentId of await fs
        .readdir(stateRoot)
        .then((entries) =>
          entries.filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry)),
        )
        .catch(() => [] as Array<string>)) {
        const jobs = await readJobs(environmentId);
        const job = jobs.find((candidate) => candidate.jobId === jobId);
        if (job === undefined) continue;
        if (job.status === "queued") {
          const patched = await patchJob(
            environmentId,
            jobId,
            {
              status: "cancelled",
              completedAtMs: Date.now(),
              detail: "cancelled before it ran",
            },
            { from: "queued" },
          );
          return patched?.status === "cancelled";
        }
        return job.status === "cancelled";
      }
      return false;
    });

  const listJobs: ForgeReactorShape["listJobs"] = ({ environmentId }) =>
    Effect.promise(() => readJobs(environmentId)).pipe(
      Effect.map((jobs) => jobs.slice(-50).reverse()),
    );

  const observedStatus: ForgeReactorShape["observedStatus"] = ({ environmentId, capabilityId }) =>
    store.latestEvaluation({ environmentId, capabilityId });

  return {
    enqueueEvaluation,
    drain,
    cancel,
    listJobs,
    observedStatus,
  } satisfies ForgeReactorShape;
});

/**
 * The reactor, requiring its dependencies explicitly — including the window
 * provider, so the wiring point (or a test) decides where windows come from.
 * Pair with {@link ForgeSourceWindowProviderUnavailableLive} when no real
 * source adapter is wired yet; the port then refuses by name, fail-closed.
 */
export const ForgeReactorLive = Layer.effect(ForgeReactor, makeForgeReactor);
