// Nightly Wetlands: V3 blueprint glow over reflective dark water. Grid
// fragments float on the surface, plotted cyan lines cross the marsh,
// mushrooms glow, walkways lead to an observation post, and fog hugs close.

import * as THREE from "three";
import { plottedLine, gridFragment, rock } from "../geometry.js";
import { islandBase, stdMat, glowMat, scatter } from "./shared.js";
import { mushroomCluster, reedPatch, walkway } from "../props.js";
import { makeMotes, makeSmoke } from "../particles.js";
import { PALETTE as P } from "../config.js";

const TOP = 3;

export function wetlands({ size }) {
  const g = new THREE.Group();
  const ticks = [];

  g.add(
    islandBase({
      size,
      thickness: TOP,
      top: 0x153f52,
      layers: [0x14506b, 0x0e4458, 0x11566a],
      seed: 701,
    }).group,
  );

  //Reflective dark water covering most of the surface
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(size - 1.4, size - 1.4),
    new THREE.MeshStandardMaterial({
      color: 0x0a2a40,
      emissive: 0x155066,
      emissiveIntensity: 0.55,
      roughness: 0.12,
      metalness: 0.55,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = TOP + 0.08;
  g.add(water);

  //Marsh plates breaking the water
  for (const [x, z, w, d, rot] of [
    [-3.2, -2.6, 3.4, 2.6, 0.3],
    [3.4, -3.2, 2.6, 2.2, -0.2],
    [-3.0, 3.0, 2.8, 2.4, -0.35],
    [3.8, 2.6, 2.2, 2.6, 0.25],
  ]) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w, 0.26, d), stdMat(0x204658));
    plate.position.set(x, TOP + 0.16, z);
    plate.rotation.y = rot;
    g.add(plate);
  }

  //Blueprint grid fragments floating just above the water
  const grid1 = gridFragment({
    size: 3.2,
    divisions: 4,
    color: P.v3.nightly.glow,
    y: TOP + 0.14,
    x: 0.4,
    z: -1.4,
  });
  grid1.rotation.y = 0.18;
  g.add(grid1);
  const grid2 = gridFragment({
    size: 2.0,
    divisions: 3,
    color: P.v3.nightly.glow,
    y: TOP + 0.14,
    x: -1.6,
    z: 3.4,
  });
  grid2.rotation.y = -0.3;
  g.add(grid2);

  //Plotted cyan lines crossing the water like chart paths
  g.add(
    plottedLine(
      [
        [-5.4, TOP + 0.16, -3.6],
        [-2.6, TOP + 0.14, -1.8],
        [0.4, TOP + 0.12, -1.4],
        [3.2, TOP + 0.14, 0.2],
        [5.4, TOP + 0.16, 1.8],
      ],
      { color: P.v3.nightly.glow, radius: 0.07, emissiveIntensity: 2.6 },
    ),
  );
  g.add(
    plottedLine(
      [
        [4.2, TOP + 0.16, -4.8],
        [2.4, TOP + 0.14, -2.2],
        [0.2, TOP + 0.12, 0.6],
        [-2.2, TOP + 0.14, 2.6],
        [-4.6, TOP + 0.16, 4.6],
      ],
      { color: P.v3.dev.cyans[1], radius: 0.06, emissiveIntensity: 1.8 },
    ),
  );

  //Raised walkways leading to the observation post
  const w1 = walkway({ length: 3.4 });
  w1.position.set(-1.0, TOP, 1.2);
  w1.rotation.y = 0.5;
  g.add(w1);
  const w2 = walkway({ length: 2.6 });
  w2.position.set(0.7, TOP, 2.8);
  w2.rotation.y = -0.9;
  g.add(w2);

  //Observation post: platform on posts with a glowing marker light
  const post = new THREE.Group();
  const platform = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 1.6), stdMat(0x1d3a48));
  platform.position.y = 0.85;
  post.add(platform);
  for (const [px, pz] of [
    [-0.65, 0.65],
    [0.65, 0.65],
    [-0.65, -0.65],
    [0.65, -0.65],
  ]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.1), stdMat(0x14303c));
    leg.position.set(px, 0.45, pz);
    post.add(leg);
  }
  for (const [rx, rz, ry] of [
    [0, 0.72, 0],
    [0, -0.72, 0],
    [0.72, 0, Math.PI / 2],
    [-0.72, 0, Math.PI / 2],
  ]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.05), stdMat(0x2a5262));
    rail.position.set(rx, 1.25, rz);
    rail.rotation.y = ry;
    post.add(rail);
  }
  const roofP = new THREE.Mesh(new THREE.ConeGeometry(1.25, 0.6, 4), stdMat(0x11566a));
  roofP.rotation.y = Math.PI / 4;
  roofP.position.y = 1.9;
  post.add(roofP);
  const postMast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.0, 4), stdMat(0x2a5262));
  postMast.position.y = 1.5;
  post.add(postMast);
  const markLight = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 6, 5),
    glowMat(P.v3.nightly.glow, 2.2),
  );
  markLight.position.y = 2.05;
  post.add(markLight);
  post.position.set(1.9, TOP, 3.9);
  g.add(post);

  //Glowing mushroom clusters on the marsh plates
  const shroomSpots = [
    [-3.4, -2.8],
    [-2.8, -2.2],
    [3.6, -3.4],
    [-3.2, 3.2],
    [3.9, 2.4],
  ];
  shroomSpots.forEach(([x, z], i) => {
    const m = mushroomCluster({
      count: 3,
      seed: 720 + i,
      cap: i % 2 ? P.v3.nightly.glow : 0x7de8c8,
      glow: i % 2 ? 0x86fbfe : 0x4de3b8,
    });
    m.position.set(x, TOP + 0.28, z);
    g.add(m);
  });

  //Reeds along the plate edges
  const reeds = scatter({
    count: 14,
    radius: size / 2 - 1.6,
    seed: 744,
    avoid: [
      { x: 0, z: 1.8, r: 2.6 },
      { x: 1.9, z: 3.9, r: 1.6 },
    ],
    make: (i) => reedPatch({ count: 5, seed: 760 + i, h: 0.8 + (i % 3) * 0.15 }),
  });
  reeds.position.y = TOP + 0.2;
  g.add(reeds);

  //A few dark rocks
  const rocks = scatter({
    count: 4,
    radius: size / 2 - 2,
    seed: 755,
    avoid: [{ x: 0, z: 1.8, r: 2.4 }],
    make: (i) => rock({ size: 0.26, color: 0x16323e, seed: 780 + i }),
  });
  rocks.position.y = TOP + 0.15;
  g.add(rocks);

  //Cyan glow over the water + bioluminescent motes
  const cyan = new THREE.PointLight(P.v3.nightly.glow, 1.15, 17, 1.8);
  cyan.position.set(0, TOP + 3.2, 0);
  g.add(cyan);
  const motes = makeMotes({
    center: { x: 0, y: TOP + 1.4, z: 0 },
    spread: size * 0.7,
    height: 2.6,
    count: 46,
    color: 0x86fbfe,
  });
  g.add(motes.object);
  ticks.push(motes.update);

  //Fog hugging the terrain: slow drifting translucent patches
  const fogPatches = [];
  for (let i = 0; i < 3; i++) {
    const patch = new THREE.Mesh(
      new THREE.CircleGeometry(2.3 + i * 0.3, 18),
      new THREE.MeshBasicMaterial({
        color: 0x27506a,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
      }),
    );
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(-2 + i * 1.9, TOP + 0.35 + i * 0.16, 1.6 - i * 1.5);
    g.add(patch);
    fogPatches.push(patch);
  }

  let t = 0;
  ticks.push((dt) => {
    t += dt;
    markLight.material.emissiveIntensity = 1.8 + Math.sin(t * 2.0) * 0.7;
    cyan.intensity = 1.05 + Math.sin(t * 1.1) * 0.18;
    fogPatches.forEach((p, i) => {
      p.position.x = -2 + i * 1.9 + Math.sin(t * 0.22 + i * 2.1) * 0.55;
      p.material.opacity = 0.1 + 0.06 * (1 + Math.sin(t * 0.45 + i));
    });
  });

  return { group: g, ticks };
}
