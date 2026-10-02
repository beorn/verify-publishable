# verify-publishable

`verify-publishable` is a fail-loud release gate for Bun repositories. It builds the repository, packs the exact npm artifacts, checks their metadata and types, publishes the whole local dependency closure to an isolated Verdaccio registry, and installs every public package into a fresh consumer under Node 24.

## Run it in GitHub Actions

The checker is a GitHub Action, called in one line and pinned by full commit. It is not an npm package: the manifest
is `private: true`, so nothing publishes it.

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: "24"
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: 1.3.14
- run: bun install --frozen-lockfile
- run: mkdir "$RUNNER_TEMP/verified-tarballs"
- id: verify
  uses: beorn/verify-publishable@<40-hex commit>
  with:
    output-dir: ${{ runner.temp }}/verified-tarballs
- run: cat "${{ steps.verify.outputs.report }}"
```

- Pin a full commit, never a tag or branch: the pin is what delivers the checker's code.
- The action installs only its own dependencies, in its own directory. It never sets up or changes the caller's toolchain. It checks that Bun, Node and npm are on `PATH` and that Bun satisfies this manifest's `engines.bun`, and fails by name otherwise.
- Inputs: `output-dir` (an existing directory that receives the verified tarballs; omit it to keep none) and `working-directory` (default `.`). Output: `report`, the path of the JSON report described under [Output and failures](#output-and-failures).

Outside Actions, run the bin from a checkout of this repository after `bun install --frozen-lockfile`, with the repository to verify as the working directory:

```sh
/path/to/verify-publishable/bin/verify-publishable --output-dir <directory>
```

The host must provide Bun, Node 24, and npm. The gate uses only its declared, pinned copies of pnpm, Verdaccio, Publint, and `@arethetypeswrong/cli`. Linux and macOS are supported.

## Repository contract

Packages are discovered from the root `package.json` and its `workspaces` array or `{ "packages": [...] }` form. Negated workspace globs are exclusions. Every discovered package is packed and published to the isolated registry so local dependencies resolve; packages without `private: true` are additionally checked and consumer-probed. An empty public result is an error, with the searched and excluded scopes in the diagnostic.

The optional root configuration is strict—unknown keys and malformed values fail:

```json
{
  "verifyPublishable": {
    "build": "bun run build:all",
    "maxUnpackedBytes": 26214400,
    "public": ["example-package"],
    "checks": [
      {
        "package": "example-package",
        "runner": "vitest",
        "args": ["run", "consumer.test.ts"],
        "files": ["consumer.test.ts"]
      }
    ],
    "bunOnlyBins": [{ "package": "example-package", "bin": "example", "reason": "the CLI calls Bun APIs" }]
  }
}
```

- `build`: explicit root build command. Without it, the root `build` script is used; otherwise every public package must provide its own `build` script, and private-package build scripts are also run when present.
- `maxUnpackedBytes`: maximum public-package size reported by `npm pack --dry-run --json`; default 25 MiB.
- `public`: exact asserted public-package names. Missing, extra, private, or non-public-access entries fail by name.
- `checks`: at most one fresh-consumer check per asserted-public package. `files` are copied from the repository into the consumer, and `runner: "node"` runs the canonical host Node selected during preflight. Every other `runner` must resolve from that consumer's `node_modules/.bin`; path escapes and missing files or runners fail.
- `bunOnlyBins`: bins whose package's engines declare both node and bun, but which run under Bun only (the library imports from Node; the CLI needs Bun). Each entry names a public package, one of its declared bins, and a non-empty `reason`. Bun runs that bin's `--help`, and its Node row reads `not asked: bin declared Bun-only`. Without a declaration, a Bun shebang under `engines.node` fails the `bin-runtime` phase. A declaration whose package declares no `engines.bun`, or no `engines.node`, or no such bin, also fails. The rule is exported as `binRuntimePlan` from `verify-publishable/runtime`, so a local release verify applies the same rule to the same tarball.

The normal phase order is build, size inspection, pnpm pack, packed manifest target checks, strict Publint, ATTW's Node 16 compatibility profile (with only `cjs-resolves-to-esm` ignored), isolated publication, the served-integrity check, fresh npm install with engine enforcement, development and production imports, declared-bin `--help`, and the optional consumer check. The same tarball bytes are checked, published, and hashed. The registry runs in two phases on one storage: `publish` keeps the local packages off the npmjs uplink, so a version that is already released still publishes locally; `probe` restarts with the uplink so consumers resolve prior versions of local packages. Before any probe, every local package's served `dist.integrity` must equal its packed tarball's, or the gate refuses with `LOCAL_ARTIFACT_CONTRADICTED`, naming both hashes.

The exact packed manifest selects the install policy before npm runs. Node-only, dual-runtime and default Node targets use npm `--engine-strict --force=false`, enforcing Node/npm ranges for the target and its nonoptional dependency tree; npm may omit incompatible optional dependencies. A Bun-only target uses `--engine-strict=false --force=false`. Both flags are explicit, so inherited strict/force configuration cannot change this policy. A packed/installed runtime-name disagreement refuses before import, showing both engine declarations and selection reasons.

A Bun-only result proves that npm resolved and laid out a tree without its engine gate, and that the target's entry points import and bins run under a Bun satisfying the target's own `engines.bun`. It does not check any dependency's engines or prove a tree installed by Bun itself: npm checks `engines.node` and `engines.npm` against its host, never `engines.bun`.

## Options and environment

```text
verify-publishable [--no-build] [--keep] [--output-dir <directory>]
```

- `--no-build` skips the build only when the caller already built the same checkout.
- `--keep` preserves the registry and temporary artifacts for inspection and leaves the verifier attached; stop it with Ctrl-C when finished.
- `--output-dir` requires an existing empty directory owned by the caller. After every gate passes and the local registry stops, the verifier copies the exact checked public tarballs there. The caller removes the directory after publishing. `--keep` and `--output-dir` cannot be combined.
- `VERDACCIO_PORT` chooses an explicit loopback port; an invalid or occupied port fails.
- `VERDACCIO_DEBUG=1` mirrors bounded Verdaccio diagnostics to stderr.

## Output and failures

Stdout contains exactly one JSON object using schema `verify-publishable/v1`. Human diagnostics, including child stdout and stderr, go to stderr. Success reports the canonical Node executable path and validated Node/npm versions, build mode, exact public packages, unpacked sizes, tarball SHA-256 hashes, import specifiers, bins, and consumer-check status. With `--output-dir`, each public package also reports its absolute `tarballPath` and npm-form `sha512-<base64>` digest over the retained file. A failed verification leaves no file from that run in the caller's directory.

Expected resources never degrade into a skip or empty success. A missing manifest, build, executable, tarball, registry, installed package, export, declaration, bin, or configured check exits nonzero and identifies the phase, command, working directory, status, and captured output where applicable.
