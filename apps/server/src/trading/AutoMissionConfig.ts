/**
 * Auto-mission configuration — the rapid-testing shortcut.
 *
 * Binding a mission to a thread is normally a deliberate act: open Settings,
 * pick a free thread, name an instruction and a mandate, and — because one
 * active mission per user is a domain invariant (§10.1) — revoke whatever was
 * there before. That is the right shape for a product and the wrong shape for a
 * lab, where a testing loop is "open a thread, watch it trade" repeated dozens
 * of times a day.
 *
 * So: with the shortcut on, a thread gets a mission on its FIRST MESSAGE —
 * that message is the mandate (see `TradingAutoMission`) — under the POC
 * authority, with the standing operating note appended. Settling or deleting
 * the thread revokes it again (see `TradingMissionReactor`).
 *
 * The shortcut is off unless `T3_TRADES_AUTO_MISSION=1` says otherwise. It used
 * to default on for any server with an armed signer, which meant that arming a
 * signer — a one-time act done for entirely different reasons — silently turned
 * the next message anyone typed into a live trading mandate. Creating authority
 * to spend money is not something to infer from a key being present.
 *
 *   - `T3_TRADES_AUTO_MISSION`             — `1` turns the shortcut on. Any
 *                                            other value, including unset,
 *                                            leaves it off.
 *   - `T3_TRADES_AUTO_MISSION_WORKSPACE`   — optional. Narrows the shortcut to
 *                                            threads in the project at this
 *                                            workspace root; unset means every
 *                                            new thread.
 *   - `T3_TRADES_AUTO_MISSION_CAPITAL_USD` — optional mandate size, used
 *                                            verbatim. Unset means the mandate
 *                                            is sized from the live account
 *                                            value at creation time (see
 *                                            `MissionCapital`).
 *   - `T3_TRADES_AUTO_MISSION_INSTRUCTION` — optional standing note appended to
 *                                            the mandate the user types,
 *                                            default `POC_STANDING_INSTRUCTION`.
 *                                            It does not replace the mandate;
 *                                            set it empty to append nothing.
 *   - `T3_TRADES_AUTO_MISSION_ACCOUNT`     — optional trading account id.
 *
 * This does not arm execution and does not widen any authority. The mission it
 * creates is the same mission the Settings form creates, under the same POC
 * mandate and the same §16 gates.
 *
 * @module AutoMissionConfig
 */
import { Context, Effect, Layer, Option } from "effect";

import { POC_STANDING_INSTRUCTION } from "@t3tools/trading-contracts/strategy";

/** A resolved auto-mission target: where it applies and what it creates. */
export interface AutoMissionSettings {
  /**
   * Workspace root whose threads auto-receive a mission, or null for every
   * thread on the installation.
   */
  readonly workspaceRoot: string | null;
  /**
   * Appended to the mandate the user types, never used in place of it. Empty
   * means the mission carries the user's words alone.
   */
  readonly standingInstruction: string;
  /**
   * The operator's explicit mandate size, or `null` for "resolve it from the
   * live account value at creation" — see `MissionCapital`.
   */
  readonly allocatedCapitalUsd: number | null;
  readonly tradingAccountId: string;
}

/**
 * The account row the server provisions from the interim signer.
 *
 * Spelled out rather than imported from `TradingAccountBootstrap`: that module
 * imports `LOCAL_TRADING_USER_ID` from `TradingMissionReactor`, which is the
 * module that consumes this config, and importing back would close a cycle.
 * `NewMissionForm` mirrors the same literal for the same reason.
 */
export const AUTO_MISSION_DEFAULT_ACCOUNT_ID = "local-hyperliquid-testnet";

export class AutoMissionConfig extends Context.Service<
  AutoMissionConfig,
  {
    /** The configured target, or none when the shortcut is off. */
    readonly resolve: Effect.Effect<Option.Option<AutoMissionSettings>>;
  }
>()("t3/trading/AutoMissionConfig") {}

/**
 * Read the settings out of an env bag. Exposed for tests.
 *
 * A capital value that is not a positive finite number resolves to `null` —
 * the same as unset, so the mandate is sized from the account. This is a
 * convenience knob, and refusing to start the whole feature over a typo'd
 * number would be a worse trade than falling through to the live balance.
 */
export const resolveAutoMission = (
  env: Record<string, string | undefined>,
): Option.Option<AutoMissionSettings> => {
  if (env.T3_TRADES_AUTO_MISSION?.trim() !== "1") return Option.none();

  const capital = Number(env.T3_TRADES_AUTO_MISSION_CAPITAL_USD);
  const allocatedCapitalUsd = Number.isFinite(capital) && capital > 0 ? capital : null;

  const workspaceRoot = env.T3_TRADES_AUTO_MISSION_WORKSPACE?.trim();
  const tradingAccountId = env.T3_TRADES_AUTO_MISSION_ACCOUNT?.trim();

  // Set-but-empty is a real answer here — it means "append nothing" — so this
  // one reads presence rather than truthiness. The others fall back on empty
  // because an empty workspace root or account id is a typo, not an intent.
  const configured = env.T3_TRADES_AUTO_MISSION_INSTRUCTION;

  return Option.some({
    workspaceRoot: workspaceRoot || null,
    standingInstruction: configured === undefined ? POC_STANDING_INSTRUCTION : configured.trim(),
    allocatedCapitalUsd,
    tradingAccountId: tradingAccountId || AUTO_MISSION_DEFAULT_ACCOUNT_ID,
  });
};

/**
 * Live layer reading `process.env`. Resolved per call, not at build, so setting
 * the knob takes effect without a restart.
 */
export const AutoMissionConfigLive = Layer.succeed(
  AutoMissionConfig,
  AutoMissionConfig.of({
    resolve: Effect.sync(() => resolveAutoMission(process.env)),
  }),
);
