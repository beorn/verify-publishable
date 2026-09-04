import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { gunzipSync } from "node:zlib"

import { runCommand, type CommandResult, type CommandSpec } from "./process.ts"
import type { ResolvedTool } from "./tools.ts"

export interface ArtifactPackage {
  dir: string
  name: string
  version: string
}

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>

export interface NpmPackRecord {
  filename: string
  maxUnpackedBytes: number
  name: string
  unpackedSize: number
  version: string
}

export interface PackedTarball {
  name: string
  tarballPath: string
  version: string
}

export interface TarballCheckResults {
  attw: CommandResult
  publint: CommandResult
}

const TAR_BLOCK_BYTES = 512
const MAX_INSPECTED_ARCHIVE_BYTES = 512 * 1024 * 1024

function requireAbsolutePath(label: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute: actual=${JSON.stringify(path)}`)
}

function requirePackagePaths(pkg: ArtifactPackage): void {
  requireAbsolutePath("package directory", pkg.dir)
}

function invalidNpmResult(pkg: ArtifactPackage, reason: string, stdout: string): Error {
  return new Error(
    `invalid npm pack --dry-run result: package=${JSON.stringify(pkg.name)} cwd=${JSON.stringify(pkg.dir)}; ${reason}; stdout=${JSON.stringify(stdout)}`,
  )
}

export async function inspectNpmPack(
  pkg: ArtifactPackage,
  options: {
    maxUnpackedBytes: number
    nodePath: string
    npmCliPath: string
    run?: CommandRunner
  },
): Promise<NpmPackRecord> {
  requirePackagePaths(pkg)
  requireAbsolutePath("nodePath", options.nodePath)
  requireAbsolutePath("npmCliPath", options.npmCliPath)
  if (!Number.isSafeInteger(options.maxUnpackedBytes) || options.maxUnpackedBytes <= 0) {
    throw new Error(
      `maxUnpackedBytes must be a positive safe integer: actual=${JSON.stringify(options.maxUnpackedBytes)}`,
    )
  }

  const result = await (options.run ?? runCommand)({
    phase: `npm-pack-dry-run:${pkg.name}`,
    command: options.nodePath,
    // The repository build phase has already produced the artifact inputs.
    // Suppress lifecycle scripts here so chatty prepack output cannot corrupt
    // npm's otherwise machine-readable JSON response.
    args: [options.npmCliPath, "pack", "--dry-run", "--json", "--ignore-scripts"],
    cwd: pkg.dir,
    // npm 11 enforces a repository's devEngines.packageManager even for this
    // deliberately npm-owned artifact inspection. Override that authoring-tool
    // check only for pack: consumer installs keep npm's peer resolution strict.
    env: { npm_config_force: "true" },
  })
  if (result.stdout.trim() === "") throw invalidNpmResult(pkg, "empty stdout", result.stdout)

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw invalidNpmResult(pkg, "malformed JSON", result.stdout)
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    const count = Array.isArray(parsed) ? parsed.length : "not-an-array"
    throw invalidNpmResult(pkg, `expected exactly one result; actual=${count}`, result.stdout)
  }

  const raw: unknown = parsed[0]
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidNpmResult(pkg, "result must be an object", result.stdout)
  }
  const { filename, unpackedSize } = raw as Record<string, unknown>
  if (typeof unpackedSize !== "number" || !Number.isSafeInteger(unpackedSize) || unpackedSize < 0) {
    throw invalidNpmResult(pkg, `invalid unpackedSize: actual=${JSON.stringify(unpackedSize)}`, result.stdout)
  }
  if (unpackedSize > options.maxUnpackedBytes) {
    throw new Error(
      `npm package exceeds unpacked-size limit: package=${JSON.stringify(pkg.name)} cwd=${JSON.stringify(pkg.dir)} unpackedSize=${unpackedSize} maxUnpackedBytes=${options.maxUnpackedBytes}`,
    )
  }
  if (typeof filename !== "string" || filename === "") {
    throw invalidNpmResult(pkg, `invalid filename: actual=${JSON.stringify(filename)}`, result.stdout)
  }

  return {
    filename,
    maxUnpackedBytes: options.maxUnpackedBytes,
    name: pkg.name,
    unpackedSize,
    version: pkg.version,
  }
}

function pathIsInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function listTarballs(destination: string, pkg: ArtifactPackage): string[] {
  try {
    return readdirSync(destination, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
      .map((entry) => resolve(destination, entry.name))
      .sort((a, b) => a.localeCompare(b))
  } catch (error) {
    throw new Error(
      `cannot inspect pnpm pack destination: package=${JSON.stringify(pkg.name)} destination=${JSON.stringify(destination)} cause=${String(error)}`,
    )
  }
}

function invalidPnpmResult(pkg: ArtifactPackage, reason: string, stdout: string): Error {
  return new Error(
    `invalid pnpm pack --json result: package=${JSON.stringify(pkg.name)} cwd=${JSON.stringify(pkg.dir)}; ${reason}; stdout=${JSON.stringify(stdout)}`,
  )
}

function tarString(block: Buffer, offset: number, length: number): string {
  const end = block.indexOf(0, offset)
  return block.subarray(offset, end === -1 || end > offset + length ? offset + length : end).toString("utf8")
}

function tarEntrySize(block: Buffer, pkg: ArtifactPackage, tarballPath: string): number {
  const raw = tarString(block, 124, 12).trim()
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(
      `packed tarball has an invalid entry size: package=${JSON.stringify(pkg.name)} tarballPath=${JSON.stringify(tarballPath)} raw=${JSON.stringify(raw)}`,
    )
  }
  const size = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(size)) {
    throw new Error(
      `packed tarball entry is too large to inspect safely: package=${JSON.stringify(pkg.name)} tarballPath=${JSON.stringify(tarballPath)} raw=${JSON.stringify(raw)}`,
    )
  }
  return size
}

function packedManifest(pkg: ArtifactPackage, tarballPath: string): Record<string, unknown> {
  let archive: Buffer
  try {
    archive = gunzipSync(readFileSync(tarballPath), { maxOutputLength: MAX_INSPECTED_ARCHIVE_BYTES })
  } catch (error) {
    throw new Error(
      `cannot decompress packed tarball for identity verification: package=${JSON.stringify(pkg.name)} tarballPath=${JSON.stringify(tarballPath)} maxOutputBytes=${MAX_INSPECTED_ARCHIVE_BYTES} cause=${String(error)}`,
    )
  }

  const manifests: Buffer[] = []
  for (let offset = 0; offset + TAR_BLOCK_BYTES <= archive.byteLength; ) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES)
    if (header.every((byte) => byte === 0)) break
    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const path = prefix === "" ? name : `${prefix}/${name}`
    const size = tarEntrySize(header, pkg, tarballPath)
    const dataStart = offset + TAR_BLOCK_BYTES
    const dataEnd = dataStart + size
    if (dataEnd > archive.byteLength) {
      throw new Error(
        `packed tarball entry is truncated: package=${JSON.stringify(pkg.name)} tarballPath=${JSON.stringify(tarballPath)} entry=${JSON.stringify(path)} size=${size}`,
      )
    }
    const type = String.fromCharCode(header[156] ?? 0)
    if (path === "package/package.json" && (type === "\0" || type === "0")) {
      manifests.push(archive.subarray(dataStart, dataEnd))
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
  }

  if (manifests.length !== 1) {
    throw new Error(
      `packed tarball must contain exactly one package/package.json: package=${JSON.stringify(pkg.name)} tarballPath=${JSON.stringify(tarballPath)} actual=${manifests.length}`,
    )
  }
  try {
    const value: unknown = JSON.parse(manifests[0]!.toString("utf8"))
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("top level must be an object")
    }
    return value as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `packed package/package.json is invalid: package=${JSON.stringify(pkg.name)} tarballPath=${JSON.stringify(tarballPath)} cause=${String(error)}`,
    )
  }
}

export async function packPackage(
  pkg: ArtifactPackage,
  options: {
    destination: string
    nodePath: string
    pnpm: ResolvedTool
    run?: CommandRunner
  },
): Promise<PackedTarball> {
  requirePackagePaths(pkg)
  requireAbsolutePath("destination", options.destination)
  requireAbsolutePath("nodePath", options.nodePath)
  requireAbsolutePath("pnpm.binPath", options.pnpm.binPath)

  const before = new Set(listTarballs(options.destination, pkg))
  const result = await (options.run ?? runCommand)({
    phase: `pnpm-pack:${pkg.name}`,
    command: options.nodePath,
    args: [
      options.pnpm.binPath,
      "pack",
      "--json",
      "--config.ignore-scripts=true",
      "--pack-destination",
      options.destination,
    ],
    cwd: pkg.dir,
  })
  if (result.stdout.trim() === "") throw invalidPnpmResult(pkg, "empty stdout", result.stdout)

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw invalidPnpmResult(pkg, "malformed JSON", result.stdout)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidPnpmResult(pkg, "result must be an object", result.stdout)
  }
  const { filename, name, version } = parsed as Record<string, unknown>
  if (name !== pkg.name || version !== pkg.version) {
    throw new Error(
      `packed manifest identity mismatch: actual=${JSON.stringify({ name, version })} expected=${JSON.stringify({ name: pkg.name, version: pkg.version })} cwd=${JSON.stringify(pkg.dir)}`,
    )
  }
  if (typeof filename !== "string" || !isAbsolute(filename)) {
    throw invalidPnpmResult(pkg, `filename must be an absolute path: actual=${JSON.stringify(filename)}`, result.stdout)
  }

  const destination = resolve(options.destination)
  const tarballPath = resolve(filename)
  if (!pathIsInside(destination, tarballPath)) {
    throw new Error(
      `pnpm pack reported a tarball outside its destination: package=${JSON.stringify(pkg.name)} destination=${JSON.stringify(destination)} tarballPath=${JSON.stringify(tarballPath)}`,
    )
  }
  if (!tarballPath.endsWith(".tgz")) {
    throw new Error(
      `pnpm pack reported a non-tarball path: package=${JSON.stringify(pkg.name)} tarballPath=${JSON.stringify(tarballPath)}`,
    )
  }
  if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
    throw new Error(
      `pnpm pack reported tarball is missing: package=${JSON.stringify(pkg.name)} tarballPath=${JSON.stringify(tarballPath)}`,
    )
  }

  const added = listTarballs(destination, pkg).filter((path) => !before.has(path))
  if (added.length !== 1) {
    throw new Error(
      `pnpm pack expected exactly one new .tgz: package=${JSON.stringify(pkg.name)} destination=${JSON.stringify(destination)} actual=${added.length} added=${JSON.stringify(added)}`,
    )
  }
  if (added[0] !== tarballPath) {
    throw new Error(
      `pnpm pack output disagrees with created tarball: package=${JSON.stringify(pkg.name)} reported=${JSON.stringify(tarballPath)} created=${JSON.stringify(added[0])}`,
    )
  }

  const manifest = packedManifest(pkg, tarballPath)
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
    throw new Error(
      `packed tarball manifest identity mismatch: actual=${JSON.stringify({ name: manifest.name, version: manifest.version })} expected=${JSON.stringify({ name: pkg.name, version: pkg.version })} tarballPath=${JSON.stringify(tarballPath)}`,
    )
  }

  return { name: pkg.name, tarballPath, version: pkg.version }
}

export async function runTarballChecks(
  pkg: ArtifactPackage,
  options: {
    attw: ResolvedTool
    nodePath: string
    publint: ResolvedTool
    run?: CommandRunner
    tarballPath: string
  },
): Promise<TarballCheckResults> {
  requirePackagePaths(pkg)
  requireAbsolutePath("nodePath", options.nodePath)
  requireAbsolutePath("publint.binPath", options.publint.binPath)
  requireAbsolutePath("attw.binPath", options.attw.binPath)
  requireAbsolutePath("tarballPath", options.tarballPath)
  if (!existsSync(options.tarballPath) || !statSync(options.tarballPath).isFile()) {
    throw new Error(
      `required tarball is missing: package=${JSON.stringify(pkg.name)} tarballPath=${JSON.stringify(options.tarballPath)}`,
    )
  }

  const run = options.run ?? runCommand
  const publint = await run({
    phase: `publint:${pkg.name}`,
    command: options.nodePath,
    args: [options.publint.binPath, options.tarballPath, "--strict"],
    cwd: pkg.dir,
  })
  const attw = await run({
    phase: `attw:${pkg.name}`,
    command: options.nodePath,
    args: [
      options.attw.binPath,
      options.tarballPath,
      "--profile",
      "node16",
      "--ignore-rules",
      "cjs-resolves-to-esm",
      "--format",
      "table",
      "--no-color",
    ],
    cwd: pkg.dir,
  })
  return { attw, publint }
}
