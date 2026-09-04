import { accessSync, constants, existsSync, realpathSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

import type { CommandResult, CommandSpec } from "./process.ts"
import { runCommand } from "./process.ts"

export interface HostTools {
  nodePath: string
  nodeVersion: string
  npmPath: string
  npmVersion: string
}

export interface HostToolDependencies {
  which: (name: string) => string | null
  run: (spec: CommandSpec) => Promise<CommandResult>
}

function requiredPath(name: "node" | "npm", which: HostToolDependencies["which"]): string {
  const path = which(name)
  if (path === null) throw new Error(`HOST_TOOL_MISSING: tool=${name} searched=PATH`)
  if (!isAbsolute(path)) throw new Error(`HOST_TOOL_INVALID: tool=${name} expected=absolute-path actual=${path}`)
  return path
}

export function findHostExecutable(name: "node" | "npm", env: NodeJS.ProcessEnv = process.env): string | null {
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
    return canonical
  }
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
): Promise<HostTools> {
  const which = dependencies.which ?? ((name: string) => findHostExecutable(name as "node" | "npm"))
  const run = dependencies.run ?? runCommand
  const nodePath = requiredPath("node", which)
  const nodeResult = await run({ phase: "preflight", command: nodePath, args: ["--version"], cwd, timeoutMs: 10_000 })
  const nodeVersion = singleLineVersion("node", nodeResult.stdout)
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(nodeVersion)
  if (match === null) throw new Error(`NODE_VERSION_INVALID: expected=v<major>.<minor>.<patch> actual=${nodeVersion}`)
  if (match[1] !== "24") throw new Error(`NODE_VERSION_UNSUPPORTED: required=24 actual=${nodeVersion}`)

  const npmPath = requiredPath("npm", which)
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

  return { nodePath, nodeVersion, npmPath, npmVersion }
}
