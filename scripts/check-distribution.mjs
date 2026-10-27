// Read-only inventory. This does not launch Electron, access a user profile, fetch
// dependencies, or certify licensing/runtime completeness from file presence.
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clips = ["待机呼吸休闲", "被鼠标拖拽悬空反馈", "工作状态-思考冒泡",
  "工作状态-雀跃庆祝", "工作状态-垂头叹气冒汗", "碎碎念-对屏碎碎念"];
function isFile(path) { try { return statSync(path).isFile() && statSync(path).size > 0; } catch { return false; } }
function json(path) {
  try {
    if (statSync(path).size > 1_048_576) return null;
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
function contained(root, path) {
  try {
    const rel = relative(realpathSync(root), realpathSync(path));
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
  } catch { return false; }
}
function containsPayload(path) {
  // Bounded, no symbolic-link traversal. An empty directory or README is not a runtime.
  let remaining = 20_000;
  const visit = (dir, depth) => {
    if (depth > 6) return false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (--remaining < 0) throw new Error("Inventory limit reached.");
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isFile() && /\.(exe|dll|node|js|mjs|cjs|py|wasm)$/i.test(entry.name) && isFile(path)) return true;
      if (entry.isDirectory() && visit(path, depth + 1)) return true;
    }
    return false;
  };
  try { return visit(path, 0); } catch { return false; }
}
function inspectConfigNames(root) {
  // Only inspect names in the source root and config/. Never read potential secrets.
  let count = 0;
  let complete = true;
  let remaining = 20_000;
  const sensitive = /^(?:\.env(?:\..*)?|secrets|credentials(?:\..*)?|app-config\.json|dsh-pets\.json)$|\.(?:dpapi|pem|key|pfx|sqlite(?:-.*)?|db)$/i;
  const visit = (dir, recurse, depth = 0) => {
    if (depth > 8) { complete = false; return; }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (--remaining < 0) { complete = false; return; }
      if (sensitive.test(entry.name)) count++;
      if (!recurse || sensitive.test(entry.name)) continue;
      if (entry.isSymbolicLink()) { complete = false; continue; }
      if (entry.isDirectory()) visit(join(dir, entry.name), true, depth + 1);
    }
  };
  try {
    visit(root, false);
    const config = join(root, "config");
    if (contained(root, config)) visit(config, true);
    else complete = false;
  } catch { complete = false; }
  return { count, complete };
}

/** File-presence evidence only; manual acceptance always remains explicit. */
export function inspectDistribution({ root = repositoryRoot, env = process.env } = {}) {
  root = resolve(root);
  const sandbox = resolve(root, "../_sandbox/f01-dsh-desktop");
  const paths = {
    electron: env.NEKO_FISH_ELECTRON || join(sandbox, "src/apps/desktop/node_modules/electron/dist/electron.exe"),
    assets: env.NEKO_FISH_ASSETS_DIR || resolve(root, "../_sandbox/f04-renderer/assets/webm"),
    dsh: env.NEKO_FISH_DSH_RUNTIME || join(sandbox, "src/apps/desktop/.desktop-build/development/project"),
    primary: env.NEKO_FISH_DSH_PRIMARY_RUNTIME || join(sandbox, "primary-runtime-stub/primary-runtime"),
  };
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  const file = (id, path, detail) => add(id, isFile(path) ? "present" : "blocked", detail);
  const manifest = json(join(root, "package.json"));
  add("source-manifest", manifest ? "present" : "blocked", "源码 package.json 必须可解析；不输出其中的配置内容。");
  file("desktop-entry", join(root, "apps/desktop/main.cjs"), "开发桌面入口文件。");
  file("electron", paths.electron, "Electron 可执行文件；存在不证明版本、架构或依赖完整。");
  file("dsh-host", join(paths.dsh, "node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js"), "DSH Host 入口；存在不证明模型任务或工具可运行。");
  const primaryStub = /(?:^|[\\/])[^\\/]*stub[^\\/]*(?:[\\/]|$)/i.test(paths.primary);
  add("primary-runtime", !primaryStub && containsPayload(paths.primary) ? "present" : "blocked",
    "primary-runtime 必须包含实际运行文件，不能使用空目录或已知 stub；通过仍需完整工具验收。");
  add("avatar-clips", clips.every((name) => isFile(join(paths.assets, "dsh-pet", `${name}.webm`))) ? "present" : "blocked",
    "主角色及子代理所用动画片段必须齐全，文字占位不能替代原素材验收。");
  file("avatar-attribution", join(paths.assets, "ATTRIBUTION.md"), "素材署名文本必须随素材保存；存在不代表已获全部分发授权。");
  for (const [id, path] of Object.entries(paths)) {
    add(`self-contained-${id}`, contained(root, path) ? "present" : "blocked",
      "依赖应在交付目录内；检查真实路径，外部沙箱或链接到目录外均不满足独立交付。");
  }
  const main = manifest?.main;
  add("packaged-entry", typeof main === "string" && contained(root, resolve(root, main)) && isFile(resolve(root, main)) ? "present" : "blocked",
    "Electron 应用清单需要有效 main 入口；npm start 的开发脚本不等于安装包入口。");
  add("source-license", ["LICENSE", "LICENSE.md", "COPYING"].some((name) => isFile(join(root, name))) ? "present" : "blocked",
    "本项目根目录的代码许可文件；各上游许可不能自动替代本项目许可决定。");
  const lock = json(join(root, "config/upstream-lock.json"));
  add("runtime-release-lock", lock?.purpose === "source_review_snapshot_not_release_lock" ? "blocked" : "manual",
    "源码审阅提交号不能替代目标平台运行时清单、版本和文件校验值；必须另行核对完整发布锁定信息。");
  const configNames = inspectConfigNames(root);
  add("source-data-names", configNames.complete && configNames.count === 0 ? "present" : "blocked",
    configNames.count ? "源码根目录或 config/ 内发现用户数据/密钥类文件名；未读取内容，也不输出文件名。"
      : !configNames.complete ? "源码根目录或 config/ 文件名检查不完整，可能缺失、不可访问、含链接或超过扫描上限。"
        : "仅检查源码根目录和 config/ 文件名；此项不是完整包内容或凭据扫描。");
  add("installer", "manual", "尚需构建独立安装包并在无开发沙箱的 Windows 环境验证启动、升级、卸载和数据保留。");
  add("licenses", "manual", "按实际打包清单保留 Electron、DSH 及其依赖许可与素材署名，并核对素材分发范围。");
  add("real-chat", "manual", "用户在本机设置聊天 API 后验证真实流式、超时、取消与恢复；此预检不读密钥、不发请求。");
  add("real-dsh", "manual", "用户在内置 DSH 登录后验证账号、官方余额/充值入口、审批/停止/恢复和四类实际成果。");
  add("package-content", "manual", "对最终安装包使用显式文件白名单，排除用户 profile、密钥、数据库、工作区产物、日志和旧服务。");
  return { schemaVersion: 1, releaseReady: false, scope: "read-only-source-and-runtime-inventory",
    blocked: checks.filter((check) => check.status === "blocked").length,
    manual: checks.filter((check) => check.status === "manual").length, checks };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes("--help") && args.length === 1) {
    console.log("node scripts/check-distribution.mjs [--json]\n只读分发预检，不启动程序、不联网、不读取用户数据。退出码 1=存在明确缺项，2=仍需人工验收。不会宣告发布完成。");
  } else if (args.some((arg) => arg !== "--json") || args.length > 1) {
    console.error("参数无效；使用 --help 查看用法。");
    process.exitCode = 2;
  } else {
    try {
      const report = inspectDistribution();
      if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`分发尚未验收：${report.blocked} 项明确缺项，${report.manual} 项人工验收。`);
        for (const check of report.checks) console.log(`[${check.status}] ${check.id}: ${check.detail}`);
      }
      process.exitCode = report.blocked ? 1 : 2;
    } catch {
      console.error("分发预检无法完成；请检查本地文件访问权限。未启动任何服务。");
      process.exitCode = 1;
    }
  }
}
