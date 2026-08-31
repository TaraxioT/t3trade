/**
 * Agent: one animated bot. The body is a state-swapping painted sprite
 * (bots.json `<family>-<state>` frames; faces/props are baked in) anchored
 * at the feet-center inside a holder that owns horizontal flip, squash and
 * lean. All motion is GSAP timelines built from the primitives in spec §11;
 * the director owns actor locks so an agent never runs two incompatible
 * timelines. The procedural arm/eye layers of the placeholder era are
 * RETIRED from the production path — express() now swaps poses.
 */
import gsap from "gsap";
import { Container, Graphics, Sprite } from "pixi.js";
import type { Texture } from "pixi.js";
import { AGENTS } from "../config";
import type { AgentState } from "../types";
import type { AgentRole, CastKind, Pt, ScaleClass } from "../config/positions";
import type { BotArt } from "../assets";

/** Legacy eye-style vocabulary -> painted pose swaps (family fallback: neutral). */
const EYE_TO_POSE: Readonly<Record<string, string>> = {
  closed: "crying",
  worried: "crying",
  wide: "surprised",
  squint: "tired",
  sleep: "tired",
  happy: "happy",
  x: "confused",
  hearts: "happy",
  blink: "neutral",
  neutral: "neutral",
};

export type EyeStyle =
  | "neutral"
  | "blink"
  | "squint"
  | "wide"
  | "x"
  | "hearts"
  | "closed"
  | "sleep"
  | "happy"
  | "worried";

const TEAR_COLOR = 0x8ac5d9;

export interface AgentDeps {
  layer: Container;
  fxLayer: Container;
}

export interface AgentOpts {
  pose?: string;
  scaleClass?: ScaleClass;
}

export class Agent {
  readonly id: string;
  readonly role: AgentRole;
  readonly kind: CastKind;
  state: AgentState = "idle";
  readonly container = new Container();
  readonly scaleClass: ScaleClass;

  private readonly holder = new Container(); // horizontal flip + squash live here
  private readonly body: Sprite;
  private readonly shadow: Sprite;
  private readonly art: BotArt;
  private readonly deps: AgentDeps;
  private readonly bodyH: number; // world px at the agent's scale class
  private readonly depth: number;
  private readonly shadowBase = { w: 0, h: 0, alpha: 0 };
  private facing: 1 | -1 = 1;
  private currentPose = "neutral";
  private carried: Sprite | null = null;
  private destroyed = false;
  private walkBob: gsap.core.Tween | null = null;
  private activeTimeline: gsap.core.Timeline | null = null;

  constructor(
    id: string,
    role: AgentRole,
    kind: CastKind,
    art: BotArt,
    home: Pt,
    deps: AgentDeps,
    opts: AgentOpts = {},
  ) {
    this.id = id;
    this.role = role;
    this.kind = kind;
    this.art = art;
    this.deps = deps;
    this.scaleClass = opts.scaleClass ?? "normal";

    this.depth =
      AGENTS.depthScaleMin + (AGENTS.depthScaleMax - AGENTS.depthScaleMin) * (home.y / 1536);
    this.bodyH = AGENTS.bodyHeight * AGENTS.scaleClass[this.scaleClass];

    // Contact shadow: soft wide ellipse under the feet (phase 10).
    this.shadow = new Sprite(art.shadow);
    this.shadow.anchor.set(0.5);
    this.shadowBase.w = this.bodyH * AGENTS.shadow.widthFactor;
    this.shadowBase.h = this.bodyH * AGENTS.shadow.heightFactor;
    this.shadowBase.alpha = AGENTS.shadow.alpha;
    this.shadow.width = this.shadowBase.w;
    this.shadow.height = this.shadowBase.h;
    this.shadow.alpha = this.shadowBase.alpha;
    this.shadow.y = 0; // centered exactly on the feet line (gate QC note)
    this.container.addChild(this.shadow);

    this.body = new Sprite(this.poseTexture(opts.pose ?? "neutral"));
    this.body.anchor.set(0.5, 1);
    // Per-bot value/saturation variance: a deterministic, subtle tint off
    // the id so the cast does not read as one cloned sprite.
    this.body.tint = varianceTint(id);
    this.applyBodyScale();

    this.holder.addChild(this.body);
    this.holder.scale.set(this.depth);
    this.container.addChild(this.holder);

    this.container.position.set(home.x, home.y);
    this.container.zIndex = home.y;
    this.container.eventMode = "none";
    deps.layer.addChild(this.container);
    // Register skew on the holder so GSAP can tween skewX/skewY without
    // the "Missing plugin?" console warning.
    gsap.set(this.holder, { skewX: 0, skewY: 0 });
    this.startIdleBreath();
  }

  // --------------------------------------------------------------- poses

  private poseTexture(name: string): Texture {
    return this.art.states[name] ?? this.art.states.neutral;
  }

  private applyBodyScale(): void {
    // Every pose keeps the same on-screen body height: the painted frames
    // differ a few px after alpha-trim, so scale per-frame.
    this.body.scale.set(this.bodyH / this.body.texture.height);
  }

  /** Swap the painted pose; unknown states fall back to family neutral. */
  pose(name: string): void {
    this.currentPose = this.art.states[name] ? name : "neutral";
    this.body.texture = this.poseTexture(this.currentPose);
    this.applyBodyScale();
  }

  get poseName(): string {
    return this.currentPose;
  }

  get x(): number {
    return this.container.x;
  }
  get y(): number {
    return this.container.y;
  }
  get headTop(): number {
    return this.container.y - this.bodyH;
  }

  setState(s: AgentState): void {
    this.state = s;
  }

  /**
   * Expression entry point kept from the procedural era: eye styles now map
   * to painted pose swaps (faces are baked). Blinks are visual no-ops.
   */
  express(style: EyeStyle, holdSec = 1.2): void {
    if (style === "blink") return;
    const mapped = EYE_TO_POSE[style] ?? "neutral";
    if (this.art.states[mapped]) this.pose(mapped);
    if (style !== "neutral" && holdSec > 0) {
      gsap.delayedCall(holdSec, () => {
        if (this.destroyed) return;
        if (this.state !== "crying" && this.state !== "sleeping") this.pose("neutral");
      });
    }
  }

  /** Faces are baked; look-at becomes a tiny lean of the whole holder. */
  lookAt(tx: number, _ty: number): void {
    const dir = tx >= this.container.x ? 1 : -1;
    gsap.to(this.holder, { rotation: 0.03 * dir, duration: 0.3, ease: "sine.out" });
    gsap.to(this.holder, { rotation: 0, duration: 0.5, delay: 1.4 });
  }

  private startIdleBreath(): void {
    gsap.to(this.holder.scale, {
      y: this.holder.scale.y * 1.012,
      duration: 1.6,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
    });
  }

  /** Shadow reacts to the body rising in hops/bounces (0 = grounded). */
  private applyLift(v: number): void {
    const k = 1 + (AGENTS.shadow.liftScale - 1) * v;
    this.shadow.width = this.shadowBase.w * k;
    this.shadow.height = this.shadowBase.h * k;
    this.shadow.alpha = this.shadowBase.alpha - AGENTS.shadow.liftAlphaDrop * v;
  }

  // ------------------------------------------------------------ movement

  /** Walk (or run) a waypoint path. Returns the timeline (already playing). */
  walkTo(points: readonly Pt[], opts: { run?: boolean; speed?: number } = {}): gsap.core.Timeline {
    const speed = opts.speed ?? (opts.run ? AGENTS.runSpeed : AGENTS.walkSpeed);
    const tl = gsap.timeline({
      onStart: () => {
        this.state = "walking";
        this.startWalkBob(opts.run ? 1.5 : 1);
      },
      onComplete: () => this.stopWalkBob(),
    });
    let prev = { x: this.container.x, y: this.container.y };
    for (const pt of points) {
      const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y);
      const dur = Math.max(0.05, dist / speed);
      if (Math.abs(pt.x - prev.x) > 4) this.face(pt.x > prev.x ? 1 : -1);
      tl.to(this.container, {
        x: pt.x,
        y: pt.y,
        duration: dur,
        ease: "none",
        onUpdate: () => {
          this.container.zIndex = this.container.y;
        },
      });
      prev = pt;
    }
    this.activeTimeline = tl;
    return tl;
  }

  private startWalkBob(intensity: number): void {
    this.stopWalkBob();
    this.walkBob = gsap.to(this.holder, {
      y: -AGENTS.bobHeight * intensity,
      duration: 1 / (AGENTS.bobFrequency / (intensity * 2)),
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
      onUpdate: () => {
        // Shadow softens slightly while the body bobs.
        this.applyLift(
          Math.min(1, Math.max(0, -this.holder.y / (AGENTS.bobHeight * intensity || 1))),
        );
      },
    });
  }

  private stopWalkBob(): void {
    this.walkBob?.kill();
    this.walkBob = null;
    this.applyLift(0);
    gsap.to(this.holder, { y: 0, duration: 0.15, overwrite: true });
  }

  face(dir: 1 | -1): void {
    if (this.facing === dir) return;
    this.facing = dir;
    this.holder.scale.x = Math.abs(this.holder.scale.x) * dir;
  }

  // ------------------------------------------------------------ gestures

  /** Small squash-and-stretch pulse within the 15% limit. */
  squash(amount = 0.12): void {
    gsap.to(this.holder.scale, {
      x: this.holder.scale.x * (1 + amount),
      y: this.holder.scale.y * (1 - amount),
      duration: 0.09,
      yoyo: true,
      repeat: 1,
      ease: "power2.out",
    });
  }

  hop(height = 8, times = 1): gsap.core.Tween {
    const lift = { v: 0 };
    const baseY = this.container.y;
    return gsap.to(this.container, {
      y: baseY - height,
      duration: 0.18,
      yoyo: true,
      repeat: times * 2 - 1,
      ease: "power1.out",
      onUpdate: () => {
        lift.v = Math.min(1, Math.max(0, (baseY - this.container.y) / (height || 1)));
        this.applyLift(lift.v);
      },
      onComplete: () => this.applyLift(0),
    });
  }

  type(): gsap.core.Timeline {
    this.state = "working";
    const tl = gsap.timeline();
    tl.to(this.holder, { rotation: 0.05, duration: 0.16, yoyo: true, repeat: 7, ease: "steps(2)" });
    return tl;
  }

  stamp(): gsap.core.Timeline {
    this.state = "working";
    const tl = gsap.timeline();
    tl.to(this.holder, { rotation: 0.14, duration: 0.18, ease: "power2.out" });
    tl.add(() => this.squash(0.1));
    tl.to(this.holder, { rotation: 0, duration: 0.25, ease: "power2.out" });
    return tl;
  }

  point(dir: 1 | -1 = 1): gsap.core.Timeline {
    this.pose("point"); // baked pointing figure where the family has one
    const tl = gsap.timeline();
    tl.to(this.holder, { rotation: 0.06 * dir, duration: 0.2, ease: "back.out(2)" });
    tl.add(() => {
      if (this.currentPose === "point") this.pose("neutral");
    }, "+=0.6");
    tl.to(this.holder, { rotation: 0, duration: 0.3 }, "<");
    return tl;
  }

  wave(): gsap.core.Timeline {
    const tl = gsap.timeline();
    tl.add(() => this.hop(6, 1));
    tl.to(this.holder, {
      rotation: -0.08,
      duration: 0.2,
      yoyo: true,
      repeat: 2,
      ease: "sine.inOut",
    });
    tl.to(this.holder, { rotation: 0, duration: 0.25 });
    return tl;
  }

  celebrate(): gsap.core.Timeline {
    this.express("happy", 1.4);
    const tl = gsap.timeline();
    tl.add(() => this.hop(14, 2));
    tl.to(this.holder.scale, {
      x: this.holder.scale.x * 1.08,
      duration: 0.2,
      yoyo: true,
      repeat: 1,
    });
    return tl;
  }

  panic(): gsap.core.Timeline {
    this.express("wide", 1.2);
    const tl = gsap.timeline();
    tl.to(this.holder, { x: 3, duration: 0.05, yoyo: true, repeat: 9, ease: "none" });
    return tl;
  }

  startle(): gsap.core.Timeline {
    this.express("wide", 1.0);
    const tl = gsap.timeline();
    tl.add(() => this.hop(10, 1));
    tl.fromTo(this.holder, { skewX: 0 }, { skewX: -0.12, duration: 0.08, yoyo: true, repeat: 1 });
    return tl;
  }

  trip(): gsap.core.Timeline {
    this.express("wide", 0.9);
    const tl = gsap.timeline();
    tl.to(this.container, { y: this.container.y + 4, duration: 0.1, ease: "power2.in" });
    tl.to(this.holder, { rotation: 0.5, duration: 0.15, ease: "power2.out" });
    tl.to(this.holder, { rotation: 0, duration: 0.5, ease: "elastic.out(1, 0.4)" }, "+=0.4");
    return tl;
  }

  bonk(): gsap.core.Timeline {
    this.express("x", 0.9);
    const tl = gsap.timeline();
    tl.to(this.holder, { rotation: -0.35, duration: 0.12, ease: "power3.in" });
    tl.add(() => this.squash(0.15));
    tl.to(this.holder, { rotation: 0, duration: 0.7, ease: "elastic.out(1, 0.35)" });
    return tl;
  }

  /**
   * Dramatic 1-2s cartoon cry (spec §13): painted crying pose, shoulders
   * bounce, 2-3 oversized tear droplets arc outward, then recover.
   */
  cry(): gsap.core.Timeline {
    this.state = "crying";
    this.express("closed", 1.8);
    const tl = gsap.timeline({
      onComplete: () => {
        this.state = "idle";
        this.pose("neutral");
      },
    });
    tl.to(this.holder, { y: -3, duration: 0.14, yoyo: true, repeat: 6, ease: "sine.inOut" }, 0);
    tl.to(this.holder, { rotation: -0.06, duration: 0.3 }, 0);
    tl.to(this.holder, { rotation: 0.06, duration: 0.3 }, 0.3);
    tl.to(this.holder, { rotation: 0, duration: 0.4 }, 0.6);
    tl.add(() => this.spawnTears(), 0.15);
    return tl;
  }

  private spawnTears(): void {
    const count = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      const drop = new Graphics();
      const dir = i % 2 === 0 ? -1 : 1;
      drop.ellipse(0, 0, 2.6, 3.6).fill(TEAR_COLOR);
      drop.position.set(
        this.container.x + dir * this.body.width * 0.16,
        this.container.y - this.bodyH * 0.78,
      );
      drop.zIndex = 5;
      this.deps.fxLayer.addChild(drop);
      const state = { x: drop.x, y: drop.y };
      gsap.to(state, {
        x: drop.x + dir * (18 + Math.random() * 14),
        y: drop.y + 6,
        duration: 0.5,
        ease: "power1.out",
        onUpdate: () => drop.position.set(state.x, state.y),
      });
      gsap.to(drop, {
        y: drop.y + this.bodyH * 0.9,
        alpha: 0,
        delay: 0.5,
        duration: 0.55,
        ease: "power2.in",
        onUpdate: () => {
          drop.rotation += 0.2;
        },
        onComplete: () => drop.destroy(),
      });
    }
  }

  recover(): gsap.core.Timeline {
    this.pose("neutral");
    const tl = gsap.timeline();
    tl.add(() => this.squash(0.08));
    tl.to(this.holder, { y: 0, rotation: 0, duration: 0.3, ease: "back.out(2)" });
    return tl;
  }

  sleep(): void {
    this.state = "sleeping";
    this.express("sleep", 0);
    gsap.to(this.holder, { rotation: 0.08, duration: 0.8, ease: "sine.inOut" });
    gsap.to(this.holder.scale, {
      y: this.holder.scale.y * 0.97,
      duration: 1.2,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
    });
  }

  wake(): gsap.core.Timeline {
    this.state = "reacting";
    this.express("wide", 0.8);
    const tl = gsap.timeline();
    tl.to(this.holder, { rotation: 0, duration: 0.25, ease: "back.out(3)" });
    tl.add(() => this.hop(8, 1), 0);
    return tl;
  }

  argue(): gsap.core.Timeline {
    this.express("squint", 1.5);
    const tl = gsap.timeline();
    tl.to(this.holder, {
      rotation: -0.09,
      duration: 0.18,
      yoyo: true,
      repeat: 3,
      ease: "sine.inOut",
    });
    return tl;
  }

  shrug(): gsap.core.Timeline {
    this.express("squint", 1.0);
    const tl = gsap.timeline();
    tl.to(this.holder.scale, {
      y: this.holder.scale.y * 1.05,
      duration: 0.25,
      ease: "back.out(1.6)",
      yoyo: true,
      repeat: 1,
    });
    tl.to(this.holder, { skewX: 0.05, duration: 0.25 }, 0);
    tl.to(this.holder, { skewX: 0, duration: 0.3 }, "+=0.6");
    return tl;
  }

  push(): gsap.core.Timeline {
    this.state = "working";
    const tl = gsap.timeline();
    tl.to(this.holder, { rotation: 0.22, duration: 0.2 });
    tl.to(this.holder, { x: 2, duration: 0.08, yoyo: true, repeat: 8, ease: "steps(1)" });
    tl.to(this.holder, { rotation: 0, x: 0, duration: 0.3 });
    return tl;
  }

  drink(): gsap.core.Timeline {
    const tl = gsap.timeline();
    tl.to(this.holder, { rotation: -0.12, duration: 0.3 }, 0);
    tl.to(this.holder, { rotation: 0, duration: 0.4 }, "+=0.8");
    return tl;
  }

  tiltHead(): gsap.core.Timeline {
    this.express("squint", 1.2);
    const tl = gsap.timeline();
    tl.to(this.holder, { rotation: 0.14, duration: 0.3, ease: "sine.inOut" });
    tl.to(this.holder, { rotation: 0, duration: 0.4 }, "+=0.8");
    return tl;
  }

  // -------------------------------------------------------------- props

  /**
   * Carry a loose prop (dossier, coffee, papers, trade-md). Poses that
   * already bake the carried object (worker-crate) must NOT also attach a
   * duplicate sprite — use pose("crate") there instead.
   */
  carry(prop: Sprite): void {
    this.dropProp();
    prop.anchor.set(0.5, 1);
    prop.position.set(this.body.width * 0.28 * this.facing, -this.bodyH * 0.38);
    this.holder.addChild(prop);
    this.carried = prop;
    this.state = "carrying";
  }

  dropProp(): void {
    if (this.carried) {
      this.carried.destroy();
      this.carried = null;
    }
  }

  /** Detach the carried prop into the world at the agent's feet. */
  placeProp(): Sprite | null {
    const prop = this.carried;
    if (!prop) return null;
    this.carried = null;
    prop.destroy();
    return null;
  }

  dispose(): void {
    this.destroyed = true;
    this.walkBob?.kill();
    this.activeTimeline?.kill();
    gsap.killTweensOf([this.container, this.holder, this.holder.scale, this.body]);
    this.container.destroy({ children: true });
  }
}

/**
 * Five barely-different warm/cool near-whites, hash-stable per agent id.
 * Deliberately a shade below pure white (phase-8 gate finding: the painted
 * sprites read slightly brighter/more saturated than the plate, so the
 * variance tints double as a gentle warm tone-down that keeps them in the
 * plate's light without any heavy filter).
 */
function varianceTint(id: string): number {
  const tints = [0xf2ede2, 0xefe9db, 0xe9ebee, 0xf1ebdf, 0xece7da];
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return tints[Math.abs(hash) % tints.length];
}
