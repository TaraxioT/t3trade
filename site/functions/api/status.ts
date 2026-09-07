// KV-backed build board shared by every section-writing agent.
// GET  /api/status        -> the whole board (agents + recent events)
// POST /api/status        -> upsert one agent entry + append an event
//
// Storage model: one KV key per agent (`agent:<id>`, last-write-wins is
// correct for a single agent's own check-ins) and one immutable key per
// event (`event:<iso-ms>:<id>:<rand>`). Concurrent check-ins therefore
// cannot overwrite each other, and no key approaches the one-write-per-second
// KV limit. The board is assembled on read.
//
// Bindings (Pages project, production + preview):
//   STATUS_KV    KV namespace holding the board entries
//   STATUS_TOKEN shared spam-filter token sent as the "token" field

interface KVListResult {
  keys: { name: string }[];
  list_complete: boolean;
  cursor?: string;
}

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<KVListResult>;
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

const AGENT_PREFIX = "agent:";
const EVENT_PREFIX = "event:";
const MAX_EVENTS_RETURNED = 260;
const MAX_EVENTS_KEPT = 320;
const STATUSES = new Set([
  "exploring",
  "drafting",
  "writing",
  "review",
  "done",
  "failed",
  "improved",
]);
const MAX_LIST_ITEMS = 12;
const MAX_STR = 400;
// Board cards link to pages on this site only; anything else is rejected so
// a hostile `page` value can never become a `javascript:` or `data:` URL.
const PAGE_RE = /^\/([a-z0-9-]+(\.html)?)?$/;

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function listPrefix(env: Env, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page: KVListResult = await env.STATUS_KV.list({ prefix, limit: 1000, cursor });
    for (const k of page.keys) names.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.STATUS_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const onRequestGet = async ({ env }: { env: Env }): Promise<Response> => {
  const [agentKeys, eventKeys] = await Promise.all([
    listPrefix(env, AGENT_PREFIX),
    listPrefix(env, EVENT_PREFIX),
  ]);
  const agents = (await Promise.all(agentKeys.map((k) => readJson<AgentEntry>(env, k)))).filter(
    (a): a is AgentEntry => a !== null && typeof a.id === "string",
  );
  agents.sort((a, b) => a.id.localeCompare(b.id));

  // ISO millisecond timestamps sort lexicographically, newest last; we want newest first.
  const newestEvents = eventKeys.sort().reverse().slice(0, MAX_EVENTS_RETURNED);
  const events = (await Promise.all(newestEvents.map((k) => readJson<BoardEvent>(env, k)))).filter(
    (e): e is BoardEvent => e !== null && typeof e.ts === "string",
  );

  return json({ agents, events });
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
  const page = clampString(agentInput.page);
  if (page !== "" && !PAGE_RE.test(page)) {
    return json(
      { ok: false, error: "agent.page must be a root-relative site path like /risk.html" },
      400,
    );
  }
  const progressRaw = Number(agentInput.progress);
  const progress = Number.isFinite(progressRaw)
    ? Math.max(0, Math.min(100, Math.round(progressRaw)))
    : 0;

  const now = new Date();
  const entry: AgentEntry = {
    id,
    section: clampString(agentInput.section) || id,
    page,
    status,
    progress,
    notes: clampList(agentInput.notes),
    findings: clampList(agentInput.findings),
    files: clampList(agentInput.files),
    updatedAt: now.toISOString(),
  };
  const event: BoardEvent = {
    ts: entry.updatedAt,
    id,
    section: entry.section,
    status,
    text: clampString(body.note) || `status set to ${status}`,
  };
  const eventKey = `${EVENT_PREFIX}${now.getTime()}:${id}:${crypto.randomUUID().slice(0, 8)}`;

  await Promise.all([
    env.STATUS_KV.put(AGENT_PREFIX + id, JSON.stringify(entry)),
    env.STATUS_KV.put(eventKey, JSON.stringify(event)),
  ]);

  // Best-effort trim: occasionally drop the oldest events beyond the cap.
  if (Math.random() < 0.15) {
    try {
      const keys = (await listPrefix(env, EVENT_PREFIX)).sort();
      const doomed = keys.slice(0, Math.max(0, keys.length - MAX_EVENTS_KEPT));
      await Promise.all(doomed.map((k) => env.STATUS_KV.delete(k)));
    } catch {
      // trimming is advisory; a failed trim never fails the check-in
    }
  }

  return json({ ok: true, agent: entry });
};
