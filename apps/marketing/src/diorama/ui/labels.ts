/**
 * District banners over the world. Owner: UI worker.
 *
 * One banner sign per district (except "external": world/hyperliquid.ts
 * already builds its own). Banners dim to alpha 0.35 while a station is in
 * focus; interaction calls setBannersDim.
 *
 * Banners are lod "always" (wayfinding never declutters) and carry explicit
 * anchors tuned so each banner clears its district's stations at fit zoom.
 * The module also drives sign LOD: it subscribes to the camera's throttled
 * zoom broadcast and maps zoom tiers to setSignLod.
 */
import gsap from "gsap";
import { DISTRICTS } from "../config/stations.js";
import type { DioramaContext } from "../core/context.js";
import { DEPTH } from "../config/world.js";
import { lodLevelForZoom, onWorldZoom } from "../core/camera.js";
import { makeSign, setSignLod } from "../core/signs.js";

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

    if (def.id === "mcp") {
      // The provider booths sit at the district's top edge and their booth
      // frames rise well above the footprint; lift the banner clear of both
      // the frames and the PROVIDERS station sign.
      y = def.bounds.y1 - 96;
    }
    if (def.id === "ops") {
      // The EVENT BUS (railYard, anchor 720/965 with its sign near y 925)
      // collides with a district-center banner. Shift the banner east and
      // up so it sits over the observability gap, clear of every ops
      // station sign at fit zoom.
      x = 1060;
      y = def.bounds.y1 - 56;
    }

    const banner = makeSign(def.title, { x, y, size: "lg", accent: def.accent, halo: true, lod: "always" });
    banner.zIndex = def.bounds.y1 + DEPTH.overlay;
    ctx.layers.labels.addChild(banner);
    banners.push(banner);
  }

  if (dimmed) {
    for (const banner of banners) banner.alpha = 0.35;
  }

  // Semantic-zoom LOD: camera tier -> sign visibility tiers. The broadcast
  // replays the current zoom immediately, so the initial frame is correct.
  const offZoom = onWorldZoom((zoom) => {
    setSignLod(lodLevelForZoom(zoom));
  });

  ctx.onCleanup(() => {
    offZoom();
    for (const banner of banners) gsap.killTweensOf(banner);
    banners.length = 0;
  });
}
