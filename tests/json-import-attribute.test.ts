/**
 * @failure Node 22 refuses a bare import of a JSON export (ERR_IMPORT_ATTRIBUTE_MISSING) while the
 * fresh-consumer probe imported every literal subpath with no import attribute.
 * @level l1
 * @consumer probeFreshConsumer import phases under Node and Bun
 * @testonly none
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import { afterEach, expect, test } from "vitest"

import { exportContract, packShapeFindings } from "../src/pack-shape.ts"
import { findHostExecutable } from "../src/preflight.ts"
import { CONSUMER_IMPORT_EVAL, consumerImports } from "../src/probes.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function hostRuntime(name: "node" | "bun"): string {
  // Mirrors tests/probes.test.ts: NODE_FOR_TESTS pins Node where PATH has none.
  const configured = name === "node" ? process.env.NODE_FOR_TESTS : undefined
  const resolved = configured === undefined ? findHostExecutable(name) : realpathSync(configured)
  if (resolved === null)
    throw new Error(`HOST_TOOL_MISSING: tool=${name} searched=PATH purpose=json-import-attribute tests`)
  return resolved
}

test("json import attribute is decided from export targets, not the subpath name", () => {
  const plans = consumerImports(
    "p",
    exportContract({
      exports: {
        ".": "./ok.js",
        "./package.json": "./package.json",
        "./meta": "./meta.json",
        "./not-json": "./ok.js",
        "./mixed": { import: "./ok.js", default: "./meta.json" },
      },
    }),
  )
  expect(plans).toEqual([
    { specifier: "p" },
    { specifier: "p/meta", with: { type: "json" } },
    { specifier: "p/mixed" },
    { specifier: "p/not-json" },
    { specifier: "p/package.json", with: { type: "json" } },
  ])
})

test("a json target missing from the tarball is still a pack-shape failure", () => {
  const findings = packShapeFindings({
    manifest: { exports: { "./package.json": "./package.json" } },
    entries: new Set(["readme.md"]),
  })
  expect(findings).toEqual([{ field: 'exports["./package.json"]', target: "./package.json", kind: "missing" }])
})

const runtimes = [
  { name: "node", command: hostRuntime("node") },
  { name: "bun", command: hostRuntime("bun") },
] as const

test.each(runtimes)(
  "$name imports a json-only subpath with the attribute and a js subpath bare",
  ({ name: runtime, command }) => {
    const consumerRoot = mkdtempSync(join(tmpdir(), "verify-publishable-json-import-"))
    roots.push(consumerRoot)
    const packageRoot = join(consumerRoot, "node_modules", "p")
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "p",
        type: "module",
        exports: { ".": "./ok.js", "./package.json": "./package.json", "./ok.js": "./ok.js" },
      }),
    )
    writeFileSync(join(packageRoot, "ok.js"), "export const ok = true\n")
    writeFileSync(join(consumerRoot, "package.json"), '{"private":true}\n')
    const plans = consumerImports(
      "p",
      exportContract({
        exports: { ".": "./ok.js", "./package.json": "./package.json", "./ok.js": "./ok.js" },
      }),
    )
    const args =
      runtime === "node"
        ? ["--input-type=module", "--eval", CONSUMER_IMPORT_EVAL, JSON.stringify(plans)]
        : ["--eval", CONSUMER_IMPORT_EVAL, JSON.stringify(plans)]
    const result = spawnSync(command, args, {
      cwd: consumerRoot,
      encoding: "utf8",
    })
    expect(result.status, result.stderr).toBe(0)
  },
)
