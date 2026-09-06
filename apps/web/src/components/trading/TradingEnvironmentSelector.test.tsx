import type { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentPresentation } from "../../state/environments";
import { TradingEnvironmentSelector } from "./TradingEnvironmentSelector";

const environment = (id: string, label: string): EnvironmentPresentation =>
  ({
    environmentId: id as EnvironmentId,
    label,
    displayUrl: null,
    relayManaged: false,
  }) as unknown as EnvironmentPresentation;

describe("TradingEnvironmentSelector (07A)", () => {
  it("renders a static identity label when only one environment exists", () => {
    const html = renderToStaticMarkup(
      <TradingEnvironmentSelector
        environments={[environment("env_a", "Local testnet")]}
        environmentId={"env_a" as EnvironmentId}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('data-testid="trading-environment-label"');
    expect(html).toContain("Local testnet");
    // No dropdown to open when there is nothing to choose.
    expect(html).not.toContain('data-testid="trading-environment-selector"');
  });

  it("renders a selector naming label and environment identifier when several exist", () => {
    const html = renderToStaticMarkup(
      <TradingEnvironmentSelector
        environments={[environment("env_a", "Local testnet"), environment("env_b", "Relay box")]}
        environmentId={"env_a" as EnvironmentId}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('data-testid="trading-environment-selector"');
    expect(html).toContain('aria-label="Trading environment"');
    // The trigger names the selected environment, and the underlying value
    // carries the environment identifier (popup items render in a portal, so
    // static markup cannot enumerate them).
    expect(html).toContain("Local testnet");
    expect(html).toContain('value="env_a"');
  });
});
