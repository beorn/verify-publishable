/**
 * @failure Individually passing pack and probe units conceal a broken real workflow,
 * including workspace dependency rewriting, local publication, fresh install, or Node imports.
 * @level l3
 * @consumer repositories using verifyRepository or the verify-publishable CLI
 */

import { createHash } from "node:crypto"
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { resolveHostTools, findHostExecutable } from "../src/preflight.ts"
import { CommandFailure } from "../src/process.ts"
import { probeFreshConsumer, ProbeFailure } from "../src/probes.ts"
import { verifyRepository } from "../src/verify.ts"

const FIXTURE = join(import.meta.dirname, "fixtures/e2e")
const PUBLIC_NAME = "@verify-publishable-fixture/e2e-public"
const roots: string[] = []

function copyFixture(): string {
  const parent = mkdtempSync(join(tmpdir(), "verify-publishable-e2e-"))
  roots.push(parent)
  const root = join(parent, "repository")
  cpSync(FIXTURE, root, { recursive: true })
  return root
}

function installFixture(root: string): void {
  const command = [process.execPath, "install", "--ignore-scripts"]
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (!result.success) {
    throw new Error(
      `fixture install failed: command=${JSON.stringify(command)} cwd=${JSON.stringify(root)} status=${result.exitCode} stdout=${JSON.stringify(result.stdout.toString())} stderr=${JSON.stringify(result.stderr.toString())}`,
    )
  }
}

function installedFixture(): string {
  const root = copyFixture()
  installFixture(root)
  return root
}

function emptyOutputDirectory(): string {
  const outputDir = mkdtempSync(join(tmpdir(), "verify-publishable-output-"))
  roots.push(outputDir)
  return outputDir
}

function updatePublicManifest(root: string, update: (manifest: Record<string, unknown>) => void): void {
  const path = join(root, "packages/public/package.json")
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  update(manifest)
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function captureFailure(task: Promise<unknown>): Promise<unknown> {
  try {
    await task
  } catch (error) {
    return error
  }
  throw new Error("expected repository verification to fail")
}

function commandDiagnostic(failure: CommandFailure | ProbeFailure): string {
  return `${failure.stdout}\n${failure.stderr}`
}

async function stopKeptRegistry(pid: number): Promise<void> {
  const running = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  if (!running()) return
  process.kill(pid, "SIGTERM")
  const deadline = Date.now() + 5_000
  while (running() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (!running()) return
  process.kill(pid, "SIGKILL")
  const killDeadline = Date.now() + 5_000
  while (running() && Date.now() < killDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (running()) throw new Error(`kept fixture registry survived SIGKILL: pid=${pid}`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("real repository verification", () => {
  test("builds, packs, checks, publishes, installs, imports, and runs the public bin", async () => {
    const root = installedFixture()

    updatePublicManifest(root, (manifest) => {
      manifest.engines = { node: ">=24 <25" }
    })

    const internalManifestPath = join(root, "packages/internal/package.json")
    const internalManifestBefore = readFileSync(internalManifestPath, "utf8")
    expect(existsSync(join(root, "packages/public/dist/index.js"))).toBe(false)

    const result = await verifyRepository({ root })

    const selectedNode = findHostExecutable("node")
    if (selectedNode === null) throw new Error("HOST_TOOL_MISSING: tool=node searched=PATH purpose=receipt-test")
    expect(result.nodePath).toBe(realpathSync(selectedNode))
    expect(result.nodePath).not.toBe(realpathSync(process.execPath))
    const actualVersion = Bun.spawnSync([selectedNode, "--version"], { stdout: "pipe", stderr: "pipe" })
    expect(actualVersion.success).toBe(true)
    expect(result.nodeVersion).toBe(actualVersion.stdout.toString().trim())
    expect(result.nodeVersion).toMatch(/^v24\./)
    expect(result.npmVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(result.buildMode).toBe("root-script")
    expect(result.packages).toEqual([
      {
        name: "@verify-publishable-fixture/e2e-public",
        version: "1.0.0",
        unpackedSize: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        specifiers: ["@verify-publishable-fixture/e2e-public"],
        bins: ["verify-publishable-e2e"],
        binRuntimes: [
          { bin: "verify-publishable-e2e", runtime: "node", action: "run", reason: "engines declares node only" },
        ],
        consumerCheckRan: false,
        runtimes: [{ runtime: "node", version: result.nodeVersion, reason: "engines declares node only" }],
      },
    ])
    expect(result.packages[0]!.unpackedSize).toBeGreaterThan(0)
    expect(readFileSync(join(root, "packages/public/dist/index.js"), "utf8")).toContain(
      "@verify-publishable-fixture/e2e-internal",
    )
    expect(readFileSync(internalManifestPath, "utf8")).toBe(internalManifestBefore)
  }, 120_000)

  test("retains only fully verified tarballs in the caller's directory with npm SHA-512", async () => {
    const root = installedFixture()
    const outputDir = emptyOutputDirectory()

    const result = await verifyRepository({ root, outputDir })

    expect(result.kept).toBeUndefined()
    const verified = result.packages[0]!
    expect(verified.tarballPath).toMatch(new RegExp(`^${outputDir}/`, "u"))
    expect(readdirSync(outputDir)).toHaveLength(1)
    const bytes = readFileSync(verified.tarballPath!)
    expect(verified.sha512).toBe(`sha512-${createHash("sha512").update(bytes).digest("base64")}`)
    expect(verified.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
  }, 120_000)

  test("a nonempty output directory refuses before building", async () => {
    const root = installedFixture()
    const outputDir = emptyOutputDirectory()
    writeFileSync(join(outputDir, "marker"), "caller data")

    const failure = await captureFailure(verifyRepository({ root, outputDir }))

    expect((failure as Error).message).toContain("ARTIFACT_OUTPUT_NOT_EMPTY")
    expect(readFileSync(join(outputDir, "marker"), "utf8")).toBe("caller data")
    expect(existsSync(join(root, "packages/public/dist/index.js"))).toBe(false)
  }, 120_000)

  /**
   * @failure Inherited npm force admits a package whose installed engines exclude the actual Node,
   * so the fresh consumer claims compatibility npm never checked.
   * @level l3
   * @consumer npm engine enforcement in the real repository release gate
   */
  test("rejects incompatible installed engines even with inherited npm force", async () => {
    const root = installedFixture()
    updatePublicManifest(root, (manifest) => {
      manifest.engines = { node: ">=25" }
    })
    const prior = process.env.npm_config_force
    process.env.npm_config_force = "true"
    let failure: unknown
    try {
      failure = await captureFailure(verifyRepository({ root }))
    } finally {
      if (prior === undefined) delete process.env.npm_config_force
      else process.env.npm_config_force = prior
    }
    expect(failure).toBeInstanceOf(ProbeFailure)
    expect(failure).toMatchObject({ phase: "consumer-install", packageName: PUBLIC_NAME, status: 1 })
    expect(commandDiagnostic(failure as ProbeFailure)).toMatch(/EBADENGINE/)
    expect(commandDiagnostic(failure as ProbeFailure)).toContain(">=25")
    expect(existsSync((failure as ProbeFailure).cwd)).toBe(false)
  }, 120_000)

  /** Real npm must relax its Node gate only for a Bun-only public promise, including transitive dependencies. */
  test.each([false, true])(
    "Bun-only dependency exclusion keeps the dual Node promise strict (dual=%s)",
    async (dual) => {
      const root = installedFixture()
      updatePublicManifest(root, (manifest) => {
        manifest.engines = dual ? { node: ">=24", bun: ">=1.0.0" } : { bun: ">=1.0.0" }
      })
      const path = join(root, "packages/internal/package.json")
      const internal = JSON.parse(readFileSync(path, "utf8"))
      internal.engines = { node: ">=25", bun: ">=1.0.0" }
      writeFileSync(path, JSON.stringify(internal))
      const priorForce = process.env.npm_config_force
      const priorStrict = process.env.npm_config_engine_strict
      process.env.npm_config_force = "true"
      // pnpm packing has its own engine gate; the real consumer inherits strict=true below.
      process.env.npm_config_engine_strict = "false"
      try {
        if (dual) {
          const failure = await captureFailure(verifyRepository({ root }))
          expect(failure).toBeInstanceOf(ProbeFailure)
          expect(failure).toMatchObject({ phase: "consumer-install", status: 1 })
          expect(commandDiagnostic(failure as ProbeFailure)).toMatch(/EBADENGINE/)
          expect(commandDiagnostic(failure as ProbeFailure)).toContain(">=25")
          expect(existsSync((failure as ProbeFailure).cwd)).toBe(false)
        } else {
          const result = await verifyRepository({ root, keep: true })
          const kept = result.kept!
          try {
            process.env.npm_config_engine_strict = "true"
            const host = await resolveHostTools(root)
            const tarball = readdirSync(kept.artifactRoot, { recursive: true }).find((path) =>
              String(path).endsWith("e2e-public-1.0.0.tgz"),
            )
            if (tarball === undefined) throw new Error("public fixture packed tarball missing")
            const extracted = Bun.spawnSync([
              "tar",
              "-xOf",
              join(kept.artifactRoot, String(tarball)),
              "package/package.json",
            ])
            if (!extracted.success) throw new Error(`fixture manifest extraction failed: ${extracted.stderr}`)
            const manifest = JSON.parse(extracted.stdout.toString())
            const probe = await probeFreshConsumer({
              package: { name: PUBLIC_NAME, version: "1.0.0" },
              packedManifest: manifest,
              registryUrl: kept.registryUrl!,
              npmrcPath: kept.npmrcPath!,
              nodePath: host.nodePath,
              npmPath: host.npmPath,
              bunPath: host.bunPath!,
              sourceRoot: root,
            })
            expect(probe.runtimes.map(({ runtime }) => runtime)).toEqual(["bun"])
          } finally {
            if (kept.registryPid !== null) await stopKeptRegistry(kept.registryPid)
            rmSync(kept.artifactRoot, { recursive: true, force: true })
            if (kept.registryStateRoot !== null) rmSync(kept.registryStateRoot, { recursive: true, force: true })
          }
        }
      } finally {
        if (priorForce === undefined) delete process.env.npm_config_force
        else process.env.npm_config_force = priorForce
        if (priorStrict === undefined) delete process.env.npm_config_engine_strict
        else process.env.npm_config_engine_strict = priorStrict
      }
    },
    120_000,
  )

  test("--keep reports and preserves inspectable artifacts plus the live registry", async () => {
    const root = installedFixture()
    const result = await verifyRepository({ root, keep: true })
    const kept = result.kept
    expect(kept).toBeDefined()
    if (
      kept === undefined ||
      kept.registryPid === null ||
      kept.registryUrl === null ||
      kept.registryStateRoot === null ||
      kept.npmrcPath === null
    ) {
      throw new Error(`--keep returned incomplete resource evidence: ${JSON.stringify(kept)}`)
    }

    try {
      expect(existsSync(kept.artifactRoot)).toBe(true)
      expect(existsSync(kept.registryStateRoot)).toBe(true)
      expect(existsSync(kept.npmrcPath)).toBe(true)
      await expect(fetch(`${kept.registryUrl}/-/ping`).then((response) => response.ok)).resolves.toBe(true)
    } finally {
      await stopKeptRegistry(kept.registryPid)
      rmSync(kept.artifactRoot, { recursive: true, force: true })
      rmSync(kept.registryStateRoot, { recursive: true, force: true })
    }
  }, 120_000)

  test("packed shape rejects an export target absent from the packed artifact", async () => {
    const root = installedFixture()
    const outputDir = emptyOutputDirectory()
    updatePublicManifest(root, (manifest) => {
      manifest.exports = {
        ".": { types: "./dist/index.d.ts", import: "./dist/not-built.js" },
      }
    })

    const failure = await captureFailure(verifyRepository({ root, outputDir }))

    expect((failure as Error).message).toContain("PACK_SHAPE_INVALID")
    expect((failure as Error).message).toContain("exports")
    expect((failure as Error).message).toContain("./dist/not-built.js")
    expect(readdirSync(outputDir)).toEqual([])
  }, 120_000)

  test("packed shape rejects shipped TypeScript source under an unused browser condition", async () => {
    const root = installedFixture()
    const outputDir = emptyOutputDirectory()
    writeFileSync(join(root, "packages/public/src/unused.ts"), "export const bad = 1\n")
    updatePublicManifest(root, (manifest) => {
      manifest.files = ["dist", "src"]
      manifest.exports = {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js", browser: "./src/unused.ts" },
      }
    })

    const failure = await captureFailure(verifyRepository({ root, outputDir }))

    expect((failure as Error).message).toContain("PACK_SHAPE_INVALID")
    expect((failure as Error).message).toContain("typescript-source")
    expect((failure as Error).message).toContain("./src/unused.ts")
    expect(readdirSync(outputDir)).toEqual([])
  }, 120_000)

  test("discovery rejects an asserted-public package that remains private", async () => {
    const root = installedFixture()
    updatePublicManifest(root, (manifest) => {
      manifest.private = true
    })

    const failure = await captureFailure(verifyRepository({ root }))

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(
      /public assertion mismatch.*private=\["@verify-publishable-fixture\/e2e-public"\]/i,
    )
  }, 120_000)

  test("packed shape rejects a declaration target absent from the packed artifact", async () => {
    const root = installedFixture()
    updatePublicManifest(root, (manifest) => {
      manifest.types = "./dist/not-built.d.ts"
      manifest.exports = {
        ".": { types: "./dist/not-built.d.ts", import: "./dist/index.js" },
      }
    })

    const failure = await captureFailure(verifyRepository({ root }))

    expect((failure as Error).message).toContain("PACK_SHAPE_INVALID")
    expect((failure as Error).message).toContain("./dist/not-built.d.ts")
  }, 120_000)

  test("fresh install reports ETARGET for an unpublished local sibling version", async () => {
    const root = installedFixture()
    updatePublicManifest(root, (manifest) => {
      manifest.dependencies = {
        "@verify-publishable-fixture/e2e-internal": "2.0.0",
      }
    })

    const failure = await captureFailure(verifyRepository({ root }))

    expect(failure).toBeInstanceOf(ProbeFailure)
    expect(failure).toMatchObject({
      phase: "consumer-install",
      packageName: PUBLIC_NAME,
      packageVersion: "1.0.0",
      status: 1,
    })
    expect(commandDiagnostic(failure as ProbeFailure)).toMatch(
      /ETARGET|No matching version found.*e2e-internal@2\.0\.0/is,
    )
  }, 120_000)

  test("fresh consumer rejects a declared bin whose help command exits nonzero", async () => {
    const root = installedFixture()
    writeFileSync(
      join(root, "packages/public/src/cli.js"),
      '#!/usr/bin/env node\n\nconsole.error("BIN_HELP_SENTINEL")\nprocess.exitCode = 23\n',
    )

    const failure = await captureFailure(verifyRepository({ root }))

    expect(failure).toBeInstanceOf(ProbeFailure)
    expect(failure).toMatchObject({
      phase: "bin-help",
      packageName: PUBLIC_NAME,
      packageVersion: "1.0.0",
      status: 23,
    })
    expect(commandDiagnostic(failure as ProbeFailure)).toContain("BIN_HELP_SENTINEL")
  }, 120_000)

  test("real Publint rejects an invalid repository URL", async () => {
    const root = installedFixture()
    updatePublicManifest(root, (manifest) => {
      manifest.repository = { type: "git", url: "not-a-git-url" }
    })

    const failure = await captureFailure(verifyRepository({ root }))

    expect(failure).toBeInstanceOf(CommandFailure)
    expect(failure).toMatchObject({ phase: `publint:${PUBLIC_NAME}`, status: 1 })
    expect(commandDiagnostic(failure as CommandFailure)).toMatch(/repository\.url.*isn't a valid git URL/is)
  }, 120_000)

  test("real ATTW rejects CommonJS named exports that Node cannot detect", async () => {
    const root = installedFixture()
    updatePublicManifest(root, (manifest) => {
      manifest.type = "commonjs"
      manifest.types = "./dist/index.d.cts"
      manifest.exports = {
        ".": { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
      }
    })
    appendFileSync(
      join(root, "build.mjs"),
      `\nawait writeFile(join(publicRoot, "dist/index.cjs"), 'const name = "publicValue"\\nmodule.exports[name] = "dynamic"\\n')\nawait writeFile(join(publicRoot, "dist/index.d.cts"), 'export declare const publicValue: "dynamic"\\n')\n`,
    )

    const failure = await captureFailure(verifyRepository({ root }))

    expect(failure).toBeInstanceOf(CommandFailure)
    expect(failure).toMatchObject({ phase: `attw:${PUBLIC_NAME}`, status: 1 })
    expect(commandDiagnostic(failure as CommandFailure)).toMatch(/Named exports cannot be detected|Named exports/is)
  }, 120_000)
})
