import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

const root = import.meta.dirname

await mkdir(join(root, "dist"), { recursive: true })
await writeFile(join(root, "dist/index.js"), 'export const fixtureRoot = "built"\n')
await writeFile(join(root, "dist/index.d.ts"), 'export declare const fixtureRoot: "built"\n')

for (const name of ["internal", "public"]) {
  const packageRoot = join(root, "packages", name)
  await mkdir(join(packageRoot, "dist"), { recursive: true })
  await copyFile(join(packageRoot, "src/index.js"), join(packageRoot, "dist/index.js"))
  await copyFile(join(packageRoot, "src/index.d.ts"), join(packageRoot, "dist/index.d.ts"))
}

const publicRoot = join(root, "packages/public")
await copyFile(join(publicRoot, "src/cli.js"), join(publicRoot, "dist/cli.js"))
await chmod(join(publicRoot, "dist/cli.js"), 0o755)
