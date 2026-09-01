/**
 * Sign kit: all signage renders as real Pixi Text on small boards so words
 * stay crisp at every zoom and remain replaceable/localizable. Never bake
 * text into Graphics or generated art.
 *
 * Typography: JetBrains Mono (system signage, uppercase, tracked) and
 * DM Sans (descriptions), matching the marketing site fonts.
 *
 * LOD: every sign belongs to a lod class that decides at which camera zoom
 * tier it is visible. "zoom" signs (the default for xs/sm boards) hide at
 * fit view so phone-width frames are not a wall of shouting labels; "fit"
 * (md/lg/xl default) and "always" (banners, explicit) stay visible. Drivers
 * call setSignLod with the camera tier.
 */
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import gsap from "gsap";
import { PALETTE } from "../config/palette.js";
import { glow } from "./iso.js";

export type SignSize = "xs" | "sm" | "md" | "lg" | "xl";

/** LOD class: at which camera zoom tiers the sign is visible. */
export type SignLod = "always" | "fit" | "zoom";

/** Camera LOD tier: 0 = fit view, 1 = mid zoom, 2 = deep zoom. */
export type SignLodLevel = 0 | 1 | 2;

const SIZE_MAP: Record<SignSize, { fontSize: number; padX: number; padY: number; board: number }> = {
  xs: { fontSize: 12, padX: 7, padY: 3, board: 1 },
  sm: { fontSize: 14, padX: 9, padY: 4, board: 1 },
  md: { fontSize: 18, padX: 12, padY: 5, board: 1.5 },
  lg: { fontSize: 25, padX: 18, padY: 7, board: 2 },
  xl: { fontSize: 36, padX: 26, padY: 10, board: 2.5 },
};

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
   * LOD class. Omitted: derived from size (xs/sm -> "zoom", else "fit") so
   * existing callers get fit-view decluttering without signature changes.
   */
  lod?: SignLod;
}

interface SignEntry {
  root: Container;
  lod: SignLod;
}

/** All live signs; pruned lazily when their roots leave the display tree. */
const registry: SignEntry[] = [];
let lodLevel: SignLodLevel = 0;

const reducedMotion = (): boolean =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Size-derived default so small station labels declutter at fit zoom. */
const lodForSize = (size: SignSize): SignLod => (size === "xs" || size === "sm" ? "zoom" : "fit");

const visibleAt = (lod: SignLod, level: SignLodLevel): boolean => lod !== "zoom" || level >= 1;

function registerSign(root: Container, lod: SignLod): void {
  registry.push({ root, lod });
  // Late-built signs must respect the tier already in effect.
  root.alpha = visibleAt(lod, lodLevel) ? 1 : 0;
}

/**
 * Set the camera LOD tier. Fades "zoom" signs in/out over ~0.25 s; snaps
 * under reduced motion. Safe to call repeatedly; destroyed roots (parent
 * cleared by teardown) are dropped here.
 */
export function setSignLod(level: SignLodLevel): void {
  if (level === lodLevel) return;
  lodLevel = level;
  const snap = reducedMotion();
  for (let i = registry.length - 1; i >= 0; i--) {
    const entry = registry[i];
    if (entry.root.parent === null) {
      gsap.killTweensOf(entry.root);
      registry.splice(i, 1);
      continue;
    }
    // Only "zoom" signs change visibility; "fit"/"always" entries are left
    // untouched so banner focus-dimming never fights the LOD tween.
    if (entry.lod !== "zoom") continue;
    const target = visibleAt(entry.lod, lodLevel) ? 1 : 0;
    if (snap) {
      gsap.killTweensOf(entry.root);
      entry.root.alpha = target;
    } else {
      gsap.to(entry.root, { alpha: target, duration: 0.25, ease: "power1.out", overwrite: "auto" });
    }
  }
}

const signStyle = (fontSize: number, color: number): TextStyle =>
  new TextStyle({
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize,
    fontWeight: "500",
    letterSpacing: fontSize * 0.14,
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
    lod,
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
  registerSign(c, lod ?? lodForSize(size));
  return c;
}

/**
 * Large district banner: bigger board with a double accent rule beneath.
 * Used for HYPERLIQUID TESTNET and district titles. Banners default to
 * lod "always": they are the wayfinding layer and never declutter.
 */
export function makeBanner(
  text: string,
  x: number,
  y: number,
  accent: number,
  sub?: string,
  lod: SignLod = "always",
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
  return c;
}
