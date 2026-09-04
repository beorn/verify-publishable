import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { discoverRepository } from "../src/discovery.ts"
import { withSandboxManifests } from "../src/sandbox.ts"

const roots: string[] = []

function writeManifest(root: string, manifest: Record<string, unknown>): string {
  mkdirSync(root, { recursive: true })
  const path = join(root, "package.json")
  writeFileSync(path, `${JSON.stringify(manifest, null, 4)}\n`)
  return path
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "verify-publishable-sandbox-"))
  roots.push(root)
  const rootPath = writeManifest(root, {
    name: "fixture-root",
    version: "1.0.0",
    private: true,
    workspaces: ["packages/*"],
  })
  const internalPath = writeManifest(join(root, "packages/internal"), {
    name: "@fixture/internal",
    version: "1.0.0",
    private: true,
    publishConfig: { executable: "dist" },
  })
  const publicPath = writeManifest(join(root, "packages/public"), {
    name: "@fixture/public",
    version: "1.0.0",
    publishConfig: { access: "public" },
  })
  return {
    plan: await discoverRepository(root),
    paths: { rootPath, internalPath, publicPath },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("sandbox manifest mutation", () => {
  /**
   * @failure Private workspace dependencies cannot be published to the isolated registry,
   * or the verifier leaves their real manifests modified after the run.
   * @level l0
   * @consumer local-registry dependency closure
   */
  test("temporarily makes private packages publishable and restores exact bytes", async () => {
    const { plan, paths } = await fixture()
    const originals = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, "utf8")]))

    await withSandboxManifests(plan.packages, async () => {
      for (const path of [paths.rootPath, paths.internalPath]) {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
        expect(manifest.private).toBeUndefined()
        expect(manifest.publishConfig).toMatchObject({ access: "public" })
      }
      expect(readFileSync(paths.publicPath, "utf8")).toBe(originals.publicPath)
    })

    for (const [key, path] of Object.entries(paths)) expect(readFileSync(path, "utf8")).toBe(originals[key])
  })

  /**
   * @failure A pack/publish failure strands a private manifest in a public state and the
   * cleanup error disappears behind the primary failure.
   * @level l0
   * @consumer failure cleanup
   */
  test("restores exact bytes when the sandbox task fails", async () => {
    const { plan, paths } = await fixture()
    const originals = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, "utf8")]))

    await expect(
      withSandboxManifests(plan.packages, async () => {
        throw new Error("PACK_SENTINEL")
      }),
    ).rejects.toThrow("PACK_SENTINEL")

    for (const [key, path] of Object.entries(paths)) expect(readFileSync(path, "utf8")).toBe(originals[key])
  })
})
