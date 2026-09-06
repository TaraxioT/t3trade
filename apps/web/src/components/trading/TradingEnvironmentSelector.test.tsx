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

describe("TradingEnvironmentSelector (07A/RC05)", () => {
  it("renders a static identity label, visibly naming label AND id, when only one environment exists", () => {
    const html = renderToStaticMarkup(
      <TradingEnvironmentSelector
        environments={[environment("env_a", "Local testnet")]}
        environmentId={"env_a" as EnvironmentId}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('data-testid="trading-environment-label"');
    expect(html).toContain("Local testnet");
    // The id is visible text, not a title tooltip (RC05): same-label
    // environments stay distinguishable.
    expect(html).toContain("env_a");
    expect(html).not.toContain('title="env_a"');
    // No dropdown to open when there is nothing to choose.
    expect(html).not.toContain('data-testid="trading-environment-selector"');
  });

  it("offers an explicit recovery action when the selected environment vanished and one remains", () => {
    const html = renderToStaticMarkup(
      <TradingEnvironmentSelector
        environments={[environment("env_b", "Relay box")]}
        environmentId={"env_a" as EnvironmentId}
        onSelect={() => {}}
      />,
    );

    // The vanished identity stays named, and the single remaining entry is a
    // working choice — not a static label hiding the only way forward (RC05).
    expect(html).toContain("env_a");
    expect(html).toContain("is no longer available");
    expect(html).toContain('data-testid="trading-environment-use-remaining"');
    expect(html).toContain("Use Relay box (env_b)");
    // A native button: keyboard reachable by construction.
    expect(html).toContain("<button");
  });

  it("names the retained destination when no entries remain", () => {
    const html = renderToStaticMarkup(
      <TradingEnvironmentSelector
        environments={[]}
        environmentId={"env_a" as EnvironmentId}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain("env_a");
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
