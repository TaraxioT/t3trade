/**
 * Plan 38 Phase 3 live-verification setup driver (one-shot, raw WS frames).
 *
 * Speaks the effect RPC socket protocol directly (JSON frames):
 *   {"_tag":"Ping"} / {"_tag":"Pong"}
 *   {"_tag":"Request","id":N,"tag":"orchestration.dispatchCommand","payload":<command>,"headers":{}}
 *
 * Creates a thread on the existing trading project, then dispatches a
 * trading.mission.create command for the derived-watch soak mission.
 *
 * Run: bun scripts/live-derived-soak-create.ts <wsTicket>
 */
const WS_URL = "ws://127.0.0.1:13774/ws";
const PROJECT_ID = "b2406278-faf6-4113-ab76-2cca20e0b89d";
const ACCOUNT_ID = "local-hyperliquid-testnet";
const INSTRUCTION = [
  "Stand-aside watch mission for derived-metric verification (plan 38 phase 3).",
  "Hold no position and place no orders. Two derived watches are armed for you",
  "deterministically by the setup script: ETH funding_mean 7d cross below 0, and",
  "BTC funding_sign_flip 1d. When a watch fires you will be woken with the observed",
  "value on the triggered line: note it, do not trade, keep standing aside. Do not",
  "cancel or re-arm the derived watches yourself.",
].join(" ");

const ticket = process.argv[2];
if (!ticket) throw new Error("usage: bun scripts/live-derived-soak-create.ts <wsTicket>");

const uuid = () => globalThis.crypto.randomUUID();
const now = () => new Date().toISOString();

const ws = new WebSocket(`${WS_URL}?wsTicket=${ticket}`);
let nextId = 1;
const pending = new Map<number, (value: unknown) => void>();

function request(tag: string, payload: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: {} }));
    setTimeout(() => reject(new Error(`timeout awaiting ${tag} #${id}`)), 20_000);
  });
}

ws.onmessage = (event) => {
  const frames = JSON.parse(typeof event.data === "string" ? event.data : "");
  for (const frame of Array.isArray(frames) ? frames : [frames]) {
    if (frame._tag === "Ping") {
      ws.send(JSON.stringify({ _tag: "Pong" }));
    } else if (frame._tag === "Exit" && pending.has(frame.requestId)) {
      const resolve = pending.get(frame.requestId)!;
      pending.delete(frame.requestId);
      resolve(frame);
    } else if (frame._tag === "Defect" || frame._tag === "ClientProtocolError") {
      console.error("frame error:", JSON.stringify(frame).slice(0, 400));
    }
  }
};

const exitOf = (frame: unknown) => (frame as { exit?: unknown }).exit;

await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = (e) => reject(new Error("ws error: " + (e as ErrorEvent).message));
  setTimeout(() => reject(new Error("ws open timeout")), 10_000);
});
ws.send(JSON.stringify({ _tag: "Ping" }));

const threadId = uuid();
const threadExit = await request("orchestration.dispatchCommand", {
  type: "thread.create",
  commandId: uuid(),
  threadId,
  projectId: PROJECT_ID,
  title: "Plan 38 derived-watch live soak (ETH funding_mean / BTC funding_sign_flip)",
  modelSelection: {
    instanceId: "codex",
    model: "gpt-5.6-luna",
    options: [
      { id: "reasoningEffort", value: "low" },
      { id: "serviceTier", value: "priority" },
    ],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: now(),
});
console.log("thread.create exit:", JSON.stringify(exitOf(threadExit)).slice(0, 300));

const missionId = uuid();
const missionExit = await request("orchestration.dispatchCommand", {
  type: "trading.mission.create",
  commandId: uuid(),
  threadId,
  missionId,
  tradingAccountId: ACCOUNT_ID,
  instruction: INSTRUCTION,
  createdAt: now(),
});
console.log("mission.create exit:", JSON.stringify(exitOf(missionExit)).slice(0, 300));
console.log("THREAD_ID=" + threadId);
console.log("MISSION_ID=" + missionId);
ws.close();
process.exit(0);
