/**
 * @failure A package passes Publint and sampled imports while an unexercised packed entry points at missing output or TypeScript source.
 * @level l1
 * @consumer release verification and owning CI publication
 */

import { expect, test } from "vitest"

import { packShapeFindings } from "../src/pack-shape.ts"

test("built exports and declarations present in the packed file list have no findings", () => {
  const manifest = {
    exports: { ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" } },
    types: "./dist/index.d.ts",
  }
  const entries = new Set(["package.json", "dist/index.d.mts", "dist/index.mjs", "dist/index.d.ts", "src/unused.ts"])
  expect(packShapeFindings({ manifest, entries })).toEqual([])
})

test("every literal entry field is checked against the packed file list", () => {
  const manifest = {
    main: "./dist/main.cjs",
    module: "./dist/module.mjs",
    browser: "./dist/browser.mjs",
    types: "./dist/types.d.ts",
    typings: "./dist/typings.d.ts",
    bin: { app: "./dist/app.mjs" },
    exports: { ".": { import: "./dist/export.mjs" } },
    imports: { "#local": "./dist/internal.mjs", "#external": "dependency" },
  }
  const findings = packShapeFindings({ manifest, entries: new Set(["package.json"]) })
  expect(findings.map(({ field }) => field)).toEqual([
    "main",
    "module",
    "browser",
    "types",
    "typings",
    "bin.app",
    'exports["."].import',
    'imports["#local"]',
  ])
  expect(findings.every(({ kind }) => kind === "missing")).toBe(true)
})

test("nested exports, local imports, bins and patterns refuse shipped TypeScript source", () => {
  const manifest = {
    exports: { ".": { browser: { import: "./src/browser.tsx" } }, "./raw/*": "./src/*.mts" },
    imports: { "#internal": "./src/internal.cts" },
    bin: "./src/cli.ts",
  }
  const entries = new Set(["package.json", "src/browser.tsx", "src/internal.cts", "src/cli.ts"])
  expect(packShapeFindings({ manifest, entries })).toEqual([
    { field: "bin", target: "./src/cli.ts", kind: "typescript-source" },
    { field: 'exports["."].browser.import', target: "./src/browser.tsx", kind: "typescript-source" },
    { field: 'exports["./raw/*"]', target: "./src/*.mts", kind: "typescript-source" },
    { field: 'imports["#internal"]', target: "./src/internal.cts", kind: "typescript-source" },
  ])
})

test("a pattern has no literal presence verdict; null and non-path leaves are ignored", () => {
  const manifest = {
    exports: { "./*": "./dist/*.mjs", "./blocked": null, "./odd": 42 },
    imports: { "#dependency": "dependency" },
  }
  expect(packShapeFindings({ manifest, entries: new Set(["package.json"]) })).toEqual([])
})
