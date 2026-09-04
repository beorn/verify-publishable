import { CommandFailure } from "./process.ts"
import { ProbeFailure } from "./probes.ts"
import { RegistryRuntimeFailure, RegistryStartFailure } from "./registry.ts"
import { verifyRepository, type VerifyRepositoryOptions, type VerifyRepositoryResult } from "./verify.ts"

interface Writer {
  write(chunk: string): unknown
}

export interface FailureResult {
  code: string
  phase: string
  package?: string
  command: string[]
  cwd: string
  status: number | null
  signal: string | null
  stdout: string
  stderr: string
  detail: string
}

export interface CliOptions {
  argv?: string[]
  cwd?: string
  stdout?: Writer
  stderr?: Writer
  verify?: (options: VerifyRepositoryOptions) => Promise<VerifyRepositoryResult>
}

const SCHEMA = "verify-publishable/v1"

function phaseAndPackage(raw: string): { phase: string; package?: string } {
  const [rawPhase = "unknown", ...rest] = raw.split(":")
  const phase =
    rawPhase === "npm-pack-dry-run"
      ? "size"
      : rawPhase === "pnpm-pack"
        ? "pack"
        : rawPhase.startsWith("consumer-install") || rawPhase.startsWith("consumer-init")
          ? "install"
          : rawPhase.startsWith("import-")
            ? "import"
            : rawPhase.startsWith("bin-")
              ? "bin"
              : rawPhase.startsWith("consumer-check")
                ? "check"
                : rawPhase
  return { phase, ...(rest.length === 0 ? {} : { package: rest.join(":") }) }
}

function plainFailure(error: unknown, cwd: string): FailureResult {
  const detail = error instanceof Error ? error.message : String(error)
  const codeMatch = /^([A-Z][A-Z0-9_]+):/.exec(detail)
  return {
    code: codeMatch?.[1] ?? "VERIFY_FAILED",
    phase: "verify",
    command: [],
    cwd,
    status: null,
    signal: null,
    stdout: "",
    stderr: "",
    detail,
  }
}

function normalizeOne(error: unknown, cwd: string): FailureResult[] {
  if (error instanceof AggregateError) return [...error.errors].flatMap((nested) => normalizeOne(nested, cwd))
  if (error instanceof CommandFailure) {
    return [
      {
        code: "COMMAND_FAILED",
        ...phaseAndPackage(error.phase),
        command: error.command,
        cwd: error.cwd,
        status: error.status,
        signal: error.signal,
        stdout: error.stdout,
        stderr: error.stderr,
        detail: error.message,
      },
    ]
  }
  if (error instanceof ProbeFailure) {
    return [
      {
        code: "PROBE_FAILED",
        ...phaseAndPackage(error.phase),
        package: error.packageName,
        command: error.command,
        cwd: error.cwd,
        status: error.status,
        signal: null,
        stdout: error.stdout,
        stderr: error.stderr,
        detail: error.message,
      },
    ]
  }
  if (error instanceof RegistryStartFailure) {
    return [
      {
        code: "REGISTRY_START_FAILED",
        phase: "registry",
        command: error.command,
        cwd: error.cwd,
        status: error.status,
        signal: error.signal,
        stdout: error.stdout,
        stderr: error.stderr,
        detail: error.message,
      },
    ]
  }
  if (error instanceof RegistryRuntimeFailure) {
    return [
      {
        code: "REGISTRY_RUNTIME_FAILED",
        phase: "registry",
        command: error.command,
        cwd: error.cwd,
        status: error.status,
        signal: error.signal,
        stdout: error.stdout,
        stderr: error.stderr,
        detail: error.message,
      },
    ]
  }
  return [plainFailure(error, cwd)]
}

function writeFailureDiagnostics(stderr: Writer, failures: FailureResult[]): void {
  for (const failure of failures) {
    stderr.write(`verify-publishable ${failure.phase} failure: ${failure.detail}\n`)
    if (failure.stdout !== "") stderr.write(`child stdout:\n${failure.stdout}\n`)
    if (failure.stderr !== "") stderr.write(`child stderr:\n${failure.stderr}\n`)
  }
}

export async function runCli(options: CliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2)
  const cwd = options.cwd ?? process.cwd()
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const verify = options.verify ?? verifyRepository
  const unknown = argv.filter((argument) => !["--help", "--keep", "--no-build"].includes(argument))
  if (unknown.length > 0) {
    const failure: FailureResult = {
      code: "USAGE",
      phase: "preflight",
      command: ["verify-publishable", ...argv],
      cwd,
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      detail: `unknown arguments: ${JSON.stringify(unknown)}; accepted=["--help","--keep","--no-build"]`,
    }
    stderr.write(`${failure.detail}\n`)
    stdout.write(`${JSON.stringify({ schema: SCHEMA, ok: false, failures: [failure] })}\n`)
    return 2
  }
  if (argv.includes("--help")) {
    stdout.write(
      `${JSON.stringify({ schema: SCHEMA, ok: true, help: { usage: "verify-publishable [--no-build] [--keep]" } })}\n`,
    )
    return 0
  }

  try {
    const result = await verify({ root: cwd, noBuild: argv.includes("--no-build"), keep: argv.includes("--keep") })
    stdout.write(`${JSON.stringify({ schema: SCHEMA, ok: true, ...result })}\n`)
    return 0
  } catch (error) {
    const failures = normalizeOne(error, cwd)
    writeFailureDiagnostics(stderr, failures)
    stdout.write(`${JSON.stringify({ schema: SCHEMA, ok: false, failures })}\n`)
    return 1
  }
}
