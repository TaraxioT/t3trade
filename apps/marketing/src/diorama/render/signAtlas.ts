/**
 * v2 zone sign atlas (R3): one boot-generated 2048x1024 canvas texture, one
 * shared unlit material, one draw call for all 14 zone signs (codex Direct
 * Answer 6 + 09-layout-spec.md). Text is drawn once after awaiting the page
 * font; a declared fallback is reported through diagnostics if the font
 * rejects, and the atlas is never silently redrawn later.
 */

import * as THREE from "three";
import { PALETTE, PALETTE_V2 } from "../config";
import type { ResourceRegistry } from "./resources";

/** Atlas grid: 2 columns x 7 rows on a 2048x1024 canvas. */
const ATLAS_WIDTH = 2048;
const ATLAS_HEIGHT = 1024;
const COLUMNS = 2;
/** Horizontal gutter between columns (mip-bleed guard; unchanged). */
const GUTTER = 48;
/**
 * Vertical inset per row edge. Rows are only ~146px tall, so the legibility
 * fix gives the plate nearly the full row height; 10px per side still guards
 * the mip levels where the text is unreadable anyway.
 */
const GUTTER_Y = 10;

// Cell interior (fixed square-ish grid rows; gutters guard against mip bleed
// with generateMipmaps on).
const CELL_WIDTH = ATLAS_WIDTH / COLUMNS; // 1024
const CELL_HEIGHT = ATLAS_HEIGHT / 7; // ~146.3

const SIGN_FONT_SIZE = 86;
const SIGN_FONT = `600 ${SIGN_FONT_SIZE}px 'JetBrains Mono', monospace`;
/** Declared fallback if the page font cannot load; reported in diagnostics. */
const SIGN_FONT_FALLBACK = `600 ${SIGN_FONT_SIZE}px monospace`;

// Sign plate colors. #FFFFFF pure white for maximum hero-zoom contrast;
// #181B22 is the dark slate plate specified by the R3 sign-atlas contract.
const PLATE_BG = "#181B22";
const PLATE_TEXT = "#FFFFFF";

export interface SignTextEntry {
  readonly signId: string;
  readonly text: string;
  /** Underline bar color (zoneEmissive mapping per the layout spec). */
  readonly color: string;
}

/**
 * The 14 ordered sign cells. Bar colors map each sign to its zone's
 * PALETTE_V2.zoneEmissive color; RISK uses the risk zone, MANUAL CONTROL a
 * neutral mint, THE EXCHANGE slate-blue cool.
 */
export const SIGN_TEXTS: readonly SignTextEntry[] = [
  { signId: "harnessDocks", text: "HARNESS DOCKS", color: PALETTE_V2.zoneEmissive.docks },
  { signId: "greenhouse", text: "RESEARCH GREENHOUSE", color: PALETTE_V2.zoneEmissive.greenhouse },
  { signId: "activation", text: "ACTIVATION", color: PALETTE_V2.zoneEmissive.plan },
  { signId: "gauntlet", text: "THE GAUNTLET", color: PALETTE_V2.zoneEmissive.gauntlet },
  { signId: "risk", text: "RISK", color: PALETTE_V2.zoneEmissive.risk },
  { signId: "cloidMint", text: "CLOID MINT", color: PALETTE_V2.zoneEmissive.mint },
  { signId: "signerVault", text: "SIGNER VAULT", color: PALETTE_V2.zoneEmissive.mint },
  { signId: "launchBay", text: "LAUNCH BAY", color: PALETTE_V2.zoneEmissive.launch },
  { signId: "backOffice", text: "BACK OFFICE", color: PALETTE_V2.zoneEmissive.backOffice },
  { signId: "watchTower", text: "WATCH TOWER", color: PALETTE_V2.zoneEmissive.watch },
  { signId: "manualControl", text: "MANUAL CONTROL", color: PALETTE.mintBright },
  { signId: "overseer", text: "OVERSEER", color: PALETTE.brass },
  { signId: "oilBar", text: "OIL BAR", color: PALETTE_V2.zoneEmissive.oilBar },
  { signId: "exchange", text: "THE EXCHANGE", color: PALETTE.coolFill },
];

export interface SignUvRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

export interface SignAtlas {
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.MeshBasicMaterial;
  /** Cell UV rect for a signId from SIGN_TEXTS. */
  readonly uvFor: (signId: string) => SignUvRect;
  /** Which font string was actually used, plus whether it was the fallback. */
  readonly diagnostics: { readonly font: string; readonly usedFallback: boolean };
}

function cellRect(index: number): { x: number; y: number; w: number; h: number } {
  const col = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  // Canvas-space cell origin (top-left), inset by the gutter.
  return {
    x: col * CELL_WIDTH + GUTTER / 2,
    y: row * CELL_HEIGHT + GUTTER_Y,
    w: CELL_WIDTH - GUTTER,
    h: CELL_HEIGHT - GUTTER_Y * 2,
  };
}

function uvForIndex(index: number): SignUvRect {
  const cell = cellRect(index);
  // CanvasTexture has flipY = true: canvas top edge maps to v = 1.
  return {
    u0: cell.x / ATLAS_WIDTH,
    v0: 1 - (cell.y + cell.h) / ATLAS_HEIGHT,
    u1: (cell.x + cell.w) / ATLAS_WIDTH,
    v1: 1 - cell.y / ATLAS_HEIGHT,
  };
}

/**
 * Build the atlas. Async only for the font await; all drawing is synchronous
 * after it. The texture and material are registry-tracked; disposal happens
 * exclusively through registry.disposeAll().
 */
export async function createSignAtlas(registry: ResourceRegistry): Promise<SignAtlas> {
  let font = SIGN_FONT;
  let usedFallback = false;
  try {
    await document.fonts.load(SIGN_FONT, SIGN_TEXTS.map((s) => s.text).join(" "));
    await document.fonts.ready;
  } catch {
    font = SIGN_FONT_FALLBACK;
    usedFallback = true;
  }

  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_WIDTH;
  canvas.height = ATLAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("sign atlas: 2d canvas context unavailable");

  const uvById = new Map<string, SignUvRect>();

  ctx.clearRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);
  SIGN_TEXTS.forEach((sign, index) => {
    const cell = cellRect(index);
    uvById.set(sign.signId, uvForIndex(index));

    // Plate background fills the full cell (edge-to-edge inside the gutter).
    ctx.fillStyle = PLATE_BG;
    ctx.fillRect(cell.x, cell.y, cell.w, cell.h);

    // Zone-colored underline bar along the lower edge (taller for hero-zoom
    // legibility).
    const barHeight = 18;
    const barMargin = 8;
    ctx.fillStyle = sign.color;
    ctx.fillRect(cell.x, cell.y + cell.h - barHeight - barMargin, cell.w, barHeight);

    // Text layout region: cell minus bar block and generous padding so
    // descenders/overshoot never clip at any size.
    const PAD_X = 40;
    const PAD_Y = 10;
    const textAreaW = cell.w - PAD_X * 2;
    const textAreaY = cell.y + PAD_Y;
    const textAreaH = cell.h - barHeight - barMargin - PAD_Y * 2;

    // Prefer one line at full size; wrap to two lines for long names before
    // shrinking; shrink-to-fit only as a last resort. Height fit uses
    // measured glyph bounds (uppercase text has no descenders, so the em box
    // would waste most of the row height).
    const setFont = (size: number): void => {
      ctx.font = usedFallback
        ? `600 ${size}px monospace`
        : `600 ${size}px 'JetBrains Mono', monospace`;
    };
    const LINE_STEP = 1.0; // Baseline-to-baseline step for wrapped lines.
    const measureBlock = (lines: readonly string[], size: number): number => {
      setFont(size);
      let height = 0;
      for (const line of lines) {
        const m = ctx.measureText(line);
        // Uppercase: ascent from cap top, descent catches any overshoot.
        height += m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      }
      return height + (lines.length - 1) * size * LINE_STEP;
    };
    const fits = (lines: readonly string[], size: number): boolean => {
      setFont(size);
      return (
        lines.every((line) => ctx.measureText(line).width <= textAreaW) &&
        measureBlock(lines, size) <= textAreaH
      );
    };

    const words = sign.text.split(" ");
    let lines: string[] = [sign.text];
    let size = SIGN_FONT_SIZE;
    if (!fits(lines, size) && words.length > 1) {
      // Two-line wrap at the word boundary closest to half the text length.
      const mid = Math.floor(words.length / 2);
      lines = [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
    }
    while (size > 36 && !fits(lines, size)) {
      size -= 2;
    }

    setFont(size);
    ctx.fillStyle = PLATE_TEXT;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const blockH = measureBlock(lines, size);
    const firstAscent = ctx.measureText(lines[0] ?? sign.text).actualBoundingBoxAscent;
    const blockTop = textAreaY + textAreaH / 2 - blockH / 2;
    let baseline = blockTop + firstAscent;
    lines.forEach((line, i) => {
      ctx.fillText(line, cell.x + cell.w / 2, baseline);
      const next = lines[i + 1];
      if (next !== undefined) {
        baseline += size * LINE_STEP;
      }
    });
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  registry.track(texture);

  const material = registry.track(
    new THREE.MeshBasicMaterial({
      map: texture,
      toneMapped: false,
      side: THREE.FrontSide,
    }),
  );

  return {
    texture,
    material,
    uvFor: (signId: string): SignUvRect => {
      const rect = uvById.get(signId);
      if (!rect) throw new Error(`sign atlas: unknown signId "${signId}"`);
      return rect;
    },
    diagnostics: { font, usedFallback },
  };
}

/**
 * Build one sign plane with its atlas cell UVs. Default 4.2 x 0.84 to sit
 * slightly inside the 4.4 x 0.9 sign-mount boards; the caller positions it
 * slightly in front of the board and tilts it toward the camera. Geometry is
 * caller-owned (bake signs into the merged static mesh per the draw-call
 * budget); track or dispose it there.
 */
export function buildSignMesh(
  material: THREE.Material,
  uv: SignUvRect,
  width = 4.2,
  height = 0.84,
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, height);
  const uvAttribute = geometry.getAttribute("uv") as THREE.BufferAttribute;

  // The atlas cell is wider (~10:1) than the sign mesh (5:1); map only the
  // centered aspect-correct sub-rect so the text is not squeezed horizontally.
  const cellAspect = ((uv.u1 - uv.u0) * ATLAS_WIDTH) / ((uv.v1 - uv.v0) * ATLAS_HEIGHT);
  const meshAspect = width / height;
  let u0 = uv.u0;
  let u1 = uv.u1;
  let v0 = uv.v0;
  let v1 = uv.v1;
  if (cellAspect > meshAspect) {
    const inset = ((uv.u1 - uv.u0) * (1 - meshAspect / cellAspect)) / 2;
    u0 += inset;
    u1 -= inset;
  } else {
    const inset = ((uv.v1 - uv.v0) * (1 - cellAspect / meshAspect)) / 2;
    v0 += inset;
    v1 -= inset;
  }

  // PlaneGeometry uv layout: (0,1) (1,1) / (0,0) (1,0) per triangle corner.
  uvAttribute.setXY(0, u0, v1);
  uvAttribute.setXY(1, u1, v1);
  uvAttribute.setXY(2, u0, v0);
  uvAttribute.setXY(3, u1, v0);
  uvAttribute.needsUpdate = true;
  return new THREE.Mesh(geometry, material);
}
