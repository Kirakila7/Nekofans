// Launch the copied executable through its real package entry, with no source
// entrypoint argument. DevTools is enabled only for this opt-in test process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const folder = process.argv[2] && resolve(process.argv[2]);
if (!folder) throw new Error("Usage: node tests/desktop/portable-smoke.mjs <portable folder>");
const withoutDsh = process.argv.includes("--without-dsh");
const prefix = withoutDsh ? "portable-no-dsh" : "portable";
if (withoutDsh) for (const name of ["dsh", "primary-runtime", "office-skills"]) assert.equal(existsSync(join(folder, "resources", name)), false, `Excluded resource: ${name}`);
const profile = mkdtempSync(join(tmpdir(), "bigfish-portable-smoke-"));
const evidence = resolve(root, "../_sandbox/v1/evidence"); mkdirSync(evidence, { recursive: true });
const checks = [], ports = new Set(), sockets = new Set();
let child, exited, api, code = 0, requests = 0;
const delay = (ms) => new Promise((yes) => setTimeout(yes, ms));
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
async function until(fn, name, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(75); }
  throw new Error(name);
}
async function cdp(url) {
  const socket = new WebSocket(url); sockets.add(socket);
  await new Promise((yes, no) => {
    const done = (error) => {
      clearTimeout(timer); socket.removeEventListener("open", opened); socket.removeEventListener("error", failed); socket.removeEventListener("close", failed);
      error ? no(error) : yes();
    };
    const opened = () => done();
    const failed = () => done(new Error("Debug transport unavailable."));
    const timer = setTimeout(failed, 10_000);
    socket.addEventListener("open", opened, { once: true }); socket.addEventListener("error", failed, { once: true }); socket.addEventListener("close", failed, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(event.data), item = pending.get(value.id);
    if (!item) return;
    pending.delete(value.id); clearTimeout(item.timer);
    if (value.error) item.no(new Error("Debug command failed.")); else item.yes(value.result);
  });
  socket.addEventListener("close", () => { for (const item of pending.values()) { clearTimeout(item.timer); item.no(new Error("Debug target closed.")); } pending.clear(); });
  const send = (method, params) => new Promise((yes, no) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); no(new Error("Debug command timed out.")); }, 15_000);
    pending.set(id, { yes, no, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async evaluate(expression) {
      const value = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (value.exceptionDetails) throw new Error("Renderer evaluation failed.");
      return value.result?.value;
    },
    async capture(name) { const value = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidence, name), Buffer.from(value.data, "base64")); },
  };
}
async function stop() {
  for (const socket of sockets) socket.close(); sockets.clear();
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send({ type: "neko-fish:shutdown" }, () => {});
    else child.kill();
  }
  const timer = setTimeout(() => child?.kill(), 12_000);
  let hardTimer;
  try {
    const exitCode = await Promise.race([exited, new Promise((_yes, no) => { hardTimer = setTimeout(() => no(new Error("Portable process did not exit.")), 20_000); })]);
    assert.equal(exitCode, 0, "portable exits normally");
  } finally { clearTimeout(timer); clearTimeout(hardTimer); child = undefined; }
}
async function start() {
  const activePort = join(profile, "DevToolsActivePort"); rmSync(activePort, { force: true });
  const env = { ...process.env, NEKO_FISH_DATA_DIR: profile,
    // Intentionally invalid: a moved package must never use inherited dev paths.
    NEKO_FISH_ASSETS_DIR: join(profile, "missing-assets"), NEKO_FISH_DSH_RUNTIME: join(profile, "missing-host"), NEKO_FISH_DSH_PRIMARY_RUNTIME: join(profile, "missing-primary") };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(join(folder, "大肥鱼桌宠.exe"), ["--settings", ...(!withoutDsh ? ["--dsh"] : []), "--remote-debugging-port=0"],
    { cwd: tmpdir(), env, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: false });
  exited = new Promise((yes, no) => { child.once("exit", yes); child.once("error", () => no(new Error("Portable executable could not start."))); });
  exited.catch(() => {});
  const port = await until(() => { try { return Number(readFileSync(activePort, "utf8").split(/\r?\n/)[0]) || false; } catch { return false; } }, "Portable debugger did not start.");
  ports.add(port);
  const targets = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
    const list = await response.json();
    for (const target of list) { try { const u = new URL(target.url); if (u.hostname === "127.0.0.1" && u.port) ports.add(Number(u.port)); } catch {} }
    return list;
  };
  const settingsTarget = await until(async () => (await targets()).find((t) => t.url.endsWith("/settings.html")), "Packaged settings page missing.");
  const settings = await cdp(settingsTarget.webSocketDebuggerUrl);
  await until(() => settings.evaluate("Boolean(window.fishSettings && document.getElementById('name')?.value)"), "Packaged settings did not initialize.");
  const getPet = async () => {
    for (const target of await targets()) {
      if (!/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(target.url)) continue;
      const page = await cdp(target.webSocketDebuggerUrl);
      if (await page.evaluate("Boolean(window.nekoPet)")) return page;
    }
    return false;
  };
  let dsh;
  if (!withoutDsh) {
    const dshTarget = await until(async () => (await targets()).find((t) => /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url) && !t.url.endsWith("/index.html")), "Packaged DSH did not start.");
    dsh = await cdp(dshTarget.webSocketDebuggerUrl);
    await until(() => dsh.evaluate("document.querySelectorAll('#root *').length > 20"), "Packaged DSH UI did not mount.");
  }
  return { settings, getPet, dsh };
}
try {
  api = createServer((_req, res) => { requests++; res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"便携版测试回复，乌龙茶已收到。"}}]}\n\ndata: [DONE]\n\n'); });
  await new Promise((yes) => api.listen(0, "127.0.0.1", yes)); ports.add(api.address().port);
  let session = await start();
  check(withoutDsh ? "actual-executable-and-settings-start-without-dsh-and-with-invalid-dev-paths" : "actual-executable-entry-settings-and-dsh-start-with-invalid-dev-paths", requests === 0);
  let pet = await until(session.getPet, "Packaged pet missing.");
  await until(() => pet.evaluate("[...document.querySelectorAll('video')].some(v => v.currentTime > 0 && v.readyState >= 2)"), "Packaged animation did not play.");
  check("packaged-animation-plays", true);
  await session.settings.evaluate(`(() => { document.getElementById('base-url').value = 'http://127.0.0.1:${api.address().port}/v1'; document.getElementById('model').value = 'portable-synthetic'; document.getElementById('api-key').value = 'portable-synthetic-key'; document.getElementById('api-form').requestSubmit(); })()`);
  await until(() => session.settings.evaluate("document.getElementById('status').textContent.startsWith('已保存')"), "Packaged API save failed.");
  check("packaged-save-is-local-and-key-is-encrypted", requests === 0 && !readFileSync(join(profile, "secrets/chat-api-key.dpapi"), "utf8").includes("portable-synthetic-key"));
  await session.settings.evaluate("document.getElementById('persona-tab').click(); document.getElementById('name').value = '便携版测试角色'; document.getElementById('persona-form').requestSubmit()");
  await until(() => session.settings.evaluate("document.getElementById('status').textContent.startsWith('已保存')"), "Packaged persona save failed.");
  pet = await until(session.getPet, "Pet missing after restart.");
  await pet.evaluate("window.nekoPet.send({ type: 'submit', text: '我喜欢喝乌龙茶。' })");
  await until(() => pet.evaluate("window.nekoPet.getSnapshot().then(s => s.chat.phase === 'idle' && s.memory.pending.length === 1)"), "Packaged chat/memory flow failed.");
  await pet.evaluate("window.nekoPet.send({ type: 'show-memories' })");
  await until(() => pet.evaluate("Boolean(document.querySelector('#pending-memories .primary-btn'))"), "Packaged memory panel missing.");
  await pet.evaluate("document.querySelector('#pending-memories .primary-btn').click()");
  await until(() => pet.evaluate("window.nekoPet.getSnapshot().then(s => s.memory.confirmed.length === 1)"), "Packaged memory confirm failed.");
  check("packaged-local-chat-and-memory-confirmation", requests === 1);
  await pet.capture(`${prefix}-memory.png`); if (session.dsh) await session.dsh.capture("portable-dsh.png");
  await stop();
  check("first-portable-process-exits-normally", true);
  session = await start(); pet = await until(session.getPet, "Restarted pet missing.");
  const settings = await session.settings.evaluate("window.fishSettings.read()");
  const snapshot = await until(async () => {
    const value = await pet.evaluate("window.nekoPet.getSnapshot()");
    return value?.memory?.confirmed.length === 1 && value.history.some((m) => m.role === "assistant") ? value : false;
  }, "Restarted history and memory did not restore.");
  check("portable-restart-preserves-persona-key-history-and-memory", settings.hasKey && settings.persona.name === "便携版测试角色" && snapshot.memory.confirmed.length === 1 && snapshot.history.some((m) => m.role === "assistant") && requests === 1);
  await stop(); check("second-portable-process-exits-normally", true);
} catch (error) { code = 1; console.error("PORTABLE_SMOKE_FAILED", error.message); }
finally {
  try { await stop(); } catch { code = 1; }
  api?.closeAllConnections(); if (api) await new Promise((yes) => api.close(yes));
  const portResults = await Promise.all([...ports].map(async (port) => ({ port, closed: await new Promise((yes) => {
    const socket = createConnection({ host: "127.0.0.1", port }); socket.once("connect", () => { socket.destroy(); yes(false); }); socket.once("error", () => yes(true));
  }) })));
  if (portResults.some((p) => !p.closed)) code = 1;
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith("bigfish-portable-smoke-")) throw new Error("Unexpected temporary profile.");
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const report = { ok: code === 0, checks, folder, source: withoutDsh ? "actual packaged executable; synthetic local Chat API; DSH excluded" : "actual packaged executable; synthetic local Chat API; real DSH Host without login", ports: portResults, profileRemoved: true };
  writeFileSync(join(evidence, `${prefix}-smoke.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
process.exitCode = code;
