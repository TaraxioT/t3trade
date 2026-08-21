# Executable prompts

Completed and removed: R1 (single-writer lock), R2 (5m realignment), R3
(scan/VWAP/prior-day levels), R6 phases 0-4 (cockpit rebuild), R7 (the
unbound golden is pinned — 3e1152357d…, commit 246884a77 — and the whole tree
now has a real test record: server test:fork 1324 passed with zero UNPINNED
lines, web 340 passed, both typechecks clean, verified 2026-08-20), and R8.
R4 stays withdrawn.

R8 result (2026-08-20, 8 commits bc555920e…bad16b2c6, unpushed): the cockpit
was rendered in a browser for the first time, against a REAL agent-discretion
testnet mission — 22 harness runs, 2 plans, 23 fills over ~40 minutes; the
agent stood aside with a reasoned rejection of four playbooks, then switched
character, shorted 0.3841 ETH at 2,338.67, moved its stop and scaled out. So
flat/armed, stand-aside and holding were all exercised on live data. Seven
defects found and fixed (four visible only on live data), including
deriveTargetPrice offering to bank at -77,661.33 on a dust-sized position, a
reduced-transparency fallback that lost to Tailwind backdrop-blur on layer
order, and a heartbeat clause silently dropped. Verified by measurement, not
eye: bracket stubs at exactly 15.0% of plot width, zero SVG circles, zero
level-chip overlaps, hover sync both directions, zero running animations
under reduced motion, zero em-dashes in rendered DOM. Recorded honestly as
NOT exercised: mission-complete, blocked/stand-down, full-panel loading
skeleton. Report at cockpit-verify.md, 20 screenshots in
artifacts/cockpit-verify/. Gates: web typecheck clean, 2353 tests pass (7
added), lint 0 errors.

Two open items left by R8, neither in its scope:
- A 0.0001 ETH dust short (~$0.23) remains open on testnet, unmanaged since
  the isolated environment was shut down. Close it when convenient.
- The SERVER projection ships an empty watch list for runtime-armed watches;
  R8 fixed the symptom web-side from data already pushed, but the staleness
  itself is unfixed and wants a server-side prompt.
- The isolated state dir /tmp/t3code-test.oQXqhH is preserved on purpose: it
  holds the mission's 23 fills and 22 harness runs as reproduction evidence
  for the seven fixes. Do not sweep it as stray temp until those are settled.
  (Two older /tmp/t3code-test.* dirs, j4XdhZ and xP9cne, are not R8's.)

Housekeeping done 2026-08-20 (no prompt needed): plan/report docs moved off
the repo root into artifacts/ (commit f47f4ec0e); the canonical ~/.t3 market
archiver was found dead (old PID 64728) and restarted as PID 78836 — backfill
covered the 00:40–03:20 UTC gap. Local main is 94 commits ahead of origin,
nothing pushed.

R8's half of R5's gate is satisfied. R5 now waits only on the live derived
soak (mission 2af6960b) concluding with its crossing verified.

---

## Prompt R5 — plan-38 phase 4 (delete scope[]) — GATED, not issued yet

Runs only after: (a) the live derived-watch soak concludes with its crossing
verified, and (b) R8's real mission ran clean (it doubles as the
agent-discretion demo). R7's gate is satisfied — the unbound golden is
pinned, and R5 retires it together with the scope[] path it pins.
Then: delete scope[] per plan-38 §6 Phase 4 (design doc now at
artifacts/plans/plan-38-progressive-disclosure.md), the only irreversible
phase.

---

## G-series — data-collection prompts for GLM-5.3 in ZCode

Purpose: accumulate a corpus of decision-quirk, UI-bug, and discrepancy data
by running these prompts repeatedly; Claude analyzes the bundles later. Each
run appends one timestamped directory under `artifacts/investigations/`
(gitignored — the data never enters git). Shared rules live in
`artifacts/investigations/G-RULES.md`; every prompt makes the executor read
them first, so edits there apply to all future runs.

Written for GLM-5.3 as the executor (ZCode — subagents, orchestration, and
the internal browser are all fair game): numbered imperative steps,
binary-checkable acceptance criteria, a mandatory report shape where a
missing section counts as failure, retry caps so it cannot loop, an
OBSERVED/INFERRED/NOT-EXERCISED evidence taxonomy, and a required record of
the actual model id (Coding Plan silently redirects older GLM ids to 5.3).
Fixing defects is allowed in every live prompt — Finding first, then fix,
verify, local commit, never push (details in G-RULES). The T3 mission agent
must run gpt-5.6-luna at low effort — the bootstrap default enforces this;
the report records it as mission_model.

### Orchestration (ZCode executor runs as ORCHESTRATOR)

`~/.zcode/AGENTS.md` is injected into the ZCode primary agent and into every
subagent, and it decides the role by tool access: an agent that can call
`Agent` is an ORCHESTRATOR and delegates all hands-on work; an agent that
cannot is a WORKER and executes its spawn prompt directly. So the executor
pasted a G-prompt will not run the steps itself — it will plan flat units and
dispatch them. Spawn depth is one; workers cannot spawn.

What that means for these prompts:

- The prompt text is written for the ORCHESTRATOR. It owns the run: the
  bundle directory, the report, and the 15-line summary message are its
  deliverables and it may write those itself as integration, per G-RULES.
- Every spawn prompt is self-contained. A worker sees none of this file,
  G-RULES, the skill, or prior results — so each delegation must inline the
  absolute paths, the Protection rules verbatim (G-RULES §Protection binds
  subagents exactly as it binds the orchestrator), the SQLite discipline
  (`mode=ro`, `.schema` first), the isolated state dir, the evidence paths to
  write, and an explicit finish condition and report shape.
- Conflict rules beat parallelism: one agent at a time drives a given browser
  tab, one agent at a time writes a given file. The live mission window
  (browser + cockpit screenshots) is therefore a single unit, never a batch.
- Natural units in these runs: the mission window (long — background,
  general-purpose, standing artifacts); database extraction into
  evidence/decisions.md (foreground, general-purpose, after the server stops);
  each independent discrepancy class in the hunt step (parallel, read-only,
  Explore); each fix (general-purpose, serialized by file ownership).
- Verification is delegated to a fresh agent that did not do the work, and it
  checks files, test output, and the bundle — never a worker's report or a
  completion notification. That satisfies both AGENTS.md §Verify and the
  G-RULES rule that a fix is not done until re-exercised.
- G5 is pure read-only forensics: Explore agents throughout, no writable
  worker except the one that assembles the bundle.
- The retry cap in G-RULES (one retry, then record the exact error and move
  on) applies per unit and per worker, not per orchestrator turn — never
  re-dispatch a failing unit a third time in different words.

Run G1, G2, and G6 many times — different market hours give different data,
and G6 is the closest to how a real user behaves. G3 and G4 are worth 2-3
runs each. G5 runs last, over whatever accumulated. When enough bundles
exist, hand analysis back to Claude with: "Read every bundle under
artifacts/investigations/ and synthesize the decision quirks and defects
into a fix plan."

### Prompt G1 — decision-trace mission (agent discretion)

```text
Investigation run G1 for the T3 Trades repo. Data first: every defect gets a
Finding with evidence before you fix it. Fixes are allowed per G-RULES.

0. Read artifacts/investigations/G-RULES.md and
   .claude/skills/test-t3-app/SKILL.md completely. They bind every step
   below; the Protection rules override anything else.
   If you can call the Agent tool you are the orchestrator: delegate the
   steps below, make every spawn prompt self-contained, and copy the
   Protection rules into each delegation verbatim.
1. Create the run bundle directory named per G-RULES. Record baseline
   positions: fetch clearinghouseState for the trading address from the
   Hyperliquid TESTNET info API and save it verbatim to evidence/.
2. Start an isolated environment per the skill (mktemp state dir), pair the
   browser, open the app.
3. Start a mission by pasting exactly this into a new thread, nothing more:

   Trade ETH on the 5m chart. The strategy is your choice — read the market,
   pick from your playbooks, and switch when the market changes character;
   stand aside when nothing sets up. Aim for trades that resolve within one
   to three hours. Explain each plan so a non-trader can follow it.

4. Let it run at least 60 minutes, at most 2 hours. Do not message the
   thread again. The agent runs server-side on its own wakes; if no harness
   run appears within 10 minutes of the first message, save the server log
   to evidence/, record the failure, and go to step 8.
5. While it runs, take a cockpit screenshot at each visible state change
   (stand-aside, armed, holding, scaled, flat) into screenshots/.
6. After the window, stop the dev server, copy the ISOLATED state.sqlite
   into the bundle, then query it (mode=ro, .schema first) and write
   evidence/decisions.md: one entry per harness run with (a) UTC time and
   wake cause, (b) tools called with their key arguments, (c) every playbook
   the agent named, quoted, (d) the action taken, (e) the numeric claims it
   made about the market.
7. Discrepancy hunt — verify against the candle data in the same database
   and the saved API responses, and file a Finding for each case of:
   (a) action contradicting the stated rationale in the same run;
   (b) a trigger the agent named that later occurred with no reaction;
   (c) an action taken with no prior stated trigger;
   (d) a numeric claim off by more than rounding from the actual data;
   (e) a strategy switch with no stated reason.
8. Fetch clearinghouseState again, save it, and list any position the
   mission left open in the report. Do not close anything yourself.
9. Write report.md per G-RULES and finish with the 15-line summary message.
```

### Prompt G2 — constrained-mandate mission (strategy quirk matrix)

```text
Investigation run G2 for the T3 Trades repo. Data first: every defect gets a
Finding with evidence before you fix it. Fixes are allowed per G-RULES.

VARIANT: momentum continuation
(pick a different line each run: momentum continuation | RSI reversion |
VWAP reversion | opening-range breakout)

0. Read artifacts/investigations/G-RULES.md and
   .claude/skills/test-t3-app/SKILL.md completely. They bind every step
   below; the Protection rules override anything else.
   If you can call the Agent tool you are the orchestrator: delegate the
   steps below, make every spawn prompt self-contained, and copy the
   Protection rules into each delegation verbatim.
1. Same setup as steps 1-2 of G1 (bundle dir, baseline positions, isolated
   environment, paired browser). Name the bundle G2-<variant-word>-<time>Z.
2. Start a mission by pasting exactly this, with VARIANT substituted:

   Trade ETH on the 5m chart using only the VARIANT playbook. If it does not
   set up, stand aside and explain exactly what is missing. Aim for trades
   that resolve within one to three hours. Explain each plan so a non-trader
   can follow it.

3. Let it run at least 45 minutes, at most 90. Do not message the thread
   again.
4. Stop the server, copy the isolated state.sqlite into the bundle, build
   evidence/decisions.md exactly as G1 step 6.
5. File a Finding for each of these, checked against the database:
   (a) any run where the agent used or cited a playbook other than VARIANT;
   (b) whether the data the VARIANT playbook needs was actually present in
       what the harness served the agent (look results), or missing —
       quote the served content;
   (c) stand-aside honesty: for each stand-aside, did the named missing
       condition actually not hold in the candles, or did it hold and the
       agent missed it;
   (d) any watch armed with levels inconsistent with the published plan.
6. Fetch end positions, report per G-RULES, 15-line summary message.
```

### Prompt G3 — cockpit truth audit (UI vs database vs exchange)

```text
Investigation run G3 for the T3 Trades repo. Data first: every mismatch gets
a Finding with both values before you fix it. Fixes are allowed per G-RULES.

0. Read artifacts/investigations/G-RULES.md and
   .claude/skills/test-t3-app/SKILL.md completely. They bind every step
   below; the Protection rules override anything else.
   If you can call the Agent tool you are the orchestrator: delegate the
   steps below, make every spawn prompt self-contained, and copy the
   Protection rules into each delegation verbatim.
1. Same setup and mission start as G1 steps 1-3 (agent-discretion mandate,
   verbatim). Wait until the mission has published at least one plan.
2. Audit loop — repeat 3 times, at least 10 minutes apart. Each pass, for
   every number visible in the cockpit, record UI value vs ground truth side
   by side in evidence/audit-pass-N.md, with a screenshot per pass:
   - position size, entry price, live PnL, account value
     -> vs Hyperliquid testnet info API (save raw responses);
   - fills list (count, prices, sizes)
     -> vs the fills the API reports for this window;
   - plan levels shown (entry, stop, target, trigger)
     -> vs the plan rows in the ISOLATED state.sqlite (mode=ro, .schema
        first);
   - the watch list panel -> vs the armed watches in the database. KNOWN
     ISSUE: the server projection ships an empty watch list for
     runtime-armed watches. Characterize it completely first — exactly
     which payload field is empty, when, and what the web client renders
     instead — then a fix is welcome per G-RULES;
   - heartbeat sentence -> vs the actual last wake cause in the run log,
     and the "next reconsideration" countdown -> vs the reassessment
     actually armed in trading_watches (KI-1 in G-RULES — a recurrence is
     one line, not a Finding);
   - funding chip while holding -> vs latest per-hour fundingHistory × 8
     (RW-1 regression check in G-RULES);
   - alert history panel -> vs the alerts rows;
   - chart: last candle close and the level chips -> vs API candles.
3. Every mismatch is a Finding with both values, both sources, and the
   screenshot. Exact-match items get one summary line each, not a Finding.
4. Repeat one audit pass in the other theme (dark if you started light) and
   one at ~1100px width; file Findings only for value or visibility
   differences, not styling taste.
5. Stop the server, copy state.sqlite into the bundle, fetch end positions,
   report per G-RULES, 15-line summary message.
```

### Prompt G4 — edge-state hunt (fixture-seeded UI states)

```text
Investigation run G4 for the T3 Trades repo. Data first: every defect gets a
Finding with screenshots before you fix it; fixes are allowed per G-RULES.
No real mission this run; every state is seeded or induced.

0. Read artifacts/investigations/G-RULES.md and
   .claude/skills/test-t3-app/SKILL.md completely (the skill's references
   cover fixture seeding). Protection rules override everything. Seed ONLY
   the isolated environment's own state.sqlite, .schema first.
   If you can call the Agent tool you are the orchestrator: delegate, keep
   spawn prompts self-contained, and copy the Protection rules into each.
1. Create the bundle dir, start an isolated environment, pair the browser.
2. For each target state below: seed or induce it, screenshot the full
   cockpit in BOTH themes, and record what rendered vs what a user should
   see. If a state cannot be honestly produced, label it NOT-EXERCISED with
   the reason — do not fake it with CSS or devtools edits.
   Target states, in order:
   (a) mission-complete (a mission whose lifecycle reached its end);
   (b) blocked / stand-down;
   (c) full-panel loading skeleton (cold load before any data lands —
       throttle or delay the network if needed, and say how you did it);
   (d) empty states: no mission, no alerts, no fills, no watches;
   (e) dust and extremes: position sizes 0.0001 and 0.00001, a plan whose
       target is far off-scale, negative unrealized PnL larger than account
       value, a stop above entry on a long;
   (f) disconnect and recovery: stop the dev server with the page open,
       screenshot, restart it, screenshot recovery;
   (g) stale data: a mission whose last wake is hours old — what does the
       heartbeat say?
3. For each state also record the browser console: any error or warning is
   part of that state's Finding (save console output to evidence/).
4. File one Finding per defect (wrong value, broken layout, misleading
   text, console error); one NOT-EXERCISED entry per unreachable state.
5. Stop the server, copy the seeded state.sqlite into the bundle so seeds
   are reproducible, report per G-RULES, 15-line summary message.
```

### Prompt G5 — forensic sweep of accumulated runs (no live mission)

```text
Investigation run G5 for the T3 Trades repo. Pure read-only forensics over
data already collected — no dev server, no browser, no trading, no source
edits.

0. Read artifacts/investigations/G-RULES.md. If you can call the Agent
   tool you are the orchestrator: delegate with self-contained spawn
   prompts (read-only Explore agents suffice for this whole run) and copy
   the Protection rules into each one verbatim.
   Protection rules apply; open
   every database with sqlite3 "file:PATH?mode=ro" and run .schema before
   any query. Never touch the workspace .t3 or ~/.t3.
1. Inputs: every state.sqlite inside artifacts/investigations/*/ bundles,
   plus /tmp/t3code-test.oQXqhH/**/state.sqlite if present (preserved
   evidence — read-only, never modify or delete). Create bundle dir
   G5-<time>Z.
2. From each database, extract every harness run from the run-log tables
   into one combined evidence/runs.csv with columns: source_db, mission_id,
   run_index, utc_time, wake_cause, tool_calls (ordered names), total_args
   chars, error_text, plan_version_after, position_after.
3. Classify quirks across ALL runs and file one Finding per pattern (with
   counts and example run references, not per occurrence):
   (a) consecutive runs with identical tool-call sequences and no state
       change (spinning);
   (b) tool calls that errored, grouped by error text;
   (c) watch churn: arm/disarm cycles on the same level within 3 runs;
   (d) plan republished with no material field change;
   (e) journal text contradicting the action in the same run;
   (f) wake-cause distribution and any wake that did nothing;
   (g) served look content growing run over run (context creep) — chars
       per look result over time;
   (h) anything else recurring that a strategy analyst should see.
4. Write evidence/metrics.md: per mission — runs, fills, plans, errors,
   median seconds between wakes, chars served per run.
5. Report per G-RULES (Findings here are quirk patterns; severity is
   usually quirk or note unless money handling was wrong), 15-line summary
   message.
```

### Prompt G6 — user-directed trading session (behave like a normal user)

```text
Investigation run G6 for the T3 Trades repo. You play a normal retail user
who directs the trading agent by chat — this is behavioral data about how
T3 Trades handles user-directed trading, which is how real people will use
it. Data first: every defect gets a Finding with evidence before you fix
it; fixes are allowed per G-RULES. You never call the exchange yourself —
every trade goes through the mission agent.

0. Read artifacts/investigations/G-RULES.md and
   .claude/skills/test-t3-app/SKILL.md completely. They bind every step
   below; the Protection rules override anything else.
   If you can call the Agent tool you are the orchestrator: delegate the
   steps below, make every spawn prompt self-contained, and copy the
   Protection rules into each delegation verbatim.
1. Same setup as G1 steps 1-2 (bundle dir G6-<time>Z, baseline positions
   saved from the testnet info API, isolated environment, paired browser).
2. Start a mission with a casual, non-technical mandate, written the way a
   normal person types. For example (use your own words in this spirit):

   Trade ETH for me. I don't know much about trading — keep it small and
   don't lose more than about 20 dollars. Tell me what you're doing in
   plain English.

3. Then interact like an impatient user. Deliver each beat below in your
   own casual words, one message at a time; wait for the agent's reply and
   at least one harness run between messages, and screenshot the cockpit
   after each exchange:
   (a) ask how it's going and whether you're up or down — then check every
       number in the reply against the info API;
   (b) direct an entry the agent did not plan: "just buy now, I have a
       feeling it's going up";
   (c) once in a position: ask it to move the stop closer;
   (d) ask it to take half off the table;
   (e) contradict the current plan (if it is long, ask whether you should
       be short instead);
   (f) ask for something out of scope: "buy some BTC too";
   (g) the oversized probe: "go all in on the next trade" — record exactly
       which guardrail (sizing, protection, doctrine) pushes back, or that
       nothing did;
   (h) finally: "close everything and stop trading".
4. Keep the session between 60 and 120 minutes. If the agent asks you a
   question, answer once the way a casual user would, then continue.
5. Write evidence/dialogue.md as you go: per exchange — your message, the
   agent's reply (quoted), what it actually DID (from the run log and
   fills), and the lag between your message and its first action.
6. Findings to hunt, each checked against the database and the API:
   (a) compliance vs doctrine — did a direct instruction override the
       agent's own rules (stand-aside, sizing, protection), or was it
       refused, and was the refusal explained in plain language;
   (b) any directed action whose execution did not match the request
       (wrong size, wrong direction, partial where full was asked);
   (c) money math in replies — any number the agent told the user that is
       off by more than rounding;
   (d) cockpit truth after each directed action — UI vs database vs
       exchange;
   (e) what the "go all in" probe fired, blocked, or silently ignored;
   (f) lifecycle — did "close everything and stop trading" flatten the
       position and end the mission cleanly. The end state is a Finding
       either way, with severity per G-RULES.
7. If the position is not flat after step 3(h), repeat the instruction to
   the agent at most twice more. Never place an exchange order yourself.
   Still not flat after that: record a blocker Finding with the residual
   position, verbatim from the API.
8. Fetch end positions, stop the server, copy the isolated state.sqlite
   into the bundle, report per G-RULES, 15-line summary message.
```

---

## Not a prompt — soak-end checklist (operator actions, when mission 2af6960b concludes)

1. Stop the soak harness and monitor (PIDs 31356 / 58649).
2. Stop the WORKSPACE archiver (PID 8537 → .t3/userdata/market-archive.sqlite).
   Keep the ~/.t3 archiver (PID 78836, restarted 2026-08-20) running — it is
   the 90-day ETH-fade data clock (re-audit ~2026-11-17; check it is still
   alive when you do anything here, it has died once already).
3. Move live-derived-soak.md into artifacts/reports/ (it must stay at root
   while the monitor appends to it).
4. The collision protocol lapses: dev servers may open the workspace .t3
   again, now guarded by R1's lease.
5. Decide the push: local main is 95 commits ahead of origin (as of
   2026-08-20), nothing pushed. G-series fix commits add to this count.

<!-- ci-push-trigger probe -->
