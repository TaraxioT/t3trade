/**
 * The trading surfaces' environment selector (07A, RC05): names the environment
 * the Trade tab is trading on, and lets the user change it when several exist.
 * With one environment it renders as a static label — the identity (label and
 * environment id) is still visible, but there is nothing to choose.
 *
 * RC05: when the selected environment vanished and exactly one other remains,
 * the static label is not enough — the selector would become a dead end with
 * no way to recover onto the remaining entry. That case renders an explicit
 * `Use <label> (<id>)` action instead of hiding the choice.
 *
 * @module TradingEnvironmentSelector
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { MonitorIcon } from "lucide-react";

import type { EnvironmentPresentation } from "../../state/environments";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

export function TradingEnvironmentSelector({
  environments,
  environmentId,
  onSelect,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
  environmentId: EnvironmentId | null;
  onSelect: (environmentId: EnvironmentId) => void;
}) {
  if (environments.length <= 1) {
    const single = environments[0] ?? null;
    // The requested destination is not the one remaining entry: it vanished.
    // Name it, and offer the one working recovery instead of a static label.
    const unavailable =
      environmentId !== null && (single === null || single.environmentId !== environmentId);
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="trading-environment-label"
      >
        <MonitorIcon className="size-3 shrink-0" />
        {unavailable && single !== null ? (
          <>
            <span className="truncate">{environmentId} is no longer available.</span>
            <button
              type="button"
              className="shrink-0 rounded-sm px-1 font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              data-testid="trading-environment-use-remaining"
              onClick={() => onSelect(single.environmentId)}
            >
              Use {single.label} ({single.environmentId})
            </button>
          </>
        ) : (
          <>
            <span className="truncate">
              {single?.label ?? environmentId ?? "Trading environment"}
            </span>
            {single !== null ? (
              <span className="truncate text-muted-foreground opacity-70">
                {single.environmentId}
              </span>
            ) : null}
          </>
        )}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={environmentId ?? undefined}
      onValueChange={(value) => onSelect(value as EnvironmentId)}
      items={environments.map((environment) => ({
        value: environment.environmentId,
        label: environment.label,
      }))}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="min-w-0 font-medium"
        aria-label="Trading environment"
        data-testid="trading-environment-selector"
      >
        <MonitorIcon className="size-3 shrink-0" />
        <SelectValue placeholder="Choose an environment" />
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Trading environment</SelectGroupLabel>
          {environments.map((environment) => (
            <SelectItem key={environment.environmentId} value={environment.environmentId}>
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {environment.label}
                <span className="truncate text-muted-foreground">{environment.environmentId}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}
