/**
 * Interpreters' Row: agents approach the Codex/Claude/Cursor/Grok/OpenCode
 * booths, emit a tiny symbol bubble, and the adapter answers with the
 * common town glyph T3 (spec §24). No paragraphs — translation is shown,
 * not told.
 */
import gsap from "gsap";
import type { DirectorEvent } from "../types";
import { BUBBLE_WORDS } from "../config";
import { PLACES } from "../config/positions";
import type { Pt } from "../config/positions";

// Round 5 surface audit: only these booth stands are on verified floor
// (the Cursor/Grok facades have no walkable apron — customers use the
// east boothLane approach instead).
const BOOTHS: Pt[] = [PLACES.boothCodex, PLACES.boothClaude, PLACES.boothOpenCode];

export function interpretersEvent(): DirectorEvent {
  return {
    id: "interpreters.request",
    zone: "interpreters",
    actors: 1,
    actorKind: "wanderer",
    priority: 4,
    cooldownSec: 6,
    minIntervalSec: 12,
    maxIntervalSec: 30,
    weight: 6,
    reducedMotionOk: true,
    soundCategory: "character",
    run: (ctx, agents) => {
      const agent = agents[0];
      const booth = BOOTHS[Math.floor(Math.random() * BOOTHS.length)];
      // Painted interpreter staff work BEHIND the counters (i1); the
      // visiting customer approaches the front. Baked booth customers stay.
      const staff = ctx.agents.find((a) => a.id === "i1");
      // Round 4: customers approach along the east booth lane so the walk
      // never cuts through the observatory population core.
      const tl = agent.walkTo([PLACES.boothLane, booth]);
      tl.eventCallback("onComplete", () => {
        const glyph = ctx.pick(BUBBLE_WORDS.glyphs);
        ctx.audio.play("chirp", "character", agent.container.position);
        ctx.bubbles.show(glyph, { x: agent.x, y: agent.headTop });
        agent.express("neutral", 0);
        agent.lookAt(booth.x, booth.y - 60);
        staff?.type();
        gsap.delayedCall(1.4, () => {
          // The adapter responds: the symbol resolves to the town glyph.
          ctx.bubbles.show(ctx.pick(BUBBLE_WORDS.translated), { x: booth.x, y: booth.y - 58 });
          ctx.audio.play("ping", "character", booth);
          agent.express("happy", 1);
          gsap.delayedCall(1.2, () => agent.walkTo([PLACES.boothClaude, PLACES.centralFloor]));
        });
      });
      return 9;
    },
  };
}
