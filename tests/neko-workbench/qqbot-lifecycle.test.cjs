'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { Readable, PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const base = path.join(__dirname, '../../apps/neko-workbench/vendor/dsh-qqbot-workbench');
const installer = require(path.join(base, 'install.cjs'));
const { RUNTIME } = require(path.join(base, 'runtime-state.cjs'));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, savedConfig = {}, { sessions = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-qq 中文 空格 #-'));
  const root = path.join(tmp, 'qqbot-runtime');
  fs.mkdirSync(path.join(root, 'node_modules/js-yaml'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/js-yaml/index.js'), 'module.exports={load:JSON.parse}');
  const save = value => fs.writeFileSync(path.join(root, 'cordis.patch.yml'), JSON.stringify([{ id: 'im-qqbot', config: value }]));
  save(savedConfig);
  fs.copyFileSync(installer.ARCHIVE, path.join(tmp, 'qqbot.tgz'));
  cp.execFileSync('tar', ['-xzf', 'qqbot.tgz'], { cwd: tmp });
  const pkg = path.join(tmp, 'package');
  installer.adaptPlugin(tmp, pkg);
  const fake = {
    bots: [], pendingCredentials: [], saved: [], inbound: 0, routes: 0, starts: 0, stops: 0,
    records: [], rejectStart: false,
    accountStatus: 'credential-stored', accountReaders: [],
    sends: [], streamUpdates: [], streamCompletes: 0, followed: 0, cancelled: 0, disposed: 0, selections: [],
  };
  const key = `neko-qq-test:${tmp}`;
  globalThis[key] = fake;
  fake.persist = next => {
    const entries=JSON.parse(fs.readFileSync(path.join(root,'cordis.patch.yml'),'utf8'));
    entries[0].config={...entries[0].config,...next};
    fs.writeFileSync(path.join(root,'cordis.patch.yml'),JSON.stringify(entries));
    return true;
  };
  fs.writeFileSync(path.join(pkg,'dist/setup/persist.js'),`export const updateProfileConfig = value => globalThis[${JSON.stringify(key)}].persist(value);\n`);
  fs.writeFileSync(path.join(tmp, 'dependencies.mjs'), `
const fixture = globalThis[${JSON.stringify(key)}];
export const ConfigSchema = {};
export const getProfileDir = () => '';
export const resolveEnv = () => '';
export const ensureCredentials = () => new Promise(resolve => fixture.pendingCredentials.push(resolve));
export const persistCredentialsToProfile = value => { fixture.saved.push(value); return true; };
export const registerBoundCredentialRoutes = () => { fixture.routes++; };
export class QQBot {
  constructor(options) { this.handlers = {}; fixture.botOptions = options; fixture.bots.push(this); }
  on(name, fn) { this.handlers[name] = fn; }
  start() { fixture.starts++; return fixture.rejectStart ? Promise.reject(Error('private remote error')) : Promise.resolve(); }
  stop() { fixture.stops++; }
  sendMarkdown(target, content) { fixture.sends.push(content); return fixture.sendGate || Promise.resolve(); }
  openStream() { return { update(value) { fixture.streamUpdates.push(value); return Promise.resolve(); }, complete() { fixture.streamCompletes++; return Promise.resolve(); } }; }
}
export class SessionManager { async disposeAll() {} }
export const handleInbound = () => { fixture.inbound++; };
export const createOutboundHandler = () => ({ routeSessionEvent() {}, routeStreamFrame() {} });
export const parseStreamFrame = () => undefined;
export class ReplyLimiter {}
export const cacheMsgId = () => {};
export const cacheEventId = () => {};
export const resolveReplyTarget = value => value;
export const sendResolvedMarkdown = (bot, target, content, opts) => bot.sendMarkdown(target, content, opts);
export class QuestionChannel { install() {} }
export class ApprovalChannel { install() {} }
export const decodeButtonData = () => undefined;
export const buildUserAgent = () => 'fixture';
export const setupMiddlewares = () => {};
export const startMediaCleanup = () => {};
export const ensureVisionInputModal = () => {};
export const registerDescribeImageTool = () => {};
export const registerSendFileTool = () => { throw Error('file tools must stay disabled'); };
export class DeliverablesDeliverer {}
export const SessionId = value => value;
export const createUserMessage = value => value;
export const classifyContentType = () => 'text';
export const isVoiceContentType = () => false;
export const clearGroupHistory = () => {};
export class ModelResolver {
  getEffectiveRoute() { return { provider: 'deepseek-account', model: 'deepseek-flash' }; }
  getResumeRoute() { return this.getEffectiveRoute(); }
  getSessionId() { return undefined; }
  getPreset() { return undefined; }
}
export class IdleEvictor { dispose() {} }
export const chunkMarkdownText = value => value.split('|');
export class OutboundBuffer {}
export const formatToolResult = () => '';
export const parseEvent = value => value;
export const extractTurnError = () => undefined;
`);
  // Run the actual adapted modules. Only their external services are replaced:
  // no QQ requests, credentials, messages, or model calls leave the test.
  const remap = source => source.replace(/((?:import|export\s+\{)\s+[^;]+?\s+from\s+)["']([^"']+)["']/g,
    (all, head, spec) => spec.startsWith('node:') ? all : head + JSON.stringify('./dependencies.mjs'));
  let gateway = remap(fs.readFileSync(path.join(pkg, 'dist/gateway/bootstrap.js'), 'utf8'));
  if (sessions) {
    for (const [name, source] of [['manager', 'session/session-manager'], ['inbound', 'transport/inbound'], ['outbound', 'transport/outbound']]) {
      let code = fs.readFileSync(path.join(pkg, `dist/${source}.js`), 'utf8');
      code = code.replace(/const \{ pathToFileURL: __qqPathToFileURL \}[^;]+;\nconst \{ join: __qqJoin \}[^;]+;\nconst \{ (SessionId|createUserMessage) \}[^;]+;/g, 'import { $1 } from "./dependencies.mjs";');
      fs.writeFileSync(path.join(tmp, `${name}.mjs`), remap(code));
    }
    gateway = gateway.replace('import { SessionManager } from "./dependencies.mjs"', 'import { SessionManager } from "./manager.mjs"');
    gateway = gateway.replace('import { handleInbound, createOutboundHandler } from "./dependencies.mjs"', 'import { handleInbound } from "./inbound.mjs"; import { createOutboundHandler } from "./outbound.mjs"');
  }
  fs.writeFileSync(path.join(tmp, 'gateway.mjs'), gateway);
  let main = remap(fs.readFileSync(path.join(pkg, 'dist/index.js'), 'utf8'));
  main = main.replace('import { bootstrapGateway } from "./dependencies.mjs"', 'import { bootstrapGateway } from "./gateway.mjs"');
  fs.writeFileSync(path.join(tmp, 'plugin.mjs'), main);
  const plugin = await import(pathToFileURL(path.join(tmp, 'plugin.mjs')).href);
  // The real loader imports spec.name verbatim. Keep that boundary real while
  // redirecting only the plugin's external services to the offline fixture.
  fs.writeFileSync(path.join(pkg, 'dist/index.js'),
    `export * from ${JSON.stringify(pathToFileURL(path.join(tmp, 'plugin.mjs')).href)};\n`);
  const originalInstall = installer.install;
  installer.install = async () => { if (fake.installGate) await fake.installGate; return { pkg }; };
  const target = path.join(base, 'index.cjs');
  delete require.cache[require.resolve(target)];
  const wrapper = require(target);
  const envKeys = ['NEKO_WORKBENCH_DATA_DIR', 'NEKO_WORKBENCH_DSH_MODULES', 'NEKO_WORKBENCH_QQBOT_PROFILE'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.NEKO_WORKBENCH_DATA_DIR = tmp;
  process.env.NEKO_WORKBENCH_DSH_MODULES = tmp;
  let wrapperDispose, currentFiber, createCount = 0;
  const events = [];
  const listener = state => events.push(state);
  process.on('neko-qqbot-state', listener);
  async function createFiber(value) {
    const disposers = [];
    const ctx = {
      agents: {
        get() { return undefined; },
        async resume(options) {
          fake.sessionId = options.resumeSessionId;
          if (fake.resumeGate) await fake.resumeGate;
          const agent = { model: { select(route) { fake.selections.push(route); fake.route = route; } },
            cancel() { fake.cancelled++; }, followup() { fake.followed++; }, whenIdle: async () => {} };
          fake.agent = agent;
          return { agent, async dispose() { fake.disposed++; } };
        },
        async create() { throw Error('resume should succeed'); },
      }, logger: { info() {}, warn() {}, error() {}, debug() {} }, get() { return undefined; },
      on(name, fn) { if (name === 'dispose') disposers.push(fn); else if (name === 'session/event') fake.sessionEvent = fn; return this; },
      effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') disposers.push(cleanup); },
    };
    await plugin.apply(ctx, value);
    let disposed = false;
    currentFiber = { state: 2, async dispose() { if (disposed) return; disposed = true; if (fake.disposeGate) await fake.disposeGate; for (const cleanup of disposers) await cleanup(); } };
  }
  const webRoutes = new Map();
  const context = {
    logger: { buffer: [] },
    loader: {
      async create(spec) {
        createCount++;
        const loaded = await import(spec.name);
        assert.equal(loaded.apply, plugin.apply);
        await createFiber(spec.config);
        return 'fixture-entry';
      },
      resolve() { return { fiber: currentFiber }; }, await: async () => {},
      async update(_id, spec) { await currentFiber.dispose(); await createFiber(spec.config); }, remove() {},
    },
    get(name) { return name === 'deepseekAccount' ? accountService : { requestRejection() { return fake.rejectRequests ? true : undefined; } }; },
    on(name, fn) { if (name === 'dispose') wrapperDispose = fn; },
    inject(names, fn) { fn(names.includes('deepseekAccount') ? { deepseekAccount: accountService, effect() {} } : { webServer: { register(route) { webRoutes.set(route.path, route.handler); return () => webRoutes.delete(route.path); } }, effect() {} }); },
  };
  const accountService = {
    getState: async () => ({ status: fake.accountStatus }),
    watch(signal) {
      let initial = true;
      signal.addEventListener('abort', () => { for (const resolve of fake.accountReaders.splice(0)) resolve({ done: true }); }, { once: true });
      return {
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (signal.aborted) return Promise.resolve({ done: true });
          if (initial) { initial = false; return Promise.resolve({ done: false, value: { status: fake.accountStatus } }); }
          return new Promise(resolve => fake.accountReaders.push(resolve));
        },
      };
    },
  };
  fake.setAccount = async status => {
    fake.accountStatus = status;
    for (const resolve of fake.accountReaders.splice(0)) resolve({ done: false, value: { status } });
    await tick();
  };
  wrapper.apply(context);
  t.after(async () => {
    await wrapperDispose();
    process.off('neko-qqbot-state', listener);
    installer.install = originalInstall;
    delete require.cache[require.resolve(target)];
    delete globalThis[key]; delete globalThis[RUNTIME];
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { wrapper, fake, events, save, createCount: () => createCount, dispose: wrapperDispose, context, webRoutes };
}

const bound = { appId: 'test-id', appSecret: 'test-secret', access: { c2cMode: 'allowlist', c2cAllow: ['chosen-user'], groupMode: 'disabled', groupAllow: [] }, media: { enabled: false } };

test('QQ diagnostics require active authenticated GET and never expose or change host logs', async t => {
  const f = await fixture(t);
  const handler = f.webRoutes.get('/qqbot-workbench/diagnostics');
  const read = method => {
    const res = { statusCode: 200, writeHead(status, headers) { this.statusCode = status; this.headers = headers; }, end(body = '') { this.body = body; } };
    handler({ method }, res); return res;
  };
  assert.equal(read('GET').statusCode, 403);
  await f.wrapper.qqbotAction('start');
  const previousRuntime = globalThis[RUNTIME]();
  previousRuntime.mark('received');
  previousRuntime.mark('private-identifier');
  f.context.logger.buffer.push({ name: 'im-qqbot', type: 'info', args: ['getOrCreate: secret-peer secret-conversation'] });
  const before = JSON.stringify(f.context.logger.buffer), events = f.events.length;
  const response = read('GET');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(response.body).sessionRequested, 1);
  assert.equal(JSON.parse(response.body).counters.received, 1);
  assert(!response.body.includes('secret-'));
  assert.equal(JSON.stringify(f.context.logger.buffer), before);
  assert.equal(f.events.length, events);
  assert.equal(read('POST').statusCode, 405);
  f.fake.rejectRequests = true;
  assert.equal(read('GET').statusCode, 403);
  f.fake.rejectRequests = false;
  await f.wrapper.qqbotAction('pause');
  await f.wrapper.qqbotAction('start');
  previousRuntime.mark('received');
  assert.equal(JSON.parse(read('GET').body).counters.received, 0, 'old runtime cannot alter a new run');
});

test('private pairing HTTP controls require an authenticated bound bot and expose no captured identity', async t => {
  const f = await fixture(t, bound);
  const handler = f.webRoutes.get('/qqbot-workbench/private-pairing');
  const request = async (method, action) => {
    const req = Readable.from(action ? [JSON.stringify({ action })] : []); req.method = method;
    const res = { statusCode: 200, writeHead(status) { this.statusCode = status; }, end(body='') { this.body=body; } };
    await handler(req,res); return res;
  };
  assert.equal((await request('POST','begin')).statusCode,403);
  await f.wrapper.qqbotAction('start');
  f.fake.bots[0].handlers.ready();
  f.fake.rejectRequests = true;
  assert.equal((await request('POST','begin')).statusCode,403);
  f.fake.rejectRequests = false;
  const begun = JSON.parse((await request('POST','begin')).body);
  assert.match(begun.challenge,/^[a-f0-9]{32}$/);
  await tick(); await tick();
  const oldRuntime = globalThis[RUNTIME]();
  assert.equal(oldRuntime.capture({kind:'c2c',senderId:'chosen-private-user',content:begun.challenge}),true);
  const status = await request('GET');
  assert.equal(JSON.parse(status.body).matched,true);
  assert(!status.body.includes('chosen-private-user'));
  assert(!status.body.includes(begun.challenge));
  await request('POST','cancel');
  assert.equal(JSON.parse((await request('GET')).body).active,false);
  assert.equal((await request('PUT')).statusCode,405);
  await f.wrapper.qqbotAction('pause');
  assert.equal(oldRuntime.capture({kind:'c2c',senderId:'chosen-private-user',content:begun.challenge}),false);
});

test('first pairing starts a receive-only gateway from empty scopes and requires explicit confirmation', async t => {
  const access={c2cMode:'disabled',c2cAllow:[],groupMode:'disabled',groupAllow:[]};
  const f=await fixture(t,{...bound,access});
  const handler=f.webRoutes.get('/qqbot-workbench/private-pairing');
  const request=async(method,action)=>{const req=Readable.from(action?[JSON.stringify({action})]:[]);req.method=method;
    const res={statusCode:200,writeHead(status){this.statusCode=status},end(body=''){this.body=body}};await handler(req,res);return res;};
  const initial=await f.wrapper.qqbotAction('start');
  assert.equal(initial.phase,'scope-required');assert.equal(f.fake.starts,0);
  const started=await request('POST','begin');assert.equal(started.statusCode,200);
  const {challenge}=JSON.parse(started.body);await tick();await tick();
  assert.equal(f.fake.starts,1,'pairing explicitly opens gateway despite empty allowlist');
  const runtime=globalThis[RUNTIME]();assert.equal(runtime.allowPairing(),true);assert.equal(runtime.pairingOnly(),true);
  await f.fake.bots.at(-1).sendMarkdown('target','must not be sent');
  assert.deepEqual(f.fake.sends,[],'receive-only gateway cannot send');
  assert.equal(runtime.capture({kind:'c2c',senderId:'person-123',content:'wrong'}),false);
  assert.equal(runtime.capture({kind:'c2c',senderId:'person-123',content:challenge}),true);
  assert.equal((await request('POST','confirm')).statusCode,409,'cannot confirm while gateway unready');
  f.fake.bots.at(-1).handlers.ready();
  const status=JSON.parse((await request('GET')).body);assert.equal(status.matched,true);assert.equal(status.connected,true);
  assert(!JSON.stringify(status).includes('person-123'));assert(!JSON.stringify(status).includes(challenge));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.NEKO_WORKBENCH_DATA_DIR,'qqbot-runtime/cordis.patch.yml'),'utf8'))[0].config.access,access,'scope stays disabled before confirmation');
  const confirmed=await request('POST','confirm');assert.equal(confirmed.statusCode,200);
  assert(!confirmed.body.includes('person-123'));assert(!confirmed.body.includes(challenge));
  await tick();await tick();
  assert.equal(runtime.allowPairing(),false);assert.equal(f.fake.stops>=1,true,'pairing-only gateway is closed');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.NEKO_WORKBENCH_DATA_DIR,'qqbot-runtime/cordis.patch.yml'),'utf8'))[0].config.access,{c2cMode:'allowlist',c2cAllow:['person-123'],groupMode:'disabled',groupAllow:[]});
});

test('cancelling pairing restores an existing private scope without sending during the pairing window', async t => {
  const f=await fixture(t,bound);await f.wrapper.qqbotAction('start');f.fake.bots[0].handlers.ready();
  const handler=f.webRoutes.get('/qqbot-workbench/private-pairing');
  const request=async(action)=>{const req=Readable.from([JSON.stringify({action})]);req.method='POST';
    const res={statusCode:200,writeHead(status){this.statusCode=status},end(body=''){this.body=body}};await handler(req,res);return res;};
  assert.equal((await request('begin')).statusCode,200);await tick();await tick();
  const pairingBot=f.fake.bots.at(-1);await pairingBot.sendMarkdown('target','must not send');assert.deepEqual(f.fake.sends,[]);
  let release;f.fake.disposeGate=new Promise(resolve=>{release=resolve;});
  assert.equal((await request('cancel')).statusCode,200);await tick();
  await pairingBot.sendMarkdown('target','must not send while old gateway is closing');
  assert.deepEqual(f.fake.sends,[],'old gateway remains blocked until updated scope is installed');
  release();f.fake.disposeGate=null;await tick();await tick();
  const restored=f.fake.bots.at(-1);assert.notEqual(restored,pairingBot);restored.handlers.ready();
  await restored.sendMarkdown('target','allowed after cancellation');assert.deepEqual(f.fake.sends,['allowed after cancellation']);
  const saved=JSON.parse(fs.readFileSync(path.join(process.env.NEKO_WORKBENCH_DATA_DIR,'qqbot-runtime/cordis.patch.yml'),'utf8'))[0].config.access;
  assert.deepEqual(saved,bound.access,'cancel does not alter an existing scope');
});

for(const staleAction of ['begin','cancel'])
test(`a delayed ${staleAction} request cannot cross pause and restart into a new generation`, async t => {
    const f=await fixture(t,bound);await f.wrapper.qqbotAction('start');f.fake.bots.at(-1).handlers.ready();
    const handler=f.webRoutes.get('/qqbot-workbench/private-pairing');
    const late=new PassThrough();late.method='POST';
    const lateRes={statusCode:200,writeHead(status){this.statusCode=status},end(body=''){this.body=body}};
    const inflight=handler(late,lateRes);await tick();
    await f.wrapper.qqbotAction('pause');await f.wrapper.qqbotAction('start');f.fake.bots.at(-1).handlers.ready();
    if(staleAction==='cancel') {
      const fresh=Readable.from([JSON.stringify({action:'begin'})]);fresh.method='POST';
      const freshRes={statusCode:200,writeHead(status){this.statusCode=status},end(body=''){this.body=body}};
      await handler(fresh,freshRes);assert.equal(freshRes.statusCode,200);
    }
    late.end(JSON.stringify({action:staleAction}));await inflight;
    assert.equal(lateRes.statusCode,409);assert.equal(JSON.parse(lateRes.body).code,'PAIRING_CANCELLED');
    const check=Readable.from([]);check.method='GET';const checkRes={writeHead(){},end(body){this.body=body}};
    await handler(check,checkRes);assert.equal(JSON.parse(checkRes.body).active,staleAction==='cancel');
    await f.wrapper.qqbotAction('pause');
});

test('QQ binding, access scope and gateway readiness are independent real lifecycle states', async t => {
  const f = await fixture(t);
  assert.equal((await f.wrapper.qqbotAction('start')).phase, 'login-required');
  assert.equal(f.fake.starts, 0);
  assert.equal(f.fake.pendingCredentials.length, 1);
  const waiting = await f.wrapper.qqbotAction('status');
  assert.equal(waiting.enabled, true); assert.equal(waiting.bound, false); assert.equal(waiting.connected, false);
  await f.wrapper.qqbotAction('start'); assert.equal(f.createCount(), 1);
  f.save({ ...bound, access: { c2cMode: 'disabled', groupMode: 'disabled' } });
  process.emit('neko-qqbot-config-changed'); await tick();
  const scoped = await f.wrapper.qqbotAction('status');
  assert.equal(scoped.phase, 'scope-required'); assert.equal(scoped.bound, true); assert.equal(scoped.connected, false);
  assert.equal(f.fake.routes, 1); assert.equal(f.fake.starts, 0);
  f.save(bound); process.emit('neko-qqbot-config-changed'); await tick();
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'connecting');
  assert.equal(f.fake.starts, 1);
  assert.equal(f.fake.botOptions.intents, (1 << 25) | (1 << 26), 'guild and guild DM intents stay disabled');
  assert.equal(f.fake.botOptions.baseUrl, 'https://api.bot.qq.com');
  assert.equal(f.fake.botOptions.tokenBaseUrl, 'https://bots.qq.com', 'token acquisition uses its separate official origin');
  const bot = f.fake.bots[0];
  bot.handlers.ready();
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'running');
  assert.equal((await f.wrapper.qqbotAction('status')).connected, true);
  bot.handlers.disconnected({ willReconnect: true, code: 1 });
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'connecting');
  assert.equal((await f.wrapper.qqbotAction('status')).connected, false);
  bot.handlers.ready();
  bot.handlers.disconnected({ willReconnect: false, code: 1 });
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'error');
  assert(!JSON.stringify(f.events).includes(bound.appSecret));
  assert(!JSON.stringify(f.events).includes(bound.appId));
});

test('pause during binding rejects late credentials, including after a newer start', async t => {
  const f = await fixture(t);
  await f.wrapper.qqbotAction('start');
  const oldCallback = f.fake.pendingCredentials[0];
  await f.wrapper.qqbotAction('pause');
  await f.wrapper.qqbotAction('start');
  oldCallback(bound); await tick();
  assert.equal(f.fake.saved.length, 0);
  assert.equal(f.fake.starts, 0);
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'login-required');
  await f.wrapper.qqbotAction('pause');
  f.fake.pendingCredentials[1](bound); await tick();
  assert.equal(f.fake.saved.length, 0);
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'paused');
});

test('paused and replaced gateway callbacks cannot restart status or handle inbound messages', async t => {
  const f = await fixture(t, bound);
  await f.wrapper.qqbotAction('start');
  const old = f.fake.bots[0]; old.handlers.ready();
  await f.wrapper.qqbotAction('pause'); assert.equal(f.fake.stops, 1);
  const count = f.events.length;
  old.handlers.ready(); old.handlers.disconnected({ willReconnect: true, code: 1 });
  await old.handlers.message({});
  assert.equal(f.fake.inbound, 0); assert.equal(f.events.length, count);
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'paused');
  await f.wrapper.qqbotAction('start');
  old.handlers.ready();
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'connecting');
  await f.dispose();
  assert.equal(f.fake.stops, 2);
  f.fake.bots[1].handlers.ready();
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'paused');
});

test('gateway start failure reports an error without remote detail or false connection', async t => {
  const f = await fixture(t, bound); f.fake.rejectStart = true;
  await f.wrapper.qqbotAction('start'); await tick();
  const state = await f.wrapper.qqbotAction('status');
  assert.equal(state.phase, 'error'); assert.equal(state.connected, false); assert.equal(state.bound, true);
  assert(!JSON.stringify(f.events).includes('private remote error'));
});

test('QQ waits for the workbench account, resumes once on login, and pauses on logout', async t => {
  const f = await fixture(t, bound);
  await f.fake.setAccount('signed-out');
  assert.equal((await f.wrapper.qqbotAction('start')).phase, 'model-login-required');
  assert.equal(f.fake.starts, 0);
  await f.fake.setAccount('credential-stored');
  assert.equal(f.fake.starts, 1);
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'connecting');
  await f.fake.setAccount('signed-out');
  assert.equal((await f.wrapper.qqbotAction('status')).enabled, false);
  assert.equal(f.fake.stops, 1);
  await f.fake.setAccount('credential-stored');
  assert.equal(f.fake.starts, 1);
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'paused');
});

test('pause cancels account-login continuation and logout cancels slow preparation', async t => {
  const f = await fixture(t, bound);
  await f.fake.setAccount('signed-out');
  await f.wrapper.qqbotAction('start'); await f.wrapper.qqbotAction('pause');
  await f.fake.setAccount('credential-stored');
  assert.equal(f.fake.starts, 0);
  let release;
  f.fake.installGate = new Promise(resolve => { release = resolve; });
  const starting = f.wrapper.qqbotAction('start'); await tick();
  await f.fake.setAccount('signed-out');
  assert.equal((await f.wrapper.qqbotAction('status')).enabled, false);
  await f.fake.setAccount('credential-stored');
  release(); await starting; await tick();
  assert.equal(f.fake.starts, 0);
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'paused');
});

test('a second pause revokes start queued behind asynchronous gateway shutdown', async t => {
  const f = await fixture(t, bound);
  await f.wrapper.qqbotAction('start');
  let release;
  f.fake.disposeGate = new Promise(resolve => { release = resolve; });
  const pausing = f.wrapper.qqbotAction('pause'); await tick();
  const queuedStart = f.wrapper.qqbotAction('start');
  const secondPause = f.wrapper.qqbotAction('pause');
  release(); await Promise.all([pausing, queuedStart, secondPause]);
  assert.equal(f.createCount(), 1);
  assert.equal((await f.wrapper.qqbotAction('status')).phase, 'paused');
  await f.wrapper.qqbotAction('start');
  assert.equal(f.createCount(), 2);
});

test('partial and empty QQ scope settings never enable the other channel by default', async t => {
  const f = await fixture(t, { ...bound, access: { c2cMode: 'allowlist', c2cAllow: ['  '] } });
  assert.equal((await f.wrapper.qqbotAction('start')).phase, 'scope-required');
  assert.equal(f.fake.starts, 0);
});

function message(bot) {
  return { bot, message: { kind: 'c2c', senderId: 'chosen-user', messageId: 'test-message', content: 'local fixture' },
    state: {}, replyTarget: { scope: 'c2c', targetId: 'chosen-user', msgId: 'test-message' } };
}

test('pause disposes a late resumed QQ session without followup or fallback delivery', async t => {
  const f = await fixture(t, bound, { sessions: true });
  let release;
  f.fake.resumeGate = new Promise(resolve => { release = resolve; });
  await f.wrapper.qqbotAction('start');
  const bot = f.fake.bots[0];
  const inbound = bot.handlers.message(message(bot)); await tick();
  assert(f.fake.sessionId, 'resume must be pending before pause');
  await f.wrapper.qqbotAction('pause'); release(); await inbound;
  assert.equal(f.fake.followed, 0);
  assert.equal(f.fake.cancelled, 1);
  assert.equal(f.fake.disposed, 1);
  assert.equal(f.fake.sends.length, 0);
});

test('each inbound message reasserts the account route on an existing QQ session', async t => {
  const f = await fixture(t, bound, { sessions: true });
  await f.wrapper.qqbotAction('start');
  const bot = f.fake.bots[0];
  await bot.handlers.message(message(bot));
  f.fake.agent.model.select({ provider: 'another-api-key', model: 'other' });
  await bot.handlers.message(message(bot));
  assert.equal(f.fake.followed, 2);
  assert.equal(f.fake.selections.at(-1).provider, 'deepseek-account');
  assert.equal(f.fake.selections.at(-1).model, 'deepseek-flash');
});

test('accepted QQ text emits a sourced memory observation and stale callbacks stop after pause',async t=>{
  const f=await fixture(t,bound,{sessions:true}),entries=[];const listener=e=>entries.push(e);process.on('neko-channel-experience',listener);t.after(()=>process.off('neko-channel-experience',listener));
  await f.wrapper.qqbotAction('start');const bot=f.fake.bots[0];await bot.handlers.message(message(bot));
  assert.equal(entries.length,1);assert.equal(entries[0].channel,'qq');assert.match(entries[0].text,/local fixture/);assert(!JSON.stringify(entries[0]).includes('chosen-user'));assert.match(entries[0].evidenceRefs[0],/^qq-message:[a-f0-9]{64}$/);
  await f.wrapper.qqbotAction('pause');await bot.handlers.message(message(bot));assert.equal(entries.length,1);
});

test('pause blocks later outbound chunks and updates on an already opened stream', async t => {
  const f = await fixture(t, bound, { sessions: true });
  await f.wrapper.qqbotAction('start');
  const bot = f.fake.bots[0];
  await bot.handlers.message(message(bot));
  const stream = bot.openStream({}); await stream.update('before pause');
  let release;
  f.fake.sendGate = new Promise(resolve => { release = resolve; });
  f.fake.sessionEvent({ header: { id: f.fake.sessionId } }, { type: 'assistant/message', content: [{ type: 'text', text: 'first|second' }] });
  await tick(); assert.deepEqual(f.fake.sends, ['first']);
  await f.wrapper.qqbotAction('pause'); release(); await tick();
  await stream.update('after pause'); await stream.complete();
  assert.deepEqual(f.fake.sends, ['first']);
  assert.deepEqual(f.fake.streamUpdates, ['before pause']);
  assert.equal(f.fake.streamCompletes, 0);
});

test('QQ buffers complete replies, blocks split protocol markers and still delivers normal text', async t => {
  const f = await fixture(t, bound, { sessions: true });
  await f.wrapper.qqbotAction('start');
  await f.fake.bots[0].handlers.message(message(f.fake.bots[0]));
  const session = { header: { id: f.fake.sessionId } };
  for (const text of ['<｜｜DS', 'ML｜｜ calls>', '<｜｜DSML｜｜ invoke name="bash">']) {
    f.fake.sessionEvent(session, {type:'assistant/chunk',text});
  }
  await tick();
  assert.deepEqual(f.fake.sends, []);
  f.fake.sessionEvent(session, {type:'assistant/message',content:[{type:'text',text:'<｜｜DSML｜｜ calls>private tool payload'}]});
  await tick();
  const { FORMAT_ERROR } = require(path.join(base,'chat-policy.cjs'));
  assert.deepEqual(f.fake.sends, [FORMAT_ERROR]);
  f.fake.sessionEvent(session, {type:'assistant/message',content:[{type:'text',text:'QQ连接成功'}]});
  await tick();
  assert.deepEqual(f.fake.sends, [FORMAT_ERROR,'QQ连接成功']);
  assert.deepEqual(f.fake.streamUpdates, []);
});
