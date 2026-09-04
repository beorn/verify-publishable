/**
 * @failure A package gate accepts a missing, oversized, or unchecked tarball,
 * or invokes ambient tools instead of the verifier's pinned dependencies.
 * @level l0
 * @consumer publishable artifact verification
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

import { afterEach, describe, expect, test } from "vitest"

import {
  inspectNpmPack,
  packPackage,
  runTarballChecks,
  type ArtifactPackage,
  type CommandRunner,
} from "../src/artifacts.ts"
import { CommandFailure, type CommandResult, type CommandSpec } from "../src/process.ts"
import { TOOL_SPECS, findSelfPackageRoot, resolveOwnedBin, type ResolvedTool } from "../src/tools.ts"

const roots: string[] = []

function temporaryDirectory(prefix = "verify-publishable-artifacts-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function fixturePackage(root: string, manifest: Record<string, unknown> = {}): ArtifactPackage {
  const value = { name: "@fixture/package", version: "1.2.3", ...manifest }
  writeFileSync(join(root, "package.json"), `${JSON.stringify(value, null, 2)}\n`)
  return { dir: root, name: String(value.name), version: String(value.version) }
}

function commandResult(stdout = "", stderr = ""): CommandResult {
  return { durationMs: 1, status: 0, signal: null, stdout, stderr }
}

function resolvedTool(packageName: string, binName: string, binPath: string): ResolvedTool {
  return { packageName, version: "fixture", manifestPath: `${binPath}.package.json`, binPath }
}

function writeManifestTarball(path: string, manifest: Record<string, unknown>): void {
  const source = Buffer.from(JSON.stringify(manifest))
  const header = Buffer.alloc(512)
  header.write("package/package.json", 0, "utf8")
  header.write(`${source.byteLength.toString(8).padStart(11, "0")}\0`, 124, "ascii")
  header[156] = "0".charCodeAt(0)
  const padding = Buffer.alloc(Math.ceil(source.byteLength / 512) * 512 - source.byteLength)
  writeFileSync(path, gzipSync(Buffer.concat([header, source, padding, Buffer.alloc(1024)])))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("npm pack size inspection", () => {
  test("propagates a non-zero npm pack result through runCommand", async () => {
    const root = temporaryDirectory()
    const pkg = fixturePackage(root)
    const npmCliPath = join(root, "npm-cli.cjs")
    writeFileSync(npmCliPath, 'process.stderr.write("fixture pack failure"); process.exit(23)\n')

    await expect(
      inspectNpmPack(pkg, {
        maxUnpackedBytes: 100,
        nodePath: process.execPath,
        npmCliPath,
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CommandFailure>>({
        name: "CommandFailure",
        phase: "npm-pack-dry-run:@fixture/package",
        command: [process.execPath, npmCliPath, "pack", "--dry-run", "--json", "--ignore-scripts"],
        cwd: root,
        status: 23,
        stderr: "fixture pack failure",
      }),
    )
  })

  test.each([
    ["empty stdout", "", /empty stdout/i],
    ["malformed JSON", "not-json", /malformed JSON.*not-json/is],
    ["empty result", "[]", /exactly one result.*actual=0/i],
    ["missing size", '[{"filename":"fixture.tgz"}]', /invalid unpackedSize.*actual=undefined/i],
    ["string size", '[{"unpackedSize":"12"}]', /invalid unpackedSize.*actual="12"/i],
    ["non-finite size", '[{"unpackedSize":1e999}]', /invalid unpackedSize.*actual=null/i],
  ])("refuses %s instead of silently accepting an unchecked package", async (_label, stdout, message) => {
    const root = temporaryDirectory()
    const pkg = fixturePackage(root)
    const run: CommandRunner = async () => commandResult(stdout)

    await expect(
      inspectNpmPack(pkg, {
        maxUnpackedBytes: 100,
        nodePath: process.execPath,
        npmCliPath: join(root, "npm-cli.js"),
        run,
      }),
    ).rejects.toThrow(message)
  })

  test("fails when npm reports an artifact over the configured unpacked-size cap", async () => {
    const root = temporaryDirectory()
    const pkg = fixturePackage(root)
    const run: CommandRunner = async () => commandResult('[{"filename":"fixture.tgz","unpackedSize":101}]')

    await expect(
      inspectNpmPack(pkg, {
        maxUnpackedBytes: 100,
        nodePath: process.execPath,
        npmCliPath: join(root, "npm-cli.js"),
        run,
      }),
    ).rejects.toThrow(/@fixture\/package.*unpackedSize=101.*maxUnpackedBytes=100/is)
  })

  test("returns a structured record and suppresses lifecycle output that would corrupt npm JSON", async () => {
    const root = temporaryDirectory()
    const pkg = fixturePackage(root)
    const npmCliPath = join(root, "npm-cli.js")
    const commands: CommandSpec[] = []
    const run: CommandRunner = async (spec) => {
      commands.push(spec)
      return commandResult('[{"filename":"fixture-package-1.2.3.tgz","unpackedSize":99}]')
    }

    await expect(
      inspectNpmPack(pkg, {
        maxUnpackedBytes: 100,
        nodePath: process.execPath,
        npmCliPath,
        run,
      }),
    ).resolves.toEqual({
      filename: "fixture-package-1.2.3.tgz",
      maxUnpackedBytes: 100,
      name: "@fixture/package",
      unpackedSize: 99,
      version: "1.2.3",
    })
    expect(commands).toEqual([
      {
        args: [npmCliPath, "pack", "--dry-run", "--json", "--ignore-scripts"],
        command: process.execPath,
        cwd: root,
        phase: "npm-pack-dry-run:@fixture/package",
      },
    ])
  })
})

describe("exact tarball gates", () => {
  test("runs real pnpm pack for a private input and returns its exact packed identity", async () => {
    const root = temporaryDirectory()
    const destination = temporaryDirectory("verify-publishable-tarballs-")
    const pkg = fixturePackage(root, { files: ["index.js"], private: true })
    writeFileSync(join(root, "index.js"), "export const answer = 42\n")
    const selfRoot = findSelfPackageRoot(fileURLToPath(import.meta.url))
    const pnpm = resolveOwnedBin(selfRoot, TOOL_SPECS.pnpm)
    const nodePath = Bun.which("node")
    if (nodePath === null) throw new Error("required host Node executable was not found during the pnpm pack test")

    const record = await packPackage(pkg, { destination, nodePath, pnpm })

    expect(record).toEqual({
      name: "@fixture/package",
      tarballPath: join(destination, "fixture-package-1.2.3.tgz"),
      version: "1.2.3",
    })
    expect(existsSync(record.tarballPath)).toBe(true)
  })

  test("refuses pnpm success output whose reported tarball does not exist", async () => {
    const root = temporaryDirectory()
    const destination = temporaryDirectory("verify-publishable-tarballs-")
    const pkg = fixturePackage(root)
    const missing = join(destination, "missing.tgz")
    const run: CommandRunner = async () =>
      commandResult(JSON.stringify({ filename: missing, name: pkg.name, version: pkg.version }))

    await expect(
      packPackage(pkg, {
        destination,
        nodePath: process.execPath,
        pnpm: resolvedTool("pnpm", "pnpm", join(root, "pnpm.cjs")),
        run,
      }),
    ).rejects.toThrow(/reported tarball is missing.*missing\.tgz/is)
  })

  test("refuses a packed manifest identity that differs from the discovered package", async () => {
    const root = temporaryDirectory()
    const destination = temporaryDirectory("verify-publishable-tarballs-")
    const pkg = fixturePackage(root)
    const tarballPath = join(destination, "wrong-9.9.9.tgz")
    const run: CommandRunner = async () => {
      writeFileSync(tarballPath, "fixture")
      return commandResult(JSON.stringify({ filename: tarballPath, name: "@fixture/wrong", version: "9.9.9" }))
    }

    await expect(
      packPackage(pkg, {
        destination,
        nodePath: process.execPath,
        pnpm: resolvedTool("pnpm", "pnpm", join(root, "pnpm.cjs")),
        run,
      }),
    ).rejects.toThrow(/packed manifest identity mismatch.*@fixture\/wrong.*9\.9\.9.*@fixture\/package.*1\.2\.3/is)
  })

  test("reads identity from the exact tarball instead of trusting truthful-looking pnpm JSON", async () => {
    const root = temporaryDirectory()
    const destination = temporaryDirectory("verify-publishable-tarballs-")
    const pkg = fixturePackage(root)
    const tarballPath = join(destination, "fixture-package-1.2.3.tgz")
    const run: CommandRunner = async () => {
      writeManifestTarball(tarballPath, { name: "@fixture/impostor", version: "9.9.9" })
      return commandResult(JSON.stringify({ filename: tarballPath, name: pkg.name, version: pkg.version }))
    }

    await expect(
      packPackage(pkg, {
        destination,
        nodePath: process.execPath,
        pnpm: resolvedTool("pnpm", "pnpm", join(root, "pnpm.cjs")),
        run,
      }),
    ).rejects.toThrow(/tarball manifest identity mismatch.*@fixture\/impostor.*9\.9\.9.*@fixture\/package.*1\.2\.3/is)
  })

  test("refuses a pack invocation that creates more than one new tgz", async () => {
    const root = temporaryDirectory()
    const destination = temporaryDirectory("verify-publishable-tarballs-")
    const pkg = fixturePackage(root)
    const first = join(destination, "fixture-package-1.2.3.tgz")
    const second = join(destination, "unexpected.tgz")
    const run: CommandRunner = async () => {
      writeFileSync(first, "fixture")
      writeFileSync(second, "fixture")
      return commandResult(JSON.stringify({ filename: first, name: pkg.name, version: pkg.version }))
    }

    await expect(
      packPackage(pkg, {
        destination,
        nodePath: process.execPath,
        pnpm: resolvedTool("pnpm", "pnpm", join(root, "pnpm.cjs")),
        run,
      }),
    ).rejects.toThrow(/expected exactly one new \.tgz.*actual=2.*unexpected\.tgz/is)
  })

  test("runs strict publint and the accepted node16 ATTW policy against one exact tarball", async () => {
    const root = temporaryDirectory()
    const pkg = fixturePackage(root)
    const tarballPath = join(root, "fixture.tgz")
    writeFileSync(tarballPath, "fixture")
    const publint = resolvedTool("publint", "publint", join(root, "publint.js"))
    const attw = resolvedTool("@arethetypeswrong/cli", "attw", join(root, "attw.js"))
    const commands: CommandSpec[] = []
    const run: CommandRunner = async (spec) => {
      commands.push(spec)
      return commandResult()
    }

    await runTarballChecks(pkg, { attw, nodePath: process.execPath, publint, run, tarballPath })

    expect(commands).toEqual([
      {
        args: [publint.binPath, tarballPath, "--strict"],
        command: process.execPath,
        cwd: root,
        phase: "publint:@fixture/package",
      },
      {
        args: [
          attw.binPath,
          tarballPath,
          "--profile",
          "node16",
          "--ignore-rules",
          "cjs-resolves-to-esm",
          "--format",
          "table",
          "--no-color",
        ],
        command: process.execPath,
        cwd: root,
        phase: "attw:@fixture/package",
      },
    ])
  })

  test("refuses PATH-resolved runtimes before invoking a tool", async () => {
    const root = temporaryDirectory()
    const pkg = fixturePackage(root)
    const tarballPath = join(root, "fixture.tgz")
    writeFileSync(tarballPath, "fixture")
    let invoked = false
    const run: CommandRunner = async () => {
      invoked = true
      return commandResult()
    }

    await expect(
      runTarballChecks(pkg, {
        attw: resolvedTool("@arethetypeswrong/cli", "attw", join(root, "attw.js")),
        nodePath: "node",
        publint: resolvedTool("publint", "publint", join(root, "publint.js")),
        run,
        tarballPath,
      }),
    ).rejects.toThrow(/nodePath must be absolute.*actual="node"/i)
    expect(invoked).toBe(false)
  })
})
