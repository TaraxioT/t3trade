// Dev Glacier: V3 blueprint illumination over ice. A glowing cyan plotted
// line runs beneath the frozen stream to the tile edge, the research station
// carries crosshair marks, a cable car glides, and snow drifts.

import * as THREE from "three";
import { facetedPeak, pine, rock, plottedLine, gridFragment } from "../geometry.js";
import { islandBase, stdMat, glowMat, scatter } from "./shared.js";
import { cableCar } from "../props.js";
import { makeSnow } from "../particles.js";
import { PALETTE as P } from "../config.js";

const TOP = 3.2;

export function glacier({ size }) {
  const g = new THREE.Group();
  const ticks = [];

  g.add(
    islandBase({
      size,
      thickness: TOP,
      top: 0xedf4f7,
      layers: [0xb1d8f2, 0x8eb7d4, 0x4e7694, 0x174566],
      seed: 501,
    }).group,
  );

  //Snow faceted peaks with steel shadow sides
  const p1 = facetedPeak({
    radius: 3.6,
    height: 5.2,
    segments: 6,
    ramp: [0xc7dcea, 0xe6f0f6, 0xffffff],
    seed: 511,
    snow: 0xffffff,
    squash: 1.12,
  });
  p1.position.set(-2.6, TOP, -3.2);
  g.add(p1);
  const p2 = facetedPeak({
    radius: 2.6,
    height: 3.8,
    segments: 5,
    ramp: [0xb8cddd, 0xdfe9f0, 0xf4f9fb],
    seed: 512,
    snow: 0xf8fbfd,
    squash: 1.1,
  });
  p2.position.set(1.8, TOP, -4.4);
  g.add(p2);
  const p3 = facetedPeak({
    radius: 2.0,
    height: 3.0,
    segments: 5,
    ramp: [0x5c85a6, 0x8eb7d4, 0xb1d8f2],
    seed: 513,
    squash: 1.05,
  });
  p3.position.set(-5.2, TOP, 0.6);
  g.add(p3);

  //Ice cliffs: faceted steel-blue slabs on the west edge
  for (let i = 0; i < 3; i++) {
    const cliff = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 1.1 + i * 0.5, 1.2),
      stdMat([0x8eb7d4, 0x6d94b4, 0x4e7694][i]),
    );
    cliff.position.set(-4.6 + i * 0.9, TOP + (1.1 + i * 0.5) / 2, 3.0 - i * 0.8);
    cliff.rotation.y = 0.4 - i * 0.15;
    g.add(cliff);
  }

  //Frozen stream: translucent ice strip with the glowing cyan plotted line
  //running beneath it, descending to the slab edge
  const ice = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 7.6),
    new THREE.MeshStandardMaterial({
      color: 0xbfe0ec,
      transparent: true,
      opacity: 0.55,
      roughness: 0.15,
      metalness: 0.2,
    }),
  );
  ice.rotation.x = -Math.PI / 2;
  ice.rotation.z = 0.5;
  ice.position.set(-0.6, TOP + 0.09, 0.6);
  g.add(ice);
  const streamLine = plottedLine(
    [
      [1.8, TOP + 0.05, -2.9],
      [0.6, TOP + 0.05, -1.2],
      [-0.3, TOP + 0.06, 0.6],
      [-0.9, TOP + 0.05, 2.4],
      [-1.2, TOP + 0.04, 4.0],
      [-1.3, TOP + 0.02, 5.8],
    ],
    { color: P.v3.dev.cyans[0], radius: 0.12, emissiveIntensity: 2.0 },
  );
  g.add(streamLine);

  //Research station: white hut, antenna, crosshair panel (blueprint marks)
  const station = new THREE.Group();
  const hut = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.0, 1.3), stdMat(0xf4f8fa));
  hut.position.y = 0.5;
  station.add(hut);
  const hutRoof = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 1.35, 0.55, 4, 1),
    stdMat(0x4e7694),
  );
  hutRoof.rotation.y = Math.PI / 4;
  hutRoof.position.y = 1.25;
  station.add(hutRoof);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.6, 4), stdMat(0x4e7694));
  mast.position.set(0.6, 1.8, -0.3);
  station.add(mast);
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 6, 5),
    glowMat(P.shared.indigo, 2.0),
  );
  beacon.position.set(0.6, 2.62, -0.3);
  station.add(beacon);
  //Crosshair plate on the hut face
  const chMat = glowMat(P.v3.dev.cyans[0], 1.5);
  const hLine = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.035, 0.02), chMat);
  hLine.position.set(0, 0.62, 0.67);
  const vLine = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.6, 0.02), chMat);
  vLine.position.set(0, 0.62, 0.67);
  station.add(hLine, vLine);
  station.position.set(3.2, TOP, 2.4);
  station.rotation.y = -0.5;
  g.add(station);

  //Cable car gliding between two pylons on the east side
  const car = cableCar({ span: 5.2, height: 2.8, t: 0.2 });
  car.position.set(3.6, TOP, -1.4);
  car.rotation.y = 0.9;
  g.add(car);
  let carT = 0.2;
  let dir = 1;
  ticks.push((dt) => {
    carT += dt * 0.045 * dir;
    if (carT > 0.85) dir = -1;
    if (carT < 0.1) dir = 1;
    const x = -5.2 / 2 + 5.2 * carT;
    car.userData.pod.position.x = x;
    car.userData.podWin.position.x = x;
    car.userData.arm.position.x = x;
  });

  //Frozen pines scattered between the peaks and the station
  const trees = scatter({
    count: 7,
    radius: size / 2 - 2,
    seed: 555,
    avoid: [
      { x: -2.6, z: -3.2, r: 3.4 },
      { x: 1.8, z: -4.4, r: 2.4 },
      { x: 3.2, z: 2.4, r: 1.8 },
      { x: 3.6, z: -1.4, r: 2.6 },
      { x: -0.6, z: 0.6, r: 1.6 },
    ],
    make: (i) =>
      pine({
        height: 1.7 + (i % 3) * 0.3,
        tiers: 3,
        leaf: i % 2 ? 0xa8ccd8 : 0x8fb8c6,
        trunk: 0x51626e,
        seed: 570 + i,
      }),
  });
  trees.position.y = TOP;
  g.add(trees);

  const rocks = scatter({
    count: 5,
    radius: size / 2 - 2.2,
    seed: 566,
    avoid: [
      { x: -2.6, z: -3.2, r: 3.2 },
      { x: -0.6, z: 0.6, r: 1.8 },
    ],
    make: (i) => rock({ size: 0.3, color: i % 2 ? 0xdfe9f0 : 0x8eb7d4, seed: 590 + i }),
  });
  rocks.position.y = TOP;
  g.add(rocks);

  //Cool blueprint illumination: one low cyan light over the island
  const cool = new THREE.PointLight(P.v3.dev.cyans[0], 0.55, 16, 1.8);
  cool.position.set(0, TOP + 4.5, 0);
  g.add(cool);

  //Drifting snow
  const snow = makeSnow({
    center: { x: 0, y: TOP + 2.4, z: 0 },
    spread: size * 0.8,
    height: 6.5,
    count: 150,
  });
  g.add(snow.object);
  ticks.push(snow.update);

  //Beacon + stream pulse
  let t = 0;
  ticks.push((dt) => {
    t += dt;
    beacon.material.emissiveIntensity = 1.6 + Math.sin(t * 2.2) * 0.6;
    streamLine.material.emissiveIntensity = 1.8 + Math.sin(t * 1.3) * 0.35;
  });

  return { group: g, ticks };
}
