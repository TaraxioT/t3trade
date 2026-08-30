// Nightly Caldera: the darkest island. V1 faceted basalt, a lava channel
// that reads as a descending loss-red trajectory spilling over the slab edge,
// drifting ash, and a monitoring station with a blueprint screen.

import * as THREE from "three";
import { facetedPeak, rock, plottedLine, grassTuft } from "../geometry.js";
import { islandBase, stdMat, glowMat, scatter } from "./shared.js";
import { burntTree } from "../props.js";
import { makeSmoke } from "../particles.js";
import { PALETTE as P } from "../config.js";

const TOP = 3.2;

export function volcano({ size }) {
  const g = new THREE.Group();
  const ticks = [];

  g.add(
    islandBase({
      size,
      thickness: TOP,
      top: 0x23262e,
      layers: [0x3a3542, 0x262133, 0x171325],
      seed: 601,
    }).group,
  );

  //Truncated faceted volcano: cone with a crater dish and glowing lava pool
  const cone = facetedPeak({
    radius: 4.4,
    height: 4.6,
    segments: 7,
    ramp: [0x171a21, 0x2c2f38, 0x565d6e],
    seed: 611,
    squash: 1.15,
  });
  cone.position.set(-1.4, TOP, -2.2);
  g.add(cone);
  const crater = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.15, 0.5, 7), stdMat(0x1a1c22));
  crater.position.set(-1.4, TOP + 4.35, -2.2);
  g.add(crater);
  const lavaPool = new THREE.Mesh(new THREE.CircleGeometry(1.1, 7), glowMat(0xff5a3c, 2.2));
  lavaPool.rotation.x = -Math.PI / 2;
  lavaPool.position.set(-1.4, TOP + 4.62, -2.2);
  g.add(lavaPool);

  //Secondary basalt peak
  const p2 = facetedPeak({
    radius: 2.3,
    height: 2.6,
    segments: 6,
    ramp: [0x181422, 0x262133, 0x3a3247],
    seed: 612,
    squash: 1.1,
  });
  p2.position.set(-4.9, TOP, 1.6);
  g.add(p2);

  //Lava trajectory: a loss-red plotted line from the crater, down the flank,
  //across the terrain and over the slab edge (the bear market spill)
  const lavaPts = [
    [-1.4, TOP + 4.5, -2.2],
    [-0.4, TOP + 2.8, -1.0],
    [0.8, TOP + 1.2, 0.4],
    [2.2, TOP + 0.55, 1.8],
    [3.9, TOP + 0.28, 3.2],
    [5.4, TOP + 0.18, 4.3],
    [6.3, TOP + 0.06, 5.0],
    [6.75, TOP - 1.4, 5.35],
    [7.05, TOP - 3.4, 5.6],
  ];
  const lava = plottedLine(lavaPts, { color: 0xff5a3c, radius: 0.3, emissiveIntensity: 2.0 });
  g.add(lava);
  const lavaDeep = plottedLine(lavaPts, { color: 0xd23a20, radius: 0.14, emissiveIntensity: 2.6 });
  g.add(lavaDeep);
  const branch = plottedLine(
    [
      [0.8, TOP + 1.2, 0.4],
      [2.2, TOP + 0.55, 1.4],
      [3.4, TOP + 0.3, 2.4],
      [4.4, TOP + 0.22, 3.4],
    ],
    { color: 0xff5a3c, radius: 0.18, emissiveIntensity: 1.7 },
  );
  g.add(branch);

  //Crater glow light, pulsing
  const glow = new THREE.PointLight(0xff6a45, 1.5, 11, 1.9);
  glow.position.set(-1.4, TOP + 5.4, -2.2);
  g.add(glow);

  //Ash column rising from the crater
  const ash = makeSmoke({
    origin: { x: -1.4, y: TOP + 4.7, z: -2.2 },
    count: 90,
    color: 0x6e6880,
    rise: 1.8,
    size: 2.3,
  });
  g.add(ash.object);
  ticks.push(ash.update);

  //Monitoring station: steel frame hut with a cyan blueprint screen
  const station = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.95, 1.0), stdMat(0x4d566a));
  frame.position.y = 0.48;
  station.add(frame);
  const stRoof = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.12, 1.15), stdMat(0x232833));
  stRoof.position.y = 1.0;
  station.add(stRoof);
  const legs = new THREE.Group();
  for (const [lx, lz] of [
    [-0.5, 0.38],
    [0.5, 0.38],
    [-0.5, -0.38],
    [0.5, -0.38],
  ]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.08), stdMat(0x2a2f3a));
    leg.position.set(lx, 0.25, lz);
    legs.add(leg);
  }
  station.add(legs);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.95, 0.55),
    glowMat(P.v3.nightly.glow, 1.9),
  );
  screen.position.set(0, 0.55, 0.52);
  station.add(screen);
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 1.2, 4), stdMat(0x4a5262));
  antenna.position.set(0.5, 1.6, -0.3);
  station.add(antenna);
  station.position.set(4.6, TOP, 0.8);
  station.rotation.y = 0.6;
  station.scale.setScalar(1.25);
  g.add(station);

  //Burnt trees and sparse dark vegetation
  for (const [tx, tz, tr] of [
    [1.6, 3.0, 0.5],
    [-4.6, 2.6, -0.4],
    [-0.2, -5.2, 0.9],
    [2.9, -3.6, 0.2],
  ]) {
    const tree = burntTree({ h: 1.0 + ((tx * 7) % 1) * 0.4, seed: 670 + Math.round(tx * 10 + tz) });
    tree.position.set(tx, TOP, tz);
    tree.rotation.y = tr;
    g.add(tree);
  }

  const tufts = scatter({
    count: 6,
    radius: size / 2 - 1.8,
    seed: 666,
    avoid: [
      { x: -1.4, z: -2.2, r: 4.2 },
      { x: 2.0, z: 2.0, r: 1.6 },
    ],
    make: (i) => grassTuft({ color: 0x3d3830, size: 0.2, seed: 690 + i }),
  });
  tufts.position.y = TOP;
  g.add(tufts);

  const rocks = scatter({
    count: 6,
    radius: size / 2 - 1.8,
    seed: 677,
    avoid: [{ x: -1.4, z: -2.2, r: 4.0 }],
    make: (i) => rock({ size: 0.32, color: i % 2 ? 0x2c2f38 : 0x3a3542, seed: 700 + i }),
  });
  rocks.position.y = TOP;
  g.add(rocks);

  //Electric-violet accent: a small marker ring at the lava edge exit
  const marker = new THREE.Mesh(
    new THREE.TorusGeometry(0.62, 0.07, 6, 18),
    glowMat(P.shared.indigo, 2.4),
  );
  marker.position.set(6.35, TOP + 0.12, 5.05);
  marker.rotation.x = Math.PI / 2;
  g.add(marker);

  //Lava + glow pulse
  let t = 0;
  ticks.push((dt) => {
    t += dt;
    const pulse = 0.85 + Math.sin(t * 1.7) * 0.18 + Math.sin(t * 3.3) * 0.06;
    lava.material.emissiveIntensity = 2.0 * pulse;
    lavaDeep.material.emissiveIntensity = 2.6 * pulse;
    lavaPool.material.emissiveIntensity = 2.2 * pulse;
    glow.intensity = 1.5 * pulse;
  });

  return { group: g, ticks };
}
