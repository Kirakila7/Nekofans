import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function nekoTestFiles(sourceRoot = root) {
  const directories = ["tests/neko-launcher", "tests/neko-workbench",
    "apps/neko-workbench/framework/tests"];
  return directories.flatMap(directory => readdirSync(join(sourceRoot, directory))
    .filter(file => /\.test\.(?:cjs|mjs|ts)$/.test(file))
    .map(file => join(directory, file)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // DOM tests resolve jsdom/react through NEKO_DOM_DEPS; default to this checkout when installed.
  const domDeps = process.env.NEKO_DOM_DEPS || (existsSync(join(root, "node_modules", "jsdom")) ? root : null);
  if (!domDeps) console.warn("[test:neko] jsdom not found; DOM tests will be skipped. Run npm ci or set NEKO_DOM_DEPS.");
  const environment = { ...process.env };
  if (domDeps) environment.NEKO_DOM_DEPS = domDeps;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...nekoTestFiles().sort()], {
    cwd: root, stdio: "inherit", windowsHide: true, env: environment,
  });
  process.exitCode = result.status ?? 1;
}
