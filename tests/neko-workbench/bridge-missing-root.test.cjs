'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.argv.includes('--bridge-harness')) {
  const run = scenario => new Promise((resolve, reject) => require('node:child_process').execFile(process.execPath, [__filename, '--bridge-harness', scenario], { timeout: 15000, maxBuffer: 2e6 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`${stdout}\n${stderr}`));
    resolve(stdout);
  }));

  test('a saved root session that DSH no longer has starts a fresh root instead of blocking the connecting page', async () => {
    assert.match(await run('missing'), /missing root fixture passed/);
  });

  test('other resume failures still fail init so the real error stays visible', async () => {
    assert.match(await run('broken'), /broken root fixture passed/);
  });
} else {
  (async () => {
    const scenario = process.argv.at(-1);
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module'), { EventEmitter } = require('node:events');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-missing-root-'));
    const originalLoad = Module._load, originalWrite = process.stdout.write;
    const lines = new EventEmitter(), frames = [], handlers = new Map(), agents = new Map(), created = [], resumed = [];
    const workspaceDir = path.join(directory, 'work');
    class ApiSessionNotFound extends Error { constructor(message) { super(message); this.name = 'ApiSessionNotFound'; } }
    const header = id => ({ id, cwd: workspaceDir, createdAt: 100 });
    const ctx = { on: (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
      get: name => name === 'loader' ? { await: async () => {} } : undefined,
      agents: { get: id => agents.get(id),
        resume: async ({ resumeSessionId }) => { resumed.push(resumeSessionId);
          if (scenario === 'missing') throw new ApiSessionNotFound(`session "${resumeSessionId}" not found`);
          throw new Error('provider credentials rejected'); },
        create: async ({ sessionId, meta }) => { created.push({ sessionId, cwd: meta.cwd }); const agent = { id: sessionId, status: 'idle', session: { id: sessionId, header: header(sessionId) } }; agents.set(sessionId, agent); return { agent }; } },
      sessionQuery: { observeSession: async id => { if (!agents.has(id)) throw Error('missing fixture'); return { header: header(id), events: [], inheritedEventCount: 0, projections: { values: { title: '' } }, [Symbol.dispose]() {} }; } },
      subagents: { listChildren: async () => [] },
      agentPresets: { mount: () => {} }, connection: { authenticatedUrl: url => url }, webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:59099/fixture' }, root: { dispose: async () => {} } };
    lines.close = () => lines.emit('close');
    const invoke = async (method, params) => { const id = Math.random(); lines.emit('line', JSON.stringify({ id, method, params })); for (let n = 0; n < 200; n++) { const response = frames.find(frame => frame.id === id); if (response) return response; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('bridge fixture RPC timeout'); };
    try {
      for (const [name, source] of [['dsh-llm', 'export const createUserMessage=value=>value;'], ['dsh-scope', 'export const carrierKeyOf=()=>undefined;']]) {
        const moduleDir = path.join(directory, name); fs.mkdirSync(path.join(moduleDir, 'lib'), { recursive: true }); fs.writeFileSync(path.join(moduleDir, 'package.json'), '{"type":"module"}'); fs.writeFileSync(path.join(moduleDir, 'lib/index.js'), source);
      }
      Module._load = function (name, parent, ...args) {
        if (parent?.filename.replaceAll('\\', '/').endsWith('/apps/neko-workbench/bridge.cjs')) {
          if (name === './runtime-config.cjs') return { resolveRuntimePaths: () => ({ modulesDir: directory, dataDir: path.join(directory, 'data'), workspaceDir }) };
          if (name === 'node:readline') return { createInterface: () => lines };
        }
        return originalLoad.call(this, name, parent, ...args);
      };
      process.stdout.write = value => { for (const line of String(value).trim().split('\n')) if (line) frames.push(JSON.parse(line)); return true; };
      require('../../apps/neko-workbench/bridge.cjs').apply(ctx);
      const initialized = await invoke('init', { rootId: 'gone-root', resume: true, parentIds: [], taskIds: [] });
      process.stdout.write = originalWrite;
      assert.deepEqual(resumed, ['gone-root']);
      if (scenario === 'missing') {
        assert.equal(initialized.error, undefined);
        assert.equal(created.length, 1);
        assert.notEqual(initialized.result.sessionId, 'gone-root');
        assert.equal(initialized.result.sessionId, created[0].sessionId);
        assert.equal(created[0].cwd, workspaceDir, 'the fresh root opens in the current workspace');
        assert.equal(initialized.result.uiUrl, 'http://127.0.0.1:59099/fixture');
        console.log('missing root fixture passed');
      } else {
        assert.equal(created.length, 0, 'an unrelated failure must not silently replace the saved root');
        assert.match(String(initialized.error), /provider credentials rejected/);
        console.log('broken root fixture passed');
      }
    } finally { process.stdout.write = originalWrite; Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); }
  })().catch(error => { process.stdout.write = process.stdout.constructor.prototype.write; console.error(error); process.exitCode = 1; });
}
