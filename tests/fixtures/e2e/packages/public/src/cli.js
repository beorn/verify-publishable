#!/usr/bin/env node

if (process.argv[2] !== "--help") {
  console.error("expected --help")
  process.exitCode = 2
} else {
  console.log("Usage: verify-publishable-e2e")
}
