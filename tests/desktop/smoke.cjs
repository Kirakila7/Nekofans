// Opt-in real Electron integration check. Uses only a synthetic loopback API and an isolated profile.
// Run: node tests/desktop/run-smoke.mjs (the runner owns and removes the temporary profile).
const assert = require("node:assert/strict");
const { app, BrowserWindow, Menu } = require("electron");
const electron = require("electron");
const { EventEmitter } = require("node:events");
const { createServer } = require("node:http");
const { createConnection } = require("node:net");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { pathToFileURL } = require("node:url");

const repository = resolve(__dirname, "../..");
const evidence = resolve(repository, "../_sandbox/v1/evidence");
mkdirSync(evidence, { recursive: true });
const profile = process.env.NEKO_FISH_SMOKE_PROFILE;
if (!profile) throw new Error("Use node tests/desktop/run-smoke.mjs to manage the isolated profile.");
app.setPath("userData", profile);
process.env.NEKO_FISH_ASSETS_DIR = resolve(repository, "../_sandbox/f04-renderer/assets/webm");

let runtime;
let server;
let template;
let code = 0;
const ports = new Set();
const requestBodies = [];
const checks = [];
const delay = (ms) => new Promise((yes) => setTimeout(yes, ms));
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
async function until(condition, message) {
  for (let n = 0; n < 150; n++) {
    if (await condition()) return;
    await delay(80);
  }
  throw new Error(message);
}
function pet() { return runtime.pet().window().window; }
function menu(label) { const item = template.find((entry) => entry.label === label); assert.ok(item); item.click(); }
function settingWindow() { return BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith("settings.html")); }
async function capture(win, name) {
  await delay(350);
  writeFileSync(join(evidence, name), (await win.webContents.capturePage()).toPNG());
}
async function closedPort(port) {
  return new Promise((yes) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); yes(false); });
    socket.once("error", () => yes(true));
  });
}
const watchdog = setTimeout(() => { console.error("DESKTOP_SMOKE_TIMEOUT"); app.exit(2); }, 90_000);

app.whenReady().then(async () => {
  try {
    server = createServer((req, res) => {
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      let body = "";
      req.on("data", (part) => { body += part; });
      req.on("end", () => {
        requestBodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write('data: {"choices":[{"delta":{"content":"乌龙茶的香气，"}}]}\n\n');
        const timer = setTimeout(() => {
          res.write('data: {"choices":[{"delta":{"content":"我会等你确认后再记住。"}}]}\n\n');
          res.end("data: [DONE]\n\n");
        }, 500);
        res.once("close", () => clearTimeout(timer));
      });
    });
    await new Promise((yes) => server.listen(0, "127.0.0.1", yes));
    const mockPort = server.address().port;
    ports.add(mockPort);
    const { launchDesktop } = await import(pathToFileURL(resolve(repository, "apps/desktop/desktop.ts")).href);
    let simulatedArea;
    const screen = Object.assign(new EventEmitter(), {
      getPrimaryDisplay: () => simulatedArea ? { workArea: simulatedArea } : electron.screen.getPrimaryDisplay(),
      getAllDisplays: () => simulatedArea ? [{ workArea: simulatedArea }] : electron.screen.getAllDisplays(),
      getCursorScreenPoint: () => electron.screen.getCursorScreenPoint(),
    });
    runtime = await launchDesktop({ ...electron, screen, Menu: {
      setApplicationMenu: (value) => Menu.setApplicationMenu(value),
      buildFromTemplate: (items) => { template = items; return Menu.buildFromTemplate(items); },
    } });
    ports.add(runtime.pet().server.port);
    await until(() => pet().webContents.executeJavaScript("Boolean(window.__nekoPetView && window.__nekoPetView.renders > 0)"), "Pet renderer did not initialize");
    check("native-menu-has-chat-dsh-and-global-settings", template.some((item) => item.label === "打开内置 DSH") && template.find((item) => item.label === "全局设置")?.submenu.length === 2);
    pet().setPosition(-30000, -30000);
    template.find((item) => item.label === "全局设置").submenu.find((item) => item.label === "将桌宠移回可见区域").click();
    const inside = (bounds, area) => bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height;
    check("global-settings-recovers-offscreen-native-pet", electron.screen.getAllDisplays().some((display) => inside(pet().getBounds(), display.workArea)));
    const normalSize = pet().getSize();
    const primary = electron.screen.getPrimaryDisplay().workArea;
    simulatedArea = { x: primary.x, y: primary.y, width: 320, height: 480 };
    screen.emit("display-metrics-changed");
    const fitSmall = inside(pet().getBounds(), simulatedArea) && pet().webContents.getZoomFactor() < 1;
    simulatedArea = undefined; screen.emit("display-metrics-changed");
    check("native-pet-fits-simulated-small-workarea-and-restores", fitSmall && pet().webContents.getZoomFactor() === 1 && pet().getSize().every((value, i) => value === normalSize[i]));
    check("unconfigured-start-has-no-network", requestBodies.length === 0 && runtime.read().hasKey === false);
    await until(() => pet().webContents.executeJavaScript("[...document.querySelectorAll('video')].some(video => video.classList.contains('is-front') && video.readyState >= 2 && video.currentTime > 0)"), "Avatar video did not become ready");
    check("real-avatar-video-plays", true);
    await capture(pet(), "desktop-pet.png");
    await runtime.pet().overlay.handleCommand({ type: "submit", text: "尚未配置时的本地检查" });
    check("unconfigured-send-remains-local", requestBodies.length === 0 && runtime.pet().overlay.snapshot().chat.phase === "error");

    menu("API 设置");
    await until(() => settingWindow(), "Settings did not open");
    const settings = settingWindow();
    await until(() => settings.webContents.executeJavaScript("Boolean(window.fishSettings)"), "Settings preload did not initialize");
    const initial = await settings.webContents.executeJavaScript("window.fishSettings.read()");
    check("settings-ipc-valid-main-frame", initial.ok && !initial.hasKey && initial.mainChat.baseUrl === "");
    await capture(settings, "desktop-api-settings.png");
    await settings.webContents.executeJavaScript(`(() => {
      document.getElementById('base-url').value = 'http://127.0.0.1:${mockPort}/v1';
      document.getElementById('model').value = 'synthetic-test-model';
      document.getElementById('api-key').value = 'synthetic-local-only-key';
      document.getElementById('api-form').requestSubmit();
    })()`);
    await until(() => settings.webContents.executeJavaScript("document.getElementById('status').textContent.startsWith('已保存')"), "API settings save failed");
    ports.add(runtime.pet().server.port);
    check("save-does-not-connect-to-api", requestBodies.length === 0);
    check("api-key-dpapi-only", !readFileSync(join(profile, "app-config.json"), "utf8").includes("synthetic-local-only-key")
      && !readFileSync(join(profile, "secrets/chat-api-key.dpapi"), "utf8").includes("synthetic-local-only-key"));
    const state = await settings.webContents.executeJavaScript("window.fishSettings.read()");
    check("stored-key-never-returned-to-settings", state.hasKey && !JSON.stringify(state).includes("synthetic-local-only-key"));
    check("key-input-cleared", await settings.webContents.executeJavaScript("document.getElementById('api-key').value === ''"));

    const send = runtime.pet().overlay.handleCommand({ type: "submit", text: "我喜欢喝乌龙茶。" });
    await until(() => runtime.pet().overlay.snapshot().chat.streaming.length > 0, "Streaming reply did not arrive");
    check("local-api-streams", runtime.pet().overlay.snapshot().chat.phase === "replying");
    await send;
    await until(() => runtime.pet().overlay.snapshot().memory.pending.length === 1, "Pending memory missing");
    menu("完整回复");
    await until(() => pet().webContents.executeJavaScript("!document.getElementById('history-panel').hidden"), "History menu did not open panel");
    await capture(pet(), "desktop-chat-history.png");
    menu("记忆管理");
    await until(() => pet().webContents.executeJavaScript("!document.getElementById('memory-panel').hidden && document.querySelector('#pending-memories .primary-btn') !== null"), "Memory panel did not render pending item");
    await capture(pet(), "desktop-memory-pending.png");
    await pet().webContents.executeJavaScript("document.querySelector('#pending-memories .primary-btn').click()");
    await until(() => runtime.pet().overlay.snapshot().memory.confirmed.length === 1, "Memory confirm failed");
    check("memory-ui-confirms", runtime.pet().overlay.snapshot().memory.pending.length === 0);

    menu("角色设定");
    await until(() => settings.webContents.executeJavaScript("!document.getElementById('persona-form').hidden"), "Persona menu did not select page");
    await capture(settings, "desktop-persona-settings.png");
    await settings.webContents.executeJavaScript("document.getElementById('name').value = '测试大肥鱼'; document.getElementById('persona-form').requestSubmit()");
    await until(() => settings.webContents.executeJavaScript("document.getElementById('status').textContent.startsWith('已保存')"), "Persona save failed");
    ports.add(runtime.pet().server.port);
    await until(() => runtime.pet().overlay.snapshot().memory.confirmed.length === 1, "Restart lost confirmed memory");
    check("restart-keeps-persona-history-memory", runtime.read().persona.name === "测试大肥鱼" && runtime.pet().overlay.snapshot().history.some((entry) => entry.role === "assistant"));
    await runtime.pet().overlay.handleCommand({ type: "submit", text: "我刚才提过什么饮品？" });
    check("confirmed-memory-recalled", requestBodies.length === 2 && requestBodies[1].messages[0].content.includes("用户喜欢喝乌龙茶"));
    const busyTurn = runtime.pet().overlay.handleCommand({ type: "submit", text: "这条回复用于取消检查" });
    await until(() => runtime.pet().overlay.snapshot().chat.streaming.length > 0, "Cancellation stream did not begin");
    await runtime.pet().overlay.handleCommand({ type: "cancel-reply" });
    await busyTurn;
    check("running-chat-cancels", runtime.pet().overlay.snapshot().chat.phase === "idle");
    const { SqliteConversationStore } = await import(pathToFileURL(resolve(repository, "packages/conversation-store/src/index.ts")).href);
    const archive = new SqliteConversationStore(join(profile, "conversations.sqlite"));
    const conversationId = archive.latestConversationId("bigfish");
    const sourceMarker = '<img src=x onerror=alert(1)>摘要来源标记';
    try {
      for (let i = 0; i < 40; i++) await archive.append({ id: `smoke-summary-${i}`, personaId: "bigfish", conversationId,
        role: i % 2 ? "assistant" : "user", text: i === 0 ? sourceMarker : `摘要测试历史 ${i}，尚未确认。`, createdAt: i });
    } finally { archive.close(); }
    await runtime.pet().overlay.handleCommand({ type: "submit", text: "请整理摘要测试历史。" });
    menu("记忆管理");
    await until(() => runtime.pet().overlay.snapshot().summaries?.items.length > 0, "Historical summaries were not generated");
    const summary = runtime.pet().overlay.snapshot().summaries.items.find((s) => s.sourceMessageIds.includes("smoke-summary-0"));
    check("old-history-summarized-with-source-identities", !!summary);
    await until(() => pet().webContents.executeJavaScript(`!!document.querySelector('[data-summary-id="${summary.id}"] .quiet-btn')`), "Summary row did not render");
    await pet().webContents.executeJavaScript(`document.querySelector('[data-summary-id="${summary.id}"] .quiet-btn').click()`);
    await until(() => pet().webContents.executeJavaScript("document.querySelector('.summary-sources')?.textContent.includes('摘要来源标记')"), "Source UI did not open");
    check("source-preview-is-text-only", await pet().webContents.executeJavaScript("document.querySelector('.summary-sources').textContent.includes('<img') && !document.querySelector('.summary-sources img')"));
    await pet().webContents.executeJavaScript("document.querySelector('.summary-sources').scrollIntoView({block:'start'})");
    await capture(pet(), "desktop-summary-sources.png");
    await pet().webContents.executeJavaScript(`document.querySelector('[data-summary-id="${summary.id}"] .danger-btn').click()`);
    await until(() => !runtime.pet().overlay.snapshot().summaries.items.some((s) => s.id === summary.id), "Summary delete did not complete");
    await runtime.pet().overlay.handleCommand({ type: "submit", text: "删除后继续聊。" });
    check("deleted-summary-is-not-recreated-or-sent", !requestBodies.at(-1).messages[0].content.includes("摘要来源标记") && !runtime.pet().overlay.snapshot().summaries.items.some((s) => s.id === summary.id));
    menu("打开内置 DSH");
    const isDsh = (win) => /^http:\/\/127\.0\.0\.1:\d+\//.test(win.webContents.getURL()) && !win.webContents.getURL().startsWith(runtime.pet().server.origin + "/");
    await until(() => BrowserWindow.getAllWindows().find(isDsh), "Real DSH workbench did not open");
    const dsh = BrowserWindow.getAllWindows().find(isDsh);
    ports.add(Number(new URL(dsh.webContents.getURL()).port));
    await until(() => dsh.webContents.executeJavaScript("document.querySelectorAll('#root *').length > 20"), "Real DSH web UI did not mount");
    check("real-dsh-workbench-ui-mounts", true);
    check("dsh-has-no-chat-settings-or-node-bridge", await dsh.webContents.executeJavaScript("typeof require === 'undefined' && !window.nekoPet && !window.fishSettings"));
    await capture(dsh, "desktop-dsh-workbench.png");
    dsh.close();
    check("closing-dsh-keeps-main-pet", !pet().isDestroyed());
  } catch (error) {
    code = 1;
    console.error("DESKTOP_SMOKE_FAILED", error && error.message);
  } finally {
    if (runtime) await runtime.stop().catch(() => { code = 1; });
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    if (server) { server.closeAllConnections(); await new Promise((yes) => server.close(yes)); }
    const portResults = await Promise.all([...ports].map(async (port) => ({ port, closed: await closedPort(port) })));
    if (portResults.some((result) => !result.closed)) code = 1;
    writeFileSync(join(evidence, "desktop-smoke.json"), JSON.stringify({ ok: code === 0, checks, ports: portResults, profile, electron: process.versions.electron, node: process.versions.node }, null, 2));
    console.log(JSON.stringify({ ok: code === 0, checks: checks.length, ports: portResults, evidence }));
    clearTimeout(watchdog);
    app.exit(code);
  }
});
