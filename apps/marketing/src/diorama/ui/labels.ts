/**
 * Section banners over the one-room diorama. Owner: UI worker.
 *
 * Three banners for the three sections. The two back-section banners
 * (research, risk) mount on the cutaway room's back walls with a short rail
 * chord that runs along the wall plane behind the board; the floor banner
 * floats at the open north mouth per the floating-banner convention.
 *
 * Banner policy (freeze cycle-4 §5, addendum item 15): banners are built with
 * makeBanner, which registers them UNMANAGED in core/signs — labels.ts is
 * their single alpha owner, so the sign focus logic never fights the dim
 * here. Banners are zoom-tier wayfinding: hidden at tier 0 so fit view shows
 * only the eight overview boards, shown from tier 1. They dim to alpha 0.35
 * while a station is in focus (interaction calls setBannersDim); the dim
 * composes with the tier rule, so clearing focus at tier 0 re-hides them.
 * Wall mounts and the floating floor mount are unchanged. The module also
 * drives sign LOD: it subscribes to the camera's throttled zoom broadcast and
 * maps zoom tiers to setSignLod.
 */
import gsap from "gsap";
import { Graphics } from "pixi.js";
import { DISTRICTS, type DistrictId } from "../config/stations.js";
import { PALETTE } from "../config/palette.js";
import type { DioramaContext } from "../core/context.js";
import { DEPTH } from "../config/world.js";
import { lodLevelForZoom, onWorldZoom } from "../core/camera.js";
import { makeBanner, setSignLod, type SignLodLevel } from "../core/signs.js";

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
 * The relief owns the wall band; a banner centered at x 420 keeps its board
 * clear of the slab tip and 33 units above the wall's top rim, clear of
 * every west station sign below. Its rail chord lies ON the top rim.
 *
 * floor (1435,290): floating at the north mouth, straight above the dais and
 * below the page's hint-pill band.
 *
 * risk (2160,330): the board floats in the void band above the wall cap
 * (cap top edge y = (x-1372)/2; 398 at x 2160) with its mount rail on the
 * cap itself. The west tip crosses the cap line where the wall rises toward
 * the N corner, which reads as anchored. Station signs sit below it.
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

const banners: ReturnType<typeof makeBanner>[] = [];
let dimmed = false;
let tier: SignLodLevel = 0;

const reducedMotion = (): boolean =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Banner alpha from the composed state: hidden at tier 0 (even while dimmed),
 * full at tier >= 1, dimmed while a station is focused.
 */
const bannerTarget = (): number => (tier >= 1 ? (dimmed ? 0.35 : 1) : 0);

function applyBanners(): void {
  const snap = reducedMotion();
  const target = bannerTarget();
  for (const banner of banners) {
    if (banner.parent === null) continue;
    if (snap) {
      gsap.killTweensOf(banner);
      banner.alpha = target;
    } else {
      gsap.to(banner, { alpha: target, duration: 0.35, ease: "power1.out", overwrite: true });
    }
  }
}

/** Dim banners for station focus, restore on selection clear. */
export function setBannersDim(dim: boolean): void {
  if (dim === dimmed) return;
  dimmed = dim;
  applyBanners();
}

/**
 * Draw the wall-mount rail behind a banner board: one diagonal chord along
 * the wall plane with bolt caps on both tips. The horizontal board hides the
 * chord's middle, so the tips read as short arms angling back to the wall.
 */
function addWallMount(
  banner: ReturnType<typeof makeBanner>,
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
  // Fresh visits start undimmed at the broadcast tier even if the previous
  // visit was torn down while focused (module state persists across routes).
  dimmed = false;

  for (const def of Object.values(DISTRICTS)) {
    const mount = BANNER_MOUNTS[def.id];
    // Unmanaged banner: core/signs never tweens its alpha; this module owns
    // the full rule (tier hiding + focus dim). Board is size xl with the
    // double accent rule per the frozen banner design.
    const banner = makeBanner(def.title, mount.x, mount.y, def.accent);
    if (mount.wall) addWallMount(banner, mount.wall, def.accent);
    banner.zIndex = def.bounds.y1 + DEPTH.overlay;
    ctx.layers.labels.addChild(banner);
    banners.push(banner);
  }

  // First frame: unmanaged entries keep their constructed alpha (1), and the
  // zoom replay below early-returns when the tier is unchanged (0 on a fresh
  // load), so snap the composed rule here or banners would show at tier 0.
  for (const banner of banners) banner.alpha = bannerTarget();

  // Semantic-zoom LOD: camera tier -> sign visibility tiers, plus the
  // tier half of the banner rule. The broadcast replays the current zoom
  // immediately, so the initial frame is correct.
  const offZoom = onWorldZoom((zoom) => {
    const next = lodLevelForZoom(zoom);
    if (next === tier) return;
    tier = next;
    setSignLod(tier);
    applyBanners();
  });

  ctx.onCleanup(() => {
    offZoom();
    for (const banner of banners) gsap.killTweensOf(banner);
    banners.length = 0;
    dimmed = false;
    tier = 0;
  });
}
