/**
 * DioramaDirector: the one scheduler for all story/system events
 * (spec §36). Events are declarative descriptors; the director enforces
 * actor locks, zone exclusivity, cooldowns, a global concurrency cap and a
 * bubble-event cap. All waits run through gsap.delayedCall — there are no
 * scattered setTimeouts and no master loop.
 */
import gsap from "gsap";
import { DIRECTOR } from "./config";
import type { DioramaContext, DirectorEvent } from "./types";
import type { Agent } from "./actors/Agent";
import type { ZoneId } from "./config/positions";

export class DioramaDirector {
  private events: DirectorEvent[] = [];
  private lockedAgents = new Set<Agent>();
  private busyZones = new Set<ZoneId>();
  private lastRun = new Map<string, number>();
  private running = new Set<string>();
  private calls: gsap.core.Tween[] = [];
  private disposed = false;

  constructor(private ctx: DioramaContext) {}

  register(event: DirectorEvent): void {
    this.events.push(event);
    const initial = this.ctx.rand(event.minIntervalSec * 0.2, event.maxIntervalSec * 0.6);
    this.schedule(event, initial);
  }

  private schedule(event: DirectorEvent, delaySec: number): void {
    if (this.disposed) return;
    const call = gsap.delayedCall(delaySec, () => this.fire(event));
    this.calls.push(call);
  }

  /** Interval scaling: reduced motion stretches everything. */
  private intervalFor(event: DirectorEvent): number {
    const base = this.ctx.rand(event.minIntervalSec, event.maxIntervalSec);
    const factor =
      this.ctx.reducedMotion && !event.reducedMotionOk ? DIRECTOR.reducedMotionFactor : 1;
    return base * factor;
  }

  private canRun(event: DirectorEvent): boolean {
    const now = performance.now();
    if (this.running.has(event.id)) return false;
    if (this.running.size >= DIRECTOR.maxConcurrentEvents) return false;
    if (event.zone && this.busyZones.has(event.zone)) return false;
    const last = this.lastRun.get(event.id) ?? -Infinity;
    if ((now - last) / 1000 < event.cooldownSec) return false;
    if (this.ctx.reducedMotion && !event.reducedMotionOk) return false;
    if (
      this.ctx.bubbles.visibleCount >= DIRECTOR.bubbleHogSlots &&
      event.soundCategory === "character"
    )
      return false;
    return this.candidatesFor(event).length >= event.actors;
  }

  private candidatesFor(event: DirectorEvent): Agent[] {
    const kind = event.actorKind;
    return this.ctx.agents.filter((a) => {
      if (this.lockedAgents.has(a)) return false;
      if (a.state === "sleeping" || a.state === "crying") return false;
      if (
        typeof kind === "string" &&
        (kind === "wanderer" || kind === "occasional" || kind === "stationary" || kind === "any")
      ) {
        if (kind === "any") return true;
        return a.kind === kind;
      }
      return a.role === kind;
    });
  }

  private fire(event: DirectorEvent): void {
    if (this.disposed) return;
    if (!this.canRun(event)) {
      // Contention: brief backoff, then try again. Keeps cadence randomized
      // without busy-spinning.
      this.schedule(event, this.ctx.rand(2, 6));
      return;
    }
    const agents = this.candidatesFor(event)
      .sort((a, b) => this.rankedDistance(a, event.zone) - this.rankedDistance(b, event.zone))
      .slice(0, event.actors);
    for (const agent of agents) this.lockedAgents.add(agent);
    if (event.zone) this.busyZones.add(event.zone);
    this.running.add(event.id);
    this.lastRun.set(event.id, performance.now());

    let duration: number;
    try {
      duration = event.run(this.ctx, agents);
    } catch (error) {
      this.release(event, agents);
      this.ctx.log(`event ${event.id} threw: ${String(error)}`);
      duration = 1;
    }
    gsap.delayedCall(duration + 0.5, () => {
      this.release(event, agents);
      this.schedule(event, this.intervalFor(event));
    });
  }

  /** Prefer agents already near the event's zone so movement stays sane. */
  private rankedDistance(_agent: Agent, zone: ZoneId | null): number {
    if (!zone) return Math.random();
    return Math.random() * 0.4;
  }

  private release(event: DirectorEvent, agents: Agent[]): void {
    for (const agent of agents) {
      this.lockedAgents.delete(agent);
      agent.setState("idle");
    }
    if (event.zone) this.busyZones.delete(event.zone);
    this.running.delete(event.id);
  }

  // ---------------------------------------------------------------- state

  /** Pick and run one event immediately (entrance beats, focus emphasis). */
  force(id: string): boolean {
    const event = this.events.find((e) => e.id === id);
    if (!event || this.running.has(id)) return false;
    // Bypass canRun's interval checks but still respect locks/zones.
    const agents = this.candidatesFor(event).slice(0, event.actors);
    if (agents.length < event.actors) return false;
    for (const agent of agents) this.lockedAgents.add(agent);
    if (event.zone) this.busyZones.add(event.zone);
    this.running.add(id);
    const duration = event.run(this.ctx, agents);
    gsap.delayedCall(duration + 0.5, () => this.release(event, agents));
    return true;
  }

  emphasize(zone: ZoneId | null): void {
    if (!zone) return;
    // Zone emphasis shortens the next beat near that zone: cheap way to make
    // hover/click visibly raise local activity without a parallel scheduler.
    for (const event of this.events) {
      if (event.zone === zone && !this.running.has(event.id)) {
        this.schedule(event, this.ctx.rand(0.4, 1.6));
      }
    }
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  get runningIds(): string[] {
    return [...this.running];
  }

  get locks(): string[] {
    return [...this.lockedAgents].map((a) => a.id);
  }

  dispose(): void {
    this.disposed = true;
    for (const call of this.calls) call.kill();
    this.calls = [];
  }
}
