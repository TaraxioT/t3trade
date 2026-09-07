/**
 * The cycle-4 story catalog: 19 event-driven scenarios that continuously
 * explain T3 Trade. Stories are the simulated product actor: they dispatch
 * typed events through the diorama event bus (ctx.bus) and move background
 * agents. They NEVER call station APIs, send rail packets, mutate the
 * simulation, or cue audio — systems/sceneBindings.ts is the single semantic
 * consumer that turns each event into station visuals, rails, state, and HUD.
 *
 * Catalog = freeze §11 ledger exactly:
 * - 1 spine: s-lifecycle, the full mission pass the director loops.
 * - 16 segment stories, one per card-action station.
 * - 2 textures (no card): s-refusal, s-tool-texture.
 *
 * Determinism: fake ids/sizes/sides and hold lengths come from the shared
 * seeded rng in StoryDeps, so the same seed replays the same show. Reduced
 * motion keeps the same event order; the director's beat() shortens holds and
 * stories never manage packet visuals, so no story work is motion-specific.
 *
 * Owner: stories worker (sole writer of this file). Consumers: the director
 * (SPINE_ID / TEXTURE_POOL / STORY_MAP) and station info cards,
 * which run story ids through Director.runStory.
 */
import type { DioramaContext } from "../core/context.js";
import type { StationId } from "../config/stations.js";
import { STATIONS } from "../config/stations.js";
import type { Expression, ReactionKind } from "../agents/agent.js";
import type { Agent } from "../agents/agent.js";
import type { AgentSystem } from "../agents/system.js";

/**
 * The bus event union, derived from the frozen context surface instead of a
 * direct eventBus.ts import: freeze §3 adds `bus` to DioramaContext and the
 * bus lane owns the union type. This keeps the coupling point to exactly one
 * field name.
 */
type BusEvent = Parameters<DioramaContext["bus"]["dispatch"]>[0];

export interface StoryDeps {
  ctx: DioramaContext;
  agents: AgentSystem;
  /** Seeded rng shared with the director; same seed = same show. */
  rng: () => number;
  /** Actors acquired for this run; guaranteed held until the story finishes. */
  cast: Map<string, Agent>;
  /** Content wait; resolves immediately once stopped. (Reserved for holds
   * that must not compress under reduced motion; current stories use beat.) */
  wait(ms: number): Promise<void>;
  /** Story beat: the director shortens it under reduced motion and resolves
   * immediately once stopped, so every spacing wait in a story goes through it. */
  beat(ms: number): Promise<void>;
  /** True once the director has been stopped; finish early when set. */
  cancelled(): boolean;
}

export interface Story {
  id: string;
  title: string;
  /** Rough playing time in seconds; scheduler hint only. */
  durationHint: number;
  /** Agent ids acquired for the run; the story skips when any is busy. */
  agents: string[];
  /** Stations whose visuals this story drives; the director marks them busy
   * so no other story or heartbeat writes the same station concurrently. */
  locks: StationId[];
  run(deps: StoryDeps): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[diorama/stories] ${message}`);
}

/** The one hero asset across every story; matches the WATCHLIST board. */
const MARKET = "ETH";
/** Mid-row MCP tool port used by tool-call/tool-health stories. */
const TOOL_PORT = 3;

/** Dispatch a bus event unless the director already stopped this run. */
function emit(d: StoryDeps, event: BusEvent): void {
  if (d.cancelled()) return;
  d.ctx.bus.dispatch(event);
}

/**
 * Cleanup dispatch from finally paths: an interrupted story must still leave
 * coherent state (recovered port, resumed campus). The bus is inert after
 * destroy, so after teardown this is a harmless no-op.
 */
function emitRestore(d: StoryDeps, event: BusEvent): void {
  d.ctx.bus.dispatch(event);
}

/** Seeded fake identifier, e.g. "watch-3f0a"; never shown as real data. */
function fakeId(d: StoryDeps, prefix: string): string {
  return `${prefix}-${Math.floor(d.rng() * 0xffff)
    .toString(16)
    .padStart(4, "0")}`;
}

/** Seeded order size in ETH (0.20-1.00) as a plain decimal string, the shape
 * the execution-requested event carries; nothing in the scene parses it. */
function fakeSize(d: StoryDeps): string {
  return (0.2 + d.rng() * 0.8).toFixed(2);
}

/**
 * Walk a cast agent through waypoints; no-ops once the director is stopped
 * (story continuations can resume after teardown and must not touch
 * destroyed objects). Locomotion always walks, also under reduced motion:
 * miniature agents walking between posts is scene content, not a vestibular
 * trigger. Waypoints must come from near() so registry re-anchoring keeps
 * them inside the agent's legal west/east district.
 */
async function move(
  d: StoryDeps,
  agentId: string,
  points: { x: number; y: number }[],
): Promise<void> {
  if (d.cancelled()) return;
  const agent = d.cast.get(agentId);
  if (!agent) {
    warnOnce(`agent missing from cast: ${agentId}`);
    return;
  }
  if (points.length === 0) return;
  await d.agents.walk(agent, points, { ease: "arrive" });
}

/** Face work expression on a cast agent (tasking, not comedy). */
function express(d: StoryDeps, agentId: string, expr: Expression): void {
  if (d.cancelled()) return;
  d.cast.get(agentId)?.setExpression(expr);
}

/** One purposeful body reaction on a cast agent. */
function react(d: StoryDeps, agentId: string, kind: ReactionKind): void {
  if (d.cancelled()) return;
  d.cast.get(agentId)?.react(kind);
}

/** A walking point offset from a station anchor; the only legal source of
 * story coordinates (small offsets, west/east stations only for agents). */
function near(id: StationId, dx = 0, dy = 0): { x: number; y: number } {
  const s = STATIONS[id].anchor;
  return { x: s.x + dx, y: s.y + dy };
}

// ---------------------------------------------------------------------------
// Story builders
// ---------------------------------------------------------------------------

const s = (
  id: string,
  title: string,
  durationHint: number,
  agents: string[],
  locks: StationId[],
  run: (d: StoryDeps) => Promise<void>,
): Story => ({ id, title, durationHint, agents, locks, run });

/**
 * The spine: one full mission pass from creation to open position, played as
 * the ordered freeze §8 event sequence with 250-450 ms gaps, a readable
 * 6-8 s analyse beat, and the 2.5 s finale hold. Exactly two background
 * agent waypoints (research-1 during the analyse beat, recon-1 during the
 * reconcile beat). No rejection in the spine.
 */
const sLifecycle = s(
  "s-lifecycle",
  "Full mission lifecycle",
  28,
  ["research-1", "recon-1"],
  [
    "marketData",
    "researchTools",
    "missionBoard",
    "decisionTable",
    "budgetMeter",
    "riskFortress",
    "protection",
    "signerVault",
    "executionGateway",
    "hyperliquidVenue",
    "reconciliationDock",
    "portfolioVault",
    "holoCore",
    "signalTower",
    "auditArchive",
  ],
  async (d) => {
    const missionId = fakeId(d, "mission");
    const watchId = fakeId(d, "watch");
    const side = d.rng() < 0.5 ? "buy" : "sell";
    const size = fakeSize(d);

    // Mission opens; the board holds "Analysing" while research reads it.
    emit(d, { type: "trading.mission-create-requested", missionId, market: MARKET });
    emit(d, { type: "trading.mission-status-changed", status: "Analysing" });
    const researchWalk = move(d, "research-1", [
      near("marketData", 46, 62),
      near("researchTools", 34, 56),
    ]);
    await d.beat(6800 + d.rng() * 700);
    await researchWalk;
    if (d.cancelled()) return;

    // A watch goes armed, the mission waits, the market crosses it.
    emit(d, { type: "trading.mission-watch-registered", watchId, asset: MARKET });
    await d.beat(400);
    emit(d, { type: "trading.mission-status-changed", status: "Waiting" });
    await d.beat(420);
    emit(d, { type: "trading.mission-watch-fired", watchId });
    await d.beat(400);
    emit(d, { type: "trading.mission-run-started", cause: "watch-fired" });
    await d.beat(380);

    // The plan becomes an order: preview, guards, protection, signature.
    emit(d, { type: "trading.execution-requested", market: MARKET, side, size });
    await d.beat(420);
    emit(d, { type: "diorama.execution-status", status: "previewed" });
    await d.beat(450);
    emit(d, { type: "diorama.execution-status", status: "reserved" });
    await d.beat(420);
    emit(d, { type: "diorama.execution-status", status: "signed" });
    await d.beat(380);

    // Out to the authoritative exchange, then back through reconciliation.
    // "Executing" lands the moment the order is submitted, before the ack.
    emit(d, { type: "diorama.execution-status", status: "submitted" });
    emit(d, { type: "trading.mission-status-changed", status: "Executing" });
    await d.beat(420);
    emit(d, { type: "diorama.execution-status", status: "accepted" });
    await d.beat(400);
    emit(d, { type: "diorama.execution-status", status: "filled" });
    await d.beat(300);
    emit(d, { type: "diorama.account-invalidated", reason: "reconcile:after_fill" });
    const reconWalk = move(d, "recon-1", [near("reconciliationDock", 44, -30)]);
    await d.beat(420);
    emit(d, {
      type: "diorama.account-view-refetched",
      market: MARKET,
      hasPosition: true,
      protection: "resting_on_exchange",
    });
    await d.beat(400);
    emit(d, { type: "trading.mission-status-changed", status: "Position open" });
    await reconWalk;
    // Finale: the canonical wave RECONCILE -> POSITIONS -> CHART and the one
    // HISTORY receipt row are sceneBindings' answer to the refetch; hold so
    // the viewer can read them before the loop breathes.
    await d.beat(2600);
  },
);

/** The execution half of the spine, runnable from the TRADE card. */
const sPlaceOrder = s(
  "s-place-order",
  "Place an order",
  14,
  [],
  [
    "decisionTable",
    "budgetMeter",
    "riskFortress",
    "protection",
    "signerVault",
    "executionGateway",
    "hyperliquidVenue",
    "reconciliationDock",
    "portfolioVault",
    "holoCore",
    "missionBoard",
    "auditArchive",
  ],
  async (d) => {
    const side = d.rng() < 0.5 ? "buy" : "sell";
    const size = fakeSize(d);
    emit(d, { type: "trading.execution-requested", market: MARKET, side, size });
    await d.beat(420);
    emit(d, { type: "diorama.execution-status", status: "previewed" });
    await d.beat(450);
    emit(d, { type: "diorama.execution-status", status: "reserved" });
    await d.beat(420);
    emit(d, { type: "diorama.execution-status", status: "signed" });
    await d.beat(380);
    emit(d, { type: "diorama.execution-status", status: "submitted" });
    await d.beat(420);
    emit(d, { type: "diorama.execution-status", status: "accepted" });
    await d.beat(400);
    emit(d, { type: "diorama.execution-status", status: "filled" });
    await d.beat(300);
    emit(d, { type: "diorama.account-invalidated", reason: "reconcile:after_fill" });
    await d.beat(420);
    emit(d, {
      type: "diorama.account-view-refetched",
      market: MARKET,
      hasPosition: true,
      protection: "resting_on_exchange",
    });
    await d.beat(400);
    emit(d, { type: "trading.mission-status-changed", status: "Position open" });
    await d.beat(2400);
  },
);

/** Arm a watch on the WATCHLIST card; it fires and the mission run starts. */
const sWatchMarket = s(
  "s-watch-market",
  "Watch the market",
  6,
  ["research-1"],
  ["marketData", "missionBoard", "signalTower"],
  async (d) => {
    const watchId = fakeId(d, "watch");
    const walk = move(d, "research-1", [near("marketData", 46, 62)]);
    emit(d, { type: "trading.mission-watch-registered", watchId, asset: MARKET });
    await d.beat(400);
    emit(d, { type: "trading.mission-status-changed", status: "Waiting" });
    await d.beat(420);
    emit(d, { type: "trading.mission-watch-fired", watchId });
    await d.beat(420);
    emit(d, { type: "trading.mission-run-started", cause: "watch-fired" });
    await d.beat(600);
    // Settle: this segment runs no execution, so the mission returns to
    // waiting instead of hanging on a started run that never trades.
    emit(d, { type: "trading.mission-status-changed", status: "Waiting" });
    await walk;
  },
);

/** ALERTS card: arm then fire a watch so the fired pulse and row are real. */
const sAlertFire = s(
  "s-alert-fire",
  "Alert fires",
  4,
  [],
  ["signalTower", "missionBoard"],
  async (d) => {
    const watchId = fakeId(d, "watch");
    emit(d, { type: "trading.mission-watch-registered", watchId, asset: MARKET });
    await d.beat(350);
    emit(d, { type: "trading.mission-watch-fired", watchId });
    await d.beat(900);
  },
);

/** IDEAS & VALIDATION card: a research cycle that stays in research mode. */
const sRunValidation = s(
  "s-run-validation",
  "Forward validation",
  6,
  ["research-1"],
  ["researchTools", "missionBoard"],
  async (d) => {
    const missionId = fakeId(d, "mission");
    const walk = move(d, "research-1", [near("researchTools", 32, 58)]);
    emit(d, { type: "trading.mission-create-requested", missionId, market: MARKET });
    await d.beat(300);
    emit(d, { type: "trading.mission-status-changed", status: "Analysing" });
    await d.beat(2400);
    // Paper validation never trades: the cycle ends back in waiting.
    emit(d, { type: "trading.mission-status-changed", status: "Waiting" });
    await walk;
  },
);

/** CHART card: re-assert the open-position chart state (overlay refresh). */
const sMarketShift = s(
  "s-market-shift",
  "Market regime shift",
  4,
  [],
  ["holoCore", "missionBoard"],
  async (d) => {
    // Regime shifts flow through the derived projection so the binding owns
    // the CHART reaction (overlays + regime shading) like every other event.
    emit(d, { type: "diorama.market-regime-changed", regime: "turbulent" });
    await d.beat(900);
    emit(d, { type: "diorama.market-regime-changed", regime: "rising" });
    await d.beat(500);
  },
);

/** TOOLS card: one tool call briefly loads a port, then it recovers. */
const sToolCall = s("s-tool-call", "Tool call", 6, ["hub-keeper"], ["mcpHub"], async (d) => {
  const walk = move(d, "hub-keeper", [near("mcpHub", -34, 52)]);
  emit(d, { type: "diorama.tool-health-changed", port: TOOL_PORT, health: "amber" });
  await d.beat(1400);
  emit(d, { type: "diorama.tool-health-changed", port: TOOL_PORT, health: "green" });
  await d.beat(600);
  await walk;
});

/** HYPERLIQUID card: order, ack, fill, authoritative state return, align. */
const sExchangeRoundtrip = s(
  "s-exchange-roundtrip",
  "Exchange round trip",
  9,
  [],
  [
    "hyperliquidVenue",
    "executionGateway",
    "reconciliationDock",
    "portfolioVault",
    "holoCore",
    "missionBoard",
    "auditArchive",
  ],
  async (d) => {
    emit(d, { type: "diorama.execution-status", status: "submitted" });
    await d.beat(420);
    emit(d, { type: "diorama.execution-status", status: "accepted" });
    await d.beat(400);
    emit(d, { type: "diorama.execution-status", status: "filled" });
    await d.beat(300);
    emit(d, { type: "diorama.account-invalidated", reason: "reconcile:after_fill" });
    await d.beat(420);
    emit(d, {
      type: "diorama.account-view-refetched",
      market: MARKET,
      hasPosition: true,
      protection: "resting_on_exchange",
    });
    // Refetch finale (aligned dock, positions, history row) is bindings' side.
    await d.beat(2200);
  },
);

/** EXECUTION card: the previewed -> submitted progression. */
const sSubmitOrder = s(
  "s-submit-order",
  "Order submitted",
  4,
  [],
  ["executionGateway", "hyperliquidVenue"],
  async (d) => {
    emit(d, { type: "diorama.execution-status", status: "previewed" });
    await d.beat(450);
    emit(d, { type: "diorama.execution-status", status: "submitted" });
    await d.beat(700);
  },
);

/** LOCAL SIGNING card: the signed pulse; the key itself never leaves. */
const sSignPulse = s(
  "s-sign-pulse",
  "Local signing",
  3,
  ["vault-keeper"],
  ["signerVault"],
  async (d) => {
    express(d, "vault-keeper", "focused");
    react(d, "vault-keeper", "lean");
    emit(d, { type: "diorama.execution-status", status: "signed" });
    await d.beat(800);
  },
);

/** PROTECTION card: the reserved beat that raises the exchange-native shield. */
const sProtectionAttach = s(
  "s-protection-attach",
  "Protection attached",
  4,
  [],
  ["protection", "riskFortress", "budgetMeter"],
  async (d) => {
    emit(d, { type: "diorama.execution-status", status: "reserved" });
    await d.beat(900);
  },
);

/** RISK GUARDS card: the reserved scan pass, with the scanner on patrol. */
const sRiskScan = s(
  "s-risk-scan",
  "Risk scan",
  5,
  ["risk-scanner"],
  ["riskFortress", "protection", "budgetMeter"],
  async (d) => {
    emit(d, { type: "diorama.execution-status", status: "reserved" });
    const walk = move(d, "risk-scanner", [
      near("riskFortress", 42, 48),
      near("riskFortress", -28, 60),
    ]);
    await d.beat(300);
    await walk;
  },
);

/** LOSS BUDGET card: the reserved beat that consumes the reservation. */
const sBudgetConsume = s(
  "s-budget-consume",
  "Loss budget reserved",
  3,
  [],
  ["budgetMeter", "riskFortress", "protection"],
  async (d) => {
    emit(d, { type: "diorama.execution-status", status: "reserved" });
    await d.beat(700);
  },
);

/** CONTROLS card: pause, hold, resume; the campus is never left dimmed. */
const sPauseControl = s(
  "s-pause-control",
  "Pause and resume",
  8,
  [],
  ["emergencyPanel", "tradingFloor", "missionBoard"],
  async (d) => {
    let paused = false;
    try {
      emit(d, { type: "trading.mission-control-requested", control: "trading.mission.pause" });
      paused = true;
      await d.beat(450);
      emit(d, { type: "trading.mission-status-changed", status: "Paused" });
      await d.beat(2200);
      emit(d, { type: "trading.mission-control-requested", control: "trading.mission.resume" });
      await d.beat(450);
      emit(d, { type: "trading.mission-status-changed", status: "Waiting" });
      paused = false;
    } finally {
      // Interrupt-safe: an abandoned pause must not leave the campus frozen.
      if (paused) {
        emitRestore(d, {
          type: "trading.mission-control-requested",
          control: "trading.mission.resume",
        });
        emitRestore(d, { type: "trading.mission-status-changed", status: "Waiting" });
      }
    }
  },
);

/** RECONCILE card: after-fill invalidation, canonical refetch, aligned. */
const sReconcile = s(
  "s-reconcile",
  "Reconciliation",
  8,
  ["recon-1"],
  ["reconciliationDock", "portfolioVault", "holoCore", "missionBoard", "auditArchive"],
  async (d) => {
    emit(d, { type: "diorama.account-invalidated", reason: "reconcile:after_fill" });
    const walk = move(d, "recon-1", [near("reconciliationDock", 40, -28)]);
    await d.beat(500);
    emit(d, {
      type: "diorama.account-view-refetched",
      market: MARKET,
      hasPosition: true,
      protection: "resting_on_exchange",
    });
    await d.beat(900);
    await walk;
    await d.beat(1200);
  },
);

/** POSITIONS card: the refetch that updates protection and the position. */
const sPositionUpdate = s(
  "s-position-update",
  "Position update",
  4,
  [],
  ["portfolioVault", "reconciliationDock", "holoCore", "missionBoard", "auditArchive"],
  async (d) => {
    emit(d, {
      type: "diorama.account-view-refetched",
      market: MARKET,
      hasPosition: true,
      protection: "resting_on_exchange",
    });
    await d.beat(1400);
  },
);

/** HISTORY card: a manual reconcile whose receipt row lands in the archive. */
const sHistoryRow = s(
  "s-history-row",
  "History row",
  6,
  [],
  ["auditArchive", "reconciliationDock", "portfolioVault", "missionBoard", "holoCore"],
  async (d) => {
    emit(d, { type: "diorama.account-invalidated", reason: "reconcile:manual" });
    await d.beat(450);
    emit(d, {
      type: "diorama.account-view-refetched",
      market: MARKET,
      hasPosition: true,
      protection: "resting_on_exchange",
    });
    // The receipt row travels to HISTORY during the refetch finale.
    await d.beat(1600);
  },
);

/**
 * Texture (no card): a product-true refusal. Only meaningful after a first
 * successful pass; the director owns that gate and the >= 90 s spacing
 * (addendum §D.11). Dispatches the refusal progression bus-only — requested,
 * previewed, rejected with a product guard reason, the Blocked status that
 * reason produces, then recovery to Waiting. Every visual (refused ticket
 * sentence, ALERTS pulse, HISTORY row, failed scan) is sceneBindings' answer.
 */
const sRefusal = s(
  "s-refusal",
  "Order refused",
  8,
  [],
  ["decisionTable", "signalTower", "auditArchive", "missionBoard"],
  async (d) => {
    const side = d.rng() < 0.5 ? "buy" : "sell";
    const size = fakeSize(d);
    emit(d, { type: "trading.execution-requested", market: MARKET, side, size });
    await d.beat(420);
    emit(d, { type: "diorama.execution-status", status: "previewed" });
    await d.beat(450);
    emit(d, {
      type: "diorama.execution-status",
      status: "rejected",
      reason: "cumulative_loss_limit",
    });
    await d.beat(700);
    emit(d, {
      type: "trading.mission-status-changed",
      status: "Blocked",
      blockedReason: "cumulative_loss_limit",
    });
    await d.beat(1400);
    // The mission survives the refusal and keeps waiting.
    emit(d, { type: "trading.mission-status-changed", status: "Waiting" });
    await d.beat(400);
  },
);

/** Texture (no card): a tool port degrades and recovers; interrupt-safe. */
const sToolTexture = s("s-tool-texture", "Tool health texture", 9, [], ["mcpHub"], async (d) => {
  let recovered = false;
  try {
    emit(d, { type: "diorama.tool-health-changed", port: TOOL_PORT, health: "amber" });
    await d.beat(1300);
    emit(d, { type: "diorama.tool-health-changed", port: TOOL_PORT, health: "red" });
    await d.beat(2800);
    emit(d, { type: "diorama.tool-health-changed", port: TOOL_PORT, health: "green" });
    recovered = true;
    await d.beat(700);
  } finally {
    // Interrupt-safe: a destroyed or cancelled run still restores the port
    // so the hub never sits red forever.
    if (!recovered) {
      emitRestore(d, { type: "diorama.tool-health-changed", port: TOOL_PORT, health: "green" });
    }
  }
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** The spine story id: the director's spine lane loops exactly this one. */
export const SPINE_ID = "s-lifecycle";

/** Ambient texture singles; the director runs at most one at a time and only
 * after the first pass (s-refusal additionally needs its >= 90 s gate). */
export const TEXTURE_POOL: string[] = [
  "s-refusal",
  "s-tool-texture",
  "s-alert-fire",
  "s-market-shift",
  "s-tool-call",
];

export const STORIES: Story[] = [
  sLifecycle,
  sPlaceOrder,
  sWatchMarket,
  sAlertFire,
  sRunValidation,
  sMarketShift,
  sToolCall,
  sExchangeRoundtrip,
  sSubmitOrder,
  sSignPulse,
  sProtectionAttach,
  sRiskScan,
  sBudgetConsume,
  sPauseControl,
  sReconcile,
  sPositionUpdate,
  sHistoryRow,
  sRefusal,
  sToolTexture,
];

export const STORY_MAP: Map<string, Story> = new Map(STORIES.map((story) => [story.id, story]));
