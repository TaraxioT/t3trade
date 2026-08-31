/**
 * Deterministic textureless particle effects (plan section 8, Particles).
 *
 * Strategy: exactly three shared THREE.Points objects (one per pool:
 * "normal", "additive", "confetti") with preallocated typed-array buffers,
 * giving a hard cap of QUALITY.maxParticleDrawCalls === 3 draw calls. Every
 * effect is an analytic window evaluated purely from absolute time relative
 * to its authored trigger, so seeking into the middle of a burst shows the
 * correct phase and time outside the window is invisible. No per-frame
 * allocation anywhere in update().
 */

import * as THREE from "three";
import { DURATION_MS, PALETTE, QUALITY, SEEDS } from "./config";
import { createRng, lerp, saturate, seededId, type Rng } from "./math";
import type { XYZ } from "./types";
import type { ResourceRegistry } from "./render/resources";

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

/** Effect vocabulary; the director maps its cue IDs onto these. */
export type EffectId =
  | "steamPuff"
  | "paperBurst"
  | "stampDust"
  | "confettiBurst"
  | "cannonSmoke"
  | "receiptSparks"
  | "poleDust";

export const EFFECT_IDS: readonly EffectId[] = [
  "steamPuff",
  "paperBurst",
  "stampDust",
  "confettiBurst",
  "cannonSmoke",
  "receiptSparks",
  "poleDust",
];

export const isEffectId = (value: string): value is EffectId =>
  (EFFECT_IDS as readonly string[]).includes(value);

export interface SpawnOptions {
  /** Authored trigger time in absolute story milliseconds (default 0). */
  readonly triggerMs?: number;
  /** Preferred burst direction (normalized internally); +Y when omitted. */
  readonly direction?: XYZ;
  /** Size/radius multiplier around 1 (default 1). */
  readonly scale?: number;
  /** stampDust variant: mint puff for approve, gray-red for reject. */
  readonly variant?: "approve" | "reject";
  /** Distinguishes simultaneous same-effect spawns (default 0). */
  readonly instance?: number;
}

/**
 * A bound, windowed effect. `write` must be pure in (tLocal, params): the
 * same local time always produces the same particle state.
 */
export interface EffectInstance {
  readonly key: string;
  readonly effectId: EffectId;
  readonly pool: PoolId;
  readonly triggerMs: number;
  readonly durationMs: number;
  readonly count: number;
  /** Write all particles at local time tLocal (ms in [0, durationMs)). */
  write(tLocal: number, slice: PoolSlice): void;
}

export type PoolId = "normal" | "additive" | "confetti";

/** Preallocated shared-buffer view handed to EffectInstance.write. */
export interface PoolSlice {
  readonly pos: Float32Array;
  readonly col: Float32Array;
  readonly alpha: Float32Array;
  readonly size: Float32Array;
  /** Particle index offset this effect writes from. */
  readonly offset: number;
}

export interface EffectCounts {
  /** Registered windowed effects (live, idempotent per key). */
  readonly effects: number;
  /** Particles visible at the last update() call. */
  readonly points: number;
  /** Fixed: three shared Points objects, one per pool. */
  readonly drawCalls: number;
}

export interface EffectSystem {
  /** Add to the scene once; contains the three shared Points objects. */
  readonly group: THREE.Group;
  /**
   * Register a windowed effect. Idempotent per (effectId, triggerMs,
   * instance): director re-fires on seek never duplicate. Resolves false
   * when the effect id is unknown or the pool/point budget is exhausted.
   */
  spawn(effectId: EffectId, origin: XYZ, opts?: SpawnOptions): boolean;
  /** Evaluate all effects at absolute (cyclic) story time and pack pools. */
  update(timeMs: number): void;
  /** Drop all registered effects; buffers are kept for reuse. */
  clear(): void;
  /**
   * Pixel-per-world-unit scale for point sizes. Call on resize with the
   * canvas pixel height and the orthographic frustum height.
   */
  setViewport(pixelHeight: number, frustumHeight: number): void;
  readonly counts: EffectCounts;
}

// ---------------------------------------------------------------------------
// Shader (textureless soft round points; salvaged biomes pattern)
// ---------------------------------------------------------------------------

const POINT_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aSize;
  uniform float uSizeScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(aSize * uSizeScale, 0.0);
  }
`;

const POINT_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float falloff = smoothstep(0.5, 0.12, d);
    float a = vAlpha * falloff;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------
// Color helpers (all literals come from PALETTE; converted to linear space)
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

const rgb = (hex: string): Rgb => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

const PALETTE_RGB = {
  cream: rgb(PALETTE.cream),
  creamWallLight: rgb(PALETTE.creamWallLight),
  warmFill: rgb(PALETTE.warmFill),
  slate: rgb(PALETTE.slate),
  mint: rgb(PALETTE.mint),
  mintBright: rgb(PALETTE.mintBright),
  mintDim: rgb(PALETTE.mintDim),
  dataRed: rgb(PALETTE.dataRed),
  brass: rgb(PALETTE.brass),
  caramelLight: rgb(PALETTE.caramelLight),
} as const;

const mix3 = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/** Write a color into the shared color buffer at particle index i. */
const putColor = (slice: PoolSlice, i: number, c: Rgb): void => {
  const j = (slice.offset + i) * 3;
  slice.col[j] = c[0];
  slice.col[j + 1] = c[1];
  slice.col[j + 2] = c[2];
};

const putState = (
  slice: PoolSlice,
  i: number,
  x: number,
  y: number,
  z: number,
  alpha: number,
  size: number,
): void => {
  const p = slice.offset + i;
  slice.pos[p * 3] = x;
  slice.pos[p * 3 + 1] = y;
  slice.pos[p * 3 + 2] = z;
  slice.alpha[p] = alpha;
  slice.size[p] = size;
};

/** Fade-in over the first `inFrac`, fade-out over the last `outFrac`. */
const envelope = (u: number, inFrac: number, outFrac: number): number => {
  if (u <= 0 || u >= 1) return 0;
  return saturate(u / inFrac) * saturate((1 - u) / outFrac);
};

// ---------------------------------------------------------------------------
// Per-effect factories
//
// Each factory allocates its immutable per-particle parameter block once
// (spawn time, not frame time) from a seed derived from
// SEEDS.particles + the effect key, and returns an analytic evaluator.
// ---------------------------------------------------------------------------

/** Base params layout shared by most puff/burst effects (8 floats/particle). */
interface BurstParams {
  readonly dirX: Float32Array;
  readonly dirY: Float32Array;
  readonly dirZ: Float32Array;
  readonly speed: Float32Array;
  readonly delay: Float32Array; // fraction of duration in [0, stagger]
  readonly size: Float32Array;
  readonly color: Float32Array; // mix factor into the effect color pair
  readonly phase: Float32Array;
}

const buildBurstParams = (
  rng: Rng,
  count: number,
  stagger: number,
  makeDir: (i: number) => [number, number, number],
  speedRange: readonly [number, number],
  sizeRange: readonly [number, number],
): BurstParams => {
  const p: BurstParams = {
    dirX: new Float32Array(count),
    dirY: new Float32Array(count),
    dirZ: new Float32Array(count),
    speed: new Float32Array(count),
    delay: new Float32Array(count),
    size: new Float32Array(count),
    color: new Float32Array(count),
    phase: new Float32Array(count),
  };
  for (let i = 0; i < count; i += 1) {
    const [dx, dy, dz] = makeDir(i);
    const len = Math.hypot(dx, dy, dz) || 1;
    p.dirX[i] = dx / len;
    p.dirY[i] = dy / len;
    p.dirZ[i] = dz / len;
    p.speed[i] = rng.range(speedRange[0], speedRange[1]);
    p.delay[i] = rng.range(0, stagger);
    p.size[i] = rng.range(sizeRange[0], sizeRange[1]);
    p.color[i] = rng.next();
    p.phase[i] = rng.range(0, Math.PI * 2);
  }
  return p;
};

const baseInstance = (
  effectId: EffectId,
  pool: PoolId,
  key: string,
  triggerMs: number,
  durationMs: number,
  count: number,
): Omit<EffectInstance, "write"> => ({ key, effectId, pool, triggerMs, durationMs, count });

/** Coffee machine steam: warm gray, gentle rise with sinusoidal drift. */
export function steamPuff(origin: XYZ, opts: SpawnOptions = {}): EffectInstance {
  const key = effectKey("steamPuff", opts);
  const rng = createRng(seededId(SEEDS.particles, key));
  const count = 26;
  const durationMs = 2600;
  const scale = opts.scale ?? 1;
  const p = buildBurstParams(
    rng,
    count,
    0.3,
    () => {
      const a = rng.range(0, Math.PI * 2);
      return [Math.cos(a) * 0.25, 1, Math.sin(a) * 0.25];
    },
    [0.18, 0.34],
    [0.16, 0.3],
  );
  const base = baseInstance("steamPuff", "normal", key, opts.triggerMs ?? 0, durationMs, count);
  return {
    ...base,
    write(tLocal, slice) {
      const life = durationMs * 0.7;
      for (let i = 0; i < count; i += 1) {
        const u = saturate((tLocal - p.delay[i] * durationMs) / life);
        const rise = (1 - Math.pow(1 - u, 2)) * p.speed[i] * 2.2 * scale;
        const sway = Math.sin(p.phase[i] + u * 5) * 0.12 * scale * u;
        const alpha = envelope(u, 0.2, 0.45) * 0.5;
        const size = p.size[i] * scale * (0.7 + u * 1.1);
        putState(
          slice,
          i,
          origin.x + p.dirX[i] * rise + sway,
          origin.y + rise,
          origin.z + p.dirZ[i] * rise - sway,
          alpha,
          size,
        );
        putColor(slice, i, mix3(PALETTE_RGB.warmFill, PALETTE_RGB.cream, p.color[i] * 0.6));
      }
    },
  };
}

/** Crate-collision paper: 10 paper-colored flakes fluttering on analytic arcs. */
export function paperBurst(origin: XYZ, opts: SpawnOptions = {}): EffectInstance {
  const key = effectKey("paperBurst", opts);
  const rng = createRng(seededId(SEEDS.particles, key));
  const count = 10;
  const durationMs = 1500;
  const scale = opts.scale ?? 1;
  const p = buildBurstParams(
    rng,
    count,
    0.08,
    () => {
      const a = rng.range(0, Math.PI * 2);
      return [Math.cos(a), rng.range(0.5, 1.4), Math.sin(a)];
    },
    [0.9, 1.6],
    [0.14, 0.22],
  );
  const base = baseInstance("paperBurst", "normal", key, opts.triggerMs ?? 0, durationMs, count);
  const gravity = -5.2; // scene units / s^2
  return {
    ...base,
    write(tLocal, slice) {
      const life = durationMs * 0.92;
      for (let i = 0; i < count; i += 1) {
        const u = saturate((tLocal - p.delay[i] * durationMs) / life);
        const tSec = (u * life) / 1000;
        const x =
          origin.x +
          p.dirX[i] * p.speed[i] * scale * tSec +
          Math.sin(p.phase[i] + tSec * 7) * 0.1 * u;
        const y = origin.y + p.dirY[i] * p.speed[i] * scale * tSec + 0.5 * gravity * tSec * tSec;
        const z =
          origin.z +
          p.dirZ[i] * p.speed[i] * scale * tSec +
          Math.cos(p.phase[i] + tSec * 6) * 0.1 * u;
        // Size/alpha wobble reads as the paper quad rotating in flight.
        const flip = 0.45 + 0.55 * Math.abs(Math.sin(p.phase[i] + tSec * 11));
        const alpha = envelope(u, 0.08, 0.3);
        putState(slice, i, x, y, z, alpha, p.size[i] * scale * flip);
        putColor(slice, i, p.color[i] < 0.5 ? PALETTE_RGB.cream : PALETTE_RGB.creamWallLight);
      }
    },
  };
}

/** Stamp verdict dust: mint puff (approve) or gray-red puff (reject). */
export function stampDust(origin: XYZ, opts: SpawnOptions = {}): EffectInstance {
  const key = effectKey("stampDust", opts);
  const rng = createRng(seededId(SEEDS.particles, key));
  const count = 18;
  const durationMs = 700;
  const scale = opts.scale ?? 1;
  const approve = opts.variant !== "reject";
  const p = buildBurstParams(
    rng,
    count,
    0.12,
    () => {
      const a = rng.range(0, Math.PI * 2);
      const up = rng.range(0.15, 0.7);
      return [Math.cos(a), up, Math.sin(a)];
    },
    [0.5, 1.1],
    [0.1, 0.18],
  );
  const base = baseInstance("stampDust", "additive", key, opts.triggerMs ?? 0, durationMs, count);
  const cLow = approve ? PALETTE_RGB.mintDim : mix3(PALETTE_RGB.slate, PALETTE_RGB.dataRed, 0.45);
  const cHigh = approve
    ? PALETTE_RGB.mintBright
    : mix3(PALETTE_RGB.slate, PALETTE_RGB.dataRed, 0.7);
  return {
    ...base,
    write(tLocal, slice) {
      const life = durationMs * 0.88;
      for (let i = 0; i < count; i += 1) {
        const u = saturate((tLocal - p.delay[i] * durationMs) / life);
        // Radial burst with quadratic deceleration.
        const reach = (1 - Math.pow(1 - u, 2)) * p.speed[i] * 0.55 * scale;
        putState(
          slice,
          i,
          origin.x + p.dirX[i] * reach,
          origin.y + Math.max(p.dirY[i] * reach - 0.15 * u * u, -0.1),
          origin.z + p.dirZ[i] * reach,
          envelope(u, 0.12, 0.4) * 0.7,
          p.size[i] * scale * (1 + u * 0.8),
        );
        putColor(slice, i, mix3(cLow, cHigh, p.color[i]));
      }
    },
  };
}

/** Celebration confetti: mint/cream/amber family only, ~90 points. */
export function confettiBurst(origin: XYZ, opts: SpawnOptions = {}): EffectInstance {
  const key = effectKey("confettiBurst", opts);
  const rng = createRng(seededId(SEEDS.particles, key));
  const count = 90;
  const durationMs = 2400;
  const scale = opts.scale ?? 1;
  const p = buildBurstParams(
    rng,
    count,
    0.1,
    () => {
      const a = rng.range(0, Math.PI * 2);
      return [Math.cos(a), rng.range(1.2, 2.6), Math.sin(a)];
    },
    [0.8, 1.5],
    [0.12, 0.2],
  );
  // Locked family: mint, bright mint, cream, brass, light caramel. No purple/blue.
  const family: readonly Rgb[] = [
    PALETTE_RGB.mint,
    PALETTE_RGB.mintBright,
    PALETTE_RGB.cream,
    PALETTE_RGB.brass,
    PALETTE_RGB.caramelLight,
  ];
  const base = baseInstance(
    "confettiBurst",
    "confetti",
    key,
    opts.triggerMs ?? 0,
    durationMs,
    count,
  );
  const gravity = -3.4;
  return {
    ...base,
    write(tLocal, slice) {
      const life = durationMs * 0.9;
      for (let i = 0; i < count; i += 1) {
        const u = saturate((tLocal - p.delay[i] * durationMs) / life);
        const tSec = (u * life) / 1000;
        const x =
          origin.x +
          p.dirX[i] * p.speed[i] * scale * tSec * 0.6 +
          Math.sin(p.phase[i] + tSec * 9) * 0.15 * u;
        const y = origin.y + p.dirY[i] * p.speed[i] * scale * tSec + 0.5 * gravity * tSec * tSec;
        const z =
          origin.z +
          p.dirZ[i] * p.speed[i] * scale * tSec * 0.6 +
          Math.cos(p.phase[i] + tSec * 8) * 0.15 * u;
        const spin = 0.3 + 0.7 * Math.abs(Math.sin(p.phase[i] + tSec * 13));
        const alpha = envelope(u, 0.05, 0.25);
        putState(slice, i, x, y, z, alpha, p.size[i] * scale * spin);
        putColor(slice, i, family[Math.floor(p.color[i] * family.length) % family.length] as Rgb);
      }
    },
  };
}

/** Launch smoke: slate-gray cone burst along `direction`. */
export function cannonSmoke(origin: XYZ, opts: SpawnOptions = {}): EffectInstance {
  const key = effectKey("cannonSmoke", opts);
  const rng = createRng(seededId(SEEDS.particles, key));
  const count = 40;
  const durationMs = 1300;
  const scale = opts.scale ?? 1;
  const dir = normalizeDirection(opts.direction, 0, 1, 0);
  const p = buildBurstParams(
    rng,
    count,
    0.06,
    () => {
      // Cone around the launch direction with seeded spread.
      const a = rng.range(0, Math.PI * 2);
      const spread = rng.range(0.08, 0.42);
      const orthoA = orthogonal(dir);
      const orthoB = [
        dir[1] * orthoA[2] - dir[2] * orthoA[1],
        dir[2] * orthoA[0] - dir[0] * orthoA[2],
        dir[0] * orthoA[1] - dir[1] * orthoA[0],
      ] as const;
      return [
        dir[0] + (Math.cos(a) * orthoA[0] + Math.sin(a) * orthoB[0]) * spread,
        dir[1] + (Math.cos(a) * orthoA[1] + Math.sin(a) * orthoB[1]) * spread,
        dir[2] + (Math.cos(a) * orthoA[2] + Math.sin(a) * orthoB[2]) * spread,
      ];
    },
    [0.9, 1.9],
    [0.22, 0.4],
  );
  const base = baseInstance("cannonSmoke", "normal", key, opts.triggerMs ?? 0, durationMs, count);
  return {
    ...base,
    write(tLocal, slice) {
      const life = durationMs * 0.94;
      for (let i = 0; i < count; i += 1) {
        const u = saturate((tLocal - p.delay[i] * durationMs) / life);
        const reach = (1 - Math.pow(1 - u, 3)) * p.speed[i] * 0.8 * scale;
        putState(
          slice,
          i,
          origin.x + p.dirX[i] * reach,
          origin.y + p.dirY[i] * reach + 0.2 * u * u * scale,
          origin.z + p.dirZ[i] * reach,
          envelope(u, 0.1, 0.4) * 0.6,
          p.size[i] * scale * (0.8 + u * 1.6),
        );
        putColor(slice, i, mix3(PALETTE_RGB.slate, PALETTE_RGB.warmFill, p.color[i] * 0.5));
      }
    },
  };
}

/** Receipt sparks: small mint ticks rising at the tray. */
export function receiptSparks(origin: XYZ, opts: SpawnOptions = {}): EffectInstance {
  const key = effectKey("receiptSparks", opts);
  const rng = createRng(seededId(SEEDS.particles, key));
  const count = 12;
  const durationMs = 550;
  const scale = opts.scale ?? 1;
  const p = buildBurstParams(
    rng,
    count,
    0.35,
    () => {
      const a = rng.range(0, Math.PI * 2);
      return [Math.cos(a) * 0.4, 1, Math.sin(a) * 0.4];
    },
    [0.4, 0.8],
    [0.08, 0.14],
  );
  const base = baseInstance(
    "receiptSparks",
    "additive",
    key,
    opts.triggerMs ?? 0,
    durationMs,
    count,
  );
  return {
    ...base,
    write(tLocal, slice) {
      const life = durationMs * 0.65;
      for (let i = 0; i < count; i += 1) {
        const u = saturate((tLocal - p.delay[i] * durationMs) / life);
        const rise = (1 - Math.pow(1 - u, 2)) * p.speed[i] * 0.5 * scale;
        putState(
          slice,
          i,
          origin.x + p.dirX[i] * rise * 0.5,
          origin.y + rise,
          origin.z + p.dirZ[i] * rise * 0.5,
          envelope(u, 0.15, 0.35) * 0.9,
          p.size[i] * scale,
        );
        putColor(slice, i, mix3(PALETTE_RGB.mint, PALETTE_RGB.mintBright, p.color[i]));
      }
    },
  };
}

/** Pole pile-up dust: brief low warm-gray ring. */
export function poleDust(origin: XYZ, opts: SpawnOptions = {}): EffectInstance {
  const key = effectKey("poleDust", opts);
  const rng = createRng(seededId(SEEDS.particles, key));
  const count = 14;
  const durationMs = 650;
  const scale = opts.scale ?? 1;
  const p = buildBurstParams(
    rng,
    count,
    0.08,
    () => {
      const a = rng.range(0, Math.PI * 2);
      return [Math.cos(a), rng.range(0.05, 0.3), Math.sin(a)];
    },
    [0.5, 1.0],
    [0.14, 0.24],
  );
  const base = baseInstance("poleDust", "normal", key, opts.triggerMs ?? 0, durationMs, count);
  return {
    ...base,
    write(tLocal, slice) {
      const life = durationMs * 0.92;
      for (let i = 0; i < count; i += 1) {
        const u = saturate((tLocal - p.delay[i] * durationMs) / life);
        const reach = (1 - Math.pow(1 - u, 2)) * p.speed[i] * 0.5 * scale;
        putState(
          slice,
          i,
          origin.x + p.dirX[i] * reach,
          origin.y + p.dirY[i] * reach,
          origin.z + p.dirZ[i] * reach,
          envelope(u, 0.12, 0.4) * 0.55,
          p.size[i] * scale * (1 + u * 0.6),
        );
        putColor(slice, i, mix3(PALETTE_RGB.caramelLight, PALETTE_RGB.cream, p.color[i]));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory plumbing
// ---------------------------------------------------------------------------

const effectKey = (effectId: EffectId, opts: SpawnOptions): string =>
  `${effectId}@${opts.triggerMs ?? 0}#${opts.instance ?? 0}`;

const normalizeDirection = (
  d: XYZ | undefined,
  x: number,
  y: number,
  z: number,
): readonly [number, number, number] => {
  if (!d) return [x, y, z];
  const len = Math.hypot(d.x, d.y, d.z) || 1;
  return [d.x / len, d.y / len, d.z / len];
};

const orthogonal = (d: readonly [number, number, number]): readonly [number, number, number] => {
  const ax = Math.abs(d[0]);
  const ay = Math.abs(d[1]);
  const az = Math.abs(d[2]);
  const other: readonly [number, number, number] =
    ax < ay ? (ax < az ? [1, 0, 0] : [0, 0, 1]) : ay < az ? [0, 1, 0] : [0, 0, 1];
  const len = Math.hypot(other[0], other[1], other[2]);
  return [other[0] / len, other[1] / len, other[2] / len];
};

type EffectFactory = (origin: XYZ, opts: SpawnOptions) => EffectInstance;

const FACTORIES: Readonly<Record<EffectId, EffectFactory>> = {
  steamPuff,
  paperBurst,
  stampDust,
  confettiBurst,
  cannonSmoke,
  receiptSparks,
  poleDust,
};

/** Effect inventory as data (documentation/testing surface). */
export const EFFECT_SPEC: Readonly<
  Record<EffectId, { readonly pool: PoolId; readonly count: number; readonly durationMs: number }>
> = {
  steamPuff: { pool: "normal", count: 26, durationMs: 2600 },
  paperBurst: { pool: "normal", count: 10, durationMs: 1500 },
  stampDust: { pool: "additive", count: 18, durationMs: 700 },
  confettiBurst: { pool: "confetti", count: 90, durationMs: 2400 },
  cannonSmoke: { pool: "normal", count: 40, durationMs: 1300 },
  receiptSparks: { pool: "additive", count: 12, durationMs: 550 },
  poleDust: { pool: "normal", count: 14, durationMs: 650 },
};

// ---------------------------------------------------------------------------
// Shared pool implementation
// ---------------------------------------------------------------------------

const POOL_CAPACITY: Readonly<Record<PoolId, number>> = {
  normal: 256,
  additive: 96,
  confetti: 96,
};

interface Pool {
  readonly id: PoolId;
  readonly points: THREE.Points;
  readonly geometry: THREE.BufferGeometry;
  readonly pos: Float32Array;
  readonly col: Float32Array;
  readonly alpha: Float32Array;
  readonly size: Float32Array;
  used: number;
}

const createPool = (registry: ResourceRegistry, id: PoolId, blending: THREE.Blending): Pool => {
  const capacity = POOL_CAPACITY[id];
  const geometry = new THREE.BufferGeometry();
  const pos = new Float32Array(capacity * 3);
  const col = new Float32Array(capacity * 3);
  const alpha = new Float32Array(capacity);
  const size = new Float32Array(capacity);
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  geometry.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  const material = new THREE.ShaderMaterial({
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    uniforms: { uSizeScale: { value: 60 } },
    transparent: true,
    depthWrite: false,
    blending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.visible = false;
  registry.track(geometry);
  registry.track(material);
  return { id, points, geometry, pos, col, alpha, size, used: 0 };
};

export function createEffects(registry: ResourceRegistry): EffectSystem {
  const group = new THREE.Group();
  group.name = "diorama-effects";
  const pools: Readonly<Record<PoolId, Pool>> = {
    normal: createPool(registry, "normal", THREE.NormalBlending),
    additive: createPool(registry, "additive", THREE.AdditiveBlending),
    confetti: createPool(registry, "confetti", THREE.NormalBlending),
  };
  group.add(pools.normal.points, pools.additive.points, pools.confetti.points);

  const effects = new Map<string, EffectInstance>();
  const order: EffectInstance[] = [];
  let lastPoints = 0;

  const sliceFor = (pool: Pool, offset: number): PoolSlice => ({
    pos: pool.pos,
    col: pool.col,
    alpha: pool.alpha,
    size: pool.size,
    offset,
  });

  return {
    group,

    spawn(effectId, origin, opts = {}) {
      if (!isEffectId(effectId)) return false;
      const key = effectKey(effectId, opts);
      if (effects.has(key)) return true; // idempotent re-fire on seek
      const effect = FACTORIES[effectId](origin, opts);
      if (effects.size >= 64) return false; // authored-event sanity cap
      effects.set(key, effect);
      order.push(effect);
      return true;
    },

    update(timeMs) {
      let livePoints = 0;
      for (const pool of Object.values(pools)) pool.used = 0;

      for (const effect of order) {
        // Cyclic local time: windows crossing the 90 s seam still evaluate.
        const tLocal = (((timeMs - effect.triggerMs) % DURATION_MS) + DURATION_MS) % DURATION_MS;
        if (tLocal < 0 || tLocal >= effect.durationMs) continue; // outside window: invisible
        const pool = pools[effect.pool];
        if (pool.used + effect.count > POOL_CAPACITY[effect.pool]) continue; // budget guard
        const slice = sliceFor(pool, pool.used);
        effect.write(tLocal, slice);
        pool.used += effect.count;
        livePoints += effect.count;
      }

      lastPoints = livePoints;
      for (const pool of Object.values(pools)) {
        pool.geometry.setDrawRange(0, pool.used);
        pool.points.visible = pool.used > 0;
        if (pool.used > 0) {
          const attrs = pool.geometry.attributes;
          attrs.position.needsUpdate = true;
          attrs.aColor.needsUpdate = true;
          attrs.aAlpha.needsUpdate = true;
          attrs.aSize.needsUpdate = true;
        }
      }
    },

    clear() {
      effects.clear();
      order.length = 0;
      for (const pool of Object.values(pools)) {
        pool.used = 0;
        pool.geometry.setDrawRange(0, 0);
        pool.points.visible = false;
      }
      lastPoints = 0;
    },

    setViewport(pixelHeight, frustumHeight) {
      const scale = frustumHeight > 0 ? pixelHeight / frustumHeight : 60;
      for (const pool of Object.values(pools)) {
        const u = (pool.points.material as THREE.ShaderMaterial).uniforms.uSizeScale;
        if (u) u.value = scale;
      }
    },

    get counts(): EffectCounts {
      return { effects: effects.size, points: lastPoints, drawCalls: QUALITY.maxParticleDrawCalls };
    },
  };
}
