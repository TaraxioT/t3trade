/**
 * Deterministic math helpers: seeded RNG, easing, interpolation, shortest-path
 * angles, periodic helpers, stable string hashing, and pure curve evaluation.
 *
 * Pure TypeScript: no THREE, no DOM, so story tests run in bare node.
 * Immutable XYZ objects are used instead of THREE.Vector3.
 */

import type { XYZ } from "./types";

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32)
// ---------------------------------------------------------------------------

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [a, b). */
  range(a: number, b: number): number;
  /** Uniform integer in [a, b] inclusive. */
  int(a: number, b: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed: number): Rng {
  // mulberry32: 32-bit state, deterministic across runs and platforms.
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error("Rng.pick called with an empty array");
      return items[Math.floor(next() * items.length)] as T;
    },
  };
}

/** FNV-1a 32-bit; maps arbitrary strings (IDs) to stable 32-bit seeds. */
export function hashStringToSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Seed derived from a namespace constant plus a subject ID (bot phases etc). */
export function seededId(namespaceSeed: number, id: string): number {
  return (hashStringToSeed(id) ^ namespaceSeed) >>> 0;
}

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const saturate = (value: number): number => clamp(value, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const inverseLerp = (a: number, b: number, value: number): number =>
  a === b ? 0 : (value - a) / (b - a);

export const remap = (
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number => lerp(outMin, outMax, saturate(inverseLerp(inMin, inMax, value)));

/** Cyclic value in [0, period); safe for negative time. */
export const periodic = (t: number, period: number): number =>
  period <= 0 ? 0 : ((t % period) + period) % period;

// ---------------------------------------------------------------------------
// Easing (t expected in [0, 1]; implementations clamp defensively)
// ---------------------------------------------------------------------------

export type Easing = (t: number) => number;

export const easeLinear: Easing = (t) => t;

export const easeSmoothstep: Easing = (t) => {
  const x = saturate(t);
  return x * x * (3 - 2 * x);
};

export const easeInOutCubic: Easing = (t) => {
  const x = saturate(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export const easeOutCubic: Easing = (t) => 1 - Math.pow(1 - saturate(t), 3);

export const easeOutBack: Easing = (t) => {
  const x = saturate(t);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

export const easeInQuad: Easing = (t) => {
  const x = saturate(t);
  return x * x;
};

export const easeOutQuad: Easing = (t) => {
  const x = saturate(t);
  return 1 - (1 - x) * (1 - x);
};

/** Small, restrained elastic settle (amplitude capped ~1.1). */
export const easeOutElasticSmall: Easing = (t) => {
  const x = saturate(t);
  if (x === 0 || x === 1) return x;
  const c4 = ((2 * Math.PI) / 3) * 0.7;
  return Math.pow(2, -9 * x) * Math.sin((x * 9 - 0.75) * c4) + 1;
};

export const EASINGS = {
  linear: easeLinear,
  smoothstep: easeSmoothstep,
  easeInOutCubic: easeInOutCubic,
  easeOutCubic: easeOutCubic,
  easeOutBack: easeOutBack,
  easeInQuad: easeInQuad,
  easeOutQuad: easeOutQuad,
  easeOutElastic: easeOutElasticSmall,
} as const;

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

/** Shortest signed delta from a to b, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Shortest-path angular interpolation; shortest branch never spins the long way. */
export function angleLerp(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * saturate(t);
}

// ---------------------------------------------------------------------------
// Curve paths (pure polyline + cubic segments)
// ---------------------------------------------------------------------------

export type CurveSegment =
  | { readonly kind: "line"; readonly from: XYZ; readonly to: XYZ }
  | {
      readonly kind: "cubic";
      readonly from: XYZ;
      readonly to: XYZ;
      readonly controlA: XYZ;
      readonly controlB: XYZ;
    };

export type CurvePath = readonly CurveSegment[];

/** Mutable evaluation target so hot paths allocate nothing. */
export interface CurveSampleOut {
  position: { x: number; y: number; z: number };
  tangent: { x: number; y: number; z: number };
}

export const createCurveSample = (): CurveSampleOut => ({
  position: { x: 0, y: 0, z: 0 },
  tangent: { x: 0, y: 0, z: 0 },
});

const dist = (a: XYZ, b: XYZ): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** Approximate segment length: exact for lines, control-polygon for cubics. */
const segmentLength = (segment: CurveSegment): number =>
  segment.kind === "line"
    ? dist(segment.from, segment.to)
    : dist(segment.from, segment.controlA) +
      dist(segment.controlA, segment.controlB) +
      dist(segment.controlB, segment.to);

/** Cumulative arc-length fractions used to parameterize the whole path. */
const cumulativeFractions = (path: CurvePath): number[] => {
  const lengths: number[] = [];
  let total = 0;
  for (const segment of path) {
    const length = segmentLength(segment);
    lengths.push(length);
    total += length;
  }
  const fractions: number[] = [];
  let running = 0;
  for (const length of lengths) {
    running += length;
    fractions.push(total <= 0 ? 1 : running / total);
  }
  return fractions;
};

/**
 * Evaluate a curve path at overall parameter t in [0, 1] (chord-length
 * parameterized). Writes position and normalized tangent into `out` and
 * returns it. An empty path throws; a single segment is parameterized exactly.
 */
export function evaluateCurve(path: CurvePath, t: number, out: CurveSampleOut): CurveSampleOut {
  if (path.length === 0) throw new Error("evaluateCurve called with an empty path");
  const fractions = cumulativeFractions(path);
  const x = saturate(t);

  let index = 0;
  const startFraction = (i: number): number => (i === 0 ? 0 : (fractions[i - 1] ?? 0));
  while (index < path.length - 1 && x > (fractions[index] ?? 1)) index += 1;

  const seg = path[index] as CurveSegment;
  const spanStart = startFraction(index);
  const spanEnd = fractions[index] ?? 1;
  const local = spanEnd <= spanStart ? 1 : saturate((x - spanStart) / (spanEnd - spanStart));

  if (seg.kind === "line") {
    out.position.x = lerp(seg.from.x, seg.to.x, local);
    out.position.y = lerp(seg.from.y, seg.to.y, local);
    out.position.z = lerp(seg.from.z, seg.to.z, local);
    const len = dist(seg.from, seg.to) || 1;
    out.tangent.x = (seg.to.x - seg.from.x) / len;
    out.tangent.y = (seg.to.y - seg.from.y) / len;
    out.tangent.z = (seg.to.z - seg.from.z) / len;
    return out;
  }

  // Cubic Bezier position and derivative (unnormalized tangent).
  const u = local;
  const v = 1 - u;
  const p0 = seg.from;
  const p1 = seg.controlA;
  const p2 = seg.controlB;
  const p3 = seg.to;
  out.position.x =
    v * v * v * p0.x + 3 * v * v * u * p1.x + 3 * v * u * u * p2.x + u * u * u * p3.x;
  out.position.y =
    v * v * v * p0.y + 3 * v * v * u * p1.y + 3 * v * u * u * p2.y + u * u * u * p3.y;
  out.position.z =
    v * v * v * p0.z + 3 * v * v * u * p1.z + 3 * v * u * u * p2.z + u * u * u * p3.z;
  const dx = 3 * v * v * (p1.x - p0.x) + 6 * v * u * (p2.x - p1.x) + 3 * u * u * (p3.x - p2.x);
  const dy = 3 * v * v * (p1.y - p0.y) + 6 * v * u * (p2.y - p1.y) + 3 * u * u * (p3.y - p2.y);
  const dz = 3 * v * v * (p1.z - p0.z) + 6 * v * u * (p2.z - p1.z) + 3 * u * u * (p3.z - p2.z);
  const len = Math.hypot(dx, dy, dz) || 1;
  out.tangent.x = dx / len;
  out.tangent.y = dy / len;
  out.tangent.z = dz / len;
  return out;
}

/** Total chord-polygon length of a path (gate stride, speed planning). */
export function curveLength(path: CurvePath): number {
  let total = 0;
  for (const segment of path) total += segmentLength(segment);
  return total;
}
