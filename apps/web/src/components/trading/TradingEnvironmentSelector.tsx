/**
 * The trading surfaces' environment selector (07A): names the environment the
 * Trade tab is trading on, and lets the user change it when several exist.
 * With one environment it renders as a static label — the identity is still
 * visible, but there is nothing to choose.
 *
 * @module TradingEnvironmentSelector
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { MonitorIcon } from "lucide-react";
import { useMemo } from "react";

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
  const active = useMemo(
    () => environments.find((environment) => environment.environmentId === environmentId) ?? null,
    [environments, environmentId],
  );

  if (environments.length <= 1) {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="trading-environment-label"
        title={active?.environmentId ?? environmentId ?? undefined}
      >
        <MonitorIcon className="size-3 shrink-0" />
        {active?.label ?? "Trading environment"}
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
