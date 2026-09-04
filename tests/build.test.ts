import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { executeBuild, planBuild } from "../src/build.ts"
import { discoverRepository } from "../src/discovery.ts"
import { CommandFailure } from "../src/process.ts"

const roots: string[] = []

function fixture(manifest: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "verify-publishable-build-"))
  roots.push(root)
  writeManifest(root, manifest)
  return root
}

function writeManifest(root: string, manifest: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("build selection", () => {
  /**
   * @failure A repository-specific build is tokenized or replaced by a guessed ladder,
   * so the verifier builds artifacts differently from release.
   * @level l0
   * @consumer verifyPublishable.build
   */
  test("runs the configured command once at the repository root through Bun Shell", async () => {
    const root = fixture({
      name: "fixture",
      version: "1.0.0",
      verifyPublishable: { build: "printf configured > build-marker && printf '%s' '-done' >> build-marker" },
    })
    const plan = await discoverRepository(root)

    const result = await executeBuild(plan)

    expect(result.mode).toBe("configured")
    expect(readFileSync(join(root, "build-marker"), "utf8")).toBe("configured-done")
  })

  /**
   * @failure Build failure is ignored while pack/install probes continue against stale
   * output, recreating the three-of-four false green.
   * @level l0
   * @consumer build gate
   */
  test("makes a configured build failure losslessly fatal", async () => {
    const root = fixture({
      name: "fixture",
      version: "1.0.0",
      verifyPublishable: { build: "printf BUILD_SENTINEL; exit 23" },
    })
    const plan = await discoverRepository(root)

    await expect(executeBuild(plan)).rejects.toThrowError(
      expect.objectContaining<Partial<CommandFailure>>({
        phase: "build",
        cwd: root,
        status: 23,
        stdout: "BUILD_SENTINEL",
      }),
    )
  })

  test("uses one root build script before considering package scripts", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      private: true,
      scripts: { build: "fixture-build" },
      workspaces: ["packages/*"],
    })
    writeManifest(join(root, "packages/a"), {
      name: "@fixture/a",
      version: "1.0.0",
      scripts: { build: "package-build" },
    })

    const build = planBuild(await discoverRepository(root), { noBuild: false })

    expect(build).toMatchObject({ mode: "root-script", steps: [{ cwd: root, script: "build" }] })
  })

  test("refuses package fallback when any public package has no build script", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
    })
    writeManifest(join(root, "packages/a"), {
      name: "@fixture/a",
      version: "1.0.0",
      scripts: { build: "fixture-build" },
    })
    writeManifest(join(root, "packages/b"), { name: "@fixture/b", version: "1.0.0" })

    const plan = await discoverRepository(root)
    expect(() => planBuild(plan, { noBuild: false })).toThrow(/public packages have no build script.*@fixture\/b/i)
  })

  test("reports an explicit no-build skip without selecting a command", async () => {
    const root = fixture({ name: "fixture", version: "1.0.0" })

    expect(planBuild(await discoverRepository(root), { noBuild: true })).toEqual({ mode: "skipped", steps: [] })
  })
})
