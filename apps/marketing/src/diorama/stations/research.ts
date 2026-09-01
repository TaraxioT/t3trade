/**
 * West section: the research row along the N-W wall and the decision wedge.
 * Owner: west lane. Cycle 4 rebuild around one readable flow
 * (freeze.md §1): WATCHLIST -> IDEAS & VALIDATION -> MISSION -> TRADE.
 *
 * - WATCHLIST (marketData, hero): a console wall of asset rows with mark and
 *   24h change, one selected row, and a refresh glyph. The periodic sweep is
 *   a fetch, never a tick stream: values only change when a story sets them.
 * - IDEAS & VALIDATION (researchTools): a forward-validation board with one
 *   candidate idea, paper-validation status, research-mode honesty copy, and
 *   an unlabeled curve pane (the quiet market-structure nod; no venue).
 * - MISSION (missionBoard): phase breadcrumb chips, exact status, Max loss
 *   bar, and the armed-watch counter on the wedge's landmark board.
 * - TRADE (decisionTable, hero): the order ticket. Server preview and the
 *   verbatim refusal sentence share one readout area; there is no proposal
 *   fan, approval gate, or evidence-pip theatre anywhere on the path.
 *
 * Removed this cycle (registrations, signs, and text included): the research
 * only gate, strategy lab, market-structure exhibit, sandbox, budget-plan
 * lectern, and the randomized scatter; their concepts survive as card copy or
 * in MISSION/LOSS BUDGET/TOOLS per freeze.md §1. Budget planning visuals live
 * in the mission Max loss bar; sandbox lives in the research-mode copy.
 *
 * All statics are built once; ambient motion runs through ctx.onTick, GSAP
 * only for brief state transitions. Screen text is produced exclusively
 * through detailKit, which applies the freeze §5 detail policy (visible at
 * camera tier >= 1.8 only).
 */
import { Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { registerStation } from "../core/registry.js";
import { STATIONS, type StationId } from "../config/stations.js";
import { PALETTE } from "../config/palette.js";
import { DEPTH } from "../config/world.js";
import { dotTexture, glow, isoBox, isoCylinder, screenPanel } from "../core/iso.js";
import { adoptDetailText, makeSign } from "../core/signs.js";

/** West ids owned by this module (freeze.md §1 registry). */
type WestStationId = "marketData" | "researchTools" | "missionBoard" | "decisionTable";

export interface MarketDataApi {
  /** Highlight the watchlist row that the active mission watches. */
  setMissionMarket(asset: string | null): void;
}

export interface ResearchToolsApi {
  /** Pulse the candidate idea row or the paper-validation state. */
  pulse(kind: "idea" | "validation"): void;
}

/** Exact mission statuses (packages/trading-contracts mission states). */
export type MissionStatus =
  | "Initializing"
  | "Analysing"
  | "Waiting"
  | "Executing"
  | "Position open"
  | "Paused"
  | "Agent unavailable"
  | "Blocked"
  | "Revoked"
  | "Completed";

/** Breadcrumb phases shown on the mission board. */
export type MissionPhase = "Analyse" | "Wait" | "Execute" | "Position";

export interface MissionBoardApi {
  /** Move the breadcrumb highlight; accepts any case ("waiting" -> Wait). */
  setPhase(phase: string): void;
  /** Show the exact mission status and, when blocked, its reason. */
  setStatus(status: MissionStatus, blockedReason?: string): void;
  /** Set the Max loss bar's used percentage (0..100). */
  setMaxLoss(usedPct: number): void;
  /** Set the armed-watch counter. */
  setWatchCount(n: number): void;
}

export type TicketState = "editing" | "preview" | "refused" | "sent";

export interface DecisionTableApi {
  /** Drive the order ticket readout; refusal carries the verbatim sentence. */
  setTicket(state: TicketState, refusal?: string): void;
}

type StationRoot = Container & { hit: Container };

/** Shared scaffolding: root at anchor depth, hit area, sign above structure. */
function stationBase(
  ctx: DioramaContext,
  id: WestStationId,
  structureHeight: number,
  opts: { signDx?: number } = {},
): StationRoot {
  const def = STATIONS[id];
  const root = new Container() as StationRoot;
  root.position.set(def.anchor.x, def.anchor.y);
  root.zIndex = def.anchor.y + DEPTH.base;
  ctx.layers.sortable.addChild(root);

  // Hit surface: flat diamond covering the footprint, kept invisible.
  const hit = new Container();
  const hitG = new Graphics();
  const hw = def.size.w / 2;
  const hd = def.size.d / 2;
  hitG.poly([-hw, 0, 0, hd, hw, 0, 0, -hd]);
  hitG.fill({ color: 0xffffff, alpha: 0 });
  hit.addChild(hitG);
  hit.eventMode = "static";
  hit.cursor = "pointer";
  root.addChild(hit);
  root.hit = hit;

  const sign = makeSign(def.label, {
    x: def.anchor.x + (opts.signDx ?? 0),
    y: def.anchor.y - (structureHeight + 26),
    size: def.signSize,
    accent: PALETTE.cyan,
    lod: def.lod,
    stationId: id,
  });
  sign.zIndex = def.anchor.y + DEPTH.overlay;
  ctx.layers.labels.addChild(sign);

  return root;
}

/**
 * Detail-text kit: the ONLY text factory in this module. Every string is
 * adopted into the sign registry (freeze §5) under the owning station id, so
 * tier gating, focus forcing, and focus dimming are one shared rule. The kit
 * itself owns nothing but typography.
 */
export function detailKit(stationId: StationId): (
  text: string,
  size: number,
  color: number,
  opts?: {
    wrapWidth?: number;
    lineHeight?: number;
  },
) => Text {
  return (text, size, color, opts = {}) => {
    const style = new TextStyle({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: size,
      letterSpacing: size * 0.06,
      fill: color,
    });
    if (opts.wrapWidth !== undefined) {
      style.wordWrap = true;
      style.wordWrapWidth = opts.wrapWidth;
      style.breakWords = false;
    }
    if (opts.lineHeight !== undefined) style.lineHeight = opts.lineHeight;
    const t = new Text({ text, style });
    t.resolution = 2;
    adoptDetailText(t, stationId);
    return t;
  };
}

/** Status light paired with a shape cue: pulsing ring + blinking inner dot. */
function statusLight(
  x: number,
  y: number,
  color: number,
  ctx: DioramaContext,
  phase: number,
): Container {
  const c = new Container();
  c.position.set(x, y);
  const ring = new Graphics();
  ring.circle(0, 0, 5);
  ring.stroke({ width: 1.5, color, alpha: 0.9 });
  const dot = new Sprite(dotTexture());
  dot.anchor.set(0.5);
  dot.width = 7;
  dot.height = 7;
  dot.tint = color;
  c.addChild(ring, dot);
  const off = ctx.onTick(() => {
    const s = (performance.now() / 1000 + phase) % 2;
    ring.scale.set(1 + 0.25 * Math.sin(s * Math.PI));
    ring.alpha = 0.55 + 0.35 * Math.sin(s * Math.PI);
    dot.alpha = s % 1 < 0.7 ? 1 : 0.25;
  });
  ctx.onCleanup(off);
  return c;
}

/** Landmark beacon: soft dot + tight glow with a slow sine pulse. */
function beacon(
  x: number,
  y: number,
  color: number,
  ctx: DioramaContext,
  phase: number,
): Container {
  const c = new Container();
  c.position.set(x, y);
  c.addChild(glow(0, 0, 16, color, 0.45));
  const dot = new Sprite(dotTexture());
  dot.anchor.set(0.5);
  dot.width = 6;
  dot.height = 6;
  dot.tint = color;
  c.addChild(dot);
  const off = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const s = (performance.now() / 1000 + phase) % 3;
    dot.alpha = 0.6 + 0.4 * Math.sin(s * Math.PI * 2);
  });
  ctx.onCleanup(off);
  return c;
}

/** Slow sine breathing helper for ambient loops. */
const breathe = (t: number, period: number, phase: number): number =>
  Math.sin(((t + phase) / period) * Math.PI * 2);

/**
 * Soft dark ground ellipse added right after the hit surface so each
 * structure sits on the floor instead of floating over it. Coordinates are
 * root-local (research roots are positioned at their anchor).
 */
function contactShadow(
  root: Container,
  x: number,
  y: number,
  w: number,
  d: number,
  alpha = 0.27,
): void {
  const g = new Graphics();
  g.ellipse(x, y, w / 2, d / 2);
  g.fill({ color: 0x03080f, alpha });
  root.addChild(g);
}

/** Shared-tier floor pad (unsorted ground layer) tying the twin consoles
 * (WATCHLIST + IDEAS) into one evidence tier. No caption: freeze §5. */
function groundPad(
  ctx: DioramaContext,
  x: number,
  y: number,
  w: number,
  d: number,
  rim: number,
  rimAlpha: number,
): void {
  const g = new Graphics();
  g.roundRect(x - w / 2, y - d / 2, w, d, Math.min(w, d) * 0.28);
  g.fill({ color: PALETTE.structure, alpha: 0.5 });
  g.roundRect(x - w / 2, y - d / 2, w, d, Math.min(w, d) * 0.28);
  g.stroke({ width: 1.5, color: rim, alpha: rimAlpha });
  ctx.layers.ground.addChild(g);
}

/** Small marked standing plate: rounded pad + tick for an agent's post. */
function footPlate(x: number, y: number, accent: number): Graphics {
  const g = new Graphics();
  g.roundRect(x - 13, y - 7, 26, 14, 3);
  g.fill({ color: PALETTE.structureLight, alpha: 0.85 });
  g.roundRect(x - 13, y - 7, 26, 14, 3);
  g.stroke({ width: 1, color: accent, alpha: 0.7 });
  g.moveTo(x - 4, y);
  g.lineTo(x + 4, y);
  g.stroke({ width: 1.5, color: accent, alpha: 0.9 });
  return g;
}

/** One-shot glow flash: peak alpha fading back to rest. */
function blip(target: Sprite, ctx: DioramaContext, peak: number, fade: number): void {
  if (ctx.reducedMotion) {
    target.alpha = peak * 0.6;
    gsap.to(target, { alpha: 0, duration: 0.3, ease: "none" });
    return;
  }
  gsap.fromTo(target, { alpha: peak }, { alpha: 0, duration: fade, ease: "power2.out" });
}

// ---------------------------------------------------------------------------
// WATCHLIST (marketData, hero): console wall with three asset rows (symbol,
// mark, 24h change as registered detail text), one selected row, and a
// refresh glyph. The periodic sweep re-reads the wall (a fetch); values do
// not tick on a timer, so nothing implies a live websocket feed.
// ---------------------------------------------------------------------------

interface WatchRow {
  symbol: string;
  mission: Graphics;
}

const WATCH_ASSETS = [
  { symbol: "ETH", mark: "3,214.5", change: "+2.4%", up: true },
  { symbol: "BTC", mark: "64,180", change: "+0.8%", up: true },
  { symbol: "SOL", mark: "148.20", change: "-1.2%", up: false },
];

function buildMarketData(ctx: DioramaContext): void {
  const detail = detailKit("marketData");
  const root = stationBase(ctx, "marketData", 50);

  contactShadow(root, 0, 26, 200, 64);
  root.addChild(
    isoBox({
      x: 0,
      y: 14,
      w: 186,
      d: 46,
      h: 12,
      color: PALETTE.structure,
      rim: PALETTE.cyan,
      rimAlpha: 0.55,
    }),
  );

  // Backdrop wall the watchlist screen mounts on.
  const wall = new Graphics();
  wall.roundRect(-92, -50, 184, 58, 6);
  wall.fill({ color: PALETTE.space, alpha: 0.8 });
  wall.roundRect(-92, -50, 184, 58, 6);
  wall.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.3 });
  root.addChild(wall);

  // One watchlist screen: three rows, columns for symbol / mark / 24h.
  const panel = screenPanel({ x: -86, y: -46, w: 172, h: 50, accent: PALETTE.cyan });
  root.addChild(panel);

  const rows: WatchRow[] = [];
  WATCH_ASSETS.forEach((asset, i) => {
    const cy = -34 + i * 16;
    const selected = new Graphics();
    selected.roundRect(-82, cy - 6.5, 164, 13, 3);
    selected.fill({ color: PALETTE.cyan, alpha: 0.13 });
    selected.roundRect(-82, cy - 6.5, 164, 13, 3);
    selected.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.75 });
    panel.addChild(selected);
    const mission = new Graphics();
    mission.roundRect(-82, cy - 6.5, 164, 13, 3);
    mission.fill({ color: PALETTE.violet, alpha: 0.12 });
    mission.roundRect(-82, cy - 6.5, 164, 13, 3);
    mission.stroke({ width: 1.2, color: PALETTE.violet, alpha: 0.9 });
    mission.visible = false;
    panel.addChild(mission);

    const symbol = detail(asset.symbol, 7, PALETTE.ink);
    symbol.anchor.set(0, 0.5);
    symbol.position.set(-76, cy);
    const mark = detail(asset.mark, 7, PALETTE.ink);
    mark.anchor.set(0.5, 0.5);
    mark.position.set(8, cy);
    const change = detail(asset.change, 6.5, asset.up ? PALETTE.healthy : PALETTE.blocked);
    change.anchor.set(1, 0.5);
    change.position.set(76, cy);
    panel.addChild(symbol, mark, change);
    rows.push({ symbol: asset.symbol, mission });
  });

  // Refresh glyph: a circular-arrow fetch mark, not a ticker.
  const glyph = new Graphics();
  glyph.arc(0, 0, 5, -Math.PI / 3, Math.PI * 1.1);
  glyph.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.95 });
  glyph.poly([4.4, -3.4, 6.6, -1.4, 3.2, -0.6]);
  glyph.fill({ color: PALETTE.cyan, alpha: 0.95 });
  glyph.position.set(78, -55);
  root.addChild(glyph);

  root.addChild(statusLight(80, 22, PALETTE.healthy, ctx, 1.1));

  // Fetch sweep: crosses the wall every ~13 s (a refresh, values unchanged).
  const sweep = new Graphics();
  sweep.rect(-1, -44, 2, 46);
  sweep.fill({ color: PALETTE.aqua, alpha: 0.4 });
  sweep.blendMode = "add";
  sweep.alpha = 0;
  root.addChild(sweep);
  if (!ctx.reducedMotion) {
    const sweepTl = gsap.timeline({ repeat: -1, repeatDelay: 11.8 });
    sweepTl
      .set(sweep, { x: -84 })
      .to(sweep, { alpha: 0.85, duration: 0.15 })
      .to(sweep, { x: 84, duration: 1.1, ease: "none" })
      .to(sweep, { alpha: 0, duration: 0.15 });
    ctx.onCleanup(() => sweepTl.kill());
  }

  const api: MarketDataApi = {
    setMissionMarket(asset) {
      const target = asset
        ? rows.find((r) => r.symbol.toUpperCase() === asset.trim().toUpperCase())
        : undefined;
      for (const row of rows) row.mission.visible = row === target;
    },
  };
  registerStation({ id: "marketData", root, hit: root.hit, api });
}

// ---------------------------------------------------------------------------
// IDEAS & VALIDATION (researchTools): forward-validation board. One candidate
// idea, "Validating on paper" status, "Research mode · signer not required"
// honesty copy (the merged research-only-gate concept), and an unlabeled
// curve pane (the quiet market-structure nod; unbranded, not a venue).
// ---------------------------------------------------------------------------

function buildResearchTools(ctx: DioramaContext): void {
  const detail = detailKit("researchTools");
  const root = stationBase(ctx, "researchTools", 46);

  contactShadow(root, 0, 40, 200, 64);
  root.addChild(
    isoBox({
      x: 0,
      y: 34,
      w: 180,
      d: 44,
      h: 12,
      color: PALETTE.structure,
      rim: PALETTE.cyan,
      rimAlpha: 0.55,
    }),
  );

  const wall = new Graphics();
  wall.roundRect(-90, -52, 180, 76, 6);
  wall.fill({ color: PALETTE.space, alpha: 0.8 });
  wall.roundRect(-90, -52, 180, 76, 6);
  wall.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.3 });
  root.addChild(wall);

  // Forward-validation board.
  const panel = screenPanel({ x: -84, y: -48, w: 120, h: 52, accent: PALETTE.cyan });
  root.addChild(panel);

  const header = detail("FORWARD VALIDATION", 6.5, PALETTE.ink);
  header.anchor.set(0, 0);
  header.position.set(-78, -42);
  panel.addChild(header);

  // Candidate idea row: one card outline + idea text (the strategy-lab
  // candidate concept, one row instead of a fan).
  const ideaCard = new Graphics();
  ideaCard.roundRect(-78, -33, 76, 13, 2);
  ideaCard.fill({ color: PALETTE.violet, alpha: 0.08 });
  ideaCard.roundRect(-78, -33, 76, 13, 2);
  ideaCard.stroke({ width: 1, color: PALETTE.violet, alpha: 0.8 });
  panel.addChild(ideaCard);
  const ideaText = detail("ETH trend candidate", 6, PALETTE.ink);
  ideaText.anchor.set(0, 0.5);
  ideaText.position.set(-73, -26.5);
  panel.addChild(ideaText);
  const ideaFlash = glow(-40, -26.5, 46, PALETTE.violet, 0);
  panel.addChild(ideaFlash);

  const validating = detail("Validating on paper", 6, PALETTE.waiting);
  validating.anchor.set(0, 0.5);
  validating.position.set(-78, -13);
  validating.alpha = 0.85;
  panel.addChild(validating);

  const mode = detail("Research mode", 5.5, PALETTE.cyan);
  mode.anchor.set(0, 0.5);
  mode.position.set(-78, -4.5);
  mode.alpha = 0.9;
  panel.addChild(mode);
  const noSigner = detail("signer not required", 5, PALETTE.inkDim);
  noSigner.anchor.set(0, 0.5);
  noSigner.position.set(-30, -4.5);
  panel.addChild(noSigner);

  // Unlabeled curve pane: the market-structure concept nod. A quiet
  // validation curve with a breathing end dot; no formula, no branding.
  const pane = screenPanel({ x: 40, y: -40, w: 44, h: 34, accent: PALETTE.violet });
  root.addChild(pane);
  const curve = new Graphics();
  curve.moveTo(-36, -12);
  curve.lineTo(-36, -32);
  curve.moveTo(-36, -12);
  curve.lineTo(78, -12);
  curve.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.35 });
  curve.moveTo(-34, -16);
  curve.quadraticCurveTo(-20, -34, -8, -24);
  curve.quadraticCurveTo(2, -16, 12, -22);
  curve.quadraticCurveTo(30, -34, 40, -20);
  curve.quadraticCurveTo(60, -8, 78, -14);
  curve.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.8 });
  pane.addChild(curve);
  const curveDot = glow(78, -14, 7, PALETTE.cyan, 0.8);
  pane.addChild(curveDot);
  const paneFlash = glow(62, -23, 52, PALETTE.cyan, 0);
  root.addChild(paneFlash);
  // Validation scan line rides inside the pane on pulse.
  const scan = new Graphics();
  scan.rect(-0.8, -38, 1.6, 30);
  scan.fill({ color: PALETTE.violet, alpha: 0.8 });
  scan.blendMode = "add";
  scan.alpha = 0;
  root.addChild(scan);

  root.addChild(statusLight(66, 16, PALETTE.healthy, ctx, 0.6));

  const dotOff = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const t = performance.now() / 1000;
    curveDot.alpha = 0.55 + 0.3 * breathe(t, 4, 0);
  });
  ctx.onCleanup(dotOff);

  const api: ResearchToolsApi = {
    pulse(kind) {
      if (kind === "idea") {
        blip(ideaFlash, ctx, 0.85, 0.7);
        if (ctx.reducedMotion) {
          ideaText.y = -26.5;
          return;
        }
        gsap.killTweensOf(ideaText);
        gsap.fromTo(ideaText, { y: -29.5 }, { y: -26.5, duration: 0.45, ease: "back.out(2)" });
        return;
      }
      blip(paneFlash, ctx, 0.7, 0.8);
      gsap.killTweensOf(validating);
      validating.alpha = 1;
      gsap.to(validating, { alpha: 0.85, duration: 0.6, ease: "power2.out", delay: 0.3 });
      if (ctx.reducedMotion) return;
      gsap.killTweensOf(scan);
      gsap
        .timeline({ onComplete: () => gsap.set(scan, { alpha: 0 }) })
        .fromTo(scan, { x: 42, alpha: 0.9 }, { x: 82, alpha: 0.9, duration: 0.8, ease: "none" })
        .to(scan, { alpha: 0, duration: 0.15 });
    },
  };
  registerStation({ id: "researchTools", root, hit: root.hit, api });
  ctx.onCleanup(() => {
    gsap.killTweensOf([ideaText, validating, scan]);
  });
}

// ---------------------------------------------------------------------------
// MISSION (missionBoard): the wedge landmark. Angled board with phase
// breadcrumb chips (Analyse › Wait › Execute › Position), exact status text
// with optional blocked reason, the Max loss bar (the merged budget-planning
// concept), and the armed-watch counter.
// ---------------------------------------------------------------------------

const PHASES: MissionPhase[] = ["Analyse", "Wait", "Execute", "Position"];

const STATUS_COLORS: Record<MissionStatus, number> = {
  Initializing: PALETTE.waiting,
  Analysing: PALETTE.waiting,
  Waiting: PALETTE.cyan,
  Executing: PALETTE.cyan,
  "Position open": PALETTE.healthy,
  Paused: PALETTE.warning,
  // Product parity: the workspace renders agent_unavailable red, like Blocked.
  "Agent unavailable": PALETTE.blocked,
  Blocked: PALETTE.blocked,
  Revoked: PALETTE.blocked,
  Completed: PALETTE.healthy,
};

function buildMissionBoard(ctx: DioramaContext): void {
  const detail = detailKit("missionBoard");
  const accent = PALETTE.cyan;
  const root = stationBase(ctx, "missionBoard", 62);

  contactShadow(root, 0, 12, 208, 84);
  root.addChild(
    isoBox({
      x: 0,
      y: 22,
      w: 206,
      d: 84,
      h: 8,
      color: PALETTE.structure,
      rim: accent,
      rimAlpha: 0.35,
    }),
  );

  // Gate pylons carry the fit-visible beacons.
  for (const px of [-106, 106]) {
    root.addChild(
      isoCylinder({ x: px, y: 12, r: 5, h: 70, color: PALETTE.structure, rim: accent }),
    );
  }
  root.addChild(beacon(-106, -60, PALETTE.cyan, ctx, 0.0));
  root.addChild(beacon(106, -60, PALETTE.cyan, ctx, 0.5));

  const board = screenPanel({ x: -102, y: -60, w: 204, h: 60, accent });
  root.addChild(board);

  // Phase breadcrumb: four chips with separators; setPhase moves the highlight.
  const chipFills: Graphics[] = [];
  const chipLabels: Text[] = [];
  PHASES.forEach((phase, i) => {
    const left = -98 + i * 46;
    const fill = new Graphics();
    fill.roundRect(left, -54, 34, 12, 3);
    fill.fill({ color: accent, alpha: i === 0 ? 0.2 : 0.06 });
    fill.roundRect(left, -54, 34, 12, 3);
    fill.stroke({ width: 1, color: accent, alpha: i === 0 ? 0.9 : 0.35 });
    board.addChild(fill);
    chipFills.push(fill);
    const label = detail(phase, 5.5, i === 0 ? PALETTE.ink : PALETTE.inkDim);
    label.anchor.set(0.5, 0.5);
    label.position.set(left + 17, -48);
    board.addChild(label);
    chipLabels.push(label);
    if (i < PHASES.length - 1) {
      const sep = detail("\u203a", 8, PALETTE.inkDim);
      sep.anchor.set(0.5, 0.5);
      sep.position.set(left + 40, -48);
      board.addChild(sep);
    }
  });

  // Exact status row: the status union verbatim plus an optional reason.
  const statusText = detail("Initializing", 11, STATUS_COLORS.Initializing);
  statusText.anchor.set(0, 0.5);
  statusText.position.set(-98, -31);
  board.addChild(statusText);
  const reasonText = detail("", 6, PALETTE.blocked);
  reasonText.anchor.set(1, 0.5);
  reasonText.position.set(98, -31);
  reasonText.visible = false;
  board.addChild(reasonText);

  // Max loss bar (budget-planning concept): label, track, used fill, percent.
  const lossLabel = detail("Max loss", 6, PALETTE.inkDim);
  lossLabel.anchor.set(0, 0.5);
  lossLabel.position.set(-98, -16);
  board.addChild(lossLabel);
  const lossTrack = new Graphics();
  lossTrack.roundRect(-62, -19, 100, 6, 3);
  lossTrack.fill({ color: PALETTE.structureLight, alpha: 0.9 });
  board.addChild(lossTrack);
  const lossFill = new Graphics();
  board.addChild(lossFill);
  const drawLoss = (pct: number): void => {
    lossFill.clear();
    const w = Math.max(0, Math.min(100, pct));
    lossFill.roundRect(-62, -19, w, 6, 3);
    lossFill.fill({ color: w >= 90 ? PALETTE.blocked : PALETTE.orange, alpha: 0.95 });
  };
  drawLoss(0);
  const lossPct = detail("0%", 6, PALETTE.ink);
  lossPct.anchor.set(0, 0.5);
  lossPct.position.set(46, -16);
  board.addChild(lossPct);

  // Armed-watch counter: label, count, and up to six watch dots.
  const watchLabel = detail("Armed watches", 6, PALETTE.inkDim);
  watchLabel.anchor.set(0, 0.5);
  watchLabel.position.set(-98, -6);
  board.addChild(watchLabel);
  const watchCount = detail("0", 8, PALETTE.ink);
  watchCount.anchor.set(0, 0.5);
  watchCount.position.set(-36, -6);
  board.addChild(watchCount);
  const watchDots: Graphics[] = [];
  for (let i = 0; i < 6; i++) {
    const dot = new Graphics();
    dot.circle(-10 + i * 9, -6, 2.4);
    dot.fill({ color: accent, alpha: 0.95 });
    dot.visible = false;
    board.addChild(dot);
    watchDots.push(dot);
  }

  const api: MissionBoardApi = {
    setPhase(phase) {
      // Normalize: "waiting"/"WAITING" -> Wait, "position open"/"holding" -> Position.
      const p = phase.trim().toLowerCase();
      const idx = PHASES.findIndex((name) => {
        const n = name.toLowerCase();
        return (
          p === n ||
          p.startsWith(n) ||
          (n === "wait" && p === "waiting") ||
          (n === "position" && (p === "position open" || p === "holding")) ||
          (n === "analyse" && p === "analysing") ||
          (n === "execute" && p === "executing")
        );
      });
      if (idx < 0) return;
      chipFills.forEach((fill, i) => {
        const on = i === idx;
        fill.clear();
        fill.roundRect(-98 + i * 46, -54, 34, 12, 3);
        fill.fill({ color: accent, alpha: on ? 0.2 : 0.06 });
        fill.roundRect(-98 + i * 46, -54, 34, 12, 3);
        fill.stroke({ width: 1, color: accent, alpha: on ? 0.9 : 0.35 });
      });
      chipLabels.forEach((label, i) => {
        label.style.fill = i === idx ? PALETTE.ink : PALETTE.inkDim;
      });
      if (ctx.reducedMotion) return;
      gsap.fromTo(board, { alpha: 0.6 }, { alpha: 1, duration: 0.4, ease: "power1.inOut" });
    },
    setStatus(status, blockedReason) {
      statusText.text = status;
      statusText.style.fill = STATUS_COLORS[status];
      if (blockedReason) {
        reasonText.text = blockedReason;
        reasonText.visible = true;
      } else {
        reasonText.visible = false;
      }
      if (ctx.reducedMotion) return;
      gsap.fromTo(statusText, { alpha: 0.25 }, { alpha: 1, duration: 0.45, ease: "power1.inOut" });
    },
    setMaxLoss(usedPct) {
      const pct = Math.max(0, Math.min(100, usedPct));
      drawLoss(pct);
      lossPct.text = `${Math.round(pct)}%`;
    },
    setWatchCount(n) {
      watchCount.text = String(Math.max(0, n));
      for (let i = 0; i < watchDots.length; i++) watchDots[i].visible = i < n;
    },
  };
  registerStation({ id: "missionBoard", root, hit: root.hit, api });
}

// ---------------------------------------------------------------------------
// TRADE (decisionTable, hero): the order ticket on the decision table. Fields
// (side toggle, size, required stop, urgency) are drawn once; the readout
// area shows the live server preview or the verbatim refusal sentence. No
// proposal cards, no approval gate, no evidence pips.
// ---------------------------------------------------------------------------

const TICKET_READOUTS: Record<Exclude<TicketState, "refused">, { text: string; color: number }> = {
  editing: { text: "Awaiting preview", color: PALETTE.inkDim },
  preview: { text: "Preview ready", color: PALETTE.healthy },
  sent: { text: "Order sent", color: PALETTE.healthy },
};

function buildDecisionTable(ctx: DioramaContext): void {
  const detail = detailKit("decisionTable");
  // signDx keeps the ticket sign clear of the TOOLS compound board to the SE.
  const root = stationBase(ctx, "decisionTable", 118, { signDx: -30 });

  contactShadow(root, 0, 28, 186, 80);

  // Round table on a pedestal, kept from the previous decision endpoint.
  root.addChild(isoCylinder({ x: 0, y: 30, r: 14, h: 14, color: PALETTE.structure }));
  const tableTop = new Graphics();
  tableTop.ellipse(0, 16, 88, 44);
  tableTop.fill({ color: PALETTE.structureLight });
  tableTop.ellipse(0, 16, 88, 44);
  tableTop.stroke({ width: 2, color: PALETTE.surfacePale, alpha: 0.8 });
  tableTop.ellipse(0, 16, 70, 34);
  tableTop.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.22 });
  root.addChild(tableTop);
  root.addChild(glow(0, 14, 120, PALETTE.blue, 0.1));

  // Ticket screen on two posts above the table.
  for (const px of [-44, 44]) {
    const post = new Graphics();
    post.rect(px - 1.2, -16, 2.4, 24);
    post.fill({ color: PALETTE.structureLight });
    root.addChild(post);
  }
  const panel = screenPanel({ x: -64, y: -112, w: 128, h: 96, accent: PALETTE.blue });
  root.addChild(panel);

  // Ticket state LED: readable at tier 0 when the detail text is hidden.
  const led = new Graphics();
  led.circle(56, -106, 3);
  led.fill({ color: PALETTE.cyan });
  root.addChild(led);

  const title = detail("TRADE ETH", 8, PALETTE.ink);
  title.anchor.set(0, 0.5);
  title.position.set(-56, -100);
  panel.addChild(title);

  // Side toggle: the demo ticket is a Buy; Sell stays available but dim.
  const sideBuy = new Graphics();
  sideBuy.roundRect(2, -104, 24, 11, 3);
  sideBuy.fill({ color: PALETTE.healthy, alpha: 0.14 });
  sideBuy.roundRect(2, -104, 24, 11, 3);
  sideBuy.stroke({ width: 1, color: PALETTE.healthy, alpha: 0.9 });
  panel.addChild(sideBuy);
  const buyLabel = detail("Buy", 6, PALETTE.healthy);
  buyLabel.anchor.set(0.5, 0.5);
  buyLabel.position.set(14, -98.5);
  panel.addChild(buyLabel);
  const sideSell = new Graphics();
  sideSell.roundRect(28, -104, 26, 11, 3);
  sideSell.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.45 });
  panel.addChild(sideSell);
  const sellLabel = detail("Sell", 6, PALETTE.inkDim);
  sellLabel.anchor.set(0.5, 0.5);
  sellLabel.position.set(41, -98.5);
  panel.addChild(sellLabel);

  // Field rows: size, required stop, urgency.
  const fieldRow = (label: string, value: string, y: number): void => {
    const l = detail(label, 6.5, PALETTE.inkDim);
    l.anchor.set(0, 0.5);
    l.position.set(-56, y);
    panel.addChild(l);
    const v = detail(value, 6.5, PALETTE.ink);
    v.anchor.set(1, 0.5);
    v.position.set(56, y);
    panel.addChild(v);
  };
  fieldRow("Size", "0.25 ETH", -78);
  fieldRow("Stop price (required)", "2,980.0", -64);
  const urgency = detail("Urgency", 6.5, PALETTE.inkDim);
  urgency.anchor.set(0, 0.5);
  urgency.position.set(-56, -50);
  panel.addChild(urgency);
  [0, 1, 2].forEach((i) => {
    const notch = new Graphics();
    notch.roundRect(32 + i * 9, -54, 7, 8, 2);
    if (i === 1) notch.fill({ color: PALETTE.cyan, alpha: 0.8 });
    else {
      notch.fill({ color: PALETTE.space, alpha: 0.7 });
      notch.roundRect(32 + i * 9, -54, 7, 8, 2);
      notch.stroke({ width: 0.8, color: PALETTE.inkDim, alpha: 0.6 });
    }
    panel.addChild(notch);
  });

  // Readout area: live preview or the verbatim refusal sentence.
  const readoutZone = new Graphics();
  readoutZone.roundRect(-58, -42, 116, 22, 3);
  readoutZone.fill({ color: PALETTE.space, alpha: 0.55 });
  panel.addChild(readoutZone);
  const readout = detail(TICKET_READOUTS.editing.text, 6.5, TICKET_READOUTS.editing.color, {
    wrapWidth: 106,
    lineHeight: 9,
  });
  readout.anchor.set(0, 0);
  readout.position.set(-52, -39);
  panel.addChild(readout);

  root.addChild(statusLight(-84, 20, PALETTE.healthy, ctx, 0.05));

  // Witness plate: strategy-1's post beside the table (freeze §6).
  const def = STATIONS.decisionTable;
  ctx.layers.ground.addChild(footPlate(def.anchor.x + 65, def.anchor.y + 25, PALETTE.violet));

  let flash: gsap.core.Timeline | null = null;
  ctx.onCleanup(() => flash?.kill());
  const pulseLed = (color: number): void => {
    led.clear();
    led.circle(56, -106, 3);
    led.fill({ color });
    if (ctx.reducedMotion) return;
    flash?.kill();
    flash = gsap
      .timeline()
      .fromTo(led, { alpha: 0.2 }, { alpha: 1, duration: 0.25 })
      .to(led, { alpha: 0.75, duration: 0.3 });
  };

  const api: DecisionTableApi = {
    setTicket(state, refusal) {
      if (state === "refused") {
        readout.text = refusal && refusal.length > 0 ? refusal : "Refused";
        readout.style.fill = PALETTE.blocked;
        pulseLed(PALETTE.blocked);
        return;
      }
      const preset = TICKET_READOUTS[state];
      readout.text = preset.text;
      readout.style.fill = preset.color;
      pulseLed(state === "editing" ? PALETTE.cyan : PALETTE.healthy);
    },
  };
  registerStation({ id: "decisionTable", root, hit: root.hit, api });
}

// ---------------------------------------------------------------------------
// Evidence tier apron: one shared ground pad tying WATCHLIST and IDEAS &
// VALIDATION into a single readable west tier (no caption text).
// ---------------------------------------------------------------------------

function buildEvidenceApron(ctx: DioramaContext): void {
  const a = STATIONS.marketData.anchor;
  const b = STATIONS.researchTools.anchor;
  groundPad(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, 300, 76, PALETTE.cyan, 0.22);
}

// ---------------------------------------------------------------------------

export function buildResearchDistrict(ctx: DioramaContext): void {
  buildEvidenceApron(ctx);
  buildMarketData(ctx);
  buildResearchTools(ctx);
  buildMissionBoard(ctx);
  buildDecisionTable(ctx);
}
