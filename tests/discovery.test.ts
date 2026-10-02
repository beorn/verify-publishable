import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { discoverRepository } from "../src/discovery.ts"

const roots: string[] = []

function fixture(manifest: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "verify-publishable-discovery-"))
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

describe("repository discovery", () => {
  test("defaults each selected build step to ten minutes and validates an override", async () => {
    const root = fixture({ name: "fixture", version: "1.0.0" })
    expect((await discoverRepository(root)).config.buildTimeoutMs).toBe(600_000)
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "100", null]) {
      writeManifest(root, { name: "fixture", version: "1.0.0", verifyPublishable: { buildTimeoutMs: value } })
      await expect(discoverRepository(root)).rejects.toThrow(
        /verifyPublishable.buildTimeoutMs must be a positive safe integer/,
      )
    }
    writeManifest(root, { name: "fixture", version: "1.0.0", verifyPublishable: { buildTimeoutMs: 1234 } })
    expect((await discoverRepository(root)).config.buildTimeoutMs).toBe(1234)
  })
  /**
   * @failure A hard-coded roster omits newly added public packages or the private
   * workspace packages that their local-registry install depends on.
   * @level l0
   * @consumer repository verification plan
   */
  test("discovers public and private packages from workspace globs deterministically", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*", "!packages/excluded"],
      verifyPublishable: { public: ["@fixture/a"] },
    })
    writeManifest(join(root, "packages/z-internal"), {
      name: "@fixture/z-internal",
      version: "1.0.0",
      private: true,
    })
    writeManifest(join(root, "packages/a"), {
      name: "@fixture/a",
      version: "1.0.0",
      publishConfig: { access: "public" },
    })
    writeManifest(join(root, "packages/excluded"), { name: "@fixture/excluded", version: "1.0.0" })

    const plan = await discoverRepository(root)

    expect(plan.packages.map(({ name }) => name)).toEqual(["fixture-root", "@fixture/a", "@fixture/z-internal"])
    expect(plan.publicPackages.map(({ name }) => name)).toEqual(["@fixture/a"])
    expect(plan.packages.find(({ name }) => name === "@fixture/z-internal")?.isPublic).toBe(false)
    expect(plan.searched).toEqual([".", "packages/*"])
    expect(plan.excluded).toEqual(["packages/excluded"])
  })

  /**
   * @failure A repository using the object workspace form is rejected even though
   * it expresses the same package population as the array form.
   * @level l0
   * @consumer repository discovery
   */
  test("accepts the { packages: [...] } workspace form", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      private: true,
      workspaces: { packages: ["packages/*"] },
      verifyPublishable: { public: ["@fixture/a"] },
    })
    writeManifest(join(root, "packages/a"), {
      name: "@fixture/a",
      version: "1.0.0",
      publishConfig: { access: "public" },
    })

    const plan = await discoverRepository(root)

    expect(plan.packages.map(({ name }) => name)).toEqual(["fixture-root", "@fixture/a"])
    expect(plan.searched).toEqual([".", "packages/*"])
  })

  /**
   * @failure An asserted release roster drifts from discovery and the gate silently
   * verifies fewer packages than the repository intends to publish.
   * @level l0
   * @consumer verifyPublishable.public configuration
   */
  test("refuses a public assertion that differs from discovered public packages", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
      verifyPublishable: { public: ["@fixture/a", "@fixture/missing"] },
    })
    writeManifest(join(root, "packages/a"), {
      name: "@fixture/a",
      version: "1.0.0",
      publishConfig: { access: "public" },
    })

    await expect(discoverRepository(root)).rejects.toThrow(
      /public assertion mismatch.*expected.*@fixture\/missing.*discovered.*@fixture\/a/is,
    )
  })

  test("names an asserted package that is still private before the generic empty-public failure", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
      verifyPublishable: { public: ["@fixture/a"] },
    })
    writeManifest(join(root, "packages/a"), {
      name: "@fixture/a",
      version: "1.0.0",
      private: true,
      publishConfig: { access: "public" },
    })

    await expect(discoverRepository(root)).rejects.toThrow(/public assertion mismatch.*private=\["@fixture\/a"\]/is)
  })

  test("refuses duplicate consumer checks instead of silently running only the first", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      publishConfig: { access: "public" },
      verifyPublishable: {
        public: ["fixture-root"],
        checks: [
          { package: "fixture-root", runner: "vitest", args: ["run"], files: ["one.test.ts"] },
          { package: "fixture-root", runner: "vitest", args: ["run"], files: ["two.test.ts"] },
        ],
      },
    })

    await expect(discoverRepository(root)).rejects.toThrow(
      /checks contains duplicate package entries.*fixture-root.*fixture-root/is,
    )
  })

  /**
   * @failure A misspelled option falls back to a default and produces a believable
   * but irrelevant green result.
   * @level l0
   * @consumer verifyPublishable configuration
   */
  /**
   * @failure A Bun-only bin declaration with no reason, a typo'd key, or a package that is not public here silently
   * waives the Node bin check for nothing (hh #27074, @cto 240b6f1e).
   * @level l0
   * @consumer verifyPublishable.bunOnlyBins
   */
  test("reads bunOnlyBins with a reason per bin, and refuses malformed or foreign declarations", async () => {
    const declaration = { package: "fixture-root", bin: "fixture", reason: "the CLI calls Bun APIs" }
    const accepted = fixture({
      name: "fixture-root",
      version: "1.0.0",
      verifyPublishable: { bunOnlyBins: [declaration] },
    })
    await expect(discoverRepository(accepted)).resolves.toMatchObject({ config: { bunOnlyBins: [declaration] } })

    const noReason = fixture({
      name: "fixture-root",
      version: "1.0.0",
      verifyPublishable: { bunOnlyBins: [{ package: "fixture-root", bin: "fixture", reason: " " }] },
    })
    await expect(discoverRepository(noReason)).rejects.toThrow(/bunOnlyBins\[0\]\.reason must be a non-empty string/)

    const unknownKey = fixture({
      name: "fixture-root",
      version: "1.0.0",
      verifyPublishable: { bunOnlyBins: [{ ...declaration, runtime: "bun" }] },
    })
    await expect(discoverRepository(unknownKey)).rejects.toThrow(/unknown verifyPublishable\.bunOnlyBins key.*runtime/)

    const duplicate = fixture({
      name: "fixture-root",
      version: "1.0.0",
      verifyPublishable: { bunOnlyBins: [declaration, declaration] },
    })
    await expect(discoverRepository(duplicate)).rejects.toThrow(/duplicate package bins.*fixture-root:fixture/)

    const foreign = fixture({
      name: "fixture-root",
      version: "1.0.0",
      verifyPublishable: { bunOnlyBins: [{ ...declaration, package: "other" }] },
    })
    await expect(discoverRepository(foreign)).rejects.toThrow(/names package other, which is not a public package here/)
  })

  test("refuses unknown configuration keys by name", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      verifyPublishable: { maxUnpackedByte: 10 },
    })

    await expect(discoverRepository(root)).rejects.toThrow(/unknown verifyPublishable key.*maxUnpackedByte/i)
  })

  /**
   * @failure Empty discovery is reported as success even though no releasable artifact
   * was examined.
   * @level l0
   * @consumer CLI verdict
   */
  test("refuses an empty public result with searched and excluded scope", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*", "!packages/skipped"],
    })
    writeManifest(join(root, "packages/internal"), {
      name: "@fixture/internal",
      version: "1.0.0",
      private: true,
    })
    writeManifest(join(root, "packages/skipped"), { name: "@fixture/skipped", version: "1.0.0" })

    await expect(discoverRepository(root)).rejects.toThrow(
      /no public packages.*searched.*packages\/\*.*excluded.*packages\/skipped/is,
    )
  })

  test("refuses an unmatched positive workspace glob instead of silently shrinking scope", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      workspaces: ["missing/*"],
    })

    await expect(discoverRepository(root)).rejects.toThrow(/workspace pattern matched no manifests.*missing\/\*/i)
  })

  test("refuses workspace patterns that can escape the repository", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      workspaces: ["../outside/*"],
    })

    await expect(discoverRepository(root)).rejects.toThrow(/workspace pattern must stay inside root.*\.\.\/outside/i)
  })

  test("validates consumer checks against the asserted-public set", async () => {
    const root = fixture({
      name: "fixture",
      version: "1.0.0",
      publishConfig: { access: "public" },
      verifyPublishable: {
        public: ["fixture"],
        checks: [
          {
            package: "fixture",
            runner: "vitest",
            args: ["run", "checks/installed.test.ts"],
            files: ["checks/installed.test.ts"],
          },
        ],
      },
    })

    await expect(discoverRepository(root)).resolves.toMatchObject({
      config: { checks: [{ package: "fixture", runner: "vitest" }] },
    })
  })

  test("refuses unknown consumer-check keys and escaping files", async () => {
    const root = fixture({
      name: "fixture",
      version: "1.0.0",
      publishConfig: { access: "public" },
      verifyPublishable: {
        public: ["fixture"],
        checks: [
          {
            package: "fixture",
            runner: "vitest",
            args: [],
            files: ["../outside.test.ts"],
            fallback: true,
          },
        ],
      },
    })

    await expect(discoverRepository(root)).rejects.toThrow(/unknown verifyPublishable\.checks key.*fallback/i)
  })
})
