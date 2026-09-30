import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "vitest"

const ROOT = join(import.meta.dirname, "..")

describe("Git dependency package shape", () => {
  /**
   * @failure A SHA-pinned Git dependency installs without a runnable local bin,
   * so bunx can silently fall through to an unrelated npm package.
   * @level l0
   * @consumer every verify-publishable caller
   */
  test("ships an executable Bun bin backed by checked-in source", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>
      dependencies?: Record<string, string>
      engines?: Record<string, string>
      files?: string[]
      os?: string[]
      scripts?: Record<string, string>
    }
    expect(manifest.bin).toEqual({ "verify-publishable": "bin/verify-publishable" })
    expect(manifest.scripts?.prepare).toBeUndefined()
    expect(manifest.scripts?.postinstall).toBeUndefined()
    // Bun is the only runtime the package promises; Node 24 is a host tool the probes spawn, checked by preflight.
    expect(manifest.engines).toEqual({ bun: ">=1.3.14" })
    expect(manifest.os).toEqual(["darwin", "linux"])
    expect(manifest.dependencies).toEqual({
      "@arethetypeswrong/cli": "0.18.5",
      pnpm: "9.15.9",
      publint: "0.3.24",
      verdaccio: "6.10.2",
    })
    expect(manifest.files).toEqual(["bin", "src", "dist", "LICENSE", "README.md"])
    // dist is built by prepack; every other listed path is checked in.
    for (const path of manifest.files ?? []) if (path !== "dist") expect(existsSync(join(ROOT, path))).toBe(true)

    const binPath = join(ROOT, manifest.bin!["verify-publishable"]!)
    accessSync(binPath, constants.X_OK)
    expect(readFileSync(binPath, "utf8")).toMatch(
      /^#!\/usr\/bin\/env bun\n\nimport \{ runCli \} from "\.\.\/src\/cli\.ts"/,
    )
  })

  /**
   * @failure The registry tarball points its bin or ./runtime export at TypeScript source or at files the build
   * does not emit, so a registry consumer cannot run the verifier or import its rule.
   * @level l0
   * @consumer every registry consumer of verify-publishable, and km-infra's vendor-kit (./runtime)
   */
  test("publishes a built Bun bin and a typed ./runtime export from dist", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      private?: boolean
      version?: string
      exports?: Record<string, unknown>
      publishConfig?: { access?: string; bin?: Record<string, string>; exports?: Record<string, unknown> }
      scripts?: Record<string, string>
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.publishConfig).toEqual({
      access: "public",
      bin: { "verify-publishable": "./dist/bin.js" },
      exports: { "./runtime": { types: "./dist/runtime.d.ts", import: "./dist/runtime.js" } },
    })
    expect(Object.keys(manifest.exports ?? {})).toEqual(Object.keys(manifest.publishConfig?.exports ?? {}))
    expect(manifest.scripts?.prepack).toBe("bun run build")
    expect(readFileSync(join(ROOT, "src", "bin.ts"), "utf8")).toMatch(
      /^#!\/usr\/bin\/env bun\n\nimport \{ runCli \} from "\.\/cli\.ts"/,
    )
  })
})
