import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildPortable, verifyPortable } from "../../scripts/build-portable.mjs";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "bigfish-portable-"));
  const root = join(base, "source");
  const put = (path: string, content = "synthetic-fixture") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  put(join(root, "package.json"), JSON.stringify({ version: "0.1.0-dev" }));
  put(join(root, "apps/desktop/main.cjs"), "require('electron'); require('../../packages/chat-service/src/service.ts');");
  put(join(root, "packages/chat-service/src/service.ts"), "import { randomUUID } from 'node:crypto';");
  put(join(root, "packages/chat-service/src/unreferenced.ts"));
  put(join(root, "apps/pet-overlay/index.html"));
  put(join(root, "apps/agent-pet/index.html"));
  put(join(root, "config/personas/bigfish.json"), '{"id":"bigfish"}');
  const env = {
    NEKO_FISH_ELECTRON: join(base, "electron/electron.exe"),
    NEKO_FISH_ASSETS_DIR: join(base, "assets"),
    NEKO_FISH_DSH_RUNTIME: join(base, "dsh"),
    NEKO_FISH_DSH_PRIMARY_RUNTIME: join(base, "primary-runtime"),
    NEKO_FISH_DSH_LICENSE: join(base, "DSH-LICENSE"),
  };
  put(env.NEKO_FISH_ELECTRON);
  put(join(dirname(env.NEKO_FISH_ELECTRON), "LICENSE"));
  put(join(dirname(env.NEKO_FISH_ELECTRON), "resources/default_app.asar"));
  for (const name of ["待机呼吸休闲", "被鼠标拖拽悬空反馈", "工作状态-思考冒泡", "工作状态-雀跃庆祝", "工作状态-垂头叹气冒汗", "碎碎念-对屏碎碎念"]) put(join(env.NEKO_FISH_ASSETS_DIR, "dsh-pet", `${name}.webm`));
  put(join(env.NEKO_FISH_ASSETS_DIR, "ATTRIBUTION.md"));
  put(join(env.NEKO_FISH_DSH_RUNTIME, "node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js"));
  put(join(env.NEKO_FISH_DSH_RUNTIME, "node_modules/@deepseek-ai/dsh-desktop-host/package.json"), '{"name":"@deepseek-ai/dsh-desktop-host","version":"1.0.0"}');
  put(join(env.NEKO_FISH_DSH_RUNTIME, "node_modules/@deepseek-ai/dsh-desktop-host/LICENSE"));
  put(join(env.NEKO_FISH_DSH_RUNTIME, "package.json"), '{"private":true,"dependencies":{"@deepseek-ai/dsh-desktop-host":"1.0.0"}}');
  put(join(env.NEKO_FISH_DSH_PRIMARY_RUNTIME, "dependencies/python/python.exe"));
  put(join(base, "office-skills/SKILL.md"));
  put(env.NEKO_FISH_DSH_LICENSE);
  return { base, root, env, output: join(base, "preview"), put, close: () => rmSync(base, { recursive: true, force: true }) };
}

test("portable preview includes only referenced v1 packages, runtime licenses and office sibling", () => {
  const f = fixture();
  try {
    f.put(join(f.root, "services/neko-memory/data.sqlite"), "synthetic-secret");
    f.put(join(f.root, "config/app-config.json"), "synthetic-secret");
    f.put(join(f.env.NEKO_FISH_DSH_RUNTIME, "node_modules/demo/.env"), "synthetic-secret");
    f.put(join(f.env.NEKO_FISH_DSH_RUNTIME, "node_modules/demo/tests/private.json"), "synthetic-secret");
    const built = buildPortable(f);
    assert.equal(built.releaseReady, false);
    assert.equal(built.primaryRuntime, "included-unqualified");
    assert.equal(verifyPortable(f.output).verified, true);
    const manifest = readFileSync(join(f.output, "SHA256SUMS.json"), "utf8");
    for (const excluded of ["unreferenced.ts", "services/neko", "app-config.json", ".env", "private.json", "default_app.asar"]) assert.equal(manifest.includes(excluded), false, excluded);
    assert.equal(JSON.parse(readFileSync(join(f.output, "resources/app/package.json"), "utf8")).main, "apps/desktop/main.cjs");
    assert.equal(existsSync(join(f.output, "resources/office-skills/SKILL.md")), true);
    assert.match(readFileSync(join(f.output, "THIRD-PARTY-NOTICES.md"), "utf8"), /DSH-LICENSE/);
    assert.equal(existsSync(join(f.output, "BUILD-INCOMPLETE.txt")), false);
  } finally { f.close(); }
});

test("portable inventory is repeatable and relocation independent", () => {
  const f = fixture();
  try {
    buildPortable(f);
    const second = join(f.base, "second");
    buildPortable({ ...f, output: second });
    assert.equal(readFileSync(join(f.output, "SHA256SUMS.json"), "utf8"), readFileSync(join(second, "SHA256SUMS.json"), "utf8"));
    const moved = join(f.base, "moved");
    renameSync(f.output, moved);
    assert.equal(verifyPortable(moved).verified, true);
  } finally { f.close(); }
});

test("without-dsh builds with absent DSH paths and excludes every DSH runtime payload", () => {
  const f = fixture();
  try {
    f.env.NEKO_FISH_DSH_RUNTIME = join(f.base, "absent-host");
    const result = buildPortable({ ...f, withoutDsh: true });
    assert.equal(result.primaryRuntime, "excluded-by-request");
    assert.equal(verifyPortable(f.output).verified, true);
    for (const rel of ["resources/dsh", "resources/primary-runtime", "resources/office-skills", "licenses/DSH-LICENSE"]) assert.equal(existsSync(join(f.output, rel)), false, rel);
    assert.equal(existsSync(join(f.output, "resources/assets/dsh-pet/待机呼吸休闲.webm")), true);
    assert.match(readFileSync(join(f.output, "使用说明.txt"), "utf8"), /本包不包含 DSH/);
  } finally { f.close(); }
});

test("missing primary runtime remains marked preview and release mode rejects before creating output", () => {
  const f = fixture();
  try {
    f.env.NEKO_FISH_DSH_PRIMARY_RUNTIME = join(f.base, "missing-primary");
    assert.throws(() => buildPortable({ ...f, mode: "release" }), /完整 primary-runtime/);
    assert.equal(existsSync(f.output), false);
    const result = buildPortable(f);
    assert.equal(result.primaryRuntime, "missing-tools");
    assert.match(readFileSync(join(f.output, "使用说明.txt"), "utf8"), /未携带完整/);
    assert.equal(verifyPortable(f.output).verified, true);
  } finally { f.close(); }
});

test("existing output is untouched and output inside an input is rejected", () => {
  const f = fixture();
  try {
    f.put(join(f.output, "keep.txt"), "keep");
    assert.throws(() => buildPortable(f), /已存在/);
    assert.equal(readFileSync(join(f.output, "keep.txt"), "utf8"), "keep");
    assert.throws(() => buildPortable({ ...f, output: join(f.root, "nested-output") }), /输入目录/);
    assert.equal(existsSync(join(f.root, "nested-output")), false);
  } finally { f.close(); }
});

test("unreferenced runtime links cannot pull private data into the package", () => {
  const f = fixture();
  try {
    const outside = join(f.base, "private");
    f.put(join(outside, "payload.js"));
    symlinkSync(outside, join(f.env.NEKO_FISH_DSH_RUNTIME, "node_modules/private-link"), process.platform === "win32" ? "junction" : "dir");
    buildPortable(f);
    assert.equal(readFileSync(join(f.output, "SHA256SUMS.json"), "utf8").includes("private-link"), false);
  } finally { f.close(); }
});

test("declared external workspace packages preserve conflicting versions and terminate cycles", () => {
  const f = fixture();
  try {
    const host = join(f.env.NEKO_FISH_DSH_RUNTIME, "node_modules/@deepseek-ai/dsh-desktop-host");
    f.put(join(host, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-desktop-host", version: "1.0.0", dependencies: { a: "2.0.0" } }));
    const packageDir = (name: string, version: string, dependencies = {}) => {
      const path = join(f.base, `workspace-${name}-${version}`);
      f.put(join(path, "package.json"), JSON.stringify({ name, version, dependencies }));
      f.put(join(path, "index.js"), `module.exports = '${version}';`);
      return path;
    };
    const a1 = packageDir("a", "1.0.0");
    const a2 = packageDir("a", "2.0.0", { b: "1.0.0" });
    const b = packageDir("b", "1.0.0", { a: "2.0.0" });
    const link = (target: string, source: string) => { mkdirSync(dirname(source), { recursive: true }); symlinkSync(target, source, process.platform === "win32" ? "junction" : "dir"); };
    link(a1, join(f.env.NEKO_FISH_DSH_RUNTIME, "node_modules/a"));
    link(a2, join(host, "node_modules/a"));
    link(b, join(a2, "node_modules/b"));
    link(a2, join(b, "node_modules/a"));
    f.put(join(f.env.NEKO_FISH_DSH_RUNTIME, "desktop-runtime.json"), JSON.stringify({ sharedPackages: [{ name: "a", path: "node_modules/a", version: "1.0.0" }] }));
    const planned = buildPortable({ ...f, planOnly: true });
    assert.equal(planned.planned, true);
    assert.equal(existsSync(f.output), false);
    buildPortable(f);
    assert.equal(verifyPortable(f.output).verified, true);
    const version = (path: string) => JSON.parse(readFileSync(join(f.output, "resources/dsh", path, "package.json"), "utf8")).version;
    assert.equal(version("node_modules/a"), "1.0.0");
    assert.equal(version("node_modules/@deepseek-ai/dsh-desktop-host/node_modules/a"), "2.0.0");
    assert.equal(version("node_modules/b/node_modules/a"), "2.0.0");
  } finally { f.close(); }
});

test("published package files retain business directories while excluding unpublished build data", () => {
  const f = fixture();
  try {
    const host = join(f.env.NEKO_FISH_DSH_RUNTIME, "node_modules/@deepseek-ai/dsh-desktop-host");
    f.put(join(host, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-desktop-host", version: "1.0.0", main: "lib/index.js", files: ["lib", "assets/*.json"] }));
    f.put(join(host, "lib/profiles/index.js"));
    f.put(join(host, "lib/workspaces/index.js"));
    f.put(join(host, "assets/default.json"));
    f.put(join(host, "assets/test.png"));
    f.put(join(host, "build/private-output.txt"));
    f.put(join(host, "lib/.env"));
    buildPortable(f);
    const manifest = readFileSync(join(f.output, "SHA256SUMS.json"), "utf8");
    for (const included of ["lib/profiles/index.js", "lib/workspaces/index.js", "assets/default.json"]) assert.equal(manifest.includes(included), true, included);
    for (const excluded of ["assets/test.png", "build/private-output.txt", "lib/.env"]) assert.equal(manifest.includes(excluded), false, excluded);
    assert.equal(verifyPortable(f.output).verified, true);
  } finally { f.close(); }
});

test("verify rejects modified, extra, incomplete and traversal-manifest files", () => {
  const f = fixture();
  try {
    buildPortable(f);
    const exe = join(f.output, "大肥鱼桌宠.exe");
    const original = readFileSync(exe);
    writeFileSync(exe, "changed");
    assert.throws(() => verifyPortable(f.output), /校验失败/);
    writeFileSync(exe, original);
    f.put(join(f.output, "unexpected.txt"));
    assert.throws(() => verifyPortable(f.output), /额外文件/);
    rmSync(join(f.output, "unexpected.txt"));
    f.put(join(f.output, "BUILD-INCOMPLETE.txt"));
    assert.throws(() => verifyPortable(f.output), /未完成/);
    rmSync(join(f.output, "BUILD-INCOMPLETE.txt"));
    const manifest = JSON.parse(readFileSync(join(f.output, "SHA256SUMS.json"), "utf8"));
    manifest.files[0].path = "../outside";
    writeFileSync(join(f.output, "SHA256SUMS.json"), JSON.stringify(manifest));
    assert.throws(() => verifyPortable(f.output), /无效文件记录/);
  } finally { f.close(); }
});
