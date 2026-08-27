/**
 * The explicit mission form (final-form Phase 8).
 *
 * A mission is created deliberately, from the trade home: pick the market from
 * the live universe, write the mandate, state the capital grant and the wake
 * budget, and submit. Submit dispatches `trading.mission.create` on a fresh
 * thread — the draft-hero first-message claiming path this replaces is gone.
 *
 * The capital and wake-budget fields are optional on purpose: no capital means
 * "size the mandate from the live account value" (the server's own rule), and
 * no wake budget means unlimited, which is every pre-Phase-8 mission's
 * behavior.
 *
 * @module MissionCreateForm
 */
import type { EnvironmentId, TradingAccountState } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../ui/button";
import { TradingAssetPicker } from "./TradingAssetPicker";
import { useMissionLauncher } from "./useTradingThreadLaunch";

/** The server's interim-signer default account, when the view has none yet. */
const FALLBACK_ACCOUNT_ID = "local-hyperliquid-testnet";

export function MissionCreateForm({
  environmentId,
  accounts,
  initialAsset,
  onClose,
}: {
  environmentId: EnvironmentId;
  accounts: ReadonlyArray<TradingAccountState>;
  initialAsset: string | null;
  onClose: () => void;
}) {
  const launcher = useMissionLauncher(environmentId);
  const [asset, setAsset] = useState<string>(initialAsset ?? "ETH");
  const [instruction, setInstruction] = useState("");
  const [capitalText, setCapitalText] = useState("");
  const [maxWakesText, setMaxWakesText] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);

  const tradingAccountId = accounts[0]?.accountId ?? FALLBACK_ACCOUNT_ID;

  const submit = async () => {
    const mandate = instruction.trim();
    if (mandate.length === 0) {
      setFieldError("Write the mandate — what this mission is for.");
      return;
    }
    const capital = capitalText.trim() === "" ? undefined : Number(capitalText);
    if (capital !== undefined && (!Number.isFinite(capital) || capital <= 0)) {
      setFieldError("Capital must be a positive dollar amount, or empty for account-sized.");
      return;
    }
    const maxWakes = maxWakesText.trim() === "" ? undefined : Number(maxWakesText);
    if (maxWakes !== undefined && (!Number.isInteger(maxWakes) || maxWakes <= 0)) {
      setFieldError("Wake budget must be a whole number of runs, or empty for unlimited.");
      return;
    }
    setFieldError(null);
    await launcher.launch({
      asset,
      instruction: mandate,
      tradingAccountId,
      ...(capital === undefined ? {} : { allocatedCapitalUsd: capital }),
      ...(maxWakes === undefined ? {} : { maxWakes }),
    });
  };

  const error = fieldError ?? launcher.error;

  return (
    <section
      aria-label="New mission"
      className="flex flex-col gap-3 rounded-md border border-border/60 bg-card/40 p-3"
      data-testid="mission-create-form"
    >
      <header className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">New mission</h2>
        <span className="text-xs text-muted-foreground">
          delegates one market to the agent, under a mandate
        </span>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onClose}>
          Cancel
        </Button>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Market</span>
        <TradingAssetPicker environmentId={environmentId} value={asset} onChange={setAsset} />
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Mandate</span>
        <textarea
          className="min-h-20 rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground"
          placeholder={`What should the agent do on ${asset}? Strategy, style, and any limits in plain language.`}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          data-testid="mission-create-mandate"
        />
      </label>
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Capital (USD, empty = account-sized)
          </span>
          <input
            className="w-40 rounded-md border border-border/60 bg-background px-2 py-1 text-sm tabular-nums text-foreground"
            inputMode="decimal"
            placeholder="account"
            value={capitalText}
            onChange={(event) => setCapitalText(event.target.value)}
            data-testid="mission-create-capital"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Wake budget (runs, empty = unlimited)
          </span>
          <input
            className="w-40 rounded-md border border-border/60 bg-background px-2 py-1 text-sm tabular-nums text-foreground"
            inputMode="numeric"
            placeholder="unlimited"
            value={maxWakesText}
            onChange={(event) => setMaxWakesText(event.target.value)}
            data-testid="mission-create-max-wakes"
          />
        </label>
      </div>
      {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
      <div>
        <Button
          size="sm"
          disabled={launcher.busy}
          onClick={() => void submit()}
          data-testid="mission-create-submit"
        >
          {launcher.busy ? "Creating…" : "Create mission"}
        </Button>
      </div>
    </section>
  );
}
