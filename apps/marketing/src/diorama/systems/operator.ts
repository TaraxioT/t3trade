/**
 * The Operator's House: oversized human-only lever wall with hover
 * highlight, idle micro-movement, and the explanatory PAUSE demo gag —
 * machinery briefly freezes, then a clearly-marked note explains this is a
 * demonstration, never fake trading UI (spec §26).
 */
import gsap from "gsap";
import { Graphics, Text } from "pixi.js";
import type { DioramaContext, DirectorEvent } from "../types";
import { PLACES, pctPoint } from "../config/positions";
import { flashAt } from "./util";

const LEVER_LABELS = ["PAUSE", "RESUME", "CANCEL", "CLOSE", "REVOKE"] as const;
// Docked BELOW the baked console (which ends ~y=34%), clear of the baked
// "THE OPERATOR'S HOUSE" sign and its lever bank: small chips, not a bar.
const LEVER_Y = pctPoint(66, 37.2).y;
const LEVER_X0 = pctPoint(64.5, 0).x;
const LEVER_DX = pctPoint(2.6, 0).x;

export class OperatorSystem {
  private levers: Array<{ knob: Graphics; label: Text }> = [];
  private note: HTMLElement | null = null;

  constructor(private ctx: DioramaContext) {
    // Each lever renders as a small chip: a short slot with a knob and the
    // label right beneath it, so the group reads as docked instrumentation
    // rather than a HUD bar over the artwork.
    LEVER_LABELS.forEach((label, i) => {
      const x = LEVER_X0 + i * LEVER_DX;
      const knob = new Graphics();
      knob
        .roundRect(-7, -14, 14, 20, 4)
        .fill({ color: 0x0b0e13, alpha: 0.85 })
        .stroke({ color: 0x2a384c, width: 1 });
      knob.roundRect(-5, -4, 10, 8, 3).fill(0xe0534c).stroke({ color: 0x5c1f1b, width: 1 });
      knob.position.set(x, LEVER_Y);
      knob.zIndex = 35;
      ctx.layers.machineFX.addChild(knob);
      const text = new Text({
        text: label,
        style: {
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 9,
          fill: "#9aa4ad",
          fontWeight: "600",
        },
      });
      text.anchor.set(0.5, 0);
      text.position.set(x, LEVER_Y + 10);
      text.zIndex = 35;
      ctx.layers.machineFX.addChild(text);
      this.levers.push({ knob, label: text });

      // Idle micro-movement, desynced per lever (the knob slides in its slot).
      gsap.to(knob, {
        y: LEVER_Y + gsap.utils.random(2, 5),
        duration: gsap.utils.random(3, 7),
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
        delay: Math.random() * 5,
      });
    });
  }

  /** Hover/focus highlight parity (hotspots highlight covers the zone). */
  highlight(on: boolean): void {
    for (const lever of this.levers) {
      gsap.to(lever.knob, { alpha: on ? 1 : 0.85, duration: 0.2 });
    }
    if (on) flashAt(this.ctx, pctPoint(70, 38), 0xffd166, 16, 0.5);
  }

  /**
   * The demo gag: freeze the miniature machinery ~1.4s, then show a
   * clearly-marked explanatory note. gsap's global timeScale is eased to a
   * crawl rather than paused so tweens resume cleanly; the world FX loop
   * separately honors ctx.frozenUntil.
   */
  maybeDemo(): void {
    if (this.ctx.reducedMotion) return;
    if (Math.random() > 0.5) return;
    this.ctx.frozenUntil = performance.now() + 1400;
    // gsap itself is being slowed, so the restore must run on wall clock —
    // a delayedCall here would count seconds at the frozen rate.
    gsap.set(gsap.globalTimeline, { timeScale: 0.04 });
    this.ctx.audio.play("lever", "mechanical", pctPoint(70, 38));
    window.setTimeout(() => {
      gsap.set(gsap.globalTimeline, { timeScale: 1 });
      this.showNote();
    }, 1400);
  }

  private showNote(): void {
    if (!this.note) {
      this.note = document.createElement("p");
      this.note.className = "demo-note";
      this.note.textContent = "Demo only — the real Pause control lives in the T3 Trade app.";
      this.ctx.app.canvas.parentElement?.appendChild(this.note);
    }
    this.note.classList.add("shown");
    this.ctx.bubbles.show("DEMO", pctPoint(70, 27));
    gsap.delayedCall(3.6, () => this.note?.classList.remove("shown"));
  }

  event(): DirectorEvent {
    return {
      id: "operator.guard",
      zone: "operator",
      actors: 1,
      actorKind: "occasional",
      priority: 5,
      cooldownSec: 20,
      minIntervalSec: 30,
      maxIntervalSec: 80,
      weight: 3,
      reducedMotionOk: true,
      soundCategory: "character",
      run: (ctx, agents) => {
        // Curious agent approaches; the house is human-only, so it turns back.
        const agent = agents[0];
        // Round 5: the house front has no verified floor; the curious agent
        // approaches the booth row's west stand, then turns back.
        const tl = agent.walkTo([PLACES.boothCodex]);
        tl.eventCallback("onComplete", () => {
          agent.express("squint", 1.2);
          ctx.bubbles.show("...", { x: agent.x, y: agent.headTop });
          ctx.audio.play("squeak", "character", agent.container.position);
          gsap.delayedCall(1.1, () => {
            agent.shrug();
            agent.walkTo([PLACES.boothStaffMid]);
          });
        });
        return 7;
      },
    };
  }
}
