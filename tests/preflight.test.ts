import { describe, expect, test, vi } from "vitest"

import type { CommandResult, CommandSpec } from "../src/process.ts"
import { resolveHostTools } from "../src/preflight.ts"

function result(stdout: string): CommandResult {
  return { status: 0, signal: null, durationMs: 1, stdout, stderr: "" }
}

describe("host preflight", () => {
  /**
   * @failure The gate runs its import probes under a different Node major than CI/release,
   * giving environment-dependent package verdicts.
   * @level l0
   * @consumer external Node probes and Verdaccio
   */
  test("requires Node 24 before resolving later tools", async () => {
    const run = vi.fn(async (spec: CommandSpec) =>
      spec.args?.[0] === "--version" ? result("v22.14.0\n") : result("11.0.0\n"),
    )

    await expect(
      resolveHostTools("/fixture", {
        which: (name) => `/tools/${name}`,
        run,
      }),
    ).rejects.toThrow(/NODE_VERSION_UNSUPPORTED.*required=24.*actual=v22\.14\.0/i)
    expect(run).toHaveBeenCalledTimes(1)
  })

  /**
   * @failure A missing host resource becomes a skipped phase instead of naming what was
   * queried and where it was searched.
   * @level l0
   * @consumer Node/npm host dependency contract
   */
  test("fails loud when Node or npm is absent from the host search path", async () => {
    await expect(
      resolveHostTools("/fixture", {
        which: (name) => (name === "node" ? "/tools/node" : null),
        run: async () => result("v24.1.0\n"),
      }),
    ).rejects.toThrow(/HOST_TOOL_MISSING.*tool=npm.*searched=PATH/i)
  })

  test("returns absolute paths and parsed versions for a valid host", async () => {
    const run = vi.fn(async (spec: CommandSpec) =>
      spec.args?.[0] === "--version" ? result("v24.18.1\n") : result("11.6.2\n"),
    )

    await expect(
      resolveHostTools("/fixture", {
        which: (name) => `/tools/${name}`,
        run,
      }),
    ).resolves.toEqual({
      nodePath: "/tools/node",
      nodeVersion: "v24.18.1",
      npmPath: "/tools/npm",
      npmVersion: "11.6.2",
    })
    expect(run).toHaveBeenNthCalledWith(2, {
      phase: "preflight",
      command: "/tools/node",
      args: ["/tools/npm", "--version"],
      cwd: "/fixture",
      timeoutMs: 10_000,
    })
  })
})
