import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DshHost } from "../../packages/dsh-bridge/src/host.ts";

function fixture(t: TestContext, behavior: "ready" | "hang" | "fatal") {
  const root = mkdtempSync(join(tmpdir(), "dsh-host-lifecycle-"));
  const runtimeDir = join(root, "runtime"), primaryRuntimeDir = join(root, "primary");
  const entryDir = join(runtimeDir, "node_modules/@deepseek-ai/dsh-desktop-host/lib");
  mkdirSync(entryDir, { recursive: true }); mkdirSync(primaryRuntimeDir);
  // A real child process and listener, exercising the supervisor rather than mocking spawn.
  writeFileSync(join(entryDir, "index.js"), `
    const http = require('node:http');
    const mode = ${JSON.stringify(behavior)};
    const server = http.createServer((_req, res) => res.writeHead(302, { 'set-cookie': 'dsh-api=synthetic; HttpOnly' }).end());
    server.listen(0, '127.0.0.1', () => {
      if (mode === 'ready') process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port + '/?token=synthetic' });
      if (mode === 'fatal') process.send({ type: 'fatal', message: 'private upstream detail' });
    });
    process.on('message', m => { if (m.type === 'shutdown') server.close(() => process.exit(0)); });
    process.on('disconnect', () => server.close(() => process.exit(0)));
  `);
  const host = new DshHost({ runtimeDir, primaryRuntimeDir, dataDir: join(root, "data"), startupTimeoutMs: behavior === "hang" ? 150 : 3000, shutdownTimeoutMs: 1000 });
  t.after(async () => { await host.stop(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  return host;
}

test("Host shares concurrent starts and repeated stop closes the child exactly once", async (t) => {
  const host = fixture(t, "ready");
  const [first, second] = await Promise.all([host.start(), host.start()]);
  assert.equal(first, second); assert.ok(host.pid());
  await Promise.all([host.stop(), host.stop()]);
  assert.equal(host.pid(), undefined);
  await assert.rejects(fetch(first.url));
  await assert.rejects(host.start(), /closing/);
});

test("startup timeout and fatal messages clean the process and conceal upstream diagnostics", async (t) => {
  for (const mode of ["hang", "fatal"] as const) {
    const host = fixture(t, mode);
    await assert.rejects(host.start(), (error: Error) => { assert.equal(error.message, "DSH could not start. Check the local runtime."); return true; });
    assert.equal(host.pid(), undefined);
  }
});

test("stop while startup is pending waits for child exit and prevents late readiness", async (t) => {
  const host = fixture(t, "hang");
  const opening = assert.rejects(host.start());
  await host.stop(); await opening;
  assert.equal(host.pid(), undefined);
});
