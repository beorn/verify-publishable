/**
 * @failure The isolated registry proxies local packages to npmjs while publishing, so a repository whose current
 * version is already released gets E409 "this package is already present" and the gate is red on every push after a
 * release (beorn/termless Verify Publishable, 2026-09-09 onward); or the probe registry serves the uplink's
 * same-version bytes and the probe judges a tarball nobody packed.
 * @level l2
 * @consumer verifyRepository's publish and probe phases
 */

import { createHash } from "node:crypto"
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { startRegistry, type StartedRegistry } from "../src/registry.ts"
import { assertServedIntegrity, tarballIntegrity } from "../src/served-integrity.ts"

const NAME = "fixture-package"
const VERSION = "1.0.0"
const roots: string[] = []
const registries: StartedRegistry[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.stop()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "verify-publishable-phases-test-"))
  roots.push(root)
  return root
}

/** A real npm tarball for NAME@VERSION whose bytes differ by `marker`. */
function packTarball(root: string, marker: string): string {
  const source = join(root, `src-${marker}`, "package")
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: NAME, version: VERSION, description: marker }))
  const tarball = join(root, `${NAME}-${marker}.tgz`)
  const result = Bun.spawnSync(["tar", "-czf", tarball, "-C", join(root, `src-${marker}`), "package"])
  if (!result.success) throw new Error(`fixture tar failed: ${result.stderr.toString()}`)
  return tarball
}

function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`
}

/** The fake upstream: npmjs already holding NAME@VERSION with other bytes, the case that stood since 09-09. */
async function fakeUpstream(bytes: Buffer): Promise<string> {
  let base = ""
  const server = createServer((request, response) => {
    if (request.url === `/${NAME}`) {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          name: NAME,
          "dist-tags": { latest: VERSION },
          versions: {
            [VERSION]: {
              name: NAME,
              version: VERSION,
              dist: {
                tarball: `${base}/${NAME}/-/${NAME}-${VERSION}.tgz`,
                shasum: createHash("sha1").update(bytes).digest("hex"),
                integrity: integrityOf(bytes),
              },
            },
          },
        }),
      )
      return
    }
    if (request.url === `/${NAME}/-/${NAME}-${VERSION}.tgz`) {
      response.end(bytes)
      return
    }
    response.statusCode = 404
    response.end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fake upstream has no TCP address")
  base = `http://127.0.0.1:${address.port}`
  return `${base}/`
}

/** Publish NAME@VERSION the way npm does: one PUT carrying the version and its tarball attachment. */
async function publish(registryUrl: string, bytes: Buffer): Promise<Response> {
  const filename = `${NAME}-${VERSION}.tgz`
  return fetch(`${registryUrl}/${NAME}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: "Bearer anonymous" },
    body: JSON.stringify({
      _id: NAME,
      name: NAME,
      "dist-tags": { latest: VERSION },
      versions: {
        [VERSION]: {
          name: NAME,
          version: VERSION,
          _id: `${NAME}@${VERSION}`,
          dist: {
            tarball: `${registryUrl}/${NAME}/-/${filename}`,
            shasum: createHash("sha1").update(bytes).digest("hex"),
            integrity: integrityOf(bytes),
          },
        },
      },
      _attachments: {
        [filename]: { content_type: "application/octet-stream", data: bytes.toString("base64"), length: bytes.length },
      },
    }),
  })
}

describe("registry phases against an upstream that already holds the local version", () => {
  test("the proxied configuration reproduces the 409 the publish phase exists to avoid", async () => {
    const root = temporaryDirectory()
    const local = readFileSync(packTarball(root, "local"))
    const uplinkUrl = await fakeUpstream(readFileSync(packTarball(root, "upstream")))
    const proxied = await startRegistry({ cwd: root, localPackageNames: [NAME], phase: "probe", uplinkUrl })
    registries.push(proxied)

    const response = await publish(proxied.url, local)

    expect(response.status, await response.text()).toBe(409)
  })

  test("publish phase accepts the version, and the probe phase serves the LOCAL bytes for it", async () => {
    const root = temporaryDirectory()
    const localPath = packTarball(root, "local")
    const local = readFileSync(localPath)
    const upstream = readFileSync(packTarball(root, "upstream"))
    const uplinkUrl = await fakeUpstream(upstream)

    const publishRegistry = await startRegistry({ cwd: root, localPackageNames: [NAME], phase: "publish", uplinkUrl })
    registries.push(publishRegistry)
    expect(readFileSync(publishRegistry.configPath, "utf8")).not.toMatch(/"fixture-package":\n(?:    .*\n)*?    proxy:/)
    const published = await publish(publishRegistry.url, local)
    expect(published.status, await published.text()).toBe(201)

    const stateRoot = await publishRegistry.handoff()
    const probeRegistry = await startRegistry({
      cwd: root,
      localPackageNames: [NAME],
      phase: "probe",
      stateRoot,
      uplinkUrl,
    })
    registries.push(probeRegistry)
    expect(readFileSync(probeRegistry.configPath, "utf8")).toMatch(/"fixture-package":\n(?:    .*\n)*?    proxy: npmjs/)

    const expected = [{ name: NAME, version: VERSION, integrity: await tarballIntegrity(localPath) }]
    expect(expected[0]!.integrity).not.toBe(integrityOf(upstream))
    await expect(assertServedIntegrity(probeRegistry.url, expected)).resolves.toBeUndefined()
    const served = await fetch(`${probeRegistry.url}/${NAME}/-/${NAME}-${VERSION}.tgz`)
    expect(Buffer.from(await served.arrayBuffer()).equals(local)).toBe(true)
  })

  test("a served same-version integrity that differs from local storage refuses with both hashes", async () => {
    const metadata = { versions: { [VERSION]: { dist: { integrity: "sha512-UPSTREAM" } } } }
    const fakeFetch = async () => new Response(JSON.stringify(metadata), { status: 200 })

    await expect(
      assertServedIntegrity(
        "http://127.0.0.1:1",
        [{ name: NAME, version: VERSION, integrity: "sha512-LOCAL" }],
        fakeFetch,
      ),
    ).rejects.toThrow(
      `LOCAL_ARTIFACT_CONTRADICTED: package=${NAME}@${VERSION} local=sha512-LOCAL served=sha512-UPSTREAM`,
    )
  })
})
