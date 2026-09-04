import { realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export const DEFAULT_MAX_UNPACKED_BYTES = 25 * 1024 * 1024

export interface VerifyPublishableConfig {
  build?: string
  checks?: ConsumerCheckConfig[]
  maxUnpackedBytes: number
  public?: string[]
}

export interface ConsumerCheckConfig {
  package: string
  runner: string
  args: string[]
  files: string[]
}

export interface PackageManifest {
  name: string
  version: string
  private?: boolean
  scripts?: Record<string, string>
  bin?: string | Record<string, string>
  exports?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

export interface DiscoveredPackage {
  dir: string
  relativeDir: string
  manifestPath: string
  manifest: PackageManifest
  name: string
  version: string
  isPublic: boolean
}

export interface RepositoryPlan {
  root: string
  rootManifest: Record<string, unknown>
  config: VerifyPublishableConfig
  packages: DiscoveredPackage[]
  publicPackages: DiscoveredPackage[]
  searched: string[]
  excluded: string[]
}

const CONFIG_KEYS = new Set(["build", "checks", "maxUnpackedBytes", "public"])
const CHECK_KEYS = new Set(["package", "runner", "args", "files"])

function describeScope(searched: string[], excluded: string[]): string {
  return `searched=${JSON.stringify(searched)} excluded=${JSON.stringify(excluded)}`
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  let source: string
  try {
    source = await Bun.file(path).text()
  } catch (error) {
    throw new Error(`required package manifest is missing: path=${path}; cause=${String(error)}`)
  }

  try {
    const value: unknown = JSON.parse(source)
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("top level must be an object")
    }
    return value as Record<string, unknown>
  } catch (error) {
    throw new Error(`invalid package manifest JSON: path=${path}; cause=${String(error)}`)
  }
}

function readConfig(manifest: Record<string, unknown>): VerifyPublishableConfig {
  const raw = manifest.verifyPublishable
  if (raw === undefined) return { maxUnpackedBytes: DEFAULT_MAX_UNPACKED_BYTES }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("verifyPublishable must be an object")
  }

  const object = raw as Record<string, unknown>
  for (const key of Object.keys(object)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`unknown verifyPublishable key: ${key}`)
  }

  const config: VerifyPublishableConfig = { maxUnpackedBytes: DEFAULT_MAX_UNPACKED_BYTES }
  if (object.build !== undefined) {
    if (typeof object.build !== "string" || object.build.trim() === "") {
      throw new Error("verifyPublishable.build must be a non-empty command string")
    }
    config.build = object.build
  }
  if (object.maxUnpackedBytes !== undefined) {
    if (!Number.isSafeInteger(object.maxUnpackedBytes) || (object.maxUnpackedBytes as number) <= 0) {
      throw new Error("verifyPublishable.maxUnpackedBytes must be a positive safe integer")
    }
    config.maxUnpackedBytes = object.maxUnpackedBytes as number
  }
  if (object.public !== undefined) {
    if (!Array.isArray(object.public) || object.public.some((name) => typeof name !== "string" || name === "")) {
      throw new Error("verifyPublishable.public must be an array of non-empty package names")
    }
    const names = object.public as string[]
    if (new Set(names).size !== names.length) throw new Error("verifyPublishable.public contains duplicate names")
    config.public = [...names].sort()
  }
  if (object.checks !== undefined) {
    if (!Array.isArray(object.checks)) throw new Error("verifyPublishable.checks must be an array")
    config.checks = object.checks.map((value, index) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`verifyPublishable.checks[${index}] must be an object`)
      }
      const check = value as Record<string, unknown>
      for (const key of Object.keys(check)) {
        if (!CHECK_KEYS.has(key)) throw new Error(`unknown verifyPublishable.checks key: index=${index} key=${key}`)
      }
      if (typeof check.package !== "string" || check.package === "") {
        throw new Error(`verifyPublishable.checks[${index}].package must be a non-empty string`)
      }
      if (typeof check.runner !== "string" || !/^[A-Za-z0-9._-]+$/.test(check.runner)) {
        throw new Error(`verifyPublishable.checks[${index}].runner must name one node_modules/.bin entry`)
      }
      if (!Array.isArray(check.args) || check.args.some((argument) => typeof argument !== "string")) {
        throw new Error(`verifyPublishable.checks[${index}].args must be a string array`)
      }
      if (
        !Array.isArray(check.files) ||
        check.files.length === 0 ||
        check.files.some((file) => typeof file !== "string" || file === "")
      ) {
        throw new Error(`verifyPublishable.checks[${index}].files must be a non-empty string array`)
      }
      for (const file of check.files as string[]) {
        const destination = resolve("/check-root", file)
        if (isAbsolute(file) || !inside("/check-root", destination)) {
          throw new Error(`verifyPublishable.checks[${index}].files must stay inside root: file=${file}`)
        }
      }
      return {
        package: check.package,
        runner: check.runner,
        args: [...(check.args as string[])],
        files: [...(check.files as string[])],
      }
    })
    const checkedPackages = config.checks.map((check) => check.package)
    if (new Set(checkedPackages).size !== checkedPackages.length) {
      throw new Error(
        `verifyPublishable.checks contains duplicate package entries: packages=${JSON.stringify(checkedPackages)}`,
      )
    }
    if (config.public === undefined) {
      throw new Error("verifyPublishable.checks requires an explicit verifyPublishable.public assertion")
    }
    for (const check of config.checks) {
      if (!config.public.includes(check.package)) {
        throw new Error(
          `verifyPublishable.checks package must be asserted public: package=${check.package} public=${JSON.stringify(config.public)}`,
        )
      }
    }
  }
  return config
}

function readWorkspacePatterns(manifest: Record<string, unknown>): string[] {
  const raw = manifest.workspaces
  if (raw === undefined) return []
  const patterns = Array.isArray(raw)
    ? raw
    : raw !== null &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        Object.keys(raw).every((key) => key === "packages")
      ? (raw as Record<string, unknown>).packages
      : undefined
  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string" || pattern === "")) {
    throw new Error(
      "package.json workspaces must be an array or { packages: [...] } of non-empty relative glob strings",
    )
  }
  return patterns as string[]
}

function isExcluded(relativeDir: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const glob = new Bun.Glob(pattern)
    return glob.match(relativeDir) || glob.match(`${relativeDir}/package.json`)
  })
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function workspaceManifests(root: string, includes: string[], excludes: string[]): Promise<string[]> {
  const paths = new Set<string>()
  for (const pattern of includes) {
    const lexicalRoot = resolve(root, pattern.split(/[!*?{[]/, 1)[0] || ".")
    if (isAbsolute(pattern) || !inside(root, lexicalRoot)) {
      throw new Error(`workspace pattern must stay inside root: pattern=${pattern} root=${root}`)
    }
    const manifestPattern = pattern.endsWith("package.json") ? pattern : `${pattern.replace(/\/$/, "")}/package.json`
    const glob = new Bun.Glob(manifestPattern)
    let matches = 0
    for await (const path of glob.scan({ cwd: root, absolute: false, onlyFiles: true, followSymlinks: false })) {
      matches += 1
      const relativeDir = dirname(path)
      if (isExcluded(relativeDir, excludes)) continue
      const canonical = await realpath(resolve(root, path))
      if (!inside(root, canonical)) {
        throw new Error(`workspace manifest escapes repository root: pattern=${pattern} path=${canonical} root=${root}`)
      }
      paths.add(canonical)
    }
    if (matches === 0) throw new Error(`workspace pattern matched no manifests: pattern=${pattern} root=${root}`)
  }
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function packageFromManifest(root: string, manifestPath: string, raw: Record<string, unknown>): DiscoveredPackage {
  if (raw.private !== undefined && typeof raw.private !== "boolean") {
    throw new Error(`package private field must be boolean: path=${manifestPath}`)
  }

  const name = raw.name
  const version = raw.version
  if (typeof name !== "string" || name === "" || typeof version !== "string" || version === "") {
    throw new Error(`package must declare non-empty name and version: path=${manifestPath}`)
  }

  const dir = dirname(manifestPath)
  return {
    dir,
    relativeDir: relative(root, dir) || ".",
    manifestPath,
    manifest: raw as PackageManifest,
    name,
    version,
    isPublic: raw.private !== true,
  }
}

export async function discoverRepository(rootInput: string): Promise<RepositoryPlan> {
  const root = resolve(rootInput)
  const rootManifestPath = join(root, "package.json")
  const rootManifest = await readJson(rootManifestPath)
  const config = readConfig(rootManifest)
  const patterns = readWorkspacePatterns(rootManifest)
  const includes = patterns.filter((pattern) => !pattern.startsWith("!"))
  const excluded = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1))
  const searched = [".", ...includes]

  const packages: DiscoveredPackage[] = []
  packages.push(packageFromManifest(root, rootManifestPath, rootManifest))
  for (const manifestPath of await workspaceManifests(root, includes, excluded)) {
    const raw = await readJson(manifestPath)
    packages.push(packageFromManifest(root, manifestPath, raw))
  }
  packages.sort((a, b) => (a.relativeDir < b.relativeDir ? -1 : a.relativeDir > b.relativeDir ? 1 : 0))

  const byName = new Map<string, string>()
  for (const pkg of packages) {
    const previous = byName.get(pkg.name)
    if (previous !== undefined) {
      throw new Error(`duplicate package name ${pkg.name}: paths=${JSON.stringify([previous, pkg.manifestPath])}`)
    }
    byName.set(pkg.name, pkg.manifestPath)
  }

  const publicPackages = packages.filter((pkg) => pkg.isPublic)
  const discoveredNames = publicPackages.map(({ name }) => name).sort()
  if (config.public !== undefined) {
    const configured = new Set(config.public)
    const notDiscovered = config.public.filter((name) => !byName.has(name))
    const configuredPrivate = config.public.filter(
      (name) => byName.has(name) && !packages.find((pkg) => pkg.name === name)!.isPublic,
    )
    const omitted = discoveredNames.filter((name) => !configured.has(name))
    const missingPublishAccess = publicPackages
      .filter((pkg) => configured.has(pkg.name))
      .filter((pkg) => {
        const publishConfig = pkg.manifest.publishConfig
        return (
          publishConfig === null ||
          typeof publishConfig !== "object" ||
          Array.isArray(publishConfig) ||
          (publishConfig as Record<string, unknown>).access !== "public"
        )
      })
      .map(({ name }) => name)
    if (
      notDiscovered.length > 0 ||
      configuredPrivate.length > 0 ||
      omitted.length > 0 ||
      missingPublishAccess.length > 0
    ) {
      throw new Error(
        `public assertion mismatch: expected=${JSON.stringify(config.public)} discovered=${JSON.stringify(discoveredNames)} notDiscovered=${JSON.stringify(notDiscovered)} private=${JSON.stringify(configuredPrivate)} omitted=${JSON.stringify(omitted)} missingPublishAccess=${JSON.stringify(missingPublishAccess)}; ${describeScope(searched, excluded)}`,
      )
    }
  }

  if (publicPackages.length === 0) {
    throw new Error(`no public packages discovered; refusing success; ${describeScope(searched, excluded)}`)
  }

  return { root, rootManifest, config, packages, publicPackages, searched, excluded }
}
