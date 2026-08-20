#!/usr/bin/env bash
#
# How far T3 Trade has drifted from its pinned upstream baseline, and how
# expensive the next sync looks.
#
# Prints the commit count in the unsynced range and a per-file conflict
# forecast from `git merge-tree`, so a sync is scheduled by measurement rather
# than by how long it has been since the last one. See
# docs/upstream/SYNC_RUNBOOK.md for the thresholds this feeds.
#
#   scripts/upstream-drift.sh            # human-readable report
#   scripts/upstream-drift.sh --json     # one JSON object, for CI
#
# Set UPSTREAM_DRIFT_JSON_PATH to also write the JSON object to that file. A
# consumer that wants both the prose and the machine object gets them from one
# measurement that way, rather than from two runs that can straddle an upstream
# push and disagree about the head they measured.
#
# Exits 0 when drift is under both thresholds, 1 when either is exceeded, and
# 2 when the drift cannot be measured at all — no upstream remote, or a
# `git merge-tree` that failed outright rather than reporting conflicts.

set -euo pipefail

# Sync when either is crossed, whichever comes first. The 259-commit v0.0.34
# range produced 28 conflicts; smaller batches shrink superlinearly, which is
# the whole argument for a low ceiling.
COMMIT_THRESHOLD=150
CONFLICT_THRESHOLD=15

json_output=false
if [[ $# -eq 1 && "$1" == "--json" ]]; then
  json_output=true
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--json]" >&2
  exit 2
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "No 'upstream' remote. See docs/upstream/SYNC_RUNBOOK.md." >&2
  exit 2
fi

if ! git fetch --quiet upstream main; then
  echo "Failed to fetch upstream/main; drift not measured." >&2
  exit 2
fi

if ! baseline=$(git merge-base main upstream/main); then
  # Unrelated histories: there is no range to measure, and treating that as
  # zero drift would be a lie the weekly run repeats forever.
  echo "No common ancestor between main and upstream/main; drift not measured." >&2
  exit 2
fi
upstream_head=$(git rev-parse upstream/main)

if [[ "$baseline" == "$upstream_head" ]]; then
  behind=0
else
  behind=$(git rev-list --count "${baseline}..${upstream_head}")
fi

# `git merge-tree` writes the conflicted paths to stdout ahead of its
# human-readable log, and exits 1 when there are conflicts at all — so status 1
# is information, not a failure. Anything above that is a real failure, and its
# output says nothing about drift.
#
# `core.quotePath=true` is git's default, but a repo- or user-level override
# would let a non-UTF-8 path through verbatim and make `--json` unparseable.
merge_status=0
conflicts=""
if [[ "$behind" -gt 0 ]]; then
  merge_output=$(git -c core.quotePath=true merge-tree --write-tree --name-only main upstream/main) || merge_status=$?
  if [[ "$merge_status" -gt 1 ]]; then
    echo "git merge-tree failed (status $merge_status); drift not measured." >&2
    exit 2
  fi
  # First line is the tree oid; the paths follow until the first blank line.
  conflicts=$(printf '%s\n' "$merge_output" | tail -n +2 | sed -n '/^$/q;p')
fi

conflict_count=0
if [[ -n "$conflicts" ]]; then
  conflict_count=$(printf '%s\n' "$conflicts" | wc -l | tr -d ' ')
elif [[ "$merge_status" -ne 0 ]]; then
  # Some conflict classes (a binary/submodule clash, an unresolvable rename)
  # set the exit status without naming a path. Counting them as zero would
  # report a clean forecast for a merge that will not apply.
  conflict_count=1
fi

over_threshold=false
if [[ "$behind" -gt "$COMMIT_THRESHOLD" || "$conflict_count" -gt "$CONFLICT_THRESHOLD" ]]; then
  over_threshold=true
fi

# Git C-quotes paths with unusual bytes, which still leaves backslashes and
# double quotes in the line — escape both before wrapping, or one odd path
# makes the whole report unparseable.
files_json=$(printf '%s\n' "$conflicts" | sed '/^$/d' |
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/.*/"&"/' | paste -sd, -)
json_report=$(printf '{"baseline":"%s","upstreamHead":"%s","commitsBehind":%s,"forecastConflicts":%s,"overThreshold":%s,"conflictFiles":[%s]}' \
  "$baseline" "$upstream_head" "$behind" "$conflict_count" "$over_threshold" "$files_json")

if [[ -n "${UPSTREAM_DRIFT_JSON_PATH:-}" ]]; then
  # An unwritable path is a delivery failure, not a threshold: letting `set -e`
  # abort here would exit 1, which every caller reads as "sync due".
  if ! printf '%s\n' "$json_report" > "$UPSTREAM_DRIFT_JSON_PATH"; then
    echo "Failed to write JSON to '$UPSTREAM_DRIFT_JSON_PATH'; drift not reported." >&2
    exit 2
  fi
fi

if [[ "$json_output" == true ]]; then
  printf '%s\n' "$json_report"
else
  echo "Baseline:      ${baseline:0:9}"
  echo "upstream/main: ${upstream_head:0:9}"
  echo "Behind by:     $behind commit(s)   (sync at > $COMMIT_THRESHOLD)"
  echo "Conflicts:     $conflict_count file(s)     (sync at > $CONFLICT_THRESHOLD)"
  if [[ -n "$conflicts" ]]; then
    echo
    echo "Forecast conflicts:"
    printf '%s\n' "$conflicts" | sed 's/^/  /'
  fi
  echo
  if [[ "$over_threshold" == true ]]; then
    echo "Over threshold — sync now. See docs/upstream/SYNC_RUNBOOK.md."
  else
    echo "Under both thresholds."
  fi
fi

[[ "$over_threshold" == true ]] && exit 1
exit 0
