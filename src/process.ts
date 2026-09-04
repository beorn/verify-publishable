import { spawn } from "node:child_process"

export interface CommandSpec {
  phase: string
  command: string
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  abortSignal?: AbortSignal
}

export interface CommandResult {
  status: number
  signal: NodeJS.Signals | null
  durationMs: number
  stdout: string
  stderr: string
}

export class CommandFailure extends Error {
  readonly phase: string
  readonly command: string[]
  readonly cwd: string
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  readonly spawnError: Error | undefined
  readonly timedOut: boolean
  readonly aborted: boolean

  constructor(options: {
    phase: string
    command: string[]
    cwd: string
    status: number | null
    signal: NodeJS.Signals | null
    durationMs: number
    stdout: string
    stderr: string
    spawnError?: Error
    timedOut?: boolean
    aborted?: boolean
  }) {
    const renderedCommand = options.command.map((part) => JSON.stringify(part)).join(" ")
    const status =
      options.status !== null ? String(options.status) : options.spawnError === undefined ? "none" : "spawn-error"
    const detail = [
      `phase=${JSON.stringify(options.phase)}`,
      `command=${renderedCommand}`,
      `cwd=${JSON.stringify(options.cwd)}`,
      `status=${status}`,
      `signal=${options.signal ?? "none"}`,
      `durationMs=${options.durationMs}`,
      options.timedOut === true ? "timeout=true" : undefined,
      options.aborted === true ? "aborted=true" : undefined,
      `stdout=${JSON.stringify(options.stdout)}`,
      `stderr=${JSON.stringify(options.stderr)}`,
      options.spawnError === undefined ? undefined : `spawnError=${JSON.stringify(options.spawnError.message)}`,
    ]
      .filter((value) => value !== undefined)
      .join("; ")
    super(`command failed: ${detail}`)
    this.name = "CommandFailure"
    this.phase = options.phase
    this.command = options.command
    this.cwd = options.cwd
    this.status = options.status
    this.signal = options.signal
    this.durationMs = options.durationMs
    this.stdout = options.stdout
    this.stderr = options.stderr
    this.spawnError = options.spawnError
    this.timedOut = options.timedOut ?? false
    this.aborted = options.aborted ?? false
  }
}

const MAX_CAPTURE_BYTES = 1024 * 1024
const TRUNCATION_MARKER = "[verify-publishable: earlier output truncated]\n"
const KILL_GRACE_MS = 1_000
const CLOSE_CONFIRMATION_MS = 1_000

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeSystemError(error: unknown): string {
  const code = errorCode(error)
  const message = describeError(error)
  return code === undefined || code === message ? message : `${code}: ${message}`
}

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): { output: Buffer<ArrayBufferLike>; truncated: boolean } {
  const combined = Buffer.concat([current, chunk])
  return combined.byteLength <= MAX_CAPTURE_BYTES
    ? { output: combined, truncated: false }
    : {
        output: combined.subarray(combined.byteLength - MAX_CAPTURE_BYTES + Buffer.byteLength(TRUNCATION_MARKER)),
        truncated: true,
      }
}

function capturedOutput(output: Buffer<ArrayBufferLike>, truncated: boolean): string {
  return `${truncated ? TRUNCATION_MARKER : ""}${output.toString("utf8")}`
}

export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const args = spec.args ?? []
  const startedAt = performance.now()
  return await new Promise<CommandResult>((resolve, reject) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stdoutTruncated = false
    let stderrTruncated = false
    let settled = false
    let timedOut = false
    let aborted = false
    let terminating = false
    let killAttempted = false
    let killConfirmed = false
    let closeResult: { status: number | null; signal: NodeJS.Signals | null } | undefined
    const terminationFailures: string[] = []
    const supportsProcessGroups = process.platform === "linux" || process.platform === "darwin"
    let timeout: ReturnType<typeof setTimeout> | undefined
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let closeConfirmationTimer: ReturnType<typeof setTimeout> | undefined
    const child = spawn(spec.command, args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      detached: supportsProcessGroups,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })

    child.stdout.on("data", (chunk: Buffer) => {
      const captured = appendTail(stdout, chunk)
      stdout = captured.output
      stdoutTruncated ||= captured.truncated
    })
    child.stderr.on("data", (chunk: Buffer) => {
      const captured = appendTail(stderr, chunk)
      stderr = captured.output
      stderrTruncated ||= captured.truncated
    })

    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      if (closeConfirmationTimer !== undefined) clearTimeout(closeConfirmationTimer)
      spec.abortSignal?.removeEventListener("abort", abortListener)
    }
    const failure = (options: {
      status: number | null
      signal: NodeJS.Signals | null
      spawnError?: Error
      terminationFailures?: string[]
    }) => {
      const result = new CommandFailure({
        phase: spec.phase,
        command: [spec.command, ...args],
        cwd: spec.cwd,
        status: options.status,
        signal: options.signal,
        durationMs: Math.round(performance.now() - startedAt),
        stdout: capturedOutput(stdout, stdoutTruncated),
        stderr: capturedOutput(stderr, stderrTruncated),
        timedOut,
        aborted,
        ...(options.spawnError === undefined ? {} : { spawnError: options.spawnError }),
      })
      if (options.terminationFailures !== undefined && options.terminationFailures.length > 0) {
        result.message += `; terminationFailures=${JSON.stringify(options.terminationFailures)}`
      }
      return result
    }

    const settleFailure = (
      result: { status: number | null; signal: NodeJS.Signals | null },
      options: { releaseHandles?: boolean; extraTerminationFailure?: string } = {},
    ) => {
      if (settled) return
      settled = true
      const failures = [...terminationFailures]
      if (options.extraTerminationFailure !== undefined) failures.push(options.extraTerminationFailure)
      cleanup()
      const commandFailure = failure({ ...result, ...(failures.length === 0 ? {} : { terminationFailures: failures }) })
      if (options.releaseHandles === true) {
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
      }
      reject(commandFailure)
    }

    const settleClose = (result: { status: number | null; signal: NodeJS.Signals | null }) => {
      if (settled) return
      if (result.status !== 0 || timedOut || aborted) {
        settleFailure(result)
        return
      }
      settled = true
      cleanup()
      resolve({
        status: result.status,
        signal: result.signal,
        durationMs: Math.round(performance.now() - startedAt),
        stdout: capturedOutput(stdout, stdoutTruncated),
        stderr: capturedOutput(stderr, stderrTruncated),
      })
    }

    const signalTree = (signal: "SIGTERM" | "SIGKILL"): "gone" | "reached" | "uncertain" => {
      if (supportsProcessGroups && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal)
          return "reached"
        } catch (error) {
          if (errorCode(error) === "ESRCH") return "gone"
          terminationFailures.push(
            `process-group ${signal} failed (${describeSystemError(error)}); descendants may survive pgid ${child.pid}`,
          )
          try {
            if (!child.kill(signal)) {
              terminationFailures.push(`direct-child ${signal} was not delivered to pid ${child.pid}`)
            }
          } catch (directError) {
            if (errorCode(directError) !== "ESRCH") {
              terminationFailures.push(
                `direct-child ${signal} failed (${describeSystemError(directError)}) for pid ${child.pid}`,
              )
            }
          }
          return "uncertain"
        }
      }

      terminationFailures.push(
        supportsProcessGroups
          ? `process-group ${signal} could not be delivered because the child pid is unavailable`
          : `process-group ${signal} is unavailable on ${process.platform}; descendants may survive`,
      )
      try {
        if (!child.kill(signal)) return "gone"
      } catch (error) {
        if (errorCode(error) === "ESRCH") return "gone"
        terminationFailures.push(
          `direct-child ${signal} failed (${describeSystemError(error)}) for pid ${child.pid ?? "unknown"}`,
        )
      }
      return "uncertain"
    }

    const escalate = () => {
      if (settled) return
      killAttempted = true
      killConfirmed = signalTree("SIGKILL") !== "uncertain"
      if (closeResult !== undefined && killConfirmed) {
        settleClose(closeResult)
        return
      }
      closeConfirmationTimer = setTimeout(() => {
        const unconfirmed = [
          !killConfirmed ? "process tree termination was not confirmed after SIGKILL" : undefined,
          closeResult === undefined
            ? `direct child did not close within ${CLOSE_CONFIRMATION_MS}ms after SIGKILL`
            : undefined,
        ]
          .filter((detail): detail is string => detail !== undefined)
          .join("; ")
        settleFailure(closeResult ?? { status: child.exitCode, signal: child.signalCode }, {
          releaseHandles: true,
          extraTerminationFailure:
            unconfirmed.length === 0 ? "process tree termination was not confirmed" : unconfirmed,
        })
      }, CLOSE_CONFIRMATION_MS)
    }

    const abort = (reason: "timeout" | "abort") => {
      if (settled || terminating) return
      terminating = true
      timedOut = reason === "timeout"
      aborted = reason === "abort"
      if (timeout !== undefined) clearTimeout(timeout)
      signalTree("SIGTERM")
      forceKillTimer = setTimeout(escalate, KILL_GRACE_MS)
    }
    const abortListener = () => abort("abort")

    child.once("error", (error) => {
      if (settled) return
      if (terminating && child.pid !== undefined) {
        terminationFailures.push(
          `child-process error during termination (${describeSystemError(error)}) for pid ${child.pid}`,
        )
        return
      }
      settled = true
      cleanup()
      reject(failure({ status: null, signal: null, spawnError: error }))
    })
    child.once("close", (status, signal) => {
      if (settled) return
      const result = { status, signal }
      if (!terminating) {
        settleClose(result)
        return
      }
      closeResult = result
      if (killAttempted && killConfirmed) settleClose(result)
    })

    timeout = setTimeout(() => abort("timeout"), spec.timeoutMs ?? 120_000)
    spec.abortSignal?.addEventListener("abort", abortListener, { once: true })
    if (spec.abortSignal?.aborted === true) abort("abort")
  })
}
