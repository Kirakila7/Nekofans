// Default checks for the current framework. The archived NEKO / voice integration
// suites start services or call live providers; they require separate opt-in work.
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { nekoTestFiles } from "./test-neko-workbench.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const groups = ["chat-api", "chat-service", "persona-store", "conversation-store", "memory-store",
  "desktop", "avatar-runtime", "dsh-bridge", "artifact-service", "account-adapter"];
const files = groups.flatMap((group) => readdirSync(join(root, "tests", group))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => join("tests", group, name)));
files.push(...readdirSync(join(root, "tests", "app-coordinator"))
  .filter((name) => name.startsWith("pet-") && name.endsWith(".test.ts"))
  .map((name) => join("tests", "app-coordinator", name)));
files.push(...nekoTestFiles(root));
// DOM tests resolve jsdom/react through NEKO_DOM_DEPS; default to this checkout when installed.
const domDeps = process.env.NEKO_DOM_DEPS || (existsSync(join(root, "node_modules", "jsdom")) ? root : null);
if (!domDeps) console.warn("[test-v1] jsdom not found; DOM tests will be skipped. Run npm ci or set NEKO_DOM_DEPS.");
const environment = { ...process.env };
if (domDeps) environment.NEKO_DOM_DEPS = domDeps;
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...files.sort()], {
  cwd: root, stdio: "inherit", windowsHide: true, env: environment,
});
process.exitCode = result.status ?? 1;
