#!/usr/bin/env node
// One-shot developer bootstrap for a fresh checkout on macOS, Linux or Windows.
//
//   node scripts/bootstrap.mjs                 # full setup
//   node scripts/bootstrap.mjs --skip-electron # no Electron download
//   node scripts/bootstrap.mjs --check         # only verify the toolchain
//
// The goal is that a second machine needs no local knowledge beyond this file:
// every step is either reproducible from the lockfiles or reported as missing.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const argv = new Set(process.argv.slice(2));
const skipElectron = argv.has("--skip-electron");
const checkOnly = argv.has("--check");
const MIN_NODE_MAJOR = 24;

let failures = 0;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function run(label, command, args) {
  log(`\n== ${label} ==`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    failures += 1;
    log(`!! ${label} failed (exit ${result.status ?? "null"})`);
    return false;
  }
  return true;
}

function probe(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  return result.status === 0 ? (result.stdout || "").trim() : null;
}

// 1. Node ------------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split(".")[0]);
log(`== Node ==\nlocal: v${process.versions.node} (requires >= ${MIN_NODE_MAJOR})`);
if (nodeMajor < MIN_NODE_MAJOR) {
  failures += 1;
  log(`!! Node ${MIN_NODE_MAJOR}+ is required. Run "nvm use" (a .nvmrc is provided) or install it first.`);
}

// 2. Python + uv -----------------------------------------------------------
const uvVersion = probe("uv", ["--version"]);
if (uvVersion) {
  log(`\n== uv ==\n${uvVersion}`);
} else {
  failures += 1;
  log(`\n== uv ==\n!! uv was not found. Install it from https://github.com/astral-sh/uv and re-run.`);
}

// 3. Dependencies ----------------------------------------------------------
if (checkOnly) {
  log(`\n== Dependencies ==\n--check given, skipping installs.`);
} else {
  if (existsSync(join(ROOT, ".git")) === false) {
    log(`\n!! Not a git checkout, continuing anyway.`);
  }
  run("JavaScript dependencies", "npm", ["ci"]);
  if (!skipElectron) {
    run("Electron runtime", "npm", ["run", "setup:electron"]);
  }
  if (uvVersion) {
    run("Python memory service", "npm", ["run", "setup:neko-memory"]);
    log(
      `\nNote: services/neko-asr and services/neko-tts reuse that venv and need the\n` +
        `extra pins listed in services/neko-asr/VENDOR.md (faster-whisper, soxr, websockets);\n` +
        `add them with "uv pip install --python services/neko-memory/.venv/bin/python ..."\n` +
        `(use .venv/Scripts/python.exe on Windows).`,
    );
  }
}

// 4. Report ----------------------------------------------------------------
if (failures > 0) {
  log(`\n${failures} step(s) need attention.`);
  process.exit(1);
}
log(`\nEnvironment is ready. Next: npm run check:neko, then npm run start (see README).`);
