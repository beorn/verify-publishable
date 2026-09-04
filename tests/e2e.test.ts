/**
 * @failure Individually passing pack and probe units conceal a broken real workflow,
 * including workspace dependency rewriting, local publication, fresh install, or Node imports.
 * @level l3
 * @consumer repositories using verifyRepository or the verify-publishable CLI
 */

import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { CommandFailure } from "../src/process.ts"
import { ProbeFailure } from "../src/probes.ts"
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

    const internalManifestPath = join(root, "packages/internal/package.json")
    const internalManifestBefore = readFileSync(internalManifestPath, "utf8")
    expect(existsSync(join(root, "packages/public/dist/index.js"))).toBe(false)

    const result = await verifyRepository({ root })

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
        consumerCheckRan: false,
      },
    ])
    expect(result.packages[0]!.unpackedSize).toBeGreaterThan(0)
    expect(readFileSync(join(root, "packages/public/dist/index.js"), "utf8")).toContain(
      "@verify-publishable-fixture/e2e-internal",
    )
    expect(readFileSync(internalManifestPath, "utf8")).toBe(internalManifestBefore)
  }, 120_000)

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

  test("Publint rejects an export target absent from the packed artifact", async () => {
    const root = installedFixture()
    updatePublicManifest(root, (manifest) => {
      manifest.exports = {
        ".": { types: "./dist/index.d.ts", import: "./dist/not-built.js" },
      }
    })

    const failure = await captureFailure(verifyRepository({ root }))

    expect(failure).toBeInstanceOf(CommandFailure)
    expect(failure).toMatchObject({ phase: `publint:${PUBLIC_NAME}`, status: 1 })
    expect(commandDiagnostic(failure as CommandFailure)).toMatch(/dist\/not-built\.js|not published|does not exist/i)
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

  test("Publint rejects a declaration target absent from the packed artifact", async () => {
    const root = installedFixture()
    updatePublicManifest(root, (manifest) => {
      manifest.types = "./dist/not-built.d.ts"
      manifest.exports = {
        ".": { types: "./dist/not-built.d.ts", import: "./dist/index.js" },
      }
    })

    const failure = await captureFailure(verifyRepository({ root }))

    expect(failure).toBeInstanceOf(CommandFailure)
    expect(failure).toMatchObject({ phase: `publint:${PUBLIC_NAME}`, status: 1 })
    expect(commandDiagnostic(failure as CommandFailure)).toMatch(/dist\/not-built\.d\.ts|not published|does not exist/i)
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
