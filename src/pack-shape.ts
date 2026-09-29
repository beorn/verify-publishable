/** The manifest and file list extracted from the same tarball after publishConfig was applied. */
export interface PackedArtifact {
  manifest: Record<string, unknown>
  entries: ReadonlySet<string>
}

export interface PackShapeFinding {
  field: string
  target: string
  kind: "missing" | "typescript-source"
}

interface Entry {
  field: string
  target: string
}

const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/u
const DECLARATION = /\.d\.(?:ts|mts|cts)$/u

function stringEntry(field: string, value: unknown): Entry[] {
  return typeof value === "string" ? [{ field, target: value }] : []
}

function exportEntries(field: string, value: unknown): Entry[] {
  if (typeof value === "string") return [{ field, target: value }]
  if (Array.isArray(value)) return value.flatMap((child, index) => exportEntries(`${field}[${index}]`, child))
  if (value === null || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, child]) =>
    exportEntries(
      field === "exports" || field === "imports" ? `${field}[${JSON.stringify(key)}]` : `${field}.${key}`,
      child,
    ),
  )
}

function manifestEntries(manifest: Record<string, unknown>): Entry[] {
  const bin =
    typeof manifest.bin === "string"
      ? stringEntry("bin", manifest.bin)
      : manifest.bin !== null && typeof manifest.bin === "object" && !Array.isArray(manifest.bin)
        ? Object.entries(manifest.bin).flatMap(([key, value]) =>
            stringEntry(/^[a-z_$][\w$]*$/iu.test(key) ? `bin.${key}` : `bin[${JSON.stringify(key)}]`, value),
          )
        : []
  return [
    ...stringEntry("main", manifest.main),
    ...stringEntry("module", manifest.module),
    ...stringEntry("browser", manifest.browser),
    ...stringEntry("types", manifest.types),
    ...stringEntry("typings", manifest.typings),
    ...bin,
    ...exportEntries("exports", manifest.exports),
    ...exportEntries("imports", manifest.imports).filter(({ target }) => target.startsWith("./")),
  ]
}

/** Enumerate every file target without claiming a wildcard pattern names one particular file. */
export function packShapeFindings(artifact: PackedArtifact): PackShapeFinding[] {
  const findings: PackShapeFinding[] = []
  for (const { field, target } of manifestEntries(artifact.manifest)) {
    if (TYPESCRIPT_SOURCE.test(target) && !DECLARATION.test(target)) {
      findings.push({ field, target, kind: "typescript-source" })
    } else if (!target.includes("*") && !artifact.entries.has(target.replace(/^\.\//u, ""))) {
      findings.push({ field, target, kind: "missing" })
    }
  }
  return findings
}

export function assertPackShape(packageName: string, artifact: PackedArtifact): void {
  const findings = packShapeFindings(artifact)
  if (findings.length === 0) return
  throw new Error(`PACK_SHAPE_INVALID: package=${packageName} findings=${JSON.stringify(findings)}`)
}
