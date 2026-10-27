// Exercises the exact parent-lifecycle handler used by the production entry.
const { app, BrowserWindow, Menu } = require("electron");
const electron = require("electron");
const { createConnection } = require("node:net");
const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const profile = process.env.NEKO_FISH_SMOKE_PROFILE;
if (!profile || !process.connected) throw new Error("Run through run-smoke.mjs.");
app.setPath("userData", profile);
require("../../apps/desktop/parent-lifecycle.cjs").installParentLifecycle(app);
let port;
const ports = [];
const watchdog = setTimeout(() => app.exit(2), 40_000);
app.whenReady().then(async () => {
  const { launchDesktop } = await import(pathToFileURL(resolve(__dirname, "../../apps/desktop/desktop.ts")).href);
  let template;
  const runtime = await launchDesktop({ ...electron, Menu: {
    setApplicationMenu: (menu) => Menu.setApplicationMenu(menu),
    buildFromTemplate: (items) => { template = items; return Menu.buildFromTemplate(items); },
  } });
  port = runtime.pet().server.port;
  ports.push(port);
  template.find((item) => item.label === "打开内置 DSH").click();
  let dsh;
  for (let n = 0; n < 200; n++) {
    dsh = BrowserWindow.getAllWindows().find((win) => /^http:\/\/127\.0\.0\.1:\d+\//.test(win.webContents.getURL()) && !win.webContents.getURL().startsWith(runtime.pet().server.origin + "/"));
    if (dsh) break;
    await new Promise((yes) => setTimeout(yes, 100));
  }
  if (!dsh) throw new Error("DSH host did not start for shutdown check.");
  ports.push(Number(new URL(dsh.webContents.getURL()).port));
  process.send({ type: "neko-fish:smoke-ready" });
}).catch(() => app.exit(1));
app.on("will-quit", (event) => {
  event.preventDefault();
  Promise.all(ports.map((value) => new Promise((yes) => {
    const socket = createConnection({ host: "127.0.0.1", port: value });
    socket.once("connect", () => { socket.destroy(); yes(false); });
    socket.once("error", () => yes(true));
  }))).then((results) => {
    if (results.some((closed) => !closed)) { app.exit(1); return; }
    const mode = process.env.NEKO_FISH_SMOKE_SHUTDOWN;
    writeFileSync(resolve(__dirname, `../../../_sandbox/v1/evidence/desktop-shutdown-${mode}.json`), JSON.stringify({ ok: true, mode, port, ports, closed: true, dshHostWasRunning: true }));
    clearTimeout(watchdog);
    app.exit(0);
  });
});
