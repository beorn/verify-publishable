import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

export interface ToolSpec {
  packageName: string
  expectedVersion: string
  binName: string
}

export interface ResolvedTool {
  packageName: string
  version: string
  manifestPath: string
  binPath: string
}

export const TOOL_SPECS = {
  verdaccio: { packageName: "verdaccio", expectedVersion: "6.10.2", binName: "verdaccio" },
  pnpm: { packageName: "pnpm", expectedVersion: "9.15.9", binName: "pnpm" },
  attw: { packageName: "@arethetypeswrong/cli", expectedVersion: "0.18.5", binName: "attw" },
  publint: { packageName: "publint", expectedVersion: "0.3.24", binName: "publint" },
} as const satisfies Record<string, ToolSpec>

function readManifest(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("top level must be an object")
    }
    return value as Record<string, unknown>
  } catch (error) {
    throw new Error(`cannot read required tool manifest: path=${path}; cause=${String(error)}`)
  }
}

export function findSelfPackageRoot(fromFile: string): string {
  const canonical = realpathSync(fromFile)
  let current = statSync(canonical).isDirectory() ? canonical : dirname(canonical)
  const searched: string[] = []
  while (true) {
    const manifestPath = join(current, "package.json")
    searched.push(manifestPath)
    if (existsSync(manifestPath)) {
      const manifest = readManifest(manifestPath)
      if (manifest.name === "verify-publishable") return current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`cannot find verify-publishable package root; searched=${JSON.stringify(searched)}`)
}

function packagePath(base: string, packageName: string): string {
  return join(base, ...packageName.split("/"))
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path)
}

export function resolveOwnedBin(selfRootInput: string, spec: ToolSpec): ResolvedTool {
  const selfRoot = realpathSync(selfRootInput)
  const selfManifestPath = join(selfRoot, "package.json")
  const selfManifest = readManifest(selfManifestPath)
  if (selfManifest.name !== "verify-publishable") {
    throw new Error(
      `tool owner mismatch: expected=verify-publishable actual=${String(selfManifest.name)} path=${selfManifestPath}`,
    )
  }
  const dependencies = selfManifest.dependencies
  const declared =
    dependencies !== null && typeof dependencies === "object" && !Array.isArray(dependencies)
      ? (dependencies as Record<string, unknown>)[spec.packageName]
      : undefined
  if (declared !== spec.expectedVersion) {
    throw new Error(
      `${spec.packageName} version mismatch: expected=${spec.expectedVersion} actual=${String(declared)} source=verify-publishable.dependencies`,
    )
  }

  const candidates = [packagePath(join(selfRoot, "node_modules"), spec.packageName)]
  const parent = dirname(selfRoot)
  if (basename(parent) === "node_modules") candidates.push(packagePath(parent, spec.packageName))
  const packageRootInput = candidates.find((candidate) => existsSync(join(candidate, "package.json")))
  if (packageRootInput === undefined) {
    throw new Error(
      `required owned tool is missing: package=${spec.packageName}; searched=${JSON.stringify(candidates)}`,
    )
  }
  const packageRoot = realpathSync(packageRootInput)
  const manifestPath = join(packageRoot, "package.json")
  const manifest = readManifest(manifestPath)
  if (manifest.name !== spec.packageName) {
    throw new Error(
      `resolved tool name mismatch: expected=${spec.packageName} actual=${String(manifest.name)} path=${manifestPath}`,
    )
  }
  if (manifest.version !== spec.expectedVersion) {
    throw new Error(
      `${spec.packageName} version mismatch: expected=${spec.expectedVersion} actual=${String(manifest.version)} path=${manifestPath}`,
    )
  }

  const rawBin = manifest.bin
  const relativeBin =
    typeof rawBin === "string"
      ? rawBin
      : rawBin !== null && typeof rawBin === "object" && !Array.isArray(rawBin)
        ? (rawBin as Record<string, unknown>)[spec.binName]
        : undefined
  if (typeof relativeBin !== "string" || relativeBin === "") {
    throw new Error(`required bin is missing: package=${spec.packageName} bin=${spec.binName} path=${manifestPath}`)
  }
  if (isAbsolute(relativeBin)) {
    throw new Error(`bin path must be relative: package=${spec.packageName} bin=${relativeBin}`)
  }
  const binPathInput = resolve(packageRoot, relativeBin)
  if (!inside(packageRoot, binPathInput)) {
    throw new Error(`bin path escapes package: package=${spec.packageName} bin=${relativeBin} root=${packageRoot}`)
  }
  if (!existsSync(binPathInput)) {
    throw new Error(
      `required bin file is missing: package=${spec.packageName} bin=${spec.binName} path=${binPathInput}`,
    )
  }
  const binPath = realpathSync(binPathInput)
  if (!inside(packageRoot, binPath)) {
    throw new Error(`bin path escapes package: package=${spec.packageName} bin=${relativeBin} root=${packageRoot}`)
  }
  if (!statSync(binPath).isFile()) {
    throw new Error(`required bin file is missing: package=${spec.packageName} bin=${spec.binName} path=${binPath}`)
  }
  return { packageName: spec.packageName, version: spec.expectedVersion, manifestPath, binPath }
}
