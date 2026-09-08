import {
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
} from "@t3tools/shared/usageLimits";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  type AuthEnvironmentScope,
  AuthSessionId,
  ClientConnectionMethod,
  ClientDeviceType,
  ClientOs,
  ClientSurface,
  ClientWebDeployment,
  CommandId,
  type DiscoveredLocalServerList,
  EventId,
  type EditorId,
  type FileManagerRevealKind,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationGetTurnDiffError,
  type OrchestrationTradingMission,
  type TradingAccountWatch,
  type TradingWatchlistEntry,
  type TradingWatchlistMutationResult,
  ORCHESTRATION_WS_METHODS,
  TRADING_IDEA_ROW_CAP,
  type TradingIdeaRow,
  ProjectId,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProviderUploadFeedbackError,
  ProviderSetupError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  ServerSelfUpdateError,
  type ServerSelfUpdateProgressEvent,
  type ServerLifecycleStreamEvent,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  RpcClientId,
  EnvironmentAuthorizationError,
  ThreadId,
  type OrchestrationActivatePlanDocumentInput,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerRespondable } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from "./orchestration/ActivityPayloadProjection.ts";
import { makeThreadLiveEventCoalescer } from "./orchestration/ThreadLiveEventCoalescer.ts";
import { makeLiveStreamBudget, type RetainedLiveItem } from "./orchestration/LiveStreamBudget.ts";
import {
  cleanupFailedUploadedAttachments,
  normalizeDispatchCommand,
} from "./orchestration/Normalizer.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor.ts";
import { TradingMarketChart } from "./trading/TradingMarketChart.ts";
import {
  TradingResearchSceneService,
  composeSceneViews,
} from "./trading/TradingResearchSceneService.ts";
import { TradingEventService } from "./trading/TradingEventService.ts";
import { isChartReadEntitled } from "./trading/chartReadEntitlement.ts";
import { TradingMissionService } from "./trading/TradingMissionService.ts";
import { TradingManualEntryService } from "./trading/TradingManualEntryService.ts";
import { TradingControlService } from "./trading/TradingControlService.ts";
import { reconcileManualExposure } from "./trading/HyperliquidReconciler.ts";
import { LOCAL_TRADING_ACCOUNT_ID } from "./trading/TradingAccountBootstrap.ts";
import { TradingJournalService } from "./trading/TradingJournalService.ts";
import { publishPlanWithAftermath } from "./trading/TradingPlanPublication.ts";
import { composePlanRevisionNote } from "./trading/TradingPlanRevisionNote.ts";
import { TradingMarketPrice } from "./trading/TradingMarketPrice.ts";
import { ArchiveSupervisor } from "./trading/ArchiveSupervisor.ts";
import { FollowSetRegistry } from "./trading/FollowSetRegistry.ts";
import { marketRef } from "@t3tools/trading-contracts/primitives";
import { describeThesis } from "@t3tools/trading-contracts/thesis";
import { STUDY_CHART_MAX_WINDOW_BARS } from "@t3tools/trading-contracts/researchScenes";
import { TRADE_MD_FILENAME } from "@t3tools/trading-contracts";
import { TradingUniverse } from "./trading/TradingUniverse.ts";
import { TradingMissionProjection } from "./trading/TradingMissionProjection.ts";
import {
  readThreadWorkspaceRoot,
  TradingPlanDocumentService,
} from "./trading/TradingPlanDocument.ts";
import { TradingAccountProjection } from "./trading/TradingAccountProjection.ts";
import { TradingAlertService, type AccountWatch } from "./trading/TradingAlertService.ts";
import { TradingThesisValidationService } from "./trading/TradingThesisValidationService.ts";
import { TradingHypothesisService } from "./trading/TradingHypothesisService.ts";
import { selectIdeaCandidates, toIdeaRow } from "./trading/tradingIdeaRows.ts";
import { TradingAnalystService } from "./trading/TradingAnalystService.ts";
import {
  TradingThreadMarketService,
  type ThreadMarketFocus,
} from "./trading/TradingThreadMarketService.ts";
import {
  TradingWatchlistService,
  type WatchlistEntry,
  type WatchlistMutationResult,
} from "./trading/TradingWatchlistService.ts";
import { TradingTurnCoordinator } from "./trading/TradingTurnCoordinator.ts";

/**
 * Attach each mission's workspace TRADE.md facts to the snapshot the UI polls.
 *
 * The projection is SQL-only by design, and the plan document is a file on
 * disk classified against a persisted revision, so the join happens here — at
 * the read surface that needs it, like `withMarketPrices` beside it.
 *
 * A thread without a persisted workspace root (projectless) carries `null`,
 * which the UI reports as its own state. A read that fails degrades to the
 * absent shape rather than failing the whole snapshot: the document service
 * stays authoritative for drift, and a snapshot that cannot see one file must
 * not blind the operator to every mission.
 */
const withPlanDocuments = (
  missions: ReadonlyArray<OrchestrationTradingMission>,
  documents: TradingPlanDocumentService["Service"],
  sql: SqlClient.SqlClient,
): Effect.Effect<ReadonlyArray<OrchestrationTradingMission>> =>
  Effect.forEach(
    missions,
    (mission) =>
      Effect.gen(function* () {
        const workspaceRoot = yield* readThreadWorkspaceRoot(sql, mission.threadId);
        if (workspaceRoot === null) {
          return { ...mission, planDocument: null };
        }
        const current = yield* documents
          .readCurrent(workspaceRoot)
          .pipe(Effect.orElseSucceed(() => null));
        if (current !== null && current.status === "present") {
          return {
            ...mission,
            planDocument: {
              relativePath: TRADE_MD_FILENAME,
              activation: current.activation,
              contentHash: current.contentHash,
              activatedHash: current.activated === null ? null : current.activated.contentHash,
              activatedAt: current.activated === null ? null : current.activated.activatedAt,
              missionId: current.activated === null ? null : current.activated.missionId,
            },
          };
        }
        // Missing (or unreadable) file: the activation audit trail still
        // reads, so a vanished document shows what it drifted from rather
        // than nothing at all.
        const active =
          current === null
            ? null
            : yield* documents.readActive(workspaceRoot).pipe(Effect.orElseSucceed(() => null));
        return {
          ...mission,
          planDocument: {
            relativePath: TRADE_MD_FILENAME,
            activation: "none" as const,
            contentHash: null,
            activatedHash: active === null ? null : active.contentHash,
            activatedAt: active === null ? null : active.activatedAt,
            missionId: active === null ? null : active.missionId,
          },
        };
      }),
    { concurrency: "unbounded" },
  );

/** The `updatedAt` an empty mission snapshot reports. */
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/**
 * Quote each live mission's market on the snapshot the workspace polls.
 *
 * The projection is SQL-only, and no local table holds a mark price while the
 * mission is flat, so the live price is attached here — at the read surface
 * that needs it. Only missions that can still act are quoted: a revoked mission
 * is history, and pricing it would put an exchange call on the wire for a card
 * that reports a finished result.
 */
const withMarketPrices = (
  missions: ReadonlyArray<OrchestrationTradingMission>,
  marketPrice: TradingMarketPrice["Service"],
): Effect.Effect<ReadonlyArray<OrchestrationTradingMission>> =>
  Effect.forEach(
    missions,
    (mission) => {
      if (mission.status === "revoked" || mission.status === "completed") {
        return Effect.succeed(mission);
      }
      // One read per held market, so a switcher can label every tab. The
      // primary's is lifted into `marketPrice` as well, which is what every
      // surface that draws one market still reads.
      return Effect.map(
        Effect.forEach(
          mission.markets,
          (market) =>
            Effect.map(marketPrice.markPrice(market), (price) =>
              price === null ? null : { market, price },
            ),
          { concurrency: "unbounded" },
        ),
        (reads) => {
          const marketPrices = reads.filter((read) => read !== null);
          const primary = marketPrices.find((read) => read.market === mission.market);
          return {
            ...mission,
            marketPrices,
            ...(primary === undefined ? {} : { marketPrice: primary.price }),
          };
        },
      );
    },
    { concurrency: "unbounded" },
  );
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import { ProviderAuthService } from "./provider/Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { makeProviderInstallation } from "./provider/providerInstallation.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { deletePendingAttachment, issueAttachmentUploadUrl } from "./assets/AttachmentUpload.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import { readWorkflowScript } from "./orchestration/workflowScriptQuery.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import { importRecentAgentThreads } from "./project/AgentSessionImporter.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const epochIso = (epochMillis: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

/** The thread's market row, as the ISO wire contract. */
const toWireThreadMarketFocus = (focus: ThreadMarketFocus | null) =>
  focus === null
    ? null
    : {
        threadId: ThreadId.make(focus.threadId),
        market: marketRef(focus.asset),
        source: focus.source,
        updatedAt: epochIso(focus.updatedAt),
      };

/** The service's epoch-millis account watch, as the ISO wire contract. */
const toWireAccountWatch = (watch: AccountWatch): TradingAccountWatch => ({
  id: watch.id,
  market: watch.market,
  condition: watch.condition,
  deliver: watch.deliver,
  ...(watch.rearm === undefined ? {} : { rearm: watch.rearm }),
  status: watch.status,
  accountId: watch.accountId,
  ...(watch.lastObservedValue === undefined ? {} : { lastObservedValue: watch.lastObservedValue }),
  createdAt: epochIso(watch.createdAt),
  updatedAt: epochIso(watch.updatedAt),
});

const toWireWatchlistEntry = (entry: WatchlistEntry): TradingWatchlistEntry => ({
  market: entry.market,
  addedAt: epochIso(entry.addedAt),
  position: entry.position,
});

const toWireWatchlistResult = (result: WatchlistMutationResult): TradingWatchlistMutationResult =>
  result.outcome === "rejected"
    ? result
    : { outcome: "ok", entries: result.entries.map(toWireWatchlistEntry) };
const CONFIG_DISCOVERY_TIMEOUT = Duration.seconds(5);

const resolveDiscoveryForConfig = <A, E, R>(
  discovery: Effect.Effect<A, E, R>,
  onTimeout: () => A,
) =>
  discovery.pipe(
    Effect.timeoutOption(CONFIG_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(onTimeout)),
  );

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) => resolveDiscoveryForConfig(discovery, () => []);

export const resolveFileManagerRevealKindForConfig = <E, R>(
  discovery: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) => resolveDiscoveryForConfig(discovery, () => undefined);

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

/** Preserve the setup runner's broader pre-refactor message normalization. */
function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// When a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh shell
// snapshot instead. Replaying each intervening event costs a shell refetch;
// past this gap a single O(active-threads) snapshot is cheaper and bounded.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const SHELL_RESUME_MAX_GAP = 1_000;

// Thread replay counts only this thread's rows. Busy or pruned unrelated
// streams must not force a full thread snapshot.
const THREAD_RESUME_MAX_EVENTS = 1_000;
// Row count alone does not bound replay memory: a few events with large tool
// payloads can decode to gigabytes. Before replaying, sum the serialized
// payload bytes of the range in SQL and reset with a snapshot past this budget.
const ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024;

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const isClientSurface = Schema.is(ClientSurface);
const isClientConnectionMethod = Schema.is(ClientConnectionMethod);
const isClientDeviceType = Schema.is(ClientDeviceType);
const isClientOs = Schema.is(ClientOs);
const isClientWebDeployment = Schema.is(ClientWebDeployment);
const MAX_CLIENT_APP_VERSION_LENGTH = 64;
const MAX_CLIENT_BROWSER_LENGTH = 64;
const MAX_CLIENT_DEVICE_MODEL_LENGTH = 80;

// Optional client identity announced on the /ws upgrade URL next to wsTicket.
// Lenient by design: absent or malformed values degrade to {} so a connection
// never fails over attribution metadata.
function readClientConnectionOrigin(
  request: HttpServerRequest.HttpServerRequest,
): OrchestrationClientOrigin {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return {};
  }
  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion }
      : {}),
  };
}

// Client telemetry stays in this socket's RPC layer. It must not become a
// server-global "current client" because several client types can connect at once.
function readClientAnalyticsProps(request: HttpServerRequest.HttpServerRequest) {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return {};
  }

  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  const deviceType = url.value.searchParams.get("clientDeviceType");
  const os = url.value.searchParams.get("clientOs");
  const webDeployment = url.value.searchParams.get("clientWebDeployment");
  const browser = url.value.searchParams.get("clientBrowser")?.trim() ?? "";
  const connectionMethod = url.value.searchParams.get("connectionMethod");
  const rawOsMajorVersion = url.value.searchParams.get("clientOsMajorVersion") ?? "";
  const osMajorVersion = Number(rawOsMajorVersion);
  const deviceModel = url.value.searchParams.get("clientDeviceModel")?.trim() ?? "";
  const isMobile = surface === "mobile";
  const hasOsMajorVersion =
    isMobile && rawOsMajorVersion !== "" && Number.isInteger(osMajorVersion) && osMajorVersion > 0;
  const hasDeviceModel =
    isMobile && deviceModel !== "" && deviceModel.length <= MAX_CLIENT_DEVICE_MODEL_LENGTH;

  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion, clientAppVersion: appVersion }
      : {}),
    ...(isClientOs(os)
      ? {
          clientOs: os,
          ...(isMobile && (os === "iOS" || os === "Android") ? { os } : {}),
        }
      : {}),
    ...(isClientDeviceType(deviceType) ? { clientDeviceType: deviceType } : {}),
    ...(surface === "web" && isClientWebDeployment(webDeployment) ? { webDeployment } : {}),
    ...(surface === "web" && browser !== "" && browser.length <= MAX_CLIENT_BROWSER_LENGTH
      ? { clientBrowser: browser }
      : {}),
    ...(hasOsMajorVersion ? { osMajorVersion, clientOsMajorVersion: osMajorVersion } : {}),
    ...(hasDeviceModel ? { deviceModel, clientDeviceModel: deviceModel } : {}),
    ...(isClientConnectionMethod(connectionMethod) ? { connectionMethod } : {}),
  };
}

const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  clientOrigin: OrchestrationClientOrigin,
  clientAnalyticsProps: Readonly<Record<string, unknown>>,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const crypto = yield* Crypto.Crypto;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const tradingMissionProjection = yield* TradingMissionProjection;
      const planDocuments = yield* TradingPlanDocumentService;
      const sql = yield* SqlClient.SqlClient;
      const tradingAccountProjection = yield* TradingAccountProjection;
      const tradingAlertService = yield* TradingAlertService;
      const tradingValidations = yield* TradingThesisValidationService;
      const tradingHypotheses = yield* TradingHypothesisService;
      const tradingAnalystService = yield* TradingAnalystService;
      const tradingThreadMarket = yield* TradingThreadMarketService;
      const tradingWatchlistService = yield* TradingWatchlistService;
      const tradingManualEntry = yield* TradingManualEntryService;
      const tradingControls = yield* TradingControlService;
      const tradingMissionService = yield* TradingMissionService;
      const archiveSupervisor = yield* ArchiveSupervisor;
      const followSetRegistry = yield* FollowSetRegistry;
      const tradingUniverse = yield* TradingUniverse;
      const tradingMarketPrice = yield* TradingMarketPrice;
      const tradingMarketChart = yield* TradingMarketChart;
      const tradingTurnCoordinator = yield* TradingTurnCoordinator;
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const threadDeletionReactor = yield* ThreadDeletionReactor;
      const analytics = yield* AnalyticsService.AnalyticsService;
      // Every command dispatched on this connection carries the connecting
      // client's origin, including server-generated bootstrap sub-commands:
      // the client's request caused them.
      const hasClientOrigin =
        clientOrigin.surface !== undefined || clientOrigin.appVersion !== undefined;
      const dispatchFromClient: OrchestrationEngine.OrchestrationEngineShape["dispatch"] = (
        command,
      ) =>
        orchestrationEngine.dispatch(
          command,
          hasClientOrigin ? { origin: clientOrigin } : undefined,
        );
      const recordClientCommandAnalytics = (command: OrchestrationCommand) => {
        switch (command.type) {
          case "thread.create":
            return analytics.record("client.thread.started", clientAnalyticsProps);
          case "thread.turn.start":
            return command.bootstrap?.createThread
              ? Effect.andThen(
                  analytics.record("client.thread.started", clientAnalyticsProps),
                  analytics.record("client.turn.requested", clientAnalyticsProps),
                )
              : analytics.record("client.turn.requested", clientAnalyticsProps);
          default:
            return Effect.void;
        }
      };
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
      const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const previewManager = yield* PreviewManager.PreviewManager;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providerService = yield* ProviderService.ProviderService;
      const providerSessionDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const providerAuth = yield* ProviderAuthService;
      const providerInstances = yield* ProviderInstanceRegistry;
      const providerInstallation = yield* makeProviderInstallation();
      const serverUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const canReplayPersistedRange = Effect.fnUntraced(function* (
        afterSequence: number,
        headSequence: number,
        maxGap: number,
      ) {
        const replayGap = headSequence - afterSequence;
        if (replayGap < 0 || replayGap > maxGap) {
          return false;
        }
        const stats = yield* projectionSnapshotQuery
          .getEventReplayStats({
            fromSequenceExclusive: afterSequence,
            toSequenceInclusive: headSequence,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to measure orchestration replay range",
                  cause,
                }),
            ),
          );
        if (stats.payloadBytes > ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES) {
          yield* Effect.logDebug("orchestration replay replaced by snapshot", {
            afterSequence,
            headSequence,
            replayGap,
            eventCount: stats.eventCount,
            payloadBytes: stats.payloadBytes,
            payloadBudgetBytes: ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES,
          });
          return false;
        }
        return true;
      });
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const agentSessionScanner = yield* AgentSessionScanner.AgentSessionScanner;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
      yield* Effect.addFinalizer(() =>
        Ref.get(rpcClientIds).pipe(
          Effect.flatMap((clientIds) =>
            Effect.forEach(
              clientIds,
              (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
              {
                discard: true,
              },
            ),
          ),
          Effect.ignore,
        ),
      );
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map(
          (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const pullRequests = yield* PullRequestService.PullRequestService;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const hostResources = yield* HostResources.HostResources;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
      const usage = yield* UsageService.UsageService;
      const relayClient = yield* RelayClient.RelayClient;
      const authorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(authorizationError(requiredScope));
      const authorizeStream = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? stream
          : Stream.fail(authorizationError(requiredScope));
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStream(
          method,
          authorizeStream(requiredScopeForRpcMethod(method), stream),
          traceAttributes,
        );
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStreamEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });
      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
        ),
      );
      const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        );

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId("setup-script-activity"),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            dispatchFromClient({
              type: "thread.activity.append",
              commandId,
              threadId: input.threadId,
              activity: {
                id: activityId,
                tone: input.tone,
                kind: input.kind,
                summary: input.summary,
                payload: input.payload,
                turnId: null,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        );

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return isOrchestrationDispatchCommandError(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      // Shell updates refetch the aggregate. Message and tool bodies are not needed.
      const toShellEvent = ({
        type,
        aggregateKind,
        aggregateId,
        sequence,
      }: OrchestrationEvent) => ({
        type,
        aggregateKind,
        aggregateId,
        sequence,
      });
      type ShellEvent = ReturnType<typeof toShellEvent>;

      const toShellStreamEvent = (
        event: ShellEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectUpsertOrRemove(ProjectId.make(event.aggregateId), event.sequence);
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: ProjectId.make(event.aggregateId),
              }),
            );
          case "thread.deleted":
          case "thread.archived":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: ThreadId.make(event.aggregateId),
              }),
            );
          case "thread.unarchived":
            return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
        }
      };

      // Coalescing makes each projection read represent every event for that
      // aggregate in the current window. Retry a typed persistence failure once
      // so a brief read failure cannot strand the shell at its previous state.
      // If both attempts fail, log and drop the stream item; treating an error as
      // a missing row would incorrectly remove a still-active aggregate.
      const retryShellProjectionRead = <A, E>(
        aggregateKind: "project" | "thread",
        aggregateId: string,
        read: Effect.Effect<A, E>,
      ): Effect.Effect<Option.Option<A>, never, never> =>
        read.pipe(
          Effect.retry({ times: 1 }),
          Effect.map(Option.some),
          Effect.tapError((error) =>
            Effect.logWarning("orchestration shell projection refetch failed", {
              aggregateKind,
              aggregateId,
              error,
            }),
          ),
          Effect.orElseSucceed(() => Option.none()),
        );

      const projectUpsertOrRemove = (
        projectId: ProjectId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "project",
          projectId,
          projectionSnapshotQuery.getProjectShellById(projectId),
        ).pipe(
          Effect.map(
            Option.flatMap((project) =>
              Option.match(project, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-removed" as const,
                    sequence,
                    projectId,
                  }),
                onSome: (nextProject) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-upserted" as const,
                    sequence,
                    project: nextProject,
                  }),
              }),
            ),
          ),
        );

      // Refetch a thread's shell and emit an upsert if it is still active, or a
      // `thread-removed` if the projection has no active row for it. Emitting a
      // removal on a `none` (rather than dropping the event) is what keeps
      // coalescing correct: when a burst collapses a `thread.deleted`/`archived`
      // into a later refetchable event for the same thread, the refetch returns
      // `none` for the now-inactive row and this still tells the sidebar to drop
      // it. A `thread-removed` the client does not have is a harmless no-op. The
      // projection commits in the same transaction before the event publishes,
      // so a `none` reliably means the thread is deleted or archived, not
      // not-yet-persisted.
      const threadUpsertOrRemove = (
        threadId: ThreadId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "thread",
          threadId,
          projectionSnapshotQuery.getThreadShellById(threadId),
        ).pipe(
          Effect.map(
            Option.flatMap((thread) =>
              Option.match(thread, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-removed" as const,
                    sequence,
                    threadId,
                  }),
                onSome: (nextThread) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-upserted" as const,
                    sequence,
                    thread: nextThread,
                  }),
              }),
            ),
          ),
        );

      // Turn a batch of domain events into shell stream items, coalescing by
      // aggregate first. `toShellStreamEvent` re-reads the *current* projected
      // shell for an aggregate, so within a batch only the latest event per
      // aggregate matters: a burst of streaming `thread.message-sent` deltas for
      // one thread collapses into a single shell refetch, and an unrelated
      // `thread.created` in the same batch is never stuck behind those DB reads.
      //
      // Input events arrive in ascending sequence; we keep the last (highest
      // sequence) event per aggregate, then re-sort ascending before emitting so
      // the client — which applies shell items strictly by increasing sequence
      // and drops any `sequence <= snapshotSequence` — never skips a coalesced
      // item. The refetch runs with bounded concurrency (order-preserving).
      const SHELL_REFETCH_CONCURRENCY = 8;
      const coalesceShellEvents = (
        events: ReadonlyArray<ShellEvent>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>, never, never> =>
        Effect.gen(function* () {
          if (events.length === 0) {
            return [];
          }
          const latestByAggregate = new Map<string, ShellEvent>();
          for (const event of events) {
            latestByAggregate.set(`${event.aggregateKind}:${event.aggregateId}`, event);
          }
          const survivors = Array.from(latestByAggregate.values()).sort(
            (left, right) => left.sequence - right.sequence,
          );
          const shellEvents = yield* Effect.forEach(survivors, toShellStreamEvent, {
            concurrency: SHELL_REFETCH_CONCURRENCY,
          });
          return shellEvents.flatMap((option) => (Option.isSome(option) ? [option.value] : []));
        });

      // Small time/size window over which to coalesce shell events. The window
      // bounds the worst-case added latency for a brand-new thread to appear in
      // the sidebar (imperceptible), while collapsing high-frequency streaming
      // traffic so it can't serialize the shell stream behind per-event DB reads.
      const SHELL_COALESCE_WINDOW = Duration.millis(50);
      const SHELL_COALESCE_MAX_CHUNK = 512;
      const coalesceShellStream = <E, R>(
        stream: Stream.Stream<OrchestrationEvent, E, R>,
      ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
        stream.pipe(
          Stream.map(toShellEvent),
          Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
          Stream.mapEffect(coalesceShellEvents),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

      type ShellLiveInput =
        | { readonly kind: "event"; readonly event: ShellEvent }
        | { readonly kind: "synchronized" };

      // A completion marker is queued alongside live event metadata so it cannot
      // overtake an event still waiting in the coalescing window. Split each
      // batch at markers and coalesce only the event segments on either side.
      const coalesceShellLiveInputs = (
        inputs: ReadonlyArray<ShellLiveInput>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamItem>, never, never> =>
        Effect.gen(function* () {
          const output: Array<OrchestrationShellStreamItem> = [];
          let pendingEvents: Array<ShellEvent> = [];

          for (const input of inputs) {
            if (input.kind === "event") {
              pendingEvents.push(input.event);
              continue;
            }

            output.push(...(yield* coalesceShellEvents(pendingEvents)));
            pendingEvents = [];
            output.push({ kind: "synchronized" });
          }

          output.push(...(yield* coalesceShellEvents(pendingEvents)));
          return output;
        });

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? serverCommandId("bootstrap-thread-delete").pipe(
                  Effect.flatMap((commandId) =>
                    dispatchFromClient({
                      type: "thread.delete",
                      commandId,
                      threadId: command.threadId,
                    }),
                  ),
                  Effect.as(true),
                )
              : Effect.succeed(false);

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail = projectSetupScriptCompatibilityDetail(input.error);
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) =>
            Effect.gen(function* () {
              const startedAt = yield* nowIso;
              const payload = {
                scriptId: input.scriptId,
                scriptName: input.scriptName,
                terminalId: input.terminalId,
                worktreePath: input.worktreePath,
              };
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: input.requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: startedAt,
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "bootstrap turn start launched setup script but failed to record setup activity",
                    {
                      threadId: command.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: input.scriptId,
                      terminalId: input.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              );
            });

          const runSetupProgram = () =>
            Effect.gen(function* () {
              if (!bootstrap?.runSetupScript || !targetWorktreePath) {
                return;
              }
              const worktreePath = targetWorktreePath;
              const requestedAt = yield* nowIso;
              yield* projectSetupScriptRunner
                .runForThread({
                  threadId: command.threadId,
                  ...(targetProjectId ? { projectId: targetProjectId } : {}),
                  ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                  worktreePath,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      recordSetupScriptLaunchFailure({
                        error,
                        requestedAt,
                        worktreePath,
                      }),
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") {
                        return Effect.void;
                      }
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      });
                    },
                  }),
                );
            });

          const bootstrapProgram = Effect.gen(function* () {
            // Creating the thread is the "ensure it exists" half of the
            // bootstrap, not a claim that it does not. A client that sends a
            // second message before the first turn's creation is reflected in
            // its own state sends the same `createThread` bootstrap again, and
            // the `thread.create` invariant rejected that second command —
            // taking the user's message down with it. Skipping the create for
            // a thread that already exists keeps the message.
            const threadAlreadyExists = bootstrap?.createThread
              ? yield* projectionSnapshotQuery.getThreadShellById(command.threadId).pipe(
                  Effect.map(Option.isSome),
                  // An unreadable projection is not evidence of absence, and
                  // the create below is the same call this code always made:
                  // let it decide.
                  Effect.orElseSucceed(() => false),
                )
              : false;
            if (bootstrap?.createThread && !threadAlreadyExists) {
              const created = yield* dispatchFromClient({
                type: "thread.create",
                commandId: yield* serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              // The successful create is a fence in the engine command queue:
              // every delete for the prior incarnation committed before it.
              // Drain through that event before setup or turn start can own
              // terminals and provider sessions under the reused thread id.
              yield* threadDeletionReactor.drainThrough(created.sequence);
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
              // "Start from origin" is a stored default; repos without the
              // requested remote branch fall back to the local base branch.
              const startFromOrigin =
                bootstrap.prepareWorktree.startFromOrigin === true &&
                (yield* gitWorkflow.remoteExists({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  remoteName: "origin",
                }));
              if (startFromOrigin) {
                yield* gitWorkflow.fetchRemote({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  remoteName: "origin",
                });
                const remoteBaseExists = yield* gitWorkflow.remoteBranchExists({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  refName: bootstrap.prepareWorktree.baseBranch,
                  remoteName: "origin",
                });
                if (remoteBaseExists) {
                  const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                    cwd: bootstrap.prepareWorktree.projectCwd,
                    refName: bootstrap.prepareWorktree.baseBranch,
                    fallbackRemoteName: "origin",
                  });
                  worktreeBaseRef = resolvedRemoteBase.commitSha;
                }
              }
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: worktreeBaseRef,
                newRefName: bootstrap.prepareWorktree.branch,
                baseRefName: bootstrap.prepareWorktree.baseBranch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* dispatchFromClient({
                type: "thread.meta.update",
                commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* dispatchTradingAwareTurnStart(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return Effect.uninterruptible(cleanupCreatedThread()).pipe(
                Effect.matchCauseEffect({
                  onFailure: (cleanupCause) =>
                    Effect.logWarning("bootstrap thread cleanup failed", {
                      threadId: command.threadId,
                      detail: Cause.pretty(cleanupCause),
                    }).pipe(Effect.flatMap(() => Effect.fail(dispatchError))),
                  onSuccess: (threadDeleted) =>
                    Effect.fail(
                      threadDeleted
                        ? new OrchestrationDispatchCommandError({
                            message: dispatchError.message,
                            ...(dispatchError.cause !== undefined
                              ? { cause: dispatchError.cause }
                              : {}),
                            bootstrapThreadDisposition: "deleted",
                          })
                        : dispatchError,
                    ),
                }),
              );
            }),
          );
        });

      /**
       * Route a turn start past the trading path that may own it.
       *
       * A message on a thread bound to a live mission goes through the wake
       * path, so the operator's message arrives with a fresh mission snapshot
       * and holds the decision lease rather than racing a watch-fired run.
       * (Missions themselves are created explicitly from the trade home's
       * mission form via `trading.mission.create` — a first message never
       * becomes one.)
       *
       * The coordinator answers "not mine" for anything else, and the
       * ordinary dispatch runs.
       */
      const dispatchTradingAwareTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ) =>
        Effect.gen(function* () {
          const routed = yield* tradingTurnCoordinator.requestUserMessageRun({
            threadId: command.threadId,
            text: command.message.text,
          });
          if (routed) return { sequence: yield* orchestrationEngine.latestSequence };

          return yield* dispatchFromClient(command).pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
        });

      const dispatchTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ) =>
        command.bootstrap
          ? dispatchBootstrapTurnStart(command)
          : dispatchTradingAwareTurnStart(command);

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start"
            ? dispatchTurnStart(normalizedCommand)
            : dispatchFromClient(normalizedCommand).pipe(
                Effect.tap(({ sequence }) =>
                  // Returning from thread.create is the handoff point at which
                  // clients may start resources for the new incarnation. Use
                  // its event sequence as the exact deletion-cleanup fence.
                  normalizedCommand.type === "thread.create"
                    ? threadDeletionReactor.drainThrough(sequence)
                    : Effect.void,
                ),
                Effect.mapError((cause) =>
                  toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                ),
              );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      // Only clients that answer /usage-limits themselves see it in the catalogs;
      // an older client would send the injected command to the provider.
      const loadServerConfig = (options: { readonly usageLimitsCommand: boolean }) =>
        Effect.gen(function* () {
          const keybindingsConfig = yield* keybindings.loadConfigState;
          const currentProviders = yield* providerRegistry.getProviders;
          const providers = options.usageLimitsCommand
            ? withUsageLimitsCommands(currentProviders, yield* usageLimitSources.current)
            : currentProviders;
          const settings = ServerSettings.redactServerSettingsForClient(
            yield* serverSettings.getSettings,
          );
          const environment = yield* serverEnvironment.getDescriptor;
          const auth = yield* serverAuth.getDescriptor();
          const availableEditors: ReadonlyArray<EditorId> = yield* resolveAvailableEditorsForConfig(
            externalLauncher.resolveAvailableEditors(),
          );
          const fileManagerRevealKind = availableEditors.includes("file-manager")
            ? yield* resolveFileManagerRevealKindForConfig(
                externalLauncher.resolveFileManagerRevealKind(),
              )
            : undefined;

          return {
            environment,
            auth,
            cwd: config.cwd,
            keybindingsConfigPath: config.keybindingsConfigPath,
            keybindings: keybindingsConfig.keybindings,
            issues: keybindingsConfig.issues,
            providers,
            availableEditors,
            // Same discovery-with-timeout treatment as editors: a slow probe
            // must not stall server.getConfig, so it degrades to no targets.
            remoteOpenTargets: yield* resolveAvailableEditorsForConfig(
              remoteOpenTargets.resolveTargets(),
            ),
            observability: {
              logsDirectoryPath: config.logsDir,
              localTracingEnabled: true,
              ...(config.otlpTracesUrl !== undefined
                ? { otlpTracesUrl: config.otlpTracesUrl }
                : {}),
              otlpTracesEnabled: config.otlpTracesUrl !== undefined,
              ...(config.otlpMetricsUrl !== undefined
                ? { otlpMetricsUrl: config.otlpMetricsUrl }
                : {}),
              otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
            },
            settings,
            shellResumeCompletionMarker: true,
            ...(fileManagerRevealKind === undefined
              ? {}
              : {
                  shellRevealInFileManager: true,
                  shellRevealInFileManagerKind: fileManagerRevealKind,
                }),
            threadResumeCompletionMarker: true,
            threadSnapshotPagination: true,
          };
        });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              // Archive removes the thread from the client, so this transport
              // closes its session and terminals after the command lands.
              // Settlement cleanup is driven by thread.settled events in the
              // provider reactor, including settlements that have no client.
              const archiveCommand =
                normalizedCommand.type === "thread.archive" ? normalizedCommand : undefined;
              // Best-effort on purpose: the user's archive must not
              // fail because this cleanup read blipped, so a failed read
              // logs and skips the stop instead of propagating.
              const shouldStopSessionAfterCommand = archiveCommand
                ? yield* projectionSnapshotQuery.getThreadShellById(archiveCommand.threadId).pipe(
                    Effect.map(
                      Option.match({
                        onNone: () => false,
                        onSome: (thread) =>
                          thread.session !== null && thread.session.status !== "stopped",
                      }),
                    ),
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        "failed to read thread session state before session-stop check",
                        { threadId: archiveCommand.threadId, cause },
                      ).pipe(Effect.as(false)),
                    ),
                  )
                : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand).pipe(
                Effect.tapError(() => cleanupFailedUploadedAttachments(command, normalizedCommand)),
              );
              yield* recordClientCommandAnalytics(normalizedCommand);
              if (archiveCommand) {
                if (shouldStopSessionAfterCommand) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${archiveCommand.commandId}`,
                      ),
                      threadId: archiveCommand.threadId,
                      createdAt: yield* nowIso,
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: archiveCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                // Archive removes the thread from view, so its user-opened
                // terminal panes close with it.
                yield* terminalManager.close({ threadId: archiveCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: archiveCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getWorkflowScript]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getWorkflowScript,
            readWorkflowScript({ scriptPath: input.scriptPath }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.searchThreads,
            projectionSnapshotQuery.searchThreads(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationSearchThreadsError({
                    message: "Failed to search threads",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              // Coalesce the live shell stream per aggregate over a small window
              // so bursts of high-frequency events (streaming message deltas,
              // activity appends) collapse into a single shell refetch and never
              // serialize a brand-new thread's `thread.created` behind hundreds
              // of per-event DB reads. See coalesceShellStream.
              // Attach live delivery into a scope-bound buffer BEFORE loading any
              // snapshot or draining catch-up, otherwise an event published while
              // the snapshot query is in flight is lost (it is past the snapshot's
              // sequence but the live subscription is not attached yet). Every
              // path below emits from this same buffered live tail. Overlapping
              // events are deduped by sequence on the client.
              const liveBudget = yield* makeLiveStreamBudget();
              const liveBuffer = yield* Queue.unbounded<
                RetainedLiveItem<ShellLiveInput>,
                OrchestrationGetSnapshotError
              >();
              let liveBufferClosed = false;
              const closeLiveBuffer = (error?: OrchestrationGetSnapshotError) =>
                Effect.gen(function* () {
                  if (liveBufferClosed) {
                    return;
                  }
                  liveBufferClosed = true;
                  liveBudget.release(yield* Queue.clear(liveBuffer).pipe(Effect.orDie));
                  if (error) {
                    yield* Queue.fail(liveBuffer, error);
                  }
                  yield* Queue.shutdown(liveBuffer);
                });
              yield* Effect.addFinalizer(() => closeLiveBuffer());
              yield* liveBudget.failed.pipe(
                Effect.catchTags({ OrchestrationGetSnapshotError: closeLiveBuffer }),
                Effect.forkScoped,
              );
              yield* Effect.forkScoped(
                orchestrationEngine.streamDomainEvents.pipe(
                  Stream.map(toShellEvent),
                  Stream.runForEach((event) =>
                    liveBudget.retain({ kind: "event" as const, event }, event).pipe(
                      Effect.flatMap((item) => Queue.offer(liveBuffer, item)),
                      Effect.uninterruptible,
                    ),
                  ),
                  // Stop the PubSub consumer even if RPC delivery is waiting
                  // for an ACK and never pulls the failed buffer again.
                  Effect.raceFirst(liveBudget.failed),
                  Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
                ),
                { startImmediately: true },
              );
              const coalesceRetainedInputs = (
                items: ReadonlyArray<RetainedLiveItem<ShellLiveInput>>,
              ) =>
                coalesceShellLiveInputs(items.map((item) => item.value)).pipe(
                  Effect.flatMap((output) => liveBudget.replace(items, output)),
                );
              const bufferedLiveStream = Stream.fromQueue(liveBuffer).pipe(
                Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
                Stream.mapEffect(coalesceRetainedInputs),
                Stream.flatMap((items) => Stream.fromIterable(items)),
              );

              const loadSnapshot = projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              // Offer the completion marker into the same queue as live events.
              // Anything buffered while snapshot/replay work was in flight is
              // therefore delivered before the client is told it is synchronized.
              const synchronizedThenLive = liveBudget.deliver(
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        liveBudget.retain({ kind: "synchronized" as const }).pipe(
                          Effect.flatMap((item) => Queue.offer(liveBuffer, item)),
                          Effect.uninterruptible,
                          Effect.andThen(Queue.takeAll(liveBuffer)),
                          Effect.flatMap(coalesceRetainedInputs),
                        ),
                      ).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream,
              );

              // When the client already holds a shell snapshot (cached, or loaded
              // over HTTP) it passes that snapshot's sequence, and we resume by
              // replaying shell events after it instead of re-sending the whole
              // projects/threads list over the socket. If the client is too far
              // behind, we fall back to a fresh snapshot instead of an unbounded
              // replay (see below).
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                // Gap too large: replaying every intervening event (each a shell
                // refetch) is far more expensive than a single O(active-threads)
                // snapshot. A cursor ahead of this engine's authoritative state
                // is also invalid, so reset it with a snapshot. Send the snapshot
                // followed by the buffered live tail, exactly as the
                // no-afterSequence path does.
                if (
                  !(yield* canReplayPersistedRange(
                    afterSequence,
                    headSequence,
                    SHELL_RESUME_MAX_GAP,
                  ))
                ) {
                  const snapshot = yield* loadSnapshot;
                  return Stream.concat(
                    Stream.make({ kind: "snapshot" as const, snapshot }),
                    synchronizedThenLive,
                  );
                }
                const catchUpStream = coalesceShellStream(
                  // Replay only through the head captured above. Newer events
                  // are already covered by the live subscription, so this bound
                  // cannot chase a moving event-store head or grow the live
                  // buffer indefinitely while waiting for an empty page.
                  orchestrationEngine.readEvents(afterSequence, replayGap),
                ).pipe(
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to replay orchestration shell events",
                        cause,
                      }),
                  ),
                );
                return Stream.concat(catchUpStream, synchronizedThenLive);
              }

              const snapshot = yield* loadSnapshot;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                synchronizedThenLive,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTradingMissionSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTradingMissionSnapshot,
            Effect.gen(function* () {
              const missions = yield* withPlanDocuments(
                yield* withMarketPrices(yield* tradingMissionProjection.list(), tradingMarketPrice),
                planDocuments,
                sql,
              );
              // The snapshot sequence is the engine's latest event sequence, so
              // the client can tell a stale snapshot (behind the subscribed
              // stream) from a fresh one. Previously this was hardcoded to 0,
              // which made the sequence useless for ordered catch-up.
              const snapshotSequence = yield* orchestrationEngine.latestSequence;
              const archive = yield* archiveSupervisor.health;
              return {
                snapshotSequence,
                missions,
                updatedAt: missions[0]?.updatedAt ?? EPOCH_ISO,
                archive: {
                  status: archive.status,
                  externalWriter: archive.externalWriter,
                  running: archive.running,
                  lastHeartbeat: archive.lastHeartbeat,
                  lastHeartbeatAt:
                    archive.lastHeartbeatAt === null
                      ? null
                      : DateTime.formatIso(DateTime.makeUnsafe(archive.lastHeartbeatAt)),
                  restarts: archive.restarts,
                  stoppedReason: archive.stoppedReason,
                },
              };
            }).pipe(
              Effect.tapError((cause) =>
                Effect.logError("trading mission snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load the trading mission snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTradingUniverse]: () =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTradingUniverse,
            Effect.gen(function* () {
              // Unentitled by design: this is the list of what the venue
              // trades, the same public data the exchange serves anyone. It
              // carries no account, no mission, and no position.
              const assets = yield* tradingUniverse.list;
              const observedAt = yield* nowIso;
              return { assets, observedAt };
            }).pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("trading universe load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load the trading universe",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTradingAccountView]: () =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTradingAccountView,
            Effect.gen(function* () {
              const assembled = yield* tradingAccountProjection.view();
              // Same riders as the mission snapshot, for the same reasons: the
              // sequence dates the read against the event stream, and archiver
              // health is what says whether derived numbers are real.
              const snapshotSequence = yield* orchestrationEngine.latestSequence;
              const archive = yield* archiveSupervisor.health;
              // Whether this environment can sign at all. The `trading_accounts`
              // row is the thing every execution path actually needs, and
              // `TradingAccountBootstrap` writes it only when a signer is armed,
              // so its presence is the honest answer. Rides this view rather
              // than getting a subscription of its own: the trade home already
              // reads it for the archiver line, and this belongs beside that one.
              const signerArmed = yield* tradingMissionService
                .getMasterWalletAddress(LOCAL_TRADING_ACCOUNT_ID)
                .pipe(
                  Effect.as(true),
                  Effect.catchCause(() => Effect.succeed(false)),
                );
              return {
                snapshotSequence,
                accounts: assembled.accounts,
                updatedAt: assembled.updatedAt,
                signerArmed,
                archive: {
                  status: archive.status,
                  externalWriter: archive.externalWriter,
                  running: archive.running,
                  lastHeartbeat: archive.lastHeartbeat,
                  lastHeartbeatAt:
                    archive.lastHeartbeatAt === null
                      ? null
                      : DateTime.formatIso(DateTime.makeUnsafe(archive.lastHeartbeatAt)),
                  restarts: archive.restarts,
                  stoppedReason: archive.stoppedReason,
                },
              };
            }).pipe(
              Effect.tapError((cause) =>
                Effect.logError("trading account view load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load the trading account view",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeTradingAccount]: (_input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeTradingAccount,
            // Doorbell-only: each event tells the client to refetch the view.
            // No snapshot rides the stream — the view RPC is the snapshot.
            // Alert appends and watch/watchlist edits ring this same doorbell,
            // so the alert feed needs no second subscription.
            Effect.succeed(tradingAccountProjection.changes),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.armTradingWatch]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.armTradingWatch,
            tradingAlertService.armWatch(input).pipe(
              Effect.map((result) =>
                result.outcome === "rejected"
                  ? result
                  : { outcome: "armed" as const, watch: toWireAccountWatch(result.watch) },
              ),
              Effect.tapError((cause) => Effect.logError("trading watch arm failed", { cause })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to arm the trading watch",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        // Acknowledging a drifted (or never-activated) TRADE.md revision from
        // the plan-state card. The same act the `trading_plan_document` tool
        // performs, on the same optimistic-concurrency token: a file that
        // changed since the caller's read refuses with `stale_hash` and
        // nothing is written.
        [ORCHESTRATION_WS_METHODS.activateTradingPlanDocument]: (
          input: OrchestrationActivatePlanDocumentInput,
        ) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.activateTradingPlanDocument,
            Effect.gen(function* () {
              const workspaceRoot = yield* readThreadWorkspaceRoot(sql, input.threadId);
              if (workspaceRoot === null) {
                return {
                  outcome: "rejected" as const,
                  reason: "no_workspace",
                  detail:
                    "This thread has no persisted workspace root, so there is no TRADE.md to activate.",
                };
              }
              return yield* Effect.map(
                planDocuments.activate({
                  workspaceRoot,
                  expectedContentHash: input.expectedContentHash,
                  threadId: input.threadId,
                  provider: "web-ui",
                  ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
                  ...(input.changeNote === undefined ? {} : { changeNote: input.changeNote }),
                }),
                (active) => ({
                  outcome: "activated" as const,
                  planDocument: {
                    relativePath: TRADE_MD_FILENAME,
                    activation: "active" as const,
                    contentHash: active.contentHash,
                    activatedHash: active.contentHash,
                    activatedAt: active.activatedAt,
                    missionId: active.missionId,
                  },
                }),
              );
            }).pipe(
              Effect.catchTags({
                TradingPlanDocumentError: (cause) =>
                  Effect.succeed({
                    outcome: "rejected" as const,
                    reason: cause.reason,
                    detail: cause.detail,
                  }),
              }),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to activate the trading plan document",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.ensureTradingAnalystThread]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.ensureTradingAnalystThread,
            tradingAnalystService
              .ensureThread({ asset: input.asset, candidateThreadId: input.candidateThreadId })
              .pipe(
                Effect.map((result) => ({
                  threadId: ThreadId.make(result.threadId),
                  created: result.created,
                })),
                Effect.tapError((cause) =>
                  Effect.logError("trading analyst thread ensure failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to resolve the analyst thread",
                      cause,
                    }),
                ),
              ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTradingThreadMarket]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTradingThreadMarket,
            tradingThreadMarket.read(input.threadId).pipe(
              Effect.map((focus) => ({ focus: toWireThreadMarketFocus(focus) })),
              Effect.tapError((cause) =>
                Effect.logError("trading thread market read failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to read the thread's market",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.setTradingThreadMarket]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.setTradingThreadMarket,
            tradingThreadMarket
              .record({ threadId: input.threadId, asset: input.asset, source: "seeded" })
              .pipe(
                Effect.map((focus) => ({ focus: toWireThreadMarketFocus(focus) })),
                Effect.tapError((cause) =>
                  Effect.logError("trading thread market seed failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to put that market on the thread",
                      cause,
                    }),
                ),
              ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.cancelTradingWatch]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.cancelTradingWatch,
            tradingAlertService.cancelWatch(input.watchId).pipe(
              Effect.map((cancelled) => ({ cancelled })),
              Effect.tapError((cause) => Effect.logError("trading watch cancel failed", { cause })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to cancel the trading watch",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.listTradingWatches]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listTradingWatches,
            tradingAlertService.listWatches.pipe(
              Effect.map((watches) => ({ watches: watches.map(toWireAccountWatch) })),
              Effect.tapError((cause) => Effect.logError("trading watch list failed", { cause })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to list the trading watches",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.listTradingAlerts]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listTradingAlerts,
            tradingAlertService
              .listAlerts(input.limit === undefined ? {} : { limit: input.limit })
              .pipe(
                // A validation ending is filed under the validation's own id,
                // so one lookup over the page says which rows have a report
                // behind them. Without it the client sees an opaque id and
                // cannot tell an expandable row from an ordinary alert.
                Effect.flatMap((alerts) =>
                  tradingValidations
                    .knownIds(alerts.map((alert) => alert.watchId))
                    .pipe(Effect.map((validationIds) => ({ alerts, validationIds }))),
                ),
                Effect.map(({ alerts, validationIds }) => ({
                  alerts: alerts.map((alert) => ({
                    id: alert.id,
                    market: alert.market,
                    accountId: alert.accountId,
                    watchId: alert.watchId,
                    firedAt: DateTime.formatIso(DateTime.makeUnsafe(alert.firedAt)),
                    summary: alert.summary,
                    ...(validationIds.has(alert.watchId) ? { validationId: alert.watchId } : {}),
                  })),
                })),
                Effect.tapError((cause) => Effect.logError("trading alert list failed", { cause })),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to list the trading alerts",
                      cause,
                    }),
                ),
              ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTradingValidationReport]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTradingValidationReport,
            Effect.gen(function* () {
              const now = DateTime.toEpochMillis(yield* DateTime.now);
              const validation = yield* tradingValidations.get(input.validationId);
              if (validation === null) return { report: null };
              // Guarded the way the chart read is, and against the same list:
              // a market this install pays attention to, held by a mission or
              // in the follow set. A windowed shape, because a validation
              // whose report anybody wants to read has usually ended, and
              // refusing a terminal mission's market would refuse every
              // post-mortem there is.
              const missions = yield* tradingMissionProjection.list();
              const followed = yield* followSetRegistry.list;
              if (
                !isChartReadEntitled(
                  { market: validation.asset, startTime: validation.armedAt, endTime: now },
                  missions,
                  followed.map((market) => market.asset),
                )
              ) {
                return { report: null };
              }
              const report = yield* tradingValidations.report({
                id: input.validationId,
                now,
              });
              return { report };
            }).pipe(
              Effect.tapError((cause) =>
                Effect.logError("trading validation report read failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to read the validation report",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.listTradingIdeas]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listTradingIdeas,
            Effect.gen(function* () {
              const now = DateTime.toEpochMillis(yield* DateTime.now);
              // Ended runs are read too, because a hypothesis in `testing`
              // whose runs have all finished is described by its newest one.
              // The selection below is what keeps that from meaning a report
              // per validation that ever existed.
              const validations = yield* tradingValidations.list({ includeEnded: true });
              const hypotheses = yield* tradingHypotheses.list({});
              const candidates = selectIdeaCandidates({
                validations: validations.map((validation) => ({
                  id: validation.id,
                  threadId: validation.threadId,
                  asset: validation.asset,
                  interval: validation.interval,
                  label: validation.label,
                  headline: describeThesis(validation.thesis),
                  status: validation.status,
                  armedAt: validation.armedAt,
                  hypothesisId: validation.hypothesisId,
                })),
                hypotheses,
                cap: TRADING_IDEA_ROW_CAP,
              });
              // One ledger read per SERVED row. The cap is the bound on this
              // loop, which is why the selection happens before the reports
              // rather than after them.
              const ideas: Array<TradingIdeaRow> = [];
              for (const candidate of candidates) {
                const report = yield* tradingValidations.report({
                  id: candidate.reportValidationId,
                  now,
                });
                ideas.push(toIdeaRow(candidate, report));
              }
              return { ideas };
            }).pipe(
              Effect.tapError((cause) => Effect.logError("trading ideas read failed", { cause })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to list the ideas in testing",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.addTradingWatchlistEntry]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.addTradingWatchlistEntry,
            tradingWatchlistService.add(input.market).pipe(
              Effect.map(toWireWatchlistResult),
              Effect.tapError((cause) =>
                Effect.logError("trading watchlist add failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to add the watchlist entry",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.removeTradingWatchlistEntry]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.removeTradingWatchlistEntry,
            tradingWatchlistService.remove(input.market).pipe(
              Effect.map(toWireWatchlistResult),
              Effect.tapError((cause) =>
                Effect.logError("trading watchlist remove failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to remove the watchlist entry",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.listTradingWatchlist]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.listTradingWatchlist,
            tradingWatchlistService.list.pipe(
              Effect.map((entries) => ({ entries: entries.map(toWireWatchlistEntry) })),
              Effect.tapError((cause) =>
                Effect.logError("trading watchlist list failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to list the watchlist",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.previewTradingOrder]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.previewTradingOrder,
            tradingManualEntry
              .prepare({
                accountId: input.accountId ?? LOCAL_TRADING_ACCOUNT_ID,
                market: input.market,
                side: input.side,
                stopPrice: input.stopPrice,
                sizeEth: input.sizeEth,
                notionalUsd: input.notionalUsd,
                urgency: input.urgency,
              })
              .pipe(
                Effect.map((preparation) =>
                  preparation.outcome === "refused"
                    ? {
                        outcome: "refused" as const,
                        reason: preparation.reason,
                        detail: preparation.detail,
                        ...(preparation.feasibleSize === undefined
                          ? {}
                          : { feasibleSize: preparation.feasibleSize }),
                      }
                    : {
                        outcome: "prepared" as const,
                        size: preparation.size,
                        feasibleSize: preparation.feasibleSize,
                        notionalUsd: preparation.notionalUsd,
                        limitPrice: preparation.intent.limitPrice,
                        plannedLossAtStopUsd: preparation.plannedLossAtStopUsd,
                        estimatedRoundTripCostUsd: preparation.estimatedRoundTripCostUsd,
                        constrainedBy: preparation.constrainedBy,
                        notes: preparation.notes,
                      },
                ),
                Effect.tapError((cause) =>
                  Effect.logError("trading manual preview failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to preview the manual order",
                      cause,
                    }),
                ),
              ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.closeTradingManualPosition]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.closeTradingManualPosition,
            Effect.gen(function* () {
              const accountId = input.accountId ?? LOCAL_TRADING_ACCOUNT_ID;
              const masterAddress = yield* tradingMissionService.getMasterWalletAddress(accountId);
              const outcome = yield* tradingControls.closeManualPosition({
                accountId,
                masterAddress,
                market: input.market.asset,
                percent: input.percent,
              });
              // Converge the manual rows and ring the doorbell before the
              // panel's refetch, so what closed is what renders.
              yield* reconcileManualExposure({
                accountId,
                masterAddress,
                market: input.market.asset,
              }).pipe(Effect.catch(() => Effect.void));
              return outcome.outcome === "refused"
                ? { outcome: "refused" as const, reason: outcome.reason, detail: outcome.detail }
                : {
                    outcome: "done" as const,
                    positionSize: outcome.positionSize,
                    summary: outcome.summary,
                  };
            }).pipe(
              Effect.tapError((cause) => Effect.logError("trading manual close failed", { cause })),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to close the manual position",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTradingResearchScenes]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTradingResearchScenes,
            Effect.gen(function* () {
              // Research mode through and through: scenes are research
              // output, the read needs no signer and no mission, and the only
              // scope worth checking is the thread's own — a scene list never
              // crosses conversations, so neither does this read.
              const scenes = yield* TradingResearchSceneService;
              const eventService = yield* TradingEventService;
              const rows = yield* scenes.list(input.threadId).pipe(Effect.orDie);
              // The same composition the publish and show tool results carry:
              // the graph polls this path after a reload, and a scene served
              // here without its deterministic layers would silently downgrade
              // the calendar view to anonymous bands (or nothing at all).
              const decorated = yield* composeSceneViews({
                views: [...rows],
                showEventSet: (eventSetId) => eventService.show(eventSetId).pipe(Effect.orDie),
              });
              return { scenes: [...decorated] };
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTradingMarketChart]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTradingMarketChart,
            Effect.gen(function* () {
              // See `chartReadEntitlement`: a mission on the market entitles a
              // read (running for live, any for windowed), and so does the
              // market being followed — watchlist, positions, armed watches,
              // or a recent chart open (final-form phase 6).
              const missions = yield* tradingMissionProjection.list();
              const followed = yield* followSetRegistry.list;
              if (
                !isChartReadEntitled(
                  input,
                  missions,
                  followed.map((market) => market.asset),
                )
              ) {
                return yield* Effect.fail(
                  new OrchestrationGetSnapshotError({
                    message: `Market ${input.market} is neither followed nor held by a mission`,
                  }),
                );
              }
              // Opening a chart is attention: it starts (or extends) recording
              // for that market, so the next question about it has data. This
              // runs for every entitled read — missionless ones included.
              yield* followSetRegistry.noteChartOpened(marketRef(input.market));
              // The client may ask for a wider window; the server owns the cap.
              // The cap must clear a study-derived window: a scene recipe may
              // declare up to EVENT_STUDY_MAX_HORIZON_BARS plus context bars,
              // and a clamp below that silently truncates the window's OLDEST
              // bars — which are the entry the study measured from.
              const maxBars = Math.min(input.maxBars ?? 120, STUDY_CHART_MAX_WINDOW_BARS);
              const chart = yield* tradingMarketChart.read({
                market: input.market,
                interval: input.interval,
                maxBars,
                ...(input.range !== undefined ? { range: input.range } : {}),
                ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
                ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
              });
              if (chart === null) {
                return yield* Effect.fail(
                  new OrchestrationGetSnapshotError({
                    message: `Failed to read market chart for ${input.market}`,
                  }),
                );
              }
              return chart;
            }).pipe(
              // A poll tick that could not be served is a warning, not an
              // error: the chart service now serves its last good view through
              // a transient exchange failure, so reaching here means either an
              // unentitled read or a market that has been unreadable for
              // minutes. The client keeps the previous series either way.
              Effect.tapError((cause) =>
                Effect.logWarning("trading market chart load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load the trading market chart",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        // Plan 29 step 8.4: a drag on the chart is a `plan()` revision. It goes
        // through the same `publishPlanWithAftermath` the model's `trading_plan`
        // goes through — the same optimistic lock, the same exchange reconcile,
        // the same withdrawal of a resting entry — because a revision that only
        // wrote the row would move the stop on screen and not on Hyperliquid.
        [ORCHESTRATION_WS_METHODS.reviseTradingPlan]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.reviseTradingPlan,
            Effect.gen(function* () {
              const missions = yield* TradingMissionService;
              const journal = yield* TradingJournalService;
              const mission = yield* missions.getMission(input.missionId).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: `No mission ${input.missionId} to revise`,
                      cause,
                    }),
                ),
              );
              const previousPlan = mission.strategy ?? null;
              const outcome = yield* publishPlanWithAftermath({
                threadId: mission.harness.threadId,
                mission,
                publish: {
                  missionId: input.missionId,
                  expectedMissionVersion: input.expectedMissionVersion,
                  strategy: input.strategy,
                },
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "The plan revision could not be published",
                      cause,
                    }),
                ),
              );
              const published = outcome.published;
              if (published.outcome !== "accepted") {
                return {
                  outcome: "rejected" as const,
                  reason: published.reason,
                  currentVersion: published.currentVersion,
                  ...(published.detail === undefined ? {} : { detail: published.detail }),
                };
              }

              // The operator dragged and said nothing, so the server says what
              // moved. `author: "user"` is what stops this reading, on the
              // model's next wake, as a decision the model made itself.
              const note = composePlanRevisionNote(previousPlan, published.strategy);
              if (note !== null) {
                yield* journal
                  .append({ missionId: input.missionId, note, author: "user" })
                  // The plan is already durable and the exchange already moved;
                  // a journal write that failed costs the model a sentence.
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("could not journal an operator's plan revision", {
                        missionId: input.missionId,
                        cause,
                      }),
                    ),
                  );
              }

              const reconciled = outcome.reconciled;
              return {
                outcome: "accepted" as const,
                strategy: published.strategy,
                warnings: outcome.warnings,
                stop:
                  reconciled === null
                    ? null
                    : {
                        status: reconciled.stopStatus,
                        planStopPrice: reconciled.stopPrice,
                        restingStopPrice: reconciled.restingStopPrice ?? null,
                        ...(reconciled.refusal === undefined
                          ? {}
                          : { refusal: reconciled.refusal }),
                      },
                // The take-profit sweep's outcome, when the leg ran: since the
                // target became a wake this only ever reports what leftover
                // resting orders were withdrawn.
                target:
                  reconciled === null || reconciled.target === null
                    ? null
                    : {
                        status: reconciled.target.status,
                        ...(reconciled.target.detail === undefined
                          ? {}
                          : { detail: reconciled.target.detail }),
                      },
              };
            }).pipe(
              Effect.tapError((cause) =>
                Effect.logError("trading plan revision failed", { cause }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === input.threadId &&
                isThreadDetailEvent(event);

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(isThisThreadDetailEvent),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event,
                })),
              );

              // Attach live delivery before reading either replay or snapshot state.
              // Otherwise an event published while the snapshot is loading is lost.
              const liveBuffer = yield* makeThreadLiveEventCoalescer();
              yield* Effect.forkScoped(
                liveStream.pipe(
                  Stream.runForEachArray(liveBuffer.offerAll),
                  Effect.raceFirst(liveBuffer.failed),
                  Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
                ),
                { startImmediately: true },
              );
              const bufferedLiveStream = liveBuffer.stream;
              let replayOnMissingSnapshot: typeof bufferedLiveStream | undefined;

              // When the client already loaded the snapshot over HTTP it passes
              // that snapshot's sequence, and we resume the live subscription by
              // replaying persisted events after it instead of re-sending the
              // (potentially multi-KB) snapshot frame over the socket.
              //
              // The live PubSub subscription must be attached *before* draining
              // the catch-up replay, otherwise events published during the replay
              // window are dropped (they are past the persisted tail the replay
              // read, but the live stream is not yet subscribed). So fork the
              // live stream into a buffer bound to this stream's scope, then emit
              // catch-up followed by the buffered/ongoing live events. Overlapping
              // events are deduped by sequence on the client.
              //
              // Measure only this thread's rows. Global sequence gaps can
              // contain unrelated or pruned streams. Keep an explicit upper
              // bound so events after the captured head stay in the live tail.
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const range = {
                  threadId: input.threadId,
                  fromSequenceExclusive: afterSequence,
                  toSequenceInclusive: headSequence,
                };
                const replayStats =
                  afterSequence > headSequence
                    ? null
                    : yield* orchestrationEngine
                        .getThreadReplayStats({
                          ...range,
                          maxEvents: THREAD_RESUME_MAX_EVENTS,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new OrchestrationGetSnapshotError({
                                message: `Failed to measure thread ${input.threadId} replay range`,
                                cause,
                              }),
                          ),
                        );
                if (
                  replayStats !== null &&
                  replayStats.eventCount <= THREAD_RESUME_MAX_EVENTS &&
                  replayStats.payloadBytes <= ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES
                ) {
                  const catchUpStream = orchestrationEngine
                    .readThreadEvents({ ...range, limit: THREAD_RESUME_MAX_EVENTS })
                    .pipe(
                      Stream.filter(isThisThreadDetailEvent),
                      Stream.map((event) => ({
                        kind: "event" as const,
                        event: projectActivityEvent(event),
                      })),
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to replay thread ${input.threadId} events`,
                            cause,
                          }),
                      ),
                    );
                  const afterCatchUp =
                    input.requestCompletionMarker === true
                      ? Stream.unwrap(
                          liveBuffer
                            .offer({ kind: "synchronized" as const })
                            .pipe(Effect.as(bufferedLiveStream)),
                        )
                      : bufferedLiveStream;
                  const replay = Stream.concat(catchUpStream, afterCatchUp);
                  if (!replayStats.hasCreateEvent) {
                    return replay;
                  }
                  replayOnMissingSnapshot = replay;
                }
                // A recreated thread needs a fresh snapshot if it still exists.
                // Oversized replays and invalid cursors also use the snapshot path.
              }

              const snapshot = yield* projectionSnapshotQuery
                .getThreadDetailSnapshot(
                  input.threadId,
                  // Windowing the fallback snapshot is opt-in per subscription:
                  // clients that don't send turnLimit (including all
                  // pre-pagination clients) get the full thread, since they
                  // have no way to load older pages.
                  input.turnLimit === undefined ? undefined : { turnLimit: input.turnLimit },
                )
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                );

              if (Option.isNone(snapshot)) {
                // The recreated thread can already be deleted. Preserve the
                // bounded replay and shell removal instead of retrying a
                // snapshot that cannot exist. Oversized ranges still fail.
                if (replayOnMissingSnapshot !== undefined) {
                  return replayOnMissingSnapshot;
                }
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              const afterSnapshot =
                input.requestCompletionMarker === true
                  ? Stream.unwrap(
                      liveBuffer
                        .offer({ kind: "synchronized" as const })
                        .pipe(Effect.as(bufferedLiveStream)),
                    )
                  : bufferedLiveStream;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: projectThreadDetailSnapshot(snapshot.value),
                }),
                afterSnapshot,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetConfig,
            loadServerConfig({ usageLimitsCommand: false }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            Effect.gen(function* () {
              // An untargeted refresh is "re-read everything's status", which
              // includes quota from configured usage-limit sources. Awaited,
              // not forked: the RPC scope closes on return and would
              // interrupt a fork before the hub answered.
              if (input.instanceId === undefined) {
                yield* usageLimitSources.refresh;
              }
              let providers = yield* input.cwd !== undefined && input.instanceId !== undefined
                ? providerRegistry.refreshWorkspaceSnapshot({
                    instanceId: input.instanceId,
                    cwd: input.cwd,
                  })
                : input.instanceId !== undefined
                  ? providerRegistry.refreshInstance(input.instanceId)
                  : providerRegistry.refresh();
              if (input.refreshModels) {
                const instances = yield* providerInstances.listInstances;
                for (const instance of instances) {
                  if (
                    !instance.refreshModels ||
                    (input.instanceId !== undefined && input.instanceId !== instance.instanceId) ||
                    !providers.some(
                      (provider) =>
                        provider.instanceId === instance.instanceId &&
                        provider.enabled &&
                        provider.installed,
                    )
                  )
                    continue;
                  yield* instance.refreshModels().pipe(
                    Effect.mapError(
                      (error) =>
                        new ProviderSetupError({
                          instanceId: instance.instanceId,
                          operation: "refresh-models",
                          detail: error.detail,
                        }),
                    ),
                  );
                  providers = yield* providerRegistry.refreshInstance(instance.instanceId);
                }
              }
              return { providers };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.providerUploadFeedback]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerUploadFeedback,
            providerService.uploadFeedback(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderUploadFeedbackError({
                    threadId: input.threadId,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.providerConsumeResetCredit]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerConsumeResetCredit,
            Effect.gen(function* () {
              if ("sourceId" in input) return yield* usageLimitSources.consumeResetCredit(input);
              const instance = yield* providerInstances.getInstance(input.instanceId);
              // A disabled instance must not spend anything on its account.
              if (instance === undefined || !instance.enabled) {
                return yield* new ProviderSetupError({
                  instanceId: input.instanceId,
                  operation: "consume-reset-credit",
                  detail: instance ? "This provider is disabled." : "Provider instance not found.",
                });
              }
              if (instance.consumeResetCredit === undefined) {
                return yield* new ProviderSetupError({
                  instanceId: input.instanceId,
                  operation: "consume-reset-credit",
                  detail: "This provider does not bank reset credits.",
                });
              }
              const outcome = yield* instance.consumeResetCredit().pipe(
                Effect.mapError(
                  (error) =>
                    new ProviderSetupError({
                      instanceId: input.instanceId,
                      operation: "consume-reset-credit",
                      detail: error.detail,
                      cause: error,
                    }),
                ),
              );
              return { outcome };
            }),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthStart]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthStart,
            providerAuth.start(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthComplete]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthComplete,
            providerAuth.complete(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthCancel,
            providerAuth.cancel(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthLogout]: (input) =>
          observeRpcEffect(WS_METHODS.providerAuthLogout, providerAuth.logout(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerAuthSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.providerAuthSubscribe,
            providerAuth.subscribe(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerInstallStart]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallStart, providerInstallation.start(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerInstallCancel]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallCancel, providerInstallation.cancel(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerInstallSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.providerInstallSubscribe,
            providerInstallation.subscribe(input),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerInstallRemove]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallRemove, providerInstallation.remove(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.serverUpdateServer]: (input) =>
          observeRpcEffect(WS_METHODS.serverUpdateServer, serverUpdate.update(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
          observeRpcStream(
            WS_METHODS.serverUpdateServerWithProgress,
            Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) =>
              serverUpdate
                .update(input, (stage) =>
                  Queue.offer(queue, {
                    type: "progress",
                    stage,
                  }).pipe(Effect.asVoid),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Queue.offer(queue, {
                      type: "complete",
                      result,
                    }),
                  ),
                  Effect.catchTags({
                    ServerSelfUpdateError: (error) => Queue.fail(queue, error),
                  }),
                  Effect.andThen(Queue.end(queue)),
                  Effect.forkScoped,
                ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCommitDesktopUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCommitDesktopUpdate,
            serverUpdate.commitDesktopUpdate(input.requestId),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings
              .updateSettings(patch)
              .pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetHostResources]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetHostResources, hostResources.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetResourceTelemetryHistory,
            resourceTelemetry.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetUsageSummary]: (input) =>
          observeRpcEffect(WS_METHODS.serverGetUsageSummary, usage.readSummary(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshUsageRates]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRefreshUsageRates, usage.refreshRates, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRetryResourceTelemetry]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRetryResourceTelemetry, resourceTelemetry.retry, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              observeRpcEffect(
                WS_METHODS.serverReportClientActivity,
                backgroundPolicy.reportClientActivity(
                  currentSessionId,
                  RpcClientId.make(metadata.client.id),
                  input,
                ),
                { "rpc.aggregate": "server" },
              ),
            ),
          ),
        [WS_METHODS.serverReportHostPowerState]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReportHostPowerState,
            backgroundPolicy.reportHostPowerState(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetBackgroundPolicy]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetBackgroundPolicy, backgroundPolicy.snapshot, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) =>
          observeRpcEffect(WS_METHODS.cloudGetRelayClientStatus, relayClient.resolve, {
            "rpc.aggregate": "cloud",
          }),
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          observeRpcStream(
            WS_METHODS.cloudInstallRelayClient,
            Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>(
              (queue) =>
                relayClient
                  .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
                  .pipe(
                    Effect.flatMap((status) =>
                      Queue.offer(queue, {
                        type: "complete",
                        status,
                      }),
                    ),
                    Effect.catchTag("RelayClientInstallError", (error) =>
                      Queue.fail(
                        queue,
                        new RelayClientInstallFailedError({
                          reason: error.reason,
                          message: error.message,
                        }),
                      ),
                    ),
                    Effect.andThen(Queue.end(queue)),
                    Effect.forkScoped,
                  ),
            ),
            { "rpc.aggregate": "cloud" },
          ),
        [WS_METHODS.pullRequestsList]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsList, pullRequests.list(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsListStats]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsListStats, pullRequests.listStats(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsSummary]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSummary, pullRequests.summary(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsDetail, pullRequests.detail(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsActivity]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsActivity, pullRequests.activity(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsThreadComments]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsThreadComments,
            pullRequests.threadComments(input),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsDiffFileContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsDiffFileContents,
            pullRequests.diffFileContents(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRunAction]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsRunAction, pullRequests.runAction(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsUpdate]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsUpdate, pullRequests.update(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsComment]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsComment, pullRequests.comment(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsUpdateComment]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsUpdateComment,
            pullRequests.updateComment(input),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsSubmitReview]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSubmitReview, pullRequests.submitReview(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsReplyToThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReplyToThread,
            pullRequests.replyToThread(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetThreadResolution,
            pullRequests.setThreadResolution(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetReaction]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSetReaction, pullRequests.setReaction(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsInvalidate]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsInvalidate, pullRequests.invalidate(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () =>
          observeRpcStream(
            WS_METHODS.pullRequestsSubscribeRefreshes,
            pullRequests.subscribeRefreshes,
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReviewerCandidates,
            pullRequests.reviewerCandidates(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRequestReviewers,
            pullRequests.requestReviewers(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsLabelCandidates]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsLabelCandidates,
            pullRequests.labelCandidates(input),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetLabels]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsSetLabels, pullRequests.setLabels(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsSearchContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchContents,
            workspaceEntries.searchContents(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchContentsError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
            workspaceEntries.list(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListEntriesError({
                    ...input,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            workspaceFileSystem.readFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectReadFileError({
                    ...input,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectWriteFileError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    ...input,
                    ...filesystemBrowseFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.attachmentsCreateUploadUrl]: (input) =>
          observeRpcEffect(WS_METHODS.attachmentsCreateUploadUrl, issueAttachmentUploadUrl(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.attachmentsDelete]: (input) =>
          observeRpcEffect(
            WS_METHODS.attachmentsDelete,
            deletePendingAttachment(input.attachmentId),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.agentSessionsScan]: () =>
          observeRpcEffect(WS_METHODS.agentSessionsScan, agentSessionScanner.scan, {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.agentSessionsImport]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentSessionsImport,
            importRecentAgentThreads(input).pipe(
              Effect.provideService(AgentSessionScanner.AgentSessionScanner, agentSessionScanner),
              Effect.provideService(
                OrchestrationEngine.OrchestrationEngineService,
                orchestrationEngine,
              ),
              Effect.provideService(
                ProjectionSnapshotQuery.ProjectionSnapshotQuery,
                projectionSnapshotQuery,
              ),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(
                ProviderSessionDirectory.ProviderSessionDirectory,
                providerSessionDirectory,
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.assetsCreateUrl]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsCreateUrl,
            Effect.gen(function* () {
              if (
                input.resource._tag === "attachment" ||
                input.resource._tag === "native-app-icon"
              ) {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              if (input.resource._tag === "project-favicon") {
                const project = yield* projectionSnapshotQuery
                  .getActiveProjectByWorkspaceRoot(input.resource.cwd)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new AssetWorkspaceContextResolutionError({
                          resource: input.resource,
                          cause,
                        }),
                    ),
                  );
                if (Option.isNone(project)) {
                  return yield* new AssetWorkspaceContextNotFoundError({
                    resource: input.resource,
                  });
                }
                return yield* issueAssetUrl({
                  resource: input.resource,
                  ...(project.value.faviconPath
                    ? { projectFaviconPath: project.value.faviconPath }
                    : {}),
                });
              }
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.resource.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(thread)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
              });
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input, {
              automaticRemoteRefreshInterval: automaticGitFetchInterval,
            }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.reviewGetDiffFileContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.reviewGetDiffFileContents,
            review.getDiffFileContents(input),
            { "rpc.aggregate": "review" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalAttach]: (input) =>
          observeRpcStream(
            WS_METHODS.terminalAttach,
            Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
              Effect.acquireRelease(
                terminalManager.attachStream(input, (event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            Stream.callback<TerminalMetadataStreamEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.previewOpen]: (input) =>
          observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewNavigate]: (input) =>
          observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewResize]: (input) =>
          observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewRefresh]: (input) =>
          observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewClose]: (input) =>
          observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewList]: (input) =>
          observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewReportStatus]: (input) =>
          observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnect,
            previewAutomationBroker.connect(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationRespond,
            previewAutomationBroker.respond(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationFocusHost]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationFocusHost,
            previewAutomationBroker.focusHost(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.subscribePreviewEvents]: (_input) =>
          observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
            Stream.callback<DiscoveredLocalServerList>((queue) =>
              Effect.gen(function* () {
                const configuredUrls = input.configuredUrls ?? [];
                yield* portDiscovery.retain;
                const initial = yield* portDiscovery.scan(configuredUrls);
                const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
                yield* Queue.offer(queue, {
                  servers: initial,
                  scannedAt: initialScannedAt,
                  configuredUrlProbing: true,
                });
                yield* portDiscovery.subscribe(
                  { configuredUrls, initialSnapshot: initial },
                  (servers) =>
                    Effect.gen(function* () {
                      const scannedAt = DateTime.formatIso(yield* DateTime.now);
                      yield* Queue.offer(queue, {
                        servers,
                        scannedAt,
                        configuredUrlProbing: true,
                      });
                    }),
                );
              }),
            ),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.subscribeServerConfig]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const usageLimitsCommand = input.usageLimitsCommand === true;
              const config = yield* loadServerConfig({ usageLimitsCommand });
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = Stream.zipLatestWith(
                // The registry stream carries changes only. Seed it with the current
                // providers so a source refresh that lands before any provider change
                // still pairs up and reaches the client.
                Stream.concat(
                  Stream.fromEffect(providerRegistry.getProviders),
                  providerRegistry.streamChanges,
                ),
                usageLimitSources.streamChanges.pipe(
                  // Quota updates already have their own stream. Republish the model
                  // catalog only when the set of providers offered the command changes.
                  Stream.changesWith(
                    usageLimitsCommand ? sameUsageLimitCommandCoverage : () => true,
                  ),
                ),
                (providers, sources) =>
                  usageLimitsCommand ? withUsageLimitsCommands(providers, sources) : providers,
              ).pipe(
                // Both sides replay their current value, so the first pairing normally
                // repeats the snapshot the client already holds. Compare against that
                // snapshot rather than dropping blindly: a refresh that landed between
                // the snapshot and the subscription still goes out.
                (updates) => Stream.concat(Stream.make(config.providers), updates),
                Stream.changesWith(
                  (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
                ),
                Stream.drop(1),
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              // The only source of published themes: the stream emits the
              // current set before any change, so the snapshot carrying it too
              // would just send every client the same array twice per connect.
              // Gated on the subscriber's capability flag because an
              // already-shipped client decodes this stream against the old
              // event union and its whole config subscription dies on an
              // unknown member.
              const environmentThemeUpdates =
                input.environmentThemes === true
                  ? environmentTheme.streamChanges.pipe(
                      Stream.map((themes) => ({
                        version: 1 as const,
                        type: "environmentThemesUpdated" as const,
                        payload: { themes },
                      })),
                    )
                  : Stream.empty;
              // Same gate as themes: an older client dies on an unknown event.
              const usageLimitSourceUpdates =
                input.usageLimitSources === true
                  ? usageLimitSources.streamChanges.pipe(
                      Stream.map((sources) => ({
                        version: 1 as const,
                        type: "usageLimitSourcesUpdated" as const,
                        payload: { sources },
                      })),
                    )
                  : Stream.empty;
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(
                  providerStatuses,
                  Stream.merge(
                    settingsUpdates,
                    Stream.merge(environmentThemeUpdates, usageLimitSourceUpdates),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({ version: 1 as const, type: "snapshot" as const, config }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const liveBuffer = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
              yield* Effect.forkScoped(
                lifecycleEvents.stream.pipe(
                  Stream.runForEach((event) => Queue.offer(liveBuffer, event)),
                ),
                { startImmediately: true },
              );
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = Stream.fromQueue(liveBuffer).pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeBackgroundPolicy]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeBackgroundPolicy,
            Stream.unwrap(
              Effect.map(backgroundPolicy.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeResourceTelemetry,
            Stream.unwrap(
              Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const baseServerSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const config = yield* ServerConfig.ServerConfig;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const serverSelfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
      mode: config.mode,
      selfUpdate: baseServerSelfUpdate,
      prepare: startup.markRunningProviderSessionsForContinuation.pipe(
        Effect.mapError(
          (cause) =>
            new ServerSelfUpdateError({
              reason: "Could not prepare running threads to continue after the update.",
              cause,
            }),
        ),
      ),
      clear: (threadIds) =>
        startup.clearProviderSessionContinuationMarkers(threadIds).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSelfUpdateError({
                reason: "Could not clear thread continuation markers after the update failed.",
                cause,
              }),
          ),
        ),
    });
    const pullRequests = yield* PullRequestService.PullRequestService;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const analytics = yield* AnalyticsService.AnalyticsService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const clientOrigin = readClientConnectionOrigin(request);
        const clientAnalyticsProps = readClientAnalyticsProps(request);
        yield* sessions.recordClientConnection(session.sessionId, clientOrigin);
        yield* analytics.record("client.connected", clientAnalyticsProps);
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(
              session,
              clientOrigin,
              clientAnalyticsProps,
              previewAutomationBroker,
            ).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(AgentSessionScanner.layer),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
              // One server-lifetime service means clients share the same PR caches, and a WS
              // mutation invalidates the HTTP diff cache that every client reads from.
              Layer.provide(Layer.succeed(PullRequestService.PullRequestService, pullRequests)),
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
