/**
 * @failure A packed package installs successfully but its real Node consumer surface
 * (conditional exports, declared bins, or an opt-in framework check) is unusable.
 * @level l1
 * @consumer fresh npm installs from the verifier's private registry
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { findHostExecutable } from "../src/preflight.ts"
import { ProbeFailure, probeFreshConsumer } from "../src/probes.ts"

const roots: string[] = []
const configuredNodePath = process.env.NODE_FOR_TESTS
const hostNodePath = configuredNodePath === undefined ? findHostExecutable("node") : realpathSync(configuredNodePath)
if (hostNodePath === null) throw new Error("HOST_TOOL_MISSING: tool=node searched=PATH purpose=test-fixtures")

interface FakeNpmOptions {
  emptyFeature?: boolean
  linkPackageBin?: boolean
  linkVitestBin?: boolean
  nodeVersion?: string
  registerMatcher?: boolean
}

function temporaryDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `verify-publishable-${label}-`))
  roots.push(root)
  return root
}

function executable(path: string, source: string): void {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

function fakeNpm(options: FakeNpmOptions = {}): {
  npmPath: string
  nodePath: string
  nodeLog: string
  commandLog: string
  importLog: string
  binLog: string
  checkLog: string
} {
  const root = temporaryDirectory("fake-npm")
  const nodeDirectory = join(root, "selected-node")
  mkdirSync(nodeDirectory)
  const nodePath = join(nodeDirectory, "node")
  const nodeLog = join(root, "node.ndjson")
  const npmPath = join(root, "npm-cli.mjs")
  const commandLog = join(root, "npm.ndjson")
  const importLog = join(root, "imports.log")
  const binLog = join(root, "bins.log")
  const checkLog = join(root, "check.log")
  const manifest = {
    name: "@fixture/public",
    version: "1.2.3",
    type: "module",
    exports: {
      ".": "./index.mjs",
      "./feature": "./feature.mjs",
      "./matchers": "./matchers.mjs",
      "./generated/*": "./generated/*.mjs",
    },
    bin: { fixture: "./cli.mjs" },
  }
  executable(
    nodePath,
    `#!${hostNodePath}
const { appendFileSync } = require("node:fs")
const { spawnSync } = require("node:child_process")
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(nodeLog)}, JSON.stringify(args) + "\\n")
if (args.length === 1 && args[0] === "--version") {
  console.log(${JSON.stringify(options.nodeVersion ?? "v24.99.0")})
  process.exit(0)
}
const result = spawnSync(${JSON.stringify(hostNodePath)}, args, { env: process.env, stdio: "inherit" })
if (result.error) throw result.error
process.exit(result.status ?? 1)
`,
  )
  const source = `
import { appendFileSync, chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const cwd = process.cwd()
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({
  args,
  cwd,
  npmConfig: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    key.toLowerCase() === "npm_config_registry" || key.toLowerCase() === "npm_config_userconfig"
  )),
  pathFirst: process.env.PATH?.split(${JSON.stringify(process.platform === "win32" ? ";" : ":")})[0],
}) + "\\n")

if (args[0] === "init") {
  writeFileSync(join(cwd, "package.json"), '{"name":"probe-consumer","private":true}\\n')
  process.exit(0)
}
if (args[0] !== "install") process.exit(90)

const packageRoot = join(cwd, "node_modules", "@fixture", "public")
mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true })
mkdirSync(join(packageRoot, "generated"), { recursive: true })
writeFileSync(join(packageRoot, "package.json"), ${JSON.stringify(`${JSON.stringify(manifest)}\n`)})
writeFileSync(join(packageRoot, "index.mjs"), ${JSON.stringify(`import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(importLog)}, process.env.NODE_ENV + ":root\\n")\nexport const root = true\n`)})
writeFileSync(join(packageRoot, "feature.mjs"), ${JSON.stringify(`import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(importLog)}, process.env.NODE_ENV + ":feature\\n")\n${options.emptyFeature === true ? "export {}" : "export const feature = true"}\n`)})
writeFileSync(join(packageRoot, "matchers.mjs"), ${JSON.stringify(`import { appendFileSync } from "node:fs"\nif (process.env.NODE_ENV) appendFileSync(${JSON.stringify(importLog)}, process.env.NODE_ENV + ":matchers\\n")\nif (globalThis.__VITEST_CONTEXT__ === true && ${options.registerMatcher !== false}) globalThis.__FIXTURE_MATCHER__ = true\nexport const terminalMatchers = {}\n`)})
writeFileSync(join(packageRoot, "cli.mjs"), ${JSON.stringify(`#!/usr/bin/env node\nimport { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(binLog)}, process.argv.slice(2).join(" ") + "\\n")\nif (process.argv[2] !== "--help") process.exit(91)\nconsole.log("Usage: fixture")\n`)})
chmodSync(join(packageRoot, "cli.mjs"), 0o755)
if (${options.linkPackageBin !== false}) {
  symlinkSync(join(packageRoot, "cli.mjs"), join(cwd, "node_modules", ".bin", "fixture"))
}
if (${options.linkVitestBin === true}) {
  const vitestRoot = join(cwd, "node_modules", "fake-vitest")
  mkdirSync(vitestRoot, { recursive: true })
  writeFileSync(join(vitestRoot, "vitest.mjs"), ${JSON.stringify(`#!/usr/bin/env node\nimport { appendFileSync, existsSync } from "node:fs"\nimport { join } from "node:path"\nimport { pathToFileURL } from "node:url"\nconst spec = process.argv.at(-1)\nif (!spec || !existsSync(join(process.cwd(), spec))) process.exit(92)\nglobalThis.__VITEST_CONTEXT__ = true\ntry {\n  await import(pathToFileURL(join(process.cwd(), spec)).href)\n} catch (error) {\n  console.error(error?.stack ?? String(error))\n  process.exit(94)\n}\nappendFileSync(${JSON.stringify(checkLog)}, process.argv.slice(2).join(" ") + "\\n")\n`)})
  chmodSync(join(vitestRoot, "vitest.mjs"), 0o755)
  symlinkSync(join(vitestRoot, "vitest.mjs"), join(cwd, "node_modules", ".bin", "vitest"))
}
`
  writeFileSync(npmPath, source)
  return { npmPath, nodePath, nodeLog, commandLog, importLog, binLog, checkLog }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("fresh consumer probes", () => {
  test("installs the exact version and exercises literal exports, bins, and an opt-in check", async () => {
    const fixture = fakeNpm({ linkVitestBin: true })
    const npmrcPath = join(temporaryDirectory("npmrc"), "consumer.npmrc")
    const sourceRoot = temporaryDirectory("source")
    mkdirSync(join(sourceRoot, "checks"))
    writeFileSync(
      join(sourceRoot, "checks/matchers.test.mjs"),
      'import "@fixture/public/matchers"\nif (globalThis.__FIXTURE_MATCHER__ !== true) throw new Error("matcher was not registered in Vitest context")\n',
    )
    writeFileSync(npmrcPath, "registry=http://127.0.0.1:4873/\n")

    const badNodeDirectory = temporaryDirectory("bad-node")
    const badNodeReceipt = join(badNodeDirectory, "ran")
    executable(join(badNodeDirectory, "node"), `#!/bin/sh\nprintf ran > ${JSON.stringify(badNodeReceipt)}\nexit 86\n`)
    const originalPath = process.env.PATH
    const poisonedRegistryKey = "NpM_CoNfIg_ReGiStRy"
    const poisonedUserconfigKey = "npm_CONFIG_userCONFIG"
    process.env.PATH = `${badNodeDirectory}:${originalPath ?? ""}`
    process.env[poisonedRegistryKey] = "http://poisoned.invalid/"
    process.env[poisonedUserconfigKey] = "/poisoned/npmrc"
    let result
    try {
      result = await probeFreshConsumer({
        package: { name: "@fixture/public", version: "1.2.3" },
        registryUrl: "http://127.0.0.1:4873/",
        npmrcPath,
        nodePath: fixture.nodePath,
        npmPath: fixture.npmPath,
        sourceRoot,
        consumerCheck: {
          package: "@fixture/public",
          runner: "vitest",
          args: ["run", "checks/matchers.test.mjs"],
          files: ["checks/matchers.test.mjs"],
        },
      })
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      delete process.env[poisonedRegistryKey]
      delete process.env[poisonedUserconfigKey]
    }

    expect(result).toEqual({
      packageName: "@fixture/public",
      version: "1.2.3",
      specifiers: ["@fixture/public", "@fixture/public/feature", "@fixture/public/matchers"],
      bins: ["fixture"],
      consumerCheckRan: true,
    })
    const npmCalls = readFileSync(fixture.commandLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[]
            npmConfig: Record<string, string>
            pathFirst?: string
          },
      )
    expect(npmCalls).toHaveLength(2)
    expect(npmCalls[0]?.args).toEqual([
      "init",
      "--yes",
      "--quiet",
      "--userconfig",
      npmrcPath,
      "--registry",
      "http://127.0.0.1:4873/",
    ])
    expect(npmCalls[1]?.args).toEqual([
      "install",
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--userconfig",
      npmrcPath,
      "--registry",
      "http://127.0.0.1:4873/",
      "@fixture/public@1.2.3",
    ])
    expect(npmCalls.every(({ npmConfig }) => npmConfig.NPM_CONFIG_REGISTRY === "http://127.0.0.1:4873/")).toBe(true)
    expect(npmCalls.every(({ npmConfig }) => npmConfig.NPM_CONFIG_USERCONFIG === npmrcPath)).toBe(true)
    expect(npmCalls.every(({ npmConfig }) => Object.keys(npmConfig).length === 2)).toBe(true)
    expect(npmCalls.every(({ pathFirst }) => pathFirst === dirname(fixture.nodePath))).toBe(true)
    const selectedNodeCalls = readFileSync(fixture.nodeLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    expect(selectedNodeCalls[0]).toEqual(["--version"])
    expect(selectedNodeCalls.some(([script, command]) => script === fixture.npmPath && command === "init")).toBe(true)
    expect(
      selectedNodeCalls.some(
        ([script, argument]) => script?.endsWith("/node_modules/.bin/fixture") && argument === "--help",
      ),
    ).toBe(true)
    expect(selectedNodeCalls.some(([script]) => script?.endsWith("/node_modules/.bin/vitest"))).toBe(true)
    expect(existsSync(badNodeReceipt)).toBe(false)
    const nodeModeImports = readFileSync(fixture.importLog, "utf8")
      .trim()
      .split("\n")
      .filter((line) => /^(development|production):/.test(line))
      .sort()
    expect(nodeModeImports).toEqual([
      "development:feature",
      "development:matchers",
      "development:root",
      "production:feature",
      "production:matchers",
      "production:root",
    ])
    expect(readFileSync(fixture.binLog, "utf8")).toBe("--help\n")
    expect(readFileSync(fixture.checkLog, "utf8")).toBe("run checks/matchers.test.mjs\n")
  })

  test("fails loud with package and process diagnostics when a declared bin link is missing", async () => {
    const fixture = fakeNpm({ linkPackageBin: false })
    const npmrcPath = join(temporaryDirectory("npmrc"), "consumer.npmrc")
    writeFileSync(npmrcPath, "registry=http://127.0.0.1:4873/\n")

    const failure = await probeFreshConsumer({
      package: { name: "@fixture/public", version: "1.2.3" },
      registryUrl: "http://127.0.0.1:4873/",
      npmrcPath,
      nodePath: fixture.nodePath,
      npmPath: fixture.npmPath,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ProbeFailure)
    expect(failure).toMatchObject({
      name: "ProbeFailure",
      phase: "bin-link",
      packageName: "@fixture/public",
      packageVersion: "1.2.3",
      status: null,
      stdout: "",
    })
    expect((failure as ProbeFailure).command[0]).toMatch(/node_modules\/\.bin\/fixture$/)
    expect((failure as ProbeFailure).command[1]).toBe("--help")
    expect((failure as ProbeFailure).cwd).toMatch(/verify-publishable-consumer-/)
    expect((failure as ProbeFailure).stderr).toMatch(/required installed package bin link is missing.*fixture/is)
    expect(existsSync((failure as ProbeFailure).cwd)).toBe(false)
  })

  test("accepts an importable side-effect-only export with an empty module namespace", async () => {
    const fixture = fakeNpm({ emptyFeature: true })
    const npmrcPath = join(temporaryDirectory("npmrc"), "consumer.npmrc")
    writeFileSync(npmrcPath, "registry=http://127.0.0.1:4873/\n")

    await expect(
      probeFreshConsumer({
        package: { name: "@fixture/public", version: "1.2.3" },
        registryUrl: "http://127.0.0.1:4873/",
        npmrcPath,
        nodePath: fixture.nodePath,
        npmPath: fixture.npmPath,
      }),
    ).resolves.toMatchObject({
      packageName: "@fixture/public",
      version: "1.2.3",
      specifiers: ["@fixture/public", "@fixture/public/feature", "@fixture/public/matchers"],
    })
  })

  test("proves a matcher-registration defect only observable inside the configured runner", async () => {
    const fixture = fakeNpm({ linkVitestBin: true, registerMatcher: false })
    const npmrcPath = join(temporaryDirectory("npmrc"), "consumer.npmrc")
    const sourceRoot = temporaryDirectory("source")
    writeFileSync(
      join(sourceRoot, "matchers.test.mjs"),
      'import "@fixture/public/matchers"\nif (globalThis.__FIXTURE_MATCHER__ !== true) throw new Error("matcher was not registered in Vitest context")\n',
    )
    writeFileSync(npmrcPath, "registry=http://127.0.0.1:4873/\n")

    await expect(
      probeFreshConsumer({
        package: { name: "@fixture/public", version: "1.2.3" },
        registryUrl: "http://127.0.0.1:4873/",
        npmrcPath,
        nodePath: fixture.nodePath,
        npmPath: fixture.npmPath,
        sourceRoot,
        consumerCheck: {
          package: "@fixture/public",
          runner: "vitest",
          args: ["run", "matchers.test.mjs"],
          files: ["matchers.test.mjs"],
        },
      }),
    ).rejects.toMatchObject({
      name: "ProbeFailure",
      phase: "consumer-check",
      packageName: "@fixture/public",
      status: 94,
      stdout: "",
      stderr: expect.stringMatching(/matcher was not registered in Vitest context/i),
    })
  })

  test("refuses a configured check file that escapes its source root", async () => {
    const fixture = fakeNpm({ linkVitestBin: true })
    const npmrcPath = join(temporaryDirectory("npmrc"), "consumer.npmrc")
    const repositoryRoot = temporaryDirectory("repository")
    const sourceRoot = join(repositoryRoot, "checks")
    mkdirSync(sourceRoot)
    writeFileSync(join(repositoryRoot, "outside.mjs"), "export {}\n")
    writeFileSync(npmrcPath, "registry=http://127.0.0.1:4873/\n")

    await expect(
      probeFreshConsumer({
        package: { name: "@fixture/public", version: "1.2.3" },
        registryUrl: "http://127.0.0.1:4873/",
        npmrcPath,
        nodePath: fixture.nodePath,
        npmPath: fixture.npmPath,
        sourceRoot,
        consumerCheck: {
          package: "@fixture/public",
          runner: "vitest",
          args: ["run", "../outside.mjs"],
          files: ["../outside.mjs"],
        },
      }),
    ).rejects.toMatchObject({
      name: "ProbeFailure",
      phase: "consumer-check-materialize",
      status: null,
      stderr: expect.stringMatching(/must stay inside source root.*\.\.\/outside\.mjs/i),
    })
  })

  test("fails loud with the exact check command when its installed runner link is missing", async () => {
    const fixture = fakeNpm()
    const npmrcPath = join(temporaryDirectory("npmrc"), "consumer.npmrc")
    const sourceRoot = temporaryDirectory("source")
    writeFileSync(join(sourceRoot, "check.mjs"), "export {}\n")
    writeFileSync(npmrcPath, "registry=http://127.0.0.1:4873/\n")

    const failure = await probeFreshConsumer({
      package: { name: "@fixture/public", version: "1.2.3" },
      registryUrl: "http://127.0.0.1:4873/",
      npmrcPath,
      nodePath: fixture.nodePath,
      npmPath: fixture.npmPath,
      sourceRoot,
      consumerCheck: {
        package: "@fixture/public",
        runner: "vitest",
        args: ["run", "check.mjs"],
        files: ["check.mjs"],
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toMatchObject({
      name: "ProbeFailure",
      phase: "consumer-check-link",
      packageName: "@fixture/public",
      status: null,
      stdout: "",
    })
    expect((failure as ProbeFailure).command[0]).toMatch(/node_modules\/\.bin\/vitest$/)
    expect((failure as ProbeFailure).command.slice(1)).toEqual(["run", "check.mjs"])
    expect((failure as ProbeFailure).stderr).toMatch(/required installed runner link is missing.*vitest/is)
  })

  test("refuses a supplied Node whose reported major is not 24 before invoking npm", async () => {
    const fixture = fakeNpm({ nodeVersion: "v23.11.0" })
    const npmrcPath = join(temporaryDirectory("npmrc"), "consumer.npmrc")
    writeFileSync(npmrcPath, "registry=http://127.0.0.1:4873/\n")

    await expect(
      probeFreshConsumer({
        package: { name: "@fixture/public", version: "1.2.3" },
        registryUrl: "http://127.0.0.1:4873/",
        npmrcPath,
        nodePath: fixture.nodePath,
        npmPath: fixture.npmPath,
      }),
    ).rejects.toMatchObject({
      name: "ProbeFailure",
      phase: "node-version",
      command: [fixture.nodePath, "--version"],
      status: 0,
      stdout: "v23.11.0\n",
      stderr: expect.stringMatching(/expected Node 24.*v23\.11\.0/i),
    })
    expect(existsSync(fixture.commandLog)).toBe(false)
  })
})
