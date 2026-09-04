import { readFile, writeFile } from "node:fs/promises"

import type { DiscoveredPackage } from "./discovery.ts"

interface ManifestMutation {
  package: string
  path: string
  original: string
  replacement: string
}

async function prepareMutation(pkg: DiscoveredPackage): Promise<ManifestMutation | null> {
  if (pkg.isPublic) return null
  const original = await readFile(pkg.manifestPath, "utf8")
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(original) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `sandbox manifest became invalid after discovery: package=${pkg.name} path=${pkg.manifestPath}; ${String(error)}`,
    )
  }
  const rawPublishConfig = manifest.publishConfig
  if (
    rawPublishConfig !== undefined &&
    (rawPublishConfig === null || typeof rawPublishConfig !== "object" || Array.isArray(rawPublishConfig))
  ) {
    throw new Error(`sandbox publishConfig must be an object: package=${pkg.name} path=${pkg.manifestPath}`)
  }
  delete manifest.private
  manifest.publishConfig = { ...(rawPublishConfig as Record<string, unknown> | undefined), access: "public" }
  return {
    package: pkg.name,
    path: pkg.manifestPath,
    original,
    replacement: `${JSON.stringify(manifest, null, 2)}\n`,
  }
}

export async function withSandboxManifests<T>(packages: DiscoveredPackage[], task: () => Promise<T>): Promise<T> {
  const mutations = (await Promise.all(packages.map(prepareMutation))).filter(
    (mutation): mutation is ManifestMutation => mutation !== null,
  )
  const written: ManifestMutation[] = []
  let primaryError: unknown
  let value: T | undefined
  try {
    for (const mutation of mutations) {
      written.push(mutation)
      await writeFile(mutation.path, mutation.replacement)
    }
    value = await task()
  } catch (error) {
    primaryError = error
  }

  const restorationErrors: Error[] = []
  for (const mutation of written.reverse()) {
    try {
      await writeFile(mutation.path, mutation.original)
    } catch (error) {
      restorationErrors.push(
        new Error(
          `manifest restoration failed: package=${mutation.package} path=${mutation.path}; cause=${String(error)}`,
        ),
      )
    }
  }

  if (primaryError !== undefined && restorationErrors.length > 0) {
    throw new AggregateError([primaryError, ...restorationErrors], "sandbox task and manifest restoration both failed")
  }
  if (primaryError !== undefined) throw primaryError
  if (restorationErrors.length > 0) throw new AggregateError(restorationErrors, "manifest restoration failed")
  return value as T
}
