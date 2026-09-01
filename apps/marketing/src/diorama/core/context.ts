/**
 * Diorama runtime context: the shared object every builder receives. Owns the
 * Pixi application, the fixed layer stack, and animation registration so no
 * module reaches for global state or leaks tickers.
 */
import type { Application, Container, TickerCallback } from "pixi.js";

export interface WorldLayers {
  /** Static deep-space backdrop; never sorted, never animated per frame. */
  backdrop: Container;
  /** Ground plates, floor decals, walkways; below everything sortable. */
  ground: Container;
  /**
   * The single depth-sorted layer: structures, agents, rails, packets.
   * zIndex = worldY + bias (see config/world.ts DEPTH).
   */
  sortable: Container;
  /** World-positioned signs and district banners; above local structures. */
  labels: Container;
  /** Screen-space overlays (vignette, focus ring) managed by the shell. */
  overlay: Container;
}

export type CleanupFn = () => void;

export interface DioramaContext {
  app: Application;
  layers: WorldLayers;
  /** True when prefers-reduced-motion is set; builders pick calmer variants. */
  reducedMotion: boolean;
  /** Quality tier used for glow density and trail effects. */
  quality: "high" | "low";
  /**
   * Register a per-frame update. Returns an unregister function; all
   * registrations are dropped automatically on destroy. Use this instead of
   * app.ticker.add so cleanup is centralized.
   */
  onTick: (fn: TickerCallback<unknown>) => CleanupFn;
  /** Register a cleanup that runs on world destroy (DOM listeners, GSAP). */
  onCleanup: (fn: CleanupFn) => void;
  /** Viewport element size in CSS pixels (updated on resize). */
  screenSize: { w: number; h: number };
}
