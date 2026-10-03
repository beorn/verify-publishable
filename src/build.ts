import { fileURLToPath } from "node:url"
import { StringDecoder } from "node:string_decoder"
import type { Writable } from "node:stream"

import type { RepositoryPlan } from "./discovery.ts"
import { CommandFailure, runCommand } from "./process.ts"

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

const MAX_LINE_BYTES = 8 * 1024
const LIVE_SINK_FLUSH_MS = 250

export interface LiveOutputLoss {
  stoppedAt: string
  diagnostic: string
}

interface LiveDestinationState {
  loss?: LiveOutputLoss
  activeStep?: string
}

// The destination owns its error channel for its lifetime; individual build steps never do.
const liveDestinations = new WeakMap<Writable, LiveDestinationState>()
function recordLoss(state: LiveDestinationState, stoppedAt: string, diagnostic: string): void {
  state.loss ??= { stoppedAt, diagnostic }
}
function liveDestination(destination: Writable): LiveDestinationState {
  let state = liveDestinations.get(destination)
  if (state === undefined) {
    state = {}
    destination.on("error", (error: Error) => {
      recordLoss(state!, state!.activeStep ?? "after build", `live output stopped: ${error.message}`)
    })
    liveDestinations.set(destination, state)
  }
  return state
}
export function readLiveOutputLoss(destination: Writable = process.stderr): LiveOutputLoss | undefined {
  const loss = liveDestination(destination).loss
  return loss === undefined ? undefined : { ...loss }
}

function splitUtf8Prefix(value: string, maxBytes: number): [string, string] {
  let end = 0
  let bytes = 0
  for (const character of value) {
    const next = Buffer.byteLength(character)
    if (bytes + next > maxBytes) break
    bytes += next
    end += character.length
  }
  return [value.slice(0, end), value.slice(end)]
}

/** Forward build output without allowing a slow diagnostic stream to buffer the child indefinitely. */
export function createLiveSink(destination: Writable, label: string) {
  const state = liveDestination(destination)
  state.activeStep = label
  const streams = {
    stdout: { decoder: new StringDecoder("utf8"), carry: "" },
    stderr: { decoder: new StringDecoder("utf8"), carry: "" },
  }
  let paused = false
  let droppedBytes = 0
  let pendingWrites = 0
  let wakeFinish: (() => void) | undefined
  let listeningForDrain = false
  const signal = () => {
    wakeFinish?.()
    wakeFinish = undefined
  }
  const drain = () => {
    listeningForDrain = false
    paused = false
    if (droppedBytes > 0 && state.loss === undefined) {
      const count = droppedBytes
      droppedBytes = 0
      write(`live output: ${count} bytes dropped during backpressure`)
    }
    signal()
  }
  const write = (line: string) => {
    if (state.loss !== undefined || paused) return
    try {
      pendingWrites++
      const accepted = destination.write(`[${label}] ${line}\n`, (error) => {
        pendingWrites--
        if (error !== undefined && error !== null) {
          recordLoss(state, label, `live output stopped: ${error.message}`)
        }
        signal()
      })
      if (!accepted && state.loss === undefined) {
        paused = true
        if (!listeningForDrain) {
          destination.once("drain", drain)
          listeningForDrain = true
        }
      }
    } catch (error) {
      pendingWrites--
      recordLoss(state, label, `live output stopped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    start(cwd: string, budgetMs: number) {
      write(`start; cwd=${JSON.stringify(cwd)}; budgetMs=${budgetMs}`)
    },
    onOutput(stream: "stdout" | "stderr", chunk: Buffer) {
      if (state.loss !== undefined) return
      if (paused) {
        droppedBytes += chunk.byteLength
        return
      }
      const part = streams[stream]
      part.carry += part.decoder.write(chunk)
      let newline = part.carry.indexOf("\n")
      while (newline >= 0 && !paused && state.loss === undefined) {
        write(`${stream}: ${part.carry.slice(0, newline).replace(/\r$/, "")}`)
        part.carry = part.carry.slice(newline + 1)
        newline = part.carry.indexOf("\n")
      }
      while (Buffer.byteLength(part.carry) > MAX_LINE_BYTES && !paused && state.loss === undefined) {
        const [prefix, rest] = splitUtf8Prefix(part.carry, MAX_LINE_BYTES)
        write(`${stream}: ${prefix}`)
        part.carry = rest
      }
      if (paused && part.carry.length > 0) {
        droppedBytes += Buffer.byteLength(part.carry)
        part.carry = ""
      }
      const loss = readLiveOutputLoss(destination)
      if (loss !== undefined) throw new Error(loss.diagnostic.replace(/^live output stopped: /, ""))
    },
    async finish() {
      for (const stream of ["stdout", "stderr"] as const) {
        const part = streams[stream]
        part.carry += part.decoder.end()
        if (part.carry.length > 0) {
          if (paused) droppedBytes += Buffer.byteLength(part.carry)
          else write(`${stream}: ${part.carry}`)
        }
      }
      if (droppedBytes > 0 && !paused && state.loss === undefined) {
        const count = droppedBytes
        droppedBytes = 0
        write(`live output: ${count} bytes dropped during backpressure`)
      }
      const deadline = performance.now() + LIVE_SINK_FLUSH_MS
      while (state.loss === undefined && pendingWrites > 0 && performance.now() < deadline) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(
            () => {
              wakeFinish = undefined
              resolve()
            },
            Math.max(1, deadline - performance.now()),
          )
          wakeFinish = wake
        })
      }
      if (droppedBytes > 0)
        recordLoss(
          state,
          label,
          `live output stopped: ${droppedBytes} bytes dropped during backpressure without stderr drain`,
        )
      if (pendingWrites > 0)
        recordLoss(state, label, `live output stopped: stderr flush pending after ${LIVE_SINK_FLUSH_MS}ms`)
      if (listeningForDrain) destination.off("drain", drain)
      listeningForDrain = false
      wakeFinish = undefined
      if (state.activeStep === label) delete state.activeStep
      return state.loss?.diagnostic
    },
  }
}

export interface BuildPlan {
  mode: BuildMode
  steps: BuildStep[]
}

function buildScript(manifest: Record<string, unknown>): string | undefined {
  const scripts = manifest.scripts
  if (scripts === undefined || scripts === null || typeof scripts !== "object" || Array.isArray(scripts))
    return undefined
  const build = (scripts as Record<string, unknown>).build
  return typeof build === "string" && build.trim() !== "" ? build : undefined
}

export function planBuild(plan: RepositoryPlan, options: { noBuild: boolean }): BuildPlan {
  if (options.noBuild) return { mode: "skipped", steps: [] }
  if (plan.config.build !== undefined) {
    return { mode: "configured", steps: [{ kind: "configured", cwd: plan.root, command: plan.config.build }] }
  }

  const rootPackage = plan.packages.find((pkg) => pkg.relativeDir === ".")
  if (buildScript(plan.rootManifest) !== undefined) {
    return {
      mode: "root-script",
      steps: [{ kind: "script", cwd: plan.root, package: rootPackage?.name ?? "repository root", script: "build" }],
    }
  }

  const uncovered = plan.publicPackages.filter((pkg) => buildScript(pkg.manifest) === undefined).map(({ name }) => name)
  if (uncovered.length > 0) {
    throw new Error(
      `public packages have no build script and no root/configured build covers them: packages=${JSON.stringify(uncovered)}`,
    )
  }
  const steps: ScriptBuildStep[] = plan.packages
    .filter((pkg) => pkg.relativeDir !== "." && buildScript(pkg.manifest) !== undefined)
    .map((pkg) => ({ kind: "script", cwd: pkg.dir, package: pkg.name, script: "build" }))
  return { mode: "package-scripts", steps }
}

// The runner sits beside this module: shell-runner.ts in the source tree, shell-runner.js in the published dist.
const SHELL_RUNNER = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "./shell-runner.ts" : "./shell-runner.js", import.meta.url),
)

export async function executeBuild(
  repository: RepositoryPlan,
  options: { noBuild?: boolean; bunPath?: string } = {},
): Promise<BuildPlan> {
  const plan = planBuild(repository, { noBuild: options.noBuild ?? false })
  const bunPath = options.bunPath ?? process.execPath
  for (const step of plan.steps) {
    const label =
      step.kind === "configured"
        ? `configured command ${JSON.stringify(step.command)}`
        : `${step.package} ${step.script}`
    const args = step.kind === "configured" ? [SHELL_RUNNER, step.command] : ["run", step.script]
    const budget = repository.config.buildTimeoutMs
    const sink = createLiveSink(process.stderr, label)
    sink.start(step.cwd, budget)
    try {
      await runCommand({
        phase: "build",
        command: bunPath,
        args,
        cwd: step.cwd,
        timeoutMs: budget,
        onOutput: sink.onOutput,
      })
    } catch (error) {
      const sinkDiagnostic = await sink.finish()
      if (error instanceof Error) {
        const alreadyReported = error instanceof CommandFailure && error.liveOutputDiagnostic === sinkDiagnostic
        error.message += `; buildStep=${JSON.stringify(label)}; budgetMs=${budget}; retained tail, last 1048576 bytes (stdout/stderr above)${sinkDiagnostic === undefined || alreadyReported ? "" : `; ${sinkDiagnostic}`}`
      }
      throw error
    }
    await sink.finish()
  }
  return plan
}
