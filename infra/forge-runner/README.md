# Forge runner image

The sealed container every Forge capability runs in (typecheck, generated
tests, acceptance, evaluation). The server only executes an image pinned by
sha256 digest — `T3_FORGE_SANDBOX_IMAGE` must match
`<name>@sha256:<64 hex>` — and selects the Docker runner with
`T3_FORGE_SANDBOX_RUNNER=docker`. Nothing builds this image automatically;
building it is a host setup step, done once per reviewed base.

## Build

```sh
infra/forge-runner/build.sh --base <repo@sha256:<64 hex>> [--smoke]
```

- `--base` is required and must be digest-pinned. Tag refs are refused: a
  moving base silently changes what the sealed image contains. Pick a Node
  image digest you have independently verified.
- The script never starts the Docker daemon; it refuses if the daemon is not
  already answering.
- On success it prints the exact exports for the server process:

```sh
export T3_FORGE_SANDBOX_IMAGE=t3-forge-runner@sha256:<digest>
export T3_FORGE_SANDBOX_RUNNER=docker
```

## Why the digest is the local image ID

The image is built locally and never pushed, so it has no `RepoDigests`. The
script resolves `docker inspect --format '{{.Id}}'` (the local content
address) and prints `t3-forge-runner@sha256:<id>`. That satisfies the
server's digest-pin pattern, and it works because every sandbox run uses
`--pull never` (see `dockerRunArgv` in
`apps/server/src/trading/forge/CapabilitySandbox.ts`): the server asks Docker
to resolve the name@digest against the local image store and never contacts a
registry. `--smoke` proves this end to end by running a container with the
exact printed ref under `--pull never`.

## What `--smoke` proves

Against a temp workdir holding minimal, valid `sdk.ts` / `signal.ts` /
`signal.test.ts` fixtures (the same shapes `runner.cjs` consumes), each
entrypoint runs under the same hardening flags the server uses (no network,
read-only root, dropped capabilities, non-root uid, noexec tmpfs `/tmp`,
read-only workdir mount):

- `forge-typecheck` exits 0 under `tsc --strict`;
- `forge-test` runs at least one registered test and prints
  `{"testsPassed":N}` JSON;
- `forge-evaluate` reads the input JSON from stdin and echoes the
  `readSignal` output as JSON;
- the printed `name@sha256:<digest>` ref resolves locally under
  `--pull never`.

## Detector-program (v2) modes

`forge-evaluate-v2` is a fourth shim installed beside the v1 three: it reads a
sealed detector-program input JSON (`DetectorProgramInputV2`) from stdin,
requires the compiled `detector.ts`, and calls its exported `detect` — which
must be synchronous; an async return or a missing export is a named error, the
same guard style as the v1 `readSignal` check. `forge-typecheck` and
`forge-test` are shared between bundle generations: the compile set is
discovered from the mounted `/work` directory (every `*.ts`, with `*.test.ts`
excluded in the evaluate modes), and the test entry follows whichever of
`detector.test.ts` / `signal.test.ts` the bundle authored. Because the image
contents changed, the already-built image behind `T3_FORGE_SANDBOX_IMAGE` does
NOT pick these modes up: rebuild with `build.sh` against the same reviewed base
digest and re-pin the printed `t3-forge-runner@sha256:<digest>` before any
v2 capability runs — the server refuses v2 entrypoints against an old image
with a plain `nonzero_exit`/`invalid_request` failure, never a fallback.

## Execution-policy mode

`forge-evaluate-policy` is a fifth shim: it reads a sealed policy-program input
JSON (`PolicyProgramInputV2` — envelope, detector evaluation, prior proposals,
remaining budget, prior state) from stdin, requires the compiled `policy.ts`,
and calls its exported `propose` — which must be synchronous; an async return
or a missing export is a named error (`propose must be synchronous` /
`propose export missing`), the same guard style as `detect`. The stdout is the
`{ proposal, nextState }` JSON under the shared output cap. Generated tests for
`policy.ts` are optional by the artifact closure, so the smoke bundle carries
none and the evaluate compile simply excludes `*.test.ts` as everywhere else.
Same rebuild rule as above: the mode exists only in an image rebuilt after
this shim was added.

## No model-authored Dockerfile is ever built

The only Dockerfile in play is the host-reviewed one in this directory, fed a
host-reviewed base digest. Capability bundles are four flat artifacts and
never include a Dockerfile, image reference, or build instruction.
