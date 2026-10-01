import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "vitest"

const ROOT = join(import.meta.dirname, "..")

describe("Git dependency package shape", () => {
  /**
   * @failure A SHA-pinned Git dependency installs without a runnable local bin,
   * so bunx can silently fall through to an unrelated npm package.
   * @level l0
   * @consumer every verify-publishable caller
   */
  test("ships an executable Bun bin backed by checked-in source", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>
      dependencies?: Record<string, string>
      engines?: Record<string, string>
      files?: string[]
      os?: string[]
      scripts?: Record<string, string>
    }
    expect(manifest.bin).toEqual({ "verify-publishable": "bin/verify-publishable" })
    expect(manifest.scripts?.prepare).toBeUndefined()
    expect(manifest.scripts?.postinstall).toBeUndefined()
    // Bun is the only runtime the package promises; Node 24 is a host tool the probes spawn, checked by preflight.
    expect(manifest.engines).toEqual({ bun: ">=1.3.14" })
    expect(manifest.os).toEqual(["darwin", "linux"])
    expect(manifest.dependencies).toEqual({
      "@arethetypeswrong/cli": "0.18.5",
      pnpm: "9.15.9",
      publint: "0.3.24",
      verdaccio: "6.10.2",
    })
    expect(manifest.files).toEqual(["bin", "src", "dist", "LICENSE", "README.md"])
    // dist is built by prepack; every other listed path is checked in.
    for (const path of manifest.files ?? []) if (path !== "dist") expect(existsSync(join(ROOT, path))).toBe(true)

    const binPath = join(ROOT, manifest.bin!["verify-publishable"]!)
    accessSync(binPath, constants.X_OK)
    expect(readFileSync(binPath, "utf8")).toMatch(
      /^#!\/usr\/bin\/env bun\n\nimport \{ runCli \} from "\.\.\/src\/cli\.ts"/,
    )
  })

  /**
   * @failure The checker is published to npm or listed as a registry package again, so a caller pins a version range
   * instead of a commit and two workspaces install two copies (hh 26691, @cto d603245d: an action, not a package).
   * @level l0
   * @consumer every caller of the action, and km-infra's vendor-kit (./runtime through its commit pin)
   */
  test("refuses an npm publish: the manifest is private with no publishConfig", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>
    expect(manifest.private).toBe(true)
    expect(manifest.publishConfig).toBeUndefined()
    expect(manifest.exports).toEqual({ "./runtime": "./src/runtime.ts" })
    expect(existsSync(join(ROOT, ".github", "workflows", "release.yml"))).toBe(false)
  })

  /**
   * @failure The action sets up or changes the caller's toolchain, installs into the caller's workspace, or returns no
   * report path, so a release job verifies with tools it did not choose or cannot re-hash what was verified.
   * @level l0
   * @consumer release.yml and verify.yml rendered by km-infra's vendor-kit
   */
  test("is a composite action that installs only in its own path and returns the report path", () => {
    const action = readFileSync(join(ROOT, "action.yml"), "utf8")
    expect(action).toMatch(/^runs:\n {2}using: composite$/m)
    // No nested action: setup-node, setup-bun or any other toolchain step belongs to the caller.
    expect(action).not.toMatch(/^\s*(-\s+)?uses:/m)
    expect(action).toContain(
      "working-directory: ${{ github.action_path }}\n      run: bun install --frozen-lockfile --production",
    )
    expect(action).toContain('"$ACTION_PATH/bin/verify-publishable"')
    expect(action).toMatch(/^ {2}report:\n {4}description: .+\n {4}value: \$\{\{ steps\.verify\.outputs\.report \}\}$/m)
    for (const tool of ["bun", "node", "npm"]) expect(action).toContain(tool)
  })
})
