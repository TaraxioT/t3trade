// Particle systems for environmental motion: rain, snow, smoke, motes.
// One small shader gives every system soft round particles with per-particle
// size and alpha, so no textures are needed anywhere in the scene.

import * as THREE from "three";

const VERT = `
attribute float aScale;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aScale * (140.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float edge = smoothstep(0.5, 0.18, d);
  if (edge * vAlpha < 0.01) discard;
  gl_FragColor = vec4(vColor, edge * vAlpha);
}`;

export function makeParticles({ count, color = 0xffffff, baseAlpha = 0.8, size = 1 }) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const alphas = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
    alphas[i] = baseAlpha;
    scales[i] = size;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aScale", new THREE.BufferAttribute(scales, 1));
  geo.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));
  geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, positions, scales, alphas, geo, mat };
}

//Rain concentrated beneath a cloud: a bounded cylinder of fast falling streaks
export function makeRain({ center, radius = 3, height = 6, count = 220, color = 0xcfe0ef }) {
  const sys = makeParticles({ count, color, baseAlpha: 0.68, size: 0.6 });
  const vel = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * radius;
    sys.positions[i * 3] = center.x + Math.cos(a) * rr;
    sys.positions[i * 3 + 1] = center.y + Math.random() * height;
    sys.positions[i * 3 + 2] = center.z + Math.sin(a) * rr;
    vel[i] = 9 + Math.random() * 4;
    sys.scales[i] = 0.4 + Math.random() * 0.35;
  }
  sys.geo.attributes.position.needsUpdate = true;
  return {
    object: sys.points,
    update(dt) {
      for (let i = 0; i < count; i++) {
        sys.positions[i * 3 + 1] -= vel[i] * dt;
        if (sys.positions[i * 3 + 1] < center.y - 0.2) {
          sys.positions[i * 3 + 1] = center.y + height;
        }
      }
      sys.geo.attributes.position.needsUpdate = true;
    },
  };
}

//Snow: slow vertical drift with sinusoidal sway
export function makeSnow({ center, spread = 8, height = 7, count = 160, color = 0xeef4fb }) {
  const sys = makeParticles({ count, color, baseAlpha: 0.85, size: 0.55 });
  const phase = new Float32Array(count);
  const speed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    sys.positions[i * 3] = center.x + (Math.random() - 0.5) * spread;
    sys.positions[i * 3 + 1] = center.y + Math.random() * height;
    sys.positions[i * 3 + 2] = center.z + (Math.random() - 0.5) * spread;
    phase[i] = Math.random() * Math.PI * 2;
    speed[i] = 0.5 + Math.random() * 0.5;
    sys.scales[i] = 0.35 + Math.random() * 0.4;
  }
  let t = 0;
  return {
    object: sys.points,
    update(dt) {
      t += dt;
      for (let i = 0; i < count; i++) {
        sys.positions[i * 3 + 1] -= speed[i] * dt;
        sys.positions[i * 3] += Math.sin(t * 0.9 + phase[i]) * dt * 0.35;
        if (sys.positions[i * 3 + 1] < center.y - 0.3) {
          sys.positions[i * 3 + 1] = center.y + height;
        }
      }
      sys.geo.attributes.position.needsUpdate = true;
    },
  };
}

//Smoke or ash column: rises, spreads, fades, respawns near the source
export function makeSmoke({
  origin,
  count = 90,
  color = 0x5a5f6e,
  rise = 3.2,
  spread = 1.1,
  size = 1.6,
}) {
  const sys = makeParticles({ count, color, baseAlpha: 0.4, size });
  const life = new Float32Array(count);
  const maxLife = new Float32Array(count);
  const drift = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    life[i] = Math.random() * 4;
    maxLife[i] = 3 + Math.random() * 2.5;
    drift[i * 2] = (Math.random() - 0.5) * 0.4;
    drift[i * 2 + 1] = (Math.random() - 0.5) * 0.4;
    sys.positions[i * 3] = origin.x;
    sys.positions[i * 3 + 1] = origin.y;
    sys.positions[i * 3 + 2] = origin.z;
  }
  return {
    object: sys.points,
    update(dt) {
      for (let i = 0; i < count; i++) {
        life[i] += dt;
        const t = life[i] / maxLife[i];
        if (t >= 1) {
          life[i] = 0;
          sys.positions[i * 3] = origin.x + (Math.random() - 0.5) * 0.4;
          sys.positions[i * 3 + 1] = origin.y;
          sys.positions[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.4;
          continue;
        }
        sys.positions[i * 3 + 1] += rise * dt * (0.5 + t * 0.8);
        sys.positions[i * 3] += (drift[i * 2] + t * 0.25) * dt;
        sys.positions[i * 3 + 2] += drift[i * 2 + 1] * dt * spread;
        sys.alphas[i] = 0.42 * Math.sin(Math.PI * Math.min(t, 1));
        sys.scales[i] = size * (0.5 + t * 1.4);
      }
      sys.geo.attributes.position.needsUpdate = true;
      sys.geo.attributes.aAlpha.needsUpdate = true;
      sys.geo.attributes.aScale.needsUpdate = true;
    },
  };
}

//Waterfall: streak particles hugging a vertical drop, respawning at the lip
export function makeWaterfallFall({ top, bottom, width = 1.6, count = 140, color = 0xdff3ff }) {
  const sys = makeParticles({ count, color, baseAlpha: 0.65, size: 0.7 });
  const speed = new Float32Array(count);
  const off = new Float32Array(count * 2);
  const drop = top.y - bottom.y;
  for (let i = 0; i < count; i++) {
    off[i * 2] = (Math.random() - 0.5) * width;
    off[i * 2 + 1] = (Math.random() - 0.5) * 0.3;
    sys.positions[i * 3] = top.x + off[i * 2];
    sys.positions[i * 3 + 1] = top.y - Math.random() * drop;
    sys.positions[i * 3 + 2] = top.z + off[i * 2 + 1];
    speed[i] = 7 + Math.random() * 5;
    sys.scales[i] = 0.4 + Math.random() * 0.5;
  }
  return {
    object: sys.points,
    update(dt) {
      for (let i = 0; i < count; i++) {
        sys.positions[i * 3 + 1] -= speed[i] * dt;
        if (sys.positions[i * 3 + 1] < bottom.y - 0.4) {
          sys.positions[i * 3 + 1] = top.y;
        }
      }
      sys.geo.attributes.position.needsUpdate = true;
    },
  };
}

//Static gentle motes for ambient life (bioluminescence, pollen, embers)
export function makeMotes({ center, spread = 6, height = 4, count = 40, color = 0x9fe8d8 }) {
  const sys = makeParticles({ count, color, baseAlpha: 0.7, size: 0.5 });
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    sys.positions[i * 3] = center.x + (Math.random() - 0.5) * spread;
    sys.positions[i * 3 + 1] = center.y + Math.random() * height;
    sys.positions[i * 3 + 2] = center.z + (Math.random() - 0.5) * spread;
    phase[i] = Math.random() * Math.PI * 2;
    sys.scales[i] = 0.3 + Math.random() * 0.35;
  }
  let t = 0;
  return {
    object: sys.points,
    update(dt) {
      t += dt;
      for (let i = 0; i < count; i++) {
        sys.alphas[i] = 0.35 + 0.35 * Math.sin(t * 1.6 + phase[i]);
      }
      sys.geo.attributes.aAlpha.needsUpdate = true;
    },
  };
}
