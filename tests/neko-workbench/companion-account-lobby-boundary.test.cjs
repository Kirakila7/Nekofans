'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {providerGetter}=require('../../apps/neko-workbench/lobby-cat.cjs');
const {WorkbenchMainChat}=require('../../apps/neko-workbench/main-chat-runtime.cjs');
test('account mode never silently uses an existing API key in the community lobby',()=>{
  let invoked=false;
  const runtime={backend:'deepseek-account',closed:false,settings:{baseUrl:'https://example.invalid',model:'fixture'},secretStore:{has:()=>true,available:()=>true,get:()=>{throw Error('must not read');}}};
  const get=providerGetter({runtime,createChatApiProvider:()=>{invoked=true;return {};}});
  assert.equal(get(),null);assert.equal(invoked,false);
  const memory=WorkbenchMainChat.prototype.lobbyMemory.call({closed:false,backend:'deepseek-account',memorySystem:{}});
  assert.equal(memory.personaId,'bigfish','account route retains the same public-provenance memory boundary');
});
