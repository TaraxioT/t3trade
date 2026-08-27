import { createFileRoute } from "@tanstack/react-router";

import { TradeHomePanel } from "../components/trading/TradeHomePanel";

export const Route = createFileRoute("/trade")({
  component: TradeHomePanel,
});
