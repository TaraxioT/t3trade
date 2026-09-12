/**
 * The dataset-scoped candle read for Graph-priced research scenes.
 *
 * Where `tradingMarketChartState` reads the Hyperliquid archive, this reads
 * ONE immutable retained Graph dataset through `getTradingGraphDatasetCandles`
 * — the same prices a `the-graph` study measured, never the exchange's record
 * of the market. The dataset cannot change under the read (retained evidence
 * is write-once per id), so this is a windowed one-shot: no poll, and a failed
 * read is an error state, not a retained view to keep drawing.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  TradingChartInterval,
  TradingGraphDatasetCandlesView,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import type { ChartWindow } from "./tradingMarketChartState";

/** Same candle vocabulary the market-chart state owns; one set of names. */
export type { ChartInterval, ChartWindow } from "./tradingMarketChartState";

/**
 * The sentinel atom used while no dataset identity is in hand. It holds an
 * `Initial` result so `data` reads null and nothing is read off the wire —
 * the same trick `tradingMarketChartState` plays with its disabled chart,
 * kept here so `useAtomValue` stays unconditional (rules of hooks).
 */
const NO_DATASET_ATOM = Atom.make(AsyncResult.initial<TradingGraphDatasetCandlesView>());

export interface TradingGraphDatasetCandlesState {
  readonly data: TradingGraphDatasetCandlesView | null;
  readonly error: string | null;
  readonly isLoading: boolean;
}

/**
 * Candles of one retained Graph dataset, bounded to a window (typically one
 * occurrence's measured span).
 *
 * `datasetId` null disables the read (the caller renders its own named state
 * for that). `options.window` bounds the served bars by epoch millis exactly
 * like the archive chart's windowed post-mortem read; omitted means the
 * dataset's full span. `options.maxBars` is a request the server clamps.
 *
 * Explicit states, no fallbacks: `data` non-null with an empty `candles` array
 * is a REAL answer (no swaps bucketed in the window — sparse stays sparse),
 * which the caller renders as its own empty sentence; `error` non-null is a
 * failed read and nothing is retained in its place. There is never a fallback
 * to the market chart from inside this hook.
 */
export function useTradingGraphDatasetCandles(
  environmentId: EnvironmentId,
  datasetId: string | null,
  interval: TradingChartInterval,
  options: {
    readonly window?: ChartWindow;
    readonly maxBars?: number;
  },
): TradingGraphDatasetCandlesState {
  const windowStart = options.window?.startTime ?? null;
  const windowEnd = options.window?.endTime ?? null;
  const maxBars = options.maxBars ?? null;

  // Keyed by the window's numbers, not object identity, so a caller rebuilding
  // the literal each render does not thrash the family entry.
  const atom = useMemo(() => {
    if (datasetId === null) {
      return NO_DATASET_ATOM;
    }
    return orchestrationEnvironment.tradingGraphDatasetCandles({
      environmentId,
      input: {
        datasetId,
        interval,
        ...(windowStart === null || windowEnd === null
          ? {}
          : { startTime: windowStart, endTime: windowEnd }),
        ...(maxBars === null ? {} : { maxBars }),
      },
    });
  }, [environmentId, datasetId, interval, windowStart, windowEnd, maxBars]);

  const result = useAtomValue(atom);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: AsyncResult.isFailure(result) ? "Failed to load the dataset candles." : null,
    isLoading: result.waiting,
  };
}
