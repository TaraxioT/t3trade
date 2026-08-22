# P9a: read-only perf/a11y census - DONE

Deliverable written: `apps/marketing/audit/perf-a11y.md` (all seven tables,
every row file:line, contrast math shown, JS budget verdict cited).

Key findings for the fixer:
- Zero LAYOUT-property animations anywhere; the census is clean on that axis.
- Two clause-10 reduced-motion gaps: the agent-log feed rests at the top of the
  story (AgentLog.astro:193-196) and the position state tokens never reach
  Closed/Done (Positions.astro:299). Plus a minor one: .stop-hold rests at
  opacity 0 (Chart.astro:566-571).
- aria-hidden wholesale on the positions table and status bar.
- Hard AA failures: --fg-faint as text ink everywhere (2.6-2.7), rr-seg risk
  2.97 / reward 3.84, chip captions 3.00, chip--stop 4.39, grid labels 2.10.
- Payload: JS 2,287 B raw / 1,160 B gz (budget 12 kB - PASS, ~10%). CSS
  106,485 / 19,129 gz. 1.29 MB of unreferenced public/icon.png+icon.webp.
- will-change: exactly one (Tape.astro:56), correctly placed.
- Grain/vignette overlays: all fixed or pinned-viewport absolutes, all
  pointer-events:none. Clean.

No repo files edited besides the two owned by this mission. P8 churn note:
src/components/** was untracked/new on disk during the read; line numbers
refer to the working tree state of 2026-08-22.
