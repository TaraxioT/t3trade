/**
 * District banners over the world. Owner: UI worker.
 *
 * One banner sign per district (except "external": world/hyperliquid.ts
 * already builds its own). Banners dim to alpha 0.35 while a station is in
 * focus; interaction calls setBannersDim.
 */
import gsap from "gsap";
import { DISTRICTS } from "../config/stations.js";
import type { DioramaContext } from "../core/context.js";
import { DEPTH } from "../config/world.js";
import { makeSign } from "../core/signs.js";

const banners: ReturnType<typeof makeSign>[] = [];
let dimmed = false;

/** Dim banners for station focus, restore on selection clear. */
export function setBannersDim(dim: boolean): void {
  if (dim === dimmed) return;
  dimmed = dim;
  for (const banner of banners) {
    gsap.to(banner, { alpha: dim ? 0.35 : 1, duration: 0.35, ease: "power1.out", overwrite: true });
  }
}

export function buildDistrictBanners(ctx: DioramaContext): void {
  banners.length = 0;

  for (const def of Object.values(DISTRICTS)) {
    if (def.id === "external") continue; // built by world/hyperliquid.ts
    if (def.id === "supervisor") continue; // the HUMAN SUPERVISOR station
    // sign below the deck carries this zone; a banner here stacks on the
    // TRADING FLOOR rim sign.

    let x = def.center.x;
    let y = def.bounds.y1 - 28;
    let size: "lg" | "md" = "lg";

    if (def.id === "mcp") {
      // The provider booths sit at the district's top edge with their own
      // labels at anchor y - 46; lift the banner clear above them.
      y = def.bounds.y1 - 64;
    }

    const banner = makeSign(def.title, { x, y, size, accent: def.accent, halo: true });
    banner.zIndex = def.bounds.y1 + DEPTH.overlay;
    ctx.layers.labels.addChild(banner);
    banners.push(banner);
  }

  if (dimmed) {
    for (const banner of banners) banner.alpha = 0.35;
  }

  ctx.onCleanup(() => {
    for (const banner of banners) gsap.killTweensOf(banner);
    banners.length = 0;
  });
}
