/**
 * Speech bubbles: comic-style, 0-3 words/symbols only, max 3 visible
 * scene-wide, 0.8-2.5s life with a pop-in float-and-fade (spec §25).
 */
import gsap from "gsap";
import { Container, Graphics, Text } from "pixi.js";
import { BUBBLES } from "../config";
import type { Pt } from "../config/positions";

const BUBBLE_BG = 0x11131a;
const BUBBLE_BORDER = 0x3a4152;
const TEXT_COLOR = "#e8ecf2";

const style = {
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 15,
  fill: TEXT_COLOR,
  fontWeight: "600",
} as const;

interface Bubble {
  container: Container;
  life: number;
}

export class BubbleManager {
  private bubbles: Bubble[] = [];
  private layer: Container;

  constructor(layer: Container) {
    this.layer = layer;
  }

  get visibleCount(): number {
    return this.bubbles.length;
  }

  /** Show a bubble above `at` (world coords). Silently drops when full. */
  show(text: string, at: Pt): void {
    if (this.bubbles.length >= BUBBLES.maxVisible) return;
    const container = new Container();

    const label = new Text({ text, style });
    const pad = 9;
    const w = label.width + pad * 2;
    const h = label.height + pad * 1.2;
    const tail = 6;

    const bg = new Graphics();
    bg.roundRect(0, 0, w, h, 8)
      .fill(BUBBLE_BG)
      .stroke({ color: BUBBLE_BORDER, width: 1.5, alpha: 0.9 });
    bg.poly([w / 2 - 5, h - 1, w / 2 + 5, h - 1, w / 2, h + tail]).fill(BUBBLE_BG);
    label.position.set(pad, pad * 0.6);

    container.addChild(bg, label);
    container.position.set(at.x - w / 2, at.y - h - 14);
    container.zIndex = 10;
    this.layer.addChild(container);

    // Pop in, float up, fade out (spec §25 choreography).
    container.scale.set(0.6);
    const life = gsap.utils.random(BUBBLES.minLifeSec, BUBBLES.maxLifeSec);
    const bubble: Bubble = { container, life };
    this.bubbles.push(bubble);

    gsap
      .timeline({ onComplete: () => this.remove(bubble) })
      .to(container.scale, { x: 1.08, y: 1.08, duration: 0.12, ease: "back.out(2.5)" })
      .to(container.scale, { x: 1, y: 1, duration: 0.08 })
      .to(container, { y: container.y - 7, duration: life * 0.7, ease: "sine.out" }, 0)
      .to(container, { alpha: 0, duration: life * 0.3, ease: "power1.in" }, life * 0.7);
  }

  private remove(bubble: Bubble): void {
    const i = this.bubbles.indexOf(bubble);
    if (i >= 0) this.bubbles.splice(i, 1);
    bubble.container.destroy({ children: true });
  }

  dispose(): void {
    for (const bubble of [...this.bubbles]) this.remove(bubble);
  }
}
