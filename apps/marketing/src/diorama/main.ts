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
import { clearRegistry, allStations, stationApi } from "./core/registry.js";
import { clearSigns } from "./core/signs.js";
import type { StationId } from "./config/stations.js";
import type { FocusTarget } from "./systems/rails.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./config/world.js";

// Lazy tween initialization defers a tween's first read of its target to a
// later tick. The diorama destroys display objects while their tweens are
// still pending (pool recycling, safeDestroy, route teardown), and a lazily
// initialized tween then reads a destroyed object's nulled scale/position
// ("Cannot read properties of null (reading 'y')"). Initializing eagerly is
// the same work done sooner, with no race.
gsap.defaults({ lazy: false });

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
  // A previous destroy() in this module context paused the global timeline;
  // re-play so a client-routed revisit is never frozen.
  gsap.globalTimeline.play();
  // Fonts are settled by the route page before this module is imported, so
  // there is no font wait here.

  // Quality heuristic runs before renderer creation so low mode actually
  // reduces work: no antialias and a tighter resolution cap.
  const dpr = window.devicePixelRatio || 1;
  const rect0 = host.getBoundingClientRect();
  const busyScreen = dpr * Math.max(rect0.width, 1) * Math.max(rect0.height, 1) > 6_000_000;
  const cores = navigator.hardwareConcurrency ?? 8;
  const quality: "high" | "low" = cores <= 4 || busyScreen ? "low" : "high";

  const app = new Application();
  await app.init({
    background: BG_COLOR,
    antialias: quality === "high",
    resolution: Math.min(dpr, quality === "high" ? 2 : 1.5),
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

  const ctx: DioramaContext = {
    app,
    layers,
    reducedMotion,
    quality,
    onTick,
    onCleanup,
    screenSize: { w: screenW, h: screenH },
  };

  // Debug/inspection hook for the environment owner's capture harness. Never
  // used by the page itself; harmless in production.
  let directorRef: import("./systems/director.js").Director | null = null;
  let agentsRef: import("./agents/system.js").AgentSystem | undefined;
  let simulationRef: import("./systems/simulation.js").Simulation | undefined;

  /**
   * Full teardown: unregisters listeners/tickers/cleanups recorded so far and
   * destroys the renderer. Shared by runtime.destroy() and the bootstrap
   * failure path below, so a throw mid-build never leaves a half-constructed
   * canvas bolted to the host.
   */
  const teardown = (): void => {
    // Stop the scheduler first so in-flight stories unwind while the world
    // still exists; pending waits are cancelled by stop() itself.
    directorRef?.stop();
    directorRef = null;
    // Kill every tween BEFORE any display object is destroyed: Pixi v8
    // destroy() nulls _position/_scale, and any tween that renders against
    // a half-destroyed tree throws "Cannot read properties of null". Pause
    // first so nothing can render mid-clear; no cleanup needs live tweens.
    gsap.globalTimeline.pause();
    gsap.globalTimeline.clear();
    for (const unregister of [...ticks]) unregister();
    ticks.clear();
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch (e) {
        warn("cleanup", e);
      }
    }
    clearRegistry();
    clearSigns();
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
  };

  // Everything below can throw (dynamic imports, builders). On failure, tear
  // down whatever was registered so the host is left clean; initDiorama logs.
  try {
    // Camera owns the viewport; handed to subsystems through this closure.
    const camera: Camera = createCamera({ app, viewport, host });

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
      // Read-only api accessor for the QA harnesses (dispatch checks).
      stationApi: (id: string) => stationApi(id as Parameters<typeof stationApi>[0]),
      app: () => app,
      activity(): object {
        return (
          directorRef?.activity() ?? {
            stories: [],
            moving: 0,
            reacting: 0,
            total: 0,
            districts: {},
          }
        );
      },
      agents: () => agentsRef,
      director: () => directorRef,
      simulation: () => simulationRef,
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

    // Host-driven resize keeps ctx.screenSize truthful. The camera owns the
    // viewport resize (it performs viewport.resize itself, re-derives clamp
    // bounds, and re-applies default framing when the user has not
    // interacted), so this observer must NOT call viewport.resize first or
    // the camera's no-op comparison would silently skip the refit.
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      ctx.screenSize.w = width;
      ctx.screenSize.h = height;
      camera.resize(width, height);
    });
    resizeObserver.observe(host);
    onCleanup(() => resizeObserver.disconnect());

    // World builders. Each is independent; a failing builder leaves the rest
    // of the room standing. Modules load in parallel (dev serves each
    // separately; serial awaits tripled cold-boot time), then build in order.
    // world/hyperliquid.ts now builds the docked exchange port, invoked from
    // stations/central.ts; the old perimeter module is retired with the campus.
    const [
      { buildBackdrop },
      { buildGround },
      { buildWalls },
      { buildSeam },
      { buildMarketLandscape },
      { buildResearchDistrict },
      { buildCentralDistrict },
      { buildMcpDistrict },
      { buildRiskDistrict },
      { buildOpsDistrict },
    ] = await Promise.all([
      import("./world/backdrop.js"),
      import("./world/ground.js"),
      import("./world/walls.js"),
      import("./world/seam.js"),
      import("./world/marketLandscape.js"),
      import("./stations/research.js"),
      import("./stations/central.js"),
      import("./stations/mcp.js"),
      import("./stations/risk.js"),
      import("./stations/ops.js"),
    ]);
    guard("backdrop", () => buildBackdrop(ctx));
    guard("ground", () => buildGround(ctx));
    guard("walls", () => buildWalls(ctx));
    guard("seam", () => buildSeam(ctx));
    guard("marketLandscape", () => buildMarketLandscape(ctx));
    guard("researchDistrict", () => buildResearchDistrict(ctx));
    guard("centralDistrict", () => buildCentralDistrict(ctx));
    guard("mcpDistrict", () => buildMcpDistrict(ctx));
    guard("riskDistrict", () => buildRiskDistrict(ctx));
    guard("opsDistrict", () => buildOpsDistrict(ctx));

    // Floor mascot: the duo-themed herald on its pad south of the holo.
    guard("mascot", () => {
      void import("./agents/mascot.js")
        .then(({ buildMascot, mascot }) => {
          mascot.api = buildMascot(ctx, { x: 1435, y: 965 });
          onCleanup(() => {
            mascot.api = null;
          });
        })
        .catch((e: unknown) => warn("mascot", e));
    });

    // Systems (parallel module load, ordered creation: the director needs the
    // other three).
    const [
      { createRailSystem },
      { createPopulation },
      { createSimulation },
      { createDirector },
      { createAudio, registerSpatialResolver, registerSourceHook },
    ] = await Promise.all([
      import("./systems/rails.js"),
      import("./agents/system.js"),
      import("./systems/simulation.js"),
      import("./systems/director.js"),
      import("./audio.js"),
    ]);
    let rails: import("./systems/rails.js").RailSystem | undefined;
    guard("rails", () => {
      rails = createRailSystem(ctx);
    });

    let agents: import("./agents/system.js").AgentSystem | undefined;
    guard("population", () => {
      agents = createPopulation(ctx);
      agentsRef = agents;
    });

    let simulation: import("./systems/simulation.js").Simulation | undefined;
    guard("simulation", () => {
      simulation = createSimulation(ctx);
      simulationRef = simulation;
    });

    guard("director", () => {
      if (agents && rails && simulation) {
        const director = createDirector(ctx, { agents, rails, simulation });
        directorRef = director;
        // Any lane can run a card's station story (the texture pool overlaps
        // station stories), so the card's busy button listens for settles
        // instead of owning only its own launch promises.
        const offStorySettle = director.onStorySettle(() => infoCard?.refreshActionState());
        onCleanup(offStorySettle);
        director.start();
      }
    });

    let audio: import("./audio.js").AudioController | undefined;
    guard("audio", () => {
      audio = createAudio();
      // Spatial sound: pan from the emitter's screen x, volume from its
      // distance to the viewport center. Registered against the live camera
      // so focus and resize stay truthful without audio knowing about Pixi.
      registerSpatialResolver((world) => {
        const s = camera.worldToScreen(world);
        const w = Math.max(ctx.screenSize.w, 1);
        const h = Math.max(ctx.screenSize.h, 1);
        const pan = Math.max(-1, Math.min(1, (s.x / w) * 2 - 1));
        const reach = Math.hypot(w, h) / 2;
        const falloff = (Math.hypot(s.x - w / 2, s.y - h / 2) / reach) * 0.75;
        return { pan, volume: Math.max(0.25, Math.min(1, 1 - falloff)) };
      });
      onCleanup(() => {
        audio?.destroy();
        audio = undefined;
        registerSpatialResolver(null);
      });
    });

    // True while the station's story is running (Director.isRunning); used by
    // the info card's action button and interaction's retry guard.
    const isStoryActive = (storyId: string): boolean => directorRef?.isRunning(storyId) ?? false;

    // DOM UI. Info card + HUD live in the page host. Both instances own DOM and
    // listeners without a ctx, so their destroy is registered right here.
    let clearDioramaSelection: () => void = (): void => {};
    const [
      { createInfoCard },
      { createHud },
      { buildDistrictBanners },
      { buildA11y },
      interactionModule,
      { createSourceCues },
    ] = await Promise.all([
      import("./ui/infoCard.js"),
      import("./ui/hud.js"),
      import("./ui/labels.js"),
      import("./ui/a11y.js"),
      import("./ui/interaction.js"),
      import("./ui/sourceCues.js"),
    ]);
    let infoCard: import("./ui/infoCard.js").InfoCard | undefined;
    guard("infoCard", () => {
      const cardRoot = host.querySelector<HTMLElement>("[data-diorama-card]");
      if (cardRoot) {
        infoCard = createInfoCard(cardRoot, {
          onAction: (storyId: string) => {
            void directorRef?.runStory(storyId);
          },
          // The card is created before interaction assigns clearSelection, so
          // route through the live variable, not its initial empty value.
          onClose: () => clearDioramaSelection(),
          isStoryActive,
          isStationBusy: (stationId: string) =>
            directorRef?.isStationBusy(stationId as StationId) ?? false,
        });
        onCleanup(() => {
          infoCard?.destroy();
          infoCard = undefined;
        });
      }
    });

    let hud: import("./ui/hud.js").Hud | undefined;
    guard("hud", () => {
      const hudRoot = host.querySelector<HTMLElement>("[data-diorama-hud]");
      if (hudRoot) {
        hud = createHud(hudRoot, {
          onResetView: () => {
            camera.resetView();
            clearDioramaSelection();
          },
          onToggleSound: (next: boolean) => audio?.setEnabled(next),
        });
        onCleanup(() => {
          hud?.destroy();
          hud = undefined;
        });
      }
    });

    guard("districtBanners", () => buildDistrictBanners(ctx));

    guard("a11y", () => {
      buildA11y(ctx);
    });

    // Visual sound-source pulses: same world point the audio layer accepted
    // a cue for, so sight and sound always agree on the emitter.
    guard("sourceCues", () => {
      const sourceCues = createSourceCues(ctx);
      registerSourceHook((world, cue) => sourceCues.pulse(world, cue));
      onCleanup(() => registerSourceHook(null));
    });

    guard("interaction", () => {
      if (infoCard) {
        interactionModule.createInteraction(ctx, {
          camera,
          infoCard,
          onRunStory: (storyId: string) => {
            void directorRef?.runStory(storyId);
          },
          // Selection identity (not just focus on/off) drives the rails'
          // incident-route reveal; Escape/backdrop/reset report null. The
          // Hyperliquid platform is a legal focus target (external routes).
          onSelectionChange: (stationId: string | null) => {
            rails?.setFocusStation(stationId as FocusTarget);
          },
          isStoryActive,
        });
        clearDioramaSelection = interactionModule.clearSelection;
      }
    });

    runtime = {
      ctx,
      camera,
      destroy(): void {
        if (!runtime) return;
        runtime = null;
        teardown();
      },
    };
  } catch (e) {
    teardown();
    throw e;
  }
}

export function destroyDiorama(): void {
  runtime?.destroy();
}
