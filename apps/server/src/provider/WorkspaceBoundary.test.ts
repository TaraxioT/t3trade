/**
 * The intent gate as a contract: what every provider's market_research
 * session can and cannot do, decided here once so the per-adapter tests have
 * one shared spec to inherit.
 *
 * The scenarios this file pins are the ones the boundary exists for: a new
 * market chat, a resumed one, the three trading profiles, an explicit coding
 * task, a fence that could not be established, scratch collection, and a
 * hostile page that tries to talk the agent into editing the repository.
 * None of them instantiate a provider runtime; they assert the decisions
 * every runtime is wired to enforce.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { DEFAULT_WORKSPACE_MODE, ProviderSessionStartInput, ThreadId } from "@t3tools/contracts";
import { Schema } from "effect";

import { CLAUDE_MARKET_TOOLS } from "./Layers/ClaudeAdapter.ts";
import { buildFencedOpenCodePermissionRules } from "./opencodeRuntime.ts";
import { clearAllSessionProfiles, setSessionProfile } from "./SessionProfile.ts";
import {
  allLocationsWithinScratch,
  fencedAcpPermissionDecision,
  isFencedAcpToolKind,
  selectFencedRejectOption,
  workspaceWriteBoundary,
} from "./WorkspaceBoundary.ts";

const threadId = ThreadId.make("thread_test");

/** Tools that can change state or execute, wherever they may be named. */
const FORBIDDEN_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "Task",
  "apply_patch",
  "shell_tool",
];

afterEach(() => {
  clearAllSessionProfiles();
});

describe("new market chat", () => {
  it("is fenced by default: the capability is market_research until someone says coding", () => {
    expect(DEFAULT_WORKSPACE_MODE).toBe("market_research");
    expect(workspaceWriteBoundary({ threadId, workspaceMode: undefined })).toEqual({
      kind: "fenced",
      reason: "market_research workspace",
    });
    expect(workspaceWriteBoundary({ threadId, workspaceMode: "market_research" })).toEqual({
      kind: "fenced",
      reason: "market_research workspace",
    });
  });

  it("opens the repository only for the explicit coding capability", () => {
    expect(workspaceWriteBoundary({ threadId, workspaceMode: "coding" })).toEqual({
      kind: "repo",
    });
  });
});

describe("resumed chat", () => {
  const decode = Schema.decodeUnknownSync(ProviderSessionStartInput);

  it("decodes a session start without the field back to the fenced default", () => {
    const decoded = decode({
      threadId,
      runtimeMode: "full-access",
    });
    // A persisted or older-caller payload that never named a capability
    // resumes as market_research: restart cannot restore a more permissive
    // profile than the thread's own state grants.
    expect(decoded.workspaceMode ?? DEFAULT_WORKSPACE_MODE).toBe("market_research");
  });

  it("round-trips an explicit coding capability", () => {
    const decoded = decode({ threadId, runtimeMode: "full-access", workspaceMode: "coding" });
    expect(decoded.workspaceMode).toBe("coding");
  });
});

describe("trading profiles", () => {
  it("stay fenced whatever the thread's workspace mode claims", () => {
    for (const kind of ["trading", "trading_analyst", "trading_observe"] as const) {
      setSessionProfile({ threadId, kind });
      expect(workspaceWriteBoundary({ threadId, workspaceMode: "coding" })).toEqual({
        kind: "fenced",
        reason: "trading session",
      });
      clearAllSessionProfiles();
    }
  });

  it("fence an ordinary thread with no profile and no mode at all", () => {
    expect(workspaceWriteBoundary({ threadId, workspaceMode: undefined }).kind).toBe("fenced");
  });
});

describe("hostile fetched content", () => {
  it("gives Claude's market session no tool that can write or execute", () => {
    // A page that says "edit AGENTS.md" is inert when the session holds no
    // tool that edits anything. The list is the contract.
    for (const forbidden of FORBIDDEN_TOOLS) {
      expect(CLAUDE_MARKET_TOOLS).not.toContain(forbidden);
    }
    expect(CLAUDE_MARKET_TOOLS).toContain("WebSearch");
    expect(CLAUDE_MARKET_TOOLS).toContain("WebFetch");
  });

  it("gives OpenCode's fenced session a ruleset that denies bash and repo edits", () => {
    const rules = buildFencedOpenCodePermissionRules("/tmp/t3trade-research-scratch/thread_x");
    const bashRule = rules.find((rule) => rule.permission === "bash");
    expect(bashRule?.action).not.toBe("allow");
    const editRules = rules.filter((rule) => rule.permission === "edit");
    expect(editRules.every((rule) => rule.pattern !== "*" || rule.action === "deny")).toBe(true);
    // The default line is deny, so an unanticipated permission fails closed.
    expect(rules.find((rule) => rule.permission === "*")?.action).toBe("deny");
  });

  it("keeps the ACP fence rejecting write-class requests outright", () => {
    for (const kind of ["edit", "delete", "move", "execute"]) {
      expect(isFencedAcpToolKind(kind)).toBe(true);
    }
    for (const kind of ["read", "search", "fetch", "think", "switch_mode", "other"]) {
      expect(isFencedAcpToolKind(kind)).toBe(false);
    }
  });
});

describe("ACP permission decisions", () => {
  const scratch = "/tmp/t3trade-research-scratch/thread_x";

  it("rejects write-class requests outside the scratch directory", () => {
    expect(
      fencedAcpPermissionDecision({
        kind: "edit",
        locations: [{ path: "/Users/george/Workspace/t3trade/AGENTS.md" }],
        scratchDir: scratch,
      }),
    ).toBe("reject");
    expect(
      fencedAcpPermissionDecision({ kind: "execute", locations: undefined, scratchDir: scratch }),
    ).toBe("reject");
  });

  it("allows the bounded surface: edits whose every location is inside scratch", () => {
    expect(
      fencedAcpPermissionDecision({
        kind: "edit",
        locations: [{ path: `${scratch}/dates.json` }, { path: `${scratch}/notes.md` }],
        scratchDir: scratch,
      }),
    ).toBe("allow");
    // An edit naming scratch AND the repository is a repository edit.
    expect(
      fencedAcpPermissionDecision({
        kind: "edit",
        locations: [{ path: `${scratch}/dates.json` }, { path: "/etc/hosts" }],
        scratchDir: scratch,
      }),
    ).toBe("reject");
    // No locations means nothing provable, and nothing provable is denied.
    expect(allLocationsWithinScratch(undefined, scratch)).toBe(false);
    expect(fencedAcpPermissionDecision({ kind: "edit", locations: [], scratchDir: scratch })).toBe(
      "reject",
    );
    // A sibling directory sharing the prefix by name is not inside scratch.
    expect(allLocationsWithinScratch([{ path: `${scratch}-other/file` }], scratch)).toBe(false);
  });

  it("asks the user for everything the fence did not anticipate", () => {
    for (const kind of ["read", "search", "fetch", "think"]) {
      expect(fencedAcpPermissionDecision({ kind, locations: undefined, scratchDir: scratch })).toBe(
        "ask",
      );
    }
  });

  it("selects the durable reject, and returns undefined when none was offered", () => {
    expect(
      selectFencedRejectOption([
        { optionId: "1", kind: "allow_once" },
        { optionId: "2", kind: "reject_once" },
        { optionId: "3", kind: "reject_always" },
      ]),
    ).toBe("3");
    expect(selectFencedRejectOption([{ optionId: "1", kind: "allow_always" }])).toBeUndefined();
    // The caller must treat undefined as denial, never as permission.
    expect(selectFencedRejectOption([])).toBeUndefined();
  });
});
