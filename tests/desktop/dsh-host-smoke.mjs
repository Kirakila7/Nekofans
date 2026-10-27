// Real DSH Host, isolated temporary profile; no login, model request, or paid task.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { DshHost } from "../../packages/dsh-bridge/src/host.ts";
import { DshSession } from "../../packages/dsh-bridge/src/session.ts";
import { readDshCatalog } from "../../packages/dsh-bridge/src/catalog.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sandbox = resolve(root, "../_sandbox/f01-dsh-desktop");
const temporary = resolve(tmpdir());
const dataDir = mkdtempSync(join(temporary, "bigfish-dsh-smoke-"));
const evidence = resolve(root, "../_sandbox/v1/evidence");
const ports = [];
let host;
const report = { ok: false, checks: [], ports: [], profileRemoved: false };
try {
  const options = { runtimeDir: process.env.NEKO_FISH_DSH_RUNTIME || join(sandbox, "src/apps/desktop/.desktop-build/development/project"),
    primaryRuntimeDir: process.env.NEKO_FISH_DSH_PRIMARY_RUNTIME || join(sandbox, "primary-runtime-stub/primary-runtime"), dataDir };
  host = new DshHost(options);
  const first = await host.start();
  ports.push(Number(new URL(first.url).port));
  assert.ok(host.pid());
  report.checks.push("real-host-ready");
  const exchange = await fetch(first.url, { redirect: "manual" });
  assert.ok([302, 303].includes(exchange.status));
  const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const response = await fetch(new URL(exchange.headers.get("location"), first.url), { headers: { cookie } });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes("<script") && html.includes("__DSH_BOOT__"));
  report.checks.push("real-dsh-web-document-and-boot-injections");
  const workspace = await first.client.call("workspace/initializeDefault", {});
  assert.ok(resolve(workspace.workspace.path).toLowerCase().startsWith((resolve(dataDir) + "\\").toLowerCase()), `Default workspace outside profile: ${workspace.workspace.path}`);
  report.checks.push("default-workspace-inside-private-profile");
  const session = await DshSession.create(first.client, { cwd: workspace.workspace.path });
  assert.ok((await DshSession.list(first.client)).some((s) => s.sessionId === session.session_id));
  const projection = await first.client.call("session/projections", { request: { sessionId: session.session_id } });
  assert.ok(projection && projection.values);
  assert.deepEqual(await readDshCatalog(first.client), []);
  report.checks.push("real-session-and-projection-rpc-empty-catalog-no-fabricated-pets");
  const streamAbort = new AbortController();
  const streamSignal = AbortSignal.any([streamAbort.signal, AbortSignal.timeout(10_000)]);
  const workspaces = first.client.stream("workspace/follow", {}, streamSignal)[Symbol.asyncIterator]();
  const controls = first.client.stream("session/control", {}, streamSignal)[Symbol.asyncIterator]();
  try {
    const [workspaceFrame, controlFrame] = await Promise.all([workspaces.next(), controls.next()]);
    assert.equal(workspaceFrame.value.type, "baseline");
    assert.ok(workspaceFrame.value.value.items.some((w) => w.workspaceId === workspace.workspace.workspaceId));
    assert.equal(controlFrame.value.type, "baseline");
    assert.ok(controlFrame.value.value.projections[session.session_id]);
    report.checks.push("authenticated-real-workspace-and-control-stream-baselines");
    await first.client.call("workspace/rename", { request: { workspaceId: workspace.workspace.workspaceId, title: "Isolated stream smoke" } });
    const workspaceChange = (await workspaces.next()).value;
    assert.equal(workspaceChange.type, "upsert");
    assert.equal(workspaceChange.workspace.title, "Isolated stream smoke");
    await first.client.call("session/rename", { request: { sessionId: session.session_id, title: "Synthetic stream title" } });
    const controlChange = (await controls.next()).value;
    assert.equal(controlChange.type, "projection");
    assert.equal(controlChange.sessionId, session.session_id);
    assert.equal(controlChange.key, "title");
    assert.equal(controlChange.value, "Synthetic stream title");
    report.checks.push("real-workspace-and-title-mutations-delivered-over-websocket");
  } finally {
    streamAbort.abort();
    await Promise.all([workspaces.return(), controls.return()]);
  }
  report.checks.push("real-stream-subscriptions-cancelled-before-host-stop");
  assert.ok((await DshSession.list(first.client)).some((s) => s.sessionId === session.session_id));
  const reconnectAbort = new AbortController();
  const reconnected = first.client.stream("workspace/follow", {}, AbortSignal.any([reconnectAbort.signal, AbortSignal.timeout(10_000)]))[Symbol.asyncIterator]();
  try {
    const frame = (await reconnected.next()).value;
    assert.equal(frame.type, "baseline");
    assert.ok(frame.value.items.some((w) => w.title === "Isolated stream smoke"));
  } finally { reconnectAbort.abort(); await reconnected.return(); }
  report.checks.push("stream-reconnect-mints-fresh-operator-and-preserves-unary-client");
  await host.stop();
  assert.equal(host.pid(), undefined);
  report.checks.push("real-host-graceful-exit");
  host = new DshHost(options);
  const second = await host.start();
  ports.push(Number(new URL(second.url).port));
  assert.ok((await DshSession.list(second.client)).some((s) => s.sessionId === session.session_id));
  report.checks.push("session-survives-host-restart");
  report.ok = true;
} catch (error) {
  console.error("DSH_SMOKE_FAILED", error.message);
  process.exitCode = 1;
} finally {
  await host?.stop();
  report.ports = await Promise.all(ports.map(async (port) => ({ port, closed: await new Promise((yes) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); yes(false); });
    socket.once("error", () => yes(true));
  }) })));
  if (dirname(resolve(dataDir)) !== temporary || !basename(dataDir).startsWith("bigfish-dsh-smoke-")) throw new Error("Unexpected smoke profile location.");
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  report.profileRemoved = true;
  report.ok &&= report.ports.every((p) => p.closed);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "dsh-host-smoke.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
