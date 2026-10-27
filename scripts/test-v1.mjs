// Default checks for the current framework. The archived NEKO / voice integration
// suites start services or call live providers; they require separate opt-in work.
import { readdirSync } from "node:fs";
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
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...files.sort()], {
  cwd: root, stdio: "inherit", windowsHide: true,
});
process.exitCode = result.status ?? 1;
