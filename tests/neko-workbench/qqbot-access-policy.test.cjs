'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const base = path.join(__dirname,'../../apps/neko-workbench/vendor/dsh-qqbot-workbench');
const installer = require(path.join(base,'install.cjs'));
const sdkFile = path.join(__dirname,'fixtures/qqbot-sdk-access-policy.mjs');

test('access-policy fixture is the unmodified SDK 1.0.5 implementation pinned by the runtime lock',() => {
  // Upstream @tencent-connect/qqbot-nodejs@1.0.5/dist/middleware/access-policy.js.
  // Copied byte-for-byte from the integrity-locked installed dependency. The
  // adjacent .LICENSE preserves Tencent's MIT notice; no SDK behavior is mocked.
  const lock = JSON.parse(fs.readFileSync(path.join(base,'upstream/runtime-install.lock.json'),'utf8'));
  assert.equal(lock.packages['node_modules/@tencent-connect/qqbot-nodejs'].version,'1.0.5');
  // Git may materialize CRLF on Windows; normalize only line endings.
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sdkFile,'utf8').replace(/\r\n/g,'\n')).digest('hex'),
    '0eceeef8d677d0f8ce95d3a0d172320c59222ee9a5940176232d740a8143d49b');
});

async function middlewareFixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'qq-access 中文 #-'));
  const key = `qq-access:${tmp}`;
  const state = { history:0 };
  globalThis[key] = state;
  t.after(() => { delete globalThis[key]; fs.rmSync(tmp,{recursive:true,force:true}); });
  fs.copyFileSync(installer.ARCHIVE,path.join(tmp,'plugin.tgz'));
  cp.execFileSync('tar',['-xzf','plugin.tgz'],{cwd:tmp});
  const pkg = path.join(tmp,'package');
  installer.adaptPlugin(tmp,pkg);
  const source = fs.readFileSync(path.join(pkg,'dist/gateway/middleware-setup.js'),'utf8');
  fs.writeFileSync(path.join(tmp,'middleware.mjs'),source.replace(/(from\s+)["'][^"']+["']/g,'$1"./dependencies.mjs"'));
  fs.writeFileSync(path.join(tmp,'dependencies.mjs'),`
export { accessPolicy } from ${JSON.stringify(pathToFileURL(sdkFile).href)};
const state = globalThis[${JSON.stringify(key)}];
const pass = () => async (_ctx, next) => { await next(); };
export const errorHandler = pass, messageFilter = pass, mentionGate = pass,
  contentSanitizer = pass, rateLimiter = pass, concurrencyGuard = pass,
  typingIndicator = pass, quoteRef = pass, envelopeFormatter = pass,
  attachmentProcessor = pass, questionAnswer = pass;
export const slashCommand = () => ({ middleware:pass() });
export const buildCommandList = () => [];
export const getHistoryStore = () => ({});
export const historyGroupKey = () => 'fixture';
export const historyBuffer = () => async (_ctx,next) => { state.history++; await next(); };
`);
  const { setupMiddlewares } = await import(pathToFileURL(path.join(tmp,'middleware.mjs')).href);
  return async (access,message,capture = () => false) => {
    const middleware = [];
    const log = { debug() {} };
    setupMiddlewares({use(fn){middleware.push(fn);}}, {access,debug:false}, {__nekoRuntime:{mark(){},capture}},log);
    let delivered = 0, stopped = false;
    state.history = 0;
    const ctx = {message,log,stop(){stopped=true;}};
    const dispatch = async index => {
      if (index === middleware.length) { delivered++; return; }
      await middleware[index](ctx,() => dispatch(index+1));
    };
    await dispatch(0);
    return {delivered,stopped,history:state.history};
  };
}

test('real QQ middleware permits one private sender and blocks other senders, groups, guilds and guild DMs',async t => {
  const run = await middlewareFixture(t);
  const access = {c2cMode:'allowlist',c2cAllow:['chosen-user'],groupMode:'disabled',groupAllow:[]};
  assert.deepEqual(await run(access,{kind:'c2c',senderId:'chosen-user'}),{delivered:1,stopped:false,history:1});
  for (const message of [
    {kind:'c2c',senderId:'other-user'},
    {kind:'group',senderId:'chosen-user',groupOpenid:'chosen-user'},
    {kind:'guild',senderId:'chosen-user',channelId:'chosen-user'},
    {kind:'dm',senderId:'chosen-user'},
    {kind:'future-scope',senderId:'chosen-user'},
  ]) assert.deepEqual(await run(access,message),{delivered:0,stopped:true,history:0},message.kind);
});

test('empty private and group allowlists remain closed when another scope is enabled',async t => {
  const run = await middlewareFixture(t);
  const access = {c2cMode:'allowlist',c2cAllow:[],groupMode:'open',groupAllow:[]};
  assert.deepEqual(await run(access,{kind:'c2c',senderId:'any-user'}),{delivered:0,stopped:true,history:0});
  assert.deepEqual(await run({...access,c2cMode:'open',groupMode:'allowlist'},
    {kind:'group',senderId:'any-user',groupOpenid:'any-group'}),{delivered:0,stopped:true,history:0});
});

test('an armed private pairing challenge is consumed before the real access gate and model handler',async t => {
  const run = await middlewareFixture(t);
  const access = {c2cMode:'allowlist',c2cAllow:['old-user'],groupMode:'disabled',groupAllow:[]};
  const { createPrivatePairing } = require(path.join(base,'private-pairing.cjs'));
  const pairing = createPrivatePairing({readConfig:()=>({appId:'test-bot',access})});
  const { challenge } = pairing.begin();
  assert.deepEqual(await run(access,{kind:'c2c',senderId:'new-private-user',content:challenge},m=>pairing.capture(m)),{delivered:0,stopped:true,history:0});
  assert.equal(pairing.status().matched,true);
  assert.deepEqual(await run(access,{kind:'c2c',senderId:'new-private-user',content:'ordinary message'},m=>pairing.capture(m)),{delivered:0,stopped:true,history:0});
});
