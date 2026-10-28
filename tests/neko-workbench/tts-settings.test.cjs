'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
let JSDOM;try{({JSDOM}=require('jsdom'));}catch{}
const {mountSettings}=require('../../apps/neko-workbench/main-chat-ui.js');
test('voice opt-in and stop operate independently of chat API settings',{skip:!JSDOM&&'jsdom unavailable'},async()=>{
  const dom=new JSDOM('<div id="host"></div>');const host=dom.window.document.getElementById('host');
  const calls=[];let notify;
  const pet={onState:fn=>{notify=fn;return ()=>{};},call:async(method,input)=>{calls.push([method,input]);if(method==='state')return {preferences:{ttsEnabled:false}};if(method==='chat-settings-read')return {settings:{},hasKey:false,secureStorageAvailable:true};return {enabled:input?.enabled};}};
  const dispose=mountSettings(host,pet);await new Promise(resolve=>setImmediate(resolve));
  const toggle=host.querySelector('.tts-enabled');assert.equal(toggle.checked,false);assert.equal(toggle.disabled,false);
  toggle.checked=true;toggle.dispatchEvent(new dom.window.Event('change'));await new Promise(resolve=>setImmediate(resolve));
  assert.ok(calls.some(([method,input])=>method==='tts-settings'&&input.enabled===true));
  host.querySelector('.tts-stop').click();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(calls.some(([method])=>method==='tts-stop'));
  assert.equal(calls.some(([method])=>method==='chat-settings-save'),false);
  notify({preferences:{ttsEnabled:true},mainChat:{settings:{},hasKey:false,secureStorageAvailable:true}});assert.equal(toggle.checked,true);dispose();
});
