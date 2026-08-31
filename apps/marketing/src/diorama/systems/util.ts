/** Small helpers shared by the system modules. */
import gsap from "gsap";
import { Container, Graphics, Sprite, Text } from "pixi.js";
import type { DioramaContext } from "../types";
import type { PropKey } from "../assets";
import type { Pt } from "../config/positions";

/** A world-space prop sprite at its semantic target size (config PROPS). */
export function makeProp(ctx: DioramaContext, key: PropKey, at?: Pt): Sprite {
  const texture = ctx.assets.props[key];
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5, 0.5);
  sprite.scale.set(ctx.assets.propScale[key]);
  if (at) sprite.position.set(at.x, at.y);
  return sprite;
}

/** Short additive flash: visible counterpart for every mechanical sound. */
export function flashAt(
  ctx: DioramaContext,
  at: Pt,
  color: number,
  radius = 14,
  duration = 0.5,
): void {
  const g = new Graphics();
  g.circle(0, 0, radius).fill({ color, alpha: 0.55 });
  g.blendMode = "add";
  g.position.set(at.x, at.y);
  ctx.layers.machineFX.addChild(g);
  gsap.to(g, {
    alpha: 0,
    duration,
    ease: "power2.out",
    onComplete: () => g.destroy(),
  });
}

/** Stamp FX: pops the X or check prop at a position with a squash. */
export function stampFx(ctx: DioramaContext, key: "x" | "check", at: Pt): void {
  const sprite = makeProp(ctx, key, at);
  sprite.rotation = gsap.utils.random(-0.2, 0.2);
  ctx.layers.machineFX.addChild(sprite);
  gsap
    .timeline({ onComplete: () => sprite.destroy() })
    .fromTo(
      sprite.scale,
      { x: sprite.scale.x * 2, y: sprite.scale.y * 2 },
      { x: sprite.scale.x, y: sprite.scale.y, duration: 0.15, ease: "power3.in" },
    )
    .to(sprite, { alpha: 0, delay: 0.9, duration: 0.4 });
}

/** A rising mark above a position (alarm marks, confirmation glyphs). */
export function riseFx(ctx: DioramaContext, mark: string, at: Pt, color = "#ffd166"): void {
  const g = new Graphics();
  const size = 18;
  if (mark === "!") {
    g.roundRect(-3, -size, 6, size * 0.7, 3).fill(color);
    g.circle(0, 0, 3.4).fill(color);
  } else if (mark === "?") {
    g.circle(-3, -size * 0.8, 4).fill(color);
    g.circle(3, -size * 0.8, 4).fill(color);
    g.roundRect(-6, -size * 0.5, 12, 4, 2).fill(color);
    g.roundRect(-2, -size * 0.15, 4, 6, 2).fill(color);
  }
  g.position.set(at.x, at.y);
  ctx.layers.machineFX.addChild(g);
  gsap
    .timeline({ onComplete: () => g.destroy() })
    .fromTo(g, { alpha: 0, y: g.y }, { alpha: 1, y: g.y - 8, duration: 0.25, ease: "back.out(2)" })
    .to(g, { alpha: 0, y: g.y - 18, duration: 0.5, delay: 0.5 });
}

export interface ReadoutChip {
  setText: (value: string) => void;
  container: Container;
}

/**
 * System readout (BUDGET/LOCAL/EXCH): translucent dark chip with a subtle
 * border and the shared mono face, so values read as instrumentation
 * rather than raw debug text.
 */
export function makeReadout(
  ctx: DioramaContext,
  at: Pt,
  initial: string,
  color: string,
): ReadoutChip {
  const container = new Container();
  const bg = new Graphics();
  const label = new Text({
    text: initial,
    style: {
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 13,
      fontWeight: "500",
      fill: color,
    },
  });
  container.addChild(bg, label);
  container.position.set(at.x, at.y);
  container.zIndex = 39;

  const redraw = (value: string): void => {
    label.text = value;
    const padX = 9;
    const w = label.width + padX * 2;
    const h = 21;
    label.position.set(padX, (h - label.height) / 2);
    bg.clear();
    bg.roundRect(0, 0, w, h, 5)
      .fill({ color: 0x0b0e13, alpha: 0.82 })
      .stroke({ color: 0x2a384c, width: 1, alpha: 0.9 });
  };
  redraw(initial);
  ctx.layers.machineFX.addChild(container);
  return {
    setText: redraw,
    container,
  };
}
