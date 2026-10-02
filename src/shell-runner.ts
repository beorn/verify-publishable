import { $ } from "bun"

const command = process.argv[2]
if (command === undefined || command.trim() === "") {
  console.error("verify-publishable shell runner requires one non-empty command argument")
  process.exitCode = 2
} else {
  const result = await $`${{ raw: command }}`.nothrow()
  process.exitCode = result.exitCode
}
