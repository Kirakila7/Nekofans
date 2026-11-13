// Compare the full regression run against the checked-in known-failure baseline.
// Only NEW failures fail the command; fixed entries are reported and can be pruned with --update.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineFile = join(root, "tests", "regression-baseline.json");
const domDeps = process.env.NEKO_DOM_DEPS || (existsSync(join(root, "node_modules", "jsdom")) ? root : null);
const environment = { ...process.env };
if (domDeps) environment.NEKO_DOM_DEPS = domDeps;

const run = spawnSync(process.execPath, [join(root, "scripts", "test-v1.mjs")], {
  cwd: root, env: environment, encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
});
const output = `${run.stdout || ""}\n${run.stderr || ""}`;
process.stdout.write(output);
const failures = [...output.matchAll(/^✖ (.+?) \(\d+(?:\.\d+)?ms\)$/gm)].map((match) => match[1].trim());
const current = [...new Set(failures)].sort();
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
const known = [...baseline.knownFailures].sort();

if (process.argv.includes("--update")) {
  writeFileSync(baselineFile, JSON.stringify({ ...baseline, knownFailures: current }, null, 2) + "\n");
  console.log(`\n[test:regression] baseline updated with ${current.length} known failures.`);
  process.exitCode = 0;
} else {
  const added = current.filter((name) => !known.includes(name));
  const fixed = known.filter((name) => !current.includes(name));
  console.log(`\n[test:regression] current failures: ${current.length}; known baseline: ${known.length}`);
  if (fixed.length) console.log(`[test:regression] fixed since baseline (run --update to prune):\n  - ${fixed.join("\n  - ")}`);
  if (added.length) {
    console.error(`[test:regression] NEW failures:\n  - ${added.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log("[test:regression] no new failures.");
    process.exitCode = 0;
  }
}
