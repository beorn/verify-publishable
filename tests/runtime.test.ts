/**
 * @failure A packed bin's shebang or a consumer probe's runtime disagrees with the runtimes the manifest's engines promise.
 * @level l1
 * @consumer the consumer probes, and each component's build step that stamps packed bins (hh #26691)
 */

import { describe, expect, test } from "vitest"

import { binRuntimePlan, binShebangRuntime, probeRuntimesFor } from "../src/runtime.ts"

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

  // hh #27074 (@cto 240b6f1e): the one rule for a packed bin's runtimes, shared by the hosted gate and hh's release verify.
  const both = { node: ">=24", bun: ">=1.3.14" }
  const declared = { package: "git-super", bin: "git-super", reason: "the CLI calls Bun APIs" }

  test("a bin declared Bun-only runs under Bun, and the Node row reads not asked", () => {
    expect(
      binRuntimePlan({ engines: both, bin: "git-super", shebang: "#!/usr/bin/env bun", bunOnly: declared }),
    ).toEqual({
      rows: [
        { bin: "git-super", runtime: "node", action: "not-asked", reason: "not asked: bin declared Bun-only" },
        { bin: "git-super", runtime: "bun", action: "run", reason: "bin declared Bun-only: the CLI calls Bun APIs" },
      ],
    })
  })

  test("an undeclared Bun shebang under engines.node is refused and names the cure", () => {
    for (const engines of [both, { node: ">=24" }]) {
      const plan = binRuntimePlan({ engines, bin: "git-super", shebang: "#!/usr/bin/env bun" })
      expect(plan).toEqual({
        refused: expect.stringMatching(/^engines declares node, but bin git-super runs under Bun: .*bunOnlyBins/),
      })
    }
  })

  test("a Bun-only declaration with no engines.bun, or with no engines.node, is refused", () => {
    expect(
      binRuntimePlan({ engines: { node: ">=24" }, bin: "git-super", shebang: "#!/usr/bin/env bun", bunOnly: declared }),
    ).toEqual({ refused: expect.stringMatching(/declared Bun-only .*declares no bun/) })
    expect(
      binRuntimePlan({ engines: { bun: ">=1.3" }, bin: "git-super", shebang: "#!/usr/bin/env bun", bunOnly: declared }),
    ).toEqual({
      refused: expect.stringMatching(/already judged under Bun; remove it from verifyPublishable\.bunOnlyBins/),
    })
  })

  test("an undeclared node bin runs under every runtime the engines select", () => {
    expect(binRuntimePlan({ engines: both, bin: "tool", shebang: "#!/usr/bin/env node" })).toEqual({
      rows: [
        { bin: "tool", runtime: "node", action: "run", reason: "engines declares node and bun" },
        { bin: "tool", runtime: "bun", action: "run", reason: "engines declares node and bun" },
      ],
    })
  })

  test("the package exports the rule under verify-publishable/runtime", async () => {
    const runtime = await import("verify-publishable/runtime")
    expect(runtime.binShebangRuntime({ bun: ">=1.3" })).toBe("bun")
  })
})
