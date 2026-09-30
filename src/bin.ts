#!/usr/bin/env bun

import { runCli } from "./cli.ts"

process.exitCode = await runCli()
