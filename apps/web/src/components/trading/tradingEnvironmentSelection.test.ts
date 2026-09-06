import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  __resetTradingEnvironmentSelectionForTests,
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

describe("resolveTradingEnvironmentGate (07A)", () => {
  it("no catalog entries means no environments", () => {
    expect(
      resolveTradingEnvironmentGate({
        selectedEnvironmentId: null,
        primaryEnvironmentId: env("a"),
        environmentIds: [],
      }),
    ).toEqual({ state: "no-environments" });
  });

  it("an explicit selection wins over the primary", () => {
    expect(
      resolveTradingEnvironmentGate({
        selectedEnvironmentId: env("a"),
        primaryEnvironmentId: env("b"),
        environmentIds: [env("a"), env("b")],
      }),
    ).toEqual({ state: "selected", environmentId: env("a") });
  });

  it("a vanished selection is unavailable, never a silent fallback to the primary", () => {
    expect(
      resolveTradingEnvironmentGate({
        selectedEnvironmentId: env("gone"),
        primaryEnvironmentId: env("b"),
        environmentIds: [env("a"), env("b")],
      }),
    ).toEqual({ state: "unavailable", environmentId: env("gone") });
  });

  it("no selection and no valid primary over several entries requires a choice", () => {
    expect(
      resolveTradingEnvironmentGate({
        selectedEnvironmentId: null,
        primaryEnvironmentId: null,
        environmentIds: [env("a"), env("b")],
      }),
    ).toEqual({ state: "choose" });
  });

  it("no selection over a sole entry selects it", () => {
    expect(
      resolveTradingEnvironmentGate({
        selectedEnvironmentId: null,
        primaryEnvironmentId: null,
        environmentIds: [env("a")],
      }),
    ).toEqual({ state: "selected", environmentId: env("a") });
  });
});

describe("the session-scoped selection store (07A)", () => {
  it("an explicit set flows through the gate and reset restores the unset state", () => {
    __resetTradingEnvironmentSelectionForTests();
    const catalog = {
      primaryEnvironmentId: env("primary"),
      environmentIds: [env("primary"), env("other")],
    };

    // Unset: the primary is the implicit selection.
    expect(resolveTradingEnvironmentGate({ ...catalog, selectedEnvironmentId: null })).toEqual({
      state: "selected",
      environmentId: env("primary"),
    });

    // An explicit choice is authoritative…
    setTradingEnvironmentId(env("other"));
    expect(
      resolveTradingEnvironmentGate({ ...catalog, selectedEnvironmentId: env("other") }),
    ).toEqual({ state: "selected", environmentId: env("other") });

    // …and reset returns to the implicit primary selection.
    __resetTradingEnvironmentSelectionForTests();
    expect(resolveTradingEnvironmentGate({ ...catalog, selectedEnvironmentId: null })).toEqual({
      state: "selected",
      environmentId: env("primary"),
    });
  });
});
