#!/bin/sh
# Build the T3 Forge sandbox runner image from a reviewed base digest.
#
# Setup-time, host-run tool. It exists so the sealed containment image the
# server executes (T3_FORGE_SANDBOX_IMAGE) is built once from a base image the
# host verified by sha256 digest — never from anything a model authored. The
# Dockerfile beside this script is the only Dockerfile involved and it is
# host-reviewed; capability bundles never carry Dockerfiles.
#
# Usage:
#   infra/forge-runner/build.sh --base <repo@sha256:<64 hex>> [--smoke]
#
# Prints the two exports the server reads:
#   export T3_FORGE_SANDBOX_IMAGE=t3-forge-runner@sha256:<digest>
#   export T3_FORGE_SANDBOX_RUNNER=docker
set -eu
# pipefail where the shell has it (POSIX sh does not guarantee it).
if (set -o pipefail 2>/dev/null); then
  set -o pipefail
fi

IMAGE_TAG="t3-forge-runner:local"
IMAGE_NAME="t3-forge-runner"

die() {
  echo "build.sh: $1" >&2
  exit 1
}

usage() {
  echo "usage: $0 --base <repo@sha256:<64 hex>> [--smoke]" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

BASE=""
SMOKE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base)
      [ "$#" -ge 2 ] || usage
      BASE=$2
      shift 2
      ;;
    --base=*)
      BASE=${1#--base=}
      shift
      ;;
    --smoke)
      SMOKE=1
      shift
      ;;
    -h | --help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done
[ -n "$BASE" ] || usage

# The base must be digest-pinned. Tags are refused: a moving base silently
# changes what the sealed image contains.
repo_part=${BASE%%@*}
digest_part=${BASE##*@sha256:}
case "$BASE" in
  *@sha256:*) ;;
  *)
    die "--base must be digest-pinned (repo@sha256:<64 hex>); refusing '$BASE'"
    ;;
esac
case "$repo_part" in
  "" | *:*)
    die "--base repo must be a plain repository path without a tag; refusing '$BASE'"
    ;;
esac
printf '%s' "$digest_part" | grep -Eq '^[0-9a-f]{64}$' ||
  die "--base digest must be exactly 64 lowercase hex characters; refusing '$BASE'"

# ---------------------------------------------------------------------------
# Docker must already be usable; this script never starts a daemon.
# ---------------------------------------------------------------------------

command -v docker >/dev/null 2>&1 || die "docker CLI not found"
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 ||
  die "the Docker daemon is not answering; start it outside this script"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

echo "==> building $IMAGE_TAG from $BASE"
docker build \
  --build-arg "RUNNER_BASE_IMAGE=$BASE" \
  -f "$script_dir/Dockerfile" \
  -t "$IMAGE_TAG" \
  "$script_dir"

# ---------------------------------------------------------------------------
# Resolve the digest the server will pin
# ---------------------------------------------------------------------------

# A locally built image has never been pushed, so it has NO RepoDigests —
# `docker inspect {{index .RepoDigests 0}}` would fail here. The image ID
# digest is the local content-addressed identity, and the sandbox runs every
# container with `--pull never` (dockerRunArgv in
# apps/server/src/trading/forge/CapabilitySandbox.ts), so the server resolves
# this name@digest form against the local image store without contacting any
# registry. The optional --smoke digest run below exercises exactly that.
image_id=$(docker inspect --type image --format '{{.Id}}' "$IMAGE_TAG")
case "$image_id" in
  sha256:*) ;;
  *)
    die "could not read the built image digest (got '$image_id')"
    ;;
esac
digest_hex=${image_id#sha256:}
printf '%s' "$digest_hex" | grep -Eq '^[0-9a-f]{64}$' ||
  die "built image digest is not 64 lowercase hex (got '$image_id')"
image_ref="$IMAGE_NAME@sha256:$digest_hex"

echo
echo "==> built $IMAGE_TAG"
echo "==> image ref (satisfies the server's digest-pin pattern):"
echo "$image_ref"
echo
echo "Export for the server process:"
echo "export T3_FORGE_SANDBOX_IMAGE=$image_ref"
echo "export T3_FORGE_SANDBOX_RUNNER=docker"

# ---------------------------------------------------------------------------
# Optional smoke: prove each entrypoint and the local digest resolution
# ---------------------------------------------------------------------------

if [ "$SMOKE" -eq 1 ]; then
  smoke_dir=$(mktemp -d "${TMPDIR:-/tmp}/forge-runner-smoke.XXXXXX")
  trap 'rm -rf "$smoke_dir"' EXIT INT TERM

  # Fixtures consistent with runner.cjs: tsc --strict over sdk.ts, signal.ts
  # (+ signal.test.ts except for evaluate); forge-test requires at least one
  # registered test and prints {"testsPassed":N}; forge-evaluate reads JSON
  # from stdin and echoes the readSignal output.
  cat >"$smoke_dir/sdk.ts" <<'EOF'
export type SourceEvidence = {
  readonly mode: "live" | "historical";
  readonly provider: "the-graph";
  readonly deploymentId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly fetchedAtMs: number;
  readonly windowEndMs: number;
  readonly querySha256: string;
  readonly responseSha256: string;
  readonly complete: boolean;
};
export type SignalInput = {
  readonly evidence: SourceEvidence;
  readonly pools: ReadonlyArray<unknown>;
};
export type SignalReading =
  | { readonly kind: "ready"; readonly regime: "coordinated" | "isolated" | "quiet"; readonly agreement: number; readonly eligiblePoolIds: ReadonlyArray<string> }
  | { readonly kind: "insufficient"; readonly reason: string };
export type SignalOutput = { readonly reading: SignalReading; readonly diagnostics: ReadonlyArray<unknown> };
export type ReadSignal = (input: SignalInput) => SignalOutput;
const registeredTests: Array<() => void | Promise<void>> = [];
export function test(_name: string, body: () => void | Promise<void>): void {
  registeredTests.push(body);
}
export async function runRegisteredTests(): Promise<number> {
  for (const body of registeredTests) await body();
  return registeredTests.length;
}
EOF
  cat >"$smoke_dir/signal.ts" <<'EOF'
import type { ReadSignal, SignalInput, SignalOutput } from "./sdk";
export const readSignal: ReadSignal = (input: SignalInput): SignalOutput => ({
  reading: { kind: "insufficient", reason: "smoke" },
  diagnostics: [],
});
EOF
  cat >"$smoke_dir/signal.test.ts" <<'EOF'
import { test } from "./sdk";
import { readSignal } from "./signal";
test("smoke readSignal exists", () => {
  if (readSignal === undefined) throw new Error("readSignal missing");
});
EOF
  cat >"$smoke_dir/evaluate-input.json" <<'EOF'
{"evidence":{"mode":"live","provider":"the-graph","deploymentId":"smoke","blockNumber":"1","blockHash":"0x00","fetchedAtMs":1,"windowEndMs":1,"querySha256":"q","responseSha256":"r","complete":true},"pools":[]}
EOF
  chmod -R a+rX "$smoke_dir"

  # The sandbox argv, mirrored: no network, read-only root, dropped
  # capabilities, non-root user, writable noexec /tmp for tsc output, the
  # workdir mounted read-only.
  run_args="--rm --network none --read-only --cap-drop ALL
    --security-opt no-new-privileges --user 65534:65534 --memory 512m --cpus 1
    --pids-limit 64 --tmpfs /tmp:rw,noexec,nosuid,size=64m
    --mount type=bind,source=$smoke_dir,target=/work,readonly
    --workdir /work --env HOME=/tmp"

  echo
  echo "==> smoke: forge-typecheck"
  # shellcheck disable=SC2086
  docker run $run_args "$IMAGE_TAG" forge-typecheck < /dev/null ||
    die "smoke failed: forge-typecheck exited nonzero"

  echo "==> smoke: forge-test"
  out=$(docker run $run_args "$IMAGE_TAG" forge-test < /dev/null) ||
    die "smoke failed: forge-test exited nonzero"
  case "$out" in
    *'"testsPassed":'*) ;;
    *) die "smoke failed: forge-test printed no testsPassed JSON (got '$out')" ;;
  esac
  echo "    forge-test: $out"

  echo "==> smoke: forge-evaluate"
  out=$(docker run $run_args "$IMAGE_TAG" forge-evaluate < "$smoke_dir/evaluate-input.json") ||
    die "smoke failed: forge-evaluate exited nonzero"
  case "$out" in
    '{'*) echo "    forge-evaluate: $out" ;;
    *) die "smoke failed: forge-evaluate printed no JSON (got '$out')" ;;
  esac

  echo "==> smoke: local digest resolution with --pull never (the server's exact ref form)"
  # shellcheck disable=SC2086
  docker run --rm --pull never $run_args "$image_ref" forge-typecheck < /dev/null ||
    die "smoke failed: the server's image ref '$image_ref' did not resolve locally with --pull never"

  echo
  echo "==> smoke passed"
fi
