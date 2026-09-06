// KV-backed build board shared by every section-writing agent.
// GET  /api/status        -> the whole board
// POST /api/status        -> upsert one agent entry + append an event
//
// Bindings (Pages project, production + preview):
//   STATUS_KV    KV namespace holding the board JSON
//   STATUS_TOKEN shared spam-filter token sent as the "token" field

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Env {
  STATUS_KV: KVLike;
  STATUS_TOKEN: string;
}

interface AgentEntry {
  id: string;
  section: string;
  page: string;
  status: string;
  progress: number;
  notes: string[];
  findings: string[];
  files: string[];
  updatedAt: string;
}

interface BoardEvent {
  ts: string;
  id: string;
  section: string;
  status: string;
  text: string;
}

interface Board {
  agents: AgentEntry[];
  events: BoardEvent[];
}

const BOARD_KEY = "board:v1";
const STATUSES = new Set([
  "exploring",
  "drafting",
  "writing",
  "review",
  "done",
  "failed",
  "improved",
]);
const MAX_AGENTS = 120;
const MAX_EVENTS = 260;
const MAX_LIST_ITEMS = 12;
const MAX_STR = 400;

function clampString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_STR);
}

function clampList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => clampString(item))
    .filter((item) => item.length > 0);
}

function emptyBoard(): Board {
  return { agents: [], events: [] };
}

async function readBoard(env: Env): Promise<Board> {
  const raw = await env.STATUS_KV.get(BOARD_KEY);
  if (!raw) return emptyBoard();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as Board).agents) &&
      Array.isArray((parsed as Board).events)
    ) {
      return parsed as Board;
    }
  } catch {
    // fall through to a fresh board on corrupt data
  }
  return emptyBoard();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export const onRequestGet = async ({ env }: { env: Env }): Promise<Response> => {
  const board = await readBoard(env);
  return json(board);
};

export const onRequestPost = async ({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  if (request.headers.get("content-type")?.includes("application/json") !== true) {
    return json({ ok: false, error: "content-type must be application/json" }, 415);
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  const body = (payload ?? {}) as Record<string, unknown>;
  if (clampString(body.token) !== env.STATUS_TOKEN) {
    return json({ ok: false, error: "bad token" }, 401);
  }

  const agentInput = (body.agent ?? {}) as Record<string, unknown>;
  const id = clampString(agentInput.id);
  if (!/^[a-z0-9-]{1,40}$/.test(id)) {
    return json({ ok: false, error: "agent.id must be a slug like 'risk'" }, 400);
  }
  const status = clampString(agentInput.status);
  if (!STATUSES.has(status)) {
    return json({ ok: false, error: `status must be one of ${[...STATUSES].join(", ")}` }, 400);
  }
  const progressRaw = Number(agentInput.progress);
  const progress = Number.isFinite(progressRaw)
    ? Math.max(0, Math.min(100, Math.round(progressRaw)))
    : 0;

  const board = await readBoard(env);
  const now = new Date().toISOString();
  const entry: AgentEntry = {
    id,
    section: clampString(agentInput.section) || id,
    page: clampString(agentInput.page),
    status,
    progress,
    notes: clampList(agentInput.notes),
    findings: clampList(agentInput.findings),
    files: clampList(agentInput.files),
    updatedAt: now,
  };

  const idx = board.agents.findIndex((a) => a.id === id);
  if (idx >= 0) board.agents[idx] = entry;
  else board.agents.push(entry);
  board.agents.sort((a, b) => a.id.localeCompare(b.id));
  board.agents = board.agents.slice(0, MAX_AGENTS);

  board.events.unshift({
    ts: now,
    id,
    section: entry.section,
    status,
    text: clampString(body.note) || `status set to ${status}`,
  });
  board.events = board.events.slice(0, MAX_EVENTS);

  await env.STATUS_KV.put(BOARD_KEY, JSON.stringify(board));
  return json({ ok: true, agent: entry });
};
