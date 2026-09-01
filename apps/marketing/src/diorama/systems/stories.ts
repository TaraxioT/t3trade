/**
 * The 34 micro-stories: small scripted sequences of agent walks, rail
 * packets, station api calls, and simulation mutations that continuously
 * explain T3 Trade. Owner: director worker.
 *
 * Contract notes relied on here (see artifacts/diorama/workers/director.md):
 * - DecisionTableApi.showProposals(count, -1) means "reject beat": all cards
 *   retract and one dims red. The research district worker must honor -1
 *   instead of clamping it to 0.
 * - Stations without a frozen animation api (marketData, portfolioVault,
 *   auditArchive, approval waiting shimmer, supervisor deck glow) get a
 *   station-agnostic glow pulse on their registered root via GSAP alpha.
 * - Perimeter / Hyperliquid / MarketLandscape apis are reached through the
 *   ground worker's exported holder objects (`perimeter`, `hyperliquid`,
 *   `marketLandscape`), each `{ api: X | null }`, and are null-guarded.
 */
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import type { StationId } from "../config/stations.js";
import { STATIONS } from "../config/stations.js";
import type { PacketKind, RouteId } from "../config/rails.js";
import { ROLE_COLORS } from "../config/palette.js";
import type { Agent, Expression } from "../agents/agent.js";
import type { AgentSystem } from "../agents/system.js";
import type { RailSystem } from "./rails.js";
import type { Simulation } from "./simulation.js";
import { stationApi as registryApi } from "../core/registry.js";
import { getStation } from "../core/registry.js";
import type { PerimeterApi } from "../world/perimeter.js";
import type { HyperliquidApi } from "../world/hyperliquid.js";
import type { MarketLandscapeApi } from "../world/marketLandscape.js";
import * as perimeterModule from "../world/perimeter.js";
import * as hyperliquidModule from "../world/hyperliquid.js";
import * as marketLandscapeModule from "../world/marketLandscape.js";
import type { DecisionTableApi, MissionBoardApi } from "../stations/research.js";
import type {
  ApprovalApi,
  BudgetMeterApi,
  ExecutionGatewayApi,
  ProtectionApi,
  RiskFortressApi,
  SignerVaultApi,
} from "../stations/risk.js";
import type { McpHubApi } from "../stations/mcp.js";
import type {
  ReceiptPrinterApi,
  ReconciliationApi,
  RecoveryApi,
  ReplayChamberApi,
} from "../stations/ops.js";
import type { HoloCoreApi, SignalTowerApi, SupervisorApi } from "../stations/central.js";
import { popMarkAt, scatterCards, rollProp } from "../agents/fx.js";
import { playDioramaCue } from "../audio.js";

export interface StoryDeps {
  ctx: DioramaContext;
  agents: AgentSystem;
  rails: RailSystem;
  simulation: Simulation;
  /** Seeded rng shared with the director; same seed = same show. */
  rng: () => number;
  /** Actors acquired for this run; guaranteed held until the story finishes. */
  cast: Map<string, Agent>;
  /** Content timing (story beats). Resolves immediately once stopped. */
  wait(ms: number): Promise<void>;
  /** Decorative pause. Skipped entirely under reduced motion. */
  beat(ms: number): Promise<void>;
  /** True once the director has been stopped; finish early when set. */
  cancelled(): boolean;
}

export interface Story {
  id: string;
  title: string;
  /** Rough playing time in seconds; scheduler hint only. */
  durationHint: number;
  /** Actor ids that must be acquirable for the story to start. */
  agents: string[];
  /** Stations that must be free; the director marks them busy. */
  stations: StationId[];
  run(deps: StoryDeps): Promise<void>;
}

// ---------------------------------------------------------------------------
// Robustness helpers
// ---------------------------------------------------------------------------

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[diorama/stories] ${message}`);
}

/** Typed station api lookup that logs once when a station is not built yet. */
function storyApi<T extends object>(id: StationId): T | undefined {
  const api = registryApi<T>(id);
  if (!api) warnOnce(`station api not registered: ${id}`);
  return api;
}

/** Ground-worker holder objects may not exist yet; read them defensively. */
function holderApi<T>(mod: object, name: string): T | null {
  const holder = (mod as unknown as Record<string, unknown>)[name] as
    | { api: T | null }
    | undefined;
  if (!holder || !holder.api) {
    warnOnce(`world holder missing or empty: ${name}`);
    return null;
  }
  return holder.api;
}

function perimeter(): PerimeterApi | null {
  return holderApi<PerimeterApi>(perimeterModule, "perimeter");
}

function hyperliquid(): HyperliquidApi | null {
  return holderApi<HyperliquidApi>(hyperliquidModule, "hyperliquid");
}

function marketLandscape(): MarketLandscapeApi | null {
  return holderApi<MarketLandscapeApi>(marketLandscapeModule, "marketLandscape");
}

/**
 * Station-agnostic glow pulse for stations without a frozen animation api.
 * Tweens the registered root's alpha; cleanup is registered with the world.
 * Exported: the director's district heartbeats reuse it.
 */
export function glowPulse(ctx: DioramaContext, id: StationId, dip = 0.5, seconds = 0.9): void {
  const station = getStation(id);
  if (!station) {
    warnOnce(`station not registered: ${id}`);
    return;
  }
  const tween = gsap.to(station.root, {
    alpha: dip,
    duration: seconds / 2,
    yoyo: true,
    repeat: 1,
    ease: "sine.inOut",
  });
  ctx.onCleanup(() => tween.kill());
}

/** Walk, or snap into place under reduced motion. No-ops once the director
 * is stopped: story continuations can resume after teardown (pending walks
 * resolve during cleanup) and must not touch destroyed objects. */
async function move(deps: StoryDeps, agentId: string, points: { x: number; y: number }[]): Promise<void> {
  if (deps.cancelled()) return;
  const agent = deps.cast.get(agentId);
  if (!agent) {
    warnOnce(`agent missing from cast: ${agentId}`);
    return;
  }
  if (points.length === 0) return;
  await deps.agents.walk(agent, points, deps.ctx.reducedMotion ? { speed: 100000 } : { ease: "arrive" });
}

/** Dispatch a packet and wait for arrival. Every packet chirps (foley cooldown
 * inside the audio layer keeps bursts from machine-gunning). */
async function send(
  deps: StoryDeps,
  route: RouteId,
  kind?: PacketKind,
  opts?: { reverse?: boolean; label?: string },
): Promise<void> {
  if (deps.cancelled()) return;
  cue("packet");
  const handle = deps.rails.dispatch(route, kind, opts);
  await handle.done;
}

function express(deps: StoryDeps, agentId: string, expr: Expression): void {
  if (deps.cancelled()) return;
  deps.cast.get(agentId)?.setExpression(expr);
}

function react(
  deps: StoryDeps,
  agentId: string,
  kind: "hop" | "droop" | "lean" | "tilt" | "wobble" | "squash" | "startle" | "headrub" | "apologize" | "doubleTake",
): void {
  if (deps.cancelled()) return;
  deps.cast.get(agentId)?.react(kind);
}

function popMark(deps: StoryDeps, agentId: string, kind: "!" | "?" | "stars" | "droplet" | "puff"): void {
  if (deps.cancelled()) return;
  deps.cast.get(agentId)?.popMark(kind);
}

/** Fire a semantic audio cue; a no-op while the visitor keeps sound muted. */
function cue(name: string): void {
  playDioramaCue(name);
}

/** A named walking point near a station anchor, offset toward the floor. */
function near(id: StationId, dx = 0, dy = 0): { x: number; y: number } {
  const s = STATIONS[id].anchor;
  return { x: s.x + dx, y: s.y + dy };
}


// Short local aliases for the station api interfaces the stories call.
type Approval = ApprovalApi;
type BudgetMeter = BudgetMeterApi;
type ExecutionGateway = ExecutionGatewayApi;
type Protection = ProtectionApi;
type RiskFortress = RiskFortressApi;
type SignerVault = SignerVaultApi;
type McpHub = McpHubApi;
type ReceiptPrinter = ReceiptPrinterApi;
type Reconciliation = ReconciliationApi;
type Recovery = RecoveryApi;
type ReplayChamber = ReplayChamberApi;
type SignalTower = SignalTowerApi;
type Supervisor = SupervisorApi;

// ---------------------------------------------------------------------------
// Story builders
// ---------------------------------------------------------------------------

const s = (
  id: string,
  title: string,
  durationHint: number,
  agents: string[],
  stations: StationId[],
  run: (deps: StoryDeps) => Promise<void>,
): Story => ({ id, title, durationHint, agents, stations, run });

const probeWalk: { x: number; y: number }[] = [
  { x: 430, y: 240 },
  { x: 560, y: 250 },
  { x: 680, y: 235 },
  { x: 850, y: 245 },
];

const corridorWalk: { x: number; y: number }[] = [
  { x: 2110, y: 1105 },
  { x: 2140, y: 1088 },
  { x: 2210, y: 1135 },
];

const gardenWalk: { x: number; y: number }[] = [
  { x: 300, y: 560 },
  { x: 360, y: 575 },
  { x: 330, y: 548 },
];

/**
 * The full trade lifecycle chain: research through reconciliation, played in
 * order with short gaps so a viewer can follow one decision end to end.
 */
export const LIFECYCLE_CHAIN: string[] = [
  "s-research-fetch",
  "s-research-to-strategy",
  "s-mission-update",
  "s-proposals-appear",
  "s-proposal-rejected",
  "s-proposal-needs-human",
  "s-human-approval",
  "s-permission-verify",
  "s-budget-consume",
  "s-risk-pass",
  "s-protection-attach",
  "s-signer-pulse",
  "s-execute-order",
  "s-exchange-ack",
  "s-fill-vault",
  "s-receipt-print",
  "s-reconcile",
  "s-audit-store",
];

/** Scattered singles: system texture between lifecycle runs. */
export const SCATTER_POOL: string[] = [
  "s-mcp-degraded",
  "s-tool-refusal",
  "s-recovery-retry",
  "s-alert-wake",
  "s-sandbox-test",
  "s-emergency-demo",
];

/** Weighted ambient texture for the new director: scatter singles plus the
 * floor choreography and supervisor rounds that keep the default frame busy. */
export const TEXTURE_POOL: string[] = [
  ...SCATTER_POOL,
  "s-floor-handoff",
  "s-floor-signal",
  "s-supervisor-rounds",
];

/** Harmless slapstick: own concurrency budget and per-gag cooldowns. */
export const COMEDY_POOL: string[] = [
  "s-bump-antennae",
  "s-drop-cards",
  "s-runaway-cart",
  "s-spring-gate",
  "s-cable-trip",
  "s-booth-jam",
  "s-stack-topple",
];

export const STORIES: Story[] = [
  // 1. Research: a probe extracts live data from the landscape.
  s("s-research-fetch", "Probe extracts market data", 8, ["probe-1", "analysis-1"], ["marketLandscape", "marketData", "strategyLab"],
    async (d) => {
      await move(d, "probe-1", probeWalk);
      react(d, "probe-1", "hop");
      await send(d, "landscapeToMarketData");
      glowPulse(d.ctx, "marketData");
      await d.beat(400);
      await send(d, "marketDataToStrategy");
      express(d, "analysis-1", "curious");
      react(d, "analysis-1", "hop");
    }),

  // 2. Research: analysis is carried to the strategy lab.
  s("s-research-to-strategy", "Analysis carried to strategy", 8, ["research-1", "strategy-1"], ["researchTools", "strategyLab"],
    async (d) => {
      const research = d.cast.get("research-1");
      research?.carry(ROLE_COLORS.research);
      express(d, "research-1", "focused");
      await move(d, "research-1", [near("strategyLab", -60, 30)]);
      research?.carry(null); // card handed over
      express(d, "strategy-1", "focused");
      react(d, "strategy-1", "lean");
      glowPulse(d.ctx, "strategyLab");
    }),

  // 3. Strategy updates the mission; the signal tower hears it.
  s("s-mission-update", "Mission phase update", 8, ["strategy-1"], ["missionBoard", "signalTower"],
    async (d) => {
      await move(d, "strategy-1", [near("missionBoard", 60, 20)]);
      const board = storyApi<MissionBoardApi>("missionBoard");
      board?.setPhase("Analysing");
      d.simulation.setPhase("Analysing");
      cue("lever");
      await d.beat(300);
      await send(d, "missionToSignalTower");
      storyApi<SignalTower>("signalTower")?.pulse("market");
    }),

  // 4. Proposals appear at the decision table.
  s("s-proposals-appear", "Proposals compared", 7, ["strategy-2"], ["decisionTable"],
    async (d) => {
      await move(d, "strategy-2", [near("decisionTable", -40, 25)]);
      storyApi<DecisionTableApi>("decisionTable")?.showProposals(3, 1);
      express(d, "strategy-2", "focused");
      react(d, "strategy-2", "lean");
    }),

  // 5. A proposal is rejected at the table and returns west.
  // CONTRACT: showProposals(count, -1) = reject beat (all retract, one dimmed red).
  s("s-proposal-rejected", "Proposal rejected", 7, ["strategy-2"], ["decisionTable", "approval"],
    async (d) => {
      storyApi<DecisionTableApi>("decisionTable")?.showProposals(3, -1);
      express(d, "strategy-2", "frustrated");
      react(d, "strategy-2", "droop");
      await d.beat(400);
      await send(d, "deniedReturn");
      glowPulse(d.ctx, "refusalDisplay", 0.35, 1.1);
    }),

  // 6. The surviving proposal needs human approval at the west gate.
  s("s-proposal-needs-human", "Approval requested", 9, ["approval-clerk"], ["decisionTable", "approval"],
    async (d) => {
      await send(d, "decisionToApproval");
      storyApi<Approval>("approval")?.setSeal("waiting");
      express(d, "approval-clerk", "curious");
      react(d, "approval-clerk", "tilt");
      // Perimeter has no "waiting shimmer" in its frozen api; glow the desk.
      glowPulse(d.ctx, "approval", 0.45, 1.4);
    }),

  // 7. The human supervisor approves; the perimeter opens.
  s("s-human-approval", "Human approval granted", 9, ["approval-clerk"], ["approval", "supervisor", "activityGallery"],
    async (d) => {
      glowPulse(d.ctx, "supervisor", 0.4, 1.2);
      await d.beat(300);
      storyApi<Approval>("approval")?.setSeal("approved");
      perimeter()?.grantPulse("west");
      await send(d, "approvalToPermission");
      // Plaque pulse for the user-activity wall (no frozen api).
      glowPulse(d.ctx, "activityGallery", 0.45, 1.0);
      express(d, "approval-clerk", "satisfied");
      react(d, "approval-clerk", "hop");
    }),

  // 8. Permission tokens verify the agent may act.
  s("s-permission-verify", "Permissions verified", 8, ["permission-keeper"], ["permission", "budgetMeter"],
    async (d) => {
      express(d, "permission-keeper", "focused");
      glowPulse(d.ctx, "permission");
      // Command round trip: permission asks budget, budget answers.
      await send(d, "permissionToBudget");
      await send(d, "permissionToBudget", "event", { reverse: true });
      react(d, "permission-keeper", "lean");
    }),

  // 9. Budget reservoirs are consumed transparently.
  s("s-budget-consume", "Budget consumed", 6, [], ["budgetMeter"],
    async (d) => {
      const budget = storyApi<BudgetMeter>("budgetMeter");
      budget?.consume("loss", 0.04);
      d.simulation.consumeLoss(4);
      await d.beat(300);
      budget?.consume("tools", 0.03);
      d.simulation.consumeTools(0.03);
      glowPulse(d.ctx, "budgetMeter", 0.45, 0.8);
    }),

  // 10. The risk fortress scans the proposal.
  s("s-risk-pass", "Risk arches pass", 9, ["risk-scanner"], ["riskFortress"],
    async (d) => {
      await send(d, "permissionToRisk");
      storyApi<RiskFortress>("riskFortress")?.runScan(true);
      express(d, "risk-scanner", "focused");
      await move(d, "risk-scanner", corridorWalk);
    }),

  // 11. Protection wraps the position token before any signing.
  s("s-protection-attach", "Protection attached", 8, [], ["riskFortress", "protection", "signerVault"],
    async (d) => {
      await send(d, "riskToProtection");
      storyApi<Protection>("protection")?.shieldUp();
      await d.beat(400);
      // The shielded token continues toward the signer.
      await send(d, "protectionToSigner");
    }),

  // 12. The signer vault pulses; the key itself never leaves.
  s("s-signer-pulse", "Order signed in vault", 7, ["vault-keeper"], ["signerVault"],
    async (d) => {
      storyApi<SignerVault>("signerVault")?.signPulse();
      express(d, "vault-keeper", "focused");
      react(d, "vault-keeper", "lean");
      await d.beat(400);
      await send(d, "signerToExecution");
    }),

  // 13. The execution gateway ships the order capsule to the exchange.
  s("s-execute-order", "Order sent to exchange", 9, ["gateway-op"], ["executionGateway"],
    async (d) => {
      const gateway = storyApi<ExecutionGateway>("executionGateway");
      gateway?.setState("preparing");
      express(d, "gateway-op", "focused");
      await d.beat(300);
      gateway?.setState("submitted");
      await send(d, "exchangeTunnel");
      hyperliquid()?.exchangeEvent("order");
    }),

  // 14. The exchange acknowledges; the tower signals execution.
  s("s-exchange-ack", "Exchange acknowledgment", 7, [], ["executionGateway", "signalTower"],
    async (d) => {
      await send(d, "exchangeTunnel", "event", { reverse: true });
      storyApi<ExecutionGateway>("executionGateway")?.setState("acknowledged");
      hyperliquid()?.exchangeEvent("ack");
      storyApi<SignalTower>("signalTower")?.pulse("execution");
    }),

  // 15. The fill returns and the portfolio vault updates.
  s("s-fill-vault", "Fill updates portfolio", 8, [], ["portfolioVault"],
    async (d) => {
      hyperliquid()?.exchangeEvent("fill");
      await send(d, "exchangeStateReturn");
      // No frozen PortfolioVault api; station-agnostic pulse.
      glowPulse(d.ctx, "portfolioVault", 0.4, 1.2);
    }),

  // 16. A receipt prints and rolls into the archive.
  s("s-receipt-print", "Receipt printed", 8, ["receipt-clerk"], ["receiptPrinter", "auditArchive"],
    async (d) => {
      await send(d, "executionToReceipts");
      storyApi<ReceiptPrinter>("receiptPrinter")?.print("order");
      express(d, "receipt-clerk", "neutral");
      await d.beat(600);
      await send(d, "receiptsToArchive");
    }),

  // 17. Reconciliation compares local and exchange state.
  s("s-reconcile", "Reconciliation aligned", 8, ["recon-1"], ["reconciliationDock"],
    async (d) => {
      await move(d, "recon-1", [near("reconciliationDock", 30, -20)]);
      await send(d, "localStateStream");
      storyApi<Reconciliation>("reconciliationDock")?.compare(true);
      express(d, "recon-1", "satisfied");
      react(d, "recon-1", "hop");
    }),

  // 18. History is archived; occasionally replayed.
  s("s-audit-store", "Audit and replay", 8, ["archivist"], ["auditArchive", "replayChamber"],
    async (d) => {
      express(d, "archivist", "focused");
      // Drawer cycle has no frozen api; station-agnostic glow.
      glowPulse(d.ctx, "auditArchive", 0.45, 1.2);
      if (d.rng() < 0.5) {
        await d.beat(500);
        storyApi<ReplayChamber>("replayChamber")?.playReceipt();
      }
    }),

  // 19. MCP ports degrade; the health console follows shared state.
  s("s-mcp-degraded", "Tool port degradation", 9, ["health-watcher"], ["mcpHub", "mcpHealth"],
    async (d) => {
      const hub = storyApi<McpHub>("mcpHub");
      hub?.setPortHealth(3, "amber");
      d.simulation.setPortHealth(3, "amber");
      await d.beat(500);
      hub?.setPortHealth(5, "red");
      d.simulation.setPortHealth(5, "red");
      express(d, "health-watcher", "worried");
      react(d, "health-watcher", "tilt");
    }),

  // 20. A call on a dead port is refused with a comic knock-back, then recovers.
  s("s-tool-refusal", "Tool call refused", 12, ["hub-keeper", "adapter-op"], ["mcpHub", "refusalDisplay", "adapterBay"],
    async (d) => {
      const hub = storyApi<McpHub>("mcpHub");
      const adapterOp = d.cast.get("adapter-op");
      try {
        await move(d, "hub-keeper", [near("mcpHub", -30, 20)]);
        hub?.portCall(5); // attempted on the red port
        express(d, "hub-keeper", "confused");
        react(d, "hub-keeper", "startle"); // ejected packet knocks the caller back
        popMark(d, "hub-keeper", "?");
        cue("skid");
        await d.beat(300);
        // Refusal card travels back from the hub toward the adapter bay.
        await send(d, "hubToAdapterBay", "refusal", { reverse: true });
        d.simulation.refuse("UNAVAILABLE TOOL");
        cue("reject");
        glowPulse(d.ctx, "refusalDisplay", 0.35, 1.2);
        // The outage beat: the caller droops, then the adapter operator comes
        // over, apologizes for the port, and they wait it out together.
        react(d, "hub-keeper", "droop");
        if (adapterOp) {
          await move(d, "adapter-op", [near("mcpHub", 10, 55)]);
          react(d, "adapter-op", "apologize");
          popMark(d, "adapter-op", "droplet");
        }
        await d.wait(3500);
        if (d.cancelled()) return;
        hub?.setPortHealth(5, "green");
        d.simulation.setPortHealth(5, "green");
        express(d, "hub-keeper", "satisfied");
        react(d, "hub-keeper", "hop");
        cue("recover");
      } finally {
        // Interrupt-safe: a destroyed or cancelled run still restores the port
        // and shared state so the hub never sits red forever.
        hub?.setPortHealth(5, "green");
        d.simulation.setPortHealth(5, "green");
      }
    }),

  // 21. Recovery repairs a drifted flow, then reconciliation aligns.
  s("s-recovery-retry", "Recovery and retry", 10, ["recovery-1"], ["recoveryWorkshop", "reconciliationDock"],
    async (d) => {
      express(d, "recovery-1", "worried");
      storyApi<Recovery>("recoveryWorkshop")?.dispatchRepair();
      await send(d, "recoveryDispatch");
      express(d, "recovery-1", "focused");
      await d.beat(400);
      storyApi<Reconciliation>("reconciliationDock")?.compare(false);
      await d.beat(700);
      storyApi<Reconciliation>("reconciliationDock")?.compare(true);
      express(d, "recovery-1", "satisfied");
      react(d, "recovery-1", "hop");
    }),

  // 22. An alert wakes the floor.
  s("s-alert-wake", "Alert wake", 7, ["floor-monitor"], ["signalTower", "missionBoard"],
    async (d) => {
      storyApi<SignalTower>("signalTower")?.pulse("alert");
      await send(d, "missionToSignalTower");
      express(d, "floor-monitor", "alarmed");
      react(d, "floor-monitor", "hop");
    }),

  // 23. Sandbox: everything stays inside the research district.
  // NOTE: this story deliberately crosses NO perimeter gate; sandbox traffic
  // loops marketData -> strategy -> missionBoard inside research only.
  s("s-sandbox-test", "Sandbox simulation", 9, ["sandbox-1"], ["sandbox", "marketData", "strategyLab", "missionBoard"],
    async (d) => {
      express(d, "sandbox-1", "excited");
      await move(d, "sandbox-1", gardenWalk);
      react(d, "sandbox-1", "hop");
      await send(d, "marketDataToStrategy");
      await send(d, "strategyToMissionBoard");
      glowPulse(d.ctx, "sandbox", 0.45, 1.0);
    }),

  // 24. Emergency pause demo from the supervisor deck.
  s("s-emergency-demo", "Emergency pause demo", 11, ["floor-monitor", "floor-exec"], ["supervisor", "emergencyPanel", "tradingFloor", "signalTower"],
    async (d) => {
      const floor = getStation("tradingFloor");
      const restore = (): void => {
        if (floor) {
          for (const child of floor.root.children) {
            gsap.to(child, { alpha: 1, duration: 0.5, overwrite: true });
          }
        }
      };
      try {
        storyApi<Supervisor>("supervisor")?.setCampusPaused(true);
        d.simulation.setPaused(true);
        storyApi<SignalTower>("signalTower")?.pulse("warning");
        cue("warn");
        if (floor) {
          // Station-agnostic: dim the floor's children, restore on resume.
          for (const child of floor.root.children) {
            const tween = gsap.to(child, { alpha: 0.75, duration: 0.5, overwrite: true });
            d.ctx.onCleanup(() => tween.kill());
          }
        }
        await d.wait(3000);
        storyApi<Supervisor>("supervisor")?.setCampusPaused(false);
        d.simulation.setPaused(false);
        restore();
        express(d, "floor-monitor", "satisfied");
        express(d, "floor-exec", "satisfied");
        react(d, "floor-exec", "hop");
        popMark(d, "floor-monitor", "puff");
      } finally {
        // Interrupt-safe: the floor never stays dimmed.
        storyApi<Supervisor>("supervisor")?.setCampusPaused(false);
        d.simulation.setPaused(false);
        restore();
      }
    }),

  // 25. Rotating duty handoff across the floor consoles.
  s("s-floor-handoff", "Duty handoff on the floor", 11, ["floor-strategy", "floor-exec", "floor-monitor"], ["tradingFloor", "holoCore"],
    async (d) => {
      const holo = storyApi<HoloCoreApi>("holoCore");
      const strategy = d.cast.get("floor-strategy");
      const exec = d.cast.get("floor-exec");
      strategy?.carry(ROLE_COLORS.strategy);
      express(d, "floor-strategy", "focused");
      // Ring arcs west -> south -> east, outside the holo footprint.
      await move(d, "floor-strategy", [{ x: 1292, y: 798 }, { x: 1342, y: 848 }, { x: 1420, y: 880 }, { x: 1502, y: 905 }]);
      react(d, "floor-exec", "doubleTake");
      strategy?.carry(null); // card handed over
      exec?.carry(ROLE_COLORS.execution);
      express(d, "floor-exec", "focused");
      await move(d, "floor-exec", [{ x: 1502, y: 905 }, { x: 1440, y: 940 }]);
      exec?.carry(null); // second handoff
      d.cast.get("floor-monitor")?.tap();
      react(d, "floor-monitor", "lean");
      holo?.rotateStrategies();
      holo?.orderLaunched();
      cue("lever");
      await d.beat(400);
      react(d, "floor-strategy", "hop");
      express(d, "floor-monitor", "satisfied");
    }),

  // 26. A market signal startles the floor and shifts the regime.
  s("s-floor-signal", "Market signal reaches the floor", 9, ["floor-research", "floor-analysis"], ["tradingFloor", "holoCore", "signalTower"],
    async (d) => {
      const holo = storyApi<HoloCoreApi>("holoCore");
      const tower = storyApi<SignalTower>("signalTower");
      tower?.pulse("market");
      cue("warn");
      express(d, "floor-research", "alarmed");
      react(d, "floor-research", "startle");
      popMark(d, "floor-research", "!");
      // Landscape flips regime; the holo mirrors it.
      marketLandscape()?.setRegime("turbulent");
      await move(d, "floor-research", [{ x: 1288, y: 612 }, { x: 1282, y: 660 }]);
      express(d, "floor-research", "focused");
      express(d, "floor-analysis", "curious");
      react(d, "floor-analysis", "tilt");
      holo?.marketEvent("state");
      holo?.rotateStrategies();
      await d.beat(600);
      // Calm returns.
      marketLandscape()?.setRegime("rising");
      holo?.marketEvent("state");
      express(d, "floor-research", "satisfied");
      react(d, "floor-analysis", "hop");
    }),

  // 27. The supervisor walks the control round: observe, approve, check the panel.
  s("s-supervisor-rounds", "Supervisor review rounds", 10, ["approval-clerk"], ["supervisor", "approval", "activityGallery"],
    async (d) => {
      glowPulse(d.ctx, "supervisor", 0.4, 1.0);
      storyApi<Approval>("approval")?.setSeal("waiting");
      await d.beat(500);
      storyApi<Approval>("approval")?.setSeal("approved");
      cue("approve");
      perimeter()?.grantPulse("west");
      await d.beat(400);
      glowPulse(d.ctx, "emergencyPanel", 0.45, 0.9);
      glowPulse(d.ctx, "activityGallery", 0.45, 0.9);
      express(d, "approval-clerk", "satisfied");
      react(d, "approval-clerk", "hop");
    }),

  // 28. COMEDY. Two bots round a console from opposite sides and bump antennae.
  s("s-bump-antennae", "Antennae bump on the north ring", 8, ["floor-research", "floor-analysis"], ["tradingFloor"],
    async (d) => {
      const meet = { x: 1400, y: 572 };
      void meet;
      await move(d, "floor-research", [{ x: 1330, y: 572 }, { x: 1378, y: 570 }]);
      await move(d, "floor-analysis", [{ x: 1545, y: 610 }, { x: 1455, y: 572 }, { x: 1420, y: 570 }]);
      // Bump.
      cue("bump");
      react(d, "floor-research", "startle");
      react(d, "floor-analysis", "startle");
      popMark(d, "floor-research", "!");
      popMark(d, "floor-analysis", "!");
      await d.beat(350);
      react(d, "floor-research", "wobble");
      react(d, "floor-analysis", "wobble");
      await d.beat(450);
      react(d, "floor-research", "apologize");
      react(d, "floor-analysis", "headrub");
      await d.beat(500);
      await move(d, "floor-research", [{ x: 1300, y: 620 }, { x: 1268, y: 640 }]);
      await move(d, "floor-analysis", [{ x: 1500, y: 630 }, { x: 1590, y: 640 }]);
      d.cast.get("floor-analysis")?.laugh();
      express(d, "floor-research", "satisfied");
    }),

  // 29. COMEDY. Dropped schema cards, a skid, and a helpful gather.
  s("s-drop-cards", "Schema cards dropped and gathered", 10, ["schema-librarian", "adapter-op"], ["toolSchemas", "adapterBay"],
    async (d) => {
      const librarian = d.cast.get("schema-librarian");
      librarian?.carry(ROLE_COLORS.operations);
      await move(d, "schema-librarian", [{ x: 2440, y: 640 }, { x: 2458, y: 588 }]);
      // Cards slip.
      librarian?.carry(null);
      cue("skid");
      react(d, "schema-librarian", "squash");
      popMark(d, "schema-librarian", "?");
      await scatterCards(2462, 580, ROLE_COLORS.operations, 5);
      // The adapter operator skids past, narrowly misses, then helps.
      react(d, "adapter-op", "squash");
      await move(d, "adapter-op", [{ x: 2480, y: 560 }, { x: 2452, y: 588 }]);
      react(d, "adapter-op", "apologize");
      await d.beat(300);
      await move(d, "schema-librarian", [{ x: 2468, y: 588 }]);
      react(d, "schema-librarian", "headrub");
      await d.beat(400);
      // Gathered together.
      cue("recover");
      express(d, "adapter-op", "satisfied");
      express(d, "schema-librarian", "satisfied");
      d.cast.get("schema-librarian")?.laugh();
      await move(d, "schema-librarian", [{ x: 2440, y: 660 }, { x: 2395, y: 690 }]);
      await move(d, "adapter-op", [{ x: 2488, y: 532 }]);
    }),

  // 30. COMEDY. A maintenance cart rolls away; three bots chase it.
  s("s-runaway-cart", "Runaway cart chased down", 12, ["hub-keeper", "schema-librarian", "adapter-op"], ["toolSchemas", "mcpHub", "adapterBay"],
    async (d) => {
      cue("cart");
      const cartDone = rollProp(2430, 690, ROLE_COLORS.execution, [{ x: 2330, y: 620 }, { x: 2230, y: 570 }, { x: 2140, y: 605 }, { x: 2205, y: 660 }], 150);
      void (async () => {
        await move(d, "schema-librarian", [{ x: 2380, y: 680 }, { x: 2300, y: 635 }, { x: 2235, y: 585 }]);
        react(d, "schema-librarian", "wobble");
      })();
      void (async () => {
        await move(d, "adapter-op", [{ x: 2470, y: 560 }, { x: 2380, y: 560 }, { x: 2260, y: 575 }]);
        react(d, "adapter-op", "startle");
      })();
      await move(d, "hub-keeper", [{ x: 2230, y: 570 }, { x: 2170, y: 590 }, { x: 2215, y: 655 }]);
      react(d, "hub-keeper", "squash"); // the catch
      popMark(d, "hub-keeper", "stars");
      await cartDone;
      cue("bump");
      await d.beat(300);
      react(d, "hub-keeper", "hop");
      d.cast.get("hub-keeper")?.laugh();
      express(d, "schema-librarian", "satisfied");
      express(d, "adapter-op", "satisfied");
    }),

  // 31. COMEDY. The research-only spring gate closes early and bonks a backpack.
  s("s-spring-gate", "Spring gate bonk at research only", 9, ["sandbox-1"], ["researchOnlyGate", "sandbox"],
    async (d) => {
      await move(d, "sandbox-1", [{ x: 270, y: 590 }, { x: 212, y: 612 }]);
      // The gate springs shut a beat early.
      cue("door");
      react(d, "sandbox-1", "squash");
      popMark(d, "sandbox-1", "stars");
      glowPulse(d.ctx, "researchOnlyGate", 0.4, 1.0);
      await d.beat(400);
      react(d, "sandbox-1", "headrub");
      react(d, "sandbox-1", "apologize");
      await d.beat(450);
      // Retry politely; the gate behaves.
      await move(d, "sandbox-1", [{ x: 240, y: 640 }, { x: 185, y: 648 }]);
      cue("door");
      react(d, "sandbox-1", "hop");
      express(d, "sandbox-1", "excited");
      await d.beat(300);
      await move(d, "sandbox-1", [{ x: 260, y: 610 }, { x: 320, y: 575 }]);
      d.cast.get("sandbox-1")?.laugh();
    }),

  // 32. COMEDY. A loose cable trips the recovery bot; a colleague helps up.
  s("s-cable-trip", "Cable trip and a helping hand", 10, ["recovery-1", "observer-1"], ["recoveryWorkshop", "observability"],
    async (d) => {
      await move(d, "recovery-1", [{ x: 470, y: 1365 }, { x: 560, y: 1315 }]);
      // Trip over the loose cable.
      cue("bump");
      react(d, "recovery-1", "squash");
      popMark(d, "recovery-1", "stars");
      popMarkAt(585, 1300, "puff");
      await d.beat(500);
      react(d, "recovery-1", "wobble");
      // The observer rushes over and helps upright.
      await move(d, "observer-1", [{ x: 1050, y: 1120 }, { x: 800, y: 1240 }, { x: 640, y: 1300 }]);
      react(d, "observer-1", "apologize");
      await d.beat(400);
      react(d, "recovery-1", "hop");
      express(d, "recovery-1", "satisfied");
      express(d, "observer-1", "satisfied");
      d.cast.get("observer-1")?.laugh();
      await move(d, "observer-1", [{ x: 900, y: 1200 }, { x: 1130, y: 1060 }]);
    }),

  // 33. COMEDY. Two impatient bots jam the same provider booth, then take turns.
  s("s-booth-jam", "Provider booth traffic jam", 9, ["adapter-op", "schema-librarian"], ["providers"],
    async (d) => {
      const booth = { x: 2415, y: 242 };
      // Both aim for the same narrow booth.
      const adapterLane = move(d, "adapter-op", [{ x: 2452, y: 470 }, { x: 2434, y: 330 }, booth]);
      const librarianLane = move(d, "schema-librarian", [{ x: 2400, y: 560 }, { x: 2418, y: 360 }, booth]);
      await Promise.all([adapterLane, librarianLane]);
      // Stuck.
      cue("door");
      react(d, "adapter-op", "squash");
      react(d, "schema-librarian", "squash");
      popMark(d, "adapter-op", "?");
      popMark(d, "schema-librarian", "?");
      await d.beat(500);
      // Reverse and apologize.
      await Promise.all([
        move(d, "adapter-op", [{ x: 2452, y: 340 }]),
        move(d, "schema-librarian", [{ x: 2380, y: 350 }]),
      ]);
      react(d, "adapter-op", "apologize");
      react(d, "schema-librarian", "headrub");
      await d.beat(400);
      // One at a time.
      await move(d, "adapter-op", [booth, { x: 2430, y: 250 }]);
      react(d, "adapter-op", "doubleTake");
      await d.beat(350);
      await move(d, "schema-librarian", [booth, { x: 2400, y: 250 }]);
      express(d, "schema-librarian", "satisfied");
      d.cast.get("adapter-op")?.laugh();
    }),

  // 34. COMEDY. A celebratory hop topples a stack of glowing capsules.
  s("s-stack-topple", "Capsule stack toppled at the vault", 9, ["receipt-clerk", "archivist"], ["receiptPrinter", "portfolioVault"],
    async (d) => {
      storyApi<ReceiptPrinter>("receiptPrinter")?.print("order");
      cue("stamp");
      await d.beat(400);
      react(d, "receipt-clerk", "hop");
      // The hop knocks the neighbor's capsule stack.
      cue("bump");
      popMark(d, "receipt-clerk", "!");
      express(d, "receipt-clerk", "alarmed");
      await scatterCards(940, 1125, ROLE_COLORS.reconciliation, 4);
      await d.beat(300);
      react(d, "receipt-clerk", "apologize");
      // The archivist helps gather.
      await move(d, "archivist", [{ x: 1020, y: 1290 }, { x: 975, y: 1185 }]);
      react(d, "archivist", "headrub");
      await d.beat(500);
      cue("recover");
      express(d, "archivist", "satisfied");
      express(d, "receipt-clerk", "satisfied");
      d.cast.get("receipt-clerk")?.laugh();
      await move(d, "archivist", [{ x: 1030, y: 1290 }]);
    }),
];

export const STORY_MAP: Map<string, Story> = new Map(STORIES.map((story) => [story.id, story]));
