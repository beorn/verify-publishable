/**
 * @failure A packed bin's shebang or a consumer probe's runtime disagrees with the runtimes the manifest's engines promise.
 * @level l1
 * @consumer the consumer probes, and each component's build step that stamps packed bins (hh #26691)
 */

import { describe, expect, test } from "vitest"

import { binShebangRuntime, probeRuntimesFor } from "../src/runtime.ts"

describe("the runtimes a manifest's engines promise", () => {
  test("a bin runs under node when node is declared, with or without bun", () => {
    expect(binShebangRuntime({ node: ">=24" })).toBe("node")
    expect(binShebangRuntime({ node: ">=24", bun: ">=1.3" })).toBe("node")
  })

  test("a bin runs under bun when bun alone is declared", () => {
    expect(binShebangRuntime({ bun: ">=1.3" })).toBe("bun")
  })

  test("a manifest with no engines keeps node", () => {
    expect(binShebangRuntime(undefined)).toBe("node")
  })

  test("engines that name neither runtime refuse by name", () => {
    expect(() => binShebangRuntime({ npm: ">=10" })).toThrow(/ENGINES_RUNTIME_UNKNOWN: engines=\{"npm":">=10"\}/)
    expect(() => binShebangRuntime({})).toThrow(/ENGINES_RUNTIME_UNKNOWN/)
  })

  test("the probes run under each declared runtime, and under node when none is declared", () => {
    expect(probeRuntimesFor({ bun: ">=1.3" }).map(({ runtime }) => runtime)).toEqual(["bun"])
    expect(probeRuntimesFor({ node: ">=24" }).map(({ runtime }) => runtime)).toEqual(["node"])
    expect(probeRuntimesFor({ node: ">=24", bun: ">=1.3" }).map(({ runtime }) => runtime)).toEqual(["node", "bun"])
    expect(probeRuntimesFor(undefined).map(({ runtime }) => runtime)).toEqual(["node"])
  })

  test("the package exports the rule under verify-publishable/runtime", async () => {
    const runtime = await import("verify-publishable/runtime")
    expect(runtime.binShebangRuntime({ bun: ">=1.3" })).toBe("bun")
  })
})
