/**
 * Explicit disposal registry for every GPU resource and DOM listener the
 * diorama creates. Nothing may call `.dispose()` ad hoc; track here and let
 * teardown run through disposeAll(), newest-first.
 */

import * as THREE from "three";

type Trackable =
  | THREE.BufferGeometry
  | THREE.Material
  | THREE.Texture
  | THREE.WebGLRenderer
  | THREE.WebGLRenderTarget;

interface TrackedListener {
  readonly target: EventTarget;
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject;
  readonly options: boolean | AddEventListenerOptions | undefined;
}

export interface ResourceCounts {
  readonly resources: number;
  readonly listeners: number;
}

export interface ResourceRegistry {
  /** Track a resource and return it, for `const m = registry.track(new X())`. */
  track<T extends Trackable>(resource: T): T;
  /** Track an event listener for removal at teardown. */
  trackEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  /** Dispose everything: listeners first, then resources newest-first. */
  disposeAll(): void;
  readonly counts: ResourceCounts;
}

export function createResourceRegistry(): ResourceRegistry {
  const resources: Trackable[] = [];
  const listeners: TrackedListener[] = [];
  let disposed = false;

  return {
    track<T extends Trackable>(resource: T): T {
      if (disposed) {
        // Late tracking after teardown would leak silently; fail loudly.
        throw new Error("ResourceRegistry.track called after disposeAll");
      }
      resources.push(resource);
      return resource;
    },

    trackEventListener(target, type, listener, options): void {
      if (disposed) {
        throw new Error("ResourceRegistry.trackEventListener called after disposeAll");
      }
      target.addEventListener(type, listener, options);
      listeners.push({ target, type, listener, options });
    },

    disposeAll(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of listeners.splice(0)) {
        entry.target.removeEventListener(entry.type, entry.listener, entry.options);
      }
      // Newest-first so render targets and renderers go before their inputs.
      for (let i = resources.length - 1; i >= 0; i -= 1) {
        resources[i]?.dispose();
      }
      resources.length = 0;
    },

    get counts(): ResourceCounts {
      return { resources: resources.length, listeners: listeners.length };
    },
  };
}
