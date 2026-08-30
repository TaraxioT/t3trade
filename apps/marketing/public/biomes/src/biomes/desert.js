// Dev Oasis: V1 faceted cuts in the dev channel language. Teal water, navy
// rock strata, stepped dune ridgelines like a depth chart, and the shared
// electric-indigo accent as a market awning.

import * as THREE from "three";
import { plottedLine, rock, grassTuft } from "../geometry.js";
import { islandBase, stdMat, glowMat, scatter } from "./shared.js";
import { palm, cactus, camel } from "../props.js";
import { PALETTE as P } from "../config.js";

const TOP = 3;

export function desert({ size }) {
  const g = new THREE.Group();
  const ticks = [];

  g.add(
    islandBase({
      size,
      thickness: TOP,
      top: 0xe3be7c,
      layers: [0x184669, 0x0b3258, 0x051c3a],
      seed: 301,
    }).group,
  );

  //Faceted dunes: squashed faceted mounds in two sand tones
  const dune = (x, z, s, color, seed) => {
    const geo = new THREE.IcosahedronGeometry(s, 1);
    const pos = geo.attributes.position;
    const r = { n: 0 };
    for (let v = 0; v < pos.count; v++) {
      pos.setXYZ(v, pos.getX(v) * (1 + ((v * 7 + seed) % 5) * 0.02), pos.getY(v), pos.getZ(v));
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, stdMat(color, { roughness: 1 }));
    m.scale.y = 0.32;
    m.position.set(x, TOP, z);
    m.rotation.y = seed;
    return m;
  };
  g.add(dune(-3.4, -3.6, 2.6, 0xd9ae66, 1));
  g.add(dune(-5.0, -1.2, 2.0, 0xe8c37e, 2));
  g.add(dune(4.4, -3.0, 2.2, 0xd9ae66, 3));

  //Stepped ridgeline: thin stacked plates descending like a depth profile
  const ridge = new THREE.Group();
  const stepColors = [0x184669, 0x2a5a80, 0x3d739a];
  for (let i = 0; i < 4; i++) {
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(2.4 - i * 0.3, 0.3, 0.9),
      stdMat(stepColors[Math.min(i, 2)]),
    );
    step.position.set(-0.4 + i * 1.15, TOP + 0.15 + i * 0.28, -4.4);
    step.rotation.y = -0.2;
    ridge.add(step);
  }
  g.add(ridge);

  //Oasis pond: bright dev-teal water with a soft emissive lift, rock rim
  const pond = new THREE.Mesh(
    new THREE.CircleGeometry(2.1, 22),
    new THREE.MeshStandardMaterial({
      color: P.v1.dev.teals[1],
      emissive: P.v1.dev.teals[2],
      emissiveIntensity: 0.35,
      roughness: 0.25,
      metalness: 0.1,
      transparent: true,
      opacity: 0.94,
    }),
  );
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(2.3, TOP + 0.04, 1.9);
  g.add(pond);
  const rim = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    const rr = rock({ size: 0.3, color: i % 2 ? 0x184669 : 0x2a5a80, seed: 320 + i });
    rr.position.set(2.3 + Math.cos(a) * 2.5, TOP, 1.9 + Math.sin(a) * 2.5);
    rim.add(rr);
  }
  g.add(rim);

  //Palms around the pond, cacti out in the sand
  const palmSpots = [
    [0.6, 3.2, 0.15],
    [3.8, 3.4, -0.3],
    [4.2, 0.4, 0.4],
  ];
  palmSpots.forEach(([x, z, rot], i) => {
    const p = palm({ h: 2.3 + i * 0.2, leaf: i === 1 ? 0x2f8a63 : 0x3f9a56, seed: 330 + i });
    p.position.set(x, TOP, z);
    p.rotation.y = rot;
    g.add(p);
  });
  const cacti = scatter({
    count: 3,
    radius: size / 2 - 2.2,
    seed: 355,
    avoid: [
      { x: 2.3, z: 1.9, r: 3.4 },
      { x: -3.4, z: -3.6, r: 2.8 },
      { x: -0.4, z: -4.4, r: 2.4 },
    ],
    make: (i) => {
      const c = cactus({ h: 0.9 + (i % 2) * 0.3, color: 0x4c9460 });
      return c;
    },
  });
  cacti.position.y = TOP;
  g.add(cacti);

  //Camel crossing the near sand
  const cm = camel({});
  cm.position.set(-2.8, TOP, 2.4);
  cm.rotation.y = 2.2;
  cm.scale.setScalar(0.9);
  g.add(cm);

  //Plotted teal road: a glowing V3 line running from the east edge to the pond
  g.add(
    plottedLine(
      [
        [5.7, TOP + 0.07, 2.8],
        [4.6, TOP + 0.07, 2.5],
        [3.4, TOP + 0.07, 2.1],
        [2.3, TOP + 0.07, 1.9],
      ],
      { color: P.v1.dev.teals[2], radius: 0.13, emissiveIntensity: 1.3 },
    ),
  );

  //Indigo market awning: the electric accent shared by every dev icon
  const stall = new THREE.Group();
  for (const sx of [-0.6, 0.6]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 0.08), stdMat(0x8a6239));
    post.position.set(sx, 0.55, 0);
    stall.add(post);
  }
  const canopy = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.07, 1.1),
    glowMat(P.shared.indigo, 0.9),
  );
  canopy.position.set(0, 1.12, 0);
  canopy.rotation.z = 0.1;
  stall.add(canopy);
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.5), stdMat(0x9c7a4f));
  crate.position.set(0.1, 0.2, 0.2);
  stall.add(crate);
  stall.position.set(-1.4, TOP, 4.2);
  stall.rotation.y = -0.4;
  g.add(stall);

  //Layered dimensional rocks (navy strata) on the west shoulder
  const shelf = new THREE.Group();
  const shelfCols = [0x0b3258, 0x184669, 0x2a5a80];
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(
      new THREE.BoxGeometry(2.6 - i * 0.5, 0.42, 1.8 - i * 0.35),
      stdMat(shelfCols[i]),
    );
    s.position.set(0, 0.21 + i * 0.42, 0);
    s.rotation.y = i * 0.14;
    shelf.add(s);
  }
  shelf.position.set(-4.4, TOP, 3.4);
  g.add(shelf);

  //Dry grass tufts
  const dry = scatter({
    count: 8,
    radius: size / 2 - 1.6,
    seed: 377,
    avoid: [
      { x: 2.3, z: 1.9, r: 2.8 },
      { x: -1.4, z: 4.2, r: 1.6 },
    ],
    make: (i) => grassTuft({ color: 0xc2a86a, size: 0.2, seed: 400 + i }),
  });
  dry.position.y = TOP;
  g.add(dry);

  //Pond shimmer
  let t = 0;
  ticks.push((dt) => {
    t += dt;
    pond.material.emissiveIntensity = 0.3 + Math.sin(t * 1.1) * 0.12;
  });

  return { group: g, ticks };
}
