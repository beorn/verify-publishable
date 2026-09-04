import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, test } from "vitest"

import { TOOL_SPECS, findSelfPackageRoot, resolveOwnedBin } from "../src/tools.ts"

const roots: string[] = []

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "verify-publishable-tools-"))
  roots.push(root)
  return root
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("owned dependency tools", () => {
  /**
   * @failure A missing dependency binary falls through to a root .bin or poisoned PATH,
   * changing which verifier actually ran.
   * @level l0
   * @consumer pnpm, publint, ATTW, and Verdaccio phases
   */
  test("resolves every runtime tool from this package and asserts its exact version", () => {
    const selfRoot = findSelfPackageRoot(fileURLToPath(import.meta.url))

    for (const spec of Object.values(TOOL_SPECS)) {
      const resolved = resolveOwnedBin(selfRoot, spec)
      expect(resolved.packageName).toBe(spec.packageName)
      expect(resolved.version).toBe(spec.expectedVersion)
      expect(existsSync(resolved.binPath)).toBe(true)
      expect(resolved.binPath).not.toContain("node_modules/.bin")
    }
  })

  test("supports a dependency beside the package in an isolated node_modules store", () => {
    const root = temporaryDirectory()
    const selfRoot = join(root, "node_modules/.store/verify-publishable/node_modules/verify-publishable")
    const dependencyRoot = join(dirname(selfRoot), "fixture-tool")
    writeJson(join(selfRoot, "package.json"), {
      name: "verify-publishable",
      dependencies: { "fixture-tool": "1.2.3" },
    })
    writeJson(join(dependencyRoot, "package.json"), {
      name: "fixture-tool",
      version: "1.2.3",
      bin: { fixture: "bin/fixture.js" },
    })
    mkdirSync(join(dependencyRoot, "bin"), { recursive: true })
    writeFileSync(join(dependencyRoot, "bin/fixture.js"), "")

    const resolved = resolveOwnedBin(selfRoot, {
      packageName: "fixture-tool",
      expectedVersion: "1.2.3",
      binName: "fixture",
    })

    expect(resolved.binPath).toBe(join(dependencyRoot, "bin/fixture.js"))
  })

  /**
   * @failure An owned bin path remains a symlink, so its eventual target can differ
   * from the dependency-contained file that preflight appeared to approve.
   * @level l0
   * @consumer owned tool command execution
   */
  test("returns the canonical target of a dependency-contained bin symlink", () => {
    const root = temporaryDirectory()
    const selfRoot = join(root, "verify-publishable")
    const dependencyRoot = join(selfRoot, "node_modules/fixture-tool")
    const target = join(dependencyRoot, "bin/fixture.js")
    const link = join(dependencyRoot, "bin/fixture")
    writeJson(join(selfRoot, "package.json"), {
      name: "verify-publishable",
      dependencies: { "fixture-tool": "1.0.0" },
    })
    writeJson(join(dependencyRoot, "package.json"), {
      name: "fixture-tool",
      version: "1.0.0",
      bin: { fixture: "bin/fixture" },
    })
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, "")
    symlinkSync("fixture.js", link)

    const resolved = resolveOwnedBin(selfRoot, {
      packageName: "fixture-tool",
      expectedVersion: "1.0.0",
      binName: "fixture",
    })

    expect(resolved.binPath).toBe(realpathSync(target))
  })

  /**
   * @failure A consumer lock resolves a different verifier version and the gate runs
   * with unreviewed semantics.
   * @level l0
   * @consumer dependency integrity preflight
   */
  test("refuses a resolved tool whose version differs from the declared pin", () => {
    const selfRoot = findSelfPackageRoot(fileURLToPath(import.meta.url))

    expect(() => resolveOwnedBin(selfRoot, { ...TOOL_SPECS.pnpm, expectedVersion: "0.0.0-wrong" })).toThrow(
      /pnpm version mismatch.*expected=0\.0\.0-wrong.*actual=9\.15\.9/i,
    )
  })

  test("refuses a dependency bin that escapes its package directory", () => {
    const root = temporaryDirectory()
    const selfRoot = join(root, "verify-publishable")
    writeJson(join(selfRoot, "package.json"), {
      name: "verify-publishable",
      dependencies: { "fixture-tool": "1.0.0" },
    })
    writeJson(join(selfRoot, "node_modules/fixture-tool/package.json"), {
      name: "fixture-tool",
      version: "1.0.0",
      bin: "../escaped.js",
    })
    writeFileSync(join(selfRoot, "node_modules/escaped.js"), "")

    expect(() =>
      resolveOwnedBin(selfRoot, { packageName: "fixture-tool", expectedVersion: "1.0.0", binName: "fixture" }),
    ).toThrow(/bin path escapes package.*fixture-tool/i)
  })

  /**
   * @failure A dependency-contained bin symlink points outside its package, allowing
   * an unrelated executable to pass ownership checks.
   * @level l0
   * @consumer dependency integrity preflight
   */
  test("refuses a dependency bin symlink whose target escapes its package directory", () => {
    const root = temporaryDirectory()
    const selfRoot = join(root, "verify-publishable")
    const dependencyRoot = join(selfRoot, "node_modules/fixture-tool")
    const externalBin = join(root, "escaped.js")
    const linkedBin = join(dependencyRoot, "bin/fixture.js")
    writeJson(join(selfRoot, "package.json"), {
      name: "verify-publishable",
      dependencies: { "fixture-tool": "1.0.0" },
    })
    writeJson(join(dependencyRoot, "package.json"), {
      name: "fixture-tool",
      version: "1.0.0",
      bin: "bin/fixture.js",
    })
    writeFileSync(externalBin, "")
    mkdirSync(dirname(linkedBin), { recursive: true })
    symlinkSync(externalBin, linkedBin)

    expect(() =>
      resolveOwnedBin(selfRoot, { packageName: "fixture-tool", expectedVersion: "1.0.0", binName: "fixture" }),
    ).toThrow(/bin path escapes package.*fixture-tool/i)
  })
})
