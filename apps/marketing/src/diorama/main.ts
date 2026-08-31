/**
 * startDiorama: boot sequence for /diorama. Loads assets with staged
 * progress (plate+shell -> cast+systems -> audio/lazy extras), builds the
 * world, camera, director, systems and interaction, runs the entrance,
 * and returns a dispose() used on pagehide/beforeunload.
 */
import gsap from "gsap";
import { Application } from "pixi.js";
import { Viewport } from "pixi-viewport";
import { loadAssets } from "./assets";
import { AudioManager } from "./audio";
import { createCamera } from "./camera";
import type { CameraHandle } from "./camera";
import { buildWorld } from "./world";
import type { WorldHandle } from "./world";
import { DioramaDirector } from "./director";
import { BubbleManager } from "./ui/bubbles";
import { createHotspots } from "./ui/hotspots";
import type { HotspotsHandle } from "./ui/hotspots";
import { Agent } from "./actors/Agent";
import { CAST, PLACES } from "./config/positions";
import { CAMERA, WORLD } from "./config";
import type { DioramaContext } from "./types";
import { gauntletEvent } from "./systems/gauntlet";
import { vaultEvent } from "./systems/vault";
import { WatchtowerSystem } from "./systems/watchtower";
import { BudgetSystem } from "./systems/budget";
import { taggingEvents } from "./systems/tagging";
import { ObservatorySystem } from "./systems/observatory";
import { interpretersEvent } from "./systems/interpreters";
import { OperatorSystem } from "./systems/operator";
import { BridgeSystem } from "./systems/bridge";
import { FerrySystem } from "./systems/ferry";
import { archivesEvent } from "./systems/archives";
import { characterEvents } from "./events/characterEvents";

function readStageAssets(stage: HTMLElement): ReadonlySet<string> | null {
  const raw = stage.dataset.assets;
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed))
      return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    /* fall through: treat as unknown availability */
  }
  return null;
}

export interface DioramaHandle {
  dispose: () => void;
  ready: Promise<void>;
}

export function startDiorama(stage: HTMLElement): DioramaHandle {
  const loading = document.getElementById("loading");
  const progressFill = document.querySelector<HTMLElement>("#progress .progress-fill");
  const progress = document.getElementById("progress");
  const status = document.getElementById("status");
  const announcer = document.getElementById("announcer");
  const fallback = document.getElementById("fallback");
  const soundButton = document.getElementById("sound") as HTMLButtonElement | null;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isPhone = window.innerWidth < CAMERA.phoneBreakpoint;

  const setProgress = (fraction: number, label: string): void => {
    if (progressFill) progressFill.style.width = `${Math.round(fraction * 100)}%`;
    if (progress) progress.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    if (status && label) status.textContent = label;
  };
  const hideLoading = (): void => {
    loading?.classList.add("done");
    window.setTimeout(() => loading?.setAttribute("hidden", ""), 900);
  };
  const fail = (): void => {
    loading?.setAttribute("hidden", "");
    if (fallback) {
      const src = fallback.getAttribute("data-src");
      if (src) fallback.setAttribute("src", src);
      fallback.hidden = false;
    }
  };

  let disposed = false;
  const cleanupFns: Array<() => void> = [];
  // Set once the world exists; the __diorama hook below closes over them.
  let layerToggle: ((mode: "plate" | "actors" | "full") => string) | null = null;
  let agentsProbe: (() => Array<{ id: string; x: number; y: number; pose: string }>) | null = null;
  const debugState = { zoneHook: null as ((name: string) => string) | null };
  const stats = {
    fps: 0,
    camera: { x: WORLD.width / 2, y: WORLD.height / 2, scale: 1 },
  };

  const ready = (async (): Promise<void> => {
    // ---------------------------------------------- phase 1: shell+plate
    setProgress(0.05, "Waking the Bureau");
    const app = new Application();
    await app.init({
      background: "#05070a",
      resizeTo: stage,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio, 2),
      autoDensity: true,
    });
    stage.appendChild(app.canvas);
    cleanupFns.push(() => app.destroy(true, { children: true, texture: true }));

    const viewport = new Viewport({
      screenWidth: stage.clientWidth,
      screenHeight: stage.clientHeight,
      worldWidth: WORLD.width,
      worldHeight: WORLD.height,
      events: app.renderer.events,
    });
    app.stage.addChild(viewport);

    const camera: CameraHandle = createCamera(viewport, { reducedMotion });

    // Keep the viewport's screen metrics and the framing model in sync with
    // renderer resizes (real resizes re-derive zoom bounds and re-clamp).
    const onResize = (): void => {
      viewport.resize(stage.clientWidth, stage.clientHeight);
      camera.onResize(stage.clientWidth, stage.clientHeight);
    };
    app.renderer.on("resize", onResize);
    cleanupFns.push(() => app.renderer.off("resize", onResize));
    cleanupFns.push(() => camera.dispose());

    // Asset phases 1+2 (plate -> cast/props/ferry/dome), all with fallbacks.
    // Requests are gated on the build-time file listing (data-assets) so
    // absent optional art never produces a console 404.
    const assets = await loadAssets(
      app.renderer,
      (f) => setProgress(0.05 + f * 0.8, f < 0.5 ? "Drawing the Bureau" : "Hiring the bots"),
      readStageAssets(stage),
    );

    const audio = new AudioManager();
    cleanupFns.push(() => audio.dispose());

    const logLines: string[] = [];
    const ctx: DioramaContext = {
      app,
      viewport,
      // Filled in right after buildWorld; systems only run post-build.
      layers: { root: viewport } as unknown as DioramaContext["layers"],
      assets,
      audio,
      director: null as unknown as DioramaContext["director"],
      bubbles: new BubbleManager(viewport),
      agents: [],
      reducedMotion,
      isPhone,
      log: (line) => logLines.push(line),
      rand: (min, max) => min + Math.random() * (max - min),
      pick: (items) => items[Math.floor(Math.random() * items.length)],
      frozenUntil: 0,
    };

    // -------------------------------------------- phase 2: world + cast
    setProgress(0.88, "Opening the Bureau");
    const world: WorldHandle = buildWorld(ctx);
    ctx.layers = world.layers;
    cleanupFns.push(() => world.dispose());

    agentsProbe = () => ctx.agents.map((a) => ({ id: a.id, x: a.x, y: a.y, pose: a.poseName }));

    layerToggle = (mode) => {
      const L = world.layers;
      const hidden =
        mode === "plate"
          ? [L.actors, L.machineFX, L.waterFX, L.bridgeFX, L.exteriorFX, L.dome]
          : mode === "actors"
            ? [L.dome]
            : [];
      const shown = [L.actors, L.machineFX, L.waterFX, L.bridgeFX, L.exteriorFX, L.dome];
      for (const layer of hidden) layer.visible = false;
      for (const layer of shown) if (!hidden.includes(layer)) layer.visible = true;
      return mode;
    };

    const director = new DioramaDirector(ctx);
    ctx.director = director;
    cleanupFns.push(() => director.dispose());

    // BubbleManager placeholder above was parented to the viewport; rebuild
    // it on the real labels layer now that layers exist.
    ctx.bubbles.dispose();
    ctx.bubbles = new BubbleManager(world.layers.labels);

    for (const entry of CAST) {
      const home = PLACES[entry.post] ?? { x: WORLD.width / 2, y: WORLD.height * 0.66 };
      const agent = new Agent(
        entry.id,
        entry.role,
        entry.kind,
        assets.bots[entry.role],
        home,
        {
          layer: world.layers.actors,
          fxLayer: world.layers.machineFX,
        },
        { pose: entry.pose, scaleClass: entry.scaleClass },
      );
      ctx.agents.push(agent);
      // Bots appear during the entrance, staggered, not all at once.
      agent.container.alpha = 0;
      gsap.delayedCall(gsap.utils.random(0.5, 2.6), () => {
        if (!disposed) gsap.to(agent.container, { alpha: 1, duration: 0.5 });
      });
    }

    // ------------------------------------------------------- systems
    const watchtower = new WatchtowerSystem(ctx);
    const budget = new BudgetSystem(ctx);
    const observatory = new ObservatorySystem(ctx);
    const operator = new OperatorSystem(ctx);
    const bridge = new BridgeSystem(ctx);
    const ferry = new FerrySystem(ctx);

    director.register(gauntletEvent());
    director.register(vaultEvent());
    director.register(watchtower.event());
    director.register(budget.event());
    for (const event of taggingEvents()) director.register(event);
    director.register(observatory.event());
    director.register(interpretersEvent());
    director.register(operator.event());
    director.register(bridge.event());
    director.register(ferry.event());
    director.register(archivesEvent());
    for (const event of characterEvents()) director.register(event);
    for (const line of assets.substituted) ctx.log(line);

    // --------------------------------------------------- interaction
    const hotspots: HotspotsHandle = createHotspots({
      hotspotLayer: world.layers.hotspots,
      labelLayer: world.layers.labels,
      camera,
      director,
      stage,
      announcer: announcer ?? document.createElement("p"),
      onFocus: (zone) => {
        if (zone === "operator") operator.maybeDemo();
      },
    });
    cleanupFns.push(() => hotspots.dispose());

    // Sound control: persisted pref, first-gesture unlock, aria-pressed.
    audio.attachUnlock(() => document.body);
    if (soundButton) {
      const reflect = (): void => {
        soundButton.setAttribute("aria-pressed", String(audio.enabled));
        soundButton.textContent = audio.enabled ? "Sound on" : "Sound off";
      };
      reflect();
      soundButton.disabled = false;
      const onClick = (): void => {
        audio.setEnabled(!audio.enabled, soundButton);
        if (audio.enabled) audio.play("chirp", "character");
        reflect();
      };
      soundButton.addEventListener("click", onClick);
      cleanupFns.push(() => soundButton.removeEventListener("click", onClick));
    }

    // ------------------------------------------- phase 3 + ticker loops
    setProgress(0.96, "Tuning the instruments");
    // Audio registers lazily — no eager fetch blocks first paint.

    app.ticker.add(() => {
      stats.fps = app.ticker.FPS;
      stats.camera = { x: viewport.center.x, y: viewport.center.y, scale: viewport.scale.x };
      const t = app.ticker.lastTime / 1000;
      const dt = Math.min(app.ticker.deltaMS / 1000, 0.1);
      world.update(t, dt);
      budget.update(t);
      observatory.update(t);
      audio.setListener({ x: viewport.center.x, y: viewport.center.y });
      hotspots.update();
    });

    // Suspend when the tab is hidden or the stage leaves the viewport.
    let suspended = false;
    const suspend = (): void => {
      if (suspended || disposed) return;
      suspended = true;
      app.ticker.stop();
      gsap.globalTimeline.pause();
    };
    const resume = (): void => {
      if (!suspended || disposed) return;
      suspended = false;
      app.ticker.start();
      gsap.globalTimeline.play();
    };
    const onVisibility = (): void => (document.hidden ? suspend() : resume());
    document.addEventListener("visibilitychange", onVisibility);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) (entry.isIntersecting ? resume : suspend)();
      },
      { threshold: 0.01 },
    );
    observer.observe(stage);
    cleanupFns.push(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
    });

    // ------------------------------------------------------------ debug
    if (import.meta.env.DEV) {
      const { DebugOverlay } = await import("./debug");
      const debug = new DebugOverlay({
        app,
        viewport,
        director,
        audio,
        substitutions: assets.substituted,
      });
      cleanupFns.push(() => debug.dispose());
      debugState.zoneHook = (name: string) => debug.zone(name);
    }

    setProgress(1, "");
    hideLoading();
    if (announcer) {
      announcer.textContent =
        "The Bureau is open. Drag to explore; click an area to learn about it.";
    }

    // -------------------------------------------------------- entrance
    if (!reducedMotion) {
      world.entrance({
        onLights: () => {
          for (const agent of ctx.agents)
            gsap.to(agent.container, { alpha: 1, duration: 0.5, overwrite: false });
        },
        onChannels: () => bridge.pulse(),
        onObservatory: () => observatory.wake(),
        onCrate: () => director.force("gauntlet.cycle"),
        onSign: () => world.testnetFlash(),
      });
    } else {
      for (const agent of ctx.agents) agent.container.alpha = 1;
    }
    if (isPhone) camera.focusZone("tribunal");
  })();

  const handle: DioramaHandle = {
    ready,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Clear first and reset timeScale: a freeze in progress must not
      // leak a slowed global timeline into the next page load.
      gsap.set(gsap.globalTimeline, { timeScale: 1 });
      gsap.globalTimeline.clear();
      for (const cleanup of cleanupFns) {
        try {
          cleanup();
        } catch {
          /* teardown continues even if one resource objects */
        }
      }
      delete (window as unknown as Record<string, unknown>).__diorama;
    },
  };

  ready.catch(() => fail());

  (window as unknown as Record<string, unknown>).__diorama = {
    ready,
    fps: () => stats.fps,
    camera: () => ({ ...stats.camera }),
    // DEV probe for capture-side geometry guards (feet points, poses).
    agents: () => (agentsProbe ? agentsProbe() : []),
    zone: (name: string) =>
      debugState.zoneHook ? debugState.zoneHook(name) : "debug disabled outside DEV",
    teardown: handle.dispose,
    /**
     * DEV-only A/B/C comparison toggle for the capture suite:
     * "plate" = plate only, "actors" = plate+cast+props (no dome),
     * "full" = the complete composite.
     */
    setLayers: (mode: "plate" | "actors" | "full") => {
      if (layerToggle) return layerToggle(mode);
      return "unavailable";
    },
  };

  return handle;
}
