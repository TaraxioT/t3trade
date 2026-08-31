/**
 * v2 R3: GLB prop library.
 *
 * Loads the curated CC0 Kenney prop set from /diorama/props/*.glb at boot and
 * converts every model into ONE normalized static BufferGeometry per prop
 * type, painted with palette vertex colors and merged mergeParts-style
 * (position + normal + color, non-indexed). Placement then costs a single
 * shared geometry + a cached material: one mesh per prop instance.
 *
 * PRIMARY-COLOR COMPROMISE (binding, see mission spec): vertex colors are
 * baked at intake and the geometry instance is shared by every placement of a
 * prop type, so a per-zone primary color cannot be baked per placement.
 * Instead the largest part of each prop is painted WHITE and `makeProp`
 * supplies the primary via `material.color` on a cached MeshLambertMaterial
 * (vertexColors: true). Material.color multiplies ALL vertex colors, so the
 * white primary part takes the tint exactly, while detail parts (slateFrame /
 * boneDeck) get multiplied by the same tint — dark slate reads as shading and
 * light bone reads as a tinted surface. Accepted trade for one draw call per
 * prop instance and zero geometry duplication.
 *
 * Intake rules (per codex guidance, /tmp/codex-diorama-v2-out.txt items 5/7):
 * - One GLTFLoader; all manifest files fetched with Promise.allSettled.
 * - Skinned meshes and animations are rejected: such parts are skipped and
 *   recorded in diagnostics (never thrown, never console-logged per part).
 * - Per mesh part: clone geometry, bake the world matrix, strip UV/tangent/
 *   skin/morph/color attributes, normalize to non-indexed, recompute missing
 *   normals.
 * - Imported geometries/materials/textures are tracked on the resource
 *   registry (the loaded gltf scene is not retained). ImageBitmap-backed
 *   textures are closed immediately: nothing references them post-intake and
 *   texture.dispose() does not close ImageBitmaps.
 * - Scale is normalized so the prop's height equals its manifest
 *   targetHeight, and the geometry is translated so minY = 0 (sits on the
 *   placement origin). Original size and normalized footprint are recorded.
 *
 * Boot wiring is owned by main.ts (staged async boot); world builders call
 * `library.makeProp(name, hex)` synchronously afterwards.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { PALETTE_V2 } from "../config";
import { mergeParts } from "../geometry";
import type { MaterialLibrary } from "../render/materials";
import type { ResourceRegistry } from "../render/resources";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface PropManifestEntry {
  /** Runtime URL under apps/marketing/public; never a TS import. */
  readonly file: string;
  /**
   * Desired world-space height of the prop. Bot reference height is 2; these
   * values normalize scale differences between Kenney packs.
   */
  readonly targetHeight: number;
}

const prop = (name: string, targetHeight: number): PropManifestEntry => ({
  file: `/diorama/props/${name}.glb`,
  targetHeight,
});

export const PROP_MANIFEST = {
  desk: prop("desk", 1.3),
  deskCorner: prop("deskCorner", 1.3),
  chairDesk: prop("chairDesk", 1.2),
  chairModernCushion: prop("chairModernCushion", 1.2),
  stoolBar: prop("stoolBar", 1.1),
  loungeChair: prop("loungeChair", 1.1),
  sideTable: prop("sideTable", 1.2),
  bookcaseOpen: prop("bookcaseOpen", 2.6),
  bookcaseClosedDoors: prop("bookcaseClosedDoors", 2.6),
  books: prop("books", 0.7),
  computer: prop("computer", 1.0),
  "computer-wide": prop("computer-wide", 1.0),
  "computer-system": prop("computer-system", 1.0),
  "display-wall": prop("display-wall", 2.6),
  "display-wall-wide": prop("display-wall-wide", 2.6),
  "table-display": prop("table-display", 1.2),
  "table-display-planet": prop("table-display-planet", 1.2),
  "table-display-small": prop("table-display-small", 1.2),
  "container-tall": prop("container-tall", 2.4),
  "container-wide": prop("container-wide", 1.8),
  "container-flat-open": prop("container-flat-open", 1.6),
  cardboardBoxClosed: prop("cardboardBoxClosed", 0.7),
  cardboardBoxOpen: prop("cardboardBoxOpen", 0.7),
  lampRoundFloor: prop("lampRoundFloor", 2.0),
  lampRoundTable: prop("lampRoundTable", 1.6),
  lampWall: prop("lampWall", 1.6),
  plantSmall1: prop("plantSmall1", 0.8),
  plantSmall2: prop("plantSmall2", 0.8),
  pottedPlant: prop("pottedPlant", 1.4),
  televisionAntenna: prop("televisionAntenna", 2.5),
  "wall-banner": prop("wall-banner", 2.2),
  "wall-window": prop("wall-window", 2.4),
} as const satisfies Record<string, PropManifestEntry>;

export type PropName = keyof typeof PROP_MANIFEST;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Axis-aligned size of the normalized prop geometry (world units). */
export interface PropSize {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

export interface PropDiagnostics {
  /** Props whose GLB failed to fetch/parse; no library entry exists for them. */
  readonly failedLoads: readonly { readonly name: string; readonly message: string }[];
  /** Mesh parts skipped because they were skinned (props must be static). */
  readonly skippedSkinnedParts: readonly { readonly name: string; readonly reason: string }[];
  /** Props that loaded but produced no usable static parts. */
  readonly emptyProps: readonly string[];
  /** Successfully intaken props with their normalized sizes. */
  readonly normalized: readonly { readonly name: string; readonly size: PropSize }[];
}

export interface PropLibrary {
  has(name: string): boolean;
  /**
   * One mesh per placement: shared normalized geometry + cached per-primary
   * Lambert material. The mesh sits on the placement origin (minY = 0) at the
   * prop's normalized scale; callers position/rotate the mesh only. Returns
   * null for failed/unknown props — callers fall back procedurally.
   */
  makeProp(name: string, primaryHex: string): THREE.Mesh | null;
  readonly diagnostics: PropDiagnostics;
}

interface IntakenProp {
  readonly geometry: THREE.BufferGeometry;
  readonly size: PropSize;
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

/** Attributes stripped from imported GLB geometries; only pos/norm/color survive. */
const STRIPPED_ATTRIBUTES = [
  "uv",
  "uv1",
  "uv2",
  "uv3",
  "tangent",
  "skinIndex",
  "skinWeight",
  "color",
] as const;

const WHITE = "#FFFFFF";

/** Bake a part's world transform and normalize its attribute set. */
function normalizePart(mesh: THREE.Mesh, matrixWorld: THREE.Matrix4): THREE.BufferGeometry | null {
  const source = mesh.geometry;
  const geo = source.clone();
  for (const key of STRIPPED_ATTRIBUTES) geo.deleteAttribute(key);
  geo.applyMatrix4(matrixWorld);
  // toNonIndexed returns a NEW geometry; drop the indexed clone it came from.
  const flat = geo.index ? geo.toNonIndexed() : geo;
  if (flat !== geo) geo.dispose();
  if (!flat.attributes.position || flat.attributes.position.count === 0) {
    flat.dispose();
    return null;
  }
  if (!flat.attributes.normal) flat.computeVertexNormals();
  return flat;
}

/** Dispose-and-forget imported GPU resources; close ImageBitmaps eagerly. */
function trackImports(scene: THREE.Object3D, registry: ResourceRegistry): void {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if ((mesh as unknown as { isMesh?: boolean }).isMesh && mesh.geometry) {
      registry.track(mesh.geometry);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material) continue;
        registry.track(material);
        for (const value of Object.values(material)) {
          const texture = value as THREE.Texture | null;
          if (texture && (texture as unknown as { isTexture?: boolean }).isTexture) {
            registry.track(texture);
            const bitmap = (texture as { image?: unknown }).image as
              | { close?: () => void }
              | undefined;
            // texture.dispose() does not close ImageBitmaps; nothing retains
            // them after palette override, so close eagerly (codex guidance 5).
            if (typeof bitmap?.close === "function") bitmap.close();
          }
        }
      }
    }
  });
}

/** Build the single merged, painted, scale-normalized geometry for a model. */
function intakeProp(
  name: string,
  scene: THREE.Object3D,
  animations: readonly THREE.AnimationClip[],
  targetHeight: number,
  registry: ResourceRegistry,
  diagnostics: {
    skippedSkinnedParts: { name: string; reason: string }[];
    emptyProps: string[];
  },
): IntakenProp | null {
  const parts: { geo: THREE.BufferGeometry; volume: number }[] = [];

  scene.updateMatrixWorld(true);
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
    const partName = `${name}/${obj.name || obj.type}`;
    if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) {
      diagnostics.skippedSkinnedParts.push({
        name: partName,
        reason: "skinned mesh skipped (props must be static)",
      });
      return;
    }
    const normalized = normalizePart(mesh, mesh.matrixWorld);
    if (!normalized) return;
    normalized.computeBoundingBox();
    const box = normalized.boundingBox ?? new THREE.Box3();
    const size = box.getSize(new THREE.Vector3());
    parts.push({ geo: normalized, volume: Math.max(size.x * size.y * size.z, 0) });
  });

  if (animations.length > 0) {
    // Animations imply non-static content; the geometry may still be usable,
    // so record it but never let a clip-driven prop reach the world.
    diagnostics.skippedSkinnedParts.push({
      name,
      reason: `model carries ${animations.length} animation clip(s); treated as static`,
    });
  }

  if (parts.length === 0) {
    diagnostics.emptyProps.push(name);
    return null;
  }

  // Deterministic paint rule: sort parts by bounding volume descending.
  parts.sort((a, b) => b.volume - a.volume);
  const largest = parts[0]?.volume ?? 0;
  const painted: THREE.BufferGeometry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    if (i === 0) {
      // Primary role: white so the per-primary material tint shows through.
      painted.push(paintAttribute(part.geo, WHITE));
    } else if (part.volume <= largest * 0.25) {
      painted.push(paintAttribute(part.geo, PALETTE_V2.slateFrame));
    } else {
      painted.push(paintAttribute(part.geo, PALETTE_V2.boneDeck));
    }
  }

  let merged = mergeParts(painted);
  for (const part of parts) part.geo.dispose();

  // Normalize scale to targetHeight and drop the prop onto y = 0.
  merged.computeBoundingBox();
  const box = merged.boundingBox ?? new THREE.Box3();
  const size = box.getSize(new THREE.Vector3());
  const height = size.y || 1;
  const scale = targetHeight / height;
  merged.scale(scale, scale, scale);
  merged.computeBoundingBox();
  const scaledBox = merged.boundingBox ?? new THREE.Box3();
  merged.translate(0, -scaledBox.min.y, 0);
  merged.computeBoundingBox();

  const finalSize = (merged.boundingBox ?? new THREE.Box3()).getSize(new THREE.Vector3());
  registry.track(merged);
  return {
    geometry: merged,
    size: { width: finalSize.x, height: finalSize.y, depth: finalSize.z },
  };
}

/**
 * paint() for already-normalized GLB parts: identical to geometry.paint but
 * local so the import surface stays mergeParts-only.
 */
function paintAttribute(geo: THREE.BufferGeometry, colorHex: string): THREE.BufferGeometry {
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

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Cached shared materials are capped; beyond the cap the oldest entry is reused. */
const MAX_PRIMARY_MATERIALS = 12;

export async function loadPropLibrary(
  _mats: Readonly<MaterialLibrary>,
  registry: ResourceRegistry,
): Promise<PropLibrary> {
  void _mats; // Primaries use cached Lambert materials, not the shared matte material.
  const loader = new GLTFLoader();
  const entries = Object.entries(PROP_MANIFEST) as [PropName, PropManifestEntry][];

  const results = await Promise.allSettled(
    entries.map(async ([, entry]) => loader.loadAsync(entry.file)),
  );

  const failedLoads: { name: string; message: string }[] = [];
  const skippedSkinnedParts: { name: string; reason: string }[] = [];
  const emptyProps: string[] = [];
  const normalized: { name: string; size: PropSize }[] = [];
  const library = new Map<string, IntakenProp>();

  // Promise.allSettled preserves input order, so results[i] pairs with entries[i].
  for (let i = 0; i < results.length; i += 1) {
    const [name, entry] = entries[i] as [PropName, PropManifestEntry];
    const result = results[i];
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      failedLoads.push({
        name,
        message: reason instanceof Error ? reason.message : String(reason),
      });
      continue;
    }
    const gltf = result.value;
    trackImports(gltf.scene, registry);
    const intaken = intakeProp(name, gltf.scene, gltf.animations, entry.targetHeight, registry, {
      skippedSkinnedParts,
      emptyProps,
    });
    if (!intaken) continue;
    library.set(name, intaken);
    normalized.push({ name, size: intaken.size });
  }

  // Rejections are recorded above; nothing further to pair here.

  if (failedLoads.length > 0) {
    // Single permitted boot log: failed loads only, once.
    console.info("[diorama] prop library failed loads:", failedLoads.map((f) => f.name).join(", "));
  }

  // Per-primary cached Lambert materials. Vertex colors stay on; white
  // primary parts take the tint, detail parts are multiplied by it.
  const primaryMaterials = new Map<string, THREE.MeshLambertMaterial>();
  const getPrimaryMaterial = (hex: string): THREE.MeshLambertMaterial => {
    const existing = primaryMaterials.get(hex);
    if (existing) return existing;
    if (primaryMaterials.size >= MAX_PRIMARY_MATERIALS) {
      // Cap reached: reuse the first cached material (documented compromise;
      // ~10 zones keep us under the cap in practice).
      const first = primaryMaterials.values().next().value;
      if (first) return first;
    }
    const material = registry.track(
      new THREE.MeshLambertMaterial({ vertexColors: true, color: new THREE.Color(hex) }),
    );
    primaryMaterials.set(hex, material);
    return material;
  };

  return {
    has(name: string): boolean {
      return library.has(name);
    },
    makeProp(name: string, primaryHex: string): THREE.Mesh | null {
      const intaken = library.get(name);
      if (!intaken) return null;
      return new THREE.Mesh(intaken.geometry, getPrimaryMaterial(primaryHex));
    },
    diagnostics: { failedLoads, skippedSkinnedParts, emptyProps, normalized },
  };
}
