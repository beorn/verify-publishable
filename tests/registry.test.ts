import { createServer, type Server } from "node:http"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

import { afterEach, describe, expect, test, vi } from "vitest"

import { findHostExecutable } from "../src/preflight.ts"
import {
  RegistryRuntimeFailure,
  RegistryStartFailure,
  startRegistry,
  startRegistryProcess,
  type RegistryHandle,
} from "../src/registry.ts"

const roots: string[] = []
const registries: RegistryHandle[] = []
const servers: Server[] = []
const configuredNodePath = process.env.NODE_FOR_TESTS
const hostNodePath = configuredNodePath === undefined ? findHostExecutable("node") : realpathSync(configuredNodePath)
if (hostNodePath === null) throw new Error("HOST_TOOL_MISSING: tool=node searched=PATH purpose=test-fixtures")

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "verify-publishable-registry-test-"))
  roots.push(root)
  return root
}

function fixture(root: string, name: string, source: string): string {
  const path = join(root, name)
  writeFileSync(path, source)
  chmodSync(path, 0o755)
  return path
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error(`fixture server has no TCP address: ${String(address)}`)
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}

async function availablePort(): Promise<number> {
  const reservation = createServer()
  const port = await listen(reservation)
  await closeServer(reservation)
  return port
}

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.stop()
  for (const server of servers.splice(0)) await closeServer(server)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("Verdaccio registry lifecycle", () => {
  /**
   * @failure The verifier reports a registry ready merely because another process
   * answers the expected HTTP endpoint, so packages publish to the wrong server.
   * @level l1
   * @consumer sandbox publish and install phases
   */
  test("requires Verdaccio IPC readiness and a successful ping", async () => {
    const root = temporaryDirectory()
    const registry = await startRegistry({
      cwd: root,
      localPackageNames: ["fixture-package"],
      maxBodySizeBytes: 42_000_000,
    })
    registries.push(registry)

    expect(registry.url).toBe(`http://127.0.0.1:${registry.port}`)
    expect(registry.port).toBeGreaterThan(0)
    expect(registry.port).toBeLessThanOrEqual(65_535)
    expect(registry.pid).toBeGreaterThan(0)
    const config = readFileSync(registry.configPath, "utf8")
    expect(config).toMatch(/"fixture-package":\n(?:    .*\n)*?    proxy: npmjs/)
    expect(config).toContain('max_body_size: "42000000b"')
    expect(readFileSync(registry.npmrcPath!, "utf8")).toContain(`registry=${registry.url}`)
    await expect(fetch(`${registry.url}/-/ping`).then((response) => response.ok)).resolves.toBe(true)

    registry.assertAlive()
    expect(registry.abortSignal.aborted).toBe(false)
    const firstStop = registry.stop()
    expect(registry.stop()).toBe(firstStop)
    await firstStop
    expect(registry.abortSignal.aborted).toBe(false)
    expect(existsSync(registry.stateRoot!)).toBe(false)
  })

  /**
   * @failure An invalid operator-selected port silently becomes the default port or
   * NaN, making the verifier connect to an unrelated registry.
   * @level l0
   * @consumer VERDACCIO_PORT configuration
   */
  test.each(["", "0", "65536", "12.5", " 4873", "+4873", "garbage"])(
    "refuses invalid VERDACCIO_PORT=%j before spawning",
    async (port) => {
      const root = temporaryDirectory()

      await expect(
        startRegistry({
          cwd: root,
          localPackageNames: ["fixture-package"],
          env: { ...process.env, VERDACCIO_PORT: port },
        }),
      ).rejects.toThrow(`invalid VERDACCIO_PORT=${JSON.stringify(port)}; expected an integer from 1 through 65535`)
    },
  )

  /**
   * @failure A child that dies before readiness is treated like a retryable ping
   * miss, hiding its command, cwd, status, and stderr until a generic timeout.
   * @level l0
   * @consumer registry startup diagnostics
   */
  test("fails immediately and visibly when the child dies before readiness", async () => {
    const root = temporaryDirectory()
    const configPath = fixture(root, "config.yaml", "storage: ./storage\n")
    const child = fixture(root, "dies.mjs", 'process.stderr.write("fixture registry exploded\\n"); process.exit(23)\n')
    const nodePath = hostNodePath

    await expect(
      startRegistryProcess({
        cwd: root,
        configPath,
        verdaccioBin: child,
        nodePath,
        port: 48_73,
        readinessTimeoutMs: 5_000,
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<RegistryStartFailure>>({
        name: "RegistryStartFailure",
        cwd: root,
        status: 23,
        stderr: "fixture registry exploded\n",
        command: [
          realpathSync(nodePath),
          realpathSync(child),
          "--config",
          realpathSync(configPath),
          "--listen",
          "127.0.0.1:4873",
        ],
      }),
    )
  })

  test("does not accept IPC readiness without a successful ping", async () => {
    const root = temporaryDirectory()
    const port = await availablePort()
    const configPath = fixture(root, "config.yaml", "storage: ./storage\n")
    const child = fixture(
      root,
      "ipc-only.mjs",
      "process.send?.({ verdaccio_started: true }); setInterval(() => {}, 1000)\n",
    )

    await expect(
      startRegistryProcess({
        cwd: root,
        configPath,
        verdaccioBin: child,
        nodePath: hostNodePath,
        port,
        readinessTimeoutMs: 250,
        pollIntervalMs: 25,
        stopGraceMs: 100,
      }),
    ).rejects.toThrow(/required IPC verdaccio_started and HTTP ping.*lastPingFailure=.*\/-\/ping failed/is)
  })

  /**
   * @failure An inherited npm registry or userconfig redirects Verdaccio itself,
   * while debug mode either disappears or corrupts the machine-readable stdout stream.
   * @level l0
   * @consumer isolated registry startup diagnostics
   */
  test("sanitizes npm registry env case-insensitively and streams debug output only to stderr", async () => {
    const root = temporaryDirectory()
    const port = await availablePort()
    const configPath = fixture(root, "config.yaml", "storage: ./storage\n")
    const child = fixture(
      root,
      "environment-and-debug.mjs",
      `import { createServer } from "node:http"
const forbidden = Object.keys(process.env).filter((key) => {
  const normalized = key.toLowerCase()
  return normalized === "npm_config_registry" || normalized === "npm_config_userconfig"
})
if (forbidden.length > 0) {
  process.stderr.write("FORBIDDEN_ENV=" + JSON.stringify(forbidden) + "\\n")
  process.exit(41)
}
process.stdout.write("DEBUG_STDOUT\\n")
process.stderr.write("DEBUG_STDERR\\n")
const listenArg = process.argv[process.argv.indexOf("--listen") + 1]
const [host, rawPort] = listenArg.split(":")
const server = createServer((request, response) => {
  response.statusCode = request.url === "/-/ping" ? 200 : 404
  response.end("ok")
})
server.listen(Number(rawPort), host, () => process.send?.({ verdaccio_started: true }))
`,
    )
    const debugWrites: string[] = []
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      debugWrites.push(String(chunk))
      return true
    })
    try {
      const registry = await startRegistryProcess({
        cwd: root,
        configPath,
        verdaccioBin: child,
        nodePath: hostNodePath,
        port,
        env: {
          ...process.env,
          VERDACCIO_DEBUG: "1",
          NpM_CoNfIg_ReGiStRy: "https://wrong.invalid",
          npm_CONFIG_userConfig: "/wrong/npmrc",
        },
        readinessTimeoutMs: 5_000,
      })
      registry.assertAlive()
      await registry.stop()
    } finally {
      stderrWrite.mockRestore()
    }

    expect(debugWrites.join("")).toContain("[verdaccio:stdout] DEBUG_STDOUT\n")
    expect(debugWrites.join("")).toContain("[verdaccio:stderr] DEBUG_STDERR\n")
  })

  /**
   * @failure A different HTTP service already owns the selected port and responds
   * to /-/ping, causing a ping-only readiness check to accept the impostor.
   * @level l1
   * @consumer explicit registry port startup
   */
  test("refuses an occupied port even when its existing service answers ping", async () => {
    const imposter = createServer((request, response) => {
      response.statusCode = request.url === "/-/ping" ? 200 : 404
      response.end("ok")
    })
    const port = await listen(imposter)
    const root = temporaryDirectory()

    const failure = await startRegistry({
      cwd: root,
      localPackageNames: ["fixture-package"],
      env: { ...process.env, VERDACCIO_PORT: String(port) },
      readinessTimeoutMs: 10_000,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(RegistryStartFailure)
    const registryFailure = failure as RegistryStartFailure
    expect(registryFailure.status).not.toBe(0)
    expect(registryFailure.message).toMatch(/Verdaccio exited before readiness.*stderr=/is)
    expect(registryFailure.lastPingFailure).toBe(`GET http://127.0.0.1:${port}/-/ping returned HTTP 200`)
    expect(isAbsolute(registryFailure.command[0]!)).toBe(true)
    expect(registryFailure.command[0]).not.toBe(realpathSync(process.execPath))
  })

  /**
   * @failure Cleanup sends SIGTERM without waiting, so a stuck registry leaks into
   * later verifier runs and retains the selected port.
   * @level l1
   * @consumer success, failure, and repeated cleanup paths
   */
  test("stop is async and idempotent, escalating a trapped SIGTERM to SIGKILL", async () => {
    const root = temporaryDirectory()
    const termReceipt = join(root, "term-received")
    const port = await availablePort()
    const configPath = fixture(root, "config.yaml", "storage: ./storage\n")
    const child = fixture(
      root,
      "traps-term.mjs",
      `import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
const listenArg = process.argv[process.argv.indexOf("--listen") + 1]
const [host, rawPort] = listenArg.split(":")
const server = createServer((request, response) => {
  response.statusCode = request.url === "/-/ping" ? 200 : 404
  response.end("ok")
})
server.listen(Number(rawPort), host, () => process.send?.({ verdaccio_started: true }))
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(termReceipt)}, "received")
})
`,
    )
    const registry = await startRegistryProcess({
      cwd: root,
      configPath,
      verdaccioBin: child,
      nodePath: hostNodePath,
      port,
      readinessTimeoutMs: 5_000,
      stopGraceMs: 100,
    })
    registries.push(registry)

    const firstStop = registry.stop()
    const secondStop = registry.stop()
    expect(secondStop).toBe(firstStop)
    await Promise.all([firstStop, secondStop])

    expect(existsSync(termReceipt)).toBe(true)
    await expect(fetch(`${registry.url}/-/ping`)).rejects.toThrow()
  })

  /**
   * @failure Verdaccio becomes ready and then dies, but the verifier continues against
   * a dead registry or treats the already-exited child as a successful cleanup.
   * @level l0
   * @consumer publish and fresh-install orchestration
   */
  test("aborts and reports a structured failure when Verdaccio dies after readiness", async () => {
    const root = temporaryDirectory()
    const port = await availablePort()
    const configPath = fixture(root, "config.yaml", "storage: ./storage\n")
    const child = fixture(
      root,
      "dies-after-ready.mjs",
      `import { createServer } from "node:http"
const listenArg = process.argv[process.argv.indexOf("--listen") + 1]
const [host, rawPort] = listenArg.split(":")
const server = createServer((request, response) => {
  response.statusCode = request.url === "/-/ping" ? 200 : 404
  response.end("ok")
})
server.listen(Number(rawPort), host, () => {
  process.send?.({ verdaccio_started: true })
  setTimeout(() => {
    process.stdout.write("RUNTIME_STDOUT\\n")
    process.stderr.write("RUNTIME_STDERR\\n")
    server.close(() => process.exit(23))
  }, 250)
})
`,
    )
    const registry = await startRegistryProcess({
      cwd: root,
      configPath,
      verdaccioBin: child,
      nodePath: hostNodePath,
      port,
      readinessTimeoutMs: 5_000,
    })

    if (!registry.abortSignal.aborted) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("registry death did not abort its handle")), 5_000)
        registry.abortSignal.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout)
            resolve()
          },
          { once: true },
        )
      })
    }

    const failure = registry.abortSignal.reason
    expect(failure).toBeInstanceOf(RegistryRuntimeFailure)
    expect(failure).toMatchObject({
      name: "RegistryRuntimeFailure",
      cwd: root,
      status: 23,
      stdout: "RUNTIME_STDOUT\n",
      stderr: "RUNTIME_STDERR\n",
    })
    let assertedFailure: unknown
    try {
      registry.assertAlive()
    } catch (error) {
      assertedFailure = error
    }
    expect(assertedFailure).toBe(failure)

    const firstStop = registry.stop()
    const secondStop = registry.stop()
    expect(secondStop).toBe(firstStop)
    await expect(firstStop).rejects.toBe(failure)
  })

  /**
   * @failure A chatty startup failure retains unbounded logs, consuming verifier
   * memory, or truncates away the final diagnostic that explains the failure.
   * @level l0
   * @consumer registry startup diagnostics
   */
  test("bounds captured logs while preserving their tail", async () => {
    const root = temporaryDirectory()
    const configPath = fixture(root, "config.yaml", "storage: ./storage\n")
    const child = fixture(
      root,
      "chatty-death.mjs",
      'process.stderr.write("x".repeat(200_000) + "FINAL-REGISTRY-ERROR\\n"); process.exit(29)\n',
    )

    const failure = await startRegistryProcess({
      cwd: root,
      configPath,
      verdaccioBin: child,
      nodePath: hostNodePath,
      port: 48_75,
      readinessTimeoutMs: 5_000,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(RegistryStartFailure)
    expect((failure as RegistryStartFailure).stderr.length).toBeLessThanOrEqual(64 * 1024)
    expect((failure as RegistryStartFailure).stderr).toMatch(/^\[\.\.\. \d+ bytes truncated; showing tail \.\.\.\]\n/)
    expect((failure as RegistryStartFailure).stderr).toMatch(/FINAL-REGISTRY-ERROR\n$/)
    expect(readFileSync(configPath, "utf8")).toContain("storage")
  })
})
