// Private Windows preview builder. No installer, signing, uploads or dependency downloads.
import { constants, copyFileSync, existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const slash = (path) => path.split(sep).join("/");
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
const excludedDirectories = new Set([".git", ".cache", "__pycache__", "profiles", "workspaces", "secrets", "logs", "test", "tests", "fixtures", "_sandbox"]);
const sensitiveName = /^(?:\.env(?:\..*)?|app-config\.json|dsh-pets\.json|credentials(?:\..*)?)$|\.(?:dpapi|pfx|key|sqlite(?:-.*)?|db|log)$/i;
const codeExtensions = new Set([".ts", ".js", ".cjs", ".mjs", ".html", ".css"]);
const allowedPackages = new Set(["app-contracts", "app-coordinator", "avatar-runtime", "chat-api", "chat-service", "conversation-store", "memory-store", "persona-store", "dsh-bridge", "artifact-service", "account-adapter"]);
const videoFiles = ["待机呼吸休闲", "被鼠标拖拽悬空反馈", "工作状态-思考冒泡", "工作状态-雀跃庆祝", "工作状态-垂头叹气冒汗", "碎碎念-对屏碎碎念"];

class PortableError extends Error {}
function fail(message) { throw new PortableError(message); }
function hash(path) {
  const fd = openSync(path, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let size; while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size)); }
  finally { closeSync(fd); }
  return digest.digest("hex");
}
function files(root, { filter = () => true, allowInternalLinks = false } = {}) {
  const realRoot = realpathSync(root);
  const result = [];
  let remaining = 500_000;
  function walk(dir, prefix, ancestors) {
    const actual = realpathSync(dir);
    if (!inside(realRoot, actual)) fail("输入目录包含指向目录外的链接，构建已停止。");
    if (ancestors.has(actual)) fail("输入目录存在循环链接，构建已停止。");
    const next = new Set([...ancestors, actual]);
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (--remaining < 0) fail("输入目录超过文件扫描上限。");
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!filter(rel, entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() && !allowInternalLinks) fail("输入目录包含链接，构建已停止。");
      const actualFile = realpathSync(path);
      if (!inside(realRoot, actualFile)) fail("输入目录包含指向目录外的链接，构建已停止。");
      const info = statSync(path);
      if (info.isDirectory()) walk(path, rel, next);
      else if (info.isFile()) result.push({ source: path, relative: rel });
      else fail("输入目录包含不支持的文件类型。");
    }
  }
  walk(root, "", new Set());
  return result;
}
function runtimeFilter(rel, name) {
  return !excludedDirectories.has(name.toLowerCase()) && !sensitiveName.test(name)
    && !rel.split("/").includes(".git") && !/\.map$/i.test(name);
}
function packageFilter(_rel, name) {
  return !new Set(["node_modules", ".git", ".cache", "__pycache__", "test", "tests", "fixtures", "_sandbox"]).has(name.toLowerCase())
    && !/^(?:\.env(?:\..*)?)$|\.(?:dpapi|pfx|log)$/i.test(name) && !/\.map$/i.test(name);
}
function publishedFile(manifest, path) {
  if (path === "package.json" || /^(?:LICENSE|COPYING|NOTICE|README)[^/]*$/i.test(path)) return true;
  if (!Array.isArray(manifest.files)) return true;
  const entrypoints = [manifest.main, typeof manifest.bin === "string" ? manifest.bin : undefined,
    ...Object.values(typeof manifest.bin === "object" && manifest.bin ? manifest.bin : {})];
  if (entrypoints.some((entry) => typeof entry === "string" && entry.replace(/^\.\//, "") === path)) return true;
  const match = (pattern) => {
    pattern = pattern.replace(/^\.\//, "").replace(/\/$/, "");
    return path === pattern || path.startsWith(pattern + "/") || matchesGlob(path, pattern);
  };
  const patterns = manifest.files.filter((value) => typeof value === "string");
  return patterns.some((pattern) => !pattern.startsWith("!") && match(pattern))
    && !patterns.some((pattern) => pattern.startsWith("!") && match(pattern.slice(1)));
}
function sourceFiles(root) {
  const selected = new Map();
  const queue = [];
  const add = (source) => {
    const actual = realpathSync(source);
    if (!inside(realpathSync(root), actual)) fail("应用源码包含目录外链接。");
    const rel = slash(relative(root, source));
    if (selected.has(rel)) return;
    selected.set(rel, { source, relative: rel });
    if ([".ts", ".js", ".cjs", ".mjs"].includes(extname(source))) queue.push(source);
  };
  for (const app of ["desktop", "pet-overlay", "agent-pet"]) {
    const appRoot = join(root, "apps", app);
    for (const item of files(appRoot, { filter: (rel, name) => runtimeFilter(rel, name) })) {
      if (codeExtensions.has(extname(item.source))) add(item.source);
    }
  }
  while (queue.length) {
    const source = queue.shift();
    const text = readFileSync(source, "utf8");
    const imports = /\b(?:from\s*|import\s*(?:\(\s*)?|require\(\s*)["']([^"']+)["']/g;
    for (const match of text.matchAll(imports)) {
      const specifier = match[1];
      if (specifier === "electron" || specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) fail("应用存在未纳入白名单的外部依赖。");
      const target = resolve(dirname(source), specifier);
      const rel = slash(relative(root, target));
      const parts = rel.split("/");
      if (!(parts[0] === "apps" && ["desktop", "pet-overlay", "agent-pet"].includes(parts[1]))
        && !(parts[0] === "packages" && allowedPackages.has(parts[1]) && parts[2] === "src")) fail("应用引用超出 v1 源码白名单。");
      if (!codeExtensions.has(extname(target))) fail("应用引用未支持的源码文件类型。");
      add(target);
    }
  }
  add(join(root, "config/personas/bigfish.json"));
  return [...selected.values()].sort((a, b) => a.relative.localeCompare(b.relative, "en"));
}

// Materialize the production dependency graph, never recursively follow a package's
// node_modules. Pnpm workspace links may point outside the prepared project; only
// packages reached through declared dependencies/bundles are copied.
function dshFiles(project) {
  const plan = [];
  const placed = new Map();
  const queue = [];
  const rootManifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  function resolvePackage(owner, name, optional, runtimeRoot = false) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) fail("DSH 依赖名称无效。");
    let dir = owner;
    while (true) {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) {
        const actual = realpathSync(candidate);
        const manifest = JSON.parse(readFileSync(join(actual, "package.json"), "utf8"));
        if (typeof manifest.name !== "string" || typeof manifest.version !== "string") fail("DSH 依赖缺少包名称或版本。");
        const supported = (values, target) => !Array.isArray(values) || (!values.includes(`!${target}`) && (values.every((v) => v.startsWith("!")) || values.includes(target)));
        if (!runtimeRoot && (!supported(manifest.os, "win32") || !supported(manifest.cpu, process.arch))) {
          if (optional) return null;
          fail("DSH 必需依赖不支持目标 Windows 架构。");
        }
        return { actual, manifest };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (optional) return null;
    fail(`DSH 缺少已声明生产依赖：${name}`);
  }
  function existing(ownerDest, name) {
    let dir = ownerDest;
    while (true) {
      const candidate = slash(join(dir, "node_modules", name));
      if (placed.has(candidate)) return { destination: candidate, actual: placed.get(candidate) };
      if (!dir || dir === ".") break;
      const parent = slash(dirname(dir));
      if (parent === dir) break;
      dir = parent === "." ? "" : parent;
    }
    return null;
  }
  function install(owner, ownerDest, name, optional, runtimeRoot = false) {
    const resolved = resolvePackage(owner, name, optional, runtimeRoot);
    if (!resolved) return;
    const found = existing(ownerDest, name);
    if (found?.actual === resolved.actual) return;
    const top = `node_modules/${name}`;
    const destination = !placed.has(top) ? top : slash(join(ownerDest, "node_modules", name));
    if (placed.has(destination)) fail("DSH 生产依赖布局发生版本冲突。");
    if (placed.size >= 10_000) fail("DSH 生产依赖图超过上限。");
    placed.set(destination, resolved.actual);
    queue.push({ ...resolved, destination });
  }
  const rootDependencies = { ...rootManifest.dependencies };
  for (const name of rootManifest.dsh?.profile?.bundles ?? []) rootDependencies[name] = "bundle";
  const runtimeManifest = join(project, "desktop-runtime.json");
  if (existsSync(runtimeManifest)) {
    const runtime = JSON.parse(readFileSync(runtimeManifest, "utf8"));
    if (!Array.isArray(runtime.sharedPackages)) fail("DSH 运行清单缺少 sharedPackages。");
    for (const item of runtime.sharedPackages) {
      if (typeof item.name !== "string" || item.path !== `node_modules/${item.name}`) fail("DSH 运行清单包含未支持的包路径。");
      rootDependencies[item.name] = "runtime-manifest";
    }
  }
  for (const name of Object.keys(rootDependencies).sort()) install(project, "", name, false, true);
  while (queue.length) {
    const pkg = queue.shift();
    for (const file of files(pkg.actual, { filter: packageFilter, allowInternalLinks: true })) {
      if (publishedFile(pkg.manifest, file.relative)) plan.push({ source: file.source, relative: `${pkg.destination}/${file.relative}` });
    }
    const optional = pkg.manifest.optionalDependencies ?? {};
    const dependencies = { ...pkg.manifest.peerDependencies, ...pkg.manifest.dependencies, ...optional };
    for (const name of Object.keys(dependencies).sort()) {
      const isOptional = Object.hasOwn(optional, name) || (!Object.hasOwn(pkg.manifest.dependencies ?? {}, name) && Object.hasOwn(pkg.manifest.peerDependencies ?? {}, name));
      install(pkg.actual, pkg.destination, name, isOptional);
    }
  }
  if (!placed.has("node_modules/@deepseek-ai/dsh-desktop-host")) fail("DSH 清单未包含 Host 生产依赖。");
  return plan;
}

/** @param {{ root?: string, output?: string, mode?: string, env?: NodeJS.ProcessEnv, planOnly?: boolean, withoutDsh?: boolean }} [options] */
export function buildPortable({ root = repo, output, mode = "preview", env = process.env, planOnly = false, withoutDsh = false } = {}) {
  if (!output) fail("必须指定新的输出目录。");
  if (mode !== "preview" && mode !== "release") fail("mode 仅支持 preview 或 release。");
  root = resolve(root);
  output = resolve(output);
  if (existsSync(output)) fail("输出目录已存在；不会覆盖或删除旧产物。");
  output = join(realpathSync(dirname(output)), basename(output));
  const sandbox = resolve(root, "../_sandbox/f01-dsh-desktop");
  const installedElectron = join(root, "node_modules/electron/dist/electron.exe");
  const electron = env.NEKO_FISH_ELECTRON || (existsSync(installedElectron) ? installedElectron : join(sandbox, "src/apps/desktop/node_modules/electron/dist/electron.exe"));
  const electronDir = dirname(electron);
  const assets = env.NEKO_FISH_ASSETS_DIR || resolve(root, "assets");
  const dsh = env.NEKO_FISH_DSH_RUNTIME || join(sandbox, "src/apps/desktop/.desktop-build/development/project");
  const primary = env.NEKO_FISH_DSH_PRIMARY_RUNTIME || join(sandbox, "primary-runtime-stub/primary-runtime");
  const primaryFiles = !withoutDsh && existsSync(primary) ? files(primary, { filter: runtimeFilter, allowInternalLinks: true }) : [];
  const hasPrimary = !/(?:^|[\\/])[^\\/]*stub[^\\/]*(?:[\\/]|$)/i.test(primary)
    && primaryFiles.some((file) => /\.(exe|dll|node|wasm)$/i.test(file.relative));
  if (mode === "release") fail(hasPrimary ? "本工具仅生成本机私有预览；正式分发验收尚未实现。" : "正式分发需要完整 primary-runtime，不能使用缺失或 stub 资源。");
  for (const source of [root, electronDir, assets, ...(!withoutDsh ? [dsh, ...(existsSync(primary) ? [primary] : [])] : [])]) {
    if (inside(realpathSync(source), output)) fail("输出目录不能位于任何输入目录中。");
  }
  if (!statSync(electron).isFile()) fail("未找到 Electron 可执行文件。");
  if (!withoutDsh && !existsSync(join(dsh, "node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js"))) fail("缺少 DSH Host 入口。");
  const sourceManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const plan = [];
  const add = (source, destination) => plan.push({ source, destination });
  for (const file of files(electronDir, { filter: (rel, name) => runtimeFilter(rel, name) && rel !== "resources", allowInternalLinks: true })) {
    if (file.relative === "electron.exe") add(file.source, "大肥鱼桌宠.exe");
    else if (!file.relative.startsWith("resources/app/")) add(file.source, file.relative);
  }
  for (const file of sourceFiles(root)) add(file.source, `resources/app/${file.relative}`);
  for (const name of videoFiles) add(join(assets, "dsh-pet", `${name}.webm`), `resources/assets/dsh-pet/${name}.webm`);
  add(join(assets, "ATTRIBUTION.md"), "resources/assets/ATTRIBUTION.md");
  if (!withoutDsh) {
    for (const name of ["package.json", "desktop-runtime.json"]) if (existsSync(join(dsh, name))) add(join(dsh, name), `resources/dsh/${name}`);
    for (const file of dshFiles(dsh)) add(file.source, `resources/dsh/${file.relative}`);
  }
  if (hasPrimary) for (const file of primaryFiles) add(file.source, `resources/primary-runtime/${file.relative}`);
  const office = env.NEKO_FISH_OFFICE_SKILLS || join(dirname(primary), "office-skills");
  if (hasPrimary && existsSync(office)) for (const file of files(office, { filter: runtimeFilter, allowInternalLinks: true })) add(file.source, `resources/office-skills/${file.relative}`);
  const dshLicense = env.NEKO_FISH_DSH_LICENSE || join(sandbox, "src/LICENSE");
  if (!withoutDsh && existsSync(dshLicense)) add(dshLicense, "licenses/DSH-LICENSE");
  for (const name of ["LICENSE", "LICENSE.md", "COPYING"]) if (existsSync(join(root, name))) add(join(root, name), `licenses/project-${name}`);
  const destinations = new Set();
  for (const item of plan) {
    if (destinations.has(item.destination.toLowerCase())) fail("输出文件名发生冲突。");
    destinations.add(item.destination.toLowerCase());
    if (!statSync(item.source).isFile()) fail("缺少必需的输入文件。");
  }
  const primaryStatus = withoutDsh ? "excluded-by-request" : hasPrimary ? "included-unqualified" : "missing-tools";
  if (planOnly) return { planned: true, releaseReady: false, fileCount: plan.length, bytes: plan.reduce((sum, item) => sum + statSync(item.source).size, 0), primaryRuntime: primaryStatus };
  // Only now create output. Failures retain a marked incomplete directory for inspection.
  mkdirSync(output, { recursive: false });
  const incomplete = join(output, "BUILD-INCOMPLETE.txt");
  writeFileSync(incomplete, "构建未完成，不要运行或分发此目录。\n", { flag: "wx" });
  const write = (name, value) => { const target = join(output, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, value, { flag: "wx" }); };
  for (const item of plan) {
    const target = join(output, item.destination);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(item.source, target, constants.COPYFILE_EXCL);
  }
  if (!withoutDsh) mkdirSync(join(output, "resources/primary-runtime"), { recursive: true });
  write("resources/app/package.json", JSON.stringify({ name: "bigfish-pet", version: sourceManifest.version, private: true, type: "module", main: "apps/desktop/main.cjs" }, null, 2) + "\n");
  const info = { schemaVersion: 1, kind: "private-local-portable-preview", releaseReady: false, platform: "win32",
    version: sourceManifest.version, dsh: withoutDsh ? "excluded-by-request" : "included", primaryRuntime: primaryStatus, signed: false,
    limitations: ["仅供私有协作使用，未取得或声明新的公开分发许可。", "未完成真实账号、API、全工具与安装升级验收。", ...(withoutDsh ? ["按要求不包含 DSH Host、primary-runtime 和 Office 技能，DSH 功能不可用。"] : hasPrimary ? [] : ["未包含完整 primary-runtime，DSH 工具不可视为可用。"])] };
  write("portable-build.json", JSON.stringify(info, null, 2) + "\n");
  const notices = plan.filter((item) => /(?:^|\/)(?:LICENSE[^/]*|COPYING[^/]*|NOTICE[^/]*|ATTRIBUTION\.md|DSH-LICENSE)$/i.test(item.destination)).map((item) => item.destination).sort();
  write("THIRD-PARTY-NOTICES.md", "# 本机私有便携预览\n\n保留随输入资源提供的许可及署名，不代表新授权或公开分发已获批准。素材以 resources/assets/ATTRIBUTION.md 的已有记录为准。第三方依赖许可仍需正式分发前逐项审核。\n\n" + notices.map((name) => `- ${name}`).join("\n") + "\n");
  write("使用说明.txt", "私有协作便携预览，双击 大肥鱼桌宠.exe。右键可打开设置。\n用户数据保存在 %APPDATA%/neko-fish，不放在程序目录。请在设置页填写文字聊天 API 密钥；不要复制用户数据到程序包。\n此目录未经签名，不是公开发布或安装升级验收完成的版本。\n" + (withoutDsh ? "本包不包含 DSH Host、primary-runtime 和 Office 技能；DSH 菜单不可用，陪伴聊天、动画和记忆可独立使用。\n" : hasPrimary ? "已携带本机 primary-runtime，仍需真实任务验收。\n" : "未携带完整 primary-runtime，DSH 工具尚不可验收。\n"));
  const inventory = files(output).filter((file) => file.relative !== "BUILD-INCOMPLETE.txt")
    .map((file) => ({ path: file.relative, bytes: statSync(file.source).size, sha256: hash(file.source) })).sort((a, b) => a.path.localeCompare(b.path, "en"));
  write("SHA256SUMS.json", JSON.stringify({ schemaVersion: 1, algorithm: "sha256", excludes: ["SHA256SUMS.json"], files: inventory }, null, 2) + "\n");
  unlinkSync(incomplete);
  return { ...info, output, fileCount: inventory.length, bytes: inventory.reduce((sum, file) => sum + file.bytes, 0) };
}

export function verifyPortable(output) {
  output = resolve(output);
  if (existsSync(join(output, "BUILD-INCOMPLETE.txt"))) fail("便携目录构建未完成。");
  const manifest = JSON.parse(readFileSync(join(output, "SHA256SUMS.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.algorithm !== "sha256" || !Array.isArray(manifest.files) || manifest.files.length > 500_000) fail("SHA256 清单格式无效。");
  const expected = new Set(["SHA256SUMS.json"]);
  for (const item of manifest.files) {
    if (typeof item.path !== "string" || /[\\:]/.test(item.path) || item.path.split("/").some((part) => !part || part === "." || part === "..")
      || isAbsolute(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) fail("SHA256 清单包含无效文件记录。");
    if (expected.has(item.path)) fail("SHA256 清单包含重复文件。");
    expected.add(item.path);
  }
  const actual = files(output);
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file.relative))) fail("便携目录存在遗漏或额外文件。");
  for (const item of manifest.files) {
    const path = join(output, item.path);
    if (statSync(path).size !== item.bytes || hash(path) !== item.sha256) fail("便携目录文件校验失败。");
  }
  for (const required of ["大肥鱼桌宠.exe", "resources/app/apps/desktop/main.cjs", "resources/app/package.json", "portable-build.json", "THIRD-PARTY-NOTICES.md"]) if (!expected.has(required)) fail("便携目录缺少入口或构建说明。");
  return { verified: true, releaseReady: false, fileCount: manifest.files.length };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") console.log("node scripts/build-portable.mjs --output <新目录> [--mode preview] [--plan] [--without-dsh]\nnode scripts/build-portable.mjs --verify <便携目录>\n仅构建私有 Windows 预览；--without-dsh 排除 DSH 及配套运行资源。--plan 只读。不覆盖旧目录、不下载依赖、不发布。");
    else if (args.length === 2 && args[0] === "--verify") console.log(JSON.stringify(verifyPortable(args[1]), null, 2));
    else {
      const options = {};
      const planIndex = args.indexOf("--plan");
      if (planIndex >= 0) { options.planOnly = true; args.splice(planIndex, 1); }
      const withoutIndex = args.indexOf("--without-dsh");
      if (withoutIndex >= 0) { options.withoutDsh = true; args.splice(withoutIndex, 1); }
      for (let i = 0; i < args.length; i += 2) {
        if (!["--output", "--mode"].includes(args[i]) || !args[i + 1] || options[args[i].slice(2)] !== undefined) fail("参数无效，请使用 --help。");
        options[args[i].slice(2)] = args[i + 1];
      }
      console.log(JSON.stringify(buildPortable(options), null, 2));
    }
  } catch (error) {
    // Filesystem errors can contain private paths. Keep CLI diagnostics fixed unless authored above.
    console.error(error instanceof PortableError ? error.message : "构建或校验失败，请检查输入文件和输出目录；已有产物未删除。");
    process.exitCode = 1;
  }
}
