// Central Forest: the unified T3 identity island. V1 faceted peaks in the
// prod green ramp, V2 metal strata + white T3 monument, V3 glowing plotted
// river that spills over the slab edge as a waterfall, rain cloud overhead.

import * as THREE from "three";
import { facetedPeak, pine, rock, plottedLine, grassTuft } from "../geometry.js";
import {
  islandBase,
  stdMat,
  glowMat,
  candleRow,
  scatter,
  t3Monument,
  rainCloud,
} from "./shared.js";
import { makeRain, makeWaterfallFall, makeSmoke } from "../particles.js";
import { rng } from "../util.js";
import { PALETTE as P } from "../config.js";

const TOP = 4.4; //slab thickness; features sit on top of this

export function forest({ size }) {
  const g = new THREE.Group();
  const ticks = [];
  const r = rng(101);

  //Slab: prod grass over the V2 metal ramp
  const base = islandBase({
    size,
    thickness: TOP,
    top: 0x4b8a66,
    layers: [0x8b8d90, 0x66676a, 0x47484b, 0x353738],
    seed: 11,
  });
  g.add(base.group);

  //Faceted mountain cluster, per-face greens from the V1 prod ramp
  const PROD_RAMP = [0x114d3a, 0x187652, 0x2f9e74, 0x56e5ad];
  const ROCK_RAMP = [0x3f454d, 0x6e767e, 0x9aa3ad];
  const peakDefs = [
    { x: -5.6, z: -4.8, rad: 4.4, h: 7.4, ramp: PROD_RAMP, seed: 21, squash: 1.12 },
    {
      x: -1.6,
      z: -6.6,
      rad: 3.4,
      h: 5.6,
      ramp: [0x0f4232, 0x145a43, 0x2f9e74, 0x4fd6a1],
      seed: 22,
      squash: 1.1,
    },
    { x: -8.2, z: -1.2, rad: 3.0, h: 4.8, ramp: PROD_RAMP, seed: 23, squash: 1.08 },
    { x: 2.8, z: -7.8, rad: 2.4, h: 3.9, ramp: ROCK_RAMP, seed: 24, squash: 1.05 },
  ];
  for (const p of peakDefs) {
    const peak = facetedPeak({
      radius: p.rad,
      height: p.h,
      segments: 6,
      ramp: p.ramp,
      seed: p.seed,
      squash: p.squash,
    });
    peak.position.set(p.x, TOP, p.z);
    g.add(peak);
  }

  //Terrain variation: low grassy plates near the front and east
  for (const [x, z, w, d] of [
    [3.5, 5.5, 4.4, 3.2],
    [-6.5, 4.2, 3.4, 2.6],
    [6.6, -2.4, 3.0, 3.6],
  ]) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w, 0.34, d), stdMat(0x529470));
    plate.position.set(x + r.range(-0.3, 0.3), TOP + 0.17, z + r.range(-0.3, 0.3));
    plate.rotation.y = r.range(-0.12, 0.12);
    g.add(plate);
  }

  //The river: a glowing V3 plotted line from the peaks across the terrain to
  //the slab edge, descending gently like a price path finding its way out
  const riverPts = [
    [-4.2, TOP + 0.5, -3.2],
    [-2.4, TOP + 0.34, -0.4],
    [0.2, TOP + 0.24, 1.4],
    [3.2, TOP + 0.18, 2.4],
    [6.0, TOP + 0.14, 3.0],
    [8.6, TOP + 0.1, 3.6],
  ];
  const river = plottedLine(riverPts, {
    color: P.v3.prod.cyan,
    radius: 0.4,
    emissiveIntensity: 1.1,
  });
  g.add(river);

  //Waterfall where the river leaves the slab: ribbon + falling particles + mist
  const fallTop = new THREE.Vector3(9.4, TOP + 0.05, 3.9);
  const fallBottom = new THREE.Vector3(9.4, TOP - 5.2, 4.15);
  const ribbon = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 5.4, 1, 6),
    new THREE.MeshStandardMaterial({
      color: 0xbfe9f5,
      emissive: 0x9fd8ec,
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.85,
      roughness: 0.3,
      side: THREE.DoubleSide,
    }),
  );
  ribbon.position.set(
    (fallTop.x + fallBottom.x) / 2 - 0.25,
    (fallTop.y + fallBottom.y) / 2,
    (fallTop.z + fallBottom.z) / 2,
  );
  ribbon.rotation.y = -Math.PI / 2.6;
  ribbon.rotation.z = 0.12;
  g.add(ribbon);
  const fallParts = makeWaterfallFall({
    top: { x: 9.3, y: TOP + 0.1, z: 3.8 },
    bottom: { x: 9.3, y: TOP - 5.4, z: 4.0 },
    width: 1.1,
    count: 120,
  });
  g.add(fallParts.object);
  ticks.push(fallParts.update);
  const mist = makeSmoke({
    origin: { x: 9.2, y: TOP - 5.0, z: 4.3 },
    count: 40,
    color: 0xcfe6f0,
    rise: 0.7,
    size: 1.45,
  });
  g.add(mist.object);
  ticks.push(mist.update);

  //Rain cloud above the mountain shoulder with rain beneath it and a wet
  //ground patch, so the rainfall reads as local weather
  const cloud = rainCloud({ x: -7, z: -4.5, y: TOP + 3.4, scale: 1.35, seed: 33 });
  g.add(cloud);
  const rain = makeRain({
    center: { x: -7, y: TOP + 0.2, z: -4.5 },
    radius: 2.9,
    height: 3.2,
    count: 260,
  });
  g.add(rain.object);
  ticks.push(rain.update);
  const wet = new THREE.Mesh(
    new THREE.CircleGeometry(3.1, 20),
    stdMat(0x376b52, { roughness: 0.55 }),
  );
  wet.rotation.x = -Math.PI / 2;
  wet.position.set(-7, TOP + 0.035, -4.5);
  g.add(wet);

  //Cabin with warm windows, front-left clearing
  const cabinGroup = new THREE.Group();
  const cb = new THREE.Group();
  const walls = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.5, 1.9), stdMat(0x7a5334));
  walls.position.y = 0.75;
  cb.add(walls);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 1.9, 1.15, 4, 1), stdMat(0x4a3527));
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 2.05;
  roof.scale.set(1.26, 1, 1);
  cb.add(roof);
  const winMat = new THREE.MeshStandardMaterial({
    color: 0xffc46b,
    emissive: 0xffb45e,
    emissiveIntensity: 1.6,
    roughness: 0.4,
  });
  const chim = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.9, 0.34), stdMat(0x6e6a66));
  chim.position.set(0.7, 2.3, -0.3);
  cb.add(chim);
  for (const [wx, wz] of [
    [-0.55, 0.96],
    [0.55, 0.96],
    [0, 0.96],
  ]) {
    const win = new THREE.Mesh(
      new THREE.BoxGeometry(wz > 0.9 && wx === 0 ? 0.5 : 0.36, 0.42, 0.06),
      winMat,
    );
    win.position.set(wx, 0.8, wz);
    cb.add(win);
  }
  cb.position.set(-4.6, TOP, 5.2);
  cb.rotation.y = 0.5;
  cabinGroup.add(cb);
  g.add(cabinGroup);

  //T3 monument: the V2 extruded white mark as architecture
  const monument = t3Monument({
    scale: 1.5,
    white: P.v2.prod.white,
    gray: 0x747679,
    plinth: 0x47484b,
  });
  monument.position.set(3.4, TOP + 0.3, 5.6);
  monument.rotation.y = -0.35;
  g.add(monument);

  //Candlestick path markers: green row flanking left, red row right (the
  //V2 prod bull/bear flanking, laid out as a path from cabin to monument)
  const bullSeries = [0.5, 0.62, 0.55, 0.7, 0.66, 0.82, 0.9, 0.78, 1.0, 0.92];
  const bearSeries = [0.9, 0.72, 0.8, 0.6, 0.66, 0.5, 0.58, 0.44, 0.52, 0.4];
  const bull = candleRow({
    series: bullSeries,
    spacing: 0.62,
    color: P.shared.profit,
    x: -0.6,
    z: 5.4,
    along: "x",
    w: 0.17,
  });
  bull.position.set(-0.6, TOP + 0.02, 4.35);
  const bear = candleRow({
    series: bearSeries,
    spacing: 0.62,
    color: P.shared.lossDeep,
    x: -0.6,
    z: 6.6,
    along: "x",
    w: 0.17,
  });
  bear.position.set(-0.6, TOP + 0.02, 6.6);
  g.add(bull, bear);

  //Dirt path ribbon under the candles
  const path = plottedLine(
    [
      [-4.2, TOP + 0.06, 5.5],
      [-2.4, TOP + 0.06, 5.5],
      [-0.4, TOP + 0.06, 5.5],
      [1.6, TOP + 0.06, 5.5],
      [3.0, TOP + 0.06, 5.5],
    ],
    { color: 0xa8946f, radius: 0.16, emissiveIntensity: 0.05 },
  );
  g.add(path);

  //Bridge over the river where the path network meets it
  const bridge = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.09, 3.0), stdMat(P.earth.wood));
  bridge.add(deck);
  for (const bx of [-0.44, 0.44]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 3.0), stdMat(P.earth.woodDark));
    rail.position.set(bx, 0.34, 0);
    bridge.add(rail);
  }
  bridge.position.set(1.1, TOP + 0.3, 1.9);
  bridge.rotation.y = -1.05;
  g.add(bridge);

  //Pines: denser toward the north and east edges, avoiding the river and cabin
  const pineScatter = scatter({
    count: 16,
    radius: size / 2 - 1.4,
    seed: 55,
    avoid: [
      { x: -4, z: -4, r: 6.5 }, //mountains
      { x: 2, z: 1, r: 4.2 }, //river mid
      { x: 8.4, z: 3.4, r: 2.6 }, //waterfall
      { x: -4.6, z: 5.2, r: 2.6 }, //cabin
      { x: 3.4, z: 5.6, r: 2.4 }, //monument
      { x: -0.6, z: 5.5, r: 3.6 }, //candle path
    ],
    make: (i) =>
      pine({
        height: 2.1 + (i % 4) * 0.35,
        tiers: 3,
        leaf: i % 3 === 0 ? 0x2e6d4f : 0x38845e,
        trunk: 0x4a3627,
        seed: 60 + i,
      }),
  });
  pineScatter.position.y = TOP;
  g.add(pineScatter);

  //Rocks and grass clusters
  const rocks = scatter({
    count: 9,
    radius: size / 2 - 1.6,
    seed: 77,
    avoid: [
      { x: -4, z: -4, r: 5.5 },
      { x: -0.6, z: 5.5, r: 3.4 },
      { x: 3.4, z: 5.6, r: 2.2 },
    ],
    make: (i) =>
      rock({ size: 0.32 + (i % 3) * 0.14, color: i % 2 ? 0x6e767e : 0x7d848e, seed: 90 + i }),
  });
  rocks.position.y = TOP;
  g.add(rocks);
  const grass = scatter({
    count: 14,
    radius: size / 2 - 1.8,
    seed: 88,
    avoid: [
      { x: -4, z: -4, r: 5 },
      { x: 8.4, z: 3.4, r: 2.2 },
    ],
    make: (i) => grassTuft({ color: 0x4c9168, size: 0.3, seed: 120 + i }),
  });
  grass.position.y = TOP;
  g.add(grass);

  //Subtle life: river glow pulse + cloud bob
  let t = 0;
  ticks.push((dt) => {
    t += dt;
    river.material.emissiveIntensity = 1.05 + Math.sin(t * 1.4) * 0.18;
    cloud.position.y = TOP + 3.4 + Math.sin(t * 0.5) * 0.16;
  });

  return { group: g, ticks };
}
