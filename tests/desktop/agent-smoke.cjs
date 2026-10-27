// Real helper windows driven by an explicit local RPC fixture, not real model tasks.
const assert = require("node:assert/strict");
const electron = require("electron");
const { app, BrowserWindow } = electron;
const { createServer } = require("node:http");
const { resolve, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { writeFileSync } = require("node:fs");
const { createConnection } = require("node:net");
const profile = process.env.NEKO_FISH_SMOKE_PROFILE;
if (!profile) throw new Error("Run with run-smoke.mjs.");
app.setPath("userData", profile);
const repository = resolve(__dirname, "../..");
const evidence = resolve(repository, "../_sandbox/v1/evidence");
const delay = (ms) => new Promise((yes) => setTimeout(yes, ms));
const checks = [];
let desktop, server, code = 0;
let helperPort;
async function until(condition) { for (let n = 0; n < 100; n++) { if (await condition()) return; await delay(60); } throw new Error("Helper UI timed out."); }
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
const watchdog = setTimeout(() => app.exit(2), 30_000);
app.whenReady().then(async () => {
  try {
    server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Local test fixture</title>"));
    await new Promise((yes) => server.listen(0, "127.0.0.1", yes));
    const { clientFixture } = await import(pathToFileURL(join(repository, "tests/dsh-bridge/fixture.ts")).href);
    const f = await clientFixture();
    const { DshDesktop } = await import(pathToFileURL(join(repository, "apps/desktop/dsh.ts")).href);
    desktop = new DshDesktop({ electron, repositoryRoot: repository, dataDir: profile, assetsDir: resolve(repository, "../_sandbox/f04-renderer/assets/webm"),
      host: { start: async () => ({ client: f.client, url: `http://127.0.0.1:${server.address().port}/` }), stop: async () => {}, pid: () => undefined } });
    await desktop.open();
    const helpers = BrowserWindow.getAllWindows().filter((w) => w.getTitle() === "DSH 子代理");
    check("two-real-helper-windows-from-fixture-catalog", helpers.length === 2);
    let helper;
    await until(async () => {
      for (const win of helpers) {
        if (await win.webContents.executeJavaScript("document.getElementById('status')?.textContent === '工作中'")) { helper = win; return true; }
      }
      return false;
    });
    helperPort = Number(new URL(helper.webContents.getURL()).port);
    await until(() => helper.webContents.executeJavaScript("document.getElementById('status').textContent === '工作中'"));
    await until(() => helper.webContents.executeJavaScript("document.getElementById('video').currentTime > 0"));
    check("helper-plays-real-work-clip", true);
    await helper.webContents.executeJavaScript("document.getElementById('pet').click()");
    check("click-opens-and-focuses-single-line-composer", await helper.webContents.executeJavaScript("!document.getElementById('dialog').hidden && document.activeElement.id === 'input'"));
    await helper.webContents.executeJavaScript("document.getElementById('input').value = 'continue fixture child'; document.getElementById('composer').requestSubmit()");
    await until(() => f.calls.some((c) => c.method === "subagents/prompt"));
    await until(() => helper.webContents.executeJavaScript("document.getElementById('input').value === ''"));
    check("helper-form-routes-to-parent-addressed-control", f.calls.at(-1).args.request.childSessionId === "child-b");
    check("one-shot-composer-is-read-only", await helpers.find((win) => win !== helper).webContents.executeJavaScript("document.getElementById('input').disabled && document.getElementById('send').disabled"));
    await helper.webContents.executeJavaScript("window.dshPet.command({ type: 'rename', name: '<img src=x onerror=alert(1)>' })");
    check("DSH-label-is-text-only", await helper.webContents.executeJavaScript("document.getElementById('task').textContent.includes('<img') && document.querySelectorAll('img').length === 0"));
    await helper.webContents.executeJavaScript("window.dshPet.command({ type: 'rename', name: '资料整理' })");
    writeFileSync(join(evidence, "desktop-agent-pet.png"), (await helper.webContents.capturePage()).toPNG());
    f.state.running = false;
    await until(() => helper.webContents.executeJavaScript("!document.getElementById('notice').hidden"));
    check("live-running-to-complete-feedback", await helper.webContents.executeJavaScript("document.getElementById('status').textContent === '已完成' && document.getElementById('video').loop === false"));
    f.state.fail = true;
    await until(() => helper.webContents.executeJavaScript("document.getElementById('status').textContent === 'DSH 连接中断'"));
    check("disconnect-preserves-window-and-blocks-send", !helper.isDestroyed() && await helper.webContents.executeJavaScript("document.getElementById('send').disabled"));
    f.state.fail = false;
    await until(() => helper.webContents.executeJavaScript("document.getElementById('status').textContent === '已完成'"));
    check("polling-recovers-after-transient-failure", true);
  } catch (error) { code = 1; console.error("AGENT_SMOKE_FAILED", error.message); }
  finally {
    await desktop?.stop().catch(() => { code = 1; });
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    server?.closeAllConnections(); if (server) await new Promise((yes) => server.close(yes));
    let closed = true;
    if (helperPort) closed = await new Promise((yes) => { const socket = createConnection({ host: "127.0.0.1", port: helperPort }); socket.once("connect", () => { socket.destroy(); yes(false); }); socket.once("error", () => yes(true)); });
    if (!closed) code = 1;
    writeFileSync(join(evidence, "desktop-agent-smoke.json"), JSON.stringify({ ok: code === 0, source: "local RPC fixture; real Electron windows and videos", checks, port: helperPort, closed }, null, 2));
    console.log(JSON.stringify({ ok: code === 0, agentChecks: checks.length, helperPort, closed }));
    clearTimeout(watchdog); app.exit(code);
  }
});
