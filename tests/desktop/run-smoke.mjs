import { spawn } from "node:child_process";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const executable = process.env.NEKO_FISH_ELECTRON || resolve(root, "../_sandbox/f01-dsh-desktop/src/apps/desktop/node_modules/electron/dist/electron.exe");
const temporaryRoot = resolve(tmpdir());
// tests/desktop exercises the Windows desktop entry (DPAPI key store).
if (process.platform !== "win32" && process.env.NEKO_FISH_SMOKE_ALLOW_NON_WINDOWS !== "1") {
  console.log("DESKTOP_SMOKE_SKIP: tests/desktop targets the Windows desktop entry (DPAPI). Set NEKO_FISH_SMOKE_ALLOW_NON_WINDOWS=1 to force the macOS diagnostic path.");
  process.exit(0);
}
const profile = mkdtempSync(join(temporaryRoot, "neko-fish-desktop-smoke-"));
const environment = { ...process.env, NEKO_FISH_SMOKE_PROFILE: profile };
delete environment.ELECTRON_RUN_AS_NODE;
let success = true;
function run(script, mode) {
  return new Promise((yes) => {
    const child = spawn(executable, [resolve(directory, script)], { cwd: root, env: { ...environment, NEKO_FISH_SMOKE_SHUTDOWN: mode || "" }, stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: false });
    child.on("message", (message) => {
      if (message?.type !== "neko-fish:smoke-ready") return;
      if (mode === "disconnect") child.disconnect();
      else child.send({ type: "neko-fish:shutdown" });
    });
    child.once("error", () => yes(1));
    child.once("exit", (code) => yes(code ?? 1));
  });
}
try {
  success = await run("smoke.cjs") === 0;
  if (success) success = await run("agent-smoke.cjs") === 0;
  if (success) {
    for (const mode of ["message", "disconnect"]) success = await run("shutdown-smoke.cjs", mode) === 0 && success;
  }
} finally {
  // The path was created by this runner. Refuse recursive removal outside its exact tmp parent.
  if (dirname(resolve(profile)) !== temporaryRoot || !basename(profile).startsWith("neko-fish-desktop-smoke-")) throw new Error("Unexpected smoke profile location.");
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const reportFile = resolve(root, "../_sandbox/v1/evidence/desktop-smoke.json");
  try {
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    report.profileRemoved = true;
    report.parentShutdownAndDisconnect = success;
    report.ok = report.ok && success;
    writeFileSync(reportFile, JSON.stringify(report, null, 2));
  } catch { success = false; }
}
process.exitCode = success ? 0 : 1;
