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
# Exits 0 when drift is under both thresholds, 1 when either is exceeded, and
# 2 when the repository is not set up for a sync at all.

set -euo pipefail

# Sync when either is crossed, whichever comes first. The 259-commit v0.0.34
# range produced 28 conflicts; smaller batches shrink superlinearly, which is
# the whole argument for a low ceiling.
COMMIT_THRESHOLD=150
CONFLICT_THRESHOLD=15

json_output=false
if [[ "${1:-}" == "--json" ]]; then
  json_output=true
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--json]" >&2
  exit 2
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "No 'upstream' remote. See docs/upstream/SYNC_RUNBOOK.md." >&2
  exit 2
fi

git fetch --quiet upstream main

baseline=$(git merge-base main upstream/main)
upstream_head=$(git rev-parse upstream/main)

if [[ "$baseline" == "$upstream_head" ]]; then
  behind=0
else
  behind=$(git rev-list --count "${baseline}..${upstream_head}")
fi

# `git merge-tree` writes the conflicted paths to stdout ahead of its
# human-readable log, and exits non-zero when there are conflicts at all — so
# the exit status is information, not a failure.
conflicts=""
if [[ "$behind" -gt 0 ]]; then
  merge_output=$(git merge-tree --write-tree --name-only main upstream/main || true)
  # First line is the tree oid; the paths follow until the first blank line.
  conflicts=$(printf '%s\n' "$merge_output" | tail -n +2 | sed -n '/^$/q;p')
fi

conflict_count=0
if [[ -n "$conflicts" ]]; then
  conflict_count=$(printf '%s\n' "$conflicts" | wc -l | tr -d ' ')
fi

over_threshold=false
if [[ "$behind" -gt "$COMMIT_THRESHOLD" || "$conflict_count" -gt "$CONFLICT_THRESHOLD" ]]; then
  over_threshold=true
fi

if [[ "$json_output" == true ]]; then
  files_json=$(printf '%s\n' "$conflicts" | sed '/^$/d' | sed 's/.*/"&"/' | paste -sd, -)
  printf '{"baseline":"%s","upstreamHead":"%s","commitsBehind":%s,"forecastConflicts":%s,"overThreshold":%s,"conflictFiles":[%s]}\n' \
    "$baseline" "$upstream_head" "$behind" "$conflict_count" "$over_threshold" "$files_json"
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
