import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test, vi } from "vitest"

import { CommandFailure, runCommand } from "../src/process.ts"

const roots: string[] = []
const spawnedPids = new Set<number>()
const supportsProcessGroups = process.platform === "linux" || process.platform === "darwin"
const processGroupTest = supportsProcessGroups ? test : test.skip

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "verify-publishable-process-"))
  roots.push(root)
  return root
}

interface ProcessTreeReceipt {
  parentPid: number
  descendantPid: number
}

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function readProcessTreeReceipt(path: string): Promise<ProcessTreeReceipt> {
  const receipt = await waitFor(() => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as ProcessTreeReceipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined
      throw error
    }
  }, "the descendant process to report ready")
  spawnedPids.add(receipt.parentPid)
  spawnedPids.add(receipt.descendantPid)
  return receipt
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  await waitFor(() => (processIsRunning(pid) ? undefined : true), `process ${pid} to exit`)
  spawnedPids.delete(pid)
}

function startStubbornProcessTree(options: {
  cwd: string
  timeoutMs: number
  abortSignal?: AbortSignal
  parentIgnoresTerm?: boolean
}): { execution: ReturnType<typeof runCommand>; readyPath: string; termPath: string } {
  const readyPath = join(options.cwd, "descendant-ready.json")
  const termPath = join(options.cwd, "descendant-term.txt")
  const descendantScript = [
    'const { appendFileSync, writeFileSync } = require("node:fs")',
    'process.on("SIGTERM", () => appendFileSync(process.env.VP_TERM_PATH, `descendant:${process.pid}\\n`))',
    "writeFileSync(process.env.VP_READY_PATH, JSON.stringify({ parentPid: process.ppid, descendantPid: process.pid }))",
    "setInterval(() => {}, 1_000)",
  ].join(";")
  const parentScript = [
    'const { spawn } = require("node:child_process")',
    options.parentIgnoresTerm === false ? undefined : 'process.on("SIGTERM", () => {})',
    `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { env: process.env, stdio: "ignore" })`,
    "descendant.unref()",
    "setInterval(() => {}, 1_000)",
  ]
    .filter((line): line is string => line !== undefined)
    .join(";")

  return {
    execution: runCommand({
      phase: "stubborn-tree",
      command: process.execPath,
      args: ["-e", parentScript],
      cwd: options.cwd,
      env: { VP_READY_PATH: readyPath, VP_TERM_PATH: termPath },
      timeoutMs: options.timeoutMs,
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
    }),
    readyPath,
    termPath,
  }
}

async function commandFailure(execution: ReturnType<typeof runCommand>): Promise<CommandFailure> {
  const didNotSettle = Symbol("did-not-settle")
  let boundTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const failure = await Promise.race([
      execution.then(
        () => undefined,
        (error: unknown) => error,
      ),
      new Promise<typeof didNotSettle>((resolve) => {
        boundTimer = setTimeout(() => resolve(didNotSettle), 8_000)
      }),
    ])
    if (failure === didNotSettle) throw new Error("runCommand did not settle within the termination bound")
    expect(failure).toBeInstanceOf(CommandFailure)
    return failure as CommandFailure
  } finally {
    if (boundTimer !== undefined) clearTimeout(boundTimer)
  }
}

afterEach(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  spawnedPids.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("process boundary", () => {
  /**
   * @failure A failed external gate is reduced to a generic error, hiding the exact
   * command, directory, status, and stderr needed to reproduce it.
   * @level l0
   * @consumer every build, pack, registry, publish, and probe phase
   */
  test("throws a complete diagnostic for a non-zero exit", async () => {
    const cwd = temporaryDirectory()

    await expect(
      runCommand({
        phase: "fixture",
        command: process.execPath,
        args: ["-e", 'process.stderr.write("fixture boom"); process.exit(7)'],
        cwd,
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<CommandFailure>>({
        name: "CommandFailure",
        phase: "fixture",
        command: [process.execPath, "-e", 'process.stderr.write("fixture boom"); process.exit(7)'],
        cwd,
        status: 7,
        stderr: "fixture boom",
      }),
    )
  })

  /**
   * @failure A required executable is absent but the gate reports a skipped check or
   * an empty result.
   * @level l0
   * @consumer host resource preflight
   */
  test("fails loud when the executable cannot be spawned", async () => {
    const cwd = temporaryDirectory()
    const command = join(cwd, "definitely-missing")

    await expect(runCommand({ phase: "preflight", command, args: ["--version"], cwd })).rejects.toThrowError(
      expect.objectContaining<Partial<CommandFailure>>({
        name: "CommandFailure",
        phase: "preflight",
        command: [command, "--version"],
        cwd,
        status: null,
      }),
    )
  })

  test("returns captured output from a successful command", async () => {
    const cwd = temporaryDirectory()
    const result = await runCommand({
      phase: "fixture",
      command: process.execPath,
      args: ["-e", 'process.stdout.write("out"); process.stderr.write("err")'],
      cwd,
    })

    expect(result).toEqual({
      durationMs: expect.any(Number),
      status: 0,
      signal: null,
      stdout: "out",
      stderr: "err",
    })
  })

  test("marks omitted output while preserving the diagnostic tail", async () => {
    const cwd = temporaryDirectory()
    const failure = await runCommand({
      phase: "chatty-fixture",
      command: process.execPath,
      args: ["-e", 'process.stderr.write("x".repeat(2 * 1024 * 1024) + "FINAL-DIAGNOSTIC", () => process.exit(9))'],
      cwd,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(CommandFailure)
    expect((failure as CommandFailure).stderr).toMatch(/^\[verify-publishable: earlier output truncated\]\n/)
    expect((failure as CommandFailure).stderr).toMatch(/FINAL-DIAGNOSTIC$/)
    expect(Buffer.byteLength((failure as CommandFailure).stderr)).toBeLessThanOrEqual(1024 * 1024)
  })

  /**
   * @failure A timed-out gate kills only its direct shell, leaving a compiler or
   * package-manager descendant running after the failure has returned.
   * @level l0
   * @consumer every phase with a timeout
   */
  processGroupTest("times out the full process tree and escalates TERM to KILL", async () => {
    const cwd = temporaryDirectory()
    const { execution, readyPath, termPath } = startStubbornProcessTree({ cwd, timeoutMs: 2_000 })
    const receipt = await readProcessTreeReceipt(readyPath)

    const failure = await commandFailure(execution)

    expect(failure).toMatchObject({ timedOut: true, aborted: false, signal: "SIGKILL" })
    expect(readFileSync(termPath, "utf8")).toContain(`descendant:${receipt.descendantPid}\n`)
    await waitForProcessExit(receipt.descendantPid)
    await waitForProcessExit(receipt.parentPid)
  })

  /**
   * @failure Cancelling a gate kills only its direct shell, so work continues in a
   * spawned descendant after callers believe cancellation completed.
   * @level l0
   * @consumer callers cancelling any external verification phase
   */
  processGroupTest("aborts the full process tree and escalates TERM to KILL", async () => {
    const cwd = temporaryDirectory()
    const controller = new AbortController()
    const { execution, readyPath, termPath } = startStubbornProcessTree({
      cwd,
      timeoutMs: 20_000,
      abortSignal: controller.signal,
      parentIgnoresTerm: false,
    })
    const receipt = await readProcessTreeReceipt(readyPath)

    controller.abort()
    const failure = await commandFailure(execution)

    expect(failure).toMatchObject({ timedOut: false, aborted: true, signal: "SIGTERM" })
    expect(readFileSync(termPath, "utf8")).toContain(`descendant:${receipt.descendantPid}\n`)
    await waitForProcessExit(receipt.descendantPid)
    await waitForProcessExit(receipt.parentPid)
  })

  /**
   * @failure An OS signal-delivery error leaves runCommand waiting forever for a
   * close event that can no longer be treated as reliable confirmation.
   * @level l0
   * @consumer timeout and cancellation failure handling
   */
  processGroupTest("fails loud within a bound when process-tree signals cannot be delivered", async () => {
    const cwd = temporaryDirectory()
    const controller = new AbortController()
    const { execution, readyPath } = startStubbornProcessTree({
      cwd,
      timeoutMs: 20_000,
      abortSignal: controller.signal,
    })
    const receipt = await readProcessTreeReceipt(readyPath)
    const realKill = process.kill.bind(process)
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -receipt.parentPid && signal !== 0) {
        throw Object.assign(new Error("fixture signal refusal"), { code: "EPERM" })
      }
      return signal === undefined ? realKill(pid) : realKill(pid, signal as NodeJS.Signals | number)
    }) as typeof process.kill)

    try {
      controller.abort()
      const failure = await commandFailure(execution)
      expect(failure.message).toContain("fixture signal refusal")
      expect(failure.message).toContain("process tree termination was not confirmed")
    } finally {
      killSpy.mockRestore()
    }
  })
})
