'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createQQCompanionLink} = require('../../apps/neko-workbench/vendor/dsh-qqbot-workbench/companion-link.cjs');

function fixture() {
  const config = {appId:'bot', appSecret:'fixture-secret', access:{
    c2cMode:'allowlist', c2cAllow:['owner-openid'], groupMode:'disabled', groupAllow:[]
  }};
  let consent = null, active = true;
  const events = [];
  const open = () => createQQCompanionLink({
    readConfig: () => config, readConsent: () => consent, saveConsent: key => {consent=key;},
    notify: id => events.push(id)
  });
  const owner = {kind:'c2c',senderId:'owner-openid',messageId:'msg-1',content:'接着聊'};
  return {config, events, open, owner, isActive: () => active, stop: () => {active=false;}};
}

test('only opted-in paired QQ text gets one private request; notifications contain no content', async () => {
  const f = fixture();
  let link = f.open();
  assert.equal(link.request(f.owner,f.isActive),null);
  link.configure(true);
  link = f.open();
  assert.equal(link.enabled(),true);
  assert.equal(link.request({...f.owner,kind:'group'},f.isActive),null);
  assert.equal(link.request({...f.owner,senderId:'another-openid'},f.isActive),null);
  const reply = link.request(f.owner,f.isActive);
  assert.equal(f.events.length,1);
  assert.match(f.events[0],/^[a-f0-9-]{36}$/);
  assert.equal(link.take('unrelated'),null);
  assert.deepEqual(link.take(f.events[0]),{text:'接着聊'});
  assert.equal(link.take(f.events[0]),null);
  assert.equal(await link.request(f.owner,f.isActive),null);
  assert.equal(link.reply(f.events[0],'上回我们聊到小窝'),true);
  assert.equal(await reply,'上回我们聊到小窝');
});

test('scope change, pause and disconnect block pending replies and cannot authorize another account',async()=>{
  const f = fixture(), link = f.open();
  link.configure(true);
  const reply = link.request(f.owner,f.isActive);
  link.take(f.events[0]);
  f.config.access.c2cAllow = ['another-openid'];
  assert.equal(link.enabled(),false);
  assert.equal(link.reply(f.events[0],'旧会话的内容'),false);
  assert.equal(await reply,null);
  assert.equal(link.request({...f.owner,senderId:'another-openid'},f.isActive),null);
  f.config.access.c2cAllow = ['owner-openid'];
  const paused = link.request({...f.owner,messageId:'msg-2'},f.isActive);
  f.stop();
  assert.equal(link.take(f.events[1]),null);
  link.cancel();
  assert.equal(await paused,null);
  link.configure(false);
  assert.equal(f.open().enabled(),false);
});
