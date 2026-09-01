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
  // Fresh visits start undimmed even if the previous visit was torn down
  // while a station was in focus (module state persists across routes).
  dimmed = false;

  for (const def of Object.values(DISTRICTS)) {
    if (def.id === "external") continue; // built by world/hyperliquid.ts

    let x = def.center.x;
    let y = def.bounds.y1 - 28;

    if (def.id === "ops") {
      // Two constraints at fit zoom: the EVENT BUS sign (railYard anchor
      // 720/965, sign near y 925) and the trading floor disc's southwest
      // rim, which reaches west to about x 1115 at this latitude. A banner
      // at x 800 clears the rim by ~300 units and hovers open ops floor
      // north of the event bus instead of straddling the floor seam.
      x = 800;
      y = def.bounds.y1 - 56;
    }

    if (def.id === "risk") {
      // The default spot straddles the MCP district seam over the MCP
      // HEALTH sign; anchor the banner over the district's own approval
      // and permission row instead.
      x = 1905;
      y = def.bounds.y1 + 16;
    }

    const banner = makeSign(def.title, {
      x,
      y,
      size: "lg",
      accent: def.accent,
      halo: true,
      lod: "always",
    });
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
    dimmed = false;
  });
}
