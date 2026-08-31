/**
 * Asset pipeline. The SHIPPING art is the collaborator-painted kit:
 * plate-back.webp (actor-cleared plate), bots.png+json (29 family-state
 * sprites), props.png+json (18 semantic props) and ferry.png (painted
 * hover-ferry). Every entry still falls back to crafted procedural art so
 * the runtime never hard-fails on a missing file (contract §6), and
 * substitutions are reported for the debug overlay.
 *
 * Sheet manifests follow the validated kit schema:
 *   { "sheet": "bots.png", "sprites": { "<family>-<state>": {x,y,w,h} } }
 * Parsed tolerantly: `sprites` is the canonical key; `roles`/`props`/`frames`
 * are accepted as aliases.
 */
import { Assets, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";
import { AGENTS, FERRY as FERRY_SIZE, PROPS, WORLD } from "./config";
import type { AgentRole } from "./config/positions";

/**
 * Semantic prop keys. The 18 painted frames come from props.json; the last
 * three are procedural-only FX (no painted frame) used by stamp flashes and
 * the bridge cart.
 */
export type PropKey =
  | "order-crate"
  | "rejected-order-crate"
  | "stamped-order-crate"
  | "dossier"
  | "bell"
  | "bell-small"
  | "trade-md-sealed"
  | "trade-md-drift"
  | "reduce-only-tag"
  | "ribbon-blue"
  | "ribbon-red"
  | "lever"
  | "telescope"
  | "terminal"
  | "receipt"
  | "archive-capsule"
  | "coffee"
  | "papers"
  | "cart"
  | "x"
  | "check";

export interface BotArt {
  /** Family pose states keyed by state suffix (e.g. "neutral", "stamp"). */
  states: Readonly<Record<string, Texture>>;
  /** Contact-shadow texture (shared, soft ellipse). */
  shadow: Texture;
  /** true when every state fell back to procedural art. */
  procedural: boolean;
}

export interface AssetBundle {
  plate: Texture | null;
  /** Additive dome overlay container (sprite or procedural arcs). */
  dome: Container;
  bots: Readonly<Record<AgentRole, BotArt>>;
  props: Readonly<Record<PropKey, Texture>>;
  /** Per-key world-px scale (already normalized; multiply nothing else). */
  propScale: Readonly<Record<PropKey, number>>;
  ferry: Texture;
  ferryTexel: number;
  substituted: string[];
}

const FAMILIES: readonly AgentRole[] = [
  "analyst",
  "clerk",
  "worker",
  "guard",
  "interpreter",
  "watcher",
];

// Procedural fallback hull tints, one per family (kept from the original
// procedural pass so a missing sheet still renders a coherent cast).
const FAMILY_COLORS: Readonly<Record<AgentRole, number>> = {
  analyst: 0xd5d0c5,
  clerk: 0x7a8450,
  worker: 0xf5794a,
  guard: 0x4a5060,
  interpreter: 0x4fa3a5,
  watcher: 0x8f6beb,
};

/** Dome glass region, percentages of the world (canonical analysis). */
const DOME_BBOX: [number, number, number, number] = [17, 5, 64, 76];

function mixColor(color: number, target: number, t: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const tr = (target >> 16) & 0xff;
  const tg = (target >> 8) & 0xff;
  const tb = target & 0xff;
  return (
    (Math.round(r + (tr - r) * t) << 16) |
    (Math.round(g + (tg - g) * t) << 8) |
    Math.round(b + (tb - b) * t)
  );
}
const darken = (c: number, t = 0.22): number => mixColor(c, 0x000000, t);

/**
 * Soft contact shadow (phase 10): three stacked wide/shallow ellipses whose
 * combined center alpha lands near AGENTS.shadow.alpha — reads as a soft
 * grounding pool, never a hard dark blob.
 */
function drawShadow(g: Graphics): void {
  const a = AGENTS.shadow.alpha;
  g.ellipse(20, 6, 19, 5.4).fill({ color: 0x000000, alpha: a * 0.55 });
  g.ellipse(20, 6, 13, 3.6).fill({ color: 0x000000, alpha: a * 0.75 });
  g.ellipse(20, 6, 7.5, 2.2).fill({ color: 0x000000, alpha: a * 0.9 });
}

/** Procedural fallback body (sheet missing): simple family-tinted figure. */
function drawFallbackBody(g: Graphics, role: AgentRole): void {
  const color = FAMILY_COLORS[role];
  const dark = darken(color, 0.3);
  g.roundRect(13, 49, 9, 14, 4).fill(dark);
  g.roundRect(26, 49, 9, 14, 4).fill(dark);
  g.roundRect(4, 20, 40, 33, 14)
    .fill(color)
    .stroke({ color: darken(color, 0.55), width: 1.1, alpha: 0.55 });
  g.ellipse(24, 14, 17, 13.5)
    .fill(color)
    .stroke({ color: darken(color, 0.55), width: 1.1, alpha: 0.55 });
  g.roundRect(12, 8.5, 24, 10, 5).fill(0x2b313d);
}

function drawProp(g: Graphics, key: PropKey): void {
  switch (key) {
    case "cart":
      g.roundRect(0, 0, 34, 12, 2).fill(0x8a9296).stroke({ color: 0x4a5060, width: 1 });
      g.rect(4, 2, 26, 3).fill({ color: 0xb8bfc2, alpha: 0.6 });
      g.circle(7, 16, 4).fill(0x2b313d);
      g.circle(27, 16, 4).fill(0x2b313d);
      g.circle(7, 16, 1.4).fill(0x8a9296);
      g.circle(27, 16, 1.4).fill(0x8a9296);
      g.moveTo(33, 3).lineTo(39, -3).stroke({ width: 2, color: 0x4a5060 });
      break;
    case "x":
      g.moveTo(2, 2).lineTo(16, 16).stroke({ width: 4, color: 0xe0534c, cap: "round" });
      g.moveTo(16, 2).lineTo(2, 16).stroke({ width: 4, color: 0xe0534c, cap: "round" });
      break;
    case "check":
      g.moveTo(1, 9).lineTo(6.5, 15).stroke({ width: 4, color: 0x5bb974, cap: "round" });
      g.moveTo(6.5, 15).lineTo(17, 1.5).stroke({ width: 4, color: 0x5bb974, cap: "round" });
      break;
    default:
      // Painted keys have no procedural drawing; a missing frame renders a
      // neutral crate so the world never shows an empty hole.
      g.roundRect(0, 0, 26, 22, 3)
        .fill(0xffd166)
        .stroke({ color: darken(0xffd166, 0.35), width: 1 });
      break;
  }
}

/** Rendered at 2x so vector fallback art survives the 2.4x zoom clamp. */
function texture2x(renderer: Renderer, g: Graphics): { texture: Texture; texel: number } {
  const texture = renderer.generateTexture({ target: g, resolution: 2, antialias: true });
  return { texture, texel: 0.5 };
}

async function tryTexture(url: string): Promise<Texture | null> {
  try {
    return (await Assets.load(url)) as Texture;
  } catch {
    return null;
  }
}

interface SheetFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}
type SpriteMap = Record<string, SheetFrame>;

async function loadSheet(
  pngUrl: string,
  jsonUrl: string,
): Promise<{ sheet: Texture; frames: SpriteMap } | null> {
  try {
    // PNG first: the manifest is only fetched when its sibling raster is
    // actually present, per the accepted asset contract.
    const sheet = await tryTexture(pngUrl);
    if (!sheet) return null;
    const res = await fetch(jsonUrl);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const frames = extractSpriteMap(data);
    return frames ? { sheet, frames } : null;
  } catch {
    return null;
  }
}

/**
 * Tolerant parser for the validated manifest shape
 * ({sheet, sprites:{...}}), also accepting roles/props/frames aliases.
 */
function extractSpriteMap(data: unknown): SpriteMap | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  const inner = (obj.sprites ?? obj.roles ?? obj.props ?? obj.frames ?? obj) as unknown;
  if (typeof inner !== "object" || inner === null) return null;
  const out: SpriteMap = {};
  for (const [key, value] of Object.entries(inner as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    if (
      typeof v.x === "number" &&
      typeof v.y === "number" &&
      typeof v.w === "number" &&
      typeof v.h === "number"
    ) {
      out[key] = { x: v.x, y: v.y, w: v.w, h: v.h };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function frameTexture(sheet: Texture, frame: SheetFrame): Texture {
  return new Texture({
    source: sheet.source,
    frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
  });
}

/**
 * Additive dome overlay. The procedural specular arcs remain the DEFAULT:
 * the full painted dome-overlay.png depicts a different, larger dome than
 * the plate's and must never be composited unmasked (art-contract finding).
 * A screen-blend sheen strip may be passed in by main.ts after the dome
 * decision (phase 17).
 */
export function buildDomeOverlay(sheet: Texture | null): Container {
  const px = { x: WORLD.width / 100, y: WORLD.height / 100 };
  const [bx, by, bw, bh] = DOME_BBOX;
  const rect = { x: bx * px.x, y: by * px.y, w: bw * px.x, h: bh * px.y };
  const container = new Container();
  const cx = rect.x + rect.w / 2;

  if (sheet) {
    const s = new Sprite(sheet);
    s.position.set(rect.x, rect.y);
    s.width = rect.w;
    s.height = rect.h;
    s.blendMode = "screen";
    s.alpha = 0.85;
    container.addChild(s);
    return container;
  }

  // Upper-dome ellipse: center near the dome's vertical middle, sweep the
  // top arc. Two offset specular strokes + one fainter inner sheen + tint.
  const midY = rect.y + rect.h * 0.52;
  const rx = rect.w * 0.49;
  const ry = rect.h * 0.48;
  const arcs: Array<{
    radiusScale: number;
    width: number;
    alpha: number;
    color: number;
    phase: number;
  }> = [
    { radiusScale: 1.0, width: rect.w * 0.02, alpha: 0.12, color: 0xffffff, phase: 0.15 },
    { radiusScale: 0.86, width: rect.w * 0.014, alpha: 0.09, color: 0xffffff, phase: 0.62 },
    { radiusScale: 0.7, width: rect.w * 0.01, alpha: 0.06, color: 0x8ac5d9, phase: 0.4 },
  ];
  for (const arc of arcs) {
    const g = new Graphics();
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const t = arc.phase + (i / steps) * 0.5; // ~90 degree sweep
      const pxp = cx + Math.cos(Math.PI * 2 * t) * rx * arc.radiusScale;
      const pyp = midY + Math.sin(Math.PI * 2 * t) * ry * arc.radiusScale;
      if (i === 0) g.moveTo(pxp, pyp);
      else g.lineTo(pxp, pyp);
    }
    g.stroke({ color: arc.color, width: arc.width, alpha: arc.alpha, cap: "round" });
    g.blendMode = "add";
    container.addChild(g);
  }
  const tint = new Graphics();
  tint.ellipse(cx, midY, rx * 0.95, ry * 0.95).fill({ color: 0x8ac5d9, alpha: 0.028 });
  tint.blendMode = "add";
  container.addChild(tint);
  return container;
}

export type LoadReporter = (fraction: number) => void;

/**
 * File names known (build-time directory listing) to exist under
 * public/diorama. Anything absent is never requested, so optional art
 * produces zero console 404s while still dropping in when it lands.
 */
export type AvailableFiles = ReadonlySet<string> | null;

export async function loadAssets(
  renderer: Renderer,
  onProgress: LoadReporter,
  available: AvailableFiles,
): Promise<AssetBundle> {
  const substituted: string[] = [];
  const exists = (name: string): boolean => available === null || available.has(name);

  let plate: Texture | null = null;
  if (exists("plate-back.webp")) plate = await tryTexture("/diorama/plate-back.webp");
  if (!plate) {
    if (exists("poster.webp")) plate = await tryTexture("/diorama/poster.webp");
    substituted.push("plate-back.webp -> poster.webp (unedited reference)");
  }
  if (!plate) substituted.push("plate -> none (procedural backdrop only)");
  onProgress(0.4);

  // ------------------------------------------------------------ bots
  const botSheet =
    exists("bots.png") && exists("bots.json")
      ? await loadSheet("/diorama/bots.png", "/diorama/bots.json")
      : null;
  const shadowG = new Graphics();
  drawShadow(shadowG);
  const shadow = texture2x(renderer, shadowG).texture;

  const bots = {} as Record<AgentRole, BotArt>;
  for (const family of FAMILIES) {
    const states: Record<string, Texture> = {};
    if (botSheet) {
      for (const [key, frame] of Object.entries(botSheet.frames)) {
        if (key.startsWith(`${family}-`)) {
          states[key.slice(family.length + 1)] = frameTexture(botSheet.sheet, frame);
        }
      }
    }
    if (states.neutral) {
      bots[family] = { states, shadow, procedural: false };
    } else {
      // Fallback: one procedural body per family.
      if (!botSheet) {
        const line = "bots.png -> procedural (shipping art)";
        if (!substituted.includes(line)) substituted.push(line);
      } else {
        substituted.push(`bots.json missing ${family}-neutral -> procedural`);
      }
      const g = new Graphics();
      drawFallbackBody(g, family);
      states.neutral = texture2x(renderer, g).texture;
      bots[family] = { states, shadow, procedural: true };
    }
  }
  onProgress(0.6);

  // ------------------------------------------------------------ props
  const propsSheet =
    exists("props.png") && exists("props.json")
      ? await loadSheet("/diorama/props.png", "/diorama/props.json")
      : null;
  const propKeys = Object.keys(PROPS) as PropKey[];
  const props = {} as Record<PropKey, Texture>;
  const propScale = {} as Record<PropKey, number>;
  for (const key of propKeys) {
    const frame = propsSheet?.frames[key];
    if (propsSheet && frame) {
      props[key] = frameTexture(propsSheet.sheet, frame);
      // Normalize so the key's target size maps to the sprite's LONGEST axis.
      const longest = Math.max(frame.w, frame.h);
      propScale[key] = PROPS[key] / longest;
    } else {
      const g = new Graphics();
      drawProp(g, key);
      const rendered = texture2x(renderer, g);
      props[key] = rendered.texture;
      propScale[key] = PROPS[key] / Math.max(rendered.texture.width, rendered.texture.height);
      if (!propsSheet) {
        const line = "props.png -> procedural (shipping art)";
        if (!substituted.includes(line)) substituted.push(line);
      } else {
        substituted.push(`props.json missing sprite ${key} -> procedural`);
      }
    }
  }

  // ------------------------------------------------------------ ferry
  let ferry: Texture;
  let ferryTexel: number;
  const ferrySheet = exists("ferry.png") ? await tryTexture("/diorama/ferry.png") : null;
  if (ferrySheet) {
    ferry = ferrySheet;
    // Painted hover-ferry: whole-sprite height lands at FERRY.heightWorld
    // world px (hull waterline reads ~30 world px against the bridge).
    ferryTexel = FERRY_SIZE.heightWorld / ferrySheet.height;
  } else {
    const g = new Graphics();
    // Procedural tugboat fallback, 46x28 world px, waterline at the bottom.
    g.moveTo(2, 8)
      .lineTo(44, 8)
      .lineTo(38, 22)
      .lineTo(8, 22)
      .closePath()
      .fill(0x2a384c)
      .stroke({ color: 0x161e2a, width: 1 });
    g.rect(2, 10, 42, 2.5).fill(0xff7a45);
    g.roundRect(12, 0, 16, 9, 2)
      .fill(0xe4ded4)
      .stroke({ color: darken(0xe4ded4, 0.35), width: 0.8 });
    g.rect(26, 1, 5, 8).fill(0x4a90e2);
    g.rect(15, 3, 5, 3).fill(0x3dd6c4);
    g.circle(41, 5, 1.6).fill(0xffd166);
    ferry = texture2x(renderer, g).texture;
    ferryTexel = 1;
    substituted.push("ferry.png -> procedural (shipping art)");
  }
  onProgress(0.8);

  const domeSheet = exists("dome-glass.png") ? await tryTexture("/diorama/dome-glass.png") : null;
  if (!domeSheet) substituted.push("dome-glass.png -> procedural additive arcs");

  const dome = buildDomeOverlay(domeSheet);
  // Dome-sheen candidate (phase 17): the levels-lifted specular arcs strip
  // composites at screen blend over the upper dome — SUBTLE, on top of the
  // procedural arcs. Only present when dome-sheen.webp has been adopted.
  const sheen = exists("dome-sheen.webp") ? await tryTexture("/diorama/dome-sheen.webp") : null;
  if (sheen) {
    const px = { x: WORLD.width / 100, y: WORLD.height / 100 };
    const [bx, by, bw, bh] = DOME_BBOX;
    const s = new Sprite(sheen);
    s.anchor.set(0.5);
    // Upper-dome arc band, biased toward the dome's right shoulder.
    s.width = bw * px.x * 0.52;
    s.height = bh * px.y * 0.34;
    s.position.set((bx + bw * 0.58) * px.x, (by + bh * 0.3) * px.y);
    s.blendMode = "screen";
    s.alpha = 0.5;
    dome.addChild(s);
  } else {
    substituted.push("dome-sheen.webp -> not adopted (procedural arcs only)");
  }

  return {
    plate,
    dome,
    bots,
    props,
    propScale,
    ferry,
    ferryTexel,
    substituted,
  };
}
