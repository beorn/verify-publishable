import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

export interface ExpectedArtifact {
  name: string
  version: string
  /** Subresource integrity of the tarball the publish phase uploaded: `sha512-<base64>`. */
  integrity: string
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>

/** The `dist.integrity` npm records for these tarball bytes. */
export async function tarballIntegrity(tarballPath: string): Promise<string> {
  return `sha512-${createHash("sha512")
    .update(await readFile(tarballPath))
    .digest("base64")}`
}

function metadataUrl(registryUrl: string, name: string): string {
  return `${registryUrl.replace(/\/$/, "")}/${name.replace("/", "%2f")}`
}

/**
 * Refuse unless the probe-phase registry serves, for every local package, the integrity the publish phase produced.
 *
 * npm verifies a downloaded tarball against the `dist.integrity` in this same metadata, so equality here is what makes
 * "the probe installs the local bytes" a checked fact rather than Verdaccio's claim that local storage wins over its
 * uplink. A same-version tarball with other bytes (the uplink's, for a version that is also on npmjs) refuses by name
 * with both hashes instead of letting the probe judge bytes nobody packed.
 */
export async function assertServedIntegrity(
  registryUrl: string,
  expected: readonly ExpectedArtifact[],
  fetchImpl: Fetch = fetch,
): Promise<void> {
  if (expected.length === 0) throw new Error("SERVED_INTEGRITY_INPUT_EMPTY: queried=local artifacts result=[]")
  for (const artifact of expected) {
    const url = metadataUrl(registryUrl, artifact.name)
    const response = await fetchImpl(url, { headers: { accept: "application/json" } })
    if (!response.ok) {
      throw new Error(
        `LOCAL_ARTIFACT_NOT_SERVED: package=${artifact.name}@${artifact.version} url=${JSON.stringify(url)} status=${response.status}`,
      )
    }
    const metadata = (await response.json()) as { versions?: Record<string, { dist?: { integrity?: unknown } }> }
    const served = metadata.versions?.[artifact.version]?.dist?.integrity
    if (typeof served !== "string") {
      throw new Error(
        `LOCAL_ARTIFACT_NOT_SERVED: package=${artifact.name}@${artifact.version} url=${JSON.stringify(url)} served versions=${JSON.stringify(Object.keys(metadata.versions ?? {}))}`,
      )
    }
    if (served !== artifact.integrity) {
      throw new Error(
        `LOCAL_ARTIFACT_CONTRADICTED: package=${artifact.name}@${artifact.version} local=${artifact.integrity} served=${served}; the probe registry would install bytes the publish phase did not produce`,
      )
    }
  }
}
