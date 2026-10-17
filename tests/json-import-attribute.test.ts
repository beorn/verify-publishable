/**
 * @failure Node 22 refuses a bare import of a JSON export (ERR_IMPORT_ATTRIBUTE_MISSING) while the
 * fresh-consumer probe imported every literal subpath with no import attribute.
 * @level l0
 * @consumer probeFreshConsumer import phases under Node and Bun
 * @testonly none
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import { expect, test } from "vitest"

import { exportContract, packShapeFindings } from "../src/pack-shape.ts"
import { CONSUMER_IMPORT_EVAL, consumerImports } from "../src/probes.ts"

const consumerRoot = "/hh/var/@adhoc1/json-import-consumer"

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
  { name: "node", command: "/usr/bin/node" },
  { name: "bun", command: "/home/hh/.local/bin/bun" },
] as const

test.each(runtimes)("$name imports a json-only subpath with the attribute and a js subpath bare", ({ name: runtime, command }) => {
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
})
