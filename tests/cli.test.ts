import { describe, expect, test, vi } from "vitest"

import { runCli } from "../src/cli.ts"
import { CommandFailure } from "../src/process.ts"

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
   * @failure Human progress logs mix with the result stream, so CI cannot parse a single
   * authoritative verdict.
   * @level l1
   * @consumer workflow and release wrappers
   */
  test("writes exactly one v1 JSON result to stdout on success", async () => {
    const stdout = sink()
    const stderr = sink()
    const verify = vi.fn(async () => ({
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
      nodeVersion: "v24.18.1",
      packages: [{ name: "fixture", version: "1.0.0" }],
    })
    expect(verify).toHaveBeenCalledWith({ root: "/fixture", noBuild: false, keep: false })
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
