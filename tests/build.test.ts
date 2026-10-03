import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"

import { afterEach, describe, expect, test, vi } from "vitest"

import { createLiveSink, executeBuild, planBuild, readLiveOutputLoss } from "../src/build.ts"
import { discoverRepository } from "../src/discovery.ts"
import { CommandFailure, runCommand } from "../src/process.ts"

const roots: string[] = []

function fixture(manifest: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "verify-publishable-build-"))
  roots.push(root)
  writeManifest(root, manifest)
  return root
}

function writeManifest(root: string, manifest: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("build selection", () => {
  test("executes a versionless private root build covering public workspace packages", async () => {
    const root = fixture({
      name: "private-root",
      private: true,
      workspaces: ["packages/*"],
      scripts: { build: 'bun -e \'Bun.write("built.txt", "root built")\'' },
    })
    writeManifest(join(root, "packages/public"), { name: "public", version: "1.0.0" })
    const repository = await discoverRepository(root)
    expect(planBuild(repository, { noBuild: false }).mode).toBe("root-script")
    await executeBuild(repository)
    expect(readFileSync(join(root, "built.txt"), "utf8")).toBe("root built")
  })

  test("drops bounded live output under backpressure and reports the byte count on drain", async () => {
    const destination = new EventEmitter() as Writable
    const writes: string[] = []
    let first = true
    destination.write = ((chunk: string, callback: () => void) => {
      writes.push(chunk)
      callback()
      if (first) {
        first = false
        return false
      }
      return true
    }) as typeof destination.write
    const live = createLiveSink(destination, "fixture")
    live.onOutput("stdout", Buffer.from("first\n"))
    live.onOutput("stderr", Buffer.from("lost bytes\n"))
    destination.emit("drain")
    live.onOutput("stderr", Buffer.from("last\n"))
    expect(await live.finish()).toBeUndefined()
    expect(writes).toEqual([
      "[fixture] stdout: first\n",
      "[fixture] live output: 11 bytes dropped during backpressure\n",
      "[fixture] stderr: last\n",
    ])
  })

  test("retains a delayed sink error until it can report one diagnostic", async () => {
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(() => callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" })), 5)
      },
    })
    const live = createLiveSink(destination, "fixture")
    live.onOutput("stdout", Buffer.from("first\n"))
    expect(await live.finish()).toBe("live output stopped: broken pipe")
    await new Promise((resolve) => setImmediate(resolve))
    expect(destination.listenerCount("error")).toBe(1)
  })

  test("records a write-callback failure once while a child succeeds", async () => {
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("fixture EPIPE"), { code: "EPIPE" }))
      },
    })
    const live = createLiveSink(destination, "configured command fixture")
    const result = await runCommand({
      phase: "build",
      command: process.execPath,
      args: ["-e", 'process.stdout.write("success\\n")'],
      cwd: fixture({ name: "fixture", version: "1.0.0" }),
      onOutput: live.onOutput,
    })
    await live.finish()
    expect(result.status).toBe(0)
    expect(readLiveOutputLoss(destination)).toEqual({
      stoppedAt: "configured command fixture",
      diagnostic: "live output stopped: fixture EPIPE",
    })
    expect(destination.listenerCount("error")).toBe(1)
  })

  test("retires each adapter when a real Writable never drains", async () => {
    const destination = new Writable({
      highWaterMark: 1,
      write() {
        /* intentionally never calls back */
      },
    })
    for (let step = 0; step < 3; step++) {
      const live = createLiveSink(destination, `step-${step}`)
      live.onOutput("stdout", Buffer.from("first\n"))
      live.onOutput("stdout", Buffer.from("lost\n"))
      const started = performance.now()
      expect(await live.finish()).toMatch(/bytes dropped/)
      expect(performance.now() - started).toBeLessThan(750)
    }
    expect(destination.listenerCount("drain")).toBe(0)
    expect(destination.listenerCount("error")).toBe(1)
  })

  test("reports a pending flush before a real Writable errors after retirement", async () => {
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(() => callback(Object.assign(new Error("late EPIPE"), { code: "EPIPE" })), 500)
      },
    })
    const live = createLiveSink(destination, "late")
    live.onOutput("stdout", Buffer.from("first\n"))
    expect(await live.finish()).toMatch(/flush|pending/i)
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(destination.listenerCount("drain")).toBe(0)
    expect(destination.listenerCount("error")).toBe(1)
    expect(readLiveOutputLoss(destination)).toEqual({
      stoppedAt: "late",
      diagnostic: expect.stringMatching(/flush pending/),
    })
    const write = vi.spyOn(destination, "write")
    const next = createLiveSink(destination, "next")
    next.start("/fixture", 100)
    next.onOutput("stdout", Buffer.from("nothing else should forward\n"))
    await next.finish()
    expect(write).not.toHaveBeenCalled()
    expect(readLiveOutputLoss(destination)?.stoppedAt).toBe("late")

    const cleanDestination = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    const clean = createLiveSink(cleanDestination, "clean")
    clean.onOutput("stdout", Buffer.from("first\n"))
    expect(await clean.finish()).toBeUndefined()
    cleanDestination.emit("error", new Error("after finish EPIPE"))
    expect(readLiveOutputLoss(cleanDestination)).toEqual({
      stoppedAt: "after build",
      diagnostic: "live output stopped: after finish EPIPE",
    })
    const cleanWrite = vi.spyOn(cleanDestination, "write")
    const after = createLiveSink(cleanDestination, "after")
    after.onOutput("stdout", Buffer.from("nothing else should forward\n"))
    await after.finish()
    expect(cleanWrite).not.toHaveBeenCalled()
  })

  test.each(["callback-first", "event-first"])("retires a sink after %s error ordering", async (order) => {
    const destination = new EventEmitter() as Writable
    const error = Object.assign(new Error("ordered EPIPE"), { code: "EPIPE" })
    destination.write = ((_chunk: string, callback: (error?: Error) => void) => {
      setTimeout(() => {
        if (order === "event-first") destination.emit("error", error)
        callback(error)
        if (order === "callback-first") destination.emit("error", error)
      }, 5)
      return true
    }) as typeof destination.write
    const live = createLiveSink(destination, order)
    live.onOutput("stdout", Buffer.from("line\n"))
    expect(await live.finish()).toBe("live output stopped: ordered EPIPE")
    await new Promise((resolve) => setImmediate(resolve))
    expect(destination.listenerCount("drain")).toBe(0)
    expect(destination.listenerCount("error")).toBe(1)
    expect(readLiveOutputLoss(destination)).toEqual({
      stoppedAt: order,
      diagnostic: "live output stopped: ordered EPIPE",
    })
  })

  test("bounds each UTF-8 line fragment without splitting multibyte characters", async () => {
    const destination = new EventEmitter() as Writable
    const writes: string[] = []
    destination.write = ((chunk: string, callback: () => void) => {
      writes.push(chunk)
      callback()
      return true
    }) as typeof destination.write
    const live = createLiveSink(destination, "unicode")
    const value = "界".repeat(3_000) + "😀" + "ø".repeat(3_000)
    const encoded = Buffer.from(value)
    for (const stream of ["stdout", "stderr"] as const) {
      // Deliberately split a three-byte code point across raw process chunks.
      live.onOutput(stream, encoded.subarray(0, 2))
      live.onOutput(stream, encoded.subarray(2, 7))
      live.onOutput(stream, encoded.subarray(7))
    }
    expect(await live.finish()).toBeUndefined()
    for (const stream of ["stdout", "stderr"] as const) {
      const prefix = `[unicode] ${stream}: `
      const fragments = writes.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length, -1))
      expect(fragments.length).toBeGreaterThan(1)
      expect(fragments.every((part) => Buffer.byteLength(part) <= 8 * 1024)).toBe(true)
      expect(fragments.join("")).toBe(value)
      expect(fragments.join("")).not.toContain("�")
    }
  })
  /**
   * @failure A repository-specific build is tokenized or replaced by a guessed ladder,
   * so the verifier builds artifacts differently from release.
   * @level l0
   * @consumer verifyPublishable.build
   */
  test("runs the configured command once at the repository root through Bun Shell", async () => {
    const root = fixture({
      name: "fixture",
      version: "1.0.0",
      verifyPublishable: { build: "printf configured > build-marker && printf '%s' '-done' >> build-marker" },
    })
    const plan = await discoverRepository(root)

    const result = await executeBuild(plan)

    expect(result.mode).toBe("configured")
    expect(readFileSync(join(root, "build-marker"), "utf8")).toBe("configured-done")
  })

  /**
   * @failure Build failure is ignored while pack/install probes continue against stale
   * output, recreating the three-of-four false green.
   * @level l0
   * @consumer build gate
   */
  test("makes a configured build failure losslessly fatal", async () => {
    const root = fixture({
      name: "fixture",
      version: "1.0.0",
      verifyPublishable: { build: "printf BUILD_SENTINEL; exit 23" },
    })
    const plan = await discoverRepository(root)

    await expect(executeBuild(plan)).rejects.toThrowError(
      expect.objectContaining<Partial<CommandFailure>>({
        phase: "build",
        cwd: root,
        status: 23,
        stdout: "BUILD_SENTINEL",
      }),
    )
  })

  /** @failure A configured short budget is ignored while a build keeps running. @level l0 @consumer build gate */
  test("uses the configured budget at the build execution seam", async () => {
    const root = fixture({
      name: "fixture",
      version: "1.0.0",
      verifyPublishable: {
        build: `bun -e 'process.stdout.write("OUT_SENTINEL"); process.stderr.write("ERR_SENTINEL"); await Bun.sleep(1000)'`,
      },
    })
    const plan = await discoverRepository(root)
    // Exercise a normalized plan too: this must fail under the old ten-minute call site.
    plan.config.buildTimeoutMs = 500
    let live = ""
    const stderrWrite = process.stderr.write.bind(process.stderr)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((...args: unknown[]) => {
      live += String(args[0])
      return Reflect.apply(stderrWrite, process.stderr, args) as boolean
    }) as typeof process.stderr.write)
    let failure: unknown
    try {
      await executeBuild(plan)
    } catch (error) {
      failure = error
    } finally {
      stderrSpy.mockRestore()
    }
    expect(failure).toBeInstanceOf(CommandFailure)
    expect(failure).toMatchObject({ timedOut: true, stdout: "OUT_SENTINEL", stderr: "ERR_SENTINEL" })
    expect(String(failure)).toContain("budgetMs=500")
    expect(String(failure)).toContain(root)
    expect(live).toContain("stdout: OUT_SENTINEL")
    expect(live).toContain("stderr: ERR_SENTINEL")
  })

  test("uses one root build script before considering package scripts", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      private: true,
      scripts: { build: "fixture-build" },
      workspaces: ["packages/*"],
    })
    writeManifest(join(root, "packages/a"), {
      name: "@fixture/a",
      version: "1.0.0",
      scripts: { build: "package-build" },
    })

    const build = planBuild(await discoverRepository(root), { noBuild: false })

    expect(build).toMatchObject({ mode: "root-script", steps: [{ cwd: root, script: "build" }] })
  })

  test("refuses package fallback when any public package has no build script", async () => {
    const root = fixture({
      name: "fixture-root",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
    })
    writeManifest(join(root, "packages/a"), {
      name: "@fixture/a",
      version: "1.0.0",
      scripts: { build: "fixture-build" },
    })
    writeManifest(join(root, "packages/b"), { name: "@fixture/b", version: "1.0.0" })

    const plan = await discoverRepository(root)
    expect(() => planBuild(plan, { noBuild: false })).toThrow(/public packages have no build script.*@fixture\/b/i)
  })

  test("reports an explicit no-build skip without selecting a command", async () => {
    const root = fixture({ name: "fixture", version: "1.0.0" })

    expect(planBuild(await discoverRepository(root), { noBuild: true })).toEqual({ mode: "skipped", steps: [] })
  })
})
