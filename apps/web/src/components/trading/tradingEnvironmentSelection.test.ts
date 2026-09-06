import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  __resetTradingEnvironmentSelectionForTests,
  initializeTradingEnvironmentDestination,
  resolveInitialTradingEnvironmentId,
  resolveTradingEnvironmentGate,
  setTradingEnvironmentId,
} from "./tradingEnvironmentSelection";

const env = (id: string) => id as EnvironmentId;

describe("resolveInitialTradingEnvironmentId (07A)", () => {
  it("prefers the primary environment when the catalog holds it", () => {
    expect(
      resolveInitialTradingEnvironmentId({
        primaryEnvironmentId: env("b"),
        environmentIds: [env("a"), env("b")],
      }),
    ).toBe(env("b"));
  });

  it("falls back to the sole entry when the primary is absent from the catalog", () => {
    expect(
      resolveInitialTradingEnvironmentId({
        primaryEnvironmentId: env("gone"),
        environmentIds: [env("a")],
      }),
    ).toBe(env("a"));
  });

  it("requires an explicit choice for several entries with no valid primary", () => {
    expect(
      resolveInitialTradingEnvironmentId({
        primaryEnvironmentId: env("gone"),
        environmentIds: [env("a"), env("b")],
      }),
    ).toBeNull();
    expect(
      resolveInitialTradingEnvironmentId({
        primaryEnvironmentId: null,
        environmentIds: [env("a"), env("b")],
      }),
    ).toBeNull();
  });
});

describe("resolveTradingEnvironmentGate (RC05)", () => {
  it("before the catalog is ready there is no destination to route to", () => {
    expect(
      resolveTradingEnvironmentGate({
        destinationId: null,
        initialChoiceComplete: false,
        environmentIds: [env("a")],
        catalogReady: false,
      }),
    ).toEqual({ state: "loading" });
  });

  it("a ready catalog whose one-time latch has not run yet is still loading", () => {
    expect(
      resolveTradingEnvironmentGate({
        destinationId: null,
        initialChoiceComplete: false,
        environmentIds: [env("a")],
        catalogReady: true,
      }),
    ).toEqual({ state: "loading" });
  });

  it("no catalog entries means no environments, even with a retained destination", () => {
    expect(
      resolveTradingEnvironmentGate({
        destinationId: env("kept"),
        initialChoiceComplete: true,
        environmentIds: [],
        catalogReady: true,
      }),
    ).toEqual({ state: "no-environments" });
  });

  it("a completed initialization without a destination requires an explicit choice", () => {
    expect(
      resolveTradingEnvironmentGate({
        destinationId: null,
        initialChoiceComplete: true,
        environmentIds: [env("a"), env("b")],
        catalogReady: true,
      }),
    ).toEqual({ state: "choose" });
  });

  it("a destination present in the catalog is selected; a vanished one is unavailable", () => {
    expect(
      resolveTradingEnvironmentGate({
        destinationId: env("a"),
        initialChoiceComplete: true,
        environmentIds: [env("a"), env("b")],
        catalogReady: true,
      }),
    ).toEqual({ state: "selected", environmentId: env("a") });
    expect(
      resolveTradingEnvironmentGate({
        destinationId: env("gone"),
        initialChoiceComplete: true,
        environmentIds: [env("a"), env("b")],
        catalogReady: true,
      }),
    ).toEqual({ state: "unavailable", environmentId: env("gone") });
  });
});

describe("the session-scoped destination store (RC05)", () => {
  it("latches the primary once and never re-derives it", () => {
    __resetTradingEnvironmentSelectionForTests();

    const first = initializeTradingEnvironmentDestination({
      primaryEnvironmentId: env("primary"),
      environmentIds: [env("primary"), env("other")],
    });
    expect(first).toEqual({ destinationId: env("primary"), initialChoiceComplete: true });

    // A later primary or catalog change is not a selection event.
    const after = initializeTradingEnvironmentDestination({
      primaryEnvironmentId: env("other"),
      environmentIds: [env("other")],
    });
    expect(after.destinationId).toBe(env("primary"));
  });

  it("a sole entry latches; several entries with no primary latch to an explicit choice required", () => {
    __resetTradingEnvironmentSelectionForTests();
    expect(
      initializeTradingEnvironmentDestination({
        primaryEnvironmentId: null,
        environmentIds: [env("only")],
      }).destinationId,
    ).toBe(env("only"));

    __resetTradingEnvironmentSelectionForTests();
    expect(
      initializeTradingEnvironmentDestination({
        primaryEnvironmentId: null,
        environmentIds: [env("a"), env("b")],
      }),
    ).toEqual({ destinationId: null, initialChoiceComplete: true });
  });

  it("an explicit choice is authoritative and itself completes the initialization", () => {
    __resetTradingEnvironmentSelectionForTests();
    setTradingEnvironmentId(env("other"));
    // The automatic latch afterwards cannot revisit or overwrite the choice.
    expect(
      initializeTradingEnvironmentDestination({
        primaryEnvironmentId: env("primary"),
        environmentIds: [env("primary"), env("other")],
      }).destinationId,
    ).toBe(env("other"));

    // The choice survives catalog churn — reorder, removal, empty — and the
    // gate says unavailable/no-environments rather than switching.
    expect(
      resolveTradingEnvironmentGate({
        destinationId: env("other"),
        initialChoiceComplete: true,
        environmentIds: [env("a")],
        catalogReady: true,
      }),
    ).toEqual({ state: "unavailable", environmentId: env("other") });
  });

  it("a cleared destination keeps the session out of automatic-selection mode until reset", () => {
    __resetTradingEnvironmentSelectionForTests();
    setTradingEnvironmentId(env("a"));
    setTradingEnvironmentId(null);
    expect(
      initializeTradingEnvironmentDestination({
        primaryEnvironmentId: env("primary"),
        environmentIds: [env("primary")],
      }),
    ).toEqual({ destinationId: null, initialChoiceComplete: true });

    __resetTradingEnvironmentSelectionForTests();
    expect(
      resolveTradingEnvironmentGate({
        destinationId: null,
        initialChoiceComplete: false,
        environmentIds: [],
        catalogReady: false,
      }),
    ).toEqual({ state: "loading" });
  });
});
