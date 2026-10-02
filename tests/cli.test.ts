import { describe, expect, test, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

import { executeBuild } from "../src/build.ts"
import { runCli } from "../src/cli.ts"
import { discoverRepository } from "../src/discovery.ts"
import { CommandFailure, runCommand } from "../src/process.ts"
import { ProbeFailure } from "../src/probes.ts"

function sink() {
  let value = ""
  return {
    write(chunk: string) {
      value += chunk
    },
    value: () => value,
  }
}

describe("CLI result contract", () => {
  /**
   * @failure Closing the live stderr pipe crashes successful verification or loses its JSON diagnostic.
   * @level l3
   * @consumer CLI callers that consume stdout while abandoning advisory stderr
   */
  test("keeps a successful CLI result and one loss diagnostic with its stderr read end closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "verify-publishable-cli-closed-stderr-"))
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "verify-publishable-closed-stderr-fixture",
          version: "1.0.0",
          type: "module",
          packageManager: "pnpm@9.15.9",
          files: ["index.js", "index.d.ts"],
          types: "./index.d.ts",
          exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
          publishConfig: { access: "public" },
          scripts: { build: "printf CLOSED_STDERR_BUILD" },
        }),
      )
      writeFileSync(join(root, "index.js"), "export const value = 42\n")
      writeFileSync(join(root, "index.d.ts"), "export declare const value: number\n")
      const child = spawn(process.execPath, [join(import.meta.dirname, "../bin/verify-publishable")], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      })
      child.stderr.destroy()
      let output = ""
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        output += chunk
      })
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      expect(output.trim().split("\n")).toHaveLength(1)
      expect(JSON.parse(output), output).toMatchObject({
        schema: "verify-publishable/v1",
        ok: true,
        liveOutput: {
          stoppedAt: "verify-publishable-closed-stderr-fixture build",
          diagnostic: expect.stringContaining("live output stopped:"),
        },
        packages: [{ name: "verify-publishable-closed-stderr-fixture", version: "1.0.0" }],
      })
      expect(status).toBe(0)
      expect(output).not.toContain("CLOSED_STDERR_BUILD")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test("keeps stdout one JSON document while a build writes both child streams", async () => {
    const root = mkdtempSync(join(tmpdir(), "verify-publishable-cli-build-"))
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          verifyPublishable: {
            build: `bun -e 'process.stdout.write("CHATTER_OUT"); process.stderr.write("CHATTER_ERR")'`,
          },
        }),
      )
      const stdout = sink()
      const stderr = sink()
      const status = await runCli({
        argv: [],
        cwd: root,
        stdout,
        stderr,
        verify: async () => {
          await executeBuild(await discoverRepository(root))
          throw new Error("stop after fake build")
        },
      })
      expect(status).toBe(1)
      expect(JSON.parse(stdout.value())).toMatchObject({ schema: "verify-publishable/v1", ok: false })
      expect(stdout.value().trim().split("\n")).toHaveLength(1)
      expect(stdout.value()).not.toMatch(/CHATTER_OUT|CHATTER_ERR/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  /**
   * @failure Probe wrapping erases a real signal/timeout from the existing CLI failure fields.
   * @level l1
   * @consumer machine-readable release diagnostics with empty child streams
   */
  test.each([false, true])("projects the same real command cause with timeout=%s", async (timedOut) => {
    const cause = await runCommand({
      phase: "import-production-bun",
      command: process.execPath,
      args: ["-e", timedOut ? "setInterval(() => {}, 1000)" : 'process.kill(process.pid, "SIGTERM")'],
      cwd: process.cwd(),
      ...(timedOut ? { timeoutMs: 100 } : {}),
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(cause).toBeInstanceOf(CommandFailure)
    const commandFailure = cause as CommandFailure
    expect(commandFailure.signal).toBe("SIGTERM")
    expect(commandFailure.timedOut).toBe(timedOut)
    const failure = new ProbeFailure({
      phase: commandFailure.phase,
      packageName: "fixture",
      packageVersion: "1.0.0",
      command: commandFailure.command,
      cwd: commandFailure.cwd,
      status: commandFailure.status,
      stdout: commandFailure.stdout,
      stderr: commandFailure.stderr,
      cause: commandFailure,
    })
    const stdout = sink()
    const stderr = sink()
    const status = await runCli({
      argv: [],
      cwd: "/fixture",
      stdout,
      stderr,
      verify: async () => {
        throw failure
      },
    })
    expect(status).toBe(1)
    expect(failure.cause).toBe(commandFailure)
    const result = JSON.parse(stdout.value())
    expect(result).toMatchObject({
      schema: "verify-publishable/v1",
      ok: false,
      failures: [
        {
          code: "PROBE_FAILED",
          phase: "import",
          package: "fixture",
          signal: "SIGTERM",
          detail: expect.stringContaining(commandFailure.message),
        },
      ],
    })
    expect(result.failures[0].detail).toContain(`durationMs=${commandFailure.durationMs}`)
    if (timedOut) expect(result.failures[0].detail).toContain("timeout=true")
    expect(result.failures[0].detail).not.toContain("spawn-error")
    expect(Object.keys(result.failures[0]).sort()).toEqual([
      "code",
      "command",
      "cwd",
      "detail",
      "package",
      "phase",
      "signal",
      "status",
      "stderr",
      "stdout",
    ])
    expect(stderr.value()).toContain(commandFailure.message)
  })

  /**
   * @failure Human progress logs mix with the result stream, so CI cannot parse a single
   * authoritative verdict.
   * @level l1
   * @consumer workflow and release wrappers
   */
  test("writes exactly one v1 JSON result to stdout on success", async () => {
    const stdout = sink()
    const stderr = sink()
    const verify = vi.fn(async () => ({
      nodePath: "/tools/node",
      nodeVersion: "v24.18.1",
      npmVersion: "11.6.2",
      buildMode: "configured" as const,
      packages: [
        {
          name: "fixture",
          version: "1.0.0",
          unpackedSize: 42,
          sha256: "0".repeat(64),
          specifiers: ["fixture"],
          bins: [],
          consumerCheckRan: false,
          runtimes: [{ runtime: "node" as const, version: "v24.0.0", reason: "engines declares no runtime" }],
        },
      ],
    }))

    const status = await runCli({ argv: [], cwd: "/fixture", stdout, stderr, verify })

    expect(status).toBe(0)
    expect(stderr.value()).toBe("")
    expect(stdout.value().trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(stdout.value())).toMatchObject({
      schema: "verify-publishable/v1",
      ok: true,
      nodePath: "/tools/node",
      nodeVersion: "v24.18.1",
      packages: [{ name: "fixture", version: "1.0.0" }],
    })
    expect(verify).toHaveBeenCalledWith({ root: "/fixture", noBuild: false, keep: false })
  })

  test("passes a caller-owned output directory to the verifier and reports retained files", async () => {
    const stdout = sink()
    const stderr = sink()
    const verify = vi.fn(async () => ({
      nodePath: "/tools/node",
      nodeVersion: "v24.18.1",
      npmVersion: "11.6.2",
      buildMode: "configured" as const,
      packages: [
        {
          name: "fixture",
          version: "1.0.0",
          unpackedSize: 42,
          sha256: "0".repeat(64),
          sha512: "sha512-fixture",
          tarballPath: "/artifacts/fixture.tgz",
          specifiers: ["fixture"],
          bins: [],
          consumerCheckRan: false,
          runtimes: [{ runtime: "node" as const, version: "v24.0.0", reason: "engines declares no runtime" }],
        },
      ],
    }))

    const status = await runCli({ argv: ["--output-dir", "/artifacts"], cwd: "/fixture", stdout, stderr, verify })

    expect(status).toBe(0)
    expect(verify).toHaveBeenCalledWith({ root: "/fixture", noBuild: false, keep: false, outputDir: "/artifacts" })
    expect(JSON.parse(stdout.value())).toMatchObject({
      schema: "verify-publishable/v1",
      ok: true,
      packages: [{ tarballPath: "/artifacts/fixture.tgz", sha512: "sha512-fixture" }],
    })
  })

  /**
   * @failure Subprocess stdout holds the actual diagnosis but only stderr is retained,
   * or the process exits nonzero without a machine-readable result.
   * @level l1
   * @consumer failed workflow diagnostics
   */
  test("normalizes command failures into JSON and relays both captured streams to stderr", async () => {
    const stdout = sink()
    const stderr = sink()
    const failure = new CommandFailure({
      phase: "attw:fixture",
      command: ["/tools/node", "/tools/attw", "fixture.tgz"],
      cwd: "/fixture",
      status: 1,
      signal: null,
      durationMs: 4,
      stdout: "ATTW_STDOUT",
      stderr: "ATTW_STDERR",
    })

    const status = await runCli({
      argv: [],
      cwd: "/fixture",
      stdout,
      stderr,
      verify: async () => {
        throw failure
      },
    })

    expect(status).toBe(1)
    const result = JSON.parse(stdout.value())
    expect(result).toMatchObject({
      schema: "verify-publishable/v1",
      ok: false,
      failures: [
        {
          phase: "attw",
          package: "fixture",
          command: failure.command,
          cwd: "/fixture",
          status: 1,
          stdout: "ATTW_STDOUT",
          stderr: "ATTW_STDERR",
        },
      ],
    })
    expect(stderr.value()).toContain("ATTW_STDOUT")
    expect(stderr.value()).toContain("ATTW_STDERR")
  })

  test("refuses unknown flags without invoking verification", async () => {
    const stdout = sink()
    const stderr = sink()
    const verify = vi.fn()

    const status = await runCli({ argv: ["--typo"], cwd: "/fixture", stdout, stderr, verify })

    expect(status).toBe(2)
    expect(verify).not.toHaveBeenCalled()
    expect(JSON.parse(stdout.value())).toMatchObject({ ok: false, failures: [{ code: "USAGE" }] })
    expect(stderr.value()).toContain("--typo")
  })

  test("does not mislabel an untyped verification failure as host preflight", async () => {
    const stdout = sink()
    const stderr = sink()

    const status = await runCli({
      argv: [],
      cwd: "/fixture",
      stdout,
      stderr,
      verify: async () => {
        throw new Error('public assertion mismatch: private=["fixture"]')
      },
    })

    expect(status).toBe(1)
    expect(JSON.parse(stdout.value())).toMatchObject({
      failures: [{ code: "VERIFY_FAILED", phase: "verify", cwd: "/fixture" }],
    })
  })
})
