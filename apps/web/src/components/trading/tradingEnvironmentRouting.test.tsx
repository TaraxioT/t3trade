/**
 * Mounted routing tests for the trading environment selection (RC05).
 *
 * These mount a real component tree (fake DOM + react-dom/client + act) over a
 * controllable catalog and a recording environment-bound client, so the
 * behaviors that only exist across renders are proven — not just the pure
 * resolver:
 *
 * - nothing environment-bound mounts or queries before the catalog is ready;
 * - the initial destination is latched once and survives primary/catalog churn;
 * - an explicit selection survives removal, an empty catalog, and navigation
 *   between the two global pages;
 * - switching destinations remounts the environment-bound subtree (keyed), so
 *   a late response from the previous environment cannot land in the new one.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { useEffect, useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentPresentation } from "../../state/environments";
import { TradingEnvironmentSelector } from "./TradingEnvironmentSelector";
import {
  __resetTradingEnvironmentSelectionForTests,
  setTradingEnvironmentId,
  useTradingEnvironmentRouting,
} from "./tradingEnvironmentSelection";

// --- a controllable, reactive catalog -----------------------------------------

const mocks = vi.hoisted(() => {
  const state = {
    isReady: false,
    primaryEnvironmentId: null as string | null,
    environments: [] as Array<{ environmentId: string; label: string }>,
  };
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    state,
    setCatalog(next: Partial<typeof state>): void {
      Object.assign(state, next);
      version += 1;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
  };
});

vi.mock("~/state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  const useCatalog = () => {
    useSyncExternalStore(mocks.subscribe, mocks.getVersion);
    return mocks.state;
  };
  return {
    useEnvironments: () => {
      const catalog = useCatalog();
      return {
        environments: catalog.environments.map((entry) => ({
          environmentId: entry.environmentId,
          label: entry.label,
          displayUrl: null,
          relayManaged: false,
        })),
        isReady: catalog.isReady,
      };
    },
    usePrimaryEnvironmentId: () => useCatalog().primaryEnvironmentId as EnvironmentId | null,
  };
});

const environment = (id: string, label: string) => ({ environmentId: id, label });

// --- a recording environment-bound client --------------------------------------

interface BoundEvent {
  readonly environmentId: string;
  readonly kind: "mount" | "unmount";
}

const boundEvents: BoundEvent[] = [];

/**
 * The stand-in for every environment-bound query/control subtree: it records
 * its lifecycle per environment, so the test can see which environment's tree
 * is mounted at any moment and that a switch remounts rather than reuses.
 */
function EnvironmentBoundClient({ environmentId }: { environmentId: EnvironmentId }) {
  useEffect(() => {
    boundEvents.push({ environmentId, kind: "mount" });
    return () => {
      boundEvents.push({ environmentId, kind: "unmount" });
    };
  }, [environmentId]);
  return null;
}

// --- the consumer both global pages share ---------------------------------------

let observedGate = "unset";
let observedDestination: string | null = null;

function RoutingConsumer() {
  const { environments, gate, select } = useTradingEnvironmentRouting();
  observedGate = gate.state;
  observedDestination = gate.state === "selected" ? gate.environmentId : null;
  return (
    <div>
      {gate.state === "selected" ? (
        <EnvironmentBoundClient key={gate.environmentId} environmentId={gate.environmentId} />
      ) : null}
      {gate.state === "loading" ? null : (
        <TradingEnvironmentSelector
          environments={environments}
          environmentId={gate.state === "unavailable" ? gate.environmentId : null}
          onSelect={select}
        />
      )}
    </div>
  );
}

// --- the minimal DOM react-dom/client needs (the repo's PreviewView pattern) ----

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(_value: string) {
    this.childNodes = [];
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  createElementNS(_namespace: string, name: string) {
    return new TestNode(name, this);
  }

  createTextNode(_text: string) {
    return new TestNode("#text", this, 3);
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
  getAttribute() {
    return null;
  }
  hasAttribute() {
    return false;
  }
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLIFrameElement: TestNode,
    HTMLElement: TestNode,
    SVGElement: TestNode,
    Element: TestNode,
    Node: TestNode,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("SVGElement", window.SVGElement);
  vi.stubGlobal("Element", window.Element);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

/** Mount N consumers (the two global surfaces) and hand back a remount for navigation. */
async function withMountedConsumers(
  count: number,
  body: (remount: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const document = installTestDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.createElement("div") as unknown as Element);
  const mount = () =>
    act(() => {
      root.render(
        <>
          {Array.from({ length: count }, (_, index) => (
            <RoutingConsumer key={index} />
          ))}
        </>,
      );
    });
  try {
    await mount();
    await body(async () => {
      await act(() => {
        root.render(null);
      });
      await mount();
    });
  } finally {
    await act(() => {
      root.render(null);
    });
    vi.unstubAllGlobals();
  }
}

/** Change the catalog and let the tree settle, the way a real catalog update lands. */
const updateCatalog = (next: Parameters<typeof mocks.setCatalog>[0]) =>
  act(() => {
    mocks.setCatalog(next);
  });

beforeEach(() => {
  __resetTradingEnvironmentSelectionForTests();
  mocks.setCatalog({ isReady: false, primaryEnvironmentId: null, environments: [] });
  boundEvents.length = 0;
  observedGate = "unset";
  observedDestination = null;
});

describe("mounted trading environment routing (RC05)", () => {
  it("renders loading and mounts nothing environment-bound before the catalog is ready", async () => {
    await withMountedConsumers(1, async () => {
      // A partial catalog (entries visible, not ready) must not choose.
      await updateCatalog({ environments: [environment("env_a", "A")] });
      await act(async () => {});

      expect(observedGate).toBe("loading");
      expect(boundEvents).toEqual([]);
    });
  });

  it("latches the primary once; later primary and catalog churn never move the destination", async () => {
    await withMountedConsumers(1, async (remount) => {
      await updateCatalog({
        isReady: true,
        primaryEnvironmentId: "env_a",
        environments: [environment("env_a", "A"), environment("env_b", "B")],
      });
      await act(async () => {});

      expect(observedGate).toBe("selected");
      expect(observedDestination).toBe("env_a");
      expect(boundEvents).toEqual([{ environmentId: "env_a", kind: "mount" }]);

      // Primary change + reorder after the latch: still routing to A.
      await updateCatalog({
        primaryEnvironmentId: "env_b",
        environments: [environment("env_b", "B"), environment("env_a", "A")],
      });
      await act(async () => {});
      expect(observedGate).toBe("selected");
      expect(observedDestination).toBe("env_a");
      expect(boundEvents.filter((event) => event.kind === "mount")).toHaveLength(1);

      // Navigation (unmount/remount of the surface) keeps the session choice.
      await remount();
      expect(observedGate).toBe("selected");
      expect(observedDestination).toBe("env_a");
    });
  });

  it("latches the sole entry, and requires an explicit choice when several exist without a primary", async () => {
    await withMountedConsumers(1, async () => {
      await updateCatalog({ isReady: true, environments: [environment("only", "Only")] });
      await act(async () => {});
      expect(observedGate).toBe("selected");
      expect(observedDestination).toBe("only");

      // A fresh session over several entries with no primary: the automatic
      // choice ran once and resolved to "require explicit" — not loading,
      // not selected, nothing newly mounted, no matter how the catalog shifts.
      __resetTradingEnvironmentSelectionForTests();
      boundEvents.length = 0;
      await updateCatalog({
        primaryEnvironmentId: null,
        environments: [environment("env_a", "A"), environment("env_b", "B")],
      });
      await act(async () => {});
      expect(observedGate).toBe("choose");
      // The prior destination's client unmounts on the reset; nothing new may
      // mount while the destination is unchosen.
      expect(boundEvents.filter((event) => event.kind === "mount")).toEqual([]);

      // A primary appearing later does not auto-select: the choice was made.
      await updateCatalog({ primaryEnvironmentId: "env_b" });
      await act(async () => {});
      expect(observedGate).toBe("choose");
    });
  });

  it("an explicit selection survives removal, an empty catalog, and recovery", async () => {
    await withMountedConsumers(1, async () => {
      await updateCatalog({
        isReady: true,
        primaryEnvironmentId: "env_a",
        environments: [environment("env_a", "A"), environment("env_b", "B")],
      });
      await act(async () => {});

      // The user's explicit A -> B (the dropdown, or the recovery action).
      act(() => {
        setTradingEnvironmentId("env_b" as EnvironmentId);
      });
      await act(async () => {});
      expect(observedGate).toBe("selected");
      expect(observedDestination).toBe("env_b");

      // B removed: unavailable with B named, never a silent fallback to A.
      await updateCatalog({ environments: [environment("env_a", "A")] });
      await act(async () => {});
      expect(observedGate).toBe("unavailable");

      // Empty catalog: no-environments, destination retained internally.
      await updateCatalog({ environments: [] });
      await act(async () => {});
      expect(observedGate).toBe("no-environments");

      // The environment returns: selected again without any new choice.
      await updateCatalog({
        environments: [environment("env_a", "A"), environment("env_b", "B")],
      });
      await act(async () => {});
      expect(observedGate).toBe("selected");
      expect(observedDestination).toBe("env_b");
    });
  });

  it("both global pages share one destination, and a switch remounts each bound subtree", async () => {
    await withMountedConsumers(2, async () => {
      await updateCatalog({
        isReady: true,
        primaryEnvironmentId: "env_a",
        environments: [environment("env_a", "A"), environment("env_b", "B")],
      });
      await act(async () => {});
      expect(boundEvents.filter((event) => event.kind === "mount")).toHaveLength(2);
      expect(boundEvents.every((event) => event.environmentId === "env_a")).toBe(true);

      // An explicit A -> B switch: each surface's A unmounts and a fresh B
      // mounts — the keyed remount is what keeps late A state out of B.
      act(() => {
        setTradingEnvironmentId("env_b" as EnvironmentId);
      });
      await act(async () => {});
      expect(boundEvents.filter((event) => event.kind === "unmount")).toEqual([
        { environmentId: "env_a", kind: "unmount" },
        { environmentId: "env_a", kind: "unmount" },
      ]);
      const mounts = boundEvents.filter((event) => event.kind === "mount");
      expect(mounts).toHaveLength(4);
      expect(mounts.slice(2).every((event) => event.environmentId === "env_b")).toBe(true);
      expect(observedDestination).toBe("env_b");
    });
  });
});

it("an explicit choice required over one remaining entry offers and accepts the sole entry", async () => {
  await withMountedConsumers(1, async () => {
    // Two entries with no primary latch to "require explicit choice"…
    await updateCatalog({
      isReady: true,
      primaryEnvironmentId: null,
      environments: [environment("env_a", "A"), environment("env_b", "B")],
    });
    await act(async () => {});
    expect(observedGate).toBe("choose");

    // …then the catalog shrinks to one. The gate still requires an explicit
    // choice; the selector's static-markup test proves the sole entry is
    // offered as a working Use action in this state (RC09-F2), and taking
    // that choice is what select() performs — so drive it directly, the fake
    // DOM cannot dispatch synthetic clicks.
    await updateCatalog({ environments: [environment("env_a", "A")] });
    await act(async () => {});
    expect(observedGate).toBe("choose");
    act(() => {
      setTradingEnvironmentId("env_a" as EnvironmentId);
    });
    await act(async () => {});
    expect(observedGate).toBe("selected");
    expect(observedDestination).toBe("env_a");
    expect(boundEvents.filter((event) => event.kind === "mount")).toEqual([
      { environmentId: "env_a", kind: "mount" },
    ]);
  });
});
