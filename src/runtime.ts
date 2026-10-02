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

/** A first line naming Bun as the interpreter: `#!/usr/bin/env bun`, `#!/path/to/bun`, with or without env flags. */
export const BUN_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?bun(?:\s|$)/

/**
 * A packed bin the manifest declares Bun-only although its engines promise node (`verifyPublishable.bunOnlyBins`,
 * hh #27074, @cto 240b6f1e): the library imports from Node, and this CLI runs under Bun. The reason is required.
 */
export interface BunOnlyBin {
  package: string
  bin: string
  reason: string
}

/** One runtime's verdict on one packed bin's `--help`: run it there, or record that it was not asked and why. */
export interface BinRuntimeRow {
  bin: string
  runtime: ProbeRuntimeName
  action: "run" | "not-asked"
  reason: string
}

/**
 * Which runtimes run a packed bin's `--help`, the one rule both the hosted gate and hh's local release verify apply.
 * Undeclared: every runtime the engines select runs it, and a Bun shebang under engines.node is refused, since a Node
 * user cannot opt into Bun. Declared Bun-only: Bun runs it and the Node row reads "not asked: bin declared Bun-only";
 * the declaration is refused when engines declares no bun (nothing runs it) or no node (it is redundant).
 */
export function binRuntimePlan(input: {
  engines: unknown
  bin: string
  shebang: string
  bunOnly?: BunOnlyBin
}): { rows: BinRuntimeRow[] } | { refused: string } {
  const { node, bun } = declaredEngines(input.engines)
  const selected = probeRuntimesFor(input.engines)
  if (input.bunOnly !== undefined) {
    if (!bun) {
      return {
        refused: `bin ${input.bin} is declared Bun-only (${input.bunOnly.reason}), but engines=${JSON.stringify(input.engines)} declares no bun, so nothing would run it`,
      }
    }
    if (!node) {
      return {
        refused: `bin ${input.bin} is declared Bun-only, but engines=${JSON.stringify(input.engines)} declares bun and no node, so it is already judged under Bun; remove it from verifyPublishable.bunOnlyBins`,
      }
    }
    return {
      rows: selected.map(({ runtime }) =>
        runtime === "node"
          ? { bin: input.bin, runtime, action: "not-asked", reason: "not asked: bin declared Bun-only" }
          : { bin: input.bin, runtime, action: "run", reason: `bin declared Bun-only: ${input.bunOnly!.reason}` },
      ),
    }
  }
  if (node && BUN_SHEBANG.test(input.shebang)) {
    return {
      refused: `engines declares node, but bin ${input.bin} runs under Bun: shebang=${JSON.stringify(input.shebang)}; ship a Node-runnable bin, or declare it in verifyPublishable.bunOnlyBins with a reason`,
    }
  }
  return { rows: selected.map(({ runtime, reason }) => ({ bin: input.bin, runtime, action: "run", reason })) }
}
