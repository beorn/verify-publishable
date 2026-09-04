import { $ } from "bun"

const command = process.argv[2]
if (command === undefined || command.trim() === "") {
  console.error("verify-publishable shell runner requires one non-empty command argument")
  process.exitCode = 2
} else {
  const result = await $`${{ raw: command }}`.quiet().nothrow()
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exitCode = result.exitCode
}
