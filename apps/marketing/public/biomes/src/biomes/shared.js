// Shared building blocks used by every biome builder: palette-driven slab
// presets, candlestick chart props (the recurring trading motif), scatter
// helpers, the T3 monument, and the rain cloud.

import * as THREE from "three";
import { buildSlab, rock, grassTuft } from "../geometry.js";
import { rng } from "../util.js";
import { PALETTE as P } from "../config.js";

export const stdMat = (color, opts = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.88, ...opts });

export const glowMat = (color, intensity = 1.4) =>
  new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.45,
    flatShading: true,
  });

//Standard island base: top layer biome-colored, deeper layers carry the V2
//metal ramp or the channel's rock tones. insets grow with depth.
export function islandBase({ size, thickness, top, layers, seed }) {
  const strata = [{ height: 0.16, color: top, inset: 0.008 }];
  const n = layers.length;
  layers.forEach((color, i) => {
    strata.push({ height: (1 - 0.16) / n, color, inset: 0.02 + i * 0.018 });
  });
  return buildSlab({ size, thickness, strata, seed });
}

//One candlestick: body + upper/lower wick stubs, like the icon chart marks
export function candle({
  x = 0,
  z = 0,
  h = 0.5,
  w = 0.16,
  color,
  wick = 0xd8e2ea,
  up = 0.14,
  down = 0.1,
}) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), stdMat(color, { roughness: 0.7 }));
  body.position.y = h / 2;
  g.add(body);
  const wickMat = stdMat(wick, { roughness: 0.6 });
  const topW = new THREE.Mesh(new THREE.BoxGeometry(w * 0.16, up, w * 0.16), wickMat);
  topW.position.y = h + up / 2;
  const botW = new THREE.Mesh(new THREE.BoxGeometry(w * 0.16, down, w * 0.16), wickMat);
  botW.position.y = -down / 2;
  g.add(topW, botW);
  g.position.set(x, 0, z);
  return g;
}

//A run of candlesticks whose heights follow a deterministic series, so crop
//rows and path markers literally read as a trading chart
export function candleRow({
  series,
  spacing = 0.42,
  color,
  alt = null,
  w = 0.15,
  x = 0,
  z = 0,
  along = "x",
}) {
  const g = new THREE.Group();
  series.forEach((h, i) => {
    const c = candle({
      h: Math.max(0.16, h),
      w,
      color: alt && i % 4 === 3 ? alt : color,
      up: 0.08 + (i % 3) * 0.03,
    });
    const off = -((series.length - 1) * spacing) / 2 + i * spacing;
    if (along === "x") c.position.set(x + off, 0, z);
    else c.position.set(x, 0, z + off);
    g.add(c);
  });
  return g;
}

//Scatter props within a radius while avoiding a keep-out list of circles
export function scatter({
  count,
  radius,
  make,
  seed,
  avoid = [], //{x,z,r}
  minR = 0,
  scaleRange = [0.85, 1.2],
}) {
  const r = rng(seed);
  const g = new THREE.Group();
  let placed = 0;
  let guard = 0;
  while (placed < count && guard++ < count * 30) {
    const a = r.range(0, Math.PI * 2);
    const rr = minR + Math.sqrt(r.next()) * (radius - minR);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (avoid.some((k) => Math.hypot(x - k.x, z - k.z) < k.r)) continue;
    const m = make(placed);
    const s = r.range(scaleRange[0], scaleRange[1]);
    m.scale.setScalar(s);
    m.position.set(x, 0, z);
    m.rotation.y = r.range(0, Math.PI * 2);
    g.add(m);
    placed++;
  }
  return g;
}

//Extruded white T3 monument with a metal-gray back face, the V2 mark as
//architecture. Reads as signage at miniature scale.
export function t3Monument({ scale = 1, white, gray, plinth }) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(1.5 * scale, 0.28 * scale, 0.9 * scale),
    stdMat(plinth),
  );
  base.position.y = 0.14 * scale;
  g.add(base);
  const stem = new THREE.Mesh(
    new THREE.BoxGeometry(0.5 * scale, 0.16 * scale, 0.5 * scale),
    stdMat(gray),
  );
  stem.position.y = 0.34 * scale;
  g.add(stem);
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(1.1 * scale, 0.72 * scale, 0.1 * scale),
    stdMat(gray),
  );
  panel.position.set(0, 0.75 * scale, -0.08 * scale);
  g.add(panel);
  const w = stdMat(white, { roughness: 0.5 });
  const bar = (bw, bh, bx, by) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw * scale, bh * scale, 0.12 * scale), w);
    m.position.set(bx * scale, by * scale, 0);
    g.add(m);
  };
  //T
  bar(0.34, 0.1, -0.33, 0.95);
  bar(0.1, 0.42, -0.33, 0.72);
  //3 as three tiers stepping outward
  bar(0.26, 0.09, 0.18, 0.97);
  bar(0.3, 0.09, 0.22, 0.78);
  bar(0.34, 0.09, 0.26, 0.59);
  const r3a = new THREE.Mesh(new THREE.BoxGeometry(0.09 * scale, 0.16 * scale, 0.12 * scale), w);
  r3a.position.set(0.36 * scale, 0.93 * scale, 0);
  const r3b = new THREE.Mesh(new THREE.BoxGeometry(0.09 * scale, 0.16 * scale, 0.12 * scale), w);
  r3b.position.set(0.41 * scale, 0.62 * scale, 0);
  g.add(r3a, r3b);
  return g;
}

//Floating rain cloud: pale faceted cluster with a flat darker underside
export function rainCloud({ x = 0, z = 0, y = 7, scale = 1, seed = 31 }) {
  const r = rng(seed);
  const g = new THREE.Group();
  const puffs = 5;
  const topMat = stdMat(0xe8edf2, { roughness: 0.95 });
  const underMat = stdMat(0x9fb2c4, { roughness: 0.95 });
  for (let i = 0; i < puffs; i++) {
    const rad = (0.5 + r.range(0, 0.35)) * scale;
    const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(rad, 1), i < 2 ? underMat : topMat);
    puff.position.set(
      r.range(-0.9, 0.9) * scale,
      r.range(0, 0.35) * scale,
      r.range(-0.6, 0.6) * scale,
    );
    puff.scale.y = 0.72;
    g.add(puff);
  }
  const under = new THREE.Mesh(
    new THREE.CylinderGeometry(1.15 * scale, 1.2 * scale, 0.3 * scale, 7),
    underMat,
  );
  under.position.y = -0.2 * scale;
  g.add(under);
  g.position.set(x, y, z);
  return g;
}

//Ground scatter shortcuts. Props seed from (seed + index) so the whole
//scene stays deterministic across reloads.
export const scatterRocks = (opts) =>
  scatter({
    make: (i) =>
      rock({ size: opts.size ?? 0.4, color: opts.color, seed: (opts.seed ?? 1) * 97 + i }),
    ...opts,
  });
export const scatterGrass = (opts) =>
  scatter({
    make: (i) =>
      grassTuft({ color: opts.color, size: opts.size ?? 0.26, seed: (opts.seed ?? 1) * 53 + i }),
    ...opts,
  });
