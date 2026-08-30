// Prod Farm: V1 faceted language under warm prod daylight. The crop rows are
// laid out as a candlestick chart, green columns climbing with one red pullback.

import * as THREE from "three";
import { plottedLine, grassTuft, rock } from "../geometry.js";
import { islandBase, stdMat, candleRow, scatter } from "./shared.js";
import { barn, tractor, windmill, fenceRun, sunflower, hayBale } from "../props.js";
import { PALETTE as P } from "../config.js";

const TOP = 3;

export function farm({ size }) {
  const g = new THREE.Group();
  const ticks = [];

  g.add(
    islandBase({
      size,
      thickness: TOP,
      top: 0x4f8a4f,
      layers: [0x8b837a, 0x6b5f55, 0x4a423b],
      seed: 201,
    }).group,
  );

  //Barn with faceted gambrel roof
  const b = barn({ w: 3.0, d: 2.2, h: 1.7 });
  b.position.set(-3.0, TOP, -2.6);
  b.rotation.y = 0.28;
  g.add(b);

  //Windmill, blades registered for animation
  const wm = windmill({ h: 2.65 });
  wm.position.set(-3.6, TOP, 1.9);
  g.add(wm);
  ticks.push((dt) => {
    wm.userData.blades.rotation.z += dt * 0.55;
  });

  //Tractor parked by the field
  const tr = tractor({ h: 0.72 });
  tr.position.set(1.1, TOP, 2.9);
  tr.rotation.y = -0.6;
  g.add(tr);

  //Crop field: four candlestick rows. Three green bull rows climb east, the
  //fourth row pulls back in loss red, exactly like a chart with one red candle
  const rowSeries = [
    [0.4, 0.52, 0.46, 0.6, 0.55, 0.68, 0.74],
    [0.5, 0.58, 0.54, 0.66, 0.72, 0.8, 0.88],
    [0.62, 0.7, 0.66, 0.78, 0.86, 0.95, 1.04],
    [0.8, 0.7, 0.74, 0.62, 0.68, 0.56, 0.6],
  ];
  rowSeries.forEach((series, i) => {
    const row = candleRow({
      series,
      spacing: 0.52,
      color: i === 3 ? P.shared.lossDeep : P.v1.prod.greens[i % 3],
      w: 0.2,
    });
    row.position.set(2.6, TOP + 0.02, -3.4 + i * 0.95);
    row.rotation.y = 0.06 * (i - 1.5);
    g.add(row);
  });
  //Tilled soil strip beneath the rows
  const soil = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.1, 3.9), stdMat(0x5c4633));
  soil.position.set(2.6, TOP + 0.03, -2.0);
  g.add(soil);

  //Fences framing the field and lining the farmhouse path
  const f1 = fenceRun({ length: 4.6, posts: 6 });
  f1.position.set(2.4, TOP, 0.6);
  g.add(f1);
  const f2 = fenceRun({ length: 3.0, posts: 4 });
  f2.position.set(-1.1, TOP, 3.6);
  f2.rotation.y = 1.35;
  g.add(f2);

  //Farmhouse path from the barn to the south edge
  g.add(
    plottedLine(
      [
        [-2.2, TOP + 0.06, -1.2],
        [-1.6, TOP + 0.06, 0.6],
        [-0.8, TOP + 0.06, 2.4],
        [0.0, TOP + 0.06, 4.2],
        [0.6, TOP + 0.06, 5.6],
      ],
      { color: 0xb59a72, radius: 0.15, emissiveIntensity: 0.04 },
    ),
  );

  //Sunflowers by the barn and hay bales near the fence
  const flowers = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const f = sunflower({});
    f.position.set(-4.6 + i * 0.55, TOP, -0.6 + (i % 2) * 0.4);
    flowers.add(f);
  }
  g.add(flowers);
  const h1 = hayBale({});
  h1.position.set(4.6, TOP + 0.3, 1.4);
  const h2 = hayBale({});
  h2.position.set(5.1, TOP + 0.28, 2.2);
  h2.rotation.y = 0.8;
  g.add(h1, h2);

  //Light natural scatter
  const grass = scatter({
    count: 10,
    radius: size / 2 - 1.4,
    seed: 233,
    avoid: [
      { x: 2.6, z: -2.0, r: 3.0 },
      { x: -3.0, z: -2.6, r: 2.2 },
      { x: -4.2, z: 1.6, r: 1.2 },
    ],
    make: (i) => grassTuft({ color: 0x5d9a55, size: 0.26, seed: 300 + i }),
  });
  grass.position.y = TOP;
  g.add(grass);
  const rocks = scatter({
    count: 4,
    radius: size / 2 - 2,
    seed: 244,
    avoid: [{ x: 2.6, z: -2.0, r: 3.0 }],
    make: (i) => rock({ size: 0.26, color: 0x8b837a, seed: 310 + i }),
  });
  rocks.position.y = TOP;
  g.add(rocks);

  return { group: g, ticks };
}
