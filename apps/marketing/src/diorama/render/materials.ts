/**
 * Shared material library, built from config.PALETTE and routed through the
 * disposal registry. Fourteen materials total (ten v1 + four v2); every
 * builder shares these instead of creating its own.
 */

import * as THREE from "three";
import { PALETTE, PALETTE_V2 } from "../config";
import type { ResourceRegistry } from "./resources";

export interface MaterialLibrary {
  /** Bulk matte geometry: walls, props, bot hulls; color from vertex colors. */
  readonly matteVertex: THREE.MeshLambertMaterial;
  /** Nameplate, vault hardware trim, pipe fittings. */
  readonly brass: THREE.MeshStandardMaterial;
  /** Cannon, vault door mechanism, machine controls. */
  readonly darkMetal: THREE.MeshStandardMaterial;
  /** Order orb: emissive mint glow. */
  readonly orb: THREE.MeshStandardMaterial;
  /** Bot eyes and status marks; emissive look via unlit basic mint. */
  readonly eyeMint: THREE.MeshBasicMaterial;
  /** Screens and ticker board off-state (dark slate). */
  readonly screenDark: THREE.MeshBasicMaterial;
  /** Data marks only: profit green. */
  readonly dataGreen: THREE.MeshBasicMaterial;
  /** Data marks only: loss red. */
  readonly dataRed: THREE.MeshBasicMaterial;
  /** Receipts and paper props, unlit paper cream. */
  readonly paper: THREE.MeshBasicMaterial;
  /**
   * v2: THE glossy zone floor-plate material (one for all zones). Tint per
   * zone exclusively via vertex colors (config.PALETTE_V2.zoneFloorTint
   * baked by the builder); never clone per-zone material instances.
   */
  readonly zonePlate: THREE.MeshStandardMaterial;
  /**
   * v2: emissive signage/screens. All color baked into vertex colors
   * (config.PALETTE_V2.zoneEmissive); toneMapped false so ACES does not
   * dull the neon read. No material.color clones.
   */
  readonly signGlow: THREE.MeshBasicMaterial;
  /** v2: unlit emissive-look cyan data screens (gauntlet cyan). */
  readonly screenCyan: THREE.MeshBasicMaterial;
  /** v2: unlit emissive-look amber data screens (activation amber). */
  readonly screenAmber: THREE.MeshBasicMaterial;
  /** Soft blob shadow disc for moving bots/props; needs plane UVs. */
  readonly blobShadow: THREE.ShaderMaterial;
}

export type MaterialName = keyof MaterialLibrary;

const BLOB_SHADOW_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BLOB_SHADOW_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    float d = distance(vUv, vec2(0.5, 0.5)) * 2.0;
    // Radial soft falloff, fully faded before the quad edge; texture-free.
    float alpha = (1.0 - smoothstep(0.25, 1.0, d)) * 0.42;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(0.039, 0.039, 0.047, alpha);
  }
`;

/**
 * Build the material library. Every material is tracked on the registry, so
 * disposal happens exclusively through `registry.disposeAll()`.
 */
export function createMaterials(registry: ResourceRegistry): Readonly<MaterialLibrary> {
  const track = <T extends THREE.Material>(material: T): T => registry.track(material);

  const library: MaterialLibrary = {
    matteVertex: track(new THREE.MeshLambertMaterial({ vertexColors: true })),

    brass: track(
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(PALETTE.brass),
        metalness: 0.75,
        roughness: 0.3,
      }),
    ),

    darkMetal: track(
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(PALETTE.slateDark),
        metalness: 0.6,
        roughness: 0.5,
      }),
    ),

    orb: track(
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(PALETTE.mintBright),
        emissive: new THREE.Color(PALETTE.mint),
        emissiveIntensity: 0.9,
        roughness: 0.35,
        metalness: 0.0,
      }),
    ),

    eyeMint: track(new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.mintBright) })),

    screenDark: track(new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.slateDark) })),

    dataGreen: track(new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.dataGreen) })),

    dataRed: track(new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.dataRed) })),

    paper: track(new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.cream) })),

    // v2 additions (08-design-direction-v2.md Decision 2). Zone tints live in
    // vertex colors, so these stay single shared instances.
    zonePlate: track(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        metalness: 0.05,
        roughness: 0.35,
      }),
    ),

    signGlow: track(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })),

    screenCyan: track(
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(PALETTE_V2.zoneEmissive.gauntlet),
        toneMapped: false,
      }),
    ),

    screenAmber: track(
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(PALETTE_V2.zoneEmissive.plan),
        toneMapped: false,
      }),
    ),

    blobShadow: track(
      new THREE.ShaderMaterial({
        vertexShader: BLOB_SHADOW_VERTEX,
        fragmentShader: BLOB_SHADOW_FRAGMENT,
        transparent: true,
        depthWrite: false,
      }),
    ),
  };

  return Object.freeze(library);
}
