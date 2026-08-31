/**
 * Lighting rig (M03): warm hemisphere + single warm shadow-casting key from
 * the upper-left front, a faint cool rim, and non-shadow warm practicals.
 *
 * Shadow strategy (plan section 8): the key's 2048 map is frozen after
 * assembly. `markShadowsDirty()` flags the key's shadow; the map is baked on
 * the next render pass (set autoUpdate=false up front so it happens exactly
 * once per dirty flag). Moving bots/props never cast into this map; M05/M07
 * use blob-shadow discs instead.
 *
 * setNightMood(t in [0,1]) supports the P0/P8 lights-low story frames: it
 * dims the key/hemisphere and raises the practicals.
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE, QUALITY } from "../config";
import { saturate } from "../math";

/** Art-tunable intensity table; deliberately not config-critical. */
const LIGHT_TUNING = {
  // Hemisphere: ambient bounce; deliberately low so interiors read as lit
  // from within (glow against a dark void) instead of flat external daylight.
  hemisphere: 0.41,
  // Key: warm directional from upper-left front; direction and frozen 2048
  // shadow map are locked, intensity kept so exteriors keep modelled form.
  key: 1.5,
  // How far the key color leans from warmKey toward caramel (amber cast).
  keyWarmth: 0.15,
  // Rim: faint cool backlight for silhouette separation only.
  rim: 0.35,
  // Practical scale/multiplier applied to every caller-passed intensity
  // (callers pass a base around 1; effective = passed * this).
  practical: 1.5,
  // Minimum effective practical intensity so no lamp can read as dead.
  practicalFloor: 1.2,
  // Point-light reach in scene units; large enough that one lamp spills
  // across a whole floor plate through the cutaway.
  practicalDistance: 15,
  // Decay 2 is physical; kept slightly under so spill survives the distance.
  practicalDecay: 1.8,
  // Candle tone: how far lamp color leans from warmKey toward caramel.
  practicalWarmth: 0.35,
  // Default soft interior fills added by createLights (one per open floor).
  interiorFill: 0.9,
  // Weak warm fills for deep recess corners (stair landings, vault back);
  // passed as bases, so the practicalFloor lifts them to a gentle minimum.
  recessFill: 0.8,
  // Cool accent over the satellite bridge mid-span so the umbilical pipes
  // read as lit elements against the void; applied directly, no floor.
  pipeAccent: 0.5,
  // How far the cool accent/satellite tone leans from coolFill toward mint.
  coolWarmth: 0.3,
  /** Night-mood modulation of key/hemisphere (t=1 -> fully dimmed). */
  nightKeyScale: 0.25,
  nightHemisphereScale: 0.45,
  /** Practical boost at full night mood. */
  nightPracticalScale: 1.7,
} as const;

/** Key light position, upper-left front and scaled to scene dims. */
const KEY_POSITION = new THREE.Vector3(-14, 26, 12);

/** Candle-toned lamp color: warmKey leaned toward caramel by the warmth mix. */
function candleColor(): THREE.Color {
  return new THREE.Color(PALETTE.warmKey).lerp(
    new THREE.Color(PALETTE.caramel),
    LIGHT_TUNING.practicalWarmth,
  );
}

/** Cool accent tone: coolFill leaned toward mint (satellite/pipe area). */
function coolAccentColor(): THREE.Color {
  return new THREE.Color(PALETTE.coolFill).lerp(
    new THREE.Color(PALETTE.mintDim),
    LIGHT_TUNING.coolWarmth,
  );
}

/**
 * Practical tone: "warm" (candle default, trading/vault floors) or "cool"
 * (satellite slotWall/mint area and bridge pipe accent).
 */
export type PracticalTone = "warm" | "cool";

export interface PracticalHandle {
  readonly light: THREE.PointLight;
  /** Remove the practical from the rig (idempotent). */
  dispose(): void;
}

export interface LightsHandle {
  readonly group: THREE.Group;
  /** Flag the frozen key shadow map for one re-bake on the next render. */
  markShadowsDirty(): void;
  /**
   * Bake the static shadow map now. With a camera, renders the scene once
   * through it (the map updates during that pass); without one, only flags
   * the map so the caller's next render bakes it.
   */
  renderStaticShadows(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera?: THREE.Camera,
  ): void;
  /**
   * Add a non-shadow practical at a world anchor position. `intensity` is a
   * multiplier base scaled by LIGHT_TUNING.practical with a floor (warm lamps);
   * `tone` selects the candle default or the cool satellite accent (cool
   * accents apply intensity directly, no floor, since they read as glow).
   */
  addPractical(
    position: { x: number; y: number; z: number },
    intensity?: number,
    tone?: PracticalTone,
  ): PracticalHandle;
  /** t=0 daylight, t=1 lights-low night mood; dims key, raises practicals. */
  setNightMood(t: number): void;
}

export function createLights(scene: THREE.Scene, _registry: unknown): LightsHandle {
  void _registry; // Lights hold no tracked GPU resources; symmetry with siblings.

  const group = new THREE.Group();
  scene.add(group);

  // Warm hemisphere: warm-key sky over a warm-fill ground bounce.
  const hemisphere = new THREE.HemisphereLight(
    new THREE.Color(PALETTE.warmKey),
    new THREE.Color(PALETTE.warmFill),
    LIGHT_TUNING.hemisphere,
  );
  group.add(hemisphere);

  // Single warm directional key, upper-left front, the only shadow caster.
  const key = new THREE.DirectionalLight(
    new THREE.Color(PALETTE.warmKey).lerp(new THREE.Color(PALETTE.caramel), LIGHT_TUNING.keyWarmth),
    LIGHT_TUNING.key,
  );
  key.position.copy(KEY_POSITION);
  key.castShadow = true;
  key.shadow.mapSize.set(QUALITY.shadowMapSize, QUALITY.shadowMapSize);
  // Ortho shadow frustum covers the whole plinth plus the satellite pad.
  const s = DIMENSIONS.satellite;
  const p = DIMENSIONS.plinth;
  const spanX = Math.max(p.width / 2, s.x + s.padRadius) + 6;
  const spanZ = Math.max(p.depth / 2, Math.abs(s.z) + s.padRadius) + 6;
  const spanY = s.y + s.padThickness / 2 - p.bottomY + 6;
  key.shadow.camera.left = -spanX;
  key.shadow.camera.right = spanX;
  key.shadow.camera.top = spanZ;
  key.shadow.camera.bottom = -spanZ;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = KEY_POSITION.length() + spanY;
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  // Frozen map: never auto-updates; markShadowsDirty() bakes it once on demand.
  key.shadow.autoUpdate = false;
  key.shadow.needsUpdate = true; // bake on the very first render after assembly
  group.add(key);
  group.add(key.target); // target stays at the origin by default

  // Faint cool rim from behind-right for silhouette separation.
  const rim = new THREE.DirectionalLight(new THREE.Color(PALETTE.coolFill), LIGHT_TUNING.rim);
  rim.position.set(18, 12, -18);
  group.add(rim);

  const practicals: { light: THREE.PointLight; base: number; disposed: boolean }[] = [];
  let nightT = 0;

  const applyMood = (): void => {
    const t = saturate(nightT);
    key.intensity = LIGHT_TUNING.key * (1 - t * (1 - LIGHT_TUNING.nightKeyScale));
    hemisphere.intensity =
      LIGHT_TUNING.hemisphere * (1 - t * (1 - LIGHT_TUNING.nightHemisphereScale));
    for (const entry of practicals) {
      if (!entry.disposed) {
        entry.light.intensity = entry.base * (1 + t * (LIGHT_TUNING.nightPracticalScale - 1));
      }
    }
  };

  const handle: LightsHandle = {
    group,

    markShadowsDirty(): void {
      key.shadow.needsUpdate = true;
    },

    renderStaticShadows(renderer, scene_, camera): void {
      key.shadow.needsUpdate = true;
      if (camera) {
        // Bake immediately by rendering once; shadow map updates in this pass.
        renderer.render(scene_, camera);
      }
    },

    addPractical(position, intensity = 1, tone: PracticalTone = "warm"): PracticalHandle {
      // Warm lamps: caller intensities are multiplier bases (M04b passes ~1);
      // scale up and enforce a floor so no lamp reads as dead. Candle tone.
      // Cool accents: intensity is final (glow, not a lamp), no floor.
      const warm = tone === "warm";
      const effective = warm
        ? Math.max(intensity * LIGHT_TUNING.practical, LIGHT_TUNING.practicalFloor)
        : intensity;
      const light = new THREE.PointLight(
        warm ? candleColor() : coolAccentColor(),
        effective,
        LIGHT_TUNING.practicalDistance,
        LIGHT_TUNING.practicalDecay,
      );
      light.position.set(position.x, position.y, position.z);
      light.castShadow = false;
      group.add(light);
      const entry = { light, base: effective, disposed: false };
      practicals.push(entry);
      const practicalHandle: PracticalHandle = {
        light,
        dispose(): void {
          if (entry.disposed) return;
          entry.disposed = true;
          group.remove(light);
          const index = practicals.indexOf(entry);
          if (index >= 0) practicals.splice(index, 1);
        },
      };
      applyMood(); // respect the current night mood for newly added lights
      return practicalHandle;
    },

    setNightMood(t: number): void {
      nightT = t;
      applyMood();
    },
  };

  // Default soft interior fills: one per open floor plate (trading floor and
  // research loft), centered over each floor at half ceiling clearance. These
  // give the dollhouse glow-from-inside read with zero M09 wiring; M04b's
  // mezzanine cutaway lets them spill. Non-shadowing by construction.
  const b = DIMENSIONS.building;
  const f = DIMENSIONS.floors;
  const midY = f.ceilingClearance / 2;
  handle.addPractical(
    { x: b.centerX, y: f.tradingY + midY, z: b.centerZ },
    LIGHT_TUNING.interiorFill,
  );
  handle.addPractical(
    { x: b.centerX, y: f.researchY + midY, z: b.centerZ },
    LIGHT_TUNING.interiorFill,
  );

  // Deep-recess corners from the station table (M04b data): one weak warm
  // fill in the stair column (x=5.5, z 3.5..6.5, mid-landing height) and one
  // at the vault's back wall (x -8..-4, just above the basement floor).
  handle.addPractical(
    { x: 5.5, y: f.tradingY + f.ceilingClearance * 0.6, z: 5 },
    LIGHT_TUNING.recessFill,
  );
  handle.addPractical({ x: -6, y: f.basementY + 1.6, z: b.centerZ }, LIGHT_TUNING.recessFill);

  // Cool accent under the satellite bridge mid-span so the umbilical pipes
  // read as a lit element against the void (roof cannon -> satellite pad).
  const sat = DIMENSIONS.satellite;
  const bridgeMidX = (b.centerX + b.footprintWidth / 2 + sat.x) / 2;
  const bridgeMidZ = (b.centerZ + sat.z) / 2;
  handle.addPractical(
    { x: bridgeMidX, y: (f.roofY + sat.y) / 2 + DIMENSIONS.bridge.midRise - 1, z: bridgeMidZ },
    LIGHT_TUNING.pipeAccent,
    "cool",
  );

  return handle;
}
