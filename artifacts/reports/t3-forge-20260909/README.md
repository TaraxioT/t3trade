# T3 Forge — September 9–11, 2026

The user explicitly requested these plans be staged and committed. This directory is an intentional exception to the normal untracked-artifact convention.

- [Implementation plan](implementation-plan.html) — authoritative product/technical plan, snippets, F0–F7 and human gates.
- [Implementation prompts](implementation-prompts.md) — agent-readable export of the same phase prompts.
- [Unified graph UI plan](unified-graph-ui-plan.html) — independent premium UI direction, schematic, U0–U2 and human gates.
- [UI prompts](unified-graph-ui-prompts.md) — agent-readable UI prompt export.

Open either HTML file directly; CSS, JavaScript and prompt content are inline. Copy/export controls are included. No external assets are required. UI preview states are layout schematics, not simulated market data.

This pack supersedes the old continuity/fork-rehearsal and broad-polish roadmap for the scoped Forge campaign. It does not execute those plans, implement the features or claim the live dependencies have passed. Core uses current real Graph observations and real public-testnet transactions; authentic historical comparisons are labeled and cannot drive live policy. Every implementation phase requires an actual human gate. All gates start pending.

Artifact checks: HTML anchors/local links/prompt JSON, exact HTML-to-Markdown prompt parity and JavaScript syntax passed. Isolated JavaScript checks for copy/export, prompt disclosure, layout-state selection and evidence disclosure also passed; these are not browser tests. Product implementation/live-dependency checks are future phase gates, not completed tests.

Deployed 2026-09-09 to Cloudflare Pages project `t3-forge-plan` at https://t3-forge-plan.pages.dev (index plus the four files above, byte-identical to this directory at `df96165b3`; redeploy with `wrangler pages deploy <dir> --project-name t3-forge-plan --branch main`). First real-browser verification happened on the deployed site: both plans render, `.html` links 308 to pretty URLs that serve 200, and the prompt-disclosure control opens the full U0/U1/U2 prompt text. Copy-to-clipboard and responsive behavior remain unverified.

## Static unification review — 2026-09-09

Reviewed current source at `0c8304eb3` and both supplied September 2 images without starting any server/browser or touching application data. The full chart image is the real weekly/EMA/event-scene baseline; the other image shows a disconnected Trade page.

The corrected UI pack preserves the legacy chart and specifies the actual composer/layout integration, source-specific views, missing Forge chart/diagnostic/read-model prerequisites, no-Hyperliquid-focus discovery, refresh-key/stale-display repairs, per-context state and scoped regression gates. Execution order is F1–F3 → U0 → U1 → F5 → U2; in the main schedule U0/U1 are F4 and U2 is F6. When the main prompts have already completed, reuse their outputs and execute only missing bridge/UI work, then reverify the affected demo.

No runtime or visual-browser acceptance is claimed by this static review. Both HTML prompt copies and Markdown exports are updated together.
