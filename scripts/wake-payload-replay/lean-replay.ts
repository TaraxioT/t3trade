/**
 * Lean-wake corpus replay (plan 38 phase 1).
 *
 * Re-renders every recorded harness wake through the REAL lean renderer
 * (`renderLeanWakeForReplay`, exported from TradingWakeupComposer) and checks
 * the two properties phase 1 promised:
 *
 *   1. mean lean length <= 1,000 chars (plan 38 §6 phase 1 item 2);
 *   2. for every wake whose firing event carried an observed value, that
 *      value survives the fold into the `triggered:` line (the plan-35
 *      finding, §1.4 — the number the watch line rounds away).
 *
 * Reads ~/.t3/userdata/state.sqlite READ-ONLY with prepared statements only.
 * Nothing here runs in CI or a normal test pass; invoke by hand:
 *
 *   bun scripts/wake-payload-replay/lean-replay.ts
 */
import { Database } from "bun:sqlite";

import { renderLeanWakeForReplay } from "../../apps/server/src/trading/TradingWakeupComposer.ts";

const DB_PATH = `${process.env.HOME}/.t3/userdata/state.sqlite`;

/** One `key:` section of a rendered wake, with its value lines joined. */
const sections = (text: string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const top = /^([a-zA-Z]+):$/.exec(line);
    if (top !== null) {
      current = top[1] ?? null;
      if (current !== null && !out.has(current)) out.set(current, []);
      continue;
    }
    if (current !== null && line.startsWith("  ")) {
      out.get(current)?.push(line.slice(2));
    }
  }
  return out;
};

const joined = (map: Map<string, string[]>, key: string): string | undefined => {
  const lines = map.get(key);
  return lines === undefined || lines.length === 0 ? undefined : lines.join(" ");
};

/** Parse `k=v k2={a=1 b=2}` token soup into a flat object. */
const parsePairs = (text: string): Record<string, string> => {
  const pairs: Record<string, string> = {};
  for (const match of text.matchAll(/([a-zA-Z]+)=((\{[^}]*\})|(\S+))/g)) {
    const key = match[1];
    if (key !== undefined) pairs[key] = match[2] ?? "";
  }
  return pairs;
};

const num = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/** One `[i] ...` entry per element, continuation lines joined. */
const parseEntries = (map: Map<string, string[]>, key: string): string[] => {
  const entries: string[] = [];
  for (const line of map.get(key) ?? []) {
    if (/^\[\d+\]/.test(line)) entries.push(line.replace(/^\[\d+\]\s*/, ""));
    else if (entries.length > 0) entries[entries.length - 1] += ` ${line}`;
  }
  return entries;
};

/** A parsed corpus wake: just enough shape for the lean renderer. */
interface CorpusWake {
  readonly text: string;
  readonly wakeup: Record<string, unknown>;
  /** Decimal tokens from the firing event's summary, when there was one. */
  readonly observedTokens: string[];
}

const toRendererInput = (text: string): CorpusWake => {
  const map = sections(text);
  const identity = parsePairs(
    [
      joined(map, "kind"),
      joined(map, "missionId"),
      joined(map, "harnessRunId"),
      joined(map, "cause"),
      joined(map, "occurredAt"),
    ]
      .filter((s) => s !== undefined)
      .map((s) => s ?? "")
      .join(" ")
      .replace(/(\w):\s/g, "$1="),
  );

  const pendingEvents = parseEntries(map, "pendingEvents").map((entry) => {
    const pairs = parsePairs(entry);
    return {
      category: pairs.category ?? "market",
      deduplicationKey: pairs.deduplicationKey ?? "",
      occurredAt: num(pairs.occurredAt) ?? 0,
      summary: entry.slice(entry.indexOf("summary=") + "summary=".length),
    };
  });

  // The triggering watch rendered only its 8-char handle; the firing event's
  // dedup key carries the full id. Recover it so the fold's id match works.
  const triggerPairs =
    joined(map, "triggeringWatch") !== undefined
      ? parsePairs(joined(map, "triggeringWatch") ?? "")
      : undefined;
  let triggeringWatch: Record<string, unknown> | undefined;
  let observedTokens: string[] = [];
  if (triggerPairs !== undefined) {
    const handle = (triggerPairs.id ?? "").slice(0, 8);
    const firing = pendingEvents.find(
      (event) =>
        event.deduplicationKey.includes(":") &&
        event.deduplicationKey.split(":").some((part) => part.startsWith(handle)),
    );
    const fullId = firing?.deduplicationKey.split(":").find((part) => part.startsWith(handle));
    const condition = parsePairs(triggerPairs.on ?? "{}".replace(/[{}]/g, ""));
    triggeringWatch = {
      id: fullId ?? triggerPairs.id,
      condition,
      status: triggerPairs.status ?? "triggered",
      createdAt: 0,
      updatedAt: 0,
    };
    if (firing !== undefined) {
      observedTokens = firing.summary.match(/\d+\.\d+/g) ?? [];
    }
  }

  const armedWatches = parseEntries(map, "armedWatches").map((entry, index) => {
    const pairs = parsePairs(entry);
    return {
      watch: {
        id: pairs.id ?? `unknown${index}`,
        condition: parsePairs(pairs.on ?? ""),
        status: "active",
        createdAt: index,
        updatedAt: index,
      },
    };
  });

  const position = parsePairs(joined(map, "position") ?? "");
  const costContext = joined(map, "costContext");
  const positionCosts = joined(map, "positionCosts");
  const plan = parsePairs(joined(map, "plan") ?? "");

  const wakeup: Record<string, unknown> = {
    kind: "trading-harness-wakeup",
    missionId: joined(map, "missionId") ?? identity.missionId ?? "replay",
    harnessRunId: joined(map, "harnessRunId") ?? "replay",
    cause: joined(map, "cause") ?? "scheduled_reassessment",
    occurredAt: num(joined(map, "occurredAt")) ?? 0,
    ...(triggeringWatch === undefined ? {} : { triggeringWatch }),
    ...(joined(map, "userMessage") === undefined
      ? {}
      : { userMessage: joined(map, "userMessage") }),
    marketSnapshot: {
      market: joined(map, "market") ?? "ETH",
      markPrice: num(joined(map, "markPrice")) ?? 0,
    },
    position: {
      market: position.market ?? "ETH",
      size: num(position.size) ?? 0,
      unrealisedPnl: num(position.unrealisedPnl) ?? 0,
      cumulativeFunding: num(position.cumulativeFunding) ?? 0,
      marginUsed: num(position.marginUsed) ?? 0,
    },
    ...(costContext === undefined ? {} : { costContext: parsePairs(costContext) }),
    ...(positionCosts === undefined ? {} : { positionCosts: parsePairs(positionCosts) }),
    ...(Object.keys(plan).length === 0
      ? {}
      : {
          activeStrategy: {
            intent: plan.intent ?? "stand_aside",
            stop: {
              ...(plan.stopPrice === undefined ? {} : { price: num(plan.stopPrice) }),
              ...(plan.maxPlannedLossUsd === undefined
                ? {}
                : { maximumPlannedLossUsd: num(plan.maxPlannedLossUsd) }),
            },
            target: {
              ...(plan.targetPrice === undefined ? {} : { price: num(plan.targetPrice) }),
              ...(plan.targetProfitUsd === undefined
                ? {}
                : { profitUsd: num(plan.targetProfitUsd) }),
            },
          },
        }),
    armedWatches,
    pendingEvents,
  };

  return { text, wakeup, observedTokens };
};

// -- run --------------------------------------------------------------------

const db = new Database(DB_PATH, { readonly: true });
const rows = db
  .prepare(
    `SELECT text FROM projection_thread_messages
     WHERE role = 'user' AND text LIKE '%trading-harness-wakeup%'
     ORDER BY message_id ASC`,
  )
  .all() as Array<{ text: string }>;

const failures: string[] = [];
let total = 0;
let max = 0;
const lengths: number[] = [];

for (const row of rows) {
  total += 1;
  const wake = toRendererInput(row.text ?? "");
  const lean = renderLeanWakeForReplay(wake.wakeup as never);
  lengths.push(lean.length);
  if (lean.length > max) max = lean.length;

  const id = wake.wakeup.missionId;
  for (const token of wake.observedTokens) {
    if (!lean.includes(token)) {
      failures.push(
        `mission ${id}: observed value ${token} from the firing event was lost in the lean re-render`,
      );
    }
  }
}

const mean = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
console.log(`corpus wakes: ${total}`);
console.log(`lean mean: ${mean.toFixed(0)} chars`);
console.log(`lean max: ${max} chars`);
console.log(`observed-value failures: ${failures.length}`);
for (const failure of failures.slice(0, 20)) console.log(`  - ${failure}`);

let ok = total > 0 && mean <= 1_000 && failures.length === 0;
if (total === 0) console.error("no wakes found — is the database the right one?");
if (mean > 1_000) console.error(`mean ${mean.toFixed(0)} exceeds the 1,000 budget`);
process.exit(ok ? 0 : 1);
