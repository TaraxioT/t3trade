#!/usr/bin/env python3
"""Build the `fetch` arm for replay scenarios (plan 38 phase 2, item 4).

Reads the same mission and turns `build-scenarios.py` replays, and for each
`t<turn>.full.txt` writes `t<turn>.fetch.txt`: the identical prompt except the
embedded `trading_look` result is what the NEW fetch path would have returned
for the equivalent call. The recorded args are translated per the handler's
real scope-to-key mapping (apps/server/src/mcp/toolkits/trading/handlers.ts,
readFetchedObservation), and the recorded result sections are re-packed into
the fetch response shape, including the `fetched` echo and any `unavailable[]`
entries the handler would emit.

Where the fetch path genuinely cannot reproduce a section (the flat-cap candle
`note`, `previousStructureRead`, the mission half's authority/control/harness
siblings) the difference is recorded in `fetch-manifest.json` — the arm tests
the real new shape, not an idealized one.

    python3 scripts/wake-payload-replay/fetch-arm.py <mission-id-prefix> <scenario-dir>

Run AFTER build-scenarios.py — it re-reads the database, not the files.
"""
import importlib.util
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from attribute import connect, thread_for, messages, tool_calls  # noqa: E402

# Reuse the scenario builder's prompt furniture verbatim, so the arm differs
# from `full` in the tool result and nothing else. The filename has a hyphen,
# so it cannot be imported by name.
_SPEC = importlib.util.spec_from_file_location(
    "build_scenarios", os.path.join(os.path.dirname(os.path.abspath(__file__)), "build-scenarios.py")
)
_BUILD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_BUILD)

ALL_SCOPES = ["market", "candles", "structure", "position", "mission", "retrospect", "trades"]


def indicator_spec(request):
    """`{"kind":"ema","period":9}` -> `ema9`, the `indicators:<spec>` form."""
    kind = request.get("kind", "")
    period = request.get("period")
    return kind + (str(period) if period is not None else "")


def parse_pending_events(wake):
    """The wake's `pendingEvents:` block as the fetch `events` section shape.

    The `events` key peeks the same inbox the wake drains, so the wake's block
    is the honest source for what the key would have served that turn.
    """
    events = []
    lines = wake.splitlines()
    i = 0
    in_block = False
    while i < len(lines):
        line = lines[i]
        if line == "pendingEvents:":
            in_block = True
            i += 1
            continue
        if in_block:
            match = re.match(r"^  \[\d+\] (.*)$", line)
            if match:
                rest = match.group(1)
                summary = ""
                summary_at = rest.find("summary=")
                if summary_at >= 0:
                    summary = rest[summary_at + len("summary=") :]
                    rest = rest[:summary_at].strip()
                fields = {}
                for token in rest.split():
                    if "=" in token:
                        key, value = token.split("=", 1)
                        fields[key] = value
                j = i + 1
                while j < len(lines) and lines[j].startswith("    "):
                    summary += " " + lines[j].strip()
                    j += 1
                events.append(
                    {
                        "category": fields.get("category", ""),
                        "occurredAt": int(fields.get("occurredAt", "0")),
                        "summary": summary.strip(),
                    }
                )
                i = j
                continue
            if not line.startswith(" "):
                in_block = False
        i += 1
    return events


def translate(args, result, wake):
    """One recorded (args, result) pair -> (fetch keys, fetch result, notes)."""
    keys = []
    unavailable = []
    notes = []

    def add(*names):
        for name in names:
            if name not in keys:
                keys.append(name)

    scopes = set(args.get("scope") or ALL_SCOPES)

    # market -> snapshot (+resolvedMarket folded in), book_full, microstructure,
    # cost. The scope path emits `cost` only while flat; holding, the fetch path
    # refuses it by name — same information either way.
    if "market" in scopes:
        add("snapshot", "book_full", "microstructure")
        if "cost" in result:
            add("cost")
        else:
            add("cost")
            unavailable.append(
                {
                    "key": "cost",
                    "reason": "holding a position — cost prices a hypothetical entry; ask position_costs",
                }
            )

    # candles -> candles:<interval>:<n> + volatility + volatility_htf + one
    # indicators:<spec> per requested reading (the scope path's implied bundle,
    # each with its own price under fetch).
    if "candles" in scopes:
        candles = result.get("candles")
        if isinstance(candles, dict) and isinstance(candles.get("bars"), list):
            interval = candles.get("interval", args.get("interval", "1m"))
            n = len(candles["bars"])
        else:
            interval = args.get("interval", "1m")
            n = args.get("bars", 20)
        add(f"candles:{interval}:{n}", "volatility", "volatility_htf")
        for request in args.get("indicators") or []:
            add(f"indicators:{indicator_spec(request)}")

    # structure keeps its own key; `levels` (levelHistory) is separate under
    # fetch, so it is named when the recorded result carried it.
    if "structure" in scopes:
        add("structure")
        if "levelHistory" in result:
            add("levels")

    # position -> position + account + orders; position_costs is opt-in and
    # only answers while holding, exactly as the scope path emitted it.
    if "position" in scopes:
        add("position", "account", "orders")
        if "positionCosts" in result:
            add("position_costs")

    # mission -> plan + watches (+events when the wake carried pending events).
    if "mission" in scopes:
        add("plan", "watches")
        if parse_pending_events(wake):
            add("events")

    if "retrospect" in scopes:
        add("plan_history", "calibration", "journal")
    if "trades" in scopes:
        add("trades")

    # -- the result, section by section, in the fetch response shape ----------
    out = {"observedAt": result["observedAt"], "market": result["market"]}

    def copy(source_key, target_key=None):
        if source_key in result:
            out[target_key or source_key] = result[source_key]

    if "snapshot" in keys:
        copy("snapshot")
        copy("resolvedMarket")  # folded into the snapshot key (§4.2)
    if "book_full" in keys:
        copy("orderBook")
    copy("microstructure")
    copy("cost")
    if any(key.startswith("candles:") for key in keys):
        candles = dict(result.get("candles") or {})
        if "note" in candles:
            del candles["note"]  # the flat-cap note; fetch has no cap, no note
            notes.append("dropped candles.note (the fetch path never caps)")
        if candles:
            out["candles"] = candles
    copy("volatility")
    copy("higherTimeframeVolatility")
    copy("indicators")
    copy("structure")
    if "previousStructureRead" in result:
        notes.append(
            "dropped previousStructureRead — no fetch key serves it; only the "
            "scope path's structure read carries it"
        )
    if "levels" in keys:
        copy("levelHistory")
    copy("position")
    copy("account")
    copy("openOrders", "openOrders")
    if "position_costs" in keys:
        copy("positionCosts")
    if "events" in keys:
        out["events"] = parse_pending_events(wake)[:5]
    if "trades" in keys:
        copy("trades")

    mission_keys = {"plan", "watches", "plan_history", "calibration", "journal"} & set(keys)
    if mission_keys:
        recorded = result.get("mission") or {}
        half = {}
        for field in ("bound", "mission", "mode", "missionVersion", "pendingExecutions"):
            if field in recorded:
                half[field] = recorded[field]
        if "plan" in mission_keys:
            if "strategy" in recorded:
                half["strategy"] = recorded["strategy"]
            else:
                unavailable.append({"key": "plan", "reason": "no plan published yet"})
        if "watches" in mission_keys:
            half["watches"] = recorded.get("watches", [])
        if "plan_history" in mission_keys:
            if "strategyHistory" in recorded:
                half["strategyHistory"] = recorded["strategyHistory"]
            else:
                unavailable.append({"key": "plan_history", "reason": "no prior plan revisions"})
        if "journal" in mission_keys:
            half["journal"] = recorded.get("journal", [])
        if "calibration" in mission_keys:
            if "targetCalibration" in recorded:
                half["targetCalibration"] = recorded["targetCalibration"]
            else:
                unavailable.append({"key": "calibration", "reason": "no closed trades to grade yet"})
        dropped_siblings = sorted(set(recorded) - set(half))
        if dropped_siblings:
            notes.append(
                f"mission half drops the scope path's siblings {sorted(set(dropped_siblings))} "
                "(authority/control/harness fold away under fetch; only named keys answer)"
            )
        out["mission"] = half
    elif isinstance(result.get("mission"), dict):
        notes.append(
            "scope path carried the mission half unasked; fetch serves it only "
            "when a mission-side key is named"
        )

    out["fetched"] = keys
    if unavailable:
        out["unavailable"] = unavailable
    return keys, out, notes


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    prefix, out_dir = sys.argv[1], sys.argv[2]

    con = connect()
    thread_id, _ = thread_for(con, prefix)
    msgs = messages(con, thread_id)
    calls = tool_calls(con, thread_id)

    wakes = [(t, at) for r, t, at in msgs if r == "user"]
    mandate = json.loads(wakes[0][0])["instruction"]

    manifest = {}
    for turn, (wake, wake_at) in enumerate(wakes[1:], start=2):
        after = [c for c in calls if c["tool"] == "trading_look" and c["at"] >= wake_at]
        if not after:
            continue
        call = after[0]
        result = json.loads(call["text"])
        keys, fetch_result, notes = translate(call["args"] or {}, result, wake)
        look = json.dumps(fetch_result, separators=(",", ":"))
        prompt = (
            "You are an autonomous perpetual-futures trading agent.\n\n"
            f"YOUR MANDATE:\n{mandate}\n\n{_BUILD.TOOLS}\n"
            f"WAKE MESSAGE:\n{wake}\n\nRESULT OF trading_look:\n{look}\n\n{_BUILD.ASK}\n"
        )
        path = os.path.join(out_dir, f"t{turn}.fetch.txt")
        with open(path, "w") as handle:
            handle.write(prompt)
        manifest[str(turn)] = {
            "keys": keys,
            "unavailable": fetch_result.get("unavailable", []),
            "notes": notes,
            "full_chars": None,
            "fetch_chars": len(look),
        }
        print(f"t{turn}  keys={len(keys)}  look {len(call['text'])} -> {len(look)} chars")

    with open(os.path.join(out_dir, "fetch-manifest.json"), "w") as handle:
        json.dump(manifest, handle, indent=1)


if __name__ == "__main__":
    main()
