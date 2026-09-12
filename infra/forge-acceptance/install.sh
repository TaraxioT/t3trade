#!/bin/sh
# Install host-reviewed Forge acceptance fixtures into a server state dir.
#
# ForgeAcceptance reads ONLY <stateDir>/forge/acceptance/<capabilityId>/v<version>.json.
# The JSON files next to this script are reviewed setup DATA — the running host
# never imports them from source (expectations travel in setup, never in host
# source). Install once per state dir before the first capability build:
#
#   infra/forge-acceptance/install.sh ~/.t3trade/dev
#
# Re-running overwrites prior installed copies of the SAME reviewed files.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <stateDir>" >&2
  exit 2
fi

state_dir=$1
if [ ! -d "$state_dir" ]; then
  echo "stateDir does not exist: $state_dir" >&2
  exit 1
fi

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
installed=0
for file in "$here"/*/v*.json; do
  [ -f "$file" ] || continue
  rel=${file#"$here"/}
  target="$state_dir/forge/acceptance/$rel"
  mkdir -p "$(dirname "$target")"
  cp "$file" "$target"
  echo "installed $rel"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "no fixtures found next to $0" >&2
  exit 1
fi
echo "done: $installed fixture file(s) under $state_dir/forge/acceptance/"
