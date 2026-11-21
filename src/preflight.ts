import { accessSync, constants, existsSync, realpathSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join } from "node:path"

import type { CommandResult, CommandSpec } from "./process.ts"
import { runCommand } from "./process.ts"

export const DEFAULT_NODE_RANGE = "24"

export function nodeEngineRange(engines: unknown): string | undefined {
  if (engines === null || typeof engines !== "object" || !("node" in engines)) return undefined
  if (typeof engines.node !== "string") {
    throw new Error(`NODE_ENGINE_INVALID: expected an npm version range; received=${JSON.stringify(engines.node)}`)
  }
  return engines.node
}

export interface HostTools {
  nodePath: string
  /** Resolved like nodePath, but optional: only a package whose engines declare bun needs it, and its probe refuses by name. */
  bunPath: string | null
  nodeVersion: string
  nodeSelectionReason: string
  npmPath: string
  npmVersion: string
}

export interface HostToolDependencies {
  which: (name: string) => string | null
  nodeCandidates: () => readonly string[]
  run: (spec: CommandSpec) => Promise<CommandResult>
}

function requiredPath(name: "node" | "npm", path: string | null): string {
  if (path === null) throw new Error(`HOST_TOOL_MISSING: tool=${name} searched=PATH`)
  if (!isAbsolute(path)) throw new Error(`HOST_TOOL_INVALID: tool=${name} expected=absolute-path actual=${path}`)
  return path
}

function* hostExecutables(name: "node" | "npm" | "bun", env: NodeJS.ProcessEnv): Generator<string> {
  const bunPath = realpathSync(process.execPath)
  const executable = process.platform === "win32" ? `${name}.exe` : name
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue
    const candidate = join(directory, executable)
    if (!existsSync(candidate)) continue
    let canonical: string
    try {
      canonical = realpathSync(candidate)
      accessSync(canonical, constants.X_OK)
    } catch (error) {
      throw new Error(`HOST_TOOL_INACCESSIBLE: tool=${name} path=${candidate} cause=${String(error)}`)
    }
    if (name === "node" && canonical === bunPath) continue
    yield canonical
  }
}

export function findHostExecutable(name: "node" | "npm" | "bun", env: NodeJS.ProcessEnv = process.env): string | null {
  for (const path of hostExecutables(name, env)) return path
  return null
}

function singleLineVersion(tool: string, stdout: string): string {
  const value = stdout.trim()
  if (value === "" || value.includes("\n")) {
    throw new Error(`HOST_VERSION_INVALID: tool=${tool} stdout=${JSON.stringify(stdout)}`)
  }
  return value
}

export async function resolveHostTools(
  cwd: string,
  dependencies: Partial<HostToolDependencies> = {},
  requirement?: { packageName: string; range?: string },
): Promise<HostTools> {
  const which = dependencies.which ?? ((name: string) => findHostExecutable(name as "node" | "npm" | "bun"))
  const run = dependencies.run ?? runCommand
  const candidates =
    dependencies.nodeCandidates?.() ??
    (dependencies.which === undefined ? hostExecutables("node", process.env) : [requiredPath("node", which("node"))])
  const range = requirement?.range ?? DEFAULT_NODE_RANGE
  const available: string[] = []
  const seen = new Set<string>()
  let selected: { nodePath: string; nodeVersion: string } | undefined
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const nodePath = requiredPath("node", candidate)
    const result = await run({ phase: "preflight", command: nodePath, args: ["--version"], cwd, timeoutMs: 10_000 })
    const nodeVersion = singleLineVersion("node", result.stdout)
    if (!/^v\d+\.\d+\.\d+(?:[-+].*)?$/.test(nodeVersion)) {
      throw new Error(`NODE_VERSION_INVALID: path=${nodePath} expected=v<major>.<minor>.<patch> actual=${nodeVersion}`)
    }
    available.push(nodeVersion)
    if (Bun.semver.satisfies(nodeVersion, range)) {
      selected = { nodePath, nodeVersion }
      break
    }
  }
  if (selected === undefined) {
    if (available.length === 0) throw new Error(`HOST_TOOL_MISSING: tool=node searched=PATH required=${range}`)
    throw new Error(
      `NODE_VERSION_UNSUPPORTED: package=${requirement?.packageName ?? "host"} required=${range} actual=${available[0]} available=${JSON.stringify(available)} searched=PATH`,
    )
  }
  const { nodePath, nodeVersion } = selected
  const nodeSelectionReason =
    requirement?.range === undefined ? "no engines range declared; default Node 24" : `engines.node ${range}`

  const adjacentNpm = dependencies.which === undefined ? findHostExecutable("npm", { PATH: dirname(nodePath) }) : null
  const npmPath = requiredPath("npm", adjacentNpm ?? which("npm"))
  const npmResult = await run({
    phase: "preflight",
    command: nodePath,
    args: [npmPath, "--version"],
    cwd,
    timeoutMs: 10_000,
  })
  const npmVersion = singleLineVersion("npm", npmResult.stdout)
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(npmVersion)) {
    throw new Error(`NPM_VERSION_INVALID: expected=<major>.<minor>.<patch> actual=${npmVersion}`)
  }

  const bunPath = which("bun")
  if (bunPath !== null && !isAbsolute(bunPath)) {
    throw new Error(`HOST_TOOL_INVALID: tool=bun expected=absolute-path actual=${bunPath}`)
  }

  return { nodePath, bunPath, nodeVersion, nodeSelectionReason, npmPath, npmVersion }
}
