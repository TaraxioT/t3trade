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
  smoke_v2_dir=$(mktemp -d "${TMPDIR:-/tmp}/forge-runner-smoke-v2.XXXXXX")
  trap 'rm -rf "$smoke_dir" "$smoke_v2_dir"' EXIT INT TERM

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

  # -- v2 detector-program fixtures: sdk.ts + detector.ts + detector.test.ts.
  # forge-evaluate-v2 compiles the same set minus the test file, reads a
  # DetectorProgramInput JSON from stdin, and must echo {result, nextState}.
  cat >"$smoke_v2_dir/sdk.ts" <<'EOF'
export type CapturedFact = {
  readonly id: string;
  readonly key: string;
  readonly entityId: string;
  readonly value: { readonly kind: "boolean"; readonly value: boolean };
  readonly evidence: ReadonlyArray<{ readonly id: string }>;
};
export type SealedSourceRecord = { readonly sourceId: string; readonly complete: boolean };
export type DetectorProgramInput = {
  readonly programSchemaVersion: 2;
  readonly asOfMs: number;
  readonly inputDigest: string;
  readonly facts: ReadonlyArray<CapturedFact>;
  readonly sources: ReadonlyArray<SealedSourceRecord>;
  readonly priorState?: unknown;
};
export type DetectionResult =
  | { readonly status: "matched"; readonly occurrenceKey: string; readonly evidenceIds: ReadonlyArray<string>; readonly facts: ReadonlyArray<CapturedFact>; readonly validUntilMs: number }
  | { readonly status: "not-matched"; readonly evidenceIds: ReadonlyArray<string>; readonly explanation: string }
  | { readonly status: "unknown"; readonly missingSourceIds: ReadonlyArray<string>; readonly explanation: string };
export type DetectorProgramOutput = { readonly result: DetectionResult; readonly nextState: unknown };
export type Detect = (input: DetectorProgramInput) => DetectorProgramOutput;
const registeredTests: Array<() => void | Promise<void>> = [];
export function test(_name: string, body: () => void | Promise<void>): void {
  registeredTests.push(body);
}
export async function runRegisteredTests(): Promise<number> {
  for (const body of registeredTests) await body();
  return registeredTests.length;
}
EOF
  cat >"$smoke_v2_dir/detector.ts" <<'EOF'
import type { Detect, DetectorProgramInput, DetectorProgramOutput } from "./sdk";
export const detect: Detect = (input: DetectorProgramInput): DetectorProgramOutput => ({
  result: { status: "not-matched", evidenceIds: [], explanation: "smoke" },
  nextState: { runs: 1 },
});
EOF
  cat >"$smoke_v2_dir/detector.test.ts" <<'EOF'
import { test } from "./sdk";
import { detect } from "./detector";
test("smoke detect exists", () => {
  if (detect === undefined) throw new Error("detect missing");
});
EOF
  cat >"$smoke_v2_dir/evaluate-v2-input.json" <<'EOF'
{"programSchemaVersion":2,"asOfMs":1,"inputDigest":"b","facts":[],"sources":[{"sourceId":"src_graph_1","complete":true}]}
EOF
  chmod -R a+rX "$smoke_v2_dir"

  run_args_v2="--rm --network none --read-only --cap-drop ALL
    --security-opt no-new-privileges --user 65534:65534 --memory 512m --cpus 1
    --pids-limit 64 --tmpfs /tmp:rw,noexec,nosuid,size=64m
    --mount type=bind,source=$smoke_v2_dir,target=/work,readonly
    --workdir /work --env HOME=/tmp"

  echo
  echo "==> smoke: forge-evaluate-v2"
  # shellcheck disable=SC2086
  docker run $run_args_v2 "$IMAGE_TAG" forge-typecheck < /dev/null ||
    die "smoke failed: v2 forge-typecheck exited nonzero"
  out=$(docker run $run_args_v2 "$IMAGE_TAG" forge-test < /dev/null) ||
    die "smoke failed: v2 forge-test exited nonzero"
  case "$out" in
    *'"testsPassed":'*) ;;
    *) die "smoke failed: v2 forge-test printed no testsPassed JSON (got '$out')" ;;
  esac
  out=$(docker run $run_args_v2 "$IMAGE_TAG" forge-evaluate-v2 < "$smoke_v2_dir/evaluate-v2-input.json") ||
    die "smoke failed: forge-evaluate-v2 exited nonzero"
  case "$out" in
    '{'*) echo "    forge-evaluate-v2: $out" ;;
    *) die "smoke failed: forge-evaluate-v2 printed no JSON (got '$out')" ;;
  esac

  # -- execution-policy fixtures: sdk.ts + policy.ts (the policy entry). The
  # generated tests for policy.ts are optional by the artifact closure, so the
  # smoke bundle carries none: evaluate-policy compiles without them.
  smoke_policy_dir=$(mktemp -d "${TMPDIR:-/tmp}/forge-runner-smoke-policy.XXXXXX")
  trap 'rm -rf "$smoke_dir" "$smoke_v2_dir" "$smoke_policy_dir"' EXIT INT TERM
  cat >"$smoke_policy_dir/sdk.ts" <<'EOF'
export type DetectorResultForPolicy =
  | { readonly status: "matched"; readonly occurrenceKey: string; readonly validUntilMs: number }
  | { readonly status: "not-matched"; readonly explanation: string }
  | { readonly status: "unknown"; readonly explanation: string };
export type PersistedProposalSummary = {
  readonly stageKey: string;
  readonly kind: "wait" | "price" | "swap" | "stop-future-actions" | "complete";
  readonly amountInRaw?: string;
  readonly occurredAtMs: number;
};
export type PolicyInput = {
  readonly policySchemaVersion: 2;
  readonly asOfMs: number;
  readonly envelope: unknown;
  readonly detectorEvaluation: {
    readonly evaluationId: string;
    readonly asOfMs: number;
    readonly result: DetectorResultForPolicy;
  };
  readonly priorProposals: ReadonlyArray<PersistedProposalSummary>;
  readonly remainingInputCapRaw: string;
  readonly priorState?: unknown;
};
export type PolicyOutput = { readonly proposal: unknown; readonly nextState: unknown };
export type Propose = (input: PolicyInput) => PolicyOutput;
EOF
  cat >"$smoke_policy_dir/policy.ts" <<'EOF'
import type { PolicyInput, PolicyOutput, Propose } from "./sdk";
export const propose: Propose = (input: PolicyInput): PolicyOutput => ({
  proposal: { kind: "wait" },
  nextState: { runs: 1 },
});
EOF
  cat >"$smoke_policy_dir/evaluate-policy-input.json" <<'EOF'
{"policySchemaVersion":2,"asOfMs":1,"envelope":{},"detectorEvaluation":{"evaluationId":"dtev_1","asOfMs":1,"result":{"status":"matched","occurrenceKey":"occ","validUntilMs":2}},"priorProposals":[],"remainingInputCapRaw":"1"}
EOF
  chmod -R a+rX "$smoke_policy_dir"

  run_args_policy="--rm --network none --read-only --cap-drop ALL
    --security-opt no-new-privileges --user 65534:65534 --memory 512m --cpus 1
    --pids-limit 64 --tmpfs /tmp:rw,noexec,nosuid,size=64m
    --mount type=bind,source=$smoke_policy_dir,target=/work,readonly
    --workdir /work --env HOME=/tmp"

  echo
  echo "==> smoke: forge-evaluate-policy"
  # shellcheck disable=SC2086
  docker run $run_args_policy "$IMAGE_TAG" forge-typecheck < /dev/null ||
    die "smoke failed: policy forge-typecheck exited nonzero"
  out=$(docker run $run_args_policy "$IMAGE_TAG" forge-evaluate-policy < "$smoke_policy_dir/evaluate-policy-input.json") ||
    die "smoke failed: forge-evaluate-policy exited nonzero"
  case "$out" in
    '{'*) echo "    forge-evaluate-policy: $out" ;;
    *) die "smoke failed: forge-evaluate-policy printed no JSON (got '$out')" ;;
  esac

  echo
  echo "==> smoke passed"
fi
