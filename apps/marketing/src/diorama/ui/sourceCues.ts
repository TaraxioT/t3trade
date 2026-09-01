/**
 * Pooled visual source cues coupled to accepted audio playbacks. Owner: UI
 * worker.
 *
 * main.ts registers createSourceCues().pulse as the audio source hook, so a
 * small ring flashes at the emitting station/agent exactly when a cue is
 * actually heard: never while muted, throttled, or cap-refused (no phantom
 * cues). Pulses live in the sortable layer at the emitter's y plus overlay
 * depth, sized and colored by cue category (authority bigger, foley
 * smaller). Pooled Graphics with GSAP tweens only; no per-frame tick.
 */
import gsap from "gsap";
import { Graphics } from "pixi.js";
import type { DioramaContext } from "../core/context.js";
import { DEPTH } from "../config/world.js";
import { PALETTE } from "../config/palette.js";
import { cueInfo, type CueCategory } from "../audio.js";

export interface SourceCues {
  /** Flash a cue pulse at a world point. Unknown cues are ignored. */
  pulse(world: { x: number; y: number }, cue: string): void;
}

/** Hard cap on concurrent pulses; the oldest is recycled when exceeded. */
const MAX_ACTIVE = 3;

/**
 * Per-category visual: color follows the cue's semantic family, radius in
 * world px (authority bigger, foley smaller), lifetime roughly matching the
 * family's short sample durations rather than the 1.8 s bell.
 */
const CATEGORY_VISUAL: Record<CueCategory, { color: number; radius: number; life: number }> = {
  authority: { color: PALETTE.warning, radius: 26, life: 0.8 },
  tool: { color: PALETTE.blue, radius: 20, life: 0.55 },
  foley: { color: PALETTE.waiting, radius: 14, life: 0.4 },
  comic: { color: PALETTE.magenta, radius: 14, life: 0.45 },
  ui: { color: PALETTE.cyan, radius: 18, life: 0.35 },
};

/** Ring plus a small center dot at the emitter point. */
function drawPulse(g: Graphics, radius: number, color: number): void {
  g.clear();
  g.circle(0, 0, radius);
  g.stroke({ width: 2, color, alpha: 0.9 });
  g.circle(0, 0, 3);
  g.fill({ color, alpha: 0.95 });
}

export function createSourceCues(ctx: DioramaContext): SourceCues {
  /** Idle pool; each entry is a reusable Graphics outside the scene graph. */
  const idle: Graphics[] = [];
  /** Live pulses in activation order (Set preserves it for recycling). */
  const live = new Set<Graphics>();

  const recycle = (g: Graphics): void => {
    gsap.killTweensOf([g, g.scale]);
    g.removeFromParent();
    live.delete(g);
    idle.push(g);
  };

  const acquire = (): Graphics => {
    const pooled = idle.pop();
    if (pooled) return pooled;
    if (live.size < MAX_ACTIVE) return new Graphics();
    // All slots busy: recycle the oldest so the newest event stays visible.
    const oldest = live.values().next().value;
    if (oldest) recycle(oldest);
    return idle.pop() ?? new Graphics();
  };

  ctx.onCleanup(() => {
    for (const g of [...live, ...idle]) {
      gsap.killTweensOf([g, g.scale]);
      g.destroy();
    }
    live.clear();
    idle.length = 0;
  });

  return {
    pulse(world, cue): void {
      const info = cueInfo(cue);
      if (!info) return;
      const visual = CATEGORY_VISUAL[info.category];
      const g = acquire();
      drawPulse(g, visual.radius, visual.color);
      g.position.set(world.x, world.y);
      // Overlay depth keeps the pulse above local geometry near its y while
      // still sorting with the world (under the separate labels layer).
      g.zIndex = world.y + DEPTH.overlay;
      g.scale.set(1);
      g.alpha = 0.95;
      ctx.layers.sortable.addChild(g);
      live.add(g);
      if (ctx.reducedMotion) {
        // Alpha-only soft halo: no expansion, brief fade.
        g.alpha = 0.55;
        gsap.to(g, {
          alpha: 0,
          duration: 0.45,
          ease: "sine.out",
          overwrite: true,
          onComplete: () => recycle(g),
        });
        return;
      }
      g.scale.set(0.55);
      gsap.to(g.scale, {
        x: 1.2,
        y: 1.2,
        duration: visual.life,
        ease: "power2.out",
        overwrite: true,
      });
      gsap.to(g, {
        alpha: 0,
        duration: visual.life,
        ease: "sine.in",
        overwrite: true,
        onComplete: () => recycle(g),
      });
    },
  };
}
