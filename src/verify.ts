import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { inspectNpmPack, packPackage, runTarballChecks, type PackedTarball } from "./artifacts.ts"
import { executeBuild, type BuildMode } from "./build.ts"
import { discoverRepository } from "./discovery.ts"
import { resolveHostTools } from "./preflight.ts"
import { probeFreshConsumer } from "./probes.ts"
import { publishTarballs } from "./publish.ts"
import { startRegistry, type RegistryHandle } from "./registry.ts"
import { withSandboxManifests } from "./sandbox.ts"
import { TOOL_SPECS, findSelfPackageRoot, resolveOwnedBin } from "./tools.ts"

const PUBLISH_BODY_OVERHEAD_BYTES = 1024 * 1024

export interface VerifyRepositoryOptions {
  root: string
  noBuild?: boolean
  keep?: boolean
}

export interface VerifiedPackageResult {
  name: string
  version: string
  unpackedSize: number
  sha256: string
  specifiers: string[]
  bins: string[]
  consumerCheckRan: boolean
}

export interface VerifyRepositoryResult {
  nodeVersion: string
  npmVersion: string
  buildMode: BuildMode
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

async function cleanupResources(registry: RegistryHandle | undefined, artifactRoot: string): Promise<unknown[]> {
  const failures: unknown[] = []
  if (registry !== undefined) {
    try {
      await registry.stop()
    } catch (error) {
      failures.push(new Error(`registry cleanup failed: url=${registry.url}; cause=${String(error)}`))
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

    for (const pkg of repository.publicPackages) {
      const tarball = packed.get(pkg.name)
      if (tarball === undefined) throw new Error(`PACK_ARTIFACT_MISSING: package=${pkg.name} packed=[]`)
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

    registry = await startRegistry({
      cwd: root,
      localPackageNames: repository.packages.map(({ name }) => name),
      maxBodySizeBytes,
      selfRoot,
      nodePath: host.nodePath,
    })
    registry.assertAlive()
    const npmrcPath = registryPath(registry, "npmrcPath")
    await publishTarballs(
      repository.packages.map((pkg) => {
        const tarball = packed.get(pkg.name)
        if (tarball === undefined) throw new Error(`PACK_ARTIFACT_MISSING: package=${pkg.name} packed=[]`)
        return { ...tarball, cwd: pkg.dir }
      }),
      {
        nodePath: host.nodePath,
        pnpm: tools.pnpm,
        registryUrl: registry.url,
        npmrcPath,
        abortSignal: registry.abortSignal,
      },
    )
    registry.assertAlive()

    const packages: VerifiedPackageResult[] = []
    for (const pkg of repository.publicPackages) {
      const tarball = packed.get(pkg.name)
      if (tarball === undefined) throw new Error(`PACK_ARTIFACT_MISSING: package=${pkg.name} packed=[]`)
      const consumerCheck = repository.config.checks?.find((check) => check.package === pkg.name)
      const probe = await probeFreshConsumer({
        package: pkg,
        registryUrl: registry.url,
        npmrcPath,
        nodePath: host.nodePath,
        npmPath: host.npmPath,
        sourceRoot: root,
        abortSignal: registry.abortSignal,
        ...(consumerCheck === undefined ? {} : { consumerCheck }),
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
        consumerCheckRan: probe.consumerCheckRan,
      })
    }

    registry.assertAlive()
    result = {
      nodeVersion: host.nodeVersion,
      npmVersion: host.npmVersion,
      buildMode: build.mode,
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

  const cleanupFailures = await cleanupResources(registry, artifactRoot)
  registry = undefined
  if (primaryError !== undefined) {
    if (cleanupFailures.length === 0) throw primaryError
    throw new AggregateError([primaryError, ...cleanupFailures], "verification and cleanup both failed")
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0]
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "verification cleanup failed")
  return result!
}
