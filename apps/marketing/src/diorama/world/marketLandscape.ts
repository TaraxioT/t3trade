/**
 * Living Market Landscape: a procedural animated terrain band along the upper
 * edge of the research district showing four regimes (calm, rising, falling,
 * turbulent). Bands are redrawn ONLY during the 1.2 s regime transition and
 * hold a static pose at rest; turbulent mode adds occasional electric flickers.
 * Owner: ground worker.
 */
import { Container, Graphics, Sprite } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { dotTexture, glow, lightBeam } from "../core/iso.js";
import { PALETTE } from "../config/palette.js";
import { seededRandom } from "../config/world.js";

export type Regime = "calm" | "rising" | "falling" | "turbulent";

export interface MarketLandscapeApi {
  /** Transition the terrain to a named regime. */
  setRegime(regime: Regime): void;
  regime(): Regime;
}

/** Populated by buildMarketLandscape; consumed by the director/stories. */
export const marketLandscape = { api: null as MarketLandscapeApi | null };

const BANDS = 4;
const POINTS = 19; // 19 top + 19 bottom = 38 polygon points per band
const X1 = 220;
const X2 = 1100;
const SOUTH_Y = 250; // south baseline of the terrain band
const BAND_GAP = 30; // vertical spacing between contour baselines

/** Per-regime contour colors, index 0 = top (north) band. */
const REGIME_COLORS: Record<Regime, number[]> = {
  calm: [PALETTE.aqua, PALETTE.cyan, PALETTE.blue, PALETTE.structureLight],
  rising: [PALETTE.aqua, PALETTE.cyan, PALETTE.orange, PALETTE.structureLight],
  falling: [PALETTE.magenta, PALETTE.violet, PALETTE.blue, PALETTE.structureLight],
  turbulent: [PALETTE.violet, PALETTE.magenta, PALETTE.violet, PALETTE.structureLight],
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function lerpColor(c1: number, c2: number, t: number): number {
  const r = Math.round(lerp((c1 >> 16) & 0xff, (c2 >> 16) & 0xff, t));
  const g = Math.round(lerp((c1 >> 8) & 0xff, (c2 >> 8) & 0xff, t));
  const b = Math.round(lerp(c1 & 0xff, c2 & 0xff, t));
  return (r << 16) | (g << 8) | b;
}

/** Deterministic per-band height profile for a regime (heights above baseline). */
function regimeHeights(regime: Regime): number[][] {
  const rnd = seededRandom(31);
  const jitter: number[][] = [];
  for (let b = 0; b < BANDS; b++) {
    const row: number[] = [];
    for (let k = 0; k < POINTS; k++) row.push(rnd() * 2 - 1);
    jitter.push(row);
  }
  const out: number[][] = [];
  for (let b = 0; b < BANDS; b++) {
    const row: number[] = [];
    for (let k = 0; k < POINTS; k++) {
      const t = k / (POINTS - 1);
      const j = jitter[b][k];
      let h: number;
      switch (regime) {
        case "calm":
          h = 10 + 7 * Math.sin(t * Math.PI * 1.5 + b * 1.1) + j * 2.5;
          break;
        case "rising":
          h = 8 + t * 30 + 5 * Math.sin(t * Math.PI * 3 + b) + j * 3;
          break;
        case "falling":
          h = 34 - t * 28 + 5 * Math.sin(t * Math.PI * 3 + b * 0.8) + j * 3;
          break;
        case "turbulent":
          h = 10 + 14 * Math.abs(Math.sin(t * Math.PI * 5 + b * 2.3)) + j * 9;
          break;
      }
      row.push(Math.max(4, h));
    }
    out.push(row);
  }
  return out;
}

export function buildMarketLandscape(ctx: DioramaContext): void {
  const root = new Container();
  // Terrain sits behind every research-district structure.
  root.zIndex = 100;

  // Backing panel: deep blue ground the contours rise from.
  const back = new Graphics();
  back.roundRect(X1, 128, X2 - X1, SOUTH_Y - 128 + 14, 18);
  back.fill({ color: PALETTE.structure, alpha: 0.55 });
  back.roundRect(X1, 128, X2 - X1, SOUTH_Y - 128 + 14, 18);
  back.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.14 });
  root.addChild(back);

  // Soft under-glow strip beneath the terrain band so the contours read as an
  // illuminated ridge line rather than flat paint.
  const under = glow((X1 + X2) / 2, SOUTH_Y - 6, 560, PALETTE.cyan, 0.1);
  under.height = 46;
  root.addChild(under);

  // Per-band Graphics, redrawn only during transitions.
  const bandGs: Graphics[] = [];
  for (let i = 0; i < BANDS; i++) {
    const g = new Graphics();
    bandGs.push(g);
    root.addChild(g);
  }

  let current: Regime = "calm";
  const currentHeights: number[][] = regimeHeights("calm").map((r) => [...r]);
  const currentColors: number[] = [...REGIME_COLORS.calm];
  let tween: gsap.core.Tween | null = null;
  let flickerTL: gsap.core.Timeline | null = null;

  /** Redraw all band polygons from the live height/color state. */
  const draw = (): void => {
    for (let b = 0; b < BANDS; b++) {
      const g = bandGs[b];
      g.clear();
      const baseline = SOUTH_Y - b * BAND_GAP;
      const below = b === 0 ? null : currentHeights[b - 1];
      const belowBase = SOUTH_Y - (b - 1) * BAND_GAP;
      g.moveTo(X1, baseline - currentHeights[b][0]);
      for (let k = 1; k < POINTS; k++) {
        const x = X1 + ((X2 - X1) * k) / (POINTS - 1);
        g.lineTo(x, baseline - currentHeights[b][k]);
      }
      // Bottom edge: the contour of the band below (or the south baseline).
      for (let k = POINTS - 1; k >= 0; k--) {
        const x = X1 + ((X2 - X1) * k) / (POINTS - 1);
        const y = below ? belowBase - below[k] : SOUTH_Y;
        g.lineTo(x, y);
      }
      g.closePath();
      g.fill({ color: currentColors[b], alpha: Math.min(1, 0.66 + b * 0.14) });
      // Bright ridge line on the contour top edge.
      g.moveTo(X1, baseline - currentHeights[b][0]);
      for (let k = 1; k < POINTS; k++) {
        const x = X1 + ((X2 - X1) * k) / (POINTS - 1);
        g.lineTo(x, baseline - currentHeights[b][k]);
      }
      g.stroke({ width: 1.4, color: currentColors[b], alpha: 1 });
    }
  };
  draw();

  // Electric flickers for the turbulent regime: <= 3 pooled light beams that
  // spike briefly on a slow ambient loop.
  const flickers: Graphics[] = [];
  const flickerXs = [380, 640, 900];
  for (const fx of flickerXs) {
    const beam = lightBeam(fx, SOUTH_Y - 55, 4, 14, 55, PALETTE.violet, 0);
    beam.alpha = 0;
    flickers.push(beam);
    root.addChild(beam);
  }

  const stopFlickers = (): void => {
    flickerTL?.kill();
    flickerTL = null;
    for (const f of flickers) f.alpha = 0;
  };

  const startFlickers = (): void => {
    if (flickerTL || ctx.reducedMotion) return;
    flickerTL = gsap.timeline({ repeat: -1, repeatDelay: 4.5 });
    flickers.forEach((f, i) => {
      flickerTL!.fromTo(
        f,
        { alpha: 0 },
        { alpha: 0.75, duration: 0.12, delay: i * 0.16, ease: "power2.out" },
        i * 0.16,
      );
      flickerTL!.to(f, { alpha: 0, duration: 0.28, ease: "power2.in" }, i * 0.16 + 0.12);
    });
  };

  marketLandscape.api = {
    regime: () => current,
    setRegime(regime) {
      if (regime === current) return;
      const fromH = currentHeights.map((r) => [...r]);
      const toH = regimeHeights(regime);
      const fromC = [...currentColors];
      const toC = REGIME_COLORS[regime];
      current = regime;
      tween?.kill();
      const state = { t: 0 };
      tween = gsap.to(state, {
        t: 1,
        duration: ctx.reducedMotion ? 0.6 : 1.2,
        ease: "power2.inOut",
        onUpdate: () => {
          for (let b = 0; b < BANDS; b++) {
            for (let k = 0; k < POINTS; k++) {
              currentHeights[b][k] = ctx.reducedMotion
                ? toH[b][k]
                : lerp(fromH[b][k], toH[b][k], state.t);
            }
            currentColors[b] = lerpColor(fromC[b], toC[b], state.t);
          }
          draw();
        },
      });
      if (regime === "turbulent") startFlickers();
      else stopFlickers();
    },
  };

  // Probes: tiny tripods along the south edge; visual only, rails are drawn
  // by the rails worker.
  const rnd = seededRandom(41);
  const probeTex = dotTexture();
  for (const px of [430, 660, 890]) {
    const probe = new Container();
    const legs = new Graphics();
    for (const lx of [-7, 0, 7]) {
      legs.moveTo(lx, 0);
      legs.lineTo(lx * 0.4, -17);
      legs.stroke({ width: 1.4, color: PALETTE.inkDim, alpha: 0.75 });
    }
    probe.addChild(legs);
    const head = new Sprite(probeTex);
    head.anchor.set(0.5);
    head.position.set(0, -20);
    head.width = 7;
    head.height = 7;
    head.tint = PALETTE.aqua;
    probe.addChild(head);
    probe.addChild(glow(0, -20, 26, PALETTE.aqua, 0.4));
    probe.position.set(px + (rnd() - 0.5) * 30, SOUTH_Y - 2 + (rnd() - 0.5) * 6);
    probe.zIndex = probe.position.y;
    root.addChild(probe);
  }

  ctx.onCleanup(() => {
    tween?.kill();
    stopFlickers();
    marketLandscape.api = null;
  });

  ctx.layers.sortable.addChild(root);
}
