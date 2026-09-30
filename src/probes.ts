import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import type { DiscoveredPackage, PackageManifest } from "./discovery.ts"
import { CommandFailure, runCommand, type CommandResult, type CommandSpec } from "./process.ts"
import { probeRuntimesFor, type ProbeRuntime, type ProbeRuntimeName } from "./runtime.ts"

export { probeRuntimesFor, type ProbeRuntime, type ProbeRuntimeName }

export interface ConsumerCheck {
  package: string
  runner: string
  args: string[]
  files: string[]
}

export interface FreshConsumerOptions {
  package: Pick<DiscoveredPackage, "name" | "version">
  registryUrl: string
  npmrcPath: string
  nodePath: string
  /** Absolute Bun executable; required only when the packed manifest's engines declare bun. */
  bunPath?: string
  npmPath: string
  sourceRoot?: string
  consumerCheck?: ConsumerCheck
  abortSignal?: AbortSignal
}

export interface FreshConsumerResult {
  packageName: string
  version: string
  specifiers: string[]
  bins: string[]
  consumerCheckRan: boolean
  runtimes: ProbeRuntime[]
}

const BUN_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?bun(?:\s|$)/

export class ProbeFailure extends Error {
  readonly phase: string
  readonly packageName: string
  readonly packageVersion: string
  readonly command: string[]
  readonly cwd: string
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string

  constructor(options: {
    phase: string
    packageName: string
    packageVersion: string
    command: string[]
    cwd: string
    status: number | null
    stdout: string
    stderr: string
  }) {
    const renderedCommand = options.command.map((part) => JSON.stringify(part)).join(" ")
    super(
      `consumer probe failed: phase=${JSON.stringify(options.phase)}; package=${JSON.stringify(`${options.packageName}@${options.packageVersion}`)}; command=${renderedCommand}; cwd=${JSON.stringify(options.cwd)}; status=${options.status === null ? "spawn-error" : options.status}; stdout=${JSON.stringify(options.stdout)}; stderr=${JSON.stringify(options.stderr)}`,
    )
    this.name = "ProbeFailure"
    this.phase = options.phase
    this.packageName = options.packageName
    this.packageVersion = options.packageVersion
    this.command = options.command
    this.cwd = options.cwd
    this.status = options.status
    this.stdout = options.stdout
    this.stderr = options.stderr
  }
}

interface PackageIdentity {
  name: string
  version: string
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function localFailure(
  identity: PackageIdentity,
  options: {
    phase: string
    command: string[]
    cwd: string
    stderr: string
  },
): ProbeFailure {
  return new ProbeFailure({
    ...options,
    packageName: identity.name,
    packageVersion: identity.version,
    status: null,
    stdout: "",
  })
}

async function runProbeCommand(identity: PackageIdentity, spec: CommandSpec): Promise<CommandResult> {
  try {
    return await runCommand(spec)
  } catch (error) {
    if (error instanceof CommandFailure) {
      throw new ProbeFailure({
        phase: error.phase,
        packageName: identity.name,
        packageVersion: identity.version,
        command: error.command,
        cwd: error.cwd,
        status: error.status,
        stdout: error.stdout,
        stderr: error.stderr,
      })
    }
    throw error
  }
}

const CONTROLLED_NPM_ENV_KEYS = new Set(["npm_config_registry", "npm_config_userconfig"])

function controlledEnvironment(nodePath: string, registryUrl: string, npmrcPath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  let inheritedPath: string | undefined
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toLowerCase()
    if (CONTROLLED_NPM_ENV_KEYS.has(normalized)) {
      // runCommand overlays this object on process.env, so explicit undefined is
      // required to remove differently-cased inherited npm config keys.
      environment[key] = undefined
      continue
    }
    if (normalized === "path") {
      inheritedPath ??= value
      continue
    }
    environment[key] = value
  }
  environment.PATH =
    inheritedPath === undefined || inheritedPath === ""
      ? dirname(nodePath)
      : `${dirname(nodePath)}${delimiter}${inheritedPath}`
  environment.NPM_CONFIG_REGISTRY = registryUrl
  environment.NPM_CONFIG_USERCONFIG = npmrcPath
  return environment
}

function assertAbsoluteResource(identity: PackageIdentity, label: string, path: string, cwd: string): void {
  if (!isAbsolute(path)) {
    throw localFailure(identity, {
      phase: "preflight",
      command: [path],
      cwd,
      stderr: `${label} must be an absolute path: path=${path}`,
    })
  }
}

function packageDirectory(consumerRoot: string, packageName: string): string {
  const parts = packageName.split("/")
  if (
    (parts.length !== 1 && !(parts.length === 2 && parts[0]?.startsWith("@"))) ||
    parts.some((part) => part === "" || part === "." || part === ".." || basename(part) !== part)
  ) {
    throw new Error(`invalid npm package name: ${packageName}`)
  }
  const path = resolve(consumerRoot, "node_modules", ...parts)
  if (!inside(join(consumerRoot, "node_modules"), path))
    throw new Error(`npm package path escapes consumer: ${packageName}`)
  return path
}

async function installedManifest(identity: PackageIdentity, consumerRoot: string): Promise<PackageManifest> {
  const manifestPath = join(packageDirectory(consumerRoot, identity.name), "package.json")
  let source: string
  try {
    source = await readFile(manifestPath, "utf8")
  } catch (error) {
    throw localFailure(identity, {
      phase: "installed-manifest",
      command: [manifestPath],
      cwd: consumerRoot,
      stderr: `installed package manifest is missing: path=${manifestPath}; cause=${String(error)}`,
    })
  }

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw localFailure(identity, {
      phase: "installed-manifest",
      command: [manifestPath],
      cwd: consumerRoot,
      stderr: `installed package manifest is invalid JSON: path=${manifestPath}; cause=${String(error)}`,
    })
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw localFailure(identity, {
      phase: "installed-manifest",
      command: [manifestPath],
      cwd: consumerRoot,
      stderr: `installed package manifest must be an object: path=${manifestPath}`,
    })
  }
  const manifest = value as PackageManifest
  if (manifest.name !== identity.name || manifest.version !== identity.version) {
    throw localFailure(identity, {
      phase: "installed-manifest",
      command: [manifestPath],
      cwd: consumerRoot,
      stderr: `installed package identity mismatch: expected=${identity.name}@${identity.version} actual=${String(manifest.name)}@${String(manifest.version)} path=${manifestPath}`,
    })
  }
  return manifest
}

/**
 * The specifiers a fresh consumer may import: the package root unless an exports subpath map leaves "." out (Node
 * then refuses the bare name with ERR_PACKAGE_PATH_NOT_EXPORTED, so the manifest promises no root import), plus
 * every literal subpath. A string, array or condition-object exports value is the root.
 */
export function literalSpecifiers(packageName: string, exportsField: unknown): string[] {
  if (
    exportsField === undefined ||
    exportsField === null ||
    typeof exportsField !== "object" ||
    Array.isArray(exportsField)
  ) {
    return [packageName]
  }
  const keys = Object.keys(exportsField as Record<string, unknown>)
  if (!keys.some((key) => key.startsWith("."))) return [packageName]
  const specifiers = new Set<string>()
  if (keys.includes(".")) specifiers.add(packageName)
  for (const subpath of keys.sort()) {
    if (subpath === "." || subpath.includes("*")) continue
    if (subpath.startsWith("./") && subpath.length > 2) specifiers.add(`${packageName}/${subpath.slice(2)}`)
  }
  return [...specifiers]
}

function declaredBins(packageName: string, rawBin: PackageManifest["bin"]): Array<[string, string]> {
  if (rawBin === undefined) return []
  if (typeof rawBin === "string") return [[packageName.split("/").at(-1)!, rawBin]]
  if (rawBin === null || typeof rawBin !== "object" || Array.isArray(rawBin)) return []
  return Object.entries(rawBin).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
}

async function explicitBin(
  identity: PackageIdentity,
  consumerRoot: string,
  binName: string,
  phase: string,
  args: string[],
  description: "package bin" | "runner",
  expectedPackageRoot?: string,
): Promise<string> {
  if (binName === "" || basename(binName) !== binName) {
    throw localFailure(identity, {
      phase,
      command: [binName, ...args],
      cwd: consumerRoot,
      stderr: `installed bin name must be a single path segment: bin=${binName}`,
    })
  }
  const binPath = join(consumerRoot, "node_modules", ".bin", binName)
  let linkTarget: string
  try {
    const link = await lstat(binPath)
    if (!link.isSymbolicLink()) throw new Error("path is not a symbolic link")
    linkTarget = await realpath(binPath)
    const target = await stat(linkTarget)
    if (!target.isFile()) throw new Error(`link target is not a file: target=${linkTarget}`)
  } catch (error) {
    throw localFailure(identity, {
      phase,
      command: [binPath, ...args],
      cwd: consumerRoot,
      stderr: `required installed ${description} link is missing or invalid: bin=${binName} path=${binPath}; cause=${String(error)}`,
    })
  }
  if (expectedPackageRoot !== undefined && !inside(expectedPackageRoot, linkTarget)) {
    throw localFailure(identity, {
      phase,
      command: [binPath, ...args],
      cwd: consumerRoot,
      stderr: `installed package bin link escapes package: bin=${binName} link=${binPath} target=${linkTarget} packageRoot=${expectedPackageRoot}`,
    })
  }
  return binPath
}

async function materializeCheck(
  identity: PackageIdentity,
  consumerRoot: string,
  sourceRootInput: string | undefined,
  check: ConsumerCheck,
): Promise<void> {
  if (check.package !== identity.name) {
    throw localFailure(identity, {
      phase: "consumer-check-config",
      command: [check.runner, ...check.args],
      cwd: consumerRoot,
      stderr: `configured consumer check targets a different package: expected=${identity.name} actual=${check.package}`,
    })
  }
  if (
    check.runner === "" ||
    basename(check.runner) !== check.runner ||
    check.args.some((arg) => typeof arg !== "string")
  ) {
    throw localFailure(identity, {
      phase: "consumer-check-config",
      command: [check.runner, ...check.args],
      cwd: consumerRoot,
      stderr: `configured consumer check runner must be one installed bin name and args must be strings: runner=${check.runner}`,
    })
  }
  if (sourceRootInput === undefined || !isAbsolute(sourceRootInput)) {
    throw localFailure(identity, {
      phase: "consumer-check-materialize",
      command: [...check.files],
      cwd: consumerRoot,
      stderr: `configured consumer check requires an absolute source root: sourceRoot=${String(sourceRootInput)}`,
    })
  }
  if (check.files.length === 0 || new Set(check.files).size !== check.files.length) {
    throw localFailure(identity, {
      phase: "consumer-check-materialize",
      command: [...check.files],
      cwd: consumerRoot,
      stderr: "configured consumer check files must be a non-empty list without duplicates",
    })
  }

  let sourceRoot: string
  try {
    sourceRoot = await realpath(sourceRootInput)
  } catch (error) {
    throw localFailure(identity, {
      phase: "consumer-check-materialize",
      command: [...check.files],
      cwd: consumerRoot,
      stderr: `configured consumer check source root is missing: sourceRoot=${sourceRootInput}; cause=${String(error)}`,
    })
  }
  for (const relativePath of check.files) {
    const sourcePath = resolve(sourceRoot, relativePath)
    const destinationPath = resolve(consumerRoot, relativePath)
    if (
      relativePath === "" ||
      isAbsolute(relativePath) ||
      !inside(sourceRoot, sourcePath) ||
      !inside(consumerRoot, destinationPath)
    ) {
      throw localFailure(identity, {
        phase: "consumer-check-materialize",
        command: [relativePath],
        cwd: consumerRoot,
        stderr: `configured consumer check file must stay inside source root: sourceRoot=${sourceRoot} path=${relativePath}`,
      })
    }
    let canonicalSource: string
    let source: Buffer
    try {
      canonicalSource = await realpath(sourcePath)
      if (!inside(sourceRoot, canonicalSource)) {
        throw new Error(`resolved path escapes source root: resolved=${canonicalSource}`)
      }
      const metadata = await stat(canonicalSource)
      if (!metadata.isFile()) throw new Error(`source is not a file: resolved=${canonicalSource}`)
      source = await readFile(canonicalSource)
    } catch (error) {
      throw localFailure(identity, {
        phase: "consumer-check-materialize",
        command: [relativePath],
        cwd: consumerRoot,
        stderr: `configured consumer check source file is missing or invalid: sourceRoot=${sourceRoot} path=${relativePath}; cause=${String(error)}`,
      })
    }
    await mkdir(dirname(destinationPath), { recursive: true })
    try {
      await writeFile(destinationPath, source, { flag: "wx" })
    } catch (error) {
      throw localFailure(identity, {
        phase: "consumer-check-materialize",
        command: [relativePath],
        cwd: consumerRoot,
        stderr: `cannot materialize configured consumer check: source=${canonicalSource} destination=${destinationPath}; cause=${String(error)}`,
      })
    }
  }
}

/**
 * The Bun a bun-declaring manifest is probed under: the one supplied, reporting a version its engines.bun range
 * admits. Bun itself judges the range, so no second semver implementation decides it.
 */
async function selectedBun(
  identity: PackageIdentity,
  bunPath: string | undefined,
  engines: unknown,
  cwd: string,
  reason: string,
  runProbe: (spec: CommandSpec) => Promise<CommandResult>,
): Promise<{ path: string; version: string }> {
  const range = (engines as Record<string, unknown>).bun as string
  if (bunPath === undefined || !isAbsolute(bunPath)) {
    throw localFailure(identity, {
      phase: "bun-version",
      command: [String(bunPath), "--version"],
      cwd,
      stderr: `${reason}, so the consumer probes run under Bun, but no absolute bunPath was supplied: bunPath=${String(bunPath)} engines.bun=${JSON.stringify(range)}`,
    })
  }
  const judge = await runProbe({
    phase: "bun-version",
    command: bunPath,
    args: [
      "--eval",
      "process.stdout.write(JSON.stringify({ version: Bun.version, satisfies: Bun.semver.satisfies(Bun.version, process.argv[1]) }))",
      range,
    ],
    cwd,
  })
  let verdict: { version?: unknown; satisfies?: unknown }
  try {
    verdict = JSON.parse(judge.stdout) as typeof verdict
  } catch (error) {
    throw localFailure(identity, {
      phase: "bun-version",
      command: [bunPath, "--eval"],
      cwd,
      stderr: `bunPath did not report its version as JSON: bunPath=${bunPath} stdout=${JSON.stringify(judge.stdout)}; cause=${String(error)}`,
    })
  }
  if (typeof verdict.version !== "string" || verdict.satisfies !== true) {
    throw localFailure(identity, {
      phase: "bun-version",
      command: [bunPath, "--version"],
      cwd,
      stderr: `Bun at bunPath=${bunPath} reports ${JSON.stringify(verdict.version)}, which engines.bun=${JSON.stringify(range)} does not admit`,
    })
  }
  return { path: bunPath, version: verdict.version }
}

async function refuseBunShebang(
  identity: PackageIdentity,
  consumerRoot: string,
  binName: string,
  binPath: string,
): Promise<void> {
  const target = await realpath(binPath)
  const firstLine = (await readFile(target, "utf8")).split("\n", 1)[0] ?? ""
  if (BUN_SHEBANG.test(firstLine)) {
    throw localFailure(identity, {
      phase: "bin-runtime",
      command: [binPath, "--help"],
      cwd: consumerRoot,
      stderr: `engines declares node, but bin ${binName} runs under Bun: target=${target} shebang=${JSON.stringify(firstLine)}`,
    })
  }
}

export async function probeFreshConsumer(options: FreshConsumerOptions): Promise<FreshConsumerResult> {
  const identity = { name: options.package.name, version: options.package.version }
  const sourceRoot = options.sourceRoot ?? process.cwd()
  assertAbsoluteResource(identity, "npmPath", options.npmPath, sourceRoot)
  assertAbsoluteResource(identity, "nodePath", options.nodePath, sourceRoot)
  assertAbsoluteResource(identity, "npmrcPath", options.npmrcPath, sourceRoot)
  const npmEnvironment = controlledEnvironment(options.nodePath, options.registryUrl, options.npmrcPath)
  const runProbe = (spec: CommandSpec) =>
    runProbeCommand(identity, {
      ...spec,
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    })
  const versionCommand = [options.nodePath, "--version"]
  const versionResult = await runProbe({
    phase: "node-version",
    command: options.nodePath,
    args: ["--version"],
    cwd: sourceRoot,
    env: npmEnvironment,
  })
  if (!/^v24(?:\.|$)/.test(versionResult.stdout.trim())) {
    const diagnostic = `expected Node 24 from nodePath=${options.nodePath}; received=${JSON.stringify(versionResult.stdout.trim())}`
    throw new ProbeFailure({
      phase: "node-version",
      packageName: identity.name,
      packageVersion: identity.version,
      command: versionCommand,
      cwd: sourceRoot,
      status: versionResult.status,
      stdout: versionResult.stdout,
      stderr: versionResult.stderr === "" ? diagnostic : `${versionResult.stderr.replace(/\n$/, "")}\n${diagnostic}`,
    })
  }
  const nodeVersion = versionResult.stdout.trim()
  const consumerRoot = await mkdtemp(join(tmpdir(), "verify-publishable-consumer-"))

  const run = async (): Promise<FreshConsumerResult> => {
    await runProbe({
      phase: "consumer-init",
      command: options.nodePath,
      args: [
        options.npmPath,
        "init",
        "--yes",
        "--quiet",
        "--userconfig",
        options.npmrcPath,
        "--registry",
        options.registryUrl,
      ],
      cwd: consumerRoot,
      env: npmEnvironment,
    })
    await runProbe({
      phase: "consumer-install",
      command: options.nodePath,
      args: [
        options.npmPath,
        "install",
        "--no-save",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--userconfig",
        options.npmrcPath,
        "--registry",
        options.registryUrl,
        `${identity.name}@${identity.version}`,
      ],
      cwd: consumerRoot,
      env: npmEnvironment,
    })

    const manifest = await installedManifest(identity, consumerRoot)
    const specifiers = literalSpecifiers(identity.name, manifest.exports)
    if (specifiers.length === 0) {
      throw localFailure(identity, {
        phase: "import-specifiers",
        command: [join(consumerRoot, "node_modules", identity.name, "package.json")],
        cwd: consumerRoot,
        stderr: `no literal import specifier: exports=${JSON.stringify(manifest.exports)} names neither "." nor a literal subpath, so a fresh consumer has nothing to import`,
      })
    }
    const selected = probeRuntimesFor(manifest.engines)
    const runtimes: Array<ProbeRuntime & { command: string; env: NodeJS.ProcessEnv }> = []
    for (const { runtime, reason } of selected) {
      if (runtime === "node") {
        runtimes.push({ runtime, version: nodeVersion, reason, command: options.nodePath, env: npmEnvironment })
        continue
      }
      const bunPath = await selectedBun(identity, options.bunPath, manifest.engines, consumerRoot, reason, runProbe)
      runtimes.push({
        runtime,
        version: bunPath.version,
        reason,
        command: bunPath.path,
        env: controlledEnvironment(bunPath.path, options.registryUrl, options.npmrcPath),
      })
    }

    const importScript = `const specifiers = JSON.parse(process.argv[1]);\nfor (const specifier of specifiers) {\n  try {\n    await import(specifier);\n  } catch (error) {\n    console.error(specifier + ": " + (error?.stack ?? String(error)));\n    process.exit(1);\n  }\n}`
    for (const probe of runtimes) {
      for (const mode of ["development", "production"] as const) {
        await runProbe({
          // Node's phase names are unchanged; a Bun probe says so in its phase.
          phase: probe.runtime === "node" ? `import-${mode}` : `import-${mode}-bun`,
          command: probe.command,
          args:
            probe.runtime === "node"
              ? ["--input-type=module", "--eval", importScript, JSON.stringify(specifiers)]
              : ["--eval", importScript, JSON.stringify(specifiers)],
          cwd: consumerRoot,
          env: { ...probe.env, NODE_ENV: mode },
        })
      }
    }

    const packageRoot = packageDirectory(consumerRoot, identity.name)
    const bins = declaredBins(identity.name, manifest.bin)
    for (const [binName, relativeBin] of bins) {
      if (typeof relativeBin !== "string" || relativeBin === "") {
        throw localFailure(identity, {
          phase: "bin-link",
          command: [binName, "--help"],
          cwd: consumerRoot,
          stderr: `declared package bin target must be a non-empty string: bin=${binName} target=${String(relativeBin)}`,
        })
      }
      const binPath = await explicitBin(
        identity,
        consumerRoot,
        binName,
        "bin-link",
        ["--help"],
        "package bin",
        packageRoot,
      )
      for (const probe of runtimes) {
        if (probe.runtime === "node") {
          // A package that promises Node must not ship a bin only Bun runs (no-engines packages keep today's probe).
          if (typeof (manifest.engines as Record<string, unknown> | undefined)?.node === "string") {
            await refuseBunShebang(identity, consumerRoot, binName, binPath)
          }
          await runProbe({ phase: "bin-help", command: binPath, args: ["--help"], cwd: consumerRoot, env: probe.env })
          continue
        }
        await runProbe({
          phase: "bin-help-bun",
          command: probe.command,
          args: [binPath, "--help"],
          cwd: consumerRoot,
          env: probe.env,
        })
      }
    }

    if (options.consumerCheck !== undefined) {
      await materializeCheck(identity, consumerRoot, options.sourceRoot, options.consumerCheck)
      const checkBin = await explicitBin(
        identity,
        consumerRoot,
        options.consumerCheck.runner,
        "consumer-check-link",
        options.consumerCheck.args,
        "runner",
      )
      await runProbe({
        phase: "consumer-check",
        command: checkBin,
        args: options.consumerCheck.args,
        cwd: consumerRoot,
        env: npmEnvironment,
      })
    }

    return {
      packageName: identity.name,
      version: identity.version,
      specifiers,
      bins: bins.map(([name]) => name),
      consumerCheckRan: options.consumerCheck !== undefined,
      runtimes: runtimes.map(({ runtime, version, reason }) => ({ runtime, version, reason })),
    }
  }

  let result: FreshConsumerResult | undefined
  let primaryError: unknown
  try {
    result = await run()
  } catch (error) {
    primaryError = error
  }
  let cleanupError: unknown
  try {
    await rm(consumerRoot, { recursive: true, force: true })
  } catch (error) {
    cleanupError = new Error(`consumer cleanup failed: path=${consumerRoot}; cause=${String(error)}`)
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([primaryError, cleanupError], "consumer probe and cleanup both failed")
  }
  if (primaryError !== undefined) throw primaryError
  if (cleanupError !== undefined) throw cleanupError
  return result!
}
