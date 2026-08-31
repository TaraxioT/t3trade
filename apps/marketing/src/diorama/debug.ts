/**
 * Dev-only debug overlay (contract §8): D key toggles. Shows fps, camera,
 * zoom, pointer world coords, zone bounds, actor locks, running events and
 * active sounds. Gated behind import.meta.env.DEV so it never ships.
 */
import type { Application } from "pixi.js";
import type { Viewport } from "pixi-viewport";
import { ZONES } from "./config/positions";
import type { ZoneId } from "./config/positions";

export interface DebugDeps {
  app: Application;
  viewport: Viewport;
  director: { runningIds: string[]; locks: string[] };
  audio: { active: string[] };
  substitutions: string[];
}

export class DebugOverlay {
  private el: HTMLElement;
  private visible = false;
  private pointerWorld = { x: 0, y: 0 };
  private disposers: Array<() => void> = [];

  constructor(private deps: DebugDeps) {
    this.el = document.createElement("pre");
    this.el.className = "debug-overlay";
    this.el.hidden = true;
    this.el.setAttribute("aria-hidden", "true");
    document.body.appendChild(this.el);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "d" || event.key === "D") this.toggle();
    };
    window.addEventListener("keydown", onKey);
    const onMove = (e: PointerEvent): void => {
      this.pointerWorld = deps.viewport.toWorld(e.clientX, e.clientY);
    };
    window.addEventListener("pointermove", onMove);
    this.disposers.push(
      () => window.removeEventListener("keydown", onKey),
      () => window.removeEventListener("pointermove", onMove),
      () => this.el.remove(),
    );

    deps.app.ticker.add(() => {
      if (!this.visible) return;
      this.render();
    });
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
  }

  zone(name: string): string {
    const zone = ZONES.find((z) => z.id === (name as ZoneId));
    return zone ? JSON.stringify(zone.bbox) : `unknown zone ${name}`;
  }

  private render(): void {
    const { app, viewport, director, audio, substitutions } = this.deps;
    const lines = [
      `fps        ${Math.round(app.ticker.FPS)}`,
      `camera     ${Math.round(viewport.center.x)},${Math.round(viewport.center.y)}`,
      `zoom       ${viewport.scale.x.toFixed(3)}`,
      `pointer    ${Math.round(this.pointerWorld.x)},${Math.round(this.pointerWorld.y)}`,
      `events     ${director.runningIds.join(", ") || "-"}`,
      `locks      ${director.locks.join(", ") || "-"}`,
      `sounds     ${audio.active.join(", ") || "-"}`,
      `assets     ${substitutions.length === 0 ? "all manifest files loaded" : substitutions.join(" | ")}`,
      "zones",
      ...ZONES.map((z) => `  ${z.id.padEnd(12)} ${z.bbox.join(",")}`),
    ];
    this.el.textContent = lines.join("\n");
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
  }
}
