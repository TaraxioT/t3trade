/**
 * Section banners over the one-room diorama. Owner: UI worker.
 *
 * Three banners for the three sections. The two back-section banners
 * (research, risk) mount on the cutaway room's back walls with a short rail
 * chord that runs along the wall plane behind the board; the floor banner
 * floats at the open north mouth per the floating-banner convention.
 *
 * Banners are lod "always" (wayfinding never declutters) and dim to alpha
 * 0.35 while a station is in focus; interaction calls setBannersDim. The
 * module also drives sign LOD: it subscribes to the camera's throttled zoom
 * broadcast and maps zoom tiers to setSignLod.
 */
import gsap from "gsap";
import { Graphics } from "pixi.js";
import { DISTRICTS, type DistrictId } from "../config/stations.js";
import { PALETTE } from "../config/palette.js";
import type { DioramaContext } from "../core/context.js";
import { DEPTH } from "../config/world.js";
import { lodLevelForZoom, onWorldZoom } from "../core/camera.js";
import { makeSign, setSignLod } from "../core/signs.js";

/**
 * Wall-plane chord the mount rail is drawn along: a point on the wall
 * (face or top rim) plus the unit direction of the wall's base edge. The
 * 2:1 iso walls run at slope +/-0.5, so the edge units are (2, -+1)/sqrt(5).
 */
interface WallMount {
  /** Point on the wall plane the rail chord passes through (world units). */
  railX: number;
  railY: number;
  /** Unit vector along the wall base edge. */
  ux: number;
  uy: number;
  /** Rail half-length in world units. */
  halfLen: number;
}

interface BannerMount {
  /** Board center (world units). */
  x: number;
  y: number;
  /** Wall treatment; omit for the floating floor banner. */
  wall?: WallMount;
}

/**
 * Frozen banner mounts (layout-decision §2, tuned for relief clearance).
 *
 * research (420,458): west of the market-landscape relief on the N-W wall.
 * The relief owns the wall band (620,530)-(1060,310) with its backing slab
 * reaching world x >= ~606, y <= ~537; a banner centered at x 420 keeps its
 * board (x 248..592, y 437..479) 13 units west of the slab tip and 33 units
 * above the wall's top rim (rim y = (1444 - x)/2 = 512 at x 420), clear of
 * every west station sign below. Its rail chord lies ON the top rim.
 *
 * floor (1435,290): floating at the north mouth, straight above the dais and
 * below the page's hint-pill band.
 *
 * risk (2160,330): the N-E wall face is fully occupied by station signs
 * (port 1810, stateStore 1965, permission 2000, budgetMeter 2220,
 * signerVault 2395), so the board floats in the void band above the wall
 * cap (cap top edge y = (x-1372)/2; 398 at x 2160) with its mount rail on
 * the cap itself. Board spans x 1827..2493, y 309..351; the west tip
 * crosses the cap line where the wall rises toward the N corner, which
 * reads as anchored. Every station sign sits below y 415: clear.
 */
const BANNER_MOUNTS: Record<DistrictId, BannerMount> = {
  research: {
    x: 420,
    y: 415,
    wall: { railX: 420, railY: 512, ux: 0.894427, uy: -0.447214, halfLen: 200 },
  },
  floor: { x: 1435, y: 290 },
  risk: {
    x: 2160,
    y: 330,
    wall: { railX: 2160, railY: 398, ux: 0.894427, uy: 0.447214, halfLen: 235 },
  },
};

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

/**
 * Draw the wall-mount rail behind a banner board: one diagonal chord along
 * the wall plane with bolt caps on both tips. The horizontal board hides the
 * chord's middle, so the tips read as short arms angling back to the wall.
 */
function addWallMount(
  banner: ReturnType<typeof makeSign>,
  mount: WallMount,
  accent: number,
): void {
  // Local frame: the chord point relative to the board center.
  const lx = mount.railX - banner.x;
  const ly = mount.railY - banner.y;
  const tx = mount.ux * mount.halfLen;
  const ty = mount.uy * mount.halfLen;
  const g = new Graphics();
  g.moveTo(lx - tx, ly - ty);
  g.lineTo(lx + tx, ly + ty);
  g.stroke({ width: 3, color: PALETTE.structureLight, alpha: 0.95 });
  for (const s of [-1, 1]) {
    g.rect(lx + s * tx - 2.5, ly + s * ty - 2.5, 5, 5);
    g.fill({ color: accent, alpha: 0.9 });
  }
  banner.addChildAt(g, 0);
}

export function buildDistrictBanners(ctx: DioramaContext): void {
  banners.length = 0;
  // Fresh visits start undimmed even if the previous visit was torn down
  // while a station was in focus (module state persists across routes).
  dimmed = false;

  for (const def of Object.values(DISTRICTS)) {
    const mount = BANNER_MOUNTS[def.id];
    const banner = makeSign(def.title, {
      x: mount.x,
      y: mount.y,
      size: "lg",
      accent: def.accent,
      halo: true,
      lod: "always",
    });
    if (mount.wall) addWallMount(banner, mount.wall, def.accent);
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
