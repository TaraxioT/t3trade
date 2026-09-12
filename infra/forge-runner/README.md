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

## No model-authored Dockerfile is ever built

The only Dockerfile in play is the host-reviewed one in this directory, fed a
host-reviewed base digest. Capability bundles are four flat artifacts and
never include a Dockerfile, image reference, or build instruction.
