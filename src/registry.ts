import { fork, type ChildProcess } from "node:child_process"
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

import { TOOL_SPECS, findSelfPackageRoot, resolveOwnedBin } from "./tools.ts"

const REGISTRY_HOST = "127.0.0.1"
const MAX_LOG_BYTES = 64 * 1024
const DEFAULT_READINESS_TIMEOUT_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 100
const DEFAULT_STOP_GRACE_MS = 1_000
const STOP_CONFIRM_TIMEOUT_MS = 5_000

export interface StartRegistryOptions {
  cwd: string
  localPackageNames: string[]
  maxBodySizeBytes?: number
  env?: NodeJS.ProcessEnv
  nodePath?: string
  selfRoot?: string
  readinessTimeoutMs?: number
  pollIntervalMs?: number
  stopGraceMs?: number
}

export interface StartRegistryProcessOptions {
  cwd: string
  configPath: string
  verdaccioBin: string
  nodePath: string
  port: number
  env?: NodeJS.ProcessEnv
  readinessTimeoutMs?: number
  pollIntervalMs?: number
  stopGraceMs?: number
}

export interface RegistryHandle {
  readonly url: string
  readonly port: number
  readonly pid: number
  readonly configPath: string
  readonly npmrcPath?: string
  readonly stateRoot?: string
  readonly abortSignal: AbortSignal
  assertAlive(): void
  stop(): Promise<void>
}

interface ChildExit {
  status: number | null
  signal: NodeJS.Signals | null
  spawnError?: Error
}

interface ChildState {
  exit: ChildExit | undefined
  exitPromise: Promise<ChildExit>
  stdout: TailBuffer
  stderr: TailBuffer
}

export class RegistryStartFailure extends Error {
  readonly command: string[]
  readonly cwd: string
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly lastPingFailure: string | undefined
  readonly spawnError: Error | undefined

  constructor(options: {
    reason: string
    command: string[]
    cwd: string
    status: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    lastPingFailure?: string
    spawnError?: Error
  }) {
    const details = [
      options.reason,
      `command=${options.command.map((part) => JSON.stringify(part)).join(" ")}`,
      `cwd=${JSON.stringify(options.cwd)}`,
      `status=${options.status === null ? "none" : String(options.status)}`,
      `signal=${options.signal ?? "none"}`,
      `stderr=${JSON.stringify(options.stderr)}`,
      `stdout=${JSON.stringify(options.stdout)}`,
      options.lastPingFailure === undefined ? undefined : `lastPingFailure=${JSON.stringify(options.lastPingFailure)}`,
      options.spawnError === undefined ? undefined : `spawnError=${JSON.stringify(options.spawnError.message)}`,
    ]
      .filter((detail) => detail !== undefined)
      .join("; ")
    super(details)
    this.name = "RegistryStartFailure"
    this.command = options.command
    this.cwd = options.cwd
    this.status = options.status
    this.signal = options.signal
    this.stdout = options.stdout
    this.stderr = options.stderr
    this.lastPingFailure = options.lastPingFailure
    this.spawnError = options.spawnError
  }
}

export class RegistryRuntimeFailure extends Error {
  readonly command: string[]
  readonly cwd: string
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly spawnError: Error | undefined

  constructor(options: {
    reason: string
    command: string[]
    cwd: string
    status: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    spawnError?: Error
  }) {
    const details = [
      options.reason,
      `command=${options.command.map((part) => JSON.stringify(part)).join(" ")}`,
      `cwd=${JSON.stringify(options.cwd)}`,
      `status=${options.status === null ? "none" : String(options.status)}`,
      `signal=${options.signal ?? "none"}`,
      `stderr=${JSON.stringify(options.stderr)}`,
      `stdout=${JSON.stringify(options.stdout)}`,
      options.spawnError === undefined ? undefined : `spawnError=${JSON.stringify(options.spawnError.message)}`,
    ]
      .filter((detail) => detail !== undefined)
      .join("; ")
    super(details)
    this.name = "RegistryRuntimeFailure"
    this.command = options.command
    this.cwd = options.cwd
    this.status = options.status
    this.signal = options.signal
    this.stdout = options.stdout
    this.stderr = options.stderr
    this.spawnError = options.spawnError
  }
}

class TailBuffer {
  #value = Buffer.alloc(0)
  #totalBytes = 0

  append(chunk: Buffer): void {
    this.#totalBytes += chunk.byteLength
    const combined = Buffer.concat([this.#value, chunk])
    if (combined.byteLength <= MAX_LOG_BYTES) {
      this.#value = combined
      return
    }
    const dropped = combined.byteLength - MAX_LOG_BYTES
    this.#value = combined.subarray(dropped)
  }

  toString(): string {
    if (this.#totalBytes <= this.#value.byteLength) return this.#value.toString("utf8")
    let truncatedBytes = this.#totalBytes - this.#value.byteLength
    let marker = Buffer.alloc(0)
    for (;;) {
      marker = Buffer.from(`[... ${truncatedBytes} bytes truncated; showing tail ...]\n`)
      const retainedBytes = Math.min(this.#value.byteLength, Math.max(0, MAX_LOG_BYTES - marker.byteLength))
      const actualTruncatedBytes = this.#totalBytes - retainedBytes
      if (actualTruncatedBytes === truncatedBytes) break
      truncatedBytes = actualTruncatedBytes
    }
    const tailBytes = Math.max(0, MAX_LOG_BYTES - marker.byteLength)
    const tail = this.#value.subarray(Math.max(0, this.#value.byteLength - tailBytes))
    return Buffer.concat([marker, tail]).toString("utf8")
  }
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive finite number; actual=${String(resolved)}`)
  }
  return resolved
}

function validatePort(port: number, source: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} must be an integer from 1 through 65535; actual=${String(port)}`)
  }
  return port
}

function configuredPort(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.VERDACCIO_PORT
  if (raw === undefined) return undefined
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`invalid VERDACCIO_PORT=${JSON.stringify(raw)}; expected an integer from 1 through 65535`)
  }
  const port = Number(raw)
  if (port > 65_535) {
    throw new Error(`invalid VERDACCIO_PORT=${JSON.stringify(raw)}; expected an integer from 1 through 65535`)
  }
  return port
}

async function reserveEphemeralPort(): Promise<number> {
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, REGISTRY_HOST, () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error(`ephemeral port reservation returned a non-TCP address: ${String(address)}`))
        return
      }
      resolve(address.port)
    })
  })
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  return port
}

function resolveHostNode(): string {
  const bunPath = realpathSync(process.execPath)
  const executableName = process.platform === "win32" ? "node.exe" : "node"
  const searched: string[] = []
  const inaccessible: string[] = []
  for (const directory of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (directory === "") continue
    const candidate = join(directory, executableName)
    searched.push(candidate)
    if (!existsSync(candidate)) continue
    const canonical = realpathSync(candidate)
    if (canonical === bunPath) continue
    if (!isAbsolute(canonical)) continue
    try {
      accessSync(canonical, constants.X_OK)
      return canonical
    } catch (error) {
      if (!(error instanceof Error)) throw error
      inaccessible.push(`${canonical}: ${error.message}`)
    }
  }
  throw new Error(
    `required host Node executable is missing (Bun's node shim is not accepted); searched=${JSON.stringify(searched)}; inaccessible=${JSON.stringify(inaccessible)}; bun=${JSON.stringify(bunPath)}`,
  )
}

function assertAbsoluteFile(path: string, label: string, executable: boolean): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute: path=${JSON.stringify(path)}`)
  const canonical = realpathSync(path)
  accessSync(canonical, executable ? constants.X_OK : constants.R_OK)
  return canonical
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds)
    timeout.unref()
  })
}

function debugEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.VERDACCIO_DEBUG
  return value !== undefined && value !== ""
}

function registryChildEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides }
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase()
    if (normalized === "npm_config_registry" || normalized === "npm_config_userconfig") delete env[key]
  }
  return env
}

function observeChild(child: ChildProcess, debug: boolean): ChildState {
  const stdout = new TailBuffer()
  const stderr = new TailBuffer()
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.append(chunk)
    if (debug) process.stderr.write(`[verdaccio:stdout] ${chunk.toString("utf8")}`)
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.append(chunk)
    if (debug) process.stderr.write(`[verdaccio:stderr] ${chunk.toString("utf8")}`)
  })

  let exit: ChildExit | undefined
  const exitPromise = new Promise<ChildExit>((resolve) => {
    const settle = (result: ChildExit) => {
      if (exit !== undefined) return
      exit = result
      resolve(result)
    }
    child.once("error", (spawnError) => settle({ status: null, signal: null, spawnError }))
    child.once("close", (status, signal) => settle({ status, signal }))
  })
  return {
    get exit() {
      return exit
    },
    exitPromise,
    stdout,
    stderr,
  }
}

async function waitForExit(state: ChildState, timeoutMs: number): Promise<ChildExit | undefined> {
  return await Promise.race([state.exitPromise, delay(timeoutMs).then(() => undefined)])
}

async function stopChild(
  child: ChildProcess,
  state: ChildState,
  graceMs: number,
  command: string[],
  cwd: string,
): Promise<void> {
  if (state.exit !== undefined) return
  const termSent = child.kill("SIGTERM")
  if (!termSent && state.exit === undefined) {
    const exit = await waitForExit(state, graceMs)
    if (exit === undefined) {
      throw new Error(
        `could not send SIGTERM to Verdaccio and process did not exit; command=${command.map((part) => JSON.stringify(part)).join(" ")}; cwd=${JSON.stringify(cwd)}`,
      )
    }
    return
  }
  if ((await waitForExit(state, graceMs)) !== undefined) return

  const killSent = child.kill("SIGKILL")
  if (!killSent && state.exit === undefined) {
    throw new Error(
      `could not send SIGKILL to Verdaccio; command=${command.map((part) => JSON.stringify(part)).join(" ")}; cwd=${JSON.stringify(cwd)}`,
    )
  }
  if ((await waitForExit(state, STOP_CONFIRM_TIMEOUT_MS)) === undefined) {
    throw new Error(
      `Verdaccio survived SIGKILL for ${STOP_CONFIRM_TIMEOUT_MS}ms; command=${command.map((part) => JSON.stringify(part)).join(" ")}; cwd=${JSON.stringify(cwd)}`,
    )
  }
}

async function ping(url: string): Promise<{ ready: boolean; diagnostic: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_000)
  timeout.unref()
  try {
    const response = await fetch(`${url}/-/ping`, { signal: controller.signal })
    const diagnostic = `GET ${url}/-/ping returned HTTP ${response.status}`
    await response.body?.cancel()
    return { ready: response.ok, diagnostic }
  } catch (error) {
    return {
      ready: false,
      diagnostic: `GET ${url}/-/ping failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function startFailure(options: {
  reason: string
  command: string[]
  cwd: string
  state: ChildState
  lastPingFailure?: string
}): RegistryStartFailure {
  return new RegistryStartFailure({
    reason: options.reason,
    command: options.command,
    cwd: options.cwd,
    status: options.state.exit?.status ?? null,
    signal: options.state.exit?.signal ?? null,
    stdout: options.state.stdout.toString(),
    stderr: options.state.stderr.toString(),
    ...(options.lastPingFailure === undefined ? {} : { lastPingFailure: options.lastPingFailure }),
    ...(options.state.exit?.spawnError === undefined ? {} : { spawnError: options.state.exit.spawnError }),
  })
}

function runtimeFailure(command: string[], cwd: string, state: ChildState): RegistryRuntimeFailure {
  return new RegistryRuntimeFailure({
    reason: "Verdaccio exited unexpectedly after readiness",
    command,
    cwd,
    status: state.exit?.status ?? null,
    signal: state.exit?.signal ?? null,
    stdout: state.stdout.toString(),
    stderr: state.stderr.toString(),
    ...(state.exit?.spawnError === undefined ? {} : { spawnError: state.exit.spawnError }),
  })
}

/** Start a registry after its exact executable resources and configuration have been resolved. */
export async function startRegistryProcess(options: StartRegistryProcessOptions): Promise<RegistryHandle> {
  const cwd = realpathSync(options.cwd)
  const configPath = assertAbsoluteFile(options.configPath, "Verdaccio config", false)
  const verdaccioBin = assertAbsoluteFile(options.verdaccioBin, "Verdaccio bin", false)
  const nodePath = assertAbsoluteFile(options.nodePath, "host Node executable", true)
  const port = validatePort(options.port, "Verdaccio port")
  const readinessTimeoutMs = positiveDuration(
    options.readinessTimeoutMs,
    DEFAULT_READINESS_TIMEOUT_MS,
    "registry readiness timeout",
  )
  const pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "registry poll interval")
  const stopGraceMs = positiveDuration(options.stopGraceMs, DEFAULT_STOP_GRACE_MS, "registry stop grace")
  const url = `http://${REGISTRY_HOST}:${port}`
  const args = [verdaccioBin, "--config", configPath, "--listen", `${REGISTRY_HOST}:${port}`]
  const command = [nodePath, ...args]
  const env = registryChildEnvironment(options.env)

  const child = fork(verdaccioBin, args.slice(1), {
    cwd,
    env,
    execPath: nodePath,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const state = observeChild(child, debugEnabled(env))
  let ipcReady = false
  const onMessage = (message: unknown) => {
    if (
      message !== null &&
      typeof message === "object" &&
      (message as { verdaccio_started?: unknown }).verdaccio_started === true
    ) {
      ipcReady = true
    }
  }
  child.on("message", onMessage)

  const deadline = Date.now() + readinessTimeoutMs
  let lastPingFailure = `GET ${url}/-/ping not attempted`
  try {
    while (Date.now() < deadline) {
      if (state.exit !== undefined) {
        throw startFailure({
          reason: "Verdaccio exited before readiness",
          command,
          cwd,
          state,
          lastPingFailure,
        })
      }

      const pingResult = await ping(url)
      if (state.exit !== undefined) {
        throw startFailure({
          reason: "Verdaccio exited before readiness",
          command,
          cwd,
          state,
          lastPingFailure: pingResult.diagnostic,
        })
      }
      if (ipcReady && pingResult.ready) {
        const pid = child.pid
        if (pid === undefined) {
          throw startFailure({
            reason: "Verdaccio became ready without an observable process id",
            command,
            cwd,
            state,
            lastPingFailure: pingResult.diagnostic,
          })
        }
        child.off("message", onMessage)
        const abortController = new AbortController()
        let stopping = false
        let failure: RegistryRuntimeFailure | undefined
        const recordUnexpectedExit = () => {
          failure ??= runtimeFailure(command, cwd, state)
          if (!abortController.signal.aborted) abortController.abort(failure)
          return failure
        }
        void state.exitPromise.then(() => {
          if (!stopping) recordUnexpectedExit()
        })
        let stopPromise: Promise<void> | undefined
        return {
          url,
          port,
          pid,
          configPath,
          abortSignal: abortController.signal,
          assertAlive: () => {
            if (failure !== undefined) throw failure
            if (stopping) throw new Error(`Verdaccio is stopping or stopped: url=${url}`)
            if (state.exit !== undefined) throw recordUnexpectedExit()
          },
          stop: () => {
            if (stopPromise !== undefined) return stopPromise
            const unexpectedExit = state.exit === undefined ? failure : recordUnexpectedExit()
            stopping = true
            stopPromise = (async () => {
              let cleanupError: unknown
              try {
                await stopChild(child, state, stopGraceMs, command, cwd)
              } catch (error) {
                cleanupError = error
              }
              if (unexpectedExit !== undefined && cleanupError !== undefined) {
                throw new AggregateError(
                  [unexpectedExit, cleanupError],
                  `registry exited unexpectedly and child cleanup also failed: command=${command.map((part) => JSON.stringify(part)).join(" ")}; cwd=${JSON.stringify(cwd)}`,
                )
              }
              if (unexpectedExit !== undefined) throw unexpectedExit
              if (cleanupError !== undefined) throw cleanupError
            })()
            return stopPromise
          },
        }
      }
      lastPingFailure = pingResult.diagnostic

      const exit = await Promise.race([state.exitPromise, delay(pollIntervalMs).then(() => undefined)])
      if (exit !== undefined) {
        throw startFailure({
          reason: "Verdaccio exited before readiness",
          command,
          cwd,
          state,
          lastPingFailure,
        })
      }
    }

    throw startFailure({
      reason: `Verdaccio did not become ready within ${readinessTimeoutMs}ms (required IPC verdaccio_started and HTTP ping)`,
      command,
      cwd,
      state,
      lastPingFailure,
    })
  } catch (error) {
    child.off("message", onMessage)
    try {
      await stopChild(child, state, stopGraceMs, command, cwd)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `registry startup failed and child cleanup also failed: command=${command.map((part) => JSON.stringify(part)).join(" ")}; cwd=${JSON.stringify(cwd)}`,
      )
    }
    throw error
  }
}

function validateLocalPackageNames(names: string[]): string[] {
  if (names.length === 0) {
    throw new Error("cannot start publish registry without local packages; queried=localPackageNames; result=[]")
  }
  const unique = [...new Set(names)]
  for (const name of unique) {
    if (name.trim() !== name || name === "" || /[\n\r]/.test(name)) {
      throw new Error(`invalid local package name for Verdaccio config: ${JSON.stringify(name)}`)
    }
  }
  return unique.sort()
}

function registryConfig(
  stateRoot: string,
  localPackageNames: string[],
  maxBodySizeBytes: number | undefined,
  debug: boolean,
): string {
  const localRules = localPackageNames
    .map(
      (name) => `  ${JSON.stringify(name)}:
    access: $anonymous
    publish: $anonymous
    unpublish: $anonymous`,
    )
    .join("\n")
  const bodyLimit = maxBodySizeBytes === undefined ? "" : `max_body_size: ${JSON.stringify(`${maxBodySizeBytes}b`)}\n`
  return `storage: ${JSON.stringify(join(stateRoot, "storage"))}
${bodyLimit}auth:
  htpasswd:
    file: ${JSON.stringify(join(stateRoot, "htpasswd"))}
    max_users: -1
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    cache: false
    timeout: 30s
    max_fails: 3
    fail_timeout: 10m
packages:
${localRules}
  '@*/*':
    access: $anonymous
    publish: $anonymous
    proxy: npmjs
  '**':
    access: $anonymous
    publish: $anonymous
    unpublish: $anonymous
    proxy: npmjs
log: { type: stdout, format: json, level: ${debug ? "debug" : "warn"} }
`
}

function throwCleanupFailures(primary: unknown, cleanup: unknown, message: string): never {
  if (cleanup === undefined) throw primary
  throw new AggregateError([primary, cleanup], message)
}

/** Resolve owned tools, create isolated state, and start a throwaway local registry. */
export async function startRegistry(options: StartRegistryOptions): Promise<RegistryHandle> {
  const cwd = realpathSync(options.cwd)
  if (
    options.maxBodySizeBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBodySizeBytes) || options.maxBodySizeBytes <= 0)
  ) {
    throw new Error(
      `maxBodySizeBytes must be a positive safe integer: actual=${JSON.stringify(options.maxBodySizeBytes)}`,
    )
  }
  const env = options.env ?? process.env
  const port = configuredPort(env) ?? (await reserveEphemeralPort())
  const localPackageNames = validateLocalPackageNames(options.localPackageNames)
  const selfRoot = options.selfRoot ?? findSelfPackageRoot(fileURLToPath(import.meta.url))
  const verdaccio = resolveOwnedBin(selfRoot, TOOL_SPECS.verdaccio)
  const nodePath = options.nodePath ?? resolveHostNode()

  const stateRoot = mkdtempSync(join(tmpdir(), "verify-publishable-registry-"))
  try {
    const configPath = join(stateRoot, "config.yaml")
    const npmrcPath = join(stateRoot, ".npmrc")
    const url = `http://${REGISTRY_HOST}:${port}`
    mkdirSync(join(stateRoot, "storage"))
    writeFileSync(join(stateRoot, "htpasswd"), "")
    writeFileSync(configPath, registryConfig(stateRoot, localPackageNames, options.maxBodySizeBytes, debugEnabled(env)))
    writeFileSync(npmrcPath, `registry=${url}\n//${REGISTRY_HOST}:${port}/:_authToken=anonymous\n`)
    const processHandle = await startRegistryProcess({
      cwd,
      configPath,
      verdaccioBin: verdaccio.binPath,
      nodePath,
      port,
      env,
      ...(options.readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs: options.readinessTimeoutMs }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
    })
    let stopPromise: Promise<void> | undefined
    return {
      ...processHandle,
      npmrcPath,
      stateRoot,
      stop: () => {
        if (stopPromise !== undefined) return stopPromise
        stopPromise = (async () => {
          let processError: unknown
          try {
            await processHandle.stop()
          } catch (error) {
            processError = error
          }
          let stateError: unknown
          try {
            rmSync(stateRoot, { recursive: true })
          } catch (error) {
            stateError = new Error(
              `registry state cleanup failed: stateRoot=${JSON.stringify(stateRoot)}; cause=${String(error)}`,
            )
          }
          if (processError !== undefined && stateError !== undefined) {
            throw new AggregateError([processError, stateError], "registry process and state cleanup both failed")
          }
          if (processError !== undefined) throw processError
          if (stateError !== undefined) throw stateError
        })()
        return stopPromise
      },
    }
  } catch (error) {
    let cleanupError: unknown
    try {
      rmSync(stateRoot, { recursive: true })
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure
    }
    throwCleanupFailures(
      error,
      cleanupError,
      `registry startup failed and temporary state cleanup also failed: stateRoot=${JSON.stringify(stateRoot)}`,
    )
  }
}
