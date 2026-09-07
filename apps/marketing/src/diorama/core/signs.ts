/**
 * Sign kit: all signage renders as real Pixi Text on small boards so words
 * stay crisp at every zoom and remain replaceable/localizable. Never bake
 * text into Graphics or generated art.
 *
 * Typography: JetBrains Mono (system signage, uppercase, tracked) and
 * DM Sans (descriptions), matching the marketing site fonts.
 *
 * LOD policy (freeze cycle-4 §5): every sign declares an explicit policy
 * class instead of deriving importance from font size:
 *   "overview" — the fit-view boards; visible at every tier.
 *   "zoom"     — station boards revealed from tier 1 (>=1.15).
 *   "detail"   — registered screen/caption copy revealed from tier 2 (>=1.8).
 *   "always"   — genuinely permanent signage (nothing uses it today).
 *
 * Focus override: while a station is focused, its signs force visible at any
 * tier and every other registered board/detail dims, so the room reads as
 * "this station, context dimmed". ui/interaction.ts owns the override; the
 * tier rule resumes when it clears. No free-floating Pixi Text may bypass
 * registration.
 */
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import gsap from "gsap";
import { PALETTE } from "../config/palette.js";
import { glow } from "./iso.js";

export type SignSize = "xs" | "sm" | "md" | "lg" | "xl";

/** Policy class: at which camera zoom tiers the sign is visible. */
export type SignLod = "overview" | "zoom" | "detail" | "always";

/** Camera LOD tier: 0 = fit view, 1 = mid zoom, 2 = deep zoom. */
export type SignLodLevel = 0 | 1 | 2;

const SIZE_MAP: Record<SignSize, { fontSize: number; padX: number; padY: number; board: number }> =
  {
    xs: { fontSize: 12, padX: 7, padY: 3, board: 1 },
    sm: { fontSize: 14, padX: 9, padY: 4, board: 1 },
    md: { fontSize: 18, padX: 12, padY: 5, board: 1.5 },
    lg: { fontSize: 25, padX: 18, padY: 7, board: 2 },
    xl: { fontSize: 36, padX: 26, padY: 10, board: 2.5 },
  };

/** Alpha for boards/details unrelated to the focused station. */
const FOCUS_DIM_ALPHA = 0.15;

export interface SignOptions {
  x: number;
  y: number;
  size?: SignSize;
  /** Emissive accent color for the board edge and underglow. */
  accent?: number;
  /** Board fill; defaults to dark structural blue. */
  boardColor?: number;
  /** Soft additive halo behind the board. */
  halo?: boolean;
  /** Post/pin mount drawn beneath the board. */
  post?: boolean;
  postHeight?: number;
  align?: "center" | "left";
  /**
   * Policy class. Station builders pass `lod: def.lod` from the registry def.
   * Default "zoom" errs toward fit-view decluttering: a forgotten lod must
   * never put a non-overview board on the tier-0 screen.
   */
  lod?: SignLod;
  /** Owning station id; the focus override forces/dims by this. */
  stationId?: string;
}

export interface DetailTextOptions {
  x: number;
  y: number;
  /** Owning station id; the focus override forces/dims by this. */
  stationId?: string;
  /** Font size in world units; default 11. */
  size?: number;
  /** Fill color; default PALETTE.inkDim. */
  color?: number;
  align?: "center" | "left";
}

interface SignEntry {
  root: Container;
  lod: SignLod;
  stationId?: string;
  /** Sign text when known; the QA snapshot skips anonymous entries. */
  text?: string;
  /**
   * False only for district banners: ui/labels.ts owns their alpha (focus
   * dim to 0.35 plus tier hiding), so the sign tweens here must not fight it.
   */
  managed: boolean;
}

/** All live signs; pruned lazily when their roots leave the display tree. */
const registry: SignEntry[] = [];
let lodLevel: SignLodLevel = 0;
/** Focused station id while a focus override is active; null = tier rule. */
let focusId: string | null = null;

const reducedMotion = (): boolean =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Tier half of the visibility rule. */
const visibleAtTier = (lod: SignLod, level: SignLodLevel): boolean =>
  lod === "overview" || lod === "always" ? true : lod === "zoom" ? level >= 1 : level >= 2;

/** Resolved alpha for a live entry, or null when another module owns it. */
function alphaTargetFor(entry: SignEntry): number | null {
  if (!entry.managed) return null;
  if (focusId !== null) {
    // Focus at any tier: the focused station's overview+zoom+detail signs are
    // forced visible; unrelated boards/details stay visible but dimmed.
    return entry.stationId === focusId ? 1 : FOCUS_DIM_ALPHA;
  }
  return visibleAtTier(entry.lod, lodLevel) ? 1 : 0;
}

/** Tween (or snap) every managed entry to its resolved alpha; prunes dead roots. */
function applySignTargets(): void {
  const snap = reducedMotion();
  for (let i = registry.length - 1; i >= 0; i--) {
    const entry = registry[i];
    if (entry.root.parent === null) {
      gsap.killTweensOf(entry.root);
      registry.splice(i, 1);
      continue;
    }
    const target = alphaTargetFor(entry);
    if (target === null) continue;
    if (snap) {
      gsap.killTweensOf(entry.root);
      entry.root.alpha = target;
    } else {
      gsap.to(entry.root, { alpha: target, duration: 0.25, ease: "power1.out", overwrite: "auto" });
    }
  }
}

function registerSign(
  root: Container,
  lod: SignLod,
  stationId?: string,
  managed = true,
  text?: string,
): void {
  const entry: SignEntry = { root, lod, stationId, managed, text };
  registry.push(entry);
  // Late-built signs must respect the policy already in effect. Unmanaged
  // entries keep their constructed alpha; their owner module drives it.
  const target = alphaTargetFor(entry);
  if (target !== null) root.alpha = target;
}

/**
 * Set the camera LOD tier (fed from the camera's throttled zoom broadcast).
 * Safe to call repeatedly; under an active focus override the override rule
 * keeps governing. Destroyed roots (parent cleared by teardown) are dropped.
 */
export function setSignLod(level: SignLodLevel): void {
  if (level === lodLevel) return;
  lodLevel = level;
  applySignTargets();
}

/**
 * Focus override: force every sign owned by `stationId` visible at any tier
 * and dim all other boards/details; null restores the camera-tier rule.
 * Called by ui/interaction.ts on selection transitions.
 */
export function setFocusSignOverride(stationId: string | null): void {
  if (stationId === focusId) return;
  focusId = stationId;
  applySignTargets();
}

/**
 * Empty the sign registry, killing any in-flight tweens and resetting module
 * policy state. Repeated visits at the same tier never trigger the lazy prune
 * in applySignTargets, so destroyed roots accumulate indefinitely; the
 * diorama teardown must call this explicitly.
 */
export function clearSigns(): void {
  for (const entry of registry) gsap.killTweensOf(entry.root);
  registry.length = 0;
  lodLevel = 0;
  focusId = null;
}

const signStyle = (fontSize: number, color: number): TextStyle =>
  new TextStyle({
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize,
    fontWeight: "500",
    letterSpacing: fontSize * 0.14,
    fill: color,
  });

const detailStyle = (fontSize: number, color: number): TextStyle =>
  new TextStyle({
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize,
    fontWeight: "400",
    letterSpacing: fontSize * 0.06,
    fill: color,
  });

/**
 * Physical station signboard. Returns the container; the Text is exposed as
 * `.signText` so the interaction layer can brighten it on hover without
 * rebuilding the board.
 */
export function makeSign(text: string, opts: SignOptions): Container & { signText: Text } {
  const {
    x,
    y,
    size = "md",
    accent = PALETTE.cyan,
    boardColor = PALETTE.structure,
    halo = true,
    post = false,
    postHeight = 14,
    align = "center",
    lod = "zoom",
    stationId,
  } = opts;
  const { fontSize, padX, padY, board } = SIZE_MAP[size];
  const c = new Container() as Container & { signText: Text };
  c.position.set(x, y);
  // Signs are decoration, not hit targets: an eventMode here would make the
  // wide halo sprite swallow clicks meant for the station beneath it.

  const label = new Text({ text: text.toUpperCase(), style: signStyle(fontSize, PALETTE.ink) });
  label.resolution = 2;
  label.anchor.set(align === "center" ? 0.5 : 0, 0.5);

  const w = label.width + padX * 2;
  const h = fontSize + padY * 2;
  const bx = align === "center" ? -w / 2 : -padX;

  const boardG = new Graphics();
  if (post) {
    boardG.rect(-1.5, h / 2, 3, postHeight);
    boardG.fill({ color: PALETTE.structureLight });
  }
  // Stable dark backing plate: keeps the board readable over busy floors
  // (rails, washes, agents) instead of relying on translucency.
  boardG.roundRect(bx - 1.5, -h / 2 - 1.5, w + 3, h + 3, 5);
  boardG.fill({ color: PALETTE.space, alpha: 0.6 });
  boardG.roundRect(bx, -h / 2, w, h, 4);
  boardG.fill({ color: boardColor, alpha: 0.95 });
  boardG.roundRect(bx, -h / 2, w, h, 4);
  boardG.stroke({ width: board, color: accent, alpha: 0.9 });
  // Crisp inner rim + corner ticks for a machined feel.
  boardG.roundRect(bx + 1.5, -h / 2 + 1.5, w - 3, h - 3, 3);
  boardG.stroke({ width: 0.75, color: PALETTE.ink, alpha: 0.16 });
  boardG.moveTo(bx + 3, -h / 2 + 3);
  boardG.lineTo(bx + 3 + 5, -h / 2 + 3);
  boardG.stroke({ width: 1, color: accent, alpha: 0.5 });

  if (halo) {
    const haloS = glow(0, 0, Math.max(w * 1.5, 60), accent, 0.16);
    c.addChild(haloS);
  }
  c.addChild(boardG);
  c.addChild(label);
  c.signText = label;
  registerSign(c, lod, stationId, true, label.text);
  return c;
}

/**
 * Registered screen/caption copy (policy class "detail"): station screens
 * render their product strings through this so the text participates in the
 * tier/focus policy — visible at tier >= 2 and when its station is focused.
 * Rendered verbatim (screen copy is mixed case); embed "\n" for extra lines.
 */
export function makeDetailText(text: string, opts: DetailTextOptions): Text {
  const { x, y, stationId, size = 11, color = PALETTE.inkDim, align = "center" } = opts;
  const t = new Text({ text, style: detailStyle(size, color) });
  t.resolution = 2;
  t.anchor.set(align === "center" ? 0.5 : 0, 0.5);
  t.position.set(x, y);
  registerSign(t, "detail", stationId, true, text);
  return t;
}

/**
 * Bring an already-built Text under the detail policy without moving it.
 * Station-local text kits (e.g. west console screens) call this per string so
 * tier gating, focus forcing, and focus dimming all flow through the same
 * registry instead of each kit reimplementing the rule.
 */
export function adoptDetailText(text: Text, stationId: string): void {
  registerSign(text, "detail", stationId, true, text.text);
}

/** Read-only snapshot for the QA/debug seam: every on-screen registered text. */
export function signSnapshot(): {
  text: string;
  lod: SignLod;
  stationId?: string;
  alpha: number;
}[] {
  return registry
    .filter(
      (entry) =>
        entry.text !== undefined && entry.root.parent !== null && entry.root.visible !== false,
    )
    .map((entry) => ({
      text: entry.text as string,
      lod: entry.lod,
      stationId: entry.stationId,
      alpha: entry.root.alpha,
    }));
}

/**
 * Large district banner: bigger board with a double accent rule beneath.
 * Banners are wayfinding, not station signage: registered here for the
 * no-free-text guarantee, but alpha-exempt from the tier/focus tweens —
 * ui/labels.ts owns banner visibility (hidden at tier 0, dim on focus).
 */
export function makeBanner(
  text: string,
  x: number,
  y: number,
  accent: number,
  sub?: string,
  lod: SignLod = "zoom",
): Container & { signText: Text } {
  const c = makeSign(text, { x, y, size: "xl", accent, post: false, halo: true, lod });
  const w = c.signText.width + 48;
  const rule = new Graphics();
  rule.moveTo(-w / 2, 32);
  rule.lineTo(w / 2, 32);
  rule.stroke({ width: 2, color: accent, alpha: 0.85 });
  rule.moveTo(-w / 2, 37);
  rule.lineTo(w / 2, 37);
  rule.stroke({ width: 1, color: accent, alpha: 0.35 });
  c.addChildAt(rule, c.children.length - 1);
  if (sub) {
    const subT = new Text({
      text: sub.toUpperCase(),
      style: signStyle(14, PALETTE.inkDim),
    });
    subT.resolution = 2;
    subT.anchor.set(0.5);
    subT.position.set(0, 58);
    c.addChild(subT);
  }
  // Registered first (no-free-text sweep), then handed to labels.ts for alpha.
  const entry = registry.find((e) => e.root === c);
  if (entry) entry.managed = false;
  return c;
}
