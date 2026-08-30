// Terrain construction primitives for the biome universe.
// Every island sits on a thick layered slab: stacked strata with slightly
// irregular insets so the sides read as hand-cut miniature rock, never as a
// plain box. Faceted peaks and rocks carry the V1 Faceted icon language.

import * as THREE from "three";
import { rng } from "./util.js";

//A layered square slab. Strata are listed top to bottom; each is inset by a
//deterministic jitter so corners misalign slightly between layers.
export function buildSlab({
  size = 12,
  thickness = 3,
  strata, // [{ height (fraction of thickness), color, inset (fraction) }, ...]
  seed = 1,
}) {
  const group = new THREE.Group();
  const r = rng(seed);
  const n = strata.length;
  let y = 0;
  let remaining = thickness;
  for (let i = 0; i < n; i++) {
    const s = strata[i];
    const h = i === n - 1 ? remaining : thickness * s.height;
    remaining -= h;
    const insetBase = (s.inset ?? 0.02) * size;
    const jitterX = r.range(0, insetBase);
    const jitterZ = r.range(0, insetBase);
    const w = size - insetBase * 2 - jitterX;
    const d = size - insetBase * 2 - jitterZ;
    const geo = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
    //Hand-cut feel: nudge the top ring of vertices independently from the bottom
    const pos = geo.attributes.position;
    const off = w / 2;
    const offD = d / 2;
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      const yv = pos.getY(v);
      const top = yv > 0 ? 1 : 0;
      pos.setX(
        v,
        x + (top ? r.range(-0.16, 0.16) : r.range(-0.1, 0.1)) * (Math.abs(x) > off - 0.01 ? 1 : 0),
      );
      pos.setZ(
        v,
        z + (top ? r.range(-0.16, 0.16) : r.range(-0.1, 0.1)) * (Math.abs(z) > offD - 0.01 ? 1 : 0),
      );
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: s.color, flatShading: true, roughness: 0.92 }),
    );
    mesh.position.y = y + h / 2;
    y += h;
    group.add(mesh);
  }
  return { group, top: thickness };
}

//Faceted crystalline peak, the core V1 silhouette. Each side face receives
//its own tone from a ramp via face-normal lambert shading, so peaks read as
//cut gemstone, never as flat cones or oversized pines.
export function facetedPeak({
  radius = 4,
  height = 6,
  segments = 6,
  color,
  ramp = null,
  seed = 2,
  snow = null,
  squash = 1,
}) {
  const r = rng(seed);
  const geo = new THREE.CylinderGeometry(0.001, radius, height, segments, 3).toNonIndexed();
  const pos = geo.attributes.position;
  for (let v = 0; v < pos.count; v++) {
    const y = pos.getY(v);
    const t = (y + height / 2) / height; //0..1 up the peak
    const radial = Math.hypot(pos.getX(v), pos.getZ(v));
    if (radial > 0.001) {
      const noise = 1 + r.range(-0.22, 0.12) * (1 - t * 0.5);
      pos.setX(v, pos.getX(v) * noise);
      pos.setZ(v, pos.getZ(v) * noise);
    }
  }
  const colors = ramp ?? [color, color, color];
  const lightDir = new THREE.Vector3(0.55, 0.6, 0.45).normalize();
  const faceColors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let f = 0; f < pos.count / 3; f++) {
    const i0 = f * 3;
    p0.fromBufferAttribute(pos, i0);
    p1.fromBufferAttribute(pos, i0 + 1);
    p2.fromBufferAttribute(pos, i0 + 2);
    n.copy(p1).sub(p0).cross(p2.clone().sub(p0)).normalize();
    const lambert = THREE.MathUtils.clamp(n.dot(lightDir) * 0.5 + 0.5, 0, 1);
    const idx = Math.min(colors.length - 1, Math.floor(lambert * colors.length));
    c.set(colors[idx]);
    for (let k = 0; k < 3; k++) {
      faceColors[(i0 + k) * 3] = c.r;
      faceColors[(i0 + k) * 3 + 1] = c.g;
      faceColors[(i0 + k) * 3 + 2] = c.b;
    }
  }
  geo.setAttribute("color", new THREE.BufferAttribute(faceColors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      flatShading: true,
      roughness: 0.85,
    }),
  );
  mesh.position.y = height / 2;
  mesh.scale.set(squash, 1, squash);
  const g = new THREE.Group();
  g.add(mesh);
  if (snow) {
    const snowCap = new THREE.Mesh(
      new THREE.ConeGeometry(radius * 0.42, height * 0.34, segments),
      new THREE.MeshStandardMaterial({ color: snow, flatShading: true, roughness: 0.65 }),
    );
    snowCap.position.y = height * 0.78;
    snowCap.rotation.y = r.range(0, 1);
    g.add(snowCap);
  }
  return g;
}

//Low faceted boulder, used everywhere as scatter
export function rock({ size = 0.5, color, seed = 3, flat = 0.35 }) {
  const r = rng(seed);
  const geo = new THREE.IcosahedronGeometry(size, 0);
  const pos = geo.attributes.position;
  for (let v = 0; v < pos.count; v++) {
    pos.setXYZ(
      v,
      pos.getX(v) * (1 + r.range(-flat, flat)),
      pos.getY(v) * (1 + r.range(-flat, flat)) * 0.82,
      pos.getZ(v) * (1 + r.range(-flat, flat)),
    );
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95 }),
  );
  m.rotation.y = r.range(0, Math.PI * 2);
  return m;
}

//Glowing plotted chart line laid over terrain: the V3 Blueprint signature.
//A slim emissive tube following a Catmull-Rom path, like a trade trajectory.
export function plottedLine(points3, { color, radius = 0.09, emissiveIntensity = 1.6 } = {}) {
  const curve = new THREE.CatmullRomCurve3(points3.map((p) => new THREE.Vector3(...p)));
  const geo = new THREE.TubeGeometry(curve, Math.max(24, points3.length * 6), radius, 5, false);
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity,
      roughness: 0.4,
    }),
  );
}

//Thin glowing grid fragment, the V3 technical substrate
export function gridFragment({ size = 4, divisions = 4, color, y = 0.06, x = 0, z = 0 }) {
  const geo = new THREE.PlaneGeometry(size, size, divisions, divisions);
  const edges = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
  const lines = new THREE.LineSegments(new THREE.WireframeGeometry(geo), mat);
  lines.rotation.x = -Math.PI / 2;
  lines.position.set(x, y, z);
  edges.add(lines);
  return edges;
}

//Angular stylized pine: stacked faceted cones. Two palettes: normal and frozen.
export function pine({ height = 2.4, tiers = 3, leaf, trunk, seed = 5 }) {
  const r = rng(seed);
  const g = new THREE.Group();
  const trunkH = height * 0.22;
  const trunkMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(height * 0.05, height * 0.07, trunkH, 5),
    new THREE.MeshStandardMaterial({ color: trunk, flatShading: true, roughness: 0.9 }),
  );
  trunkMesh.position.y = trunkH / 2;
  g.add(trunkMesh);
  let y = trunkH * 0.8;
  let w = height * 0.42;
  const tierH = (height - trunkH) / tiers;
  for (let i = 0; i < tiers; i++) {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(w, tierH * 1.25, 6),
      new THREE.MeshStandardMaterial({ color: leaf, flatShading: true, roughness: 0.85 }),
    );
    cone.position.y = y + tierH * 0.55;
    cone.rotation.y = r.range(0, Math.PI);
    g.add(cone);
    y += tierH * 0.72;
    w *= 0.68;
  }
  return g;
}

//Small angular grass tuft for scatter
export function grassTuft({ color, seed = 7, size = 0.22 }) {
  const r = rng(seed);
  const g = new THREE.Group();
  const blades = r.int(3, 4);
  for (let i = 0; i < blades; i++) {
    const h = size * r.range(0.7, 1.4);
    const blade = new THREE.Mesh(
      new THREE.ConeGeometry(size * 0.16, h, 3),
      new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9 }),
    );
    blade.position.set(r.range(-size * 0.4, size * 0.4), h / 2, r.range(-size * 0.4, size * 0.4));
    blade.rotation.z = r.range(-0.25, 0.25);
    g.add(blade);
  }
  return g;
}
