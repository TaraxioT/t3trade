/**
 * Diorama bootstrap: builds the Pixi application, camera, and the defensive
 * subsystem chain. Every subsystem is wired in its own try/catch so the page
 * renders correctly at every intermediate implementation state (typed stubs
 * included) and a failure logs instead of blanking the canvas.
 *
 * Owner: skeleton worker.
 */
import gsap from "gsap";
import { Application, Container } from "pixi.js";
import { Viewport } from "pixi-viewport";
import { createCamera, type Camera } from "./core/camera.js";
import type { CleanupFn, DioramaContext } from "./core/context.js";
import { clearRegistry, allStations } from "./core/registry.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./config/world.js";

const BG_COLOR = 0x07111f;

/** One live diorama instance; null when destroyed. */
interface DioramaRuntime {
  ctx: DioramaContext;
  camera: Camera;
  destroy(): void;
}

let runtime: DioramaRuntime | null = null;
let initing = false;

const warn = (name: string, e: unknown): void => {
  console.warn(`[diorama] ${name} failed`, e);
};

/** Run a subsystem, logging instead of throwing when a stub/module fails. */
function guard(name: string, fn: () => void | Promise<void>): void {
  try {
    void fn();
  } catch (e) {
    warn(name, e);
  }
}

export async function initDiorama(host: HTMLElement): Promise<void> {
  if (runtime || initing) return;
  initing = true;
  try {
    await build(host);
  } catch (e) {
    warn("bootstrap", e);
  } finally {
    initing = false;
  }
}

async function build(host: HTMLElement): Promise<void> {
  await document.fonts.ready;

  const app = new Application();
  await app.init({
    background: BG_COLOR,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    resizeTo: host,
  });
  host.appendChild(app.canvas);

  const rect = host.getBoundingClientRect();
  const screenW = Math.max(rect.width, 1);
  const screenH = Math.max(rect.height, 1);

  const viewport = new Viewport({
    screenWidth: screenW,
    screenHeight: screenH,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    events: app.renderer.events,
    // Non-passive wheel so zooming over the canvas never scrolls the page
    // underneath (the sticky nav would then cover the HUD buttons).
    passiveWheel: false,
  });
  viewport.drag({ clampWheel: true }).pinch().wheel({ smooth: 6 }).decelerate();
  app.stage.addChild(viewport);

  // Fixed layer stack: order defines paint order inside viewport.world.
  const layers = {
    backdrop: new Container(),
    ground: new Container(),
    sortable: new Container(),
    labels: new Container(),
    overlay: new Container(),
  };
  layers.sortable.sortableChildren = true;
  for (const layer of Object.values(layers)) viewport.addChild(layer);

  const cleanups: CleanupFn[] = [];
  const ticks = new Set<ReturnType<DioramaContext["onTick"]>>();
  const onTick: DioramaContext["onTick"] = (fn) => {
    app.ticker.add(fn);
    const unregister = () => {
      app.ticker.remove(fn);
      ticks.delete(unregister);
    };
    ticks.add(unregister);
    return unregister;
  };
  const onCleanup: DioramaContext["onCleanup"] = (fn) => {
    cleanups.push(fn);
  };

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dpr = window.devicePixelRatio || 1;
  const busyScreen = dpr * screenW * screenH > 6_000_000;
  const cores = navigator.hardwareConcurrency ?? 8;
  const quality: "high" | "low" = cores <= 4 || busyScreen ? "low" : "high";

  const ctx: DioramaContext = {
    app,
    layers,
    reducedMotion,
    quality,
    onTick,
    onCleanup,
    screenSize: { w: screenW, h: screenH },
  };

  // Camera owns the viewport; handed to subsystems through this closure.
  let camera: Camera = createCamera({ app, viewport, host });

  // Debug/inspection hook for the environment owner's capture harness. Never
  // used by the page itself; harmless in production.
  (window as unknown as { __dioramaDebug?: object }).__dioramaDebug = {
    focus(x: number, y: number, zoom?: number): void {
      camera.focusOn({ x, y }, zoom);
    },
    camera: () => camera,
    reset(): void {
      camera.resetView();
    },
    gsap: () => gsap,
    viewport: () => viewport,
    stations: () => allStations(),
    app: () => app,
  };
  onCleanup(() => {
    delete (window as unknown as { __dioramaDebug?: object }).__dioramaDebug;
  });

  // Pause rendering and tweens while the tab is hidden.
  const onVisibility = (): void => {
    if (document.hidden) {
      app.ticker.stop();
      gsap.globalTimeline.pause();
    } else {
      app.ticker.start();
      gsap.globalTimeline.play();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));

  // Host-driven resize keeps the viewport and ctx.screenSize truthful. The
  // camera only re-fits when the user has not interacted.
  const resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width <= 0 || height <= 0) return;
    viewport.resize(width, height);
    ctx.screenSize.w = width;
    ctx.screenSize.h = height;
    camera.resize(width, height);
  });
  resizeObserver.observe(host);
  onCleanup(() => resizeObserver.disconnect());

  // World builders. Each is independent; a failing builder leaves the rest
  // of the campus standing.
  const { buildBackdrop } = await import("./world/backdrop.js");
  guard("backdrop", () => buildBackdrop(ctx));
  const { buildGround } = await import("./world/ground.js");
  guard("ground", () => buildGround(ctx));
  const { buildPerimeter } = await import("./world/perimeter.js");
  guard("perimeter", () => buildPerimeter(ctx));
  const { buildMarketLandscape } = await import("./world/marketLandscape.js");
  guard("marketLandscape", () => buildMarketLandscape(ctx));
  const { buildHyperliquid } = await import("./world/hyperliquid.js");
  guard("hyperliquid", () => buildHyperliquid(ctx));
  const { buildResearchDistrict } = await import("./stations/research.js");
  guard("researchDistrict", () => buildResearchDistrict(ctx));
  const { buildCentralDistrict } = await import("./stations/central.js");
  guard("centralDistrict", () => buildCentralDistrict(ctx));
  const { buildMcpDistrict } = await import("./stations/mcp.js");
  guard("mcpDistrict", () => buildMcpDistrict(ctx));
  const { buildRiskDistrict } = await import("./stations/risk.js");
  guard("riskDistrict", () => buildRiskDistrict(ctx));
  const { buildOpsDistrict } = await import("./stations/ops.js");
  guard("opsDistrict", () => buildOpsDistrict(ctx));

  // Systems.
  const { createRailSystem } = await import("./systems/rails.js");
  let rails: import("./systems/rails.js").RailSystem | undefined;
  guard("rails", () => {
    rails = createRailSystem(ctx);
  });

  const { createPopulation } = await import("./agents/system.js");
  let agents: import("./agents/system.js").AgentSystem | undefined;
  guard("population", () => {
    agents = createPopulation(ctx);
  });

  const { createSimulation } = await import("./systems/simulation.js");
  let simulation: import("./systems/simulation.js").Simulation | undefined;
  guard("simulation", () => {
    simulation = createSimulation(ctx);
  });

  const { createDirector } = await import("./systems/director.js");
  guard("director", () => {
    if (agents && rails && simulation) {
      const director = createDirector(ctx, { agents, rails, simulation });
      director.start();
    }
  });

  const { createAudio } = await import("./audio.js");
  let audio: import("./audio.js").AudioController | undefined;
  guard("audio", () => {
    audio = createAudio();
  });

  // DOM UI. Info card + HUD live in the page host.
  const { createInfoCard } = await import("./ui/infoCard.js");
  let infoCard: import("./ui/infoCard.js").InfoCard | undefined;
  guard("infoCard", () => {
    const cardRoot = host.querySelector<HTMLElement>("[data-diorama-card]");
    if (cardRoot) infoCard = createInfoCard(cardRoot);
  });

  const { createHud } = await import("./ui/hud.js");
  guard("hud", () => {
    const hudRoot = host.querySelector<HTMLElement>("[data-diorama-hud]");
    if (hudRoot) {
      createHud(hudRoot, {
        onResetView: () => camera.resetView(),
        onToggleSound: () => audio?.setEnabled(true),
      });
    }
  });

  const { buildDistrictBanners } = await import("./ui/labels.js");
  guard("districtBanners", () => buildDistrictBanners(ctx));

  const { buildA11y } = await import("./ui/a11y.js");
  guard("a11y", () => {
    buildA11y(ctx, {
      onFocus: (id) => {
        void id;
        // Station focus wiring lands with the interaction layer; a11y
        // keyboard focus still routes through the camera.
      },
    });
  });

  const { createInteraction } = await import("./ui/interaction.js");
  guard("interaction", () => {
    if (infoCard) createInteraction(ctx, { camera, infoCard });
  });

  runtime = {
    ctx,
    camera,
    destroy(): void {
      if (!runtime) return;
      runtime = null;
      for (const unregister of [...ticks]) unregister();
      ticks.clear();
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch (e) {
          warn("cleanup", e);
        }
      }
      gsap.globalTimeline.clear();
      clearRegistry();
      try {
        viewport.destroy({ children: true, texture: false });
      } catch (e) {
        warn("viewport destroy", e);
      }
      try {
        app.destroy(true, { children: true, texture: false });
      } catch (e) {
        warn("app destroy", e);
      }
    },
  };
}

export function destroyDiorama(): void {
  runtime?.destroy();
}
