import { existsSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"

import type { CommandResult, CommandSpec } from "./process.ts"
import { runCommand } from "./process.ts"
import type { ResolvedTool } from "./tools.ts"

export interface PublishableTarball {
  name: string
  version: string
  tarballPath: string
  cwd: string
}

type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>

function requiredFile(label: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute: path=${JSON.stringify(path)}`)
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing: path=${JSON.stringify(path)}`)
  }
}

function validateRegistry(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    throw new Error(`LOCAL_REGISTRY_INVALID: url=${JSON.stringify(url)} cause=${String(error)}`)
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(`LOCAL_REGISTRY_REQUIRED: expected=http://127.0.0.1:<port> actual=${JSON.stringify(url)}`)
  }
  if (parsed.port === "")
    throw new Error(`LOCAL_REGISTRY_INVALID: explicit port is required url=${JSON.stringify(url)}`)
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      `LOCAL_REGISTRY_INVALID: path, query, or hash is not allowed url=${JSON.stringify(url)} pathname=${JSON.stringify(parsed.pathname)} search=${JSON.stringify(parsed.search)} hash=${JSON.stringify(parsed.hash)}`,
    )
  }
  return parsed.origin
}

export async function publishTarballs(
  tarballs: PublishableTarball[],
  options: {
    nodePath: string
    pnpm: ResolvedTool
    registryUrl: string
    npmrcPath: string
    run?: CommandRunner
    abortSignal?: AbortSignal
  },
): Promise<CommandResult[]> {
  if (tarballs.length === 0) throw new Error("PUBLISH_INPUT_EMPTY: queried=tarballs result=[]")
  if (!isAbsolute(options.nodePath)) {
    throw new Error(`nodePath must be absolute: path=${JSON.stringify(options.nodePath)}`)
  }
  requiredFile("pnpm bin", options.pnpm.binPath)
  requiredFile("registry npmrc", options.npmrcPath)
  const registryUrl = validateRegistry(options.registryUrl)
  for (const tarball of tarballs) {
    if (!isAbsolute(tarball.cwd))
      throw new Error(`package cwd must be absolute: package=${tarball.name} cwd=${tarball.cwd}`)
    requiredFile(`tarball for ${tarball.name}@${tarball.version}`, tarball.tarballPath)
  }

  const run = options.run ?? runCommand
  const results: CommandResult[] = []
  for (const tarball of tarballs) {
    results.push(
      await run({
        phase: `publish:${tarball.name}`,
        command: options.nodePath,
        args: [
          options.pnpm.binPath,
          "publish",
          tarball.tarballPath,
          "--registry",
          registryUrl,
          "--no-git-checks",
          "--access",
          "public",
        ],
        cwd: tarball.cwd,
        env: {
          NPM_CONFIG_REGISTRY: registryUrl,
          npm_config_registry: registryUrl,
          NPM_CONFIG_USERCONFIG: options.npmrcPath,
          npm_config_userconfig: options.npmrcPath,
          // This is an npm-backed transport into the disposable local registry,
          // even when the source repository requires Bun for authoring.
          npm_config_force: "true",
        },
        timeoutMs: 120_000,
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      }),
    )
  }
  return results
}
