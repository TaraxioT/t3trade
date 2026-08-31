/**
 * Runtime assembly and lifecycle for the /diorama route (plan sections 5,
 * 8, 9, 11). Owns the staged build, the absolute logical clock, the render
 * loop, suspension arbitration, cue dispatch (audio + particles), the
 * candle/ticker wiring gap the director cannot close, and full teardown.
 * Exported contract: stage element in, disposer out.
 */

import * as THREE from "three";
import { BEAT_STARTS, DURATION_MS, PALETTE } from "./config";
import { createUi } from "./ui";
import { createInstrumentation, type HookControllers } from "./instrumentation";
import { createAudio, isAudioCue } from "./audio";
import { createEffects, isEffectId, type EffectSystem } from "./particles";
import { createDirector } from "./story/director";
import { candleFactor } from "./story/beats";
import { createFleet } from "./bots/fleet";
import { createWorld, worldPracticals } from "./world";
import { createGlyphRenderer, type GlyphRenderer } from "./world/glyphs";
import { loadPropLibrary, type PropLibrary } from "./world/propLibrary";
import { createSignAtlas, type SignAtlas } from "./render/signAtlas";
import { createRenderer, type RendererHandle } from "./render/renderer";
import { createCamera, type CameraHandle } from "./render/camera";
import { createLights, type LightsHandle } from "./render/lights";
import { createMaterials, type MaterialLibrary } from "./render/materials";
import { createResourceRegistry } from "./render/resources";
import type { BeatId, FiredCue, LifecycleState, WorldSnapshot, XYZ } from "./types";

const SEEK_THRESHOLD_MS = 2000;
/** A suspended rAF gap counts as at most one normal frame, never a seek. */
const MAX_FRAME_DELTA_MS = 250;
/** Middle of the celebration beat; the reduced-motion static frame. */
const STATIC_TIME_MS = 75000;

/** Asset bundle handed to createWorld (R3); all-or-nothing at boot. */
interface WorldAssets {
  readonly props: PropLibrary;
  readonly signs: SignAtlas;
}
/**
 * createWorld's optional third argument is landing with the world owner;
 * a 2-arg function is assignable to this wider signature, so the call is
 * type-safe now and exact once `assets?` exists.
 */
const createWorldWithAssets: (
  mats: MaterialLibrary,
  registry: ReturnType<typeof createResourceRegistry>,
  assets?: WorldAssets,
) => ReturnType<typeof createWorld> = createWorld;

export function startDiorama(stage: HTMLElement): () => void {
  const registry = createResourceRegistry();
  const ui = createUi();
  const instrumentation = createInstrumentation();
  const audio = createAudio();

  // ---- Lifecycle state (main.ts is the sole arbiter) -----------------------
  let lifecycle: LifecycleState = "loading";
  let timeMs = 0;
  let manualPause = false;
  let pageVisible = true;
  let intersecting = true;
  let disposed = false;
  let failed = false;
  /** True once the staged boot reached ready; failure before this cleans up. */
  let bootDone = false;

  // Subsystem handles; filled in during staged assembly.
  let rendererHandle: RendererHandle | null = null;
  let cameraHandle: CameraHandle | null = null;
  let lights: LightsHandle | null = null;
  let mats: Readonly<MaterialLibrary> | null = null;
  let effects: EffectSystem | null = null;
  let glyphs: GlyphRenderer | null = null;
  let director: ReturnType<typeof createDirector> | null = null;
  let candles: THREE.Object3D[] = [];
  let tape: THREE.Object3D | null = null;
  let tapeRed: THREE.Mesh | null = null;

  let readyResolve: () => void = () => undefined;
  let readyReject: (reason: string) => void = () => undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Keep the rejected promise observable for the hook without an unhandled
  // rejection warning when no test happens to be awaiting it.
  readyPromise.catch(() => undefined);

  const scene = new THREE.Scene();

  const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

  // ---- Failure path --------------------------------------------------------
  const fail = (reason: string): void => {
    if (failed || disposed) return;
    failed = true;
    lifecycle = "failed";
    instrumentation.markFailed(reason);
    instrumentation.setLifecycle(lifecycle);
    ui.setFailed(reason);
    if (rendererHandle) rendererHandle.renderer.setAnimationLoop(null);
    audio.stopAll();
    if (!bootDone) {
      // Failed mid-boot (constructor or context-lost during staging):
      // release whatever partial GPU state exists, but keep the permanent
      // failure UI. The boot sequence aborts on `failed` between stages.
      unbindPointer?.();
      rendererHandle?.dispose();
      registry.disposeAll();
      for (const child of [...stage.querySelectorAll("canvas")]) child.remove();
    }
    readyReject(reason);
  };

  // ---- Frame composition ---------------------------------------------------
  const composeFrame = (): void => {
    if (!rendererHandle || !cameraHandle || !director || disposed) return;
    const w = stage.clientWidth || 1;
    const h = stage.clientHeight || 1;
    const fit = cameraHandle.fitCameraToStage(w, h);
    lastFit = fit;
    cameraHandle.evaluateCamera(timeMs, fit);
    lights?.setNightMood(director.moodAt(timeMs));
    applyCandlesAndTape(timeMs);
    const renderer = rendererHandle.renderer;
    renderer.render(scene, cameraHandle.camera);
    effects?.setViewport(
      renderer.domElement.height,
      cameraHandle.camera.top - cameraHandle.camera.bottom,
    );
    const info = renderer.info;
    instrumentation.recordFrame(frameDeltaMs, {
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
    });
  };

  /** Machine channels the director computes but cannot reach (M06 gap). */
  const applyCandlesAndTape = (t: number): void => {
    if (!director) return;
    for (let i = 0; i < candles.length; i += 1) {
      const candle = candles[i];
      if (candle) candle.scale.y = candleFactor(i, t);
    }
    if (tape && tapeRed && mats) {
      // tapeScroll already drives tape.position.x through the director.
      const m = director.machine;
      tape.visible = m.tapeFlicker === 0 || m.tapeFlicker > 0.5;
      tapeRed.material = m.tapeGreen > 0.5 ? mats.dataGreen : mats.dataRed;
    }
  };

  // ---- Cue dispatch --------------------------------------------------------
  const dispatchCues = (cues: readonly FiredCue[]): void => {
    for (const cue of cues) {
      const name = cue.cueId as string;
      if (isAudioCue(name)) audio.play(cue.cueId);
      const detail = cue.detail;
      if (!detail || typeof detail.effect !== "string" || !isEffectId(detail.effect)) continue;
      const origin: XYZ = {
        x: typeof detail.x === "number" ? detail.x : 0,
        y: typeof detail.y === "number" ? detail.y : 0,
        z: typeof detail.z === "number" ? detail.z : 0,
      };
      effects?.spawn(detail.effect, origin, {
        triggerMs: cue.timeMs,
        variant:
          detail.variant === "reject"
            ? "reject"
            : detail.variant === "approve"
              ? "approve"
              : undefined,
        instance: typeof detail.instance === "number" ? detail.instance : undefined,
      });
    }
  };

  // ---- Loop ----------------------------------------------------------------
  let frameDeltaMs = 16;
  let lastWallMs = 0;
  /** Camera/snapshot bookkeeping owned by main.ts (review extras). */
  let lastFit = 0;
  let pointerX = 0;
  let pointerY = 0;

  const tick = (): void => {
    const now = performance.now();
    if (lastWallMs > 0) frameDeltaMs = now - lastWallMs;
    lastWallMs = now;
    // Clamp: a backgrounded tab resumes with one huge dt; the story must not
    // fast-forward. Absolute-time evaluation keeps this a pure clock choice.
    if (frameDeltaMs > MAX_FRAME_DELTA_MS) frameDeltaMs = MAX_FRAME_DELTA_MS;
    if (!director) return;
    const prev = timeMs;
    timeMs += frameDeltaMs;
    const jumped = timeMs - prev > SEEK_THRESHOLD_MS;
    if (jumped) {
      // A stalled frame (throttled tab, breakpoint) is a seek: apply state,
      // never replay the cues the clock skipped.
      director.setSilent(true);
      director.evaluate(timeMs);
      director.setSilent(false);
    } else {
      director.evaluate(timeMs);
      dispatchCues(director.collectCrossings(prev, timeMs));
    }
    glyphs?.update();
    effects?.update(timeMs);
    composeFrame();
  };

  const canRun = (): boolean =>
    !disposed &&
    !failed &&
    !manualPause &&
    pageVisible &&
    intersecting &&
    !ui.reducedMotion() &&
    (lifecycle === "ready" ||
      lifecycle === "playing" ||
      lifecycle === "paused" ||
      lifecycle === "static");

  const updateLoop = (): boolean => {
    if (!rendererHandle) return false;
    const run = canRun();
    if (run) {
      lifecycle = "playing";
      lastWallMs = 0;
      rendererHandle.renderer.setAnimationLoop(tick);
    } else {
      if (lifecycle === "playing") lifecycle = ui.reducedMotion() ? "static" : "paused";
      rendererHandle.renderer.setAnimationLoop(null);
      audio.stopAll();
    }
    instrumentation.setLifecycle(lifecycle);
    instrumentation.setPlaying(run);
    ui.setPaused(!run);
    return run;
  };

  /** Single resume/pause path shared by the button and the hook. */
  const resume = (): void => {
    if (disposed || failed) return;
    manualPause = false;
    if (updateLoop()) ui.announce("Resumed.");
  };

  const pause = (): void => {
    if (disposed || failed) return;
    manualPause = true;
    updateLoop();
    ui.announce("Paused.");
  };

  const evaluateSilent = (t: number): void => {
    if (!director) return;
    timeMs = t;
    director.setSilent(true);
    director.evaluate(t);
    director.setSilent(false);
    glyphs?.update();
    effects?.update(t);
    composeFrame();
  };

  const seek = (t: number): void => {
    if (disposed || failed) return;
    manualPause = true;
    updateLoop();
    evaluateSilent(((t % DURATION_MS) + DURATION_MS) % DURATION_MS);
  };

  const beatWindow = (index: number): number => {
    const start = BEAT_STARTS[index]?.startMs ?? 0;
    const next = BEAT_STARTS[index + 1]?.startMs ?? DURATION_MS;
    return Math.max(next - start, 1);
  };

  const jumpToBeat = (id: BeatId, offsetMs = 0): void => {
    const index = BEAT_STARTS.findIndex((b) => b.id === id);
    if (index < 0) return;
    const start = BEAT_STARTS[index]?.startMs ?? 0;
    const clamped = Math.min(Math.max(offsetMs, 0), beatWindow(index) - 1);
    seek(start + clamped);
  };

  const step = (deltaMs: number): void => {
    if (disposed || failed || manualPause !== true) return;
    evaluateSilent(timeMs + deltaMs);
  };

  const renderStatic = (beatId?: BeatId): void => {
    if (disposed || failed) return;
    manualPause = true;
    updateLoop();
    const id = beatId ?? BEAT_STARTS.find((b) => b.id === "celebration")?.id ?? BEAT_STARTS[0]?.id;
    if (id) jumpToBeat(id);
  };

  const setSound = async (enabled: boolean): Promise<boolean> => {
    const result = await audio.setEnabled(enabled);
    if (!disposed && !failed) {
      // `result` is operation success, not state: the label reflects the
      // requested state only when the toggle succeeded.
      const effective = result && enabled;
      ui.setSoundEnabled(effective);
      instrumentation.setSound(effective);
    }
    return result;
  };

  // ---- Hook + instrumentation ---------------------------------------------
  /** WorldSnapshot plus the review-flagged extras main.ts owns cheaply. */
  interface MainSnapshot extends WorldSnapshot {
    readonly visible: boolean;
    readonly intersecting: boolean;
    readonly responsiveFit: number;
    readonly pointerParallax: XYZ;
  }

  const snapshotSupplier = (): MainSnapshot => {
    const base = director ? director.snapshot() : null;
    const cam = cameraHandle?.camera;
    return {
      version: 1,
      lifecycle,
      timeMs,
      loopCount: Math.floor(timeMs / DURATION_MS),
      beatId: (base?.beatId ?? BEAT_STARTS[0]?.id ?? "shift_start") as BeatId,
      playing: lifecycle === "playing",
      reducedMotion: ui.reducedMotion(),
      soundEnabled: audio.isEnabled(),
      camera: {
        position: cam
          ? { x: cam.position.x, y: cam.position.y, z: cam.position.z }
          : (base?.camera.position ?? { x: 0, y: 0, z: 0 }),
        target: base?.camera.target ?? { x: 0, y: 0, z: 0 },
        zoom: cam ? cam.zoom : (base?.camera.zoom ?? 1),
      },
      actors: base?.actors ?? [],
      props: base?.props ?? [],
      // Sol review gaps: visibility/intersection flags and the camera values
      // main.ts tracks (fit + last pointer parallax offset).
      visible: pageVisible,
      intersecting,
      responsiveFit: lastFit,
      pointerParallax: { x: pointerX, y: pointerY, z: 0 },
    };
  };

  const rendererInfoSupplier = () => {
    const r = rendererHandle?.renderer;
    const info = r?.info;
    return {
      dpr: rendererHandle?.dpr ?? 1,
      width: r ? r.domElement.width : 0,
      height: r ? r.domElement.height : 0,
      calls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      points: info?.render.points ?? 0,
      lines: info?.render.lines ?? 0,
      geometries: info?.memory.geometries ?? 0,
      textures: info?.memory.textures ?? 0,
    };
  };

  // ---- Teardown (idempotent; shared by the disposer and hook.dispose) ------
  let teardownOnce = false;
  const teardown = (): void => {
    if (teardownOnce) return;
    teardownOnce = true;
    disposed = true;
    if (rendererHandle) rendererHandle.renderer.setAnimationLoop(null);
    unbindUi?.();
    unbindReduced?.();
    unbindPointer?.();
    intersectionObserver?.disconnect();
    stageObserver?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    stage.removeEventListener("pointerleave", onPointerLeave);
    audio.dispose();
    ui.dispose();
    director?.dispose(); // director-owned transient props (the PAUSE hand)
    // R4: hide every glyph slot before GPU disposal (no clear() on the API).
    if (glyphs) for (let i = 0; i < glyphs.slotCount; i += 1) glyphs.hide(i);
    effects?.clear();
    rendererHandle?.dispose();
    const gl = rendererHandle?.renderer;
    registry.disposeAll(); // disposes tracked materials/geometries/renderer
    // Plan section 8: force context loss during final teardown if supported.
    gl?.forceContextLoss();
    for (const child of [...stage.querySelectorAll("canvas")]) child.remove();
    lifecycle = "disposed";
    instrumentation.setLifecycle(lifecycle);
    instrumentation.setPlaying(false);
  };

  const controllers: HookControllers = {
    play: resume,
    pause,
    seek,
    jumpToBeat,
    step,
    setSound,
    renderStatic,
    dispose: teardown,
    readyPromise,
    snapshotSupplier,
    rendererInfoSupplier,
  };

  let unbindUi: (() => void) | null = null;
  let unbindReduced: (() => void) | null = null;
  let unbindPointer: (() => void) | null = null;
  let intersectionObserver: IntersectionObserver | null = null;
  let stageObserver: ResizeObserver | null = null;

  const onVisibility = (): void => {
    pageVisible = document.visibilityState === "visible";
    instrumentation.setVisibility(pageVisible, intersecting);
    updateLoop();
  };

  const onPointerLeave = (): void => {
    pointerX = 0;
    pointerY = 0;
    cameraHandle?.setPointerParallax(0, 0);
  };

  const boot = async (): Promise<void> => {
    // Staged assembly; one browser frame between stages, progress after each.
    const progress = (p: number, label: string): void => ui.setLoadingProgress(p, label);
    try {
      progress(0.06, "Preparing resources");
      await nextFrame();
      if (failed || disposed) return; // failure during staging aborts boot
      const library = createMaterials(registry);
      mats = library;
      progress(0.16, "Lighting the bureau");
      await nextFrame();
      if (failed || disposed) return; // failure during staging aborts boot
      rendererHandle = createRenderer(stage, registry, {
        onFailure: (ctx) =>
          fail(
            ctx.phase === "create"
              ? "This experience needs WebGL."
              : "The render context was lost.",
          ),
      });
      scene.background = new THREE.Color(PALETTE.void);
      cameraHandle = createCamera(registry);
      lights = createLights(scene, registry);
      for (const p of worldPracticals()) lights.addPractical(p.position, p.intensity);
      // R3 ASSET phase: prop library + sign atlas in parallel. A total
      // failure of either degrades to a fully procedural world (assets =
      // undefined); a sign-atlas font fallback is NOT a failure.
      progress(0.26, "Loading props and signs");
      let assets: WorldAssets | undefined;
      const [propsSettled, signsSettled] = await Promise.allSettled([
        loadPropLibrary(library, registry),
        createSignAtlas(registry),
      ]);
      if (failed || disposed) return; // failure during staging aborts boot
      if (propsSettled.status === "fulfilled" && signsSettled.status === "fulfilled") {
        assets = { props: propsSettled.value, signs: signsSettled.value };
      } else {
        console.info("[diorama] optional asset loading failed; using procedural props and signs");
      }
      progress(0.34, "Building the floors");
      await nextFrame();
      if (failed || disposed) return; // failure during staging aborts boot
      const world = createWorldWithAssets(library, registry, assets);
      scene.add(world.root as unknown as THREE.Object3D);
      // Collect the machine meshes the director cannot reach (M06 gap).
      const root = world.root as unknown as THREE.Object3D;
      candles = [];
      for (let i = 0; i < 8; i += 1) {
        const c = root.getObjectByName(`c${i}`);
        if (c) candles.push(c);
      }
      const board = root.getObjectByName("tickerBoard");
      tape = board?.getObjectByName("tape") ?? null;
      tapeRed =
        (tape?.children.find(
          (ch) => (ch as THREE.Mesh).material === library.dataRed,
        ) as THREE.Mesh) ?? null;
      progress(0.5, "Hiring the agents");
      await nextFrame();
      if (failed || disposed) return; // failure during staging aborts boot
      const fleet = createFleet(library, {
        propObjects: new Map(
          [...world.props].map(([id, handle]) => [id, handle.object as unknown as THREE.Object3D]),
        ),
        anchorObjects: new Map(
          [...world.anchors].map(([id, obj]) => [id, obj as unknown as THREE.Object3D]),
        ),
      });
      scene.add(fleet.root as unknown as THREE.Object3D);
      progress(0.66, "Loading the effects");
      await nextFrame();
      if (failed || disposed) return; // failure during staging aborts boot
      effects = createEffects(registry);
      const fx: EffectSystem = effects;
      scene.add(fx.group);
      // R4 glyph renderer: built with the effects so expression slots exist
      // before the director takes over; the director drives windows/slots.
      const glyphRenderer = createGlyphRenderer(library, registry);
      glyphs = glyphRenderer;
      scene.add(glyphRenderer.group);
      progress(0.8, "Rehearsing the story");
      await nextFrame();
      if (failed || disposed) return; // failure during staging aborts boot
      director = createDirector(world, fleet, {
        glyphs: glyphRenderer,
        effects: {
          // Arrow-bound: the director only registers R4 beam-flash windows.
          spawn: (effectId, origin, opts) => fx.spawn(effectId, origin, opts),
        },
      });
      progress(0.9, "Composing the first frame");
      await nextFrame();
      if (failed || disposed) return; // failure during staging aborts boot
      lights.renderStaticShadows(rendererHandle.renderer, scene, cameraHandle.camera);

      // UI + controls.
      const unbindPause = ui.bindPause(() => {
        if (manualPause) resume();
        else pause();
      });
      // The click is the required user gesture; a stored "on" preference from
      // a previous session unlocks on this click rather than auto-playing.
      const unbindSound = ui.bindSound(() => {
        void setSound(!audio.isEnabled());
      });
      unbindUi = () => {
        unbindPause();
        unbindSound();
      };

      // Pointer parallax: fine pointers only, never under reduced motion.
      const onPointerMove = (event: PointerEvent): void => {
        if (!cameraHandle || ui.reducedMotion() || ui.pointerPreference() !== "fine") return;
        const rect = stage.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        cameraHandle.setPointerParallax(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          ((event.clientY - rect.top) / rect.height) * 2 - 1,
        );
        pointerX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointerY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
      };
      stage.addEventListener("pointermove", onPointerMove);
      stage.addEventListener("pointerleave", onPointerLeave);
      unbindPointer = () => {
        stage.removeEventListener("pointermove", onPointerMove);
      };

      document.addEventListener("visibilitychange", onVisibility);
      intersectionObserver = new IntersectionObserver(
        (entries) => {
          intersecting = entries[entries.length - 1]?.isIntersecting ?? true;
          instrumentation.setVisibility(pageVisible, intersecting);
          updateLoop();
        },
        { threshold: 0.01 },
      );
      intersectionObserver.observe(stage);

      // While suspended or static the renderer's own ResizeObserver resizes
      // the buffer; repaint the static frame so the canvas never clears.
      stageObserver = new ResizeObserver(() => {
        if (lifecycle !== "playing") requestAnimationFrame(() => composeFrame());
      });
      stageObserver.observe(stage);

      unbindReduced = ui.onReducedMotionChange((reduced) => {
        cameraHandle?.setParallaxEnabled(!reduced && ui.pointerPreference() === "fine");
        if (reduced) {
          manualPause = false; // static is not a user pause
          updateLoop();
          evaluateSilent(STATIC_TIME_MS);
        } else if (!manualPause) {
          updateLoop();
        }
      });

      instrumentation.installHook(controllers);

      // First composed frame, then ready.
      director.evaluate(0);
      glyphs?.update();
      effects.update(0);
      cameraHandle.setParallaxEnabled(!ui.reducedMotion() && ui.pointerPreference() === "fine");
      composeFrame();

      const playingNow = !ui.reducedMotion();
      if (!playingNow) {
        lifecycle = "static";
        evaluateSilent(STATIC_TIME_MS);
        rendererHandle.renderer.setAnimationLoop(null);
        instrumentation.setLifecycle(lifecycle);
        ui.setPaused(true);
      } else {
        lifecycle = "ready";
      }
      ui.setReady();
      ui.setPaused(!playingNow);
      ui.setSoundEnabled(false);
      instrumentation.setSound(false);
      instrumentation.markReady();
      instrumentation.setLifecycle(lifecycle);
      instrumentation.setPlaying(playingNow);
      ui.announce("The bureau is ready.");
      bootDone = true; // failure after this point keeps the assembled scene
      readyResolve();
      updateLoop(); // begin playing unless reduced motion/static holds
    } catch (error) {
      fail(error instanceof Error ? error.message : "The diorama could not start.");
    }
  };

  void boot();

  return teardown;
}
