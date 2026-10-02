import { createHash } from "node:crypto"
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import { inspectNpmPack, packPackage, runTarballChecks, type PackedTarball } from "./artifacts.ts"
import { executeBuild, readLiveOutputLoss, type BuildMode, type LiveOutputLoss } from "./build.ts"
import { discoverRepository, type PackageManifest } from "./discovery.ts"
import { assertPackShape } from "./pack-shape.ts"
import { resolveHostTools } from "./preflight.ts"
import { probeFreshConsumer, type ProbeRuntime } from "./probes.ts"
import type { BinRuntimeRow } from "./runtime.ts"
import { publishTarballs } from "./publish.ts"
import { startRegistry, type RegistryHandle } from "./registry.ts"
import { assertServedIntegrity, tarballIntegrity } from "./served-integrity.ts"
import { withSandboxManifests } from "./sandbox.ts"
import { TOOL_SPECS, findSelfPackageRoot, resolveOwnedBin } from "./tools.ts"

const PUBLISH_BODY_OVERHEAD_BYTES = 1024 * 1024

export interface VerifyRepositoryOptions {
  root: string
  noBuild?: boolean
  keep?: boolean
  outputDir?: string
}

export interface VerifiedPackageResult {
  name: string
  version: string
  unpackedSize: number
  sha256: string
  tarballPath?: string
  sha512?: string
  specifiers: string[]
  bins: string[]
  /** Per bin and runtime: whether its --help ran there, or was not asked and why (hh #27074). */
  binRuntimes: BinRuntimeRow[]
  consumerCheckRan: boolean
  /** The runtimes the consumer probes ran under, each with its version and the engines reason that selected it. */
  runtimes: ProbeRuntime[]
}

export interface VerifyRepositoryResult {
  nodePath: string
  nodeVersion: string
  npmVersion: string
  buildMode: BuildMode
  liveOutput?: LiveOutputLoss
  packages: VerifiedPackageResult[]
  kept?: {
    artifactRoot: string
    registryPid: number | null
    registryUrl: string | null
    registryStateRoot: string | null
    npmrcPath: string | null
  }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

async function requireEmptyOutputDirectory(path: string): Promise<string> {
  let directory: string
  try {
    directory = await realpath(path)
  } catch (error) {
    throw new Error(`ARTIFACT_OUTPUT_MISSING: path=${JSON.stringify(path)} cause=${String(error)}`)
  }
  if (!(await stat(directory)).isDirectory()) {
    throw new Error(`ARTIFACT_OUTPUT_NOT_DIRECTORY: path=${JSON.stringify(path)}`)
  }
  const entries = await readdir(directory)
  if (entries.length > 0) {
    throw new Error(`ARTIFACT_OUTPUT_NOT_EMPTY: path=${JSON.stringify(path)} entries=${JSON.stringify(entries)}`)
  }
  return directory
}

async function removeOutputFiles(paths: readonly string[]): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const path of paths) {
    try {
      await rm(path)
    } catch (error) {
      failures.push(new Error(`artifact output cleanup failed: path=${path}; cause=${String(error)}`))
    }
  }
  return failures
}

async function retainVerifiedFiles(
  outputDir: string,
  packages: VerifiedPackageResult[],
  packed: ReadonlyMap<string, PackedTarball>,
  created: string[],
): Promise<void> {
  await requireEmptyOutputDirectory(outputDir)
  for (const [index, pkg] of packages.entries()) {
    const tarball = packed.get(pkg.name)
    if (tarball === undefined) throw new Error(`PACK_ARTIFACT_MISSING: package=${pkg.name} packed=[]`)
    const destination = join(outputDir, `${String(index).padStart(4, "0")}-${basename(tarball.tarballPath)}`)
    const file = await open(destination, "wx")
    created.push(destination)
    try {
      await file.writeFile(await readFile(tarball.tarballPath))
    } finally {
      await file.close()
    }
    const sourceIntegrity = await tarballIntegrity(tarball.tarballPath)
    const retainedIntegrity = await tarballIntegrity(destination)
    if (sourceIntegrity !== retainedIntegrity) {
      throw new Error(
        `ARTIFACT_OUTPUT_CONTRADICTED: package=${pkg.name} source=${sourceIntegrity} retained=${retainedIntegrity}`,
      )
    }
    pkg.tarballPath = destination
    pkg.sha512 = retainedIntegrity
  }
}

async function cleanupResources(
  registry: RegistryHandle | undefined,
  artifactRoot: string,
  afterStop?: () => Promise<void>,
): Promise<unknown[]> {
  const failures: unknown[] = []
  if (registry !== undefined) {
    try {
      await registry.stop()
    } catch (error) {
      failures.push(new Error(`registry cleanup failed: url=${registry.url}; cause=${String(error)}`))
    }
  }
  if (failures.length === 0 && afterStop !== undefined) {
    try {
      await afterStop()
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    await rm(artifactRoot, { recursive: true, force: true })
  } catch (error) {
    failures.push(new Error(`artifact cleanup failed: path=${artifactRoot}; cause=${String(error)}`))
  }
  return failures
}

function registryPath(registry: RegistryHandle, key: "npmrcPath" | "stateRoot"): string {
  const value = registry[key]
  if (value === undefined) {
    throw new Error(`REGISTRY_RESOURCE_MISSING: resource=${key} registry=${registry.url}`)
  }
  return value
}

export async function verifyRepository(options: VerifyRepositoryOptions): Promise<VerifyRepositoryResult> {
  const root = await realpath(options.root)
  if (options.keep && options.outputDir !== undefined) {
    throw new Error("ARTIFACT_OUTPUT_KEEP_CONFLICT: --keep and --output-dir cannot be combined")
  }
  const outputDir = options.outputDir === undefined ? undefined : await requireEmptyOutputDirectory(options.outputDir)
  const repository = await discoverRepository(root)
  const host = await resolveHostTools(root)
  const selfRoot = findSelfPackageRoot(fileURLToPath(import.meta.url))
  const tools = {
    pnpm: resolveOwnedBin(selfRoot, TOOL_SPECS.pnpm),
    publint: resolveOwnedBin(selfRoot, TOOL_SPECS.publint),
    attw: resolveOwnedBin(selfRoot, TOOL_SPECS.attw),
  }
  const build = await executeBuild(repository, { noBuild: options.noBuild ?? false })
  const artifactRoot = await mkdtemp(join(tmpdir(), "verify-publishable-artifacts-"))
  let registry: RegistryHandle | undefined
  let result: VerifyRepositoryResult | undefined
  let primaryError: unknown
  let packedArtifacts: ReadonlyMap<string, PackedTarball> | undefined

  try {
    const sizes = new Map<string, number>()
    for (const pkg of repository.publicPackages) {
      const record = await inspectNpmPack(pkg, {
        maxUnpackedBytes: repository.config.maxUnpackedBytes,
        nodePath: host.nodePath,
        npmCliPath: host.npmPath,
      })
      sizes.set(pkg.name, record.unpackedSize)
    }

    const packed = await withSandboxManifests(repository.packages, async () => {
      const results = new Map<string, PackedTarball>()
      for (const [index, pkg] of repository.packages.entries()) {
        const destination = join(artifactRoot, String(index).padStart(4, "0"))
        await mkdir(destination)
        results.set(pkg.name, await packPackage(pkg, { destination, nodePath: host.nodePath, pnpm: tools.pnpm }))
      }
      return results
    })
    packedArtifacts = packed

    for (const pkg of repository.publicPackages) {
      const tarball = packed.get(pkg.name)
      if (tarball === undefined) throw new Error(`PACK_ARTIFACT_MISSING: package=${pkg.name} packed=[]`)
      assertPackShape(pkg.name, tarball.artifact)
      await runTarballChecks(pkg, {
        attw: tools.attw,
        nodePath: host.nodePath,
        publint: tools.publint,
        tarballPath: tarball.tarballPath,
      })
    }

    const packedSizes = await Promise.all([...packed.values()].map(({ tarballPath }) => stat(tarballPath)))
    const largestPackedBytes = Math.max(...packedSizes.map(({ size }) => size))
    const maxBodySizeBytes = largestPackedBytes * 2 + PUBLISH_BODY_OVERHEAD_BYTES
    if (!Number.isSafeInteger(maxBodySizeBytes)) {
      throw new Error(
        `derived Verdaccio body limit is not a safe integer: largestPackedBytes=${largestPackedBytes} maxBodySizeBytes=${maxBodySizeBytes}`,
      )
    }

    const registryOptions = {
      cwd: root,
      localPackageNames: repository.packages.map(({ name }) => name),
      maxBodySizeBytes,
      selfRoot,
      nodePath: host.nodePath,
    }
    const publishRegistry = await startRegistry({ ...registryOptions, phase: "publish" })
    registry = publishRegistry
    registry.assertAlive()
    await publishTarballs(
      repository.packages.map((pkg) => {
        const tarball = packed.get(pkg.name)
        if (tarball === undefined) throw new Error(`PACK_ARTIFACT_MISSING: package=${pkg.name} packed=[]`)
        return { ...tarball, cwd: pkg.dir }
      }),
      {
        nodePath: host.nodePath,
        pnpm: tools.pnpm,
        registryUrl: publishRegistry.url,
        npmrcPath: publishRegistry.npmrcPath,
        abortSignal: publishRegistry.abortSignal,
      },
    )
    publishRegistry.assertAlive()

    // The probes need the npmjs proxy for prior versions of local packages; the publish could not have it.
    const probeRegistry = await startRegistry({
      ...registryOptions,
      phase: "probe",
      stateRoot: await publishRegistry.handoff(),
    })
    registry = probeRegistry
    probeRegistry.assertAlive()
    const npmrcPath = probeRegistry.npmrcPath
    await assertServedIntegrity(
      probeRegistry.url,
      await Promise.all(
        repository.packages.map(async (pkg) => {
          const tarball = packed.get(pkg.name)
          if (tarball === undefined) throw new Error(`PACK_ARTIFACT_MISSING: package=${pkg.name} packed=[]`)
          return { name: pkg.name, version: pkg.version, integrity: await tarballIntegrity(tarball.tarballPath) }
        }),
      ),
    )

    const packages: VerifiedPackageResult[] = []
    for (const pkg of repository.publicPackages) {
      const tarball = packed.get(pkg.name)
      if (tarball === undefined) throw new Error(`PACK_ARTIFACT_MISSING: package=${pkg.name} packed=[]`)
      const consumerCheck = repository.config.checks?.find((check) => check.package === pkg.name)
      const bunOnlyBins = repository.config.bunOnlyBins?.filter((declaration) => declaration.package === pkg.name)
      const probe = await probeFreshConsumer({
        package: pkg,
        packedManifest: tarball.artifact.manifest as PackageManifest,
        registryUrl: registry.url,
        npmrcPath,
        nodePath: host.nodePath,
        ...(host.bunPath === null ? {} : { bunPath: host.bunPath }),
        npmPath: host.npmPath,
        sourceRoot: root,
        abortSignal: registry.abortSignal,
        ...(consumerCheck === undefined ? {} : { consumerCheck }),
        ...(bunOnlyBins === undefined || bunOnlyBins.length === 0 ? {} : { bunOnlyBins }),
      })
      registry.assertAlive()
      const unpackedSize = sizes.get(pkg.name)
      if (unpackedSize === undefined) {
        throw new Error(`SIZE_RESULT_MISSING: package=${pkg.name} queried=publicPackages result=[]`)
      }
      packages.push({
        name: pkg.name,
        version: pkg.version,
        unpackedSize,
        sha256: await sha256(tarball.tarballPath),
        specifiers: probe.specifiers,
        bins: probe.bins,
        binRuntimes: probe.binRuntimes,
        consumerCheckRan: probe.consumerCheckRan,
        runtimes: probe.runtimes,
      })
    }

    registry.assertAlive()
    const liveOutput = readLiveOutputLoss()
    result = {
      nodePath: host.nodePath,
      nodeVersion: host.nodeVersion,
      npmVersion: host.npmVersion,
      buildMode: build.mode,
      ...(liveOutput === undefined ? {} : { liveOutput }),
      packages,
    }
  } catch (error) {
    primaryError = error
  }

  if (options.keep === true) {
    const kept = {
      artifactRoot,
      registryPid: registry?.pid ?? null,
      registryUrl: registry?.url ?? null,
      registryStateRoot: registry === undefined ? null : registryPath(registry, "stateRoot"),
      npmrcPath: registry === undefined ? null : registryPath(registry, "npmrcPath"),
    }
    if (primaryError !== undefined) {
      throw new AggregateError(
        [
          primaryError,
          new Error(
            `KEEP_PRESERVED: artifactRoot=${JSON.stringify(kept.artifactRoot)} registryPid=${kept.registryPid} registryUrl=${JSON.stringify(kept.registryUrl)} registryStateRoot=${JSON.stringify(kept.registryStateRoot)} npmrcPath=${JSON.stringify(kept.npmrcPath)}`,
          ),
        ],
        "verification failed; temporary resources were preserved because --keep was set",
      )
    }
    return { ...result!, kept }
  }

  const createdOutputFiles: string[] = []
  const cleanupFailures = await cleanupResources(
    registry,
    artifactRoot,
    outputDir !== undefined && primaryError === undefined
      ? async () => {
          if (result === undefined || packedArtifacts === undefined) {
            throw new Error("ARTIFACT_OUTPUT_RESULT_MISSING: verification completed without package results")
          }
          await retainVerifiedFiles(outputDir, result.packages, packedArtifacts, createdOutputFiles)
        }
      : undefined,
  )
  if (cleanupFailures.length > 0 && createdOutputFiles.length > 0) {
    cleanupFailures.push(...(await removeOutputFiles(createdOutputFiles)))
  }
  registry = undefined
  if (primaryError !== undefined) {
    if (cleanupFailures.length === 0) throw primaryError
    throw new AggregateError([primaryError, ...cleanupFailures], "verification and cleanup both failed")
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0]
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "verification cleanup failed")
  return result!
}
