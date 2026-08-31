/**
 * DOM state binding for the /diorama route (plan sections 9 and 12/M08).
 *
 * Drives the semantic chrome authored in diorama.astro: determinate loading
 * progress, the ready crossfade, the poster fallback on failure, the
 * pause/sound buttons, and the polite live region. Pure DOM, no THREE.
 *
 * Every listener this module adds is removed by dispose(); bindPause and
 * bindSound additionally return their own unbind functions.
 */

export interface UiHandle {
  /** Drive the progressbar aria, the CSS `--progress` var, and the status text. */
  setLoadingProgress(value01: number, label?: string): void;
  /** Hide the loading overlay (crossfade, instant under reduced motion) and enable controls. */
  setReady(): void;
  /** Reveal the poster fallback, disable controls, and announce the static view. */
  setFailed(reason: string): void;
  /** Pause button label "Pause"/"Resume" and its aria-pressed state. */
  setPaused(isPaused: boolean): void;
  /** Sound button label "Sound off"/"Sound on" and its aria-pressed state. */
  setSoundEnabled(enabled: boolean): void;
  /** Speak through the polite live region (re-announces identical text). */
  announce(text: string): void;
  /** Register the pause handler; returns an unbind function. */
  bindPause(handler: () => void): () => void;
  /** Register the sound handler; returns an unbind function. */
  bindSound(handler: () => void): () => void;
  /** Current prefers-reduced-motion state. */
  reducedMotion(): boolean;
  /** Subscribe to preference changes; returns an unbind function. */
  onReducedMotionChange(handler: (reduced: boolean) => void): () => void;
  /** Primary pointer class, used for the DPR cap and parallax gating. */
  pointerPreference(): "fine" | "coarse";
  /** Remove every listener and pending timer this module added. Idempotent. */
  dispose(): void;
}

interface TrackedListener {
  readonly target: EventTarget;
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject;
}

/** Matches the loading overlay's 0.4s CSS fade plus a little slack. */
const LOADING_FADE_MS = 500;

export function createUi(): UiHandle {
  const fallback = document.getElementById("fallback") as HTMLImageElement | null;
  const pauseButton = document.getElementById("pause") as HTMLButtonElement | null;
  const soundButton = document.getElementById("sound") as HTMLButtonElement | null;
  const loading = document.getElementById("loading");
  const progress = document.getElementById("progress");
  const status = document.getElementById("status");
  const announcer = document.getElementById("announcer");

  const listeners: TrackedListener[] = [];
  const reducedHandlers = new Set<(reduced: boolean) => void>();
  let hideTimer = 0;
  let disposed = false;

  const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const fineQuery = window.matchMedia("(pointer: fine)");

  const track = (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void => {
    target.addEventListener(type, listener);
    listeners.push({ target, type, listener });
  };

  const untrack = (entry: TrackedListener): void => {
    const index = listeners.indexOf(entry);
    if (index >= 0) listeners.splice(index, 1);
    entry.target.removeEventListener(entry.type, entry.listener);
  };

  track(reducedQuery, "change", (event: Event) => {
    const reduced = (event as MediaQueryListEvent).matches;
    for (const handler of reducedHandlers) handler(reduced);
  });

  const setControlsDisabled = (disabled: boolean): void => {
    if (pauseButton) pauseButton.disabled = disabled;
    if (soundButton) soundButton.disabled = disabled;
  };

  const hideLoadingInstantly = (): void => {
    if (!loading) return;
    loading.classList.add("is-done");
    loading.hidden = true;
  };

  const bindControl = (button: HTMLButtonElement | null, handler: () => void): (() => void) => {
    if (!button) return () => undefined;
    const entry: TrackedListener = {
      target: button,
      type: "click",
      listener: () => handler(),
    };
    button.addEventListener("click", entry.listener);
    listeners.push(entry);
    return () => untrack(entry);
  };

  return {
    setLoadingProgress(value01: number, label?: string): void {
      if (disposed) return;
      const clamped = Math.min(1, Math.max(0, Number.isFinite(value01) ? value01 : 0));
      if (progress) {
        progress.style.setProperty("--progress", clamped.toFixed(4));
        progress.setAttribute("aria-valuenow", String(Math.round(clamped * 100)));
      }
      if (status && label !== undefined) status.textContent = label;
    },

    setReady(): void {
      if (disposed) return;
      this.setLoadingProgress(1);
      if (loading) {
        loading.classList.add("is-done");
        if (reducedQuery.matches) {
          loading.hidden = true;
        } else {
          hideTimer = window.setTimeout(() => {
            hideTimer = 0;
            if (loading) loading.hidden = true;
          }, LOADING_FADE_MS);
        }
      }
      setControlsDisabled(false);
    },

    setFailed(reason: string): void {
      if (disposed) return;
      hideLoadingInstantly();
      if (fallback) {
        const src = fallback.dataset.src;
        if (src && fallback.getAttribute("src") === null) fallback.src = src;
        fallback.hidden = false;
      }
      setControlsDisabled(true);
      this.announce(
        `The animated bureau could not start, so the static view is shown. Reason: ${reason}`,
      );
    },

    setPaused(isPaused: boolean): void {
      if (!pauseButton || disposed) return;
      pauseButton.textContent = isPaused ? "Resume" : "Pause";
      pauseButton.setAttribute("aria-pressed", isPaused ? "true" : "false");
    },

    setSoundEnabled(enabled: boolean): void {
      if (!soundButton || disposed) return;
      soundButton.textContent = enabled ? "Sound on" : "Sound off";
      soundButton.setAttribute("aria-pressed", enabled ? "true" : "false");
    },

    announce(text: string): void {
      if (!announcer || disposed) return;
      // Clear first so identical text is re-announced by assistive tech.
      announcer.textContent = "";
      window.requestAnimationFrame(() => {
        if (!disposed) announcer.textContent = text;
      });
    },

    bindPause(handler: () => void): () => void {
      return bindControl(pauseButton, handler);
    },

    bindSound(handler: () => void): () => void {
      return bindControl(soundButton, handler);
    },

    reducedMotion(): boolean {
      return reducedQuery.matches;
    },

    onReducedMotionChange(handler: (reduced: boolean) => void): () => void {
      reducedHandlers.add(handler);
      return () => {
        reducedHandlers.delete(handler);
      };
    },

    pointerPreference(): "fine" | "coarse" {
      return fineQuery.matches ? "fine" : "coarse";
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (hideTimer !== 0) {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
      }
      for (const entry of listeners.splice(0)) {
        entry.target.removeEventListener(entry.type, entry.listener);
      }
      reducedHandlers.clear();
    },
  };
}
