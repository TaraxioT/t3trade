# Upstream Baseline

This file records the pinned upstream commit that T3 Trade' fork was built
from, per the Git strategy repository model. See `SPEC_EVIDENCE.md` for the
separately tracked pin of the requirements/spec commit this baseline's
acceptance criteria were checked against.

## Current baseline

| Field                       | Value                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream repository         | `https://github.com/pingdotgg/t3code.git`                                                                                                                  |
| Upstream branch             | `main`                                                                                                                                                     |
| Pinned commit (full SHA)    | `09e8de9c655ae85410bf6b00446f272a01da81c7`                                                                                                                 |
| Pinned commit (short SHA)   | `09e8de9c6`                                                                                                                                                |
| Upstream commit date        | 2026-09-07                                                                                                                                                 |
| Upstream release tag at pin | `v0.0.40`                                                                                                                                                  |
| Accepted-baseline tag       | `upstream-base/2026-09-07-09e8de9c6`                                                                                                                       |
| Fork repository             | `https://github.com/TaraxioT/t3trade.git`                                                                                                                  |
| Fork product line           | `origin/main`                                                                                                                                              |
| Pinned by                   | Upstream sync to v0.0.40                                                                                                                                   |
| Pinned on                   | 2026-09-09                                                                                                                                                 |
| Sync PR                     | none — merged locally on `sync/upstream-2026-09-07-09e8de9c6`, at the user's explicit instruction (direct push to main; repo rule forbids unrequested PRs) |
| Accepted range              | `f925d6394..09e8de9c6` (879 upstream commits, two batches: v0.0.38 then v0.0.40)                                                                           |

v0.0.40 is the latest stable release; `v0.0.41` nightlies exist but no
stable tag — the nightly is the next sync candidate, not part of this one.

## Superseded baseline (v0.0.35)

| Field                       | Value                                                    |
| --------------------------- | -------------------------------------------------------- |
| Upstream repository         | `https://github.com/pingdotgg/t3code.git`                |
| Upstream branch             | `main`                                                   |
| Pinned commit (full SHA)    | `f925d639421844f02b3166d29281905dbba6d529`               |
| Pinned commit (short SHA)   | `f925d6394`                                              |
| Upstream commit date        | 2026-08-26                                               |
| Upstream release tag at pin | `v0.0.35`                                                |
| Accepted-baseline tag       | `upstream-base/2026-08-26-f925d6394`                     |
| Fork repository             | `https://github.com/TaraxioT/t3trade.git`                |
| Fork product line           | `origin/main`                                            |
| Pinned by                   | Upstream sync to v0.0.35                                 |
| Pinned on                   | 2026-08-28                                               |
| Sync PR                     | none — merged locally on `sync/v0.0.35`, not pushed      |
| Accepted range              | `beab6886f..f925d6394` (133 upstream commits, one batch) |

The previous baseline was the `v0.0.34-nightly.20260820.1142` nightly, which
sits **127 commits before** upstream's stable `v0.0.34` (`badae6a5c`,
2026-08-26). This batch therefore carries the whole v0.0.34 release as well as
v0.0.35's own six commits — measuring `v0.0.34..v0.0.35` (6 commits) badly
understates a sync taken from a nightly pin. Prefer stable tags as baselines
for exactly this reason.

## Superseded baseline (Plan 40 · v0.0.34-nightly)

| Field                       | Value                                                          |
| --------------------------- | -------------------------------------------------------------- |
| Upstream repository         | `https://github.com/pingdotgg/t3code.git`                      |
| Upstream branch             | `main`                                                         |
| Pinned commit (full SHA)    | `beab6886f45bf42906d0bd01aefe5dfe9e66a867`                     |
| Pinned commit (short SHA)   | `beab6886f`                                                    |
| Upstream commit date        | 2026-08-20                                                     |
| Upstream release tag at pin | `v0.0.34-nightly.20260820.1142` (no stable v0.0.34 exists yet) |
| Accepted-baseline tag       | `upstream-base/2026-08-20-beab6886f`                           |
| Fork repository             | `https://github.com/TaraxioT/t3trade.git`                      |
| Fork product line           | `origin/main`                                                  |
| Pinned by                   | Plan 40 · Upstream sync to v0.0.34-nightly                     |
| Pinned on                   | 2026-08-20                                                     |
| Sync PR                     | https://github.com/TaraxioT/t3trade/pull/7                     |
| Accepted range              | `3b72d17cb..beab6886f` (259 upstream commits, one batch)       |

## Superseded baseline (Plan 26 · v0.0.33)

| Field                       | Value                                                               |
| --------------------------- | ------------------------------------------------------------------- |
| Upstream repository         | `https://github.com/pingdotgg/t3code.git`                           |
| Upstream branch             | `main`                                                              |
| Pinned commit (full SHA)    | `3b72d17cbca691f0b64e6d4a10c9e349f42873a5`                          |
| Pinned commit (short SHA)   | `3b72d17cb`                                                         |
| Upstream commit date        | 2026-08-10                                                          |
| Upstream release tag at pin | `v0.0.33`                                                           |
| Accepted-baseline tag       | `upstream-base/2026-08-10-3b72d17cb`                                |
| Fork repository             | `https://github.com/TaraxioT/t3trade.git`                           |
| Fork product line           | `origin/main`                                                       |
| Pinned by                   | Plan 26 · Upstream sync to v0.0.33                                  |
| Pinned on                   | 2026-08-13                                                          |
| Accepted range              | `a8e05cbb..3b72d17cb` (236 upstream commits, merged in two batches) |

## Superseded baseline (PROMPT-00)

| Field                           | Value                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| Upstream repository             | `https://github.com/pingdotgg/t3code.git`                                            |
| Upstream branch                 | `main`                                                                               |
| Pinned commit (full SHA)        | `a8e05cbb92633a1351529f2bc402071f615e5051`                                           |
| Pinned commit (short SHA)       | `a8e05cbb`                                                                           |
| Upstream commit date            | 2026-07-29                                                                           |
| Upstream package version at pin | `0.0.31`                                                                             |
| Accepted-baseline tag           | `upstream-base/2026-07-29-a8e05cbb`                                                  |
| Fork repository                 | `https://github.com/TaraxioT/t3trade.git`                                            |
| Fork product line               | `origin/main`                                                                        |
| Fork version at baseline        | `0.0.31` (unchanged from upstream; fork versioning splits at the first fork release) |
| Pinned by                       | PROMPT-00 · Fork and integration baseline                                            |
| Pinned on                       | 2026-07-30                                                                           |

## How this was pinned

1. Cloned `https://github.com/pingdotgg/t3code.git` with
   `--single-branch --branch main`.
2. Renamed the cloned remote to `upstream` and disabled its push URL.
3. Added the writable fork `https://github.com/TaraxioT/t3trade.git`
   as `origin`.
4. Configured `upstream` to fetch only `main`
   (`+refs/heads/main:refs/remotes/upstream/main`).
5. Recorded `upstream/main` at `a8e05cbb92633a1351529f2bc402071f615e5051`
   as the accepted baseline and created the immutable annotated tag
   `upstream-base/2026-07-29-a8e05cbb` pointing at it.
6. `main` on the fork descends directly from this commit; no trading code
   has been added yet.

## Updating this file

Each future accepted upstream sync batch (see `SYNC_RUNBOOK.md`) must:

- Add a new row (or superseding section) recording the new pinned SHA, tag,
  and date — do not silently overwrite history.
- Create a new immutable `upstream-base/YYYY-MM-DD-<shortSHA>` tag; never
  reuse or move an existing tag.
- Reference the rehearsal/production sync PR that performed the merge.
