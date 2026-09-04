# verify-publishable

`verify-publishable` is a fail-loud release gate for Bun repositories. It builds the repository, packs the exact npm artifacts, checks their metadata and types, publishes the whole local dependency closure to an isolated Verdaccio registry, and installs every public package into a fresh consumer under Node 24.

## Install and run

Pin the repository commit in the consuming repository:

```json
{
  "devDependencies": {
    "verify-publishable": "github:beorn/verify-publishable#<full-commit-sha>"
  }
}
```

Then run the gate after the repository's frozen install:

```sh
bun install --frozen-lockfile
bunx --bun --no-install verify-publishable
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
    ]
  }
}
```

- `build`: explicit root build command. Without it, the root `build` script is used; otherwise every public package must provide its own `build` script, and private-package build scripts are also run when present.
- `maxUnpackedBytes`: maximum public-package size reported by `npm pack --dry-run --json`; default 25 MiB.
- `public`: exact asserted public-package names. Missing, extra, private, or non-public-access entries fail by name.
- `checks`: at most one fresh-consumer check per asserted-public package. `files` are copied from the repository into the consumer, and `runner` must resolve from that consumer's `node_modules/.bin`; path escapes and missing files or runners fail.

The normal phase order is build, size inspection, pnpm pack, strict Publint, ATTW's Node 16 compatibility profile (with only `cjs-resolves-to-esm` ignored), isolated publication, fresh npm install, development and production imports, declared-bin `--help`, and the optional consumer check. The same tarball bytes are checked, published, and hashed.

## Options and environment

```text
verify-publishable [--no-build] [--keep]
```

- `--no-build` skips the build only when the caller already built the same checkout.
- `--keep` preserves the registry and temporary artifacts for inspection and leaves the verifier attached; stop it with Ctrl-C when finished.
- `VERDACCIO_PORT` chooses an explicit loopback port; an invalid or occupied port fails.
- `VERDACCIO_DEBUG=1` mirrors bounded Verdaccio diagnostics to stderr.

## Output and failures

Stdout contains exactly one JSON object using schema `verify-publishable/v1`. Human diagnostics, including child stdout and stderr, go to stderr. Success reports the validated Node/npm versions, build mode, exact public packages, unpacked sizes, tarball SHA-256 hashes, import specifiers, bins, and consumer-check status.

Expected resources never degrade into a skip or empty success. A missing manifest, build, executable, tarball, registry, installed package, export, declaration, bin, or configured check exits nonzero and identifies the phase, command, working directory, status, and captured output where applicable.
