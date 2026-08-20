# Upstream Sync Runbook

How to pull an accepted batch of upstream commits from
`https://github.com/pingdotgg/t3code.git` into `origin/main`, per the Git
strategy repository model. Follow this exactly — the accepted-baseline tag
and `docs/upstream/BASELINE.md` are the audit trail; skipping steps breaks
that trail.

## Preconditions

- `origin` resolves to the writable T3 Trade fork
  (`https://github.com/TaraxioT/t3trade.git`).
- `upstream` resolves to `https://github.com/pingdotgg/t3code.git`, fetch-only
  (`git remote get-url --push upstream` must NOT return a usable URL).
- Local `main` is up to date with `origin/main`.

## Steps

1. **Fetch and pick the tag to sync to.**

   ```sh
   git fetch --tags upstream
   git tag --list --sort=-creatordate 'v*' \
     --no-merged <current-baseline-SHA> --merged upstream/main | head
   git log --oneline <current-baseline-SHA>..<newBaselineTag>
   ```

   The upper bound of a batch is always an upstream tag — a release tag, or
   a nightly tag when no release exists in the range (rule 2 below). Never
   `upstream/main` itself: its tip is usually untagged, and `BASELINE.md`
   has to record the upstream release/nightly tag at the pin. Picking a tag
   is also how you take a smaller/safer batch than the full range.

   The two ref filters matter: `--merged upstream/main` keeps the tag on the
   line being synced, and `--no-merged <current-baseline-SHA>` drops the
   current baseline's own tag and everything before it. Without the second
   one the list offers tags that merge to a no-op while step 7 happily
   retags an old commit as the new baseline.

   `<newBaselineTag>` is the _new_ candidate baseline; `<newBaselineSHA>` is
   the commit it resolves to (`git rev-parse <newBaselineTag>^{commit}`).

2. **Create the review branch.**

   ```sh
   git checkout -b sync/upstream-YYYY-MM-DD-<newShortSHA> main
   ```

   Name it after the _new_ candidate baseline commit's date and short SHA,
   not today's date if they differ.

3. **Merge the batch.**

   ```sh
   git merge --no-ff <newBaselineTag>
   ```

   Merge the tag, not `upstream/main` — merging the branch accepts whatever
   its tip happens to be, which is how an untagged commit becomes a baseline
   that `BASELINE.md` cannot describe.

   `--no-ff` is required: it produces a real merge commit even when the
   range is a linear fast-forward, so the sync is a visible, revertable
   unit in `main`'s history rather than silently rewriting it.

4. **Resolve conflicts against `docs/upstream/PATCH_LEDGER.md`.**

   Every conflict should correspond to a seam already listed in the ledger.
   If a conflict shows up in a file the ledger doesn't mention, the ledger
   is out of date — fix the ledger as part of this sync, not as a follow-up.

5. **Run the full gate.**

   ```sh
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm lint --report-unused-disable-directives
   pnpm test
   pnpm build
   ```

   All must pass on the merge commit before it can be proposed.

6. **Open the sync PR.**

   Base: `origin/main`. Head: the `sync/upstream-...` branch. Merge it with
   **"Create a merge commit"** — never squash, never rebase (see the rules
   below). The PR description must state:
   - The commit range (`<oldBaseline>..<newBaseline>`)
   - Who reviewed it and what conflicts (if any) were resolved
   - Links to the gate run (step 5) for both upstream's own tests and T3
     Trades' conformance tests
   - The new tag name this sync will create once merged

7. **On merge: tag and record.**

   ```sh
   git tag -a upstream-base/YYYY-MM-DD-<newShortSHA> <newBaselineSHA> \
     -m "Accepted upstream baseline: pingdotgg/t3code@<newBaselineSHA>"
   git push origin upstream-base/YYYY-MM-DD-<newShortSHA>
   ```

   Update `docs/upstream/BASELINE.md` with the new SHA, the upstream
   release/nightly tag from step 1, the accepted-baseline tag created here,
   the date, and a link to the sync PR — in the same PR or an immediate
   follow-up commit on `main`.

## Cadence: when to sync

Do not sync on a calendar alone. `scripts/upstream-drift.sh` measures the two
numbers that decide the cost, and `.github/workflows/upstream-drift.yml` runs
it every Monday and opens (or updates) a single `upstream-sync` tracking issue
when either is crossed:

| Signal                      | Threshold |
| --------------------------- | --------- |
| Commits behind the baseline | > 150     |
| `merge-tree` conflict files | > 15      |

Whichever comes first. These are ceilings, not targets — weekly is the default
rhythm, and a quiet week that stays under both is a week you can skip.

The thresholds are set from measurement: the v0.0.33 sync took 236 commits in
two batches, and the v0.0.34 sync took 259 commits in one and produced 28
conflicts. Conflict cost does not grow linearly with range size — a rewrite
upstream lands once, but every fork line inside it conflicts — so halving the
range does much better than halving the work.

```sh
scripts/upstream-drift.sh          # report
scripts/upstream-drift.sh --json   # for tooling; exits 1 when over threshold
```

## Rules that are not negotiable

1. **Sync PRs merge with a merge commit. Never squash, never rebase.** The
   squash on PR #22 orphaned the entire ancestry and had to be repaired with a
   stitch merge. A squash discards the second parent, which makes the next
   sync's `git merge-base` wrong and turns the following sync into a
   re-resolution of every seam already resolved.
2. **Sync to an upstream tag, always.** A nightly tag is fine when no stable
   release exists — v0.0.34 had none. Record that tag in `BASELINE.md`; the
   `upstream-base/...` tag step 7 creates is fork-local and does not stand in
   for it.
3. **Never sync with a dirty tree.** Checkpoint or branch the WIP first. A
   conflict resolution that has to be told apart from unrelated local edits is
   a resolution you cannot review.
4. **`git add -A` is not how a sync gets staged.** It sweeps in untracked
   working notes, and CI's formatter is what will tell you — after the PR is
   open. Stage the resolved paths.
5. **Every plan that touches a seam file adds its ledger row in the same
   commit.** The ledger going stale is what makes conflict resolution slow: on
   the v0.0.34 sync it had not moved in twelve plans, and rediscovering each
   seam cost more than resolving it.

## Where the fork's own code lives

Seams are cheapest when upstream cannot reach them. Fork-owned files never
conflict, so anything that can move into one should:

| Instead of adding to…    | Put it in…                           |
| ------------------------ | ------------------------------------ |
| `apps/web/src/index.css` | `apps/web/src/trading.css`           |
| an upstream component    | `apps/web/src/components/trading/**` |
| upstream server modules  | `apps/server/src/trading/**`         |
| upstream contracts       | `packages/trading-contracts/**`      |

`trading.css` exists for exactly this reason: upstream rewrote 1600 lines of
`index.css` in `9885a845c` and every fork rule inside it conflicted. When a
seam has to stay in an upstream file, keep it to the smallest possible
insertion — an optional prop, one import, one call — and write it down in
`PATCH_LEDGER.md`.

## Rehearsal record (PROMPT-00 validation)

This procedure was dry-run once to validate it before any trading code
exists:

- Review branch: `sync/upstream-2026-07-30-a8e05cbb`, created from
  `main@694f8d1c` (the `v0.0.30` release point).
- Merged `upstream/main` at `a8e05cbb92633a1351529f2bc402071f615e5051`
  (`v0.0.31`) with `git merge --no-ff`.
- Result: a clean merge commit (`9ea39265`), zero conflicts — the 12-commit
  range `694f8d1c..a8e05cbb` applied cleanly. The resulting tree was
  byte-identical to `main`, confirming the rehearsal reproduced the real
  baseline.
- The rehearsal branch is local-only and is not merged into `main` (`main`
  was already pinned directly at `a8e05cbb`, see `BASELINE.md`); it exists
  to prove the procedure, not to move the baseline.
