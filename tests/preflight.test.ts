import { describe, expect, test, vi } from "vitest"

import type { CommandResult, CommandSpec } from "../src/process.ts"
import { resolveHostTools } from "../src/preflight.ts"

function result(stdout: string): CommandResult {
  return { status: 0, signal: null, durationMs: 1, stdout, stderr: "" }
}

describe("host preflight", () => {
  test("selects a supplied Node for the package range, in PATH order", async () => {
    const run = vi.fn(async (spec: CommandSpec) => {
      if (spec.args?.[0] !== "--version") return result("11.6.2\n")
      return result(spec.command === "/node24/node" ? "v24.18.1\n" : "v26.13.1\n")
    })

    await expect(
      resolveHostTools(
        "/fixture",
        {
          which: (name) => `/tools/${name}`,
          nodeCandidates: () => ["/node24/node", "/node26/node"],
          run,
        },
        { packageName: "@hallohuman/hightea-ahp-host", range: ">=26.13.1" },
      ),
    ).resolves.toMatchObject({
      nodePath: "/node26/node",
      nodeVersion: "v26.13.1",
      nodeSelectionReason: "engines.node >=26.13.1",
    })
    expect(run.mock.calls[2]?.[0].command).toBe("/node26/node")
  })

  test("names the package, range, and available versions when no Node qualifies", async () => {
    await expect(
      resolveHostTools(
        "/fixture",
        {
          nodeCandidates: () => ["/node24/node", "/node26/node"],
          run: async ({ command }) => result(command === "/node24/node" ? "v24.18.1\n" : "v26.13.1\n"),
        },
        { packageName: "@fixture/next", range: ">=27" },
      ),
    ).rejects.toThrow(/NODE_VERSION_UNSUPPORTED.*@fixture\/next.*>=27.*v24\.18\.1.*v26\.13\.1/)
  })

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

  test("a host without Bun still resolves; only a bun-declaring package's probe needs it", async () => {
    await expect(
      resolveHostTools("/fixture", {
        which: (name) => (name === "bun" ? null : `/tools/${name}`),
        run: async (spec: CommandSpec) => (spec.args?.[0] === "--version" ? result("v24.18.1\n") : result("11.6.2\n")),
      }),
    ).resolves.toMatchObject({ nodePath: "/tools/node", bunPath: null })
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
      bunPath: "/tools/bun",
      nodeVersion: "v24.18.1",
      nodeSelectionReason: "no engines range declared; default Node 24",
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
