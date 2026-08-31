/**
 * Procedural geometry kit for the diorama (M03).
 *
 * Every helper returns a plain THREE.BufferGeometry with clean normals and no
 * textures. Callers own disposal: track returned geometries on the resource
 * registry (or pass them through mergeParts and track only the result).
 *
 * Frozen surface: downstream missions (M04 props/world, M05 bot rig) code
 * against exactly these signatures. Exports may be added, never changed.
 */

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Internal shape helpers
// ---------------------------------------------------------------------------

/** Rounded rectangle centered at origin in the XY plane with corner radius r. */
function roundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const a = Math.max(width / 2, 0);
  const b = Math.max(height / 2, 0);
  const r = Math.min(radius, a, b);
  const shape = new THREE.Shape();
  shape.moveTo(-a + r, -b);
  shape.lineTo(a - r, -b);
  shape.absarc(a - r, -b + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(a, b - r);
  shape.absarc(a - r, b - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-a + r, b);
  shape.absarc(-a + r, b - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-a, -b + r);
  shape.absarc(-a + r, -b + r, r, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/** Plain rectangle centered at origin in the XY plane. */
function rectShape(width: number, height: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, -height / 2);
  shape.lineTo(width / 2, -height / 2);
  shape.lineTo(width / 2, height / 2);
  shape.lineTo(-width / 2, height / 2);
  shape.closePath();
  return shape;
}

/**
 * Extruded slab: shape drawn in the XZ ground plane (shape x -> world x,
 * shape y -> world -z), extruded upward through Y, then recentered on the
 * origin so the result spans [-h/2, h/2] in Y and its full footprint in X/Z.
 *
 * `inset` is how far the bevel pulls the footprint inward, so callers pass a
 * shape already shrunk by that amount and a height reduced by 2x that amount.
 */
function extrudedSlab(
  shape: THREE.Shape,
  totalWidth: number,
  totalDepth: number,
  totalHeight: number,
  bevel: number,
  bevelSegments: number,
): THREE.BufferGeometry {
  const coreHeight = Math.max(totalHeight - 2 * bevel, 0.01);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: coreHeight,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: Math.max(1, bevelSegments),
    curveSegments: 2,
  });
  // Extrusion runs along +Z with bevels outside [0, depth]; rotate so the
  // extrusion axis is +Y and recentre the bounding box on the origin.
  geo.rotateX(-Math.PI / 2);
  geo.center();
  geo.computeVertexNormals();
  // Guard: center() uses the bounding box, so symmetric inputs stay symmetric.
  void totalWidth;
  void totalDepth;
  return geo;
}

// ---------------------------------------------------------------------------
// Frozen primitive helpers
// ---------------------------------------------------------------------------

/** Rounded box centered on the origin; radius clamped to half the smallest extent. */
export function roundedBox(
  w: number,
  h: number,
  d: number,
  radius: number,
  segments = 2,
): THREE.BufferGeometry {
  const r = Math.min(radius, w / 2, h / 2, d / 2, Math.min(w, d) / 2);
  const shape = roundedRectShape(w - 2 * r, d - 2 * r, r);
  return extrudedSlab(shape, w, d, h, r, segments);
}

/** Vertical capsule (hemispherical caps) centered on the origin, axis Y. */
export function capsule(
  radius: number,
  length: number,
  radialSegments = 10,
  capSegments = 3,
): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(radius, length, capSegments, radialSegments);
}

/** Cone centered on the origin, base at -h/2, tip at +h/2. */
export function cone(radius: number, height: number, segments = 8): THREE.BufferGeometry {
  return new THREE.ConeGeometry(radius, height, segments);
}

/** Beveled slab (rounded-edge box without corner rounding) centered on origin. */
export function bevelSlab(w: number, d: number, h: number, bevel: number): THREE.BufferGeometry {
  const b = Math.min(bevel, w / 2, d / 2, h / 2);
  const shape = rectShape(w - 2 * b, d - 2 * b);
  return extrudedSlab(shape, w, d, h, b, 1);
}

/** Pipe (tube) along a polyline/Catmull-Rom path through the given points. */
export function pipeAlong(
  points: readonly { x: number; y: number; z: number }[],
  radius: number,
  radialSegments = 8,
): THREE.BufferGeometry {
  if (points.length < 2) throw new Error("pipeAlong requires at least two points");
  const pts = points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const curve =
    pts.length === 2
      ? new THREE.LineCurve3(pts[0] as THREE.Vector3, pts[1] as THREE.Vector3)
      : new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
  const tubularSegments = Math.max(6, (pts.length - 1) * 5);
  return new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
}

/** Flat circle disc centered on the origin, facing +Y. */
export function disc(radius: number, segments = 16): THREE.BufferGeometry {
  return new THREE.CircleGeometry(radius, segments).rotateX(-Math.PI / 2);
}

/**
 * Paint a geometry with a flat color by adding/overwriting its vertex color
 * attribute. Converts the hex string through THREE.Color so palette sRGB
 * literals land in the renderer's linear working space. Returns the same geo.
 */
export function paint(geo: THREE.BufferGeometry, colorHex: string): THREE.BufferGeometry {
  const color = new THREE.Color(colorHex);
  const count = geo.attributes.position?.count ?? 0;
  const array = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    array[i * 3] = color.r;
    array[i * 3 + 1] = color.g;
    array[i * 3 + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(array, 3));
  return geo;
}

/**
 * Merge painted parts into one position+normal+color geometry for the shared
 * matteVertex material. Inputs are consumed (callers dispose their sources
 * through the registry); the merged result is a fresh untracked geometry.
 */
export function mergeParts(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (parts.length === 0) throw new Error("mergeParts requires at least one part");
  const flat = parts.map((part) => (part.index ? part.toNonIndexed() : part));
  for (const part of flat) {
    if (!part.attributes.position) throw new Error("mergeParts part missing position");
    if (!part.attributes.normal) part.computeVertexNormals();
    if (!part.attributes.color)
      throw new Error("mergeParts part missing vertex color (paint first)");
  }
  const total = flat.reduce((sum, part) => sum + (part.attributes.position?.count ?? 0), 0);
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  let offset = 0;
  for (const part of flat) {
    const pos = part.attributes.position as THREE.BufferAttribute;
    const nor = part.attributes.normal as THREE.BufferAttribute;
    const col = part.attributes.color as THREE.BufferAttribute;
    positions.set(pos.array as ArrayLike<number>, offset);
    normals.set(nor.array as ArrayLike<number>, offset);
    colors.set(col.array as ArrayLike<number>, offset);
    offset += pos.array.length;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  merged.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return merged;
}
