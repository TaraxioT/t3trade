/**
 * Deep-space backdrop: base void, static starfield, soft nebula glows, and a
 * faint horizon glow under the floating campus. Everything here is built once
 * and never touched again; zero per-frame cost (twinkling is forbidden).
 * Owner: ground worker.
 */
import { Assets, Graphics, Sprite, Texture } from "pixi.js";
import type { DioramaContext } from "../core/context.js";
import { dotTexture, glow } from "../core/iso.js";
import { PALETTE } from "../config/palette.js";
import { seededRandom, WORLD_HEIGHT, WORLD_WIDTH } from "../config/world.js";

/** Margin of void around the world rect so the campus floats in space. */
const VOID_MARGIN = 700;

export function buildBackdrop(ctx: DioramaContext): void {
  const layer = ctx.layers.backdrop;

  // Base fill: deep-space navy across the world rect plus generous margin.
  const base = new Graphics();
  base.rect(
    -VOID_MARGIN,
    -VOID_MARGIN,
    WORLD_WIDTH + VOID_MARGIN * 2,
    WORLD_HEIGHT + VOID_MARGIN * 2,
  );
  base.fill({ color: PALETTE.space });
  layer.addChild(base);

  // Painted nebula field (generated, vision-QA'd): placed just above the base
  // fill and beneath every procedural layer. Loaded async; the world renders
  // fine without it while it streams in.
  void Assets.load<Texture>("/diorama/nebula-backdrop.png")
    .then((tex) => {
      const nebula = new Sprite(tex);
      nebula.anchor.set(0.5);
      nebula.position.set(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
      // Cover the world rect plus margin, preserving the image's 16:9 shape.
      const coverW = WORLD_WIDTH + VOID_MARGIN * 2;
      const coverH = WORLD_HEIGHT + VOID_MARGIN * 2;
      const scale = Math.max(coverW / tex.width, coverH / tex.height);
      nebula.width = tex.width * scale;
      nebula.height = tex.height * scale;
      nebula.alpha = 0.9;
      nebula.zIndex = -1;
      layer.addChildAt(nebula, 1);
    })
    .catch(() => {
      // The procedural glows below already carry the scene without the image.
    });

  // Large soft nebula glows tinted with structural blues plus one subtle
  // violet, kept at low alpha so the void stays dark and readable.
  const nebulae: Array<[number, number, number, number, number]> = [
    // x, y, size, tint, alpha
    [WORLD_WIDTH * 0.22, WORLD_HEIGHT * 0.28, 1500, PALETTE.structureLight, 0.26],
    [WORLD_WIDTH * 0.78, WORLD_HEIGHT * 0.2, 1250, 0x142a40, 0.32],
    [WORLD_WIDTH * 0.62, WORLD_HEIGHT * 0.85, 1600, PALETTE.structureLight, 0.2],
    [WORLD_WIDTH * 0.12, WORLD_HEIGHT * 0.8, 1100, PALETTE.violet, 0.14],
  ];
  for (const [nx, ny, size, tint, alpha] of nebulae) {
    layer.addChild(glow(nx, ny, size, tint, alpha));
  }

  // Static starfield: ~180 deterministic stars, varied size and alpha.
  const rnd = seededRandom(7);
  const starTex = dotTexture();
  for (let i = 0; i < 180; i++) {
    const star = new Sprite(starTex);
    star.anchor.set(0.5);
    star.position.set(
      -VOID_MARGIN * 0.6 + rnd() * (WORLD_WIDTH + VOID_MARGIN * 1.2),
      -VOID_MARGIN * 0.6 + rnd() * (WORLD_HEIGHT + VOID_MARGIN * 1.2),
    );
    const size = 1.6 + rnd() * 3.4;
    star.width = size;
    star.height = size;
    star.alpha = 0.28 + rnd() * 0.6;
    star.tint = rnd() < 0.12 ? PALETTE.cyan : 0xf5fbff;
    layer.addChild(star);
  }

  // Faint horizon glow under the campus platform: a wide, low halo centered
  // beneath the campus mass so the island reads as suspended above depth.
  const horizon = glow(
    WORLD_WIDTH * 0.47,
    WORLD_HEIGHT * 0.86,
    2600,
    PALETTE.structureLight,
    0.3,
  );
  horizon.height = 700;
  layer.addChild(horizon);

  // Faint warm counterweight lower-right so the composition stays balanced
  // against the cool campus mass on the left.
  const warm = glow(WORLD_WIDTH * 0.88, WORLD_HEIGHT * 0.9, 1200, PALETTE.orange, 0.08);
  warm.height = 420;
  layer.addChild(warm);
}
