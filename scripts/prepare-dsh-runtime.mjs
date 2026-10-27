// Inspect or validate existing DSH resources; explicitly --prepare to invoke the upstream builder.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const requiredSkills = ["office", "office-docx", "office-pptx", "office-xlsx", "office-export-pdf", "office-recalculate", "office-render"];
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function requireFile(file) {
  if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error(`Required runtime file missing: ${file}`);
}
function inventory(directory) {
  let files = 0, bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Windows runtime must contain ordinary files and directories.");
    if (entry.isDirectory()) { const child = inventory(path); files += child.files; bytes += child.bytes; }
    else if (entry.isFile()) { files++; bytes += lstatSync(path).size; }
    else throw new Error("Unsupported runtime filesystem entry.");
  }
  return { files, bytes };
}

/** Metadata checks are deliberately distinct from executing the native smoke below. */
export function inspectRuntime(primaryRoot, sourceRoot) {
  primaryRoot = resolve(primaryRoot); sourceRoot = resolve(sourceRoot);
  const manifestPath = join(primaryRoot, "runtime.json");
  requireFile(manifestPath);
  const manifest = json(manifestPath);
  const lockPath = join(sourceRoot, "scripts/primary-runtime/lock.json");
  const lock = json(lockPath);
  const sourcePackage = json(join(sourceRoot, "package.json"));
  if (manifest.platform !== "win32" || manifest.arch !== "x64") throw new Error("This verifier requires a Windows x64 runtime.");
  if (manifest.python !== lock.pythonVersion || manifest.node !== lock.nodeVersion) throw new Error("Interpreter versions do not match the selected DSH source lock.");
  if (typeof manifest.pnpm !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.pnpm)) throw new Error("Runtime must declare a pnpm version.");
  if (typeof manifest.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(manifest.payloadDigest)) throw new Error("Runtime must declare its original payload digest.");
  if (!manifest.pythonPackages || typeof manifest.pythonPackages !== "object" || Array.isArray(manifest.pythonPackages)
    || Object.keys(manifest.pythonPackages).length !== Object.keys(lock.pythonPackages).length
    || Object.entries(lock.pythonPackages).some(([name, version]) => manifest.pythonPackages[name] !== version)) {
    throw new Error("Python distribution versions do not match the selected DSH source lock.");
  }
  for (const path of ["dependencies/python/python.exe", "dependencies/node/bin/node.exe", "dependencies/pnpm/bin/pnpm.mjs"]) requireFile(join(primaryRoot, path));
  const pnpm = json(join(primaryRoot, "dependencies/pnpm/package.json"));
  if (pnpm.name !== "pnpm" || pnpm.version !== manifest.pnpm) throw new Error("pnpm package identity does not match the runtime manifest.");
  const skillsRoot = join(dirname(primaryRoot), "office-skills");
  for (const skill of requiredSkills) requireFile(join(skillsRoot, skill, "SKILL.md"));
  const expectedPnpm = sourcePackage.packageManager?.replace(/^pnpm@/, "");
  const warnings = [];
  if (manifest.pnpm !== expectedPnpm) warnings.push(`Bundled pnpm ${manifest.pnpm} differs from source pin ${expectedPnpm}; this is a validated imported payload, not a source-identical build.`);
  return {
    status: "inspected", nativeSmokePassed: false, allDshToolsVerified: false,
    primaryRuntime: primaryRoot, officeSkills: skillsRoot, manifest,
    sourceVersion: sourcePackage.version, sourceLockSha256: hash(lockPath), manifestSha256: hash(manifestPath),
    primaryInventory: inventory(primaryRoot), officeInventory: inventory(skillsRoot), warnings,
  };
}

function runUpstream(sourceRoot, code, args) {
  const loader = join(sourceRoot, "node_modules/tsx/dist/loader.mjs");
  requireFile(loader);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(name)));
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(loader).href, "--input-type=module", "-e", code, ...args], {
    cwd: sourceRoot, env: environment, windowsHide: true, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error(`DSH runtime preparation or native smoke failed (exit ${result.status ?? "unavailable"}).`);
}

/** Native verification always owns a disposable copy because ensurepip children can write caches. */
export function withRuntimeCopy(primaryRoot, verify) {
  const temporary = resolve(tmpdir());
  const stage = mkdtempSync(join(temporary, "bigfish-runtime-smoke-"));
  try {
    const copy = join(stage, "primary-runtime");
    cpSync(resolve(primaryRoot), copy, { recursive: true, dereference: false });
    cpSync(join(dirname(resolve(primaryRoot)), "office-skills"), join(stage, "office-skills"), { recursive: true, dereference: false });
    return verify(copy);
  } finally {
    if (dirname(resolve(stage)) !== temporary || !stage.startsWith(join(temporary, "bigfish-runtime-smoke-"))) throw new Error("Unexpected verification temporary directory.");
    rmSync(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Validate a disposable copy. The source installation and final portable hashes remain untouched. */
export function validateRuntime(primaryRoot, sourceRoot) {
  const report = inspectRuntime(primaryRoot, sourceRoot);
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Native smoke requires a Windows x64 process.");
  const smoke = join(resolve(sourceRoot), "apps/desktop/scripts/prepare-primary-runtime.ts");
  requireFile(smoke);
  withRuntimeCopy(primaryRoot, (copy) => runUpstream(resolve(sourceRoot), "const {smokePrimaryRuntime}=await import(process.argv[1]); smokePrimaryRuntime(process.argv[2]);", [pathToFileURL(smoke).href, copy]));
  return { ...report, status: "validated", nativeSmokePassed: true, verificationUsedTemporaryCopy: true, temporaryCopyRemoved: true, validatedAt: new Date().toISOString(), checks: [
    "Python and Node interpreter versions", "Python child process and isolated venv", "locked Python distribution set and pip dependency consistency",
    "NumPy and pandas operations", "DOCX/PPTX/XLSX synthetic document round trips", "bundled pnpm execution",
  ] };
}

export function downloadPlan(sourceRoot) {
  const lock = json(join(resolve(sourceRoot), "scripts/primary-runtime/lock.json"));
  const target = lock.targets["win-x64"];
  return [
    { url: `https://nodejs.org/dist/v${lock.nodeVersion}/node-v${lock.nodeVersion}-${target.nodeArchive}`, sha256: target.nodeSha256 },
    { url: `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(`cpython-${lock.pythonVersion}+${lock.pythonRelease}-${target.pythonTarget}-install_only_stripped.tar.gz`)}`, sha256: target.pythonSha256 },
    ...target.wheels, ...lock.wheels,
  ];
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: "string" }, runtime: { type: "string" }, report: { type: "string" },
    inspect: { type: "boolean" }, smoke: { type: "boolean" }, plan: { type: "boolean" }, prepare: { type: "boolean" },
    output: { type: "string" }, cache: { type: "string" },
  } });
  if (!values.source) throw new Error("Pass --source <DSH source root> and --runtime <primary-runtime> to inspect; --smoke validates a disposable copy, --plan lists locked downloads, --prepare --output <new directory> invokes the upstream builder.");
  const sourceRoot = resolve(values.source);
  if (values.plan) { console.log(JSON.stringify({ target: "win-x64", downloads: downloadPlan(sourceRoot) }, null, 2)); return; }
  let primaryRoot = values.runtime;
  if (values.prepare) {
    if (!values.output || values.runtime || values.inspect) throw new Error("--prepare requires --output and cannot be combined with --runtime or --inspect.");
    const output = resolve(values.output);
    if (existsSync(output)) throw new Error("Preparation output must not exist; existing payloads are never overwritten.");
    const prepare = join(sourceRoot, "scripts/primary-runtime/prepare.ts");
    requireFile(prepare);
    const version = json(join(sourceRoot, "package.json")).version;
    const cache = resolve(values.cache ?? join(dirname(output), "dsh-runtime-downloads"));
    runUpstream(sourceRoot, "const {preparePrimaryRuntime}=await import(process.argv[1]); await preparePrimaryRuntime(JSON.parse(process.argv[2]));", [
      pathToFileURL(prepare).href, JSON.stringify({ target: "win-x64", output, cache, version }),
    ]);
    primaryRoot = join(output, "primary-runtime");
  }
  if (!primaryRoot) throw new Error("Pass --runtime <primary-runtime> or --prepare --output <new directory>.");
  if (values.inspect && values.smoke) throw new Error("Choose either --inspect or --smoke.");
  const report = values.smoke || values.prepare ? validateRuntime(primaryRoot, sourceRoot) : inspectRuntime(primaryRoot, sourceRoot);
  if (values.report) writeFileSync(resolve(values.report), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
