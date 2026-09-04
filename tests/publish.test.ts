import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test, vi } from "vitest"

import type { CommandResult, CommandSpec } from "../src/process.ts"
import { CommandFailure } from "../src/process.ts"
import { publishTarballs } from "../src/publish.ts"

const roots: string[] = []

function setup() {
  const root = mkdtempSync(join(tmpdir(), "verify-publishable-publish-"))
  roots.push(root)
  const npmrcPath = join(root, ".npmrc")
  writeFileSync(npmrcPath, "registry=http://127.0.0.1:4873\n")
  const tarballs = ["a.tgz", "b.tgz"].map((name) => {
    const path = join(root, name)
    writeFileSync(path, name)
    return path
  })
  const pnpmRoot = join(root, "pnpm")
  mkdirSync(pnpmRoot)
  const pnpmBin = join(pnpmRoot, "pnpm.cjs")
  writeFileSync(pnpmBin, "")
  return { root, npmrcPath, tarballs, pnpmBin }
}

function success(): CommandResult {
  return { status: 0, signal: null, durationMs: 1, stdout: "published", stderr: "" }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("local tarball publication", () => {
  /**
   * @failure Publication repacks a package directory or consults an ambient registry,
   * so probes do not consume the immutable tarball that earlier gates checked.
   * @level l0
   * @consumer local registry publication
   */
  test("publishes each exact tarball with the owned pnpm binary and isolated npmrc", async () => {
    const { root, npmrcPath, tarballs, pnpmBin } = setup()
    const run = vi.fn(async (_spec: CommandSpec) => success())

    await publishTarballs(
      [
        { name: "@fixture/a", version: "1.0.0", tarballPath: tarballs[0]!, cwd: root },
        { name: "@fixture/b", version: "1.0.0", tarballPath: tarballs[1]!, cwd: root },
      ],
      {
        nodePath: "/tools/node",
        pnpm: { packageName: "pnpm", version: "9.15.9", manifestPath: "/tools/pnpm/package.json", binPath: pnpmBin },
        registryUrl: "http://127.0.0.1:4873",
        npmrcPath,
        run,
      },
    )

    expect(run.mock.calls.map(([spec]) => spec.args)).toEqual([
      [pnpmBin, "publish", tarballs[0], "--registry", "http://127.0.0.1:4873", "--no-git-checks", "--access", "public"],
      [pnpmBin, "publish", tarballs[1], "--registry", "http://127.0.0.1:4873", "--no-git-checks", "--access", "public"],
    ])
    expect(run.mock.calls[0]![0].env).toMatchObject({
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:4873",
      NPM_CONFIG_USERCONFIG: npmrcPath,
    })
  })

  /**
   * @failure A failed publication is logged but later install probes continue and report
   * an unrelated missing-package error.
   * @level l0
   * @consumer publish phase ordering
   */
  test("stops on the first publish failure with package identity", async () => {
    const { root, npmrcPath, tarballs, pnpmBin } = setup()
    const failure = new CommandFailure({
      phase: "publish:@fixture/a",
      command: ["/tools/node", pnpmBin],
      cwd: root,
      status: 19,
      signal: null,
      durationMs: 2,
      stdout: "",
      stderr: "PUBLISH_SENTINEL",
    })
    const run = vi.fn(async () => {
      throw failure
    })

    await expect(
      publishTarballs([{ name: "@fixture/a", version: "1.0.0", tarballPath: tarballs[0]!, cwd: root }], {
        nodePath: "/tools/node",
        pnpm: { packageName: "pnpm", version: "9.15.9", manifestPath: "/tools/pnpm/package.json", binPath: pnpmBin },
        registryUrl: "http://127.0.0.1:4873",
        npmrcPath,
        run,
      }),
    ).rejects.toBe(failure)
    expect(run).toHaveBeenCalledTimes(1)
  })

  test("refuses a non-loopback registry before invoking pnpm", async () => {
    const { root, npmrcPath, tarballs, pnpmBin } = setup()
    const run = vi.fn(async () => success())

    await expect(
      publishTarballs([{ name: "fixture", version: "1.0.0", tarballPath: tarballs[0]!, cwd: root }], {
        nodePath: "/tools/node",
        pnpm: { packageName: "pnpm", version: "9.15.9", manifestPath: "/tools/pnpm/package.json", binPath: pnpmBin },
        registryUrl: "https://registry.npmjs.org",
        npmrcPath,
        run,
      }),
    ).rejects.toThrow(/LOCAL_REGISTRY_REQUIRED.*registry\.npmjs\.org/i)
    expect(run).not.toHaveBeenCalled()
  })

  /**
   * @failure Registry URL components are silently removed when the URL is reduced
   * to its origin, so the verifier appears to honor configuration that it ignored.
   * @level l0
   * @consumer local registry publication
   */
  test.each([
    ["path", "http://127.0.0.1:4873/private"],
    ["query", "http://127.0.0.1:4873?token=secret"],
    ["hash", "http://127.0.0.1:4873#private"],
  ])("refuses a loopback registry URL containing a non-root %s", async (_component, registryUrl) => {
    const { root, npmrcPath, tarballs, pnpmBin } = setup()
    const run = vi.fn(async () => success())

    await expect(
      publishTarballs([{ name: "fixture", version: "1.0.0", tarballPath: tarballs[0]!, cwd: root }], {
        nodePath: "/tools/node",
        pnpm: { packageName: "pnpm", version: "9.15.9", manifestPath: "/tools/pnpm/package.json", binPath: pnpmBin },
        registryUrl,
        npmrcPath,
        run,
      }),
    ).rejects.toThrow(/LOCAL_REGISTRY_INVALID.*path, query, or hash/i)
    expect(run).not.toHaveBeenCalled()
  })
})
