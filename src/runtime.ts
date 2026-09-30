/**
 * Which runtimes a package manifest promises, read from its engines. This is the one home of the rule: the consumer
 * probes run under what it returns, and a component's build applies binShebangRuntime to its packed bins
 * (hh #26691, @cto 367553a9, 7c231396, d7f039e2). The verifier never writes the artifacts it verifies; it exports the
 * rule, and the build step applies it.
 */

export type ProbeRuntimeName = "node" | "bun"

/** One runtime the consumer probes ran under, its reported version, and why the manifest selected it. */
export interface ProbeRuntime {
  runtime: ProbeRuntimeName
  version: string
  reason: string
}

function declaredEngines(engines: unknown): { node: boolean; bun: boolean; present: boolean } {
  if (engines === undefined) return { node: false, bun: false, present: false }
  if (engines === null || typeof engines !== "object" || Array.isArray(engines)) {
    return { node: false, bun: false, present: true }
  }
  const declared = engines as Record<string, unknown>
  return { node: typeof declared.node === "string", bun: typeof declared.bun === "string", present: true }
}

/**
 * The runtimes a manifest promises, from its engines: node alone keeps Node 24, bun alone is probed under Bun, both
 * are both probed, and neither keeps Node 24. A probe proves a promise the manifest makes, never one it does not.
 */
export function probeRuntimesFor(engines: unknown): Array<{ runtime: ProbeRuntimeName; reason: string }> {
  const { node, bun } = declaredEngines(engines)
  if (node && bun) {
    return [
      { runtime: "node", reason: "engines declares node and bun" },
      { runtime: "bun", reason: "engines declares node and bun" },
    ]
  }
  if (bun) return [{ runtime: "bun", reason: "engines declares bun only" }]
  if (node) return [{ runtime: "node", reason: "engines declares node only" }]
  return [{ runtime: "node", reason: "engines declares no runtime" }]
}

/**
 * The interpreter a packed bin's shebang names: node when the manifest declares node (with or without bun), since a
 * Bun user can opt into Bun and a Node user cannot opt into Bun; bun when it declares bun alone; node when it declares
 * no engines. An engines value that names neither runtime refuses by name rather than guessing.
 */
export function binShebangRuntime(engines: unknown): ProbeRuntimeName {
  const { node, bun, present } = declaredEngines(engines)
  if (node) return "node"
  if (bun) return "bun"
  if (!present) return "node"
  throw new Error(
    `ENGINES_RUNTIME_UNKNOWN: engines=${JSON.stringify(engines)} declares neither node nor bun, so no bin runtime is promised`,
  )
}
