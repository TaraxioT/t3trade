// Biome universe bootstrap: renderer, environment, island assembly, hover
// and focus state, responsive framing, staged loading, and the render loop.

import * as THREE from "three";
import { ISLANDS, DEFAULT_VIEW, PALETTE as P } from "./config.js";
import { createCameraController } from "./camera.js";
import { forest } from "./biomes/forest.js";
import { farm } from "./biomes/farm.js";
import { desert } from "./biomes/desert.js";
import { beach } from "./biomes/beach.js";
import { glacier } from "./biomes/glacier.js";
import { volcano } from "./biomes/volcano.js";
import { wetlands } from "./biomes/wetlands.js";
import { damp } from "./util.js";

const BUILDERS = { forest, farm, desert, beach, glacier, volcano, wetlands };

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function createUniverse(container, ui) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
  } catch (err) {
    ui.webglFailed();
    return null;
  }
  //Coarse-pointer devices get a lower pixel ratio cap: phone GPUs fill fewer
  //pixels and the diorama style survives the resolution drop cleanly
  const coarse = matchMedia("(pointer: coarse)").matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.5 : 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(P.scene.background);
  scene.fog = new THREE.Fog(P.scene.fog, 135, 330);

  const camera = new THREE.PerspectiveCamera(
    38,
    container.clientWidth / container.clientHeight,
    0.5,
    420,
  );

  //Environment lighting: warm key with shadows (V2 lighting language),
  //cool rim from behind, soft hemisphere fill
  const hemi = new THREE.HemisphereLight(P.scene.hemiSky, P.scene.hemiGround, 0.78);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(P.scene.key, 1.5);
  key.position.set(38, 52, 26);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const half = 78;
  Object.assign(key.shadow.camera, {
    left: -half,
    right: half,
    top: half,
    bottom: -half,
    near: 8,
    far: 220,
  });
  key.shadow.bias = -0.0006;
  scene.add(key);
  const rim = new THREE.DirectionalLight(P.scene.rim, 1.05);
  rim.position.set(-30, 18, -40);
  scene.add(rim);
  const bounce = new THREE.DirectionalLight(0x3a5f8f, 0.32);
  bounce.position.set(-18, -26, 26);
  scene.add(bounce);

  //Focus spotlight: brightens the selected island without hiding the rest
  const focusLight = new THREE.SpotLight(0xfff4e0, 0, 46, 0.62, 0.55, 1.1);
  focusLight.position.set(10, 26, 12);
  scene.add(focusLight);
  scene.add(focusLight.target);
  let focusLightGoal = 0;

  //World root: scaled down on narrow viewports so the whole ring still fits
  const world = new THREE.Group();
  scene.add(world);
  let worldScale = 1;

  //Soft grounding shadow disc beneath each island
  const discMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float a = smoothstep(1.0, 0.15, d) * 0.42; gl_FragColor = vec4(0.008, 0.03, 0.055, a); }`,
  });

  const islands = [];
  let shadowDirty = true;
  let hovered = null;
  let selected = null;

  function addIsland(def, index) {
    const built = BUILDERS[def.id]({ size: def.size, thickness: def.thickness });
    const group = built.group;
    group.position.set(...def.position);
    group.rotation.y = def.rotationY;
    group.traverse((o) => {
      if (o.isMesh) {
        o.receiveShadow = true;
        o.geometry.computeBoundingSphere();
        o.castShadow = o.geometry.boundingSphere.radius > 0.4;
      }
    });
    group.userData.islandId = def.id;
    world.add(group);

    const disc = new THREE.Mesh(new THREE.CircleGeometry(def.size * 0.92, 26), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(def.position[0], def.position[1] - def.thickness - 6.5, def.position[2]);
    world.add(disc);

    islands.push({
      def,
      index,
      group,
      ticks: built.ticks,
      baseY: def.position[1],
      lift: 0,
    });
  }

  //Staged build so the first paint is quick and progress is real
  let buildIndex = 0;
  function buildStep() {
    if (buildIndex < ISLANDS.length) {
      addIsland(ISLANDS[buildIndex], buildIndex);
      ui.setProgress((buildIndex + 1) / (ISLANDS.length + 1));
      buildIndex++;
      setTimeout(buildStep, 30);
    } else {
      ui.setProgress(1);
      finishInit();
    }
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let lastHoverCheck = 0;

  function islandAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(world.children, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o && !o.userData.islandId) o = o.parent;
      if (o) return islands.find((i) => i.def.id === o.userData.islandId);
    }
    return null;
  }

  const toWorld = (v) => new THREE.Vector3(v[0] * worldScale, v[1] * worldScale, v[2] * worldScale);

  function select(id) {
    const island = islands.find((i) => i.def.id === id);
    if (!island) return;
    selected = id;
    const def = island.def;
    const target = toWorld([
      def.position[0] + def.focus.offset[0],
      def.position[1] + def.focus.offset[1],
      def.position[2] + def.focus.offset[2],
    ]);
    controller.focusOn(target, {
      azimuth: def.focus.azimuth,
      polar: def.focus.polar,
      distance: def.focus.distance * worldScale,
    });
    focusLight.position.set(target.x + 10, target.y + 24, target.z + 12);
    focusLight.target.position.copy(target);
    focusLightGoal = 1.35;
    hemiGoal = 0.5;
    ui.showPanel(def, island.index);
    ui.setActiveButton(id);
  }

  function deselect() {
    selected = null;
    controller.reset({
      azimuth: DEFAULT_VIEW.azimuth,
      polar: DEFAULT_VIEW.polar,
      distance: overviewDistance(),
      target: DEFAULT_VIEW.target,
    });
    focusLightGoal = 0;
    hemiGoal = 0.78;
    ui.hidePanel();
    ui.setActiveButton(null);
  }

  let hemiGoal = 0.78;

  const controller = createCameraController(camera, renderer.domElement, {
    initial: {
      azimuth: DEFAULT_VIEW.azimuth,
      polar: DEFAULT_VIEW.polar,
      distance: DEFAULT_VIEW.distance,
      target: DEFAULT_VIEW.target,
    },
    limits: { minDistance: 22 * worldScale, maxDistance: 170 },
    reducedMotion: reduceMotion,
    onUserInput: () => ui.hintSeen(),
    onTap: (x, y) => {
      const island = islandAt(x, y);
      if (island) select(island.def.id);
      else if (selected) deselect();
    },
  });

  function onPointerMove(e) {
    const now = performance.now();
    if (now - lastHoverCheck < 60) return;
    lastHoverCheck = now;
    const island = islandAt(e.clientX, e.clientY);
    const id = island ? island.def.id : null;
    if (id !== hovered) {
      hovered = id;
      renderer.domElement.style.cursor = id ? "pointer" : "grab";
      if (id && !reduceMotion)
        ui.showHoverTag(e.clientX, e.clientY, islands.find((i) => i.def.id === id).def.name);
      else ui.hideHoverTag();
    } else if (id) {
      ui.moveHoverTag(e.clientX, e.clientY);
    }
  }
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerleave", () => {
    hovered = null;
    ui.hideHoverTag();
  });

  //Keyboard: 1-7 select islands, Escape returns to the overview
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (selected) deselect();
      return;
    }
    const def = ISLANDS.find((d) => d.key === e.key);
    if (def) select(def.id);
  });

  ui.onSelect((id) => (id === null ? deselect() : select(id)));

  const viewFit = { scale: 1, boost: 1 };
  const overviewDistance = () => DEFAULT_VIEW.distance * viewFit.scale * viewFit.boost;

  function layout() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    //Fit the whole ring: shrink the world when the viewport gets narrow.
    //On portrait phones the ring is zoomed out relative to the shrunken
    //world so all seven silhouettes stay in frame at map scale.
    const aspect = w / h;
    if (aspect < 0.95) {
      viewFit.scale = 0.46;
      viewFit.boost = 2.4;
      camera.fov = 52;
    } else {
      viewFit.scale = THREE.MathUtils.clamp(aspect / 1.62, 0.85, 1);
      viewFit.boost = 1;
      camera.fov = 38;
    }
    worldScale = viewFit.scale;
    world.scale.setScalar(viewFit.scale);
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", layout);

  let lastT = performance.now();
  let running = false;

  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;
    controller.update(dt);

    //Environmental motion pauses entirely under reduced motion; every biome
    //is built to read fully composed in its initial state
    if (!reduceMotion) {
      for (const island of islands) {
        for (const tick of island.ticks) tick(dt);
      }
    }

    //Hover lift and focus lift ease toward their goals. The shadow map only
    //refreshes while a lift is in motion; the scene is otherwise static.
    let lifting = false;
    for (const island of islands) {
      const goal = (hovered === island.def.id ? 0.45 : 0) + (selected === island.def.id ? 0.55 : 0);
      island.lift = damp(island.lift, goal, 8, dt);
      island.group.position.y = island.baseY + island.lift;
      if (Math.abs(island.lift - goal) > 0.01) lifting = true;
    }
    renderer.shadowMap.needsUpdate = lifting || shadowDirty;
    if (lifting) shadowDirty = true;
    if (shadowDirty && !lifting) shadowDirty = false;

    focusLight.intensity = damp(focusLight.intensity, focusLightGoal, 5, dt);
    hemi.intensity = damp(hemi.intensity, hemiGoal, 5, dt);

    renderer.render(scene, camera);
  }

  function finishInit() {
    layout();
    controller.reset({
      azimuth: DEFAULT_VIEW.azimuth,
      polar: DEFAULT_VIEW.polar,
      distance: overviewDistance(),
      target: DEFAULT_VIEW.target,
    });
    ui.ready();
    //Debug hook for automated layout checks in the browser
    window.__biome = { camera, world, islands, worldScale, THREE };
    if (!running) {
      running = true;
      frame();
    }
  }

  buildStep();

  return {
    select,
    deselect,
    destroy() {
      renderer.dispose();
      container.removeChild(renderer.domElement);
    },
  };
}
