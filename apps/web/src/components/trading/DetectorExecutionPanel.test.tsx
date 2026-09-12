import type { ForgeExecutionStateView } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ExecutionStateDetails } from "./DetectorExecutionPanel";

const state: Extract<ForgeExecutionStateView, { status: "ok" }> = {
  status: "ok",
  envelope: {
    envelopeId: "env-1",
    environmentId: "local",
    capabilityId: "release-flow",
    revision: 1,
    status: "proposed",
    envelope: null,
    proposedAtMs: 1_780_000_000_000,
    approvedAtMs: null,
    approvedVia: null,
    revokedAtMs: null,
  },
  proposals: [],
  intents: [],
  budget: { remainingInputCapRaw: "1000", settledRaw: "0", inFlightRaw: "0" },
};
const render = (data: ForgeExecutionStateView) =>
  renderToStaticMarkup(<ExecutionStateDetails data={data} onRevoke={vi.fn()} busy={false} />);

describe("execution details", () => {
  it("shows unavailable and absent envelopes explicitly", () => {
    expect(render({ status: "none", reason: "No envelope proposed" })).toContain(
      "No envelope proposed",
    );
    expect(render({ status: "unavailable", reason: "execution-unavailable" })).toContain(
      "execution-unavailable",
    );
  });
  it("does not fabricate approval or envelope terms and shows raw budgets", () => {
    const html = render(state);
    expect(html).toContain("Envelope terms unavailable");
    expect(html).toContain("No approval recorded");
    expect(html).toContain("Remaining 1000");
    expect(html).toContain("raw token units");
    expect(html).toContain("No policy proposals recorded");
    expect(html).toContain("No swap intents recorded");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Revoke execution envelope/);
  });
  it("makes refused submission unmistakably different from a trade", () => {
    const address = `0x${"1".repeat(40)}`;
    const html = render({
      ...state,
      intents: [
        {
          intentId: "intent-1",
          environmentId: "local",
          envelopeId: "env-1",
          proposalId: "proposal-1",
          quoteId: "quote-1",
          routeId: "route-1",
          tokenIn: address,
          tokenOut: address,
          amountInRaw: "100",
          minAmountOutRaw: "90",
          recipient: address,
          swapTargetAddress: address,
          preparedTxJson: "{}",
          status: "submit-refused",
          preparedAtMs: 1_780_000_000_000,
          refusalReason: "broadcaster-missing",
        },
      ],
    });
    expect(html).toContain("Submission refused — no trade executed");
    expect(html).toContain("broadcaster-missing");
    expect(html).toContain("quote-1");
  });
  it("offers direct revocation for an approved envelope", () => {
    const html = render({
      ...state,
      envelope: { ...state.envelope, status: "approved", approvedVia: "direct-user" },
    });
    const tag = html.slice(0, html.indexOf("Revoke execution envelope")).split("<button").at(-1);
    expect(tag).not.toContain(' disabled=""');
    expect(html).toContain("direct-user");
    expect(html).toContain("does not reverse an already submitted transaction");
  });
});
