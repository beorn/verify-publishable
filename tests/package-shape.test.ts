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
    expect(manifest.engines).toEqual({ bun: ">=1.3.14", node: ">=24 <25" })
    expect(manifest.os).toEqual(["darwin", "linux"])
    expect(manifest.dependencies).toEqual({
      "@arethetypeswrong/cli": "0.18.5",
      pnpm: "9.15.9",
      publint: "0.3.24",
      verdaccio: "6.10.2",
    })
    expect(manifest.files).toEqual(["bin", "src", "LICENSE", "README.md"])
    for (const path of manifest.files ?? []) expect(existsSync(join(ROOT, path))).toBe(true)

    const binPath = join(ROOT, manifest.bin!["verify-publishable"]!)
    accessSync(binPath, constants.X_OK)
    expect(readFileSync(binPath, "utf8")).toMatch(
      /^#!\/usr\/bin\/env bun\n\nimport \{ runCli \} from "\.\.\/src\/cli\.ts"/,
    )
  })
})
