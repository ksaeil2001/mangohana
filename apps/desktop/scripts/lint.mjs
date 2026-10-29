import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function runChecks(checks, run = spawnSync) {
  let failed = false;
  for (const args of checks) {
    const result = run(process.execPath, args, { stdio: "inherit" });
    if (result.error) console.error(result.error.message);
    if (result.error || result.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runChecks([
    ["node_modules/oxlint/bin/oxlint", "src/renderer"],
    ["scripts/lint-design-system.mjs"]
  ]);
}
