/**
 * World assembly: scene-graph layers per the contract zIndex plan, the
 * plate, the additive dome (with ±8px drift), and the ambient FX set
 * (spec §29) — every effect on its own desynced frequency, driven from one
 * per-frame update that respects the Operator demo freeze.
 */
import gsap from "gsap";
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { ENTRANCE, WORLD } from "./config";
import { Z } from "./types";
import type { Layers, DioramaContext } from "./types";
import { pctPoint, pctRect } from "./config/positions";
import type { Pt } from "./config/positions";

const FX_COLOR = {
  cyan: 0x3dd6c4,
  white: 0xffffff,
  violet: 0x8f6beb,
  amber: 0xffd166,
  orange: 0xff7a45,
  blue: 0x4a90e2,
  green: 0x5bb974,
} as const;

function glowDot(color: number, radius: number, alpha: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, radius).fill({ color, alpha });
  g.circle(0, 0, radius * 0.4).fill({ color, alpha: Math.min(1, alpha * 1.4) });
  g.blendMode = "add";
  return g;
}

export interface WorldHandle {
  layers: Layers;
  update: (elapsedSec: number, deltaSec: number) => void;
  entrance: (beats: EntranceBeats) => void;
  testnetFlash: () => void;
  dispose: () => void;
}

export interface EntranceBeats {
  onLights: () => void;
  onChannels: () => void;
  onObservatory: () => void;
  onCrate: () => void;
  onSign: () => void;
}

export function buildWorld(ctx: DioramaContext): WorldHandle {
  const root = new Container();
  ctx.viewport.addChild(root);

  const layers: Layers = {
    root,
    backdrop: layer(Z.backdrop),
    plate: layer(Z.plate),
    waterFX: layer(Z.waterFX),
    bridgeFX: layer(Z.bridgeFX),
    actors: sortableLayer(Z.actors),
    machineFX: layer(Z.machineFX),
    dome: layer(Z.dome),
    exteriorFX: layer(Z.exteriorFX),
    hotspots: layer(Z.hotspots),
    labels: layer(Z.labels),
  };
  function layer(z: number): Container {
    const c = new Container();
    c.zIndex = z;
    root.addChild(c);
    return c;
  }
  function sortableLayer(z: number): Container {
    const c = layer(z);
    c.sortableChildren = true;
    return c;
  }

  // ---------------------------------------------------------- backdrop
  const backdrop = new Container();
  layers.backdrop.addChild(backdrop);
  const bg = new Graphics();
  bg.rect(-WORLD.width, -WORLD.height, WORLD.width * 3, WORLD.height * 3).fill(0x05070a);
  bg.ellipse(WORLD.width * 0.5, WORLD.height * 0.42, WORLD.width * 0.75, WORLD.height * 0.85).fill({
    color: 0x0d131a,
    alpha: 0.85,
  });
  bg.ellipse(WORLD.width * 0.5, WORLD.height * 0.45, WORLD.width * 0.45, WORLD.height * 0.55).fill({
    color: 0x131b26,
    alpha: 0.7,
  });
  backdrop.addChild(bg);
  // Vignette corners
  const vignette = new Graphics();
  vignette.rect(0, 0, WORLD.width, WORLD.height).fill({ color: 0x000000, alpha: 0.001 });
  for (const [cx, cy] of [
    [0, 0],
    [WORLD.width, 0],
    [0, WORLD.height],
    [WORLD.width, WORLD.height],
  ] as const) {
    vignette
      .ellipse(cx, cy, WORLD.width * 0.55, WORLD.height * 0.6)
      .fill({ color: 0x000000, alpha: 0.22 });
  }
  layers.backdrop.addChild(vignette);

  // ------------------------------------------------------------- plate
  if (ctx.assets.plate) {
    const plate = new Sprite(ctx.assets.plate);
    plate.width = WORLD.width;
    plate.height = WORLD.height;
    layers.plate.addChild(plate);
  }

  // -------------------------------------------------------------- dome
  const dome = ctx.assets.dome;
  layers.dome.addChild(dome);
  let domeDrift: gsap.core.Tween | null = null;

  // ------------------------------------------------------------ FX set
  interface Fx {
    update: (t: number, dt: number) => void;
  }
  const fx: Fx[] = [];
  const disposables: Array<{ destroy: () => void }> = [];

  function addGlowPoint(
    parent: Container,
    at: Pt,
    color: number,
    radius: number,
    periodSec: number,
    phase: number,
  ): void {
    const dot = glowDot(color, radius, 0.35);
    dot.position.set(at.x, at.y);
    parent.addChild(dot);
    disposables.push(dot);
    fx.push({
      update: (t) => {
        const s = Math.sin((t / periodSec) * Math.PI * 2 + phase);
        dot.alpha = 0.35 + 0.55 * Math.max(0, s);
      },
    });
  }

  // Dome drift: slow ±8px horizontal sweep, always running (living glass).
  {
    const state = { x: 0 };
    domeDrift = gsap.to(state, {
      x: 8,
      duration: 9,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
      onUpdate: () => {
        dome.x = state.x;
      },
    });
  }

  // Dust motes: sparse, slow, whole-scene.
  {
    const motes: Array<{ s: Sprite; vx: number; vy: number }> = [];
    const moteTex = moteTexture();
    for (let i = 0; i < 26; i++) {
      const s = new Sprite(moteTex);
      s.anchor.set(0.5);
      s.alpha = 0.05 + Math.random() * 0.08;
      s.position.set(Math.random() * WORLD.width, Math.random() * WORLD.height);
      layers.backdrop.addChild(s);
      motes.push({ s, vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 6 });
    }
    disposables.push(moteTex);
    fx.push({
      update: (_t, dt) => {
        for (const m of motes) {
          m.s.x += m.vx * dt;
          m.s.y += m.vy * dt;
          if (m.s.x < 0 || m.s.x > WORLD.width) m.vx *= -1;
          if (m.s.y < 0 || m.s.y > WORLD.height) m.vy *= -1;
        }
      },
    });
  }

  // Water shimmer: drifting additive ellipses in the sea and the basin.
  {
    const regions = [pctRect([72, 76, 26, 22]), pctRect([26, 62, 7, 18])];
    const shimmers: Array<{ s: Sprite; r: ReturnType<typeof pctRect>; vx: number }> = [];
    const tex = shimmerTexture();
    disposables.push(tex);
    for (let i = 0; i < 14; i++) {
      const r = regions[i % regions.length];
      const s = new Sprite(tex);
      s.anchor.set(0.5);
      s.alpha = 0.12;
      s.position.set(r.x + Math.random() * r.w, r.y + Math.random() * r.h);
      layers.waterFX.addChild(s);
      shimmers.push({ s, r, vx: (Math.random() - 0.5) * 10 });
    }
    fx.push({
      update: (_t, dt) => {
        for (const sh of shimmers) {
          sh.s.x += sh.vx * dt;
          if (sh.s.x < sh.r.x || sh.s.x > sh.r.x + sh.r.w) sh.vx *= -1;
        }
      },
    });
  }

  // Crystal twinkles behind/under the dome.
  for (let i = 0; i < 9; i++) {
    const at = pctPoint(25 + Math.random() * 44, 11 + Math.random() * 21);
    addGlowPoint(
      layers.exteriorFX,
      at,
      FX_COLOR.violet,
      5 + Math.random() * 6,
      2.2 + Math.random() * 4.5,
      Math.random() * 7,
    );
  }

  // Vortex swirl on the left upper observatory island.
  {
    const vortex = new Graphics();
    const center = pctPoint(13, 20);
    vortex.position.set(center.x, center.y);
    vortex.blendMode = "add";
    layers.exteriorFX.addChild(vortex);
    disposables.push(vortex);
    fx.push({
      update: (t) => {
        vortex.clear();
        const arms = 3;
        for (let a = 0; a < arms; a++) {
          for (let s = 0; s < 22; s++) {
            const f = s / 22;
            const ang = (a / arms) * Math.PI * 2 + f * 4.2 + t * 0.35;
            const rad = 8 + f * 46;
            const x = Math.cos(ang) * rad;
            const y = Math.sin(ang) * rad * 0.7;
            vortex
              .circle(x, y, 2.6 * (1 - f) + 0.6)
              .fill({ color: FX_COLOR.cyan, alpha: 0.24 * (1 - f) });
          }
        }
      },
    });
  }

  // Status LEDs across machinery.
  const ledAnchors: Array<[number, number, number]> = [
    [21, 32, FX_COLOR.green],
    [36, 33, FX_COLOR.amber],
    [45, 31, FX_COLOR.green],
    [58, 30, FX_COLOR.orange],
    [67, 24, FX_COLOR.green],
    [70, 43, FX_COLOR.blue],
    [33, 52, FX_COLOR.green],
    [50, 58, FX_COLOR.cyan],
    [64, 55, FX_COLOR.green],
    [80, 22, FX_COLOR.blue],
    [86, 70, FX_COLOR.amber],
    [6, 42, FX_COLOR.green],
  ];
  ledAnchors.forEach(([x, y, c], i) => {
    addGlowPoint(layers.machineFX, pctPoint(x, y), c, 3.4, 1.4 + (i % 5) * 0.9, i * 1.3);
  });

  // Pipe gantry flow pulses: additive dots running down the pipe run.
  {
    const gantry = pctRect([77, 30, 9, 32]);
    const dots: Array<{ g: Graphics; f: number; speed: number }> = [];
    for (let i = 0; i < 7; i++) {
      const g = glowDot(i % 2 ? FX_COLOR.orange : FX_COLOR.blue, 3.6, 0.5);
      layers.exteriorFX.addChild(g);
      disposables.push(g);
      dots.push({ g, f: Math.random(), speed: 0.12 + Math.random() * 0.1 });
    }
    fx.push({
      update: (_t, dt) => {
        for (const d of dots) {
          d.f = (d.f + d.speed * dt) % 1;
          d.g.position.set(
            gantry.x + gantry.w * (0.25 + 0.5 * Math.sin(d.f * Math.PI)),
            gantry.y + gantry.h * d.f,
          );
          d.g.alpha = 0.25 + 0.4 * Math.sin(d.f * Math.PI);
        }
      },
    });
  }

  // Island string-light twinkles over the bazaar.
  for (let i = 0; i < 8; i++) {
    addGlowPoint(
      layers.exteriorFX,
      pctPoint(80 + Math.random() * 17, 66 + Math.random() * 8),
      FX_COLOR.amber,
      2.8,
      1.8 + Math.random() * 3.2,
      Math.random() * 6,
    );
  }

  // TESTNET sign glow + header signboard flicker.
  const testnetSign = new Graphics();
  const signRect = pctRect([88, 18, 10, 12]);
  testnetSign
    .roundRect(signRect.x, signRect.y, signRect.w, signRect.h, 8)
    .fill({ color: FX_COLOR.blue, alpha: 0.08 })
    .stroke({ color: FX_COLOR.blue, width: 2, alpha: 0.3 });
  testnetSign.blendMode = "add";
  layers.exteriorFX.addChild(testnetSign);
  disposables.push(testnetSign);
  fx.push({
    update: (t) => {
      testnetSign.alpha = 0.75 + 0.25 * Math.sin(t * 1.7) * (Math.random() > 0.02 ? 1 : 0.2);
    },
  });

  const headerSign = new Graphics();
  const headerRect = pctRect([44, 2, 12, 5]);
  headerSign
    .roundRect(headerRect.x, headerRect.y, headerRect.w, headerRect.h, 4)
    .fill({ color: FX_COLOR.white, alpha: 0.03 });
  headerSign.blendMode = "add";
  layers.exteriorFX.addChild(headerSign);
  disposables.push(headerSign);
  fx.push({
    update: (t) => {
      headerSign.alpha = Math.random() > 0.01 ? 1 : 0.4 + Math.random() * 0.4;
      void t;
    },
  });

  // Steam puffs at vents.
  {
    const vents = [pctPoint(30, 86), pctPoint(55, 88), pctPoint(80, 72), pctPoint(10, 60)];
    const puffTex = puffTexture();
    disposables.push(puffTex);
    const spawnPuff = (at: Pt): void => {
      const s = new Sprite(puffTex);
      s.anchor.set(0.5);
      s.alpha = 0.16;
      s.position.set(at.x, at.y);
      layers.exteriorFX.addChild(s);
      gsap.to(s, {
        y: s.y - 34 - Math.random() * 20,
        x: s.x + (Math.random() - 0.5) * 16,
        alpha: 0,
        scale: 1.8,
        duration: 2.6,
        ease: "power1.out",
        onComplete: () => s.destroy(),
      });
    };
    for (const vent of vents) {
      const loop = (): void => {
        spawnPuff(vent);
        gsap.delayedCall(gsap.utils.random(5, 14), loop);
      };
      gsap.delayedCall(gsap.utils.random(1, 6), loop);
    }
  }

  // -------------------------------------------------------------- loop
  function update(elapsedSec: number, deltaSec: number): void {
    if (performance.now() < ctx.frozenUntil) return; // Operator demo freeze
    for (const effect of fx) effect.update(elapsedSec, deltaSec);
  }

  // ---------------------------------------------------------- entrance
  function entrance(beats: EntranceBeats): void {
    const tl = gsap.timeline();
    layers.plate.alpha = 0;
    layers.backdrop.alpha = 1;
    const step = ENTRANCE.totalSec / 7;
    tl.to(layers.plate, { alpha: 1, duration: step * 1.6, ease: "sine.inOut" }, step * 0.4);
    tl.add(() => beats.onLights(), step * 1.4);
    tl.add(() => beats.onChannels(), step * 2.2);
    tl.add(() => beats.onObservatory(), step * 3.2);
    tl.add(() => beats.onCrate(), step * 4.2);
    tl.add(() => beats.onSign(), step * 5.6);
    dome.alpha = 0;
    tl.to(dome, { alpha: 1, duration: step * 1.5, ease: "sine.inOut" }, step * 1.2);
  }

  function testnetFlash(): void {
    gsap.fromTo(testnetSign, { alpha: 2.5 }, { alpha: 1, duration: 0.9, ease: "power2.out" });
  }

  function moteTexture(): Texture {
    const g = new Graphics();
    g.circle(0, 0, 2.2).fill({ color: 0xdfe8ee, alpha: 0.5 });
    const t = ctx.app.renderer.generateTexture({ target: g, resolution: 1 });
    g.destroy();
    return t;
  }
  function shimmerTexture(): Texture {
    const g = new Graphics();
    g.ellipse(0, 0, 26, 6).fill({ color: FX_COLOR.cyan, alpha: 0.4 });
    const t = ctx.app.renderer.generateTexture({ target: g, resolution: 1 });
    g.destroy();
    return t;
  }
  function puffTexture(): Texture {
    const g = new Graphics();
    g.circle(0, 0, 9).fill({ color: 0xb9c4cc, alpha: 0.35 });
    g.circle(5, 2, 6).fill({ color: 0xb9c4cc, alpha: 0.25 });
    const t = ctx.app.renderer.generateTexture({ target: g, resolution: 1 });
    g.destroy();
    return t;
  }

  // Monolith basin under-glow (vault zone anchor).
  {
    const basin = pctRect([25, 54, 9, 28]);
    const g = glowDot(FX_COLOR.cyan, basin.w * 0.45, 0.1);
    g.position.set(basin.x + basin.w / 2, basin.y + basin.h * 0.6);
    g.width = basin.w * 1.6;
    g.height = basin.h * 0.5;
    layers.waterFX.addChild(g);
    disposables.push(g);
    fx.push({
      update: (t) => {
        g.alpha = 0.08 + 0.05 * Math.sin(t * 0.6);
      },
    });
  }

  return {
    layers,
    update,
    entrance,
    testnetFlash,
    dispose: () => {
      domeDrift?.kill();
      for (const d of disposables) d.destroy();
      root.destroy({ children: true });
    },
  };
}
