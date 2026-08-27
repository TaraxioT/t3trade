/**
 * Who may read a market chart.
 *
 * The chart RPC must not become a free Hyperliquid proxy, so it serves only
 * markets this install is actually paying attention to. Two things entitle a
 * read: a mission on the market, and (final-form phase 6) the market being in
 * the follow set — held, armed, watchlisted, or recently charted. The
 * environment is the trust boundary (the mission snapshot RPC does not bind
 * to `currentSession.subject` either), so this checks the market against
 * those two lists and nothing more.
 *
 * The mission rule keeps its two shapes: the live chart requires a mission
 * that is currently running, while the post-mortem chart on a finished
 * mission's card is windowed and its mission is terminal by definition.
 * Refusing a terminal mission on the windowed path would refuse every review
 * chart there is. A followed market is entitled to both shapes — a manual
 * trader reviewing yesterday on a watchlisted market has no mission to point
 * at, and the follow set is the attention record that stands in for one.
 *
 * @module chartReadEntitlement
 */

/** The two statuses §11.1 calls permanent terminals. */
const TERMINAL_STATUSES = new Set(["revoked", "completed"]);

export interface ChartReadRequest {
  readonly market: string;
  /** Present on both bounds means a windowed (post-mortem) read. */
  readonly startTime?: number | undefined;
  readonly endTime?: number | undefined;
}

export interface ChartReadMission {
  readonly market: string;
  readonly status: string;
}

/** True when a windowed read was asked for: both bounds present. */
export function isReviewRead(request: ChartReadRequest): boolean {
  return request.startTime !== undefined && request.endTime !== undefined;
}

/**
 * Whether any of `missions`, or membership in `followedAssets`, entitles this
 * read.
 *
 * A review read is entitled by any mission on the market, terminal included;
 * a live read needs one that is still running. A followed asset entitles
 * either shape.
 */
export function isChartReadEntitled(
  request: ChartReadRequest,
  missions: ReadonlyArray<ChartReadMission>,
  followedAssets: ReadonlyArray<string> = [],
): boolean {
  if (followedAssets.includes(request.market)) return true;
  const review = isReviewRead(request);
  return missions.some((mission) => {
    if (mission.market !== request.market) return false;
    return review || !TERMINAL_STATUSES.has(mission.status);
  });
}
