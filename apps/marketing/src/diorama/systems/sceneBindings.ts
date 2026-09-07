/**
 * Scene bindings: the ONLY semantic consumer of the diorama event bus. Each
 * frozen DioramaEvent translates into station API calls (freeze §2), rail
 * packet sends (freeze §4 routes), simulation state mirrors, and HUD updates
 * per the freeze §3 binding matrix as amended by addendum §C (binding matrix
 * v2: every trunk route activated; protection.setState only from canonical
 * account state). Stories and the director never call station APIs or rail
 * sends directly; this module is the single place where events become scene
 * behavior. Owner: bus lane.
 *
 * Station handles arrive and leave as builders register, so every lookup goes
 * through stationApi() and every call is optional-chained: events dispatched
 * before a station registers are simply not rendered there.
 */
import type { RouteId } from "../config/rails.js";
import type { StationId } from "../config/stations.js";
import { stationApi } from "../core/registry.js";
import type { Hud } from "../ui/hud.js";
import type {
  BlockedReason,
  DioramaEvent,
  DioramaEventBus,
  ExecutionRejectionReason,
  ExecutionStatus,
  MissionControl,
  MissionStatus,
  ProtectionState,
  ReductionPercent,
  RiskControl,
  ToolHealth,
} from "./eventBus.js";
import type { RailSystem } from "./rails.js";
import { MCP_PORT_COUNT } from "./simulation.js";
import type { Simulation } from "./simulation.js";

// --- Station API surfaces (freeze §2 names, matrix-scoped methods only) ----

interface MarketDataApi {
  setMissionMarket(asset: string | null): void;
}

interface MissionBoardApi {
  setPhase(phase: string): void;
  setStatus(status: MissionStatus, blockedReason?: BlockedReason): void;
  setMaxLoss(usedPct: number): void;
  setWatchCount(n: number): void;
}

interface DecisionTableApi {
  setTicket(state: "editing" | "preview" | "refused" | "sent", refusal?: string): void;
}

interface McpHubApi {
  setPortHealth(port: number, health: ToolHealth): void;
  portCall(port: number): void;
}

interface TradingFloorApi {
  setCampusPaused(paused: boolean): void;
}

interface HoloCoreApi {
  orderLaunched(): void;
  fillLanded(): void;
  setOverlays(overlays: { entry?: number; stop?: number; liq?: number } | null): void;
  setRegime(regime: string): void;
}

interface SignalTowerApi {
  pulse(kind: "market" | "alert" | "wake" | "warning" | "execution"): void;
  setWatch(state: "armed" | "fired" | "cancelled"): void;
}

interface HyperliquidVenueApi {
  exchangeEvent(kind: "order" | "ack" | "fill" | "state"): void;
}

type EmergencyControl =
  | "pause"
  | "resume"
  | "revoke"
  | "cancel_entries"
  | "reduce"
  | "close"
  | "close_and_revoke";

interface EmergencyPanelApi {
  runControl(control: EmergencyControl, reductionPercent?: ReductionPercent): void;
}

interface RiskFortressApi {
  runScan(pass: boolean, reason?: string): void;
}

interface ProtectionApi {
  shieldUp(): void;
  setState(state: "stop_on_exchange" | "server_executed" | "unprotected"): void;
}

interface SignerVaultApi {
  signPulse(): void;
}

interface ExecutionGatewayApi {
  setState(state: ExecutionStatus): void;
}

/** Budget units pinned (addendum §B.7): consume takes percentage POINTS
 * (0..100 scale); setRemaining takes a 0..1 fraction. No rollover. */
interface BudgetMeterApi {
  consume(points: number): void;
  setRemaining(fraction: number): void;
}

interface ReconciliationDockApi {
  phase(phase: "doorbell" | "refetching" | "aligned" | "drift", reason?: string): void;
}

interface PortfolioVaultApi {
  pulse(block: "capital" | "realized" | "unrealized" | "balance"): void;
  setProtection(label: "Stop on exchange" | "Server-executed" | "Unprotected"): void;
  /** Addendum §B.5: initial state is EMPTY; populated only via refetch. */
  setPopulated(has: boolean): void;
}

interface AuditArchiveApi {
  glowPulse(): void;
  appendRow(kind: string): void;
  /** Addendum §B.6: "Archiver healthy" / "Archiver degraded" health line. */
  setArchiveHealth(healthy: boolean): void;
}

// --- Matrix lookup tables ---------------------------------------------------

/** Breadcrumb step per status; statuses without an entry keep the last step. */
type BreadcrumbStep = "Analyse" | "Wait" | "Execute" | "Position";

const BREADCRUMB_BY_STATUS: Partial<Record<MissionStatus, BreadcrumbStep>> = {
  Initializing: "Analyse",
  Analysing: "Analyse",
  Waiting: "Wait",
  Executing: "Execute",
  "Position open": "Position",
};

const LABEL_BY_PROTECTION: Record<
  ProtectionState,
  "Stop on exchange" | "Server-executed" | "Unprotected"
> = {
  resting_on_exchange: "Stop on exchange",
  server_executed: "Server-executed",
  unprotected: "Unprotected",
};

const PANEL_CONTROL_BY_MISSION_CONTROL: Record<MissionControl, EmergencyControl> = {
  "trading.mission.pause": "pause",
  "trading.mission.resume": "resume",
  "trading.mission.revoke": "revoke",
};

const PANEL_CONTROL_BY_RISK_CONTROL: Record<RiskControl, EmergencyControl> = {
  cancel_entries: "cancel_entries",
  reduce_position: "reduce",
  close_position: "close",
  close_and_revoke: "close_and_revoke",
};

/**
 * Product-true refusal sentences for the documented rejection reasons
 * (addendum §A.4); TRADE renders the sentence verbatim on the refused ticket.
 */
const REJECTION_SENTENCE: Record<ExecutionRejectionReason, string> = {
  cumulative_loss_limit: "Refused: cumulative loss limit",
  protection_failure: "Refused: protection failure",
  wake_budget_exhausted: "Refused: wake budget exhausted",
  stop_required: "Refused: stop required",
};

/**
 * Guard reasons also fail the risk scan (addendum §C rejected row). Note
 * "stop_required" is a ticket refusal only — the guards themselves passed.
 */
const GUARD_REASONS: readonly string[] = [
  "cumulative_loss_limit",
  "protection_failure",
  "wake_budget_exhausted",
];

/** Refusal sentence for TRADE; unknown product reasons degrade honestly. */
function refusalSentence(reason: string | undefined): string {
  if (reason === undefined) return "Refused by risk guards";
  const documented = REJECTION_SENTENCE[reason as ExecutionRejectionReason];
  return documented ?? `Refused: ${reason.replace(/_/g, " ")}`;
}

/**
 * Loss-budget percentage points one reserved entry draws down. The frozen
 * event union carries no budget numbers, so the reservation cost is a scene
 * constant mirrored into the simulation and both budget displays.
 */
const RESERVATION_COST_PCT = 4;

/**
 * Chart overlays for the simulated open position. The frozen event union
 * carries no prices, so the binding owns these scene-safe demo values; they
 * apply on refetch and on "Position open" and clear when the position closes
 * (flagged in lane-bus.md).
 */
const DEMO_OVERLAYS: { entry: number; stop: number; liq: number } = {
  entry: 2645.5,
  stop: 2591.0,
  liq: 2280.0,
};

export interface SceneBindingsDeps {
  bus: DioramaEventBus;
  rails: RailSystem;
  hud: Hud;
  simulation: Simulation;
}

export function createSceneBindings(deps: SceneBindingsDeps): { destroy(): void } {
  const { bus, rails, hud, simulation } = deps;

  /** Armed-watch count mirrored to MISSION; fired and cancelled stop counting. */
  let armedWatches = 0;

  function api<T extends object>(id: StationId): T | undefined {
    return stationApi<T>(id);
  }

  function send(route: RouteId): void {
    rails.send(route);
  }

  /** Used/remaining budget read back from the simulation (addendum §C). */
  function mirrorLossBudget(): void {
    const used = simulation.state.lossBudgetUsedPoints;
    api<BudgetMeterApi>("budgetMeter")?.setRemaining(simulation.lossRemainingFraction());
    // MISSION mirrors the used share of the max-loss budget.
    api<MissionBoardApi>("missionBoard")?.setMaxLoss(used);
  }

  /** Status writes shared by create and status-changed events. */
  function applyMissionStatus(status: MissionStatus, blockedReason?: BlockedReason): void {
    api<MissionBoardApi>("missionBoard")?.setStatus(status, blockedReason);
    simulation.setPhase(status);
    hud.setMission(status, blockedReason);
    const step = BREADCRUMB_BY_STATUS[status];
    if (step !== undefined) {
      api<MissionBoardApi>("missionBoard")?.setPhase(step);
      hud.setBreadcrumb(step);
    }
    if (status === "Analysing") {
      // Matrix v2: analysis reads the west market and hands to research.
      send("marketToResearch");
    }
    if (status === "Waiting") {
      send("researchToMission");
    }
    if (status === "Position open") {
      // CHART overlay refresh accompanies the opened position (matrix row 1).
      api<HoloCoreApi>("holoCore")?.setOverlays(DEMO_OVERLAYS);
    }
    if (status === "Revoked" || status === "Completed") {
      // Mission over: the watchlist mission highlight clears.
      api<MarketDataApi>("marketData")?.setMissionMarket(null);
    }
  }

  /**
   * Refusal texture: refused ticket sentence + ALERTS warning pulse + HISTORY
   * row, no westbound packet (addendum §C). Guard reasons additionally fail a
   * risk scan; "stop_required" refuses the ticket only.
   */
  function applyRejection(reason: string | undefined): void {
    api<DecisionTableApi>("decisionTable")?.setTicket("refused", refusalSentence(reason));
    api<SignalTowerApi>("signalTower")?.pulse("warning");
    api<AuditArchiveApi>("auditArchive")?.appendRow("refused");
    if (reason !== undefined && GUARD_REASONS.includes(reason)) {
      api<RiskFortressApi>("riskFortress")?.runScan(false, reason);
    }
  }

  function applyExecutionStatus(status: ExecutionStatus, reason?: string): void {
    switch (status) {
      case "previewed":
        api<DecisionTableApi>("decisionTable")?.setTicket("preview");
        break;
      case "reserved": {
        // One reservation: guards pass, protection PREPARES (visual only —
        // matrix v2 forbids protection.setState here), budget draws 4 points.
        api<RiskFortressApi>("riskFortress")?.runScan(true);
        api<ProtectionApi>("protection")?.shieldUp();
        simulation.consumeLoss(RESERVATION_COST_PCT);
        api<BudgetMeterApi>("budgetMeter")?.consume(RESERVATION_COST_PCT);
        mirrorLossBudget();
        send("ticketToRisk");
        send("riskToProtection");
        break;
      }
      case "signed":
        api<SignerVaultApi>("signerVault")?.signPulse();
        send("protectionToSigner");
        break;
      case "submitted":
        api<ExecutionGatewayApi>("executionGateway")?.setState("submitted");
        api<HoloCoreApi>("holoCore")?.orderLaunched();
        send("signerToExecution");
        send("exchangeOrder");
        api<HyperliquidVenueApi>("hyperliquidVenue")?.exchangeEvent("order");
        break;
      case "accepted":
        api<HyperliquidVenueApi>("hyperliquidVenue")?.exchangeEvent("ack");
        api<ExecutionGatewayApi>("executionGateway")?.setState("accepted");
        break;
      case "filled":
        api<HyperliquidVenueApi>("hyperliquidVenue")?.exchangeEvent("fill");
        api<HoloCoreApi>("holoCore")?.fillLanded();
        api<ExecutionGatewayApi>("executionGateway")?.setState("filled");
        break;
      case "rejected":
        applyRejection(reason);
        break;
      case "cancelled":
      case "failed":
        api<ExecutionGatewayApi>("executionGateway")?.setState(status);
        break;
    }
  }

  function applyLifecycleControl(control: MissionControl): void {
    api<EmergencyPanelApi>("emergencyPanel")?.runControl(PANEL_CONTROL_BY_MISSION_CONTROL[control]);
    if (control === "trading.mission.pause") {
      api<TradingFloorApi>("tradingFloor")?.setCampusPaused(true);
      simulation.setPaused(true);
    }
    if (control === "trading.mission.resume") {
      api<TradingFloorApi>("tradingFloor")?.setCampusPaused(false);
      simulation.setPaused(false);
    }
    api<AuditArchiveApi>("auditArchive")?.appendRow(control);
  }

  function applyRiskControl(
    event: Extract<DioramaEvent, { type: "trading.mission-risk-control-requested" }>,
  ): void {
    // reduce_position requires its percent on the event; other controls have none.
    const reductionPercent =
      event.control === "reduce_position" ? event.reductionPercent : undefined;
    api<EmergencyPanelApi>("emergencyPanel")?.runControl(
      PANEL_CONTROL_BY_RISK_CONTROL[event.control],
      reductionPercent,
    );
    // Risk controls reach exchange state, so ALERTS gets the warning pulse;
    // every control lands a HISTORY row (matrix: HISTORY/ALERTS rows).
    api<SignalTowerApi>("signalTower")?.pulse("warning");
    api<AuditArchiveApi>("auditArchive")?.appendRow(event.control);
    if (event.control === "close_position" || event.control === "close_and_revoke") {
      // Position gone: chart overlays clear so stations stay coherent.
      api<HoloCoreApi>("holoCore")?.setOverlays(null);
    }
  }

  /**
   * Canonical wave (addendum §C): RECONCILE aligned -> POSITIONS (protection,
   * population, pulse) -> CHART -> the exchange-native stop rendered from
   * canonical account state -> the receipt row travelling to HISTORY.
   * This is the ONLY place protection.setState may be called.
   */
  function applyAccountRefetched(
    event: Extract<DioramaEvent, { type: "diorama.account-view-refetched" }>,
  ): void {
    api<ReconciliationDockApi>("reconciliationDock")?.phase("aligned");
    api<PortfolioVaultApi>("portfolioVault")?.setProtection(LABEL_BY_PROTECTION[event.protection]);
    api<PortfolioVaultApi>("portfolioVault")?.setPopulated(event.hasPosition);
    api<PortfolioVaultApi>("portfolioVault")?.pulse(event.hasPosition ? "balance" : "capital");
    api<HoloCoreApi>("holoCore")?.setOverlays(event.hasPosition ? DEMO_OVERLAYS : null);
    // Canonical account state is the only permitted source for this render.
    api<ProtectionApi>("protection")?.setState("stop_on_exchange");
    send("reconciliationToPortfolio");
    send("portfolioToArchive");
    api<AuditArchiveApi>("auditArchive")?.appendRow("fill");
  }

  function applyToolHealth(port: number, health: ToolHealth): void {
    // The hub indexes directly into its fixed port array; out-of-range ports
    // are ignored rather than allowed to throw inside a listener.
    if (!Number.isInteger(port) || port < 0 || port >= MCP_PORT_COUNT) return;
    const hub = api<McpHubApi>("mcpHub");
    hub?.portCall(port);
    hub?.setPortHealth(port, health);
    simulation.setPortHealth(port, health);
    send("floorToMcp");
  }

  function handleEvent(event: DioramaEvent): void {
    // The HUD last-event line tracks every event discriminator (freeze §9).
    hud.setLastEvent(event.type);

    switch (event.type) {
      case "trading.mission-create-requested":
        // Mission create resets the loss budget (used = 0) before the run.
        simulation.resetLossBudget();
        api<BudgetMeterApi>("budgetMeter")?.setRemaining(1);
        api<MissionBoardApi>("missionBoard")?.setMaxLoss(0);
        applyMissionStatus("Initializing");
        if (event.market !== undefined) {
          api<MarketDataApi>("marketData")?.setMissionMarket(event.market);
        }
        send("marketToResearch");
        break;
      case "trading.mission-run-started":
        // The following status-changed event carries the visible transition;
        // run-started itself only marks the HUD last-event line.
        break;
      case "trading.mission-status-changed":
        applyMissionStatus(event.status, event.blockedReason);
        break;
      case "trading.execution-requested":
        api<DecisionTableApi>("decisionTable")?.setTicket("preview");
        send("missionToTicket");
        break;
      case "trading.order-place-requested":
        // Matrix gap (flagged): the ticket's "sent" state is the natural read.
        api<DecisionTableApi>("decisionTable")?.setTicket("sent");
        break;
      case "trading.mission-watch-registered":
        armedWatches += 1;
        api<SignalTowerApi>("signalTower")?.setWatch("armed");
        api<MissionBoardApi>("missionBoard")?.setWatchCount(armedWatches);
        send("watchToAlerts");
        break;
      case "trading.mission-watch-cancelled":
        armedWatches = Math.max(0, armedWatches - 1);
        api<SignalTowerApi>("signalTower")?.setWatch("cancelled");
        api<MissionBoardApi>("missionBoard")?.setWatchCount(armedWatches);
        send("watchToAlerts");
        break;
      case "trading.mission-watch-fired":
        armedWatches = Math.max(0, armedWatches - 1);
        api<SignalTowerApi>("signalTower")?.setWatch("fired");
        api<MissionBoardApi>("missionBoard")?.setWatchCount(armedWatches);
        send("watchToAlerts");
        break;
      case "trading.mission-control-requested":
        applyLifecycleControl(event.control);
        break;
      case "trading.mission-risk-control-requested":
        applyRiskControl(event);
        break;
      case "diorama.execution-status":
        applyExecutionStatus(event.status, event.reason);
        break;
      case "diorama.account-invalidated":
        // Matrix v2: the dock jumps straight to refetching (doorbell is part
        // of that phase's copy), fed by the authoritative state return.
        api<HyperliquidVenueApi>("hyperliquidVenue")?.exchangeEvent("state");
        send("exchangeStateReturn");
        api<ReconciliationDockApi>("reconciliationDock")?.phase("refetching", event.reason);
        break;
      case "diorama.account-view-refetched":
        applyAccountRefetched(event);
        break;
      case "diorama.tool-health-changed":
        applyToolHealth(event.port, event.health);
        break;
      case "diorama.market-regime-changed":
        api<HoloCoreApi>("holoCore")?.setRegime(event.regime);
        break;
      case "diorama.archive-health-changed":
        api<AuditArchiveApi>("auditArchive")?.setArchiveHealth(event.healthy);
        if (!event.healthy) {
          api<AuditArchiveApi>("auditArchive")?.glowPulse();
        }
        break;
    }
  }

  const unsubscribe = bus.subscribe(handleEvent);

  return {
    destroy(): void {
      unsubscribe();
    },
  };
}
