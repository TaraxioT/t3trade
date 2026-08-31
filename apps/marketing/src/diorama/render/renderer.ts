/**
 * WebGL 2 renderer boundary (M03).
 *
 * Owns renderer creation, color/tone settings, DPR policy, stage-driven
 * resize, context-failure reporting, and teardown through the resource
 * registry. The animation loop itself is driven by main.ts (M09), never here.
 *
 * Shadow-map note (verified against installed three 0.185.1,
 * src/renderers/webgl/WebGLShadowMap.js lines 99-102): PCFSoftShadowMap is
 * deprecated and logs "Using PCFShadowMap instead"; PCFShadowMap is the
 * current soft-filtered path, so that is what we set.
 */

import * as THREE from "three";
import { QUALITY, RENDER } from "../config";
import type { ResourceRegistry } from "./resources";

export interface RendererFailureContext {
  readonly phase: "create" | "context-lost";
  readonly error?: unknown;
}

export interface RendererHandle {
  readonly renderer: THREE.WebGLRenderer;
  /** Re-read the stage CSS box and clamped DPR; cheap, idempotent. */
  resize(): void;
  /** Disconnect the ResizeObserver; renderer disposal stays on the registry. */
  dispose(): void;
  /** Current effective device pixel ratio after the pointer-class cap. */
  readonly dpr: number;
}

export interface CreateRendererOptions {
  /** Called on WebGL construction failure or a later `webglcontextlost`. */
  readonly onFailure?: (context: RendererFailureContext) => void;
}

/** Coarse-pointer / iPad-class devices get a lower DPR cap (config.QUALITY). */
function dprCap(): number {
  const coarse =
    typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return coarse ? QUALITY.dprCapCoarsePointer : QUALITY.dprCapFinePointer;
}

export function createRenderer(
  stage: HTMLElement,
  registry: ResourceRegistry,
  options: CreateRendererOptions = {},
): RendererHandle {
  const onFailure = options.onFailure;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      stencil: false,
      powerPreference: "high-performance",
    });
  } catch (error) {
    onFailure?.({ phase: "create", error });
    throw error;
  }

  registry.track(renderer);

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDER.exposure;
  renderer.shadowMap.enabled = true;
  // PCFShadowMap is the soft path in the r182+ line; PCFSoft is deprecated.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const canvas = renderer.domElement;
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    onFailure?.({ phase: "context-lost" });
  };
  canvas.addEventListener("webglcontextlost", onContextLost, false);

  stage.appendChild(canvas);

  const applySize = (): void => {
    const width = Math.max(stage.clientWidth, 1);
    const height = Math.max(stage.clientHeight, 1);
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap());
    renderer.setPixelRatio(dpr);
    // CSS owns the canvas box (plan section 9); we mirror the stage's CSS
    // pixels explicitly so no inline stylesheet assumption is needed.
    renderer.setSize(width, height, false);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  };

  applySize();

  const observer = new ResizeObserver(() => applySize());
  observer.observe(stage);

  return {
    renderer,
    resize: applySize,
    dispose: () => {
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost, false);
      // Renderer disposal itself runs through registry.disposeAll().
    },
    get dpr(): number {
      return renderer.getPixelRatio();
    },
  };
}
