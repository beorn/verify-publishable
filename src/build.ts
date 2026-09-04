import { fileURLToPath } from "node:url"

import type { DiscoveredPackage, RepositoryPlan } from "./discovery.ts"
import { runCommand } from "./process.ts"

export interface ConfiguredBuildStep {
  kind: "configured"
  cwd: string
  command: string
}

export interface ScriptBuildStep {
  kind: "script"
  cwd: string
  package: string
  script: "build"
}

export type BuildStep = ConfiguredBuildStep | ScriptBuildStep
export type BuildMode = "skipped" | "configured" | "root-script" | "package-scripts"

export interface BuildPlan {
  mode: BuildMode
  steps: BuildStep[]
}

function buildScript(pkg: DiscoveredPackage): string | undefined {
  const scripts = pkg.manifest.scripts
  if (scripts === undefined || scripts === null || typeof scripts !== "object" || Array.isArray(scripts))
    return undefined
  const build = scripts.build
  return typeof build === "string" && build.trim() !== "" ? build : undefined
}

export function planBuild(plan: RepositoryPlan, options: { noBuild: boolean }): BuildPlan {
  if (options.noBuild) return { mode: "skipped", steps: [] }
  if (plan.config.build !== undefined) {
    return { mode: "configured", steps: [{ kind: "configured", cwd: plan.root, command: plan.config.build }] }
  }

  const rootPackage = plan.packages.find((pkg) => pkg.relativeDir === ".")
  if (rootPackage !== undefined && buildScript(rootPackage) !== undefined) {
    return {
      mode: "root-script",
      steps: [{ kind: "script", cwd: plan.root, package: rootPackage.name, script: "build" }],
    }
  }

  const uncovered = plan.publicPackages.filter((pkg) => buildScript(pkg) === undefined).map(({ name }) => name)
  if (uncovered.length > 0) {
    throw new Error(
      `public packages have no build script and no root/configured build covers them: packages=${JSON.stringify(uncovered)}`,
    )
  }
  const steps: ScriptBuildStep[] = plan.packages
    .filter((pkg) => pkg.relativeDir !== "." && buildScript(pkg) !== undefined)
    .map((pkg) => ({ kind: "script", cwd: pkg.dir, package: pkg.name, script: "build" }))
  return { mode: "package-scripts", steps }
}

const SHELL_RUNNER = fileURLToPath(new URL("./shell-runner.ts", import.meta.url))

export async function executeBuild(
  repository: RepositoryPlan,
  options: { noBuild?: boolean; bunPath?: string } = {},
): Promise<BuildPlan> {
  const plan = planBuild(repository, { noBuild: options.noBuild ?? false })
  const bunPath = options.bunPath ?? process.execPath
  for (const step of plan.steps) {
    if (step.kind === "configured") {
      await runCommand({
        phase: "build",
        command: bunPath,
        args: [SHELL_RUNNER, step.command],
        cwd: step.cwd,
        timeoutMs: 10 * 60_000,
      })
    } else {
      await runCommand({
        phase: "build",
        command: bunPath,
        args: ["run", step.script],
        cwd: step.cwd,
        timeoutMs: 10 * 60_000,
      })
    }
  }
  return plan
}
