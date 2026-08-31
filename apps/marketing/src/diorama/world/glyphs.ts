/**
 * Emotion glyph renderer (Diorama R4, design decision 3 item 2).
 *
 * Comic "glyph pops" floating above bot heads: !, ?, Zzz, anger cross-pop,
 * heart, star. Each glyph is one merged geometry built from the frozen
 * geometry.ts primitive kit, rendered with an unlit emissive-look
 * MeshBasicMaterial (toneMapped false) so the colors read at iso distance.
 *
 * Analytic-window contract: the DIRECTOR owns window timing and calls
 * applyWindow(actorIndex, glyphId, phase) every frame inside an active
 * window, and hide() outside it. Everything here is a pure function of the
 * last applied phase, so direct seeks into the middle of a glyph window
 * render correctly (seek-safe).
 *
 * Allocation policy: all geometries, materials, slots, and meshes are
 * preallocated at creation and tracked on the resource registry. The
 * per-frame path (setSlotPosition / applyWindow / update) performs zero
 * allocations; transforms reuse module-scratch vectors.
 *
 * Facing: each slot's base quaternion is billboard-oriented toward the frozen
 * CAMERA_ISO camera direction ONCE at creation. No per-frame lookAt; the
 * isometric orientation stays anchored while a subtle constant yaw wobble
 * (~15 degrees, 2-cycle sin) is applied around it for eye-catching motion.
 *
 * Fade-out note: MeshBasicMaterials are shared per glyph across all slots
 * (one material each), so per-slot opacity fades are not possible without
 * transparent sorting costs. The "fade" in the last 20% of a window is
 * therefore expressed as scale shrink plus a slight upward rise — a comic
 * "poof" read that matches the diorama style.
 */

import * as THREE from "three";
import { CAMERA_ISO } from "../config";
import { capsule, cone, mergeParts, paint, roundedBox } from "../geometry";
import type { ResourceRegistry } from "../render/resources";

/** The six authored emotion glyphs. */
export type GlyphId = "alarm" | "question" | "sleep" | "anger" | "heart" | "star";

const GLYPH_IDS: readonly GlyphId[] = ["alarm", "question", "sleep", "anger", "heart", "star"];

/** Per-glyph emissive colors (palette additions owned by this module). */
export const GLYPH_COLORS: Readonly<Record<GlyphId, string>> = {
  alarm: "#FF5A5F",
  question: "#7FF0BC",
  sleep: "#9BB4FF",
  anger: "#FF5A5F",
  heart: "#FF7AB8",
  star: "#FFD166",
};

/** Default reserved slot count when no explicit fleet size is given. */
const DEFAULT_MAX_ACTORS = 32;

/**
 * Nominal glyph height in scene units (~1.9 bot-heights of 2.0). R5.1
 * scale-up: the live review found 2.4-unit glyphs read as sub-pixel dots at
 * the iso viewing distance (only hearts were legible), so everything grew to
 * 3.8 units. Glyphs are composed at the original 2.4-unit proportions then
 * uniformly scaled 3.8/2.4 (~1.58x), which also thickens every stroke well
 * past the requested 1.4x bold-up.
 */
const GLYPH_HEIGHT = 3.8;
const GLYPH_SCALE = GLYPH_HEIGHT / 2.4;

// --- animation tuning (pure functions of phase 0..1) -----------------------

const POP_PEAK = 1.15; // pop-in overshoot peak (R5.1: raised from 1.1)
const POP_END = 0.25; // easeOutBack pop-in finishes here (overshoot ~POP_PEAK)
const SETTLE_END = 0.5; // scale settles from POP_PEAK to 1.0 by here
const FADE_START = 0.8; // last 20%: shrink + rise
const BOB_AMPLITUDE = 0.12; // scene units of vertical float
const BOB_CYCLES = 2; // gentle full-window float cycles
const FADE_RISE = 0.5; // scene units of upward drift while shrinking
const WOBBLE_AMPLITUDE = (15 * Math.PI) / 180; // yaw wobble half-angle, radians
// Wobble shares BOB_CYCLES so the motion reads as one coherent sway.

/** easeOutBack: overshooting ease into (and past) 1. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

function saturate01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// --- glyph geometry composition --------------------------------------------

/** Translate a painted white part into place; helper for the composers. */
function part(
  geo: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rotZ = 0,
): THREE.BufferGeometry {
  paint(geo, "#FFFFFF"); // white vertex colors; tint comes from the material
  if (rotZ !== 0) geo.rotateZ(rotZ);
  geo.translate(x, y, z);
  return geo;
}

/** Bar of a chunky "!" — tall rounded bar plus a dot. */
function buildAlarm(): THREE.BufferGeometry {
  const bar = part(roundedBox(0.55, 1.5, 0.55, 0.18), 0, 0.45, 0);
  const dot = part(roundedBox(0.6, 0.6, 0.6, 0.18), 0, -0.95, 0);
  return mergeParts([bar, dot]);
}

/** Chunky "?" approximated with three boxes and a dot. */
function buildQuestion(): THREE.BufferGeometry {
  const top = part(roundedBox(1.15, 0.55, 0.5, 0.15), -0.28, 0.85, 0); // hook top, off-center
  const right = part(roundedBox(0.55, 0.95, 0.5, 0.15), 0.3, 0.35, 0); // right stem down
  const mid = part(roundedBox(0.55, 0.75, 0.5, 0.15), 0, -0.35, 0); // center descender
  const dot = part(roundedBox(0.55, 0.55, 0.55, 0.15), 0, -1.05, 0);
  return mergeParts([top, right, mid, dot]);
}

/** One chunky "Z" made of top bar, diagonal, bottom bar. */
function zSlab(size: number, x: number, y: number): THREE.BufferGeometry[] {
  const bar = size * 0.85;
  const thick = size * 0.34;
  return [
    part(roundedBox(bar, thick, thick * 0.9, thick * 0.4), x, y + size * 0.34, 0),
    part(roundedBox(size * 1.0, thick, thick * 0.9, thick * 0.4), x, y, 0, -Math.PI / 4),
    part(roundedBox(bar, thick, thick * 0.9, thick * 0.4), x, y - size * 0.34, 0),
  ];
}

/** "Z z z": three descending Z slabs. */
function buildSleep(): THREE.BufferGeometry {
  return mergeParts([
    ...zSlab(1.15, -0.35, 0.75),
    ...zSlab(0.85, 0.3, -0.15),
    ...zSlab(0.6, 0.8, -0.9),
  ]);
}

/** Manga anger cross-pop: four wedge boxes radiating from the center. */
function buildAnger(): THREE.BufferGeometry {
  const wedges: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i += 1) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2; // diagonals, gaps at axes
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    wedges.push(part(roundedBox(1.05, 0.5, 0.5, 0.15), dx * 0.75, dy * 0.75, 0, angle));
  }
  return mergeParts(wedges);
}

/** Heart: two tilted capsule lobes over a downward cone tip. */
function buildHeart(): THREE.BufferGeometry {
  const lobeL = part(capsule(0.52, 0.35, 8, 3), -0.42, 0.55, 0, Math.PI / 5);
  const lobeR = part(capsule(0.52, 0.35, 8, 3), 0.42, 0.55, 0, -Math.PI / 5);
  const tip = part(cone(0.88, 1.5, 8), 0, -0.5, 0, Math.PI); // point down
  return mergeParts([lobeL, lobeR, tip]);
}

/** Star sparkle: + and × crossed elongated boxes. */
function buildStar(): THREE.BufferGeometry {
  const h = part(roundedBox(1.7, 0.55, 0.5, 0.15), 0, 0, 0, 0);
  const v = part(roundedBox(1.7, 0.55, 0.5, 0.15), 0, 0, 0, Math.PI / 2);
  const d1 = part(roundedBox(1.2, 0.45, 0.45, 0.12), 0, 0, 0, Math.PI / 4);
  const d2 = part(roundedBox(1.2, 0.45, 0.45, 0.12), 0, 0, 0, -Math.PI / 4);
  return mergeParts([h, v, d1, d2]);
}

// --- per-actor slot state --------------------------------------------------

interface GlyphSlot {
  /** World-level holder; wobbled around the frozen CAMERA_ISO facing each frame. */
  readonly root: THREE.Object3D;
  /** The frozen billboard facing; root.quaternion is derived from this + wobble. */
  readonly baseQuat: THREE.Quaternion;
  /** One mesh per glyph id; only the active one is visible. */
  readonly meshes: Readonly<Record<GlyphId, THREE.Mesh>>;
  /** True while an analytic glyph window is active for this actor. */
  active: boolean;
  glyph: GlyphId;
  phase: number;
  /** Head-anchor world position set by the director each frame. */
  readonly basePos: THREE.Vector3;
}

export interface GlyphRenderer {
  /** World-level group; add to the scene once. Glyphs never cast shadows. */
  readonly group: THREE.Group;
  /** Number of reserved actor slots (fleet roster size). */
  readonly slotCount: number;
  /** Show a glyph at phase 0 (shorthand for applyWindow(i, id, 0)). */
  show(actorIndex: number, glyphId: GlyphId): void;
  /** Hide a slot; the director calls this outside the active window. */
  hide(actorIndex: number): void;
  /**
   * Drive a slot from an analytic window phase (0..1). Selects the glyph,
   * marks the slot visible, and stores the phase; update() applies the
   * pop-in overshoot, float bob, and shrink-fade transforms.
   */
  applyWindow(actorIndex: number, glyphId: GlyphId, phase: number): void;
  /** Copy the actor's head world position into the slot (zero allocation). */
  setSlotPosition(actorIndex: number, x: number, y: number, z: number): void;
  /** Apply stored phase/positions to every visible slot's transform. */
  update(): void;
}

export function createGlyphRenderer(
  mats: unknown,
  registry: ResourceRegistry,
  maxActors = DEFAULT_MAX_ACTORS,
): GlyphRenderer {
  void mats; // Glyph materials are module-owned emissive colors, not palette slots.

  // --- fixed isometric facing (computed once, never per frame) ------------
  const yaw = CAMERA_ISO.yawRadians;
  const pitch = CAMERA_ISO.pitchRadians;
  const cameraDir = new THREE.Vector3(
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  ).normalize();
  const facing = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), cameraDir);

  // --- shared per-glyph geometries and materials ---------------------------
  const builders: Record<GlyphId, () => THREE.BufferGeometry> = {
    alarm: buildAlarm,
    question: buildQuestion,
    sleep: buildSleep,
    anger: buildAnger,
    heart: buildHeart,
    star: buildStar,
  };
  const geometries = {} as Record<GlyphId, THREE.BufferGeometry>;
  const materials = {} as Record<GlyphId, THREE.MeshBasicMaterial>;
  for (const id of GLYPH_IDS) {
    const geo = builders[id]();
    geo.scale(GLYPH_SCALE, GLYPH_SCALE, GLYPH_SCALE); // uniform: strokes bold up too
    geometries[id] = registry.track(geo);
    materials[id] = registry.track(
      new THREE.MeshBasicMaterial({ color: GLYPH_COLORS[id], toneMapped: false }),
    );
  }

  // --- preallocated slots --------------------------------------------------
  const group = new THREE.Group();
  group.name = "glyph-group";
  const slots: GlyphSlot[] = [];
  for (let i = 0; i < maxActors; i += 1) {
    const root = new THREE.Object3D();
    root.quaternion.copy(facing); // billboard-style fixed iso orientation
    root.visible = false;
    root.matrixAutoUpdate = true;
    const meshes = {} as Record<GlyphId, THREE.Mesh>;
    for (const id of GLYPH_IDS) {
      const mesh = new THREE.Mesh(geometries[id], materials[id]);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.visible = false;
      root.add(mesh);
      meshes[id] = mesh;
    }
    group.add(root);
    slots.push({
      root,
      baseQuat: facing.clone(),
      meshes,
      active: false,
      glyph: "alarm",
      phase: 0,
      basePos: new THREE.Vector3(),
    });
  }

  // Hot-path scratch for the yaw wobble (never allocated per frame).
  const wobbleQuat = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);

  function slotAt(actorIndex: number): GlyphSlot {
    const slot = slots[actorIndex];
    if (!slot) throw new Error(`glyph slot out of range: ${actorIndex}`);
    return slot;
  }

  // --- animation application (pure function of stored phase) --------------
  // Fade is scale shrink + y-rise: materials are shared per glyph across
  // slots, so per-slot opacity is not available (and transparency would add
  // sorting costs). See the module doc.
  function applyPhaseTransform(slot: GlyphSlot): void {
    const phase = slot.phase;
    let scale: number;
    if (phase < POP_END) {
      scale = POP_PEAK * easeOutBack(phase / POP_END);
    } else if (phase < SETTLE_END) {
      scale = lerp(POP_PEAK, 1, saturate01((phase - POP_END) / (SETTLE_END - POP_END)));
    } else {
      scale = 1;
    }
    const fade = saturate01((phase - FADE_START) / (1 - FADE_START));
    scale *= 1 - fade;

    const sway = Math.sin(phase * Math.PI * 2 * BOB_CYCLES);
    const bob = sway * BOB_AMPLITUDE * (1 - fade);
    const rise = fade * FADE_RISE;

    // Subtle constant yaw wobble around the frozen billboard facing so the
    // glyph catches the eye with motion; damped as the fade shrinks it out.
    wobbleQuat.setFromAxisAngle(yAxis, sway * WOBBLE_AMPLITUDE * (1 - fade));
    slot.root.quaternion.copy(slot.baseQuat).multiply(wobbleQuat);
    slot.root.scale.setScalar(scale);
    slot.root.position.set(slot.basePos.x, slot.basePos.y + bob + rise, slot.basePos.z);
  }

  return {
    group,
    slotCount: slots.length,

    show(actorIndex, glyphId): void {
      this.applyWindow(actorIndex, glyphId, 0);
    },

    hide(actorIndex): void {
      const slot = slotAt(actorIndex);
      slot.active = false;
      slot.root.visible = false;
    },

    applyWindow(actorIndex, glyphId, phase): void {
      const slot = slotAt(actorIndex);
      slot.glyph = glyphId;
      slot.phase = saturate01(phase);
      if (!slot.active) {
        slot.active = true;
        for (const id of GLYPH_IDS) slot.meshes[id].visible = id === glyphId;
        slot.root.visible = true;
      } else if (slot.meshes[glyphId].visible !== true) {
        for (const id of GLYPH_IDS) slot.meshes[id].visible = id === glyphId;
      }
      applyPhaseTransform(slot);
    },

    setSlotPosition(actorIndex, x, y, z): void {
      const slot = slotAt(actorIndex);
      slot.basePos.set(x, y, z);
      if (slot.active) applyPhaseTransform(slot);
    },

    update(): void {
      for (const slot of slots) {
        if (slot.active) applyPhaseTransform(slot);
      }
    },
  };
}

/** Nominal glyph height, exported for the director's head-anchor offset math. */
export const GLYPH_NOMINAL_HEIGHT = GLYPH_HEIGHT;
