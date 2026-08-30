// Reusable prop builders shared across biomes. Everything is stylized
// low-poly with flat shading and faceted forms, matching the icon language.
// Colors are always passed in so the audited T3 palette drives the scene.

import * as THREE from "three";
import { rng } from "./util.js";

const mat = (color, opts = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, ...opts });

//Small cabin with faceted roof and warm emissive windows
export function cabin({
  w = 1.8,
  d = 1.5,
  h = 1.1,
  wall = 0x8a5a3b,
  roof = 0x4a3527,
  window = 0xffc46b,
  chimney = true,
} = {}) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(wall));
  body.position.y = h / 2;
  g.add(body);
  const roofGeo = new THREE.CylinderGeometry(0.02, Math.max(w, d) * 0.78, h * 0.75, 4, 1);
  const roofMesh = new THREE.Mesh(roofGeo, mat(roof));
  roofMesh.rotation.y = Math.PI / 4;
  roofMesh.position.y = h + h * 0.37;
  roofMesh.scale.set(w / Math.max(w, d), 1, d / Math.max(w, d));
  g.add(roofMesh);
  const winMat = new THREE.MeshStandardMaterial({
    color: window,
    emissive: window,
    emissiveIntensity: 1.5,
    roughness: 0.4,
  });
  const winGeo = new THREE.BoxGeometry(w * 0.16, h * 0.28, 0.04);
  const win1 = new THREE.Mesh(winGeo, winMat);
  win1.position.set(-w * 0.22, h * 0.5, d / 2 + 0.02);
  const win2 = win1.clone();
  win2.position.x = w * 0.22;
  g.add(win1, win2);
  const door = new THREE.Mesh(new THREE.BoxGeometry(w * 0.22, h * 0.55, 0.04), mat(0x3a2a1e));
  door.position.set(0, h * 0.28, d / 2 + 0.02);
  g.add(door);
  if (chimney) {
    const ch = new THREE.Mesh(new THREE.BoxGeometry(w * 0.12, h * 0.6, w * 0.12), mat(0x6e6a66));
    ch.position.set(w * 0.28, h + h * 0.42, -d * 0.18);
    g.add(ch);
  }
  return g;
}

//Red barn with white trim and a gambrel-style faceted roof
export function barn({
  w = 2.4,
  d = 1.8,
  h = 1.3,
  body = 0xc4453a,
  trim = 0xf7f4ee,
  roof = 0xa03328,
} = {}) {
  const g = new THREE.Group();
  const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(body));
  walls.position.y = h / 2;
  g.add(walls);
  const roofMat = mat(roof);
  const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.02, w * 0.62, h * 0.42, 4, 1), roofMat);
  lower.rotation.y = Math.PI / 4;
  lower.scale.set(1, 1, d / w);
  lower.position.y = h + h * 0.2;
  g.add(lower);
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.02, w * 0.4, h * 0.5, 4, 1), roofMat);
  upper.rotation.y = Math.PI / 4;
  upper.scale.set(1, 1, (d / w) * 0.8);
  upper.position.y = h + h * 0.58;
  g.add(upper);
  const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(w * 0.34, h * 0.62, 0.05), mat(trim));
  doorFrame.position.set(0, h * 0.31, d / 2 + 0.03);
  g.add(doorFrame);
  const door = new THREE.Mesh(new THREE.BoxGeometry(w * 0.26, h * 0.52, 0.05), mat(body));
  door.position.set(0, h * 0.26, d / 2 + 0.06);
  g.add(door);
  const trimStrip = new THREE.Mesh(new THREE.BoxGeometry(w * 1.02, h * 0.08, d * 1.02), mat(trim));
  trimStrip.position.y = h * 0.08;
  g.add(trimStrip);
  return g;
}

//Windmill with a rotating blade assembly (returned for animation)
export function windmill({ pole = 0x9aa3ad, blade = 0xf2ede4, h = 2.6 } = {}) {
  const g = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.22, h, 5), mat(pole));
  tower.position.y = h / 2;
  g.add(tower);
  const hub = new THREE.Group();
  hub.position.set(0, h * 0.96, 0.18);
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.15, 0.03), mat(blade));
    b.position.y = 0.62;
    const arm = new THREE.Group();
    arm.add(b);
    arm.rotation.z = (i * Math.PI) / 2;
    hub.add(arm);
  }
  g.add(hub);
  g.userData.blades = hub;
  return g;
}

//Tiny stylized tractor
export function tractor({ body = 0xc9503c, tire = 0x2c2f36, h = 0.62 } = {}) {
  const g = new THREE.Group();
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(h * 1.5, h * 0.45, h * 0.85), mat(body));
  chassis.position.y = h * 0.5;
  g.add(chassis);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(h * 0.55, h * 0.5, h * 0.75), mat(body));
  cab.position.set(-h * 0.25, h * 0.95, 0);
  g.add(cab);
  const exhaust = new THREE.Mesh(
    new THREE.CylinderGeometry(h * 0.04, h * 0.05, h * 0.5, 5),
    mat(0x3a3d44),
  );
  exhaust.position.set(-h * 0.5, h * 1.1, 0);
  g.add(exhaust);
  const wheelGeo = (r) => new THREE.CylinderGeometry(r, r, h * 0.22, 8);
  const w1 = new THREE.Mesh(wheelGeo(h * 0.42), mat(tire));
  w1.rotation.x = Math.PI / 2;
  w1.position.set(h * 0.55, h * 0.42, h * 0.46);
  const w2 = w1.clone();
  w2.position.z = -h * 0.46;
  const w3 = new THREE.Mesh(wheelGeo(h * 0.26), mat(tire));
  w3.rotation.x = Math.PI / 2;
  w3.position.set(-h * 0.6, h * 0.26, h * 0.46);
  const w4 = w3.clone();
  w4.position.z = -h * 0.46;
  g.add(w1, w2, w3, w4);
  return g;
}

//Wooden fence run along a straight or slightly jittered segment
export function fenceRun({
  length = 3,
  wood = 0x9c7a4f,
  posts = 5,
  height = 0.45,
  seed = 11,
} = {}) {
  const r = rng(seed);
  const g = new THREE.Group();
  const railMat = mat(wood);
  for (let i = 0; i < posts; i++) {
    const x = -length / 2 + (length / (posts - 1)) * i;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, height, 0.07), railMat);
    post.position.set(x + r.range(-0.03, 0.03), height / 2, r.range(-0.02, 0.02));
    post.rotation.z = r.range(-0.05, 0.05);
    g.add(post);
  }
  for (const yy of [height * 0.42, height * 0.8]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(length, 0.045, 0.045), railMat);
    rail.position.y = yy;
    g.add(rail);
  }
  return g;
}

//Sunflower: stalk, leaves, seed head
export function sunflower({ petal = 0xf6c445, center = 0x6e4a2a, h = 0.55 } = {}) {
  const g = new THREE.Group();
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, h, 5), mat(0x4f7a3a));
  stalk.position.y = h / 2;
  g.add(stalk);
  const head = new THREE.Group();
  head.position.y = h;
  const seedCenter = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 8), mat(center));
  seedCenter.rotation.x = Math.PI / 2;
  head.add(seedCenter);
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14, 4), mat(petal));
    const a = (i / 8) * Math.PI * 2;
    p.position.set(Math.cos(a) * 0.13, Math.sin(a) * 0.13, 0);
    p.rotation.z = a - Math.PI / 2;
    head.add(p);
  }
  head.rotation.x = -0.35;
  g.add(head);
  return g;
}

//Hay bale
export function hayBale({ color = 0xd9b45c, r = 0.28 } = {}) {
  const b = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, r * 1.4, 9),
    mat(color, { roughness: 1 }),
  );
  b.rotation.z = Math.PI / 2;
  return b;
}

//Palm tree with faceted fronds
export function palm({ trunk = 0x8a6239, leaf = 0x3f9a56, h = 2.4, seed = 13 } = {}) {
  const r = rng(seed);
  const g = new THREE.Group();
  const segments = 4;
  for (let i = 0; i < segments; i++) {
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07 - i * 0.008, 0.09 - i * 0.008, h / segments, 5),
      mat(trunk),
    );
    seg.position.set(Math.sin(i * 0.35) * 0.12 * i, (h / segments) * (i + 0.5), 0);
    seg.rotation.z = -0.06 * i;
    g.add(seg);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + r.range(0, 0.4);
    const frond = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.05, 4), mat(leaf));
    frond.position.set(Math.cos(a) * 0.5, h + 0.05 - 0.12, Math.sin(a) * 0.5);
    frond.rotation.z = Math.PI / 2 + 0.45;
    frond.rotation.y = -a;
    frond.scale.set(1, 1, 0.35);
    g.add(frond);
  }
  const nut = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), mat(0x6e4a2a));
  nut.position.set(0.12, h - 0.08, 0.1);
  g.add(nut);
  return g;
}

//Cactus: classic saguaro with two arms
export function cactus({ color = 0x4c9460, h = 1.1 } = {}) {
  const g = new THREE.Group();
  const m = mat(color, { roughness: 0.8 });
  const trunk = new THREE.Mesh(new THREE.CapsuleGeometry(h * 0.13, h * 0.7, 3, 7), m);
  trunk.position.y = h / 2;
  g.add(trunk);
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(h * 0.09, h * 0.32, 3, 6), m);
  arm.position.set(h * 0.2, h * 0.62, 0);
  arm.rotation.z = -0.9;
  g.add(arm);
  const arm2 = new THREE.Mesh(new THREE.CapsuleGeometry(h * 0.08, h * 0.26, 3, 6), m);
  arm2.position.set(-h * 0.18, h * 0.48, 0);
  arm2.rotation.z = 0.95;
  g.add(arm2);
  return g;
}

//Camel: stylized low-poly with saddle blanket
export function camel({ body = 0xc49a62, blanket = 0xb03a2e } = {}) {
  const g = new THREE.Group();
  const m = mat(body);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.38, 0.34), m);
  torso.position.y = 0.62;
  g.add(torso);
  const hump = new THREE.Mesh(new THREE.SphereGeometry(0.17, 6, 4), m);
  hump.position.set(-0.1, 0.85, 0);
  hump.scale.y = 0.8;
  g.add(hump);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.14), m);
  neck.position.set(0.42, 0.85, 0);
  neck.rotation.z = 0.5;
  g.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.13), m);
  head.position.set(0.56, 1.08, 0);
  g.add(head);
  for (const [x, z] of [
    [0.32, 0.13],
    [0.32, -0.13],
    [-0.32, 0.13],
    [-0.32, -0.13],
  ]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.5, 0.09), m);
    leg.position.set(x, 0.25, z);
    g.add(leg);
  }
  const bl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.4), mat(blanket));
  bl.position.set(-0.08, 0.84, 0);
  g.add(bl);
  return g;
}

//Striped beach umbrella
export function umbrella({ canvasA = 0xf2ede4, canvasB = 0xd95f43, pole = 0x8a6239 } = {}) {
  const g = new THREE.Group();
  const p = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 5), mat(pole));
  p.position.y = 0.75;
  g.add(p);
  const canopy = new THREE.Group();
  canopy.position.y = 1.5;
  for (let i = 0; i < 8; i++) {
    const wedge = new THREE.Mesh(
      new THREE.ConeGeometry(0.75, 0.32, 4, 1, true),
      mat(i % 2 === 0 ? canvasA : canvasB),
    );
    const a = (i / 8) * Math.PI * 2;
    wedge.position.set(Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3);
    wedge.rotation.y = -a;
    wedge.scale.set(0.32, 1, 1);
    canopy.add(wedge);
  }
  g.add(canopy);
  return g;
}

//Beach lounger
export function lounger({ frame = 0x8a6239, cloth = 0x5b84c4 } = {}) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.06, 1.3), mat(cloth));
  base.position.y = 0.22;
  g.add(base);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.06, 0.6), mat(cloth));
  back.position.set(0, 0.42, -0.62);
  back.rotation.x = -0.7;
  g.add(back);
  for (const [x, z] of [
    [-0.28, 0.55],
    [0.28, 0.55],
    [-0.28, -0.55],
    [0.28, -0.55],
  ]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.05), mat(frame));
    leg.position.set(x, 0.11, z);
    g.add(leg);
  }
  return g;
}

//Lifeguard tower on stilts
export function lifeguardTower({ wood = 0xd9c19a, roof = 0xd95f43 } = {}) {
  const g = new THREE.Group();
  for (const [x, z] of [
    [-0.35, 0.35],
    [0.35, 0.35],
    [-0.35, -0.35],
    [0.35, -0.35],
  ]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.8, 0.07), mat(wood));
    leg.position.set(x, 0.4, z);
    g.add(leg);
  }
  const hut = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.55, 0.85), mat(wood));
  hut.position.y = 1.05;
  g.add(hut);
  const r = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.8, 0.35, 4, 1), mat(roof));
  r.rotation.y = Math.PI / 4;
  r.position.y = 1.48;
  g.add(r);
  return g;
}

//Tiny swimmer or figure: a capsule body and head, low detail on purpose
export function figure({ skin = 0xe8b98a, suit = 0xd95f43 } = {}) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.16, 3, 6), mat(suit));
  body.rotation.x = Math.PI / 2;
  body.position.y = 0.1;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 5), mat(skin));
  head.position.set(0, 0.12, 0.22);
  g.add(head);
  return g;
}

//Cable car pod hanging from a cable between two pylons
export function cableCar({
  car = 0xd95f43,
  cable = 0x6b7280,
  span = 5,
  height = 2.6,
  t = 0.5,
} = {}) {
  const g = new THREE.Group();
  const cableMat = mat(cable, { roughness: 0.6 });
  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, span, 4), cableMat);
  line.rotation.z = Math.PI / 2;
  line.position.y = height;
  g.add(line);
  for (const x of [-span / 2, span / 2]) {
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.08, height, 0.08), mat(0x4b5563));
    pylon.position.set(x, height / 2, 0);
    pylon.rotation.z = x > 0 ? -0.12 : 0.12;
    g.add(pylon);
  }
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 4), cableMat);
  arm.position.set(-span / 2 + span * t, height - 0.18, 0);
  g.add(arm);
  const pod = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.34), mat(car));
  pod.position.set(-span / 2 + span * t, height - 0.42, 0);
  g.add(pod);
  const win = new THREE.Mesh(
    new THREE.BoxGeometry(0.44, 0.1, 0.36),
    new THREE.MeshStandardMaterial({ color: 0xbfe3f5, emissive: 0x9fd4ec, emissiveIntensity: 0.5 }),
  );
  win.position.set(-span / 2 + span * t, height - 0.38, 0);
  g.add(win);
  g.userData.pod = pod;
  g.userData.podWin = win;
  g.userData.arm = arm;
  g.userData.span = span;
  g.userData.t = t;
  return g;
}

//Glowing mushroom cluster for the wetlands
export function mushroomCluster({
  cap = 0x7de8c8,
  stem = 0xcfd8e3,
  glow = 0x4de3b8,
  count = 3,
  seed = 17,
} = {}) {
  const r = rng(seed);
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const h = 0.22 + r.range(0, 0.2);
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, h, 5), mat(stem));
    st.position.set(r.range(-0.2, 0.2), h / 2, r.range(-0.2, 0.2));
    g.add(st);
    const capMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.12 + r.range(0, 0.06), 6, 4, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: cap,
        emissive: glow,
        emissiveIntensity: 1.2,
        flatShading: true,
        roughness: 0.5,
      }),
    );
    capMesh.position.set(st.position.x, h, st.position.z);
    g.add(capMesh);
  }
  return g;
}

//Reeds: thin stalks with seed tips
export function reedPatch({
  stalk = 0x6d9468,
  tip = 0xa87b4a,
  count = 6,
  seed = 19,
  h = 0.9,
} = {}) {
  const r = rng(seed);
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const hh = h * r.range(0.7, 1.3);
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, hh, 4), mat(stalk));
    s.position.set(r.range(-0.3, 0.3), hh / 2, r.range(-0.3, 0.3));
    s.rotation.z = r.range(-0.12, 0.12);
    g.add(s);
    const tipMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.025, 0.09, 2, 4), mat(tip));
    tipMesh.position.set(s.position.x + s.rotation.z * -hh * 0.5, hh + 0.05, s.position.z);
    g.add(tipMesh);
  }
  return g;
}

//Raised wooden walkway segment on posts
export function walkway({ length = 3, wood = 0x7a5c3e, width = 0.55 } = {}) {
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(width, 0.06, length), mat(wood));
  deck.position.y = 0.36;
  g.add(deck);
  const nPosts = Math.max(2, Math.round(length / 1.2));
  for (let i = 0; i < nPosts; i++) {
    const z = -length / 2 + (length / (nPosts - 1)) * i;
    for (const x of [-width / 2 + 0.07, width / 2 - 0.07]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.4, 0.07), mat(wood));
      post.position.set(x, 0.18, z);
      g.add(post);
    }
  }
  return g;
}

//Burnt dead tree for the volcanic biome
export function burntTree({ color = 0x4a4038, h = 1.1, seed = 23 } = {}) {
  const r = rng(seed);
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.08, h, 5), mat(color));
  trunk.position.y = h / 2;
  trunk.rotation.z = r.range(-0.12, 0.12);
  g.add(trunk);
  for (let i = 0; i < 3; i++) {
    const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.035, h * 0.5, 4), mat(color));
    branch.position.set(r.range(-0.15, 0.15), h * r.range(0.55, 0.9), r.range(-0.15, 0.15));
    branch.rotation.z = r.range(0.5, 1.1) * (r.next() > 0.5 ? 1 : -1);
    branch.rotation.x = r.range(-0.4, 0.4);
    g.add(branch);
  }
  return g;
}

//Simple wooden bridge over a river
export function bridge({ wood = 0x8a6239, span = 2.6, width = 0.7 } = {}) {
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(width, 0.06, span), mat(wood));
  g.add(deck);
  for (const x of [-width / 2 + 0.06, width / 2 - 0.06]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, span), mat(wood));
    rail.position.set(x, 0.3, 0);
    g.add(rail);
    for (const z of [-span / 2 + 0.2, 0, span / 2 - 0.2]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.32, 0.05), mat(wood));
      post.position.set(x, 0.16, z);
      g.add(post);
    }
  }
  g.userData.deck = deck;
  return g;
}
