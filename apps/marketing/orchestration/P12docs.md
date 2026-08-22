# P12docs — remove AI fake screenshot from docs surfaces

## Status: complete (2026-08-21)

## Changes

- `README.md:15` — replaced the `docs/media/t3trade-mission.png` embed with
  `docs/media/mission-live-panel.webp` (width kept at 920), new truthful alt
  (see below).
- `docs/media/mission-live-panel.webp` — byte copy of
  `apps/marketing/public/capture/mission-live-panel-desktop.webp`
  (2812x1560 WebP, 94,552 bytes). Nothing written back into `apps/marketing/`.
- `scripts/build-t3trade-themed-assets.py` — removed the
  `docs/media/t3trade-mission.png` (1840, 1177, PNG) entry from
  `hero_targets`. It was a pure PIL resize of `HERO_ART` (the AI-generated
  jpg), no theming depended on its geometry. Replaced with a verbatim
  `shutil.copyfile` of the real capture into
  `assets/themed-t3trade/docs/media/mission-live-panel.webp`. Script not
  executed (it stages many assets and its ARTIFACT_DIR inputs are external);
  syntax-checked with `ast.parse` only.
- `docs/media/t3trade-mission.png` — deleted (was 1,812,912 bytes).

## Alt text (verified against the capture via agy-vision)

"T3 Trade running an ETH/USD mission at 1,869.4 (+1.84%): a chart with target,
entry and stop levels, two 5x long positions, and an agent log showing the
agent's fills and armed watches"

Vision pass confirmed: ETH/USD 1,869.4 +1.84%, target 1,878.2 / entry 1,864.2 /
stop 1,858.1, 1.2:1 R:R, two ETH 5x Long positions (one OPEN at 1,864.2, one
WORKING at 1,858.1), agent log with fills (0.5 ETH open at 1,864.2, short
close at 1,858.4, short open at 1,855.1, earlier fills) and four armed
condition triggers.

## Remaining textual mentions (intentionally left)

- `apps/marketing/DESIGN-CONTRACT.md:64` — the ban clause itself.
- `marketingredesignprompts.md` — the plan file.
- `apps/marketing/orchestration/P7.md` — historical progress notes.
- `scripts/build-t3trade-themed-assets.py:214` — comment explaining the
  replacement.
