/**
 * Living Market Landscape (dio-3 cycle 3): the animated market-terrain band,
 * rebuilt as a LOW STRIP LYING ON THE FLOOR of the west section, running
 * parallel to and just inside the N-W wall base. Four regimes (calm, rising,
 * falling, turbulent); contour bands are redrawn ONLY during the 1.2 s regime
 * transition and hold a static pose at rest; turbulent mode adds occasional
 * electric flickers. Three probe tripods drift slowly along the band with
 * rest pauses. A static contour-silhouette panel on the wall above the band
 * echoes the terrain as a clearly secondary fixture (no animation, no
 * regimes).
 *
 * Station contract (proposed anchor; the coordinator owns config/stations.ts):
 * anchor (872,464), hit diamond 540x260 over the band corridor. This root
 * sorts at z=100, below every station root, so the console stations win
 * pointer picks wherever footprints overlap (ui/interaction.ts picks the
 * highest-z station whose def diamond contains the point).
 *
 * Containment (audited against config/geometry.ts; see
 * artifacts/diorama/dio3/lane-i-landscape.md): the band spans the near-edge
 * line (624,538.9) -> (1071.2,315.3), perpendicular width 66, tapering to a
 * thin tail past u=320 so it threads between the strategy lab's west card
 * rack and the wall. West of x=620 (the entrance door zone) stays clear.
 * Owner: room-world lane.
 */
import { Container, Graphics, Sprite } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { dotTexture, glow, lightBeam } from "../core/iso.js";
import { registerStation } from "../core/registry.js";
import { PALETTE } from "../config/palette.js";
import { seededRandom } from "../config/world.js";
import { ROOM_DIAMOND, WALL_EDGES } from "../config/geometry.js";

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

// ---------------------------------------------------------------------------
// Floor-band frame: derived from the frozen N-W wall edge so the strip is
// parallel to the wall base by construction. u runs along the wall (SW -> NE),
// n runs inward across the floor from the near edge.
// ---------------------------------------------------------------------------
const WEST = WALL_EDGES.west;
const WEST_LEN = Math.hypot(WEST.b.x - WEST.a.x, WEST.b.y - WEST.a.y);
/** Unit vector along the band, SW -> NE. */
const UDIR = { x: (WEST.a.x - WEST.b.x) / WEST_LEN, y: (WEST.a.y - WEST.b.y) / WEST_LEN };
/** Near-edge perpendicular offset from the wall base: the terrain emerges
 * from the wall's 16-unit contact shade instead of butting against it. */
const D0 = 8;
/** SW end x: staying at or east of x=620 keeps the band clear of the entrance
 * door (researchOnlyGate, 540,635) and every fixture west of it. */
const SW_X = 624;
/** Wall-base line constant: points on the N-W edge satisfy x + 2y = LINE_C. */
const LINE_C = WEST.a.x + 2 * WEST.a.y;
/** Near-edge SW end: the point D0 inside the wall base at x = SW_X. */
const SPAN_A = { x: SW_X, y: (LINE_C + D0 * Math.sqrt(5) - SW_X) / 2 };
/** Inward unit normal (into the room, toward the S corner). */
const INWARD = (() => {
  const c = { x: -UDIR.y, y: UDIR.x };
  const s = c.x * (ROOM_DIAMOND.S.x - SPAN_A.x) + c.y * (ROOM_DIAMOND.S.y - SPAN_A.y) >= 0 ? 1 : -1;
  return { x: c.x * s, y: c.y * s };
})();

/** Band length along the wall. The NE tip sits between the strategy lab's
 * table and the wall (the corridor's natural end); going further east would
 * collide with the lab's west card rack at world ~(990,395). */
const BAND_LEN = 500;
/** Full-body perpendicular width of the band (65..80 per the brief). */
const BAND_W = 66;
/** The band carries its full width to u=320, then tapers to TAPER_END of it
 * at the NE tip so the terrain thins past the strategy lab's card rack
 * (rack floor contact at 65 perpendicular units from the wall, u ~382..394;
 * the tapered far edge passes at ~60 there). */
const TAPER_U = 320;
const TAPER_END = 0.22;

const smoothstep = (t: number): number => t * t * (3 - 2 * t);
const taperAt = (u: number): number =>
  u <= TAPER_U ? 1 : 1 - (1 - TAPER_END) * smoothstep(Math.min(1, (u - TAPER_U) / (BAND_LEN - TAPER_U)));
const widthAt = (u: number): number => taperAt(u) * BAND_W;

/** World point at (u along the band, n inward from the near edge). */
function bandPt(u: number, n: number): { x: number; y: number } {
  return { x: SPAN_A.x + UDIR.x * u + INWARD.x * n, y: SPAN_A.y + UDIR.y * u + INWARD.y * n };
}

/** Contour-field constants: band 0 is the wall-side walking plain the probes
 * use; later bands stack toward the room like elevation contours. */
const FIELD_N0 = 7;
const BAND_GAP = 14;
/** Height scale keeps the tallest contour (41.3 units, falling regime) inside
 * the band: max reach = 7 + 3*14 + 41.3*0.35 = 63.5 of 66. */
const H_SCALE = 0.35;
/** Scaled contour position; the taper compresses the whole field toward the
 * NE tip so contours never cross the tapered far edge. */
const fieldN = (u: number, b: number, h: number): number =>
  taperAt(u) * (FIELD_N0 + b * BAND_GAP + h * H_SCALE);

// Static wall echo: a quiet contour silhouette mounted above the band's span.
// Inset from both band ends so it clears the research banner board (west)
// and the strategy lab sign (east).
const ECHO = { u0: 40, u1: 440, h0: 26, h1: 96, proud: 8 } as const;
/** World point on the wall face at (u along the band, h up the wall), proud. */
function wallPt(u: number, h: number): { x: number; y: number } {
  const p = bandPt(u, -D0 + ECHO.proud);
  return { x: p.x, y: p.y - h };
}

/** Station anchor and hit footprint (proposed; see file header). */
const ANCHOR = { x: 872, y: 464 };
const HIT_W = 540;
const HIT_D = 260;

/** Per-regime contour colors, index 0 = wall-side band (nearest the plain). */
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
  // Floor band: above the whole ground layer (wall face, contact shade,
  // section washes) and below every station/agent root, which all sort at
  // anchor Y >= ~310. The band is a floor decal: structures in front of it
  // (console walls, the strategy lab rack) correctly draw over it.
  root.zIndex = 100;

  // Backing floor plate: one flat polygon exactly the band's footprint, so
  // the audited boundary IS the drawn boundary. Far edge sampled so the
  // tapered tail is part of the plate, not an afterthought.
  const back = new Graphics();
  back.moveTo(SPAN_A.x, SPAN_A.y);
  for (let u = 0; u <= BAND_LEN; u += BAND_LEN / 25) {
    const p = bandPt(u, 0);
    back.lineTo(p.x, p.y);
  }
  for (let u = BAND_LEN; u >= 0; u -= BAND_LEN / 25) {
    const p = bandPt(u, widthAt(u));
    back.lineTo(p.x, p.y);
  }
  back.closePath();
  back.fill({ color: PALETTE.structure, alpha: 0.55 });
  back.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.14 });
  root.addChild(back);

  // Soft under-glow along the corridor so the contours read as an
  // illuminated terrain band rather than flat paint.
  const center = bandPt(BAND_LEN / 2, BAND_W / 2);
  const under = glow(center.x, center.y, 460, PALETTE.cyan, 0.09);
  under.height = 84;
  root.addChild(under);

  // Static wall echo (secondary): dark mount plate plus three quiet contour
  // lines traced from the calm profile. No animation, no regime response:
  // the live terrain is on the floor, this is its wall chart.
  const echo = new Graphics();
  const eq = [
    wallPt(ECHO.u0, ECHO.h0), wallPt(ECHO.u1, ECHO.h0),
    wallPt(ECHO.u1, ECHO.h1), wallPt(ECHO.u0, ECHO.h1),
  ];
  echo.poly([eq[0].x, eq[0].y, eq[1].x, eq[1].y, eq[2].x, eq[2].y, eq[3].x, eq[3].y]);
  echo.fill({ color: PALETTE.structure, alpha: 0.5 });
  echo.poly([eq[0].x, eq[0].y, eq[1].x, eq[1].y, eq[2].x, eq[2].y, eq[3].x, eq[3].y]);
  echo.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.12 });
  const echoCalm = regimeHeights("calm");
  for (let b = 0; b < 3; b++) {
    const baseline = 36 + b * 22;
    for (let k = 0; k < POINTS; k++) {
      const u = ECHO.u0 + 16 + ((ECHO.u1 - ECHO.u0 - 32) * k) / (POINTS - 1);
      const p = wallPt(u, baseline + echoCalm[b][k] * 0.25);
      if (k === 0) echo.moveTo(p.x, p.y);
      else echo.lineTo(p.x, p.y);
    }
    echo.stroke({ width: 1, color: PALETTE.structureLight, alpha: 0.4 });
  }
  root.addChild(echo);

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
      const below = b === 0 ? null : currentHeights[b - 1];
      // Room-side edge: the band's contour, rising from the wall-side plain.
      let p = bandPt(0, fieldN(0, b, currentHeights[b][0]));
      g.moveTo(p.x, p.y);
      for (let k = 1; k < POINTS; k++) {
        const u = (BAND_LEN * k) / (POINTS - 1);
        p = bandPt(u, fieldN(u, b, currentHeights[b][k]));
        g.lineTo(p.x, p.y);
      }
      // Wall-side edge: the contour of the band nearer the plain (or the
      // plain itself for band 0).
      for (let k = POINTS - 1; k >= 0; k--) {
        const u = (BAND_LEN * k) / (POINTS - 1);
        const n = below ? fieldN(u, b - 1, below[k]) : taperAt(u) * FIELD_N0;
        p = bandPt(u, n);
        g.lineTo(p.x, p.y);
      }
      g.closePath();
      g.fill({ color: currentColors[b], alpha: Math.min(1, 0.66 + b * 0.14) });
      // Bright ridge line on the contour's room-side edge.
      p = bandPt(0, fieldN(0, b, currentHeights[b][0]));
      g.moveTo(p.x, p.y);
      for (let k = 1; k < POINTS; k++) {
        const u = (BAND_LEN * k) / (POINTS - 1);
        p = bandPt(u, fieldN(u, b, currentHeights[b][k]));
        g.lineTo(p.x, p.y);
      }
      g.stroke({ width: 1.4, color: currentColors[b], alpha: 1 });
    }
  };
  draw();

  // Electric flickers for the turbulent regime: <= 3 pooled light beams that
  // spike briefly on a slow ambient loop. Bases sit on the terrain, clear of
  // the console billboards' screen rects (u 110/230/390 at n 26).
  const flickers: Graphics[] = [];
  for (const fu of [110, 230, 390]) {
    const base = bandPt(fu, 26);
    const beam = lightBeam(base.x, base.y, 4, 14, 55, PALETTE.violet, 0);
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

  // Register the station: transparent hit diamond over the floor band's
  // corridor. The registry derives the hitArea from local bounds.
  const hit = new Container();
  const hitG = new Graphics();
  hitG.poly([0, -HIT_D / 2, HIT_W / 2, 0, 0, HIT_D / 2, -HIT_W / 2, 0]);
  hitG.fill({ color: 0xffffff, alpha: 0.001 });
  hit.addChild(hitG);
  hit.position.set(ANCHOR.x, ANCHOR.y);
  hit.eventMode = "static";
  hit.cursor = "pointer";
  root.addChild(hit);
  registerStation({ id: "marketLandscape", root, hit, api: marketLandscape.api });

  // Probes: tiny tripods that drift slowly along the band's long axis on the
  // wall-side walking plain, pausing at rest. Rest spots sit near 1/4, 1/2,
  // and 3/4 of the band (probe 2 tuned 10 u west of center to stay clear of
  // the research tools billboard's west shoulder). Drift ranges keep every
  // tripod visible: the occlusion wedges behind the console walls begin at
  // u ~50..170 and ~235..350 on this lane, and the ranges stop short of them.
  // Visual only; rails are drawn by the rails worker.
  const PROBE_N = 13;
  const probeSpecs = [
    { rest: 125, lo: 95, hi: 155 },
    { rest: 240, lo: 205, hi: 275 },
    { rest: 375, lo: 335, hi: 405 },
  ];
  const driftTLs: gsap.core.Timeline[] = [];
  const probeTex = dotTexture();
  const rnd = seededRandom(41);
  for (const [i, spec] of probeSpecs.entries()) {
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
    // Tiny static footprint jitter so the three tripods never read as clones.
    const jitterU = (rnd() - 0.5) * 4;
    const walk = { u: spec.rest + jitterU };
    const place = (): void => {
      const p = bandPt(walk.u, PROBE_N);
      probe.position.set(p.x, p.y);
    };
    place();
    if (!ctx.reducedMotion) {
      const tl = gsap.timeline({ repeat: -1, delay: i * 2.6 });
      tl.to(walk, { u: spec.hi, duration: 6.5 + i, ease: "sine.inOut", onUpdate: place });
      tl.to(walk, { u: spec.lo, duration: 9 + i, ease: "sine.inOut", onUpdate: place }, "+=2.4");
      tl.to(walk, { u: spec.rest + jitterU, duration: 5.5, ease: "sine.inOut", onUpdate: place }, "+=3");
      tl.to({}, { duration: 2.6 });
      driftTLs.push(tl);
    }
    root.addChild(probe);
  }

  ctx.onCleanup(() => {
    tween?.kill();
    stopFlickers();
    for (const tl of driftTLs) tl.kill();
    marketLandscape.api = null;
  });

  ctx.layers.sortable.addChild(root);
}
