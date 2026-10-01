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

import { CommandFailure } from "../src/process.ts"
import { findHostExecutable } from "../src/preflight.ts"
import { literalSpecifiers, ProbeFailure, probeFreshConsumer } from "../src/probes.ts"

const roots: string[] = []
const configuredNodePath = process.env.NODE_FOR_TESTS
const hostNodePath = configuredNodePath === undefined ? findHostExecutable("node") : realpathSync(configuredNodePath)
if (hostNodePath === null) throw new Error("HOST_TOOL_MISSING: tool=node searched=PATH purpose=test-fixtures")
const hostBunPath = findHostExecutable("bun")
if (hostBunPath === null) throw new Error("HOST_TOOL_MISSING: tool=bun searched=PATH purpose=test-fixtures")

interface FakeNpmOptions {
  /** The packed manifest's engines; absent means the manifest declares none. */
  engines?: Record<string, string>
  /** The package bin's shebang interpreter. */
  binShebang?: "node" | "bun"
  /** The root export throws when Bun imports it. */
  rootFailsUnderBun?: boolean
  emptyFeature?: boolean
  linkPackageBin?: boolean
  linkNodeBin?: boolean
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
  runtimeLog: string
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
  const runtimeLog = join(root, "runtimes.log")
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
    ...(options.engines === undefined ? {} : { engines: options.engines }),
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
writeFileSync(join(packageRoot, "index.mjs"), ${JSON.stringify(`import { appendFileSync } from "node:fs"\nconst runtime = typeof Bun === "undefined" ? "node" : "bun"\nappendFileSync(${JSON.stringify(runtimeLog)}, process.env.NODE_ENV + ":" + runtime + "\\n")\n${options.rootFailsUnderBun === true ? 'if (runtime === "bun") throw new Error("fixture root cannot load under Bun")\n' : ""}appendFileSync(${JSON.stringify(importLog)}, process.env.NODE_ENV + ":root\\n")\nexport const root = true\n`)})
writeFileSync(join(packageRoot, "feature.mjs"), ${JSON.stringify(`import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(importLog)}, process.env.NODE_ENV + ":feature\\n")\n${options.emptyFeature === true ? "export {}" : "export const feature = true"}\n`)})
writeFileSync(join(packageRoot, "matchers.mjs"), ${JSON.stringify(`import { appendFileSync } from "node:fs"\nif (process.env.NODE_ENV) appendFileSync(${JSON.stringify(importLog)}, process.env.NODE_ENV + ":matchers\\n")\nif (globalThis.__VITEST_CONTEXT__ === true && ${options.registerMatcher !== false}) globalThis.__FIXTURE_MATCHER__ = true\nexport const terminalMatchers = {}\n`)})
writeFileSync(join(packageRoot, "cli.mjs"), ${JSON.stringify(`#!/usr/bin/env ${options.binShebang ?? "node"}\nimport { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(binLog)}, process.argv.slice(2).join(" ") + "\\n")\nif (process.argv[2] !== "--help") process.exit(91)\nconsole.log("Usage: fixture")\n`)})
chmodSync(join(packageRoot, "cli.mjs"), 0o755)
if (${options.linkPackageBin !== false}) {
  symlinkSync(join(packageRoot, "cli.mjs"), join(cwd, "node_modules", ".bin", "fixture"))
}
if (${options.linkNodeBin === true}) {
  const hostileNode = join(packageRoot, "hostile-node.mjs")
  writeFileSync(hostileNode, ${JSON.stringify("#!/bin/sh\nexit 89\n")})
  chmodSync(hostileNode, 0o755)
  symlinkSync(hostileNode, join(cwd, "node_modules", ".bin", "node"))
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
  return { npmPath, nodePath, nodeLog, commandLog, importLog, binLog, checkLog, runtimeLog }
}

/** A Bun executable in its own directory that logs each invocation and runs the host Bun. */
function fakeBun(): { bunPath: string; bunLog: string } {
  const root = temporaryDirectory("fake-bun")
  const bunDirectory = join(root, "selected-bun")
  mkdirSync(bunDirectory)
  const bunPath = join(bunDirectory, "bun")
  const bunLog = join(root, "bun.log")
  executable(
    bunPath,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(bunLog)}\nexec ${JSON.stringify(hostBunPath)} "$@"\n`,
  )
  return { bunPath, bunLog }
}

function lines(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line !== "")
    : []
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("fresh consumer probes", () => {
  /**
   * @failure Wrapping a real spawn failure loses its ENOENT cause and lifecycle metadata.
   * @level l1
   * @consumer fresh-consumer diagnostics with empty child output
   */
  test("preserves the real missing executable failure as its typed cause", async () => {
    const fixture = fakeNpm()
    const sourceRoot = temporaryDirectory("missing-node")
    const missingNode = join(sourceRoot, "absent-node")
    const failure = await probeFreshConsumer({
      package: { name: "@fixture/public", version: "1.2.3" },
      registryUrl: "http://127.0.0.1:4873/",
      npmrcPath: join(sourceRoot, "npmrc"),
      nodePath: missingNode,
      npmPath: fixture.npmPath,
      sourceRoot,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ProbeFailure)
    const wrapped = failure as ProbeFailure
    expect(wrapped.cause).toBeInstanceOf(CommandFailure)
    const cause = wrapped.cause as CommandFailure
    expect(cause.spawnError).toMatchObject({ code: "ENOENT" })
    expect(cause).toMatchObject({
      phase: "node-version",
      command: [missingNode, "--version"],
      status: null,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: "",
      stderr: "",
    })
    expect(cause.durationMs).toEqual(expect.any(Number))
    expect(wrapped.message).toContain(cause.message)
    expect(wrapped.message).toContain("@fixture/public@1.2.3")
    expect(wrapped.message).toContain("ENOENT")
    expect(existsSync(fixture.commandLog)).toBe(false)
  })

  /**
   * @failure A Node check resolves Bun or an installed .bin/node instead of the selected host Node,
   * or changes materialized files and literal arguments.
   * @level l1
   * @consumer runner=node checks in Bun-hosted fresh consumers
   */
  test.each([false, true])("runs the selected Node with installed node link=%s", async (linkNodeBin) => {
    const fixture = fakeNpm({ linkNodeBin })
    const npmrcPath = join(temporaryDirectory("npmrc"), "consumer.npmrc")
    writeFileSync(npmrcPath, "registry=http://127.0.0.1:4873/\n")
    const sourceRoot = temporaryDirectory("source")
    const receipt = join(sourceRoot, "receipt.json")
    const args = ["check.mjs", "an argument with spaces", "--literal"]
    writeFileSync(
      join(sourceRoot, "check.mjs"),
      `import { readFileSync, writeFileSync } from "node:fs"\nimport "@fixture/public"\nwriteFileSync(${JSON.stringify(receipt)}, JSON.stringify({ execPath: process.execPath, version: process.version, bun: typeof Bun, args: process.argv.slice(2), data: readFileSync("data.txt", "utf8") }))\n`,
    )
    writeFileSync(join(sourceRoot, "data.txt"), "copied payload\n")
    const result = await probeFreshConsumer({
      package: { name: "@fixture/public", version: "1.2.3" },
      registryUrl: "http://127.0.0.1:4873/",
      npmrcPath,
      nodePath: fixture.nodePath,
      npmPath: fixture.npmPath,
      sourceRoot,
      consumerCheck: { package: "@fixture/public", runner: "node", args, files: ["check.mjs", "data.txt"] },
    })
    expect(result.consumerCheckRan).toBe(true)
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
      execPath: hostNodePath,
      version: expect.stringMatching(/^v24\./),
      bun: "undefined",
      args: args.slice(1),
      data: "copied payload\n",
    })
    const selectedCalls = readFileSync(fixture.nodeLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(selectedCalls).toContainEqual(args)
  })

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
      runtimes: [{ runtime: "node", version: "v24.99.0", reason: "engines declares no runtime" }],
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
      "--engine-strict",
      "--force=false",
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
    expect((failure as ProbeFailure).message).not.toContain("spawn-error")
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

describe("probe runtimes follow the manifest's engines", () => {
  async function probe(fixture: ReturnType<typeof fakeNpm>, bunPath?: string) {
    const npmrcPath = join(temporaryDirectory("npmrc"), "consumer.npmrc")
    writeFileSync(npmrcPath, "registry=http://127.0.0.1:4873/\n")
    return probeFreshConsumer({
      package: { name: "@fixture/public", version: "1.2.3" },
      registryUrl: "http://127.0.0.1:4873/",
      npmrcPath,
      nodePath: fixture.nodePath,
      ...(bunPath === undefined ? {} : { bunPath }),
      npmPath: fixture.npmPath,
    })
  }

  test("a bun-only package is imported and its bin run under Bun, and never under Node", async () => {
    const fixture = fakeNpm({ engines: { bun: ">=1.0.0" }, binShebang: "bun" })
    const bun = fakeBun()
    const result = await probe(fixture, bun.bunPath)
    expect(result.runtimes).toEqual([
      { runtime: "bun", version: expect.stringMatching(/^\d+\.\d+\.\d+/), reason: "engines declares bun only" },
    ])
    expect(lines(fixture.runtimeLog).sort()).toEqual(["development:bun", "production:bun"])
    expect(readFileSync(fixture.binLog, "utf8")).toBe("--help\n")
    // Node still runs npm; it never imports the package or runs its bin.
    const nodeCalls = lines(fixture.nodeLog).map((line) => JSON.parse(line) as string[])
    expect(nodeCalls.some(([first]) => first === "--input-type=module")).toBe(false)
    expect(nodeCalls.some(([script]) => script?.endsWith("/node_modules/.bin/fixture"))).toBe(false)
  })

  test("a node-only package keeps the Node probe and does not touch Bun", async () => {
    const fixture = fakeNpm({ engines: { node: ">=24" } })
    const bun = fakeBun()
    const result = await probe(fixture, bun.bunPath)
    expect(result.runtimes).toEqual([{ runtime: "node", version: "v24.99.0", reason: "engines declares node only" }])
    expect(lines(fixture.runtimeLog).sort()).toEqual(["development:node", "production:node"])
    expect(lines(bun.bunLog)).toEqual([])
  })

  test("a package declaring both is probed under both", async () => {
    const fixture = fakeNpm({ engines: { node: ">=24", bun: ">=1.0.0" } })
    const bun = fakeBun()
    const result = await probe(fixture, bun.bunPath)
    expect(result.runtimes.map(({ runtime, reason }) => [runtime, reason])).toEqual([
      ["node", "engines declares node and bun"],
      ["bun", "engines declares node and bun"],
    ])
    expect(lines(fixture.runtimeLog).sort()).toEqual([
      "development:bun",
      "development:node",
      "production:bun",
      "production:node",
    ])
    expect(readFileSync(fixture.binLog, "utf8")).toBe("--help\n--help\n")
  })

  test("a package declaring no engines keeps the Node probe, as before", async () => {
    const fixture = fakeNpm()
    const bun = fakeBun()
    const result = await probe(fixture, bun.bunPath)
    expect(result.runtimes).toEqual([{ runtime: "node", version: "v24.99.0", reason: "engines declares no runtime" }])
    expect(lines(bun.bunLog)).toEqual([])
  })

  test("a bun-only package whose import fails under Bun fails the gate", async () => {
    const fixture = fakeNpm({ engines: { bun: ">=1.0.0" }, rootFailsUnderBun: true })
    const bun = fakeBun()
    await expect(probe(fixture, bun.bunPath)).rejects.toMatchObject({
      name: "ProbeFailure",
      phase: "import-development-bun",
      command: [bun.bunPath, "--eval", expect.any(String), expect.any(String)],
      stderr: expect.stringMatching(/fixture root cannot load under Bun/),
    })
  })

  test("a bun-only package with no Bun supplied refuses by name; no runtime is a waiver", async () => {
    const fixture = fakeNpm({ engines: { bun: ">=1.0.0" } })
    await expect(probe(fixture)).rejects.toMatchObject({
      name: "ProbeFailure",
      phase: "bun-version",
      stderr: expect.stringMatching(/engines declares bun only.*no absolute bunPath was supplied/),
    })
  })

  test("a Bun that engines.bun does not admit refuses by name", async () => {
    const fixture = fakeNpm({ engines: { bun: ">=99.0.0" } })
    const bun = fakeBun()
    await expect(probe(fixture, bun.bunPath)).rejects.toMatchObject({
      name: "ProbeFailure",
      phase: "bun-version",
      stderr: expect.stringMatching(/engines\.bun=">=99\.0\.0" does not admit/),
    })
    expect(lines(fixture.runtimeLog)).toEqual([])
  })

  test("a package declaring node whose bin runs under Bun is a finding, not a pass", async () => {
    const fixture = fakeNpm({ engines: { node: ">=24" }, binShebang: "bun" })
    await expect(probe(fixture)).rejects.toMatchObject({
      name: "ProbeFailure",
      phase: "bin-runtime",
      stderr: expect.stringMatching(/engines declares node, but bin fixture runs under Bun.*#!\/usr\/bin\/env bun/),
    })
    expect(existsSync(fixture.binLog)).toBe(false)
  })
})

describe("literal import specifiers", () => {
  /**
   * @failure A package whose exports map lists subpaths but no "." fails its fresh-consumer probe on the bare
   * package name, which Node refuses by design (ERR_PACKAGE_PATH_NOT_EXPORTED) and the manifest never promised.
   * @level l0
   * @consumer probeFreshConsumer's import phases
   */
  test("imports the root only where the manifest exports it", () => {
    expect(literalSpecifiers("p", undefined)).toEqual(["p"])
    expect(literalSpecifiers("p", "./dist/index.js")).toEqual(["p"])
    expect(literalSpecifiers("p", { import: "./a.js", types: "./a.d.ts" })).toEqual(["p"])
    expect(literalSpecifiers("p", { ".": "./a.js", "./b": "./b.js", "./c/*": "./c/*.js" })).toEqual(["p", "p/b"])
    expect(literalSpecifiers("p", { "./runtime": "./r.js" })).toEqual(["p/runtime"])
    expect(literalSpecifiers("p", { "./*": "./*.js" })).toEqual([])
  })
})
