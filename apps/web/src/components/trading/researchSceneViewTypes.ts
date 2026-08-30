/** Local structural types for the pure presentation module (no schema import weight). */
import type {
  DeterministicSceneLayer,
  EventStudyScenePayload,
  ResearchSceneView,
} from "@t3tools/contracts";

export type { DeterministicSceneLayer, EventStudyScenePayload, ResearchSceneView };

/** The candle shape the windowed chart read returns. */
export interface TradingChartCandleLike {
  readonly openTime: number;
  readonly open: number;
  readonly close: number;
}
