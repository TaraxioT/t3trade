/**
 * East section, state & reconciliation band. Three survivors (freeze §1):
 * RECONCILE (doorbell -> refetching -> aligned, with honest drift),
 * POSITIONS (positions + open orders board with the protection label), and
 * HISTORY (demoted mission event ledger with net P&L and one archiver-health
 * line). Owner: east lane (ops.ts). The other nine cycle-3 stations are cut;
 * their concepts live in card copy and rail rows, not as structures.
 *
 * Durability story kept honest: state is reconciled against the exchange,
 * drift is shown as drift (never dressed up as success), and every action can
 * land as a HISTORY row. The dock's idle motion is purely visual (a quiet
 * water shimmer); semantic phase transitions arrive only from scene bindings,
 * never from a self-scheduled loop.
 *
 * Shared language (R6): structural-blue booth family, gold district accent,
 * aqua counter-accent, common sign system. Station screen copy renders only
 * through the local detailText helper (registered detail, tier >= 1.8). The
 * scene reads correctly unanimated.
 */
import { Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
import { gsap } from "gsap";
import { STATIONS, type StationId } from "../config/stations.js";
import { PALETTE } from "../config/palette.js";
import { DEPTH } from "../config/world.js";
import { dotTexture, glow, isoBox, isoTile, isoWall, screenPanel } from "../core/iso.js";
import { adoptDetailText, makeSign } from "../core/signs.js";
import { registerStation } from "../core/registry.js";
import type { DioramaContext } from "../core/context.js";

export interface ReconciliationApi {
  /** Retained: aligned flashes green, drift goes amber and summons recovery. */
  compare(aligned: boolean): void;
  /**
   * Primary phase surface: doorbell rings the invalidation (with its reason,
   * e.g. "reconcile:after_fill"), refetching pulls the canonical account
   * view, aligned confirms, drift stays visibly amber. Transitions arrive
   * only from sceneBindings; the station never self-schedules them.
   */
  phase(p: "doorbell" | "refetching" | "aligned" | "drift", reason?: string): void;
}

export type ProtectionLabel = "Stop on exchange" | "Server-executed" | "Unprotected";

/** Ops-local extension: a board element pulses after a fill or refetch. */
export interface PortfolioVaultApi {
  pulse(block: "capital" | "realized" | "unrealized" | "balance"): void;
  /** The protection label row; the label itself is registered detail. */
  setProtection(label: ProtectionLabel): void;
  /**
   * Empty vs populated board: the position rows and the resting order render
   * only after a refetched account view with an open position; otherwise the
   * board shows its honest "No open position" empty state.
   */
  setPopulated(has: boolean): void;
}

export interface AuditArchiveApi {
  /** Flash the newest history row. */
  glowPulse(): void;
  /** Append a mission event row; the kind string is shown verbatim. */
  appendRow(kind: string): void;
  /**
   * Archiver health line: flips "Archiver healthy" / "Archiver degraded" and
   * the dot color with it. Initial state is healthy.
   */
  setArchiveHealth(healthy: boolean): void;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

type Killable = gsap.core.Timeline | gsap.core.Tween;

/** Duration helper: near-instant when reduced motion is requested. */
let reduced = false;
const d = (seconds: number): number => (reduced ? 0.04 : seconds);

interface IdleLoop {
  period: number;
  phase: number;
  last: number;
  fire: () => void;
}

const idleLoops: IdleLoop[] = [];
/** Register a deterministic idle loop: fires once per period, phase-offset. */
function every(period: number, phase: number, fire: () => void): void {
  idleLoops.push({ period, phase, last: -1, fire });
}

const animatedTargets: object[] = [];
const timers: Killable[] = [];
const track = <T extends Killable>(k: T): T => {
  timers.push(k);
  return k;
};

interface StationParts {
  root: Container;
  hit: Graphics;
}

/** Root container at the anchor with a transparent local iso-diamond hit. */
function stationBase(ctx: DioramaContext, id: StationId): StationParts {
  const def = STATIONS[id];
  const root = new Container();
  root.position.set(def.anchor.x, def.anchor.y);
  root.zIndex = def.anchor.y + DEPTH.base;
  ctx.layers.sortable.addChild(root);

  const hit = new Graphics();
  const hw = def.size.w / 2;
  const hd = def.size.d / 2;
  hit.poly([0, -hd, hw, 0, 0, hd, -hw, 0]);
  hit.fill({ color: 0xffffff, alpha: 0.004 });
  hit.eventMode = "static";
  hit.cursor = "pointer";
  root.addChild(hit);
  return { root, hit };
}

/** Signboard above the tallest point of the structure, in the labels layer. */
function stationSign(
  ctx: DioramaContext,
  id: StationId,
  rise: number,
  dx = 0,
  accent: number = PALETTE.aqua,
): void {
  const def = STATIONS[id];
  const sign = makeSign(def.label, {
    x: def.anchor.x + dx,
    y: def.anchor.y - rise,
    size: def.signSize,
    accent,
    lod: def.lod,
    stationId: id,
  });
  sign.zIndex = def.anchor.y + DEPTH.overlay;
  ctx.layers.labels.addChild(sign);
}

/**
 * Registered detail text (freeze §5): station screen copy, adopted into the
 * sign registry under the building station's id, so tier gating, focus
 * forcing, and focus dimming all flow through the shared policy. The owner is
 * set around each builder call in buildOpsDistrict; every piece of screen
 * copy is produced through this helper.
 */
let detailOwner = "";

function detailText(text: string, size: number, fill: number): Text {
  const t = new Text({
    text,
    style: new TextStyle({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: size,
      letterSpacing: size * 0.08,
      fill,
    }),
  });
  t.resolution = 2;
  adoptDetailText(t, detailOwner);
  return t;
}

/** Run a builder with detailText strings attributed to one station. */
function buildWithOwner<T>(id: StationId, build: () => T): T {
  const previous = detailOwner;
  detailOwner = id;
  try {
    return build();
  } finally {
    detailOwner = previous;
  }
}

/**
 * Soft dark ground ellipse rendered right after the hit surface so every
 * substantial structure visibly sits on its platform.
 */
function contactShadow(
  root: Container,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha = 0.27,
): void {
  const g = new Graphics();
  g.ellipse(x, y, w / 2, h / 2);
  g.fill({ color: 0x03080f, alpha });
  root.addChild(g);
}

// ===========================================================================
// 1. RECONCILE: doorbell, canonical refetch, aligned/drift (hero, overview)
// ===========================================================================

function buildReconciliationDock(ctx: DioramaContext): ReconciliationApi {
  const { root, hit } = stationBase(ctx, "reconciliationDock");

  contactShadow(root, 6, 12, 220, 128);
  // Dock platform.
  root.addChild(
    isoBox({
      x: 0,
      y: 0,
      w: 180,
      d: 110,
      h: 10,
      color: PALETTE.structure,
      rim: PALETTE.structureLight,
    }),
  );
  root.addChild(isoTile(0, -10, 180, 110, PALETTE.structureLight, 1, PALETTE.healthy));

  // East belt carrying local expected state (pale slip) from positions.
  const belt = new Graphics();
  belt.rect(52, -16, 74, 8);
  belt.fill({ color: PALETTE.structure });
  for (let i = 0; i < 5; i++) {
    belt.rect(56 + i * 15, -14, 7, 4);
    belt.fill({ color: 0x2a4a66 });
  }
  root.addChild(belt);
  const localSlip = new Graphics();
  localSlip.roundRect(112, -20, 10, 14, 1.5);
  localSlip.fill({ color: PALETTE.surfacePale, alpha: 0.95 });
  localSlip.rect(114, -16, 6, 1.2);
  localSlip.fill({ color: PALETTE.structure, alpha: 0.85 });
  root.addChild(localSlip);

  // Curved aqueduct carrying the exchange's authoritative state in from the
  // north-east, where the docked exchange booth sits.
  const aqueduct = new Graphics();
  aqueduct.moveTo(66, 2);
  aqueduct.quadraticCurveTo(34, 10, 6, 16);
  aqueduct.stroke({ width: 9, color: PALETTE.structure, alpha: 1 });
  aqueduct.moveTo(66, 2);
  aqueduct.quadraticCurveTo(34, 10, 6, 16);
  aqueduct.stroke({ width: 5, color: PALETTE.aqua, alpha: 0.5 });
  root.addChild(aqueduct);
  const aqueductGlow = glow(36, 9, 34, PALETTE.aqua, 0);
  root.addChild(aqueductGlow);
  // Dedicated idle shimmer on the aqueduct water. Kept separate from
  // aqueductGlow so a purely visual idle can never collide with the
  // refetching phase animation.
  const idleShimmer = glow(36, 9, 22, PALETTE.aqua, 0);
  root.addChild(idleShimmer);

  // Authoritative-state dot: rides the aqueduct during a refetch.
  const exDot = new Sprite(dotTexture());
  exDot.anchor.set(0.5);
  exDot.width = 14;
  exDot.height = 14;
  exDot.tint = PALETTE.aqua;
  exDot.position.set(24, 8);
  root.addChild(exDot);

  // Glowing pipeline segment along the south dock edge.
  const pipeline = new Graphics();
  for (let i = 0; i < 5; i++) {
    const px = -60 + i * 26;
    pipeline.rect(px, 52, 18, 5);
    pipeline.fill({ color: PALETTE.structureLight });
    pipeline.rect(px + 18, 52, 6, 5);
    pipeline.fill({ color: PALETTE.structure });
  }
  pipeline.rect(-62, 53.5, 160, 1.4);
  pipeline.fill({ color: PALETTE.healthy, alpha: 0.8 });
  root.addChild(pipeline);
  root.addChild(glow(-20, 55, 40, PALETTE.healthy, 0.3));

  // Comparison bench with a balance-scale motif.
  root.addChild(isoBox({ x: 0, y: -8, w: 44, d: 26, h: 14, color: PALETTE.structureLight }));
  const scaleG = new Graphics();
  scaleG.rect(-1, -38, 2, 16);
  scaleG.fill({ color: PALETTE.surfacePale });
  const beam = new Container();
  beam.position.set(0, -38);
  const beamG = new Graphics();
  beamG.rect(-16, -1, 32, 2);
  beamG.fill({ color: PALETTE.surfacePale });
  beamG.rect(-18, 1, 5, 2);
  beamG.fill({ color: PALETTE.surfacePale, alpha: 0.8 });
  beamG.rect(13, 1, 5, 2);
  beamG.fill({ color: PALETTE.surfacePale, alpha: 0.8 });
  beam.addChild(beamG);
  root.addChild(scaleG, beam);

  // Amber drift wash (hidden until drift), receipt pop, beacon, and the
  // recovery arm (drift summons recovery instead of a separate workshop).
  const driftWash = isoTile(0, -10, 180, 110, PALETTE.warning, 0);
  root.addChild(driftWash);
  const popReceipt = new Graphics();
  popReceipt.roundRect(-5, -33, 10, 14, 1.5);
  popReceipt.fill({ color: PALETTE.surfacePale, alpha: 0.95 });
  popReceipt.rect(-3, -30, 6, 1.2);
  popReceipt.fill({ color: PALETTE.healthy, alpha: 0.95 });
  popReceipt.alpha = 0;
  root.addChild(popReceipt);
  const beacon = glow(-70, -60, 26, PALETTE.warning, 0);
  const beaconPost = new Graphics();
  beaconPost.rect(-71, -48, 2, 30);
  beaconPost.fill({ color: PALETTE.structureLight });
  beaconPost.circle(-70, -52, 3);
  beaconPost.fill({ color: PALETTE.warning, alpha: 0.9 });
  root.addChild(beaconPost, beacon);
  const dispatchArm = new Container();
  dispatchArm.position.set(-78, 14);
  const dArm = new Graphics();
  dArm.rect(0, -1.5, 30, 3);
  dArm.fill({ color: PALETTE.structureLight });
  dArm.circle(0, 0, 3.5);
  dArm.fill({ color: PALETTE.orange });
  dArm.circle(29, 0, 2.5);
  dArm.fill({ color: PALETTE.orange });
  dispatchArm.addChild(dArm);
  dispatchArm.angle = -20;
  root.addChild(dispatchArm);

  // Doorbell at the west approach: invalidation rings it.
  const bellPost = new Graphics();
  bellPost.rect(-87, 0, 2, 18);
  bellPost.fill({ color: PALETTE.structureLight });
  const bellDome = new Graphics();
  bellDome.arc(-86, 0, 6, Math.PI, 0);
  bellDome.fill({ color: PALETTE.waiting, alpha: 0.9 });
  root.addChild(bellPost, bellDome);
  const bellGlow = glow(-86, -3, 22, PALETTE.waiting, 0);
  root.addChild(bellGlow);

  // Phase chip: the registered detail state line ("Refetching account",
  // "Aligned", the invalidation reason such as "reconcile:after_fill").
  const phaseChip = new Container();
  phaseChip.position.set(0, 76);
  const chipBg = new Graphics();
  chipBg.roundRect(-64, -10, 128, 20, 4);
  chipBg.fill({ color: PALETTE.space, alpha: 0.88 });
  chipBg.roundRect(-64, -10, 128, 20, 4);
  chipBg.stroke({ width: 1.2, color: 0xffffff, alpha: 0.85 });
  phaseChip.addChild(chipBg);
  const chipText = detailText("Aligned", 6.5, 0xffffff);
  chipText.anchor.set(0.5);
  chipText.tint = PALETTE.healthy;
  phaseChip.addChild(chipText);
  root.addChild(phaseChip);

  const setChip = (text: string, color: number): void => {
    gsap.killTweensOf([phaseChip, phaseChip.scale]);
    chipText.text = text.slice(0, 30);
    chipText.tint = color;
    chipBg.tint = color;
    phaseChip.scale.set(0.85);
    track(gsap.to(phaseChip.scale, { x: 1, y: 1, duration: d(0.3), ease: "back.out(2.4)" }));
  };

  const api: ReconciliationApi = {
    compare(aligned) {
      api.phase(aligned ? "aligned" : "drift");
    },
    phase(p, reason) {
      [beam, driftWash, beacon, dispatchArm, bellGlow, aqueductGlow, exDot, localSlip].forEach(
        (t) => {
          animatedTargets.push(t);
          gsap.killTweensOf(t);
        },
      );
      if (p === "doorbell") {
        setChip(reason ?? "reconcile:manual", PALETTE.waiting);
        bellGlow.alpha = 0.9;
        track(
          gsap.to(bellGlow, {
            alpha: 0,
            duration: d(0.35),
            repeat: 3,
            yoyo: true,
            ease: "sine.inOut",
          }),
        );
        return;
      }
      if (p === "refetching") {
        setChip("Refetching account", PALETTE.cyan);
        aqueductGlow.alpha = 0.6;
        track(gsap.to(aqueductGlow, { alpha: 0, duration: d(0.9), ease: "sine.out" }));
        // The authoritative view rides the aqueduct down to the bench.
        exDot.alpha = 1;
        exDot.position.set(66, 2);
        const ride = track(gsap.timeline());
        timers.push(ride);
        ride
          .to(exDot, { x: 36, y: 9, duration: d(0.24), ease: "none" })
          .to(exDot, { x: 24, y: 8, duration: d(0.24), ease: "none" });
        return;
      }
      if (p === "aligned") {
        setChip("Aligned", PALETTE.healthy);
        beam.angle = 0;
        localSlip.tint = PALETTE.healthy;
        exDot.tint = PALETTE.healthy;
        track(gsap.to(exDot, { width: 18, height: 18, duration: d(0.25), yoyo: true, repeat: 1 }));
        popReceipt.alpha = 1;
        popReceipt.y = -26;
        track(
          gsap.to(popReceipt, {
            alpha: 0,
            y: -33,
            duration: d(0.6),
            delay: d(1.2),
            onComplete: () => {
              localSlip.tint = 0xffffff;
              exDot.tint = PALETTE.aqua;
            },
          }),
        );
        return;
      }
      // Drift stays visibly amber and summons recovery; never dressed as
      // success.
      setChip(reason ?? "Drift detected", PALETTE.warning);
      driftWash.tint = 0xffffff;
      gsap.to(driftWash, {
        alpha: 0.55,
        duration: d(0.4),
        onComplete: () => gsap.to(driftWash, { alpha: 0, duration: d(1.6), delay: d(1.6) }),
      });
      beam.angle = 9;
      gsap.to(localSlip, { x: 100, duration: d(0.4) });
      gsap.to(exDot, { x: 34, duration: d(0.4) });
      gsap.to(beacon, {
        alpha: 0.9,
        duration: d(0.5),
        repeat: 5,
        yoyo: true,
        onComplete: () => gsap.set(beacon, { alpha: 0 }),
      });
      gsap.to(dispatchArm, {
        angle: 42,
        duration: d(0.5),
        onComplete: () => gsap.to(dispatchArm, { angle: -20, duration: d(0.8), delay: d(2.2) }),
      });
    },
  };

  // Idle stays purely visual: the aqueduct water shimmers once in a while.
  // It never traverses semantic phases — doorbell/refetching/aligned arrive
  // only from sceneBindings (freeze addendum §B).
  every(12, 4, () => {
    if (ctx.reducedMotion) return;
    animatedTargets.push(idleShimmer);
    gsap.killTweensOf(idleShimmer);
    gsap
      .timeline()
      .fromTo(idleShimmer, { alpha: 0 }, { alpha: 0.28, duration: 1.3, ease: "sine.inOut" })
      .to(idleShimmer, { alpha: 0, duration: 1.1, ease: "sine.inOut" });
  });

  stationSign(ctx, "reconciliationDock", 74, 0, PALETTE.yellow);
  registerStation({ id: "reconciliationDock", root, hit, api });
  return api;
}

// ===========================================================================
// 2. POSITIONS: positions + open orders board with the protection label
// ===========================================================================

const PROTECTION_META: Record<ProtectionLabel, { color: number }> = {
  "Stop on exchange": { color: PALETTE.healthy },
  "Server-executed": { color: PALETTE.waiting },
  Unprotected: { color: PALETTE.blocked },
};

function buildPortfolioVault(ctx: DioramaContext): PortfolioVaultApi {
  const { root, hit } = stationBase(ctx, "portfolioVault");

  contactShadow(root, 4, 8, 160, 104);
  // Vault plinth + glass case (low-alpha walls, gold frame edges).
  root.addChild(
    isoBox({ x: 0, y: 0, w: 138, d: 96, h: 8, color: PALETTE.structure, rim: PALETTE.yellow }),
  );
  const glass = { color: 0x8fd8e8, alpha: 0.12, rim: PALETTE.yellow };
  root.addChild(isoWall({ x1: -56, y1: -36, x2: -56, y2: 34, h: 36, ...glass }));
  root.addChild(isoWall({ x1: 56, y1: -36, x2: 56, y2: 34, h: 36, ...glass }));
  root.addChild(isoWall({ x1: -56, y1: -36, x2: 56, y2: -36, h: 36, ...glass }));

  // Positions panel: side bar, size, P&L rows (registered detail). The rows
  // live in a group so the board can render honestly empty until a refetched
  // account view with an open position populates it.
  root.addChild(screenPanel({ x: -58, y: -60, w: 54, h: 46, accent: PALETTE.healthy }));
  const posHeader = detailText("Positions", 6, PALETTE.inkDim);
  posHeader.anchor.set(0, 0.5);
  posHeader.position.set(-54, -54);
  root.addChild(posHeader);
  const emptyLine = detailText("No open position", 6.5, PALETTE.inkDim);
  emptyLine.anchor.set(0, 0.5);
  emptyLine.position.set(-46, -37);
  root.addChild(emptyLine);
  const rowsGroup = new Container();
  root.addChild(rowsGroup);
  const ROW_Y = [-44, -31];
  const rowBars: Graphics[] = [];
  const rowGlows: Sprite[] = [];
  ROW_Y.forEach((ry, i) => {
    const bar = new Graphics();
    bar.rect(-54, ry - 4, 4, 9);
    bar.fill({ color: i === 0 ? PALETTE.healthy : PALETTE.blocked, alpha: 0.95 });
    rowsGroup.addChild(bar);
    rowBars.push(bar);
    const size = detailText(i === 0 ? "0.5 ETH" : "0.2 ETH", 6.5, PALETTE.ink);
    size.anchor.set(0, 0.5);
    size.position.set(-46, ry + 0.5);
    rowsGroup.addChild(size);
    const pnl = detailText(i === 0 ? "+12.4" : "-3.1", 6.5, PALETTE.ink);
    pnl.anchor.set(1, 0.5);
    pnl.position.set(-8, ry + 0.5);
    rowsGroup.addChild(pnl);
    rowGlows.push(glow(-28, ry, 30, i === 0 ? PALETTE.healthy : PALETTE.blocked, 0));
    rowsGroup.addChild(rowGlows[i]);
  });

  // Open-orders panel: one resting order line (populated state only).
  root.addChild(screenPanel({ x: 4, y: -60, w: 54, h: 46, accent: PALETTE.cyan }));
  const ordHeader = detailText("Open orders", 6, PALETTE.inkDim);
  ordHeader.anchor.set(0, 0.5);
  ordHeader.position.set(8, -54);
  root.addChild(ordHeader);
  const orderGroup = new Container();
  root.addChild(orderGroup);
  const orderCard = new Graphics();
  orderCard.roundRect(8, -48, 8, 10, 1.5);
  orderCard.fill({ color: PALETTE.cyan, alpha: 0.35 });
  orderCard.roundRect(8, -48, 8, 10, 1.5);
  orderCard.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.9 });
  orderGroup.addChild(orderCard);
  const orderLine = detailText("Buy 0.2", 6.5, PALETTE.ink);
  orderLine.anchor.set(0, 0.5);
  orderLine.position.set(20, -43);
  orderGroup.addChild(orderLine);
  const orderGlow = glow(31, -42, 26, PALETTE.cyan, 0);
  orderGroup.addChild(orderGlow);
  // Initial state is EMPTY: the vault invents no exposure.
  rowsGroup.visible = false;
  orderGroup.visible = false;

  // Protection label row at the case front (registered detail).
  const protChip = new Container();
  protChip.position.set(0, 46);
  const protBg = new Graphics();
  protBg.roundRect(-42, -9, 84, 18, 3);
  protBg.fill({ color: PALETTE.space, alpha: 0.88 });
  protBg.roundRect(-42, -9, 84, 18, 3);
  protBg.stroke({ width: 1.2, color: 0xffffff, alpha: 0.85 });
  protChip.addChild(protBg);
  const protText = detailText("Stop on exchange", 6.5, 0xffffff);
  protText.anchor.set(0.5);
  protChip.addChild(protText);
  root.addChild(protChip);
  const capitalGlow = glow(0, -66, 70, PALETTE.yellow, 0);
  root.addChild(capitalGlow);

  const setProt = (label: ProtectionLabel): void => {
    gsap.killTweensOf([protChip, protChip.scale]);
    protText.text = label;
    const color = PROTECTION_META[label].color;
    protText.tint = color;
    protBg.tint = color;
    protChip.scale.set(0.85);
    track(gsap.to(protChip.scale, { x: 1, y: 1, duration: d(0.3), ease: "back.out(2.4)" }));
  };
  setProt("Stop on exchange");

  const flash = (s: Sprite): void => {
    animatedTargets.push(s);
    gsap.killTweensOf(s);
    s.alpha = 0.6;
    gsap.to(s, { alpha: 0, duration: d(0.9), delay: d(0.4) });
  };

  const api: PortfolioVaultApi = {
    pulse(block) {
      if (block === "capital") flash(capitalGlow);
      else if (block === "realized") flash(rowGlows[0]);
      else if (block === "unrealized") flash(rowGlows[1]);
      else flash(orderGlow);
    },
    setProtection(label) {
      setProt(label);
    },
    setPopulated(has) {
      rowsGroup.visible = has;
      orderGroup.visible = has;
      emptyLine.visible = !has;
    },
  };

  stationSign(ctx, "portfolioVault", 84);
  registerStation({ id: "portfolioVault", root, hit, api });
  return api;
}

// ===========================================================================
// 3. HISTORY: demoted mission event ledger, net P&L, archiver health
// ===========================================================================

const ROW_COUNT = 4;

function buildAuditArchive(ctx: DioramaContext): AuditArchiveApi {
  const { root, hit } = stationBase(ctx, "auditArchive");

  contactShadow(root, 0, -2, 196, 56);
  // Ledger board (billboard wall, biased east so its west corner clears the
  // pocket seam).
  const board = new Graphics();
  board.roundRect(-86, -84, 172, 88, 4);
  board.fill({ color: PALETTE.structure });
  board.roundRect(-86, -84, 172, 88, 4);
  board.stroke({ width: 1.5, color: PALETTE.structureLight, alpha: 0.7 });
  root.addChild(board);

  // Mission event rows; the newest sits at the bottom and glows.
  const rowYs: number[] = [];
  for (let i = 0; i < ROW_COUNT; i++) rowYs.push(-68 + i * 14);
  const rowTexts: Text[] = [];
  const initialRows = ["mission created", "order filled", "reconciled", "position open"];
  rowYs.forEach((ry, i) => {
    const tick = new Graphics();
    tick.poly([0, -2.2, 2.2, 0, 0, 2.2, -2.2, 0]);
    tick.fill({ color: PALETTE.aqua, alpha: 0.85 });
    tick.position.set(-76, ry);
    root.addChild(tick);
    const t = detailText(initialRows[i], 7, PALETTE.ink);
    t.anchor.set(0, 0.5);
    t.position.set(-68, ry);
    root.addChild(t);
    rowTexts.push(t);
  });
  const newestGlow = glow(-30, rowYs[ROW_COUNT - 1], 96, PALETTE.aqua, 0.3);
  root.addChild(newestGlow);

  // Net P&L line + one quiet archiver-health line.
  const divider = new Graphics();
  divider.moveTo(-78, -16);
  divider.lineTo(78, -16);
  divider.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.3 });
  root.addChild(divider);
  const pnlLabel = detailText("NET P&L", 6.5, PALETTE.inkDim);
  pnlLabel.anchor.set(0, 0.5);
  pnlLabel.position.set(-76, -6);
  root.addChild(pnlLabel);
  const pnlValue = detailText("+2.4%", 6.5, PALETTE.healthy);
  pnlValue.anchor.set(1, 0.5);
  pnlValue.position.set(78, -6);
  root.addChild(pnlValue);
  const healthDot = new Graphics();
  healthDot.circle(-52, 16, 2.2);
  healthDot.fill({ color: PALETTE.healthy });
  root.addChild(healthDot);
  const healthGlow = glow(-52, 16, 12, PALETTE.healthy, 0.25);
  root.addChild(healthGlow);
  const healthText = detailText("Archiver healthy", 6.5, PALETTE.inkDim);
  healthText.anchor.set(0, 0.5);
  healthText.position.set(-46, 16);
  root.addChild(healthText);
  // Health is a single source of truth: text and dot color flip together.
  const setHealth = (healthy: boolean): void => {
    const color = healthy ? PALETTE.healthy : PALETTE.blocked;
    healthDot.clear();
    healthDot.circle(-52, 16, 2.2);
    healthDot.fill({ color });
    healthGlow.tint = color;
    healthText.text = healthy ? "Archiver healthy" : "Archiver degraded";
  };
  if (!ctx.reducedMotion) {
    track(
      gsap.to(healthGlow, {
        alpha: 0.5,
        duration: 2.8,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      }),
    );
  }

  stationSign(ctx, "auditArchive", 104);

  const flashNewest = (): void => {
    animatedTargets.push(newestGlow);
    gsap.killTweensOf(newestGlow);
    newestGlow.alpha = 0.6;
    gsap.to(newestGlow, { alpha: 0.3, duration: d(1.0), delay: d(0.3) });
  };

  const api: AuditArchiveApi = {
    glowPulse() {
      flashNewest();
    },
    appendRow(kind) {
      for (let i = 0; i < ROW_COUNT - 1; i++) rowTexts[i].text = rowTexts[i + 1].text;
      const newest = rowTexts[ROW_COUNT - 1];
      newest.text = kind.slice(0, 24);
      newest.tint = PALETTE.healthy;
      animatedTargets.push(newest);
      gsap.to(newest, { tint: 0xffffff, duration: d(1.2), delay: d(0.4) });
      flashNewest();
    },
    setArchiveHealth(healthy) {
      setHealth(healthy);
    },
  };

  // Quiet index shimmer: the ledger breathes through its rows once in a
  // while; no comedy, no per-frame redraw.
  const shimmer = glow(0, -46, 30, PALETTE.aqua, 0);
  root.addChild(shimmer);
  every(13, 1.8, () => {
    if (ctx.reducedMotion) return;
    animatedTargets.push(shimmer);
    rowYs.forEach((ry, i) => {
      gsap.fromTo(
        shimmer,
        { alpha: 0 },
        {
          alpha: 0.3,
          duration: 0.4,
          delay: i * 0.8,
          onStart: () => shimmer.position.set(-20, ry),
          onComplete: () => gsap.to(shimmer, { alpha: 0, duration: 0.5 }),
        },
      );
    });
  });

  registerStation({ id: "auditArchive", root, hit, api });
  return api;
}

// ===========================================================================
// District entry
// ===========================================================================

export function buildOpsDistrict(ctx: DioramaContext): void {
  // Module state must not survive a route teardown: under Astro client-side
  // routing this module persists, and stale loops/targets would keep firing
  // closures over destroyed Pixi objects in the next visit's ticker.
  reduced = ctx.reducedMotion;
  idleLoops.length = 0;
  animatedTargets.length = 0;
  timers.length = 0;

  buildWithOwner("reconciliationDock", () => buildReconciliationDock(ctx));
  buildWithOwner("portfolioVault", () => buildPortfolioVault(ctx));
  buildWithOwner("auditArchive", () => buildAuditArchive(ctx));

  // One shared ticker drives every idle loop with its own phase offset.
  let t = 0;
  ctx.onTick((ticker) => {
    t += ticker.deltaMS / 1000;
    for (const loop of idleLoops) {
      const idx = Math.floor((t + loop.phase) / loop.period);
      if (idx > loop.last) {
        loop.last = idx;
        loop.fire();
      }
    }
  });

  ctx.onCleanup(() => {
    for (const target of animatedTargets) gsap.killTweensOf(target);
    for (const timer of timers) timer.kill();
    idleLoops.length = 0;
    animatedTargets.length = 0;
    timers.length = 0;
  });
}
