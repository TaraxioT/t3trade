// Dev Shore: V2 dimensional language in the dev ice palette. Extruded white
// lifeguard tower, layered rock shelves, pale-blue shallow water with an
// animated foam edge that meets the slab side like a tiny ocean drop-off.

import * as THREE from "three";
import { rock } from "../geometry.js";
import { islandBase, stdMat, candleRow, scatter } from "./shared.js";
import { makeWaterfallFall } from "../particles.js";
import { umbrella, lounger, lifeguardTower, figure } from "../props.js";
import { PALETTE as P } from "../config.js";

const TOP = 3;

export function beach({ size }) {
  const g = new THREE.Group();
  const ticks = [];

  g.add(
    islandBase({
      size,
      thickness: TOP,
      top: 0xf4f8f0,
      layers: [0xa5c8e2, 0x5d88a8, 0x2a5578],
      seed: 401,
    }).group,
  );

  //Shallow sea covering the back third, drawn as a soft inset plane that
  //visibly meets the slab's north side
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(size - 1.2, 4.6),
    new THREE.MeshStandardMaterial({
      color: 0x9be0e2,
      emissive: P.v2.dev.blues[1],
      emissiveIntensity: 0.42,
      roughness: 0.2,
      metalness: 0.15,
      transparent: true,
      opacity: 0.92,
    }),
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(0.2, TOP + 0.07, -3.4);
  g.add(sea);

  //Foam edge where sea meets sand: a pale strip that pulses gently
  const foam = new THREE.Mesh(
    new THREE.PlaneGeometry(size - 1.4, 0.5),
    new THREE.MeshStandardMaterial({
      color: 0xf2faf8,
      emissive: 0xe2f6f2,
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.8,
      roughness: 0.4,
    }),
  );
  foam.rotation.x = -Math.PI / 2;
  foam.position.set(0.2, TOP + 0.1, -1.2);
  g.add(foam);

  //Dimensional rock shelves stepping down into the water on the east side
  const shelf = new THREE.Group();
  const cols = [0x4e7694, 0x6d94b4, 0x8eb7d4];
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(
      new THREE.BoxGeometry(2.4 - i * 0.4, 0.4, 2.0 - i * 0.3),
      stdMat(cols[i]),
    );
    s.position.set(3.4, 0.2 + i * 0.4, -3.6 + i * 0.7);
    s.rotation.y = 0.2 - i * 0.1;
    shelf.add(s);
  }
  shelf.position.set(1.6, TOP, 0);
  g.add(shelf);

  //Lifeguard tower in extruded V2 white with warm roof
  const tower = lifeguardTower({ wood: P.v2.dev.ice, roof: 0xd95f43 });
  tower.position.set(-3.6, TOP, -2.4);
  tower.rotation.y = 0.5;
  g.add(tower);

  //Umbrellas and loungers on the sand
  const u1 = umbrella({ canvasA: P.v2.dev.ice, canvasB: 0x5b84c4 });
  u1.position.set(-1.0, TOP, 1.6);
  g.add(u1);
  const u2 = umbrella({ canvasA: P.v2.dev.ice, canvasB: 0x4e7694 });
  u2.position.set(2.6, TOP, 2.4);
  u2.rotation.y = 1.2;
  g.add(u2);
  const l1 = lounger({});
  l1.position.set(-0.2, TOP, 2.5);
  l1.rotation.y = 0.4;
  const l2 = lounger({ cloth: 0x8eb7d4 });
  l2.position.set(1.7, TOP, 3.1);
  l2.rotation.y = -0.2;
  g.add(l1, l2);

  //Tiny swimmers in the shallows
  const sw1 = figure({});
  sw1.position.set(-0.6, TOP + 0.02, -2.6);
  sw1.rotation.y = 2.4;
  const sw2 = figure({ suit: 0x4e7694 });
  sw2.position.set(1.4, TOP + 0.02, -3.4);
  sw2.rotation.y = -1.8;
  g.add(sw1, sw2);

  //Pale-blue candle cluster on the sand (the V3 og-card pale candles)
  const candles = candleRow({
    series: [0.4, 0.55, 0.48, 0.62, 0.58],
    spacing: 0.5,
    color: P.v2.dev.blues[0],
    w: 0.18,
  });
  candles.position.set(-2.6, TOP + 0.02, 0.4);
  candles.rotation.y = 1.35;
  g.add(candles);

  //Shells and a few rocks
  const shells = scatter({
    count: 7,
    radius: size / 2 - 2,
    seed: 433,
    avoid: [
      { x: -1, z: 1.6, r: 1.4 },
      { x: 2.6, z: 2.4, r: 1.2 },
      { x: 0, z: -3.4, r: 4 },
    ],
    make: (i) => {
      const s = new THREE.Mesh(
        new THREE.ConeGeometry(0.09, 0.14, 5),
        stdMat(i % 2 ? 0xf3f0e8 : 0xe3c8b0),
      );
      s.rotation.z = 1.2;
      return s;
    },
  });
  shells.position.y = TOP;
  g.add(shells);
  const rocks = scatter({
    count: 3,
    radius: size / 2 - 2.4,
    seed: 444,
    avoid: [
      { x: 0, z: -3.4, r: 4.4 },
      { x: -1, z: 1.6, r: 1.6 },
    ],
    make: (i) => rock({ size: 0.3, color: 0x6d94b4, seed: 460 + i }),
  });
  rocks.position.y = TOP;
  g.add(rocks);

  //Ocean meets the floating slab: a soft water edge spilling over the back
  //side, the shoreline counterpart of the forest waterfall
  const edgeFall = makeWaterfallFall({
    top: { x: 0.2, y: TOP + 0.06, z: -5.45 },
    bottom: { x: 0.2, y: TOP - 4.6, z: -5.7 },
    width: 3.6,
    count: 90,
    color: 0xc4e6f5,
  });
  g.add(edgeFall.object);
  ticks.push(edgeFall.update);
  const edgeRibbon = new THREE.Mesh(
    new THREE.PlaneGeometry(3.8, 4.7, 1, 5),
    new THREE.MeshStandardMaterial({
      color: 0xa8d4ee,
      emissive: 0x8ec4e2,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.55,
      roughness: 0.3,
      side: THREE.DoubleSide,
    }),
  );
  edgeRibbon.position.set(0.2, TOP - 2.32, -5.62);
  edgeRibbon.rotation.x = 0.06;
  g.add(edgeRibbon);
  const edgeFoam = new THREE.Mesh(
    new THREE.PlaneGeometry(3.9, 0.4),
    new THREE.MeshStandardMaterial({
      color: 0xf2faf8,
      emissive: 0xe2f6f2,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.7,
      roughness: 0.4,
    }),
  );
  edgeFoam.rotation.x = -Math.PI / 2;
  edgeFoam.position.set(0.2, TOP + 0.11, -5.35);
  g.add(edgeFoam);

  //Gentle wave motion: foam pulse + sea bob
  let t = 0;
  ticks.push((dt) => {
    t += dt;
    foam.material.opacity = 0.62 + Math.sin(t * 1.5) * 0.18;
    foam.position.z = -1.2 + Math.sin(t * 0.7) * 0.14;
    sea.position.y = TOP + 0.07 + Math.sin(t * 1.1) * 0.02;
    edgeFoam.material.opacity = 0.55 + Math.sin(t * 1.5 + 1) * 0.15;
  });

  return { group: g, ticks };
}
