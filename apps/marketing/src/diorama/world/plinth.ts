/**
 * Mahogany museum plinth (M04b).
 *
 * The plinth is the dark wooden base the whole diorama sits on: a beveled
 * mahogany block (30 x 22, y in [-3.5, 0]) with an inset rectangular well
 * under the bureau footprint so the risk vault (floor y = -2.2) reads as a
 * sunken basement, an aperture punched through the -X wall where the reject
 * chute exits, and a brass nameplate on the camera-facing +Z face.
 *
 * There is no ground plane beyond the plinth; the void is the background.
 * All static parts merge into a single vertex-colored mesh (plus the brass
 * nameplate plate) to hold the draw-call budget.
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE } from "../config";
import { bevelSlab, mergeParts, paint, roundedBox } from "../geometry";
import { buildNameplate } from "../props/decor";
import type { MaterialLibrary } from "../render/materials";
import type { ResourceRegistry } from "../render/resources";

export const PLINTH_VERSION = 1;

/** Per-builder result: scene subtree plus registries. */
export interface WorldPart {
  readonly group: THREE.Group;
  /** Visible static meshes (draw-call and shadow-caster inventory). */
  readonly statics: THREE.Mesh[];
  /** Named anchor objects keyed by AnchorId string. */
  readonly anchors: Readonly<Record<string, THREE.Object3D>>;
}

const P = DIMENSIONS.plinth;

/** Half extents of the plinth footprint. */
const HX = P.width / 2; // 15
const HZ = P.depth / 2; // 11
/** Border wall thickness (the well is the interior these leave open). */
const WALL = 0.9;

/** Reject-chute aperture in the -X wall (see waypoints chuteExit). */
export const CHUTE_APERTURE = {
  zMin: 0.9,
  zMax: 2.1,
  yMin: -2.0,
  yMax: -0.7,
} as const;

/** Nameplate mounting band on the +Z face (x extent around the plate). */
const NAMEPLATE_BAND = { xMin: -5.3, xMax: 1.3 } as const;
/** Nameplate upscale so the monogram reads at 1440x900. */
const NAMEPLATE_SCALE = 2.2;

export function buildPlinth(mats: MaterialLibrary, registry: ResourceRegistry): WorldPart {
  const group = new THREE.Group();
  group.name = "plinth";

  const body = PALETTE.mahoganyPlinth;
  const rim = PALETTE.mahoganyRim;

  const parts: THREE.BufferGeometry[] = [
    // Bottom chunk with a subtle chamfer; the vault slab rests on it at y=-3.0.
    paint(bevelSlab(P.width, P.depth, 0.5, 0.12).translate(0, -3.25, 0), body),
  ];

  // Border walls. The camera-facing +X and +Z sides are OPEN (sunken gallery
  // read): only a 0.25-high lip remains, plus a mounting band around the
  // nameplate on +Z. Full-height mahogany stays on the -X / -Z back faces.
  // +X lip.
  parts.push(
    paint(roundedBox(WALL, 0.25, P.depth, 0.05).translate(HX - WALL / 2, -2.875, 0), body),
  );
  // +Z lip (interrupted by the nameplate band).
  parts.push(
    paint(
      roundedBox(NAMEPLATE_BAND.xMin + HX, 0.25, WALL, 0.05).translate(
        (NAMEPLATE_BAND.xMin - HX) / 2,
        -2.875,
        HZ - WALL / 2,
      ),
      body,
    ),
    paint(
      roundedBox(HX - NAMEPLATE_BAND.xMax, 0.25, WALL, 0.05).translate(
        (NAMEPLATE_BAND.xMax + HX) / 2,
        -2.875,
        HZ - WALL / 2,
      ),
      body,
    ),
  );
  // -Z wall (full height).
  parts.push(paint(roundedBox(P.width, 3.0, WALL, 0.08).translate(0, -1.5, -HZ + WALL / 2), body));
  // -X wall in three pieces around the chute aperture (z in [0.9, 2.1]).
  const xm = -HX + WALL / 2;
  parts.push(
    paint(
      roundedBox(WALL, 3.0, CHUTE_APERTURE.zMin + HZ, 0.08).translate(
        xm,
        -1.5,
        (-HZ + CHUTE_APERTURE.zMin) / 2,
      ),
      body,
    ),
    paint(
      roundedBox(WALL, 3.0, HZ - CHUTE_APERTURE.zMax, 0.08).translate(
        xm,
        -1.5,
        (CHUTE_APERTURE.zMax + HZ) / 2,
      ),
      body,
    ),
    // Sill and lintel framing the aperture.
    paint(
      roundedBox(
        WALL,
        CHUTE_APERTURE.yMin + 3.0,
        CHUTE_APERTURE.zMax - CHUTE_APERTURE.zMin,
        0.06,
      ).translate(
        xm,
        (CHUTE_APERTURE.yMin - 3.0) / 2,
        (CHUTE_APERTURE.zMin + CHUTE_APERTURE.zMax) / 2,
      ),
      body,
    ),
    paint(
      roundedBox(
        WALL,
        -CHUTE_APERTURE.yMax,
        CHUTE_APERTURE.zMax - CHUTE_APERTURE.zMin,
        0.06,
      ).translate(xm, CHUTE_APERTURE.yMax / 2, (CHUTE_APERTURE.zMin + CHUTE_APERTURE.zMax) / 2),
      body,
    ),
  );

  // Top rim: proud mahoganyRim band on the retained back edges only.
  parts.push(
    paint(
      roundedBox(P.width + 0.3, P.rimHeight, WALL + 0.2, 0.06).translate(
        0,
        -P.rimHeight / 2,
        -HZ + WALL / 2,
      ),
      rim,
    ),
    paint(
      roundedBox(WALL + 0.2, P.rimHeight, P.depth + 0.3, 0.06).translate(
        -HX + WALL / 2,
        -P.rimHeight / 2,
        0,
      ),
      rim,
    ),
  );

  // Aperture trim: thin brass-painted collar around the chute exit on the -X face.
  const az = (CHUTE_APERTURE.zMin + CHUTE_APERTURE.zMax) / 2;
  const ay = (CHUTE_APERTURE.yMin + CHUTE_APERTURE.yMax) / 2;
  parts.push(
    paint(
      roundedBox(0.12, 0.24, CHUTE_APERTURE.zMax - CHUTE_APERTURE.zMin + 0.5, 0.04).translate(
        -HX - 0.02,
        CHUTE_APERTURE.yMax + 0.1,
        az,
      ),
      PALETTE.brass,
    ),
    paint(
      roundedBox(0.12, 0.24, CHUTE_APERTURE.zMax - CHUTE_APERTURE.zMin + 0.5, 0.04).translate(
        -HX - 0.02,
        CHUTE_APERTURE.yMin - 0.1,
        az,
      ),
      PALETTE.brass,
    ),
    paint(
      roundedBox(0.12, CHUTE_APERTURE.yMax - CHUTE_APERTURE.yMin + 0.7, 0.24, 0.04).translate(
        -HX - 0.02,
        ay,
        CHUTE_APERTURE.zMax + 0.2,
      ),
      PALETTE.brass,
    ),
    paint(
      roundedBox(0.12, CHUTE_APERTURE.yMax - CHUTE_APERTURE.yMin + 0.7, 0.24, 0.04).translate(
        -HX - 0.02,
        ay,
        CHUTE_APERTURE.zMin - 0.2,
      ),
      PALETTE.brass,
    ),
  );

  // Nameplate mounting band: full-height mahogany block on the +Z face
  // framing the enlarged brass plate, preserving the plinth silhouette.
  parts.push(
    paint(
      roundedBox(NAMEPLATE_BAND.xMax - NAMEPLATE_BAND.xMin, 2.9, WALL + 0.25, 0.08).translate(
        (NAMEPLATE_BAND.xMin + NAMEPLATE_BAND.xMax) / 2,
        -1.6,
        HZ - WALL / 2,
      ),
      body,
    ),
  );

  // Nameplate on the camera-facing +Z face, centered under the bureau and
  // scaled up so it reads clearly at desktop resolutions. The brass plate
  // keeps its brass material; the slate monogram merges into this mesh.
  const nameplate = buildNameplate(mats);
  nameplate.scale.setScalar(NAMEPLATE_SCALE);
  nameplate.position.set(
    DIMENSIONS.building.centerX,
    -1.7,
    HZ - WALL / 2 + (WALL + 0.25) / 2 + 0.03,
  );
  nameplate.updateMatrixWorld(true);
  const plates: THREE.Mesh[] = [];
  nameplate.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.material === mats.brass) {
      plates.push(o);
      return;
    }
    parts.push(o.geometry.clone().applyMatrix4(o.matrixWorld));
  });
  const plateMesh = plates[0];
  if (plateMesh) {
    plateMesh.updateMatrix();
    plateMesh.geometry = plateMesh.geometry.clone().applyMatrix4(plateMesh.matrixWorld);
    plateMesh.position.set(0, 0, 0);
    registry.track(plateMesh.geometry);
    plateMesh.castShadow = true;
    plateMesh.receiveShadow = true;
  }

  const merged = mergeParts(parts);
  registry.track(merged);
  const bodyMesh = new THREE.Mesh(merged, mats.matteVertex);
  bodyMesh.name = "plinthBody";
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(bodyMesh);
  if (plateMesh) group.add(plateMesh);

  const statics = plateMesh ? [bodyMesh, plateMesh] : [bodyMesh];
  return { group, statics, anchors: {} };
}
