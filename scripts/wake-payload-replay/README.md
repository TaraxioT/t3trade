# Wake and tool-payload replay

Three scripts for answering "can this be cut?" with a measurement instead of an
opinion. They read the frozen dev database at `~/.t3/userdata/state.sqlite` and,
for the replay, spend provider tokens against the real CLIs.

**Nothing here runs in CI or in a normal test pass.** `replay.sh` is a shell
script, not a test file — no runner discovers it, and it is invoked by hand.

## 1. Attribute the context

```bash
python3 scripts/wake-payload-replay/attribute.py 5c17c8c6
```

Prints, for one mission: what filled the model's context by category (wakes,
each tool, model output), the provider's own per-call token counts, the biggest
consumer broken into sections, and what recurred unchanged between consecutive
reads of that tool.

Quit the app first. A live database gives a half-written mission.

## 2. Build the scenarios

```bash
python3 scripts/wake-payload-replay/build-scenarios.py 5c17c8c6 /tmp/scen
```

Writes one `t<turn>.full.txt` per woken turn — the mandate, the tool contracts,
the wake that turn received, the `trading_look` result it read, and a request
for the decision as JSON — plus `truth.json` naming what the run actually did.

Apply your proposed cut to the payloads and write the result as
`t<turn>.<arm>.txt` in the same directory. `full` is the control.

## 3. Replay

```bash
TURNS="3 5 7" ARMS="full reduced" scripts/wake-payload-replay/replay.sh /tmp/scen /tmp/runs
```

Runs every (turn × arm × model) through `codex exec` (gpt-5.6-luna, low
reasoning) and `claude -p` (claude-sonnet-5, low reasoning) — the pair the
harness itself runs on. Each result is one line of JSON in
`/tmp/runs/t<turn>.<arm>.<model>.json`; existing results are skipped, so a
killed run resumes.

A cut passes when every turn gives the same `action` and `direction` on both
models, with levels within tolerance. On a divergence, re-run the same arm three
or four times before believing it: at low reasoning these models are genuinely
non-deterministic on borderline turns, and the first divergence found while
writing this was sampling noise, reproduced in the control arm.

The Claude CLI is often pointed at a third-party gateway via `ANTHROPIC_BASE_URL`
and the `ANTHROPIC_DEFAULT_*_MODEL` overrides. `replay.sh` clears them, so the
replay cannot quietly run on a different model than it claims.

## 3b. The fetch arm

```bash
python3 scripts/wake-payload-replay/fetch-arm.py 5c17c8c6 /tmp/scen
```

Writes `t<turn>.fetch.txt` next to the `full` scenarios: the identical prompt
except the embedded `trading_look` result is re-packed into the shape the NEW
fetch path (`readFetchedObservation` in
`apps/server/src/mcp/toolkits/trading/handlers.ts`) would have returned for the
equivalent call. Recorded scope arguments are translated per the handler's real
scope-to-key mapping and the result sections are copied verbatim, plus the
`fetched` echo and any `unavailable[]` entries. Sections the fetch path
genuinely cannot reproduce (the flat-cap candles note,
`previousStructureRead`, the mission half's authority/control/harness
siblings) are dropped and recorded per turn in `fetch-manifest.json`.

Replay it codex-only with the same flags `replay.sh` uses:

```bash
TURNS="$(seq 2 53)" ARMS="full fetch" scripts/wake-payload-replay/replay.sh /tmp/scen /tmp/runs
```

with `MODELS=codex` — or directly:

```bash
codex exec -m gpt-5.6-luna -c model_reasoning_effort=low --sandbox read-only --skip-git-repo-check - < t2.fetch.txt
```

The claude leg of the fetch-arm replay is pending until that CLI exists on the
machine; the invocation in `replay.sh` is ready for it unchanged.

## Cost

A full seven-turn, two-arm, two-model sweep is 28 calls. Prompts run 10k–34k
characters, so roughly 150k–200k input tokens per model per sweep and a few
thousand output tokens. Wall clock is about 10 minutes; the calls are serial by
design, so a killed run resumes cleanly.

Narrow first. Proving one cut on three turns is 12 calls and answers the
question that matters.

## 4. Lean-wake corpus replay

```bash
bun scripts/wake-payload-replay/lean-replay.ts
```

TypeScript rather than Python so it can import the REAL renderer
(`renderLeanWakeForReplay` from `TradingWakeupComposer`) instead of
re-implementing it. Reads `~/.t3/userdata/state.sqlite` read-only, re-renders
every recorded harness wake through the lean renderer, and asserts two
properties: mean lean length ≤ 1,000 chars, and no observed value from a
firing event is lost in the `triggered:` fold (the plan-35 finding). Prints
mean, max, count, and the failure list; exits non-zero on failure. Like the
other scripts here it runs by hand, never in CI.

## Coverage, and what it does not cover

A scenario is one turn, replayed once, with the tool result pre-supplied. That
tests whether the _payload_ changes the decision, which is the question these
cuts raise. It does not test whether the model would still have _called_
`trading_look`, whether a multi-turn loop drifts, or anything about live
execution. Those belong to a testnet soak.
