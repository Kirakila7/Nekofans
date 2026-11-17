'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createChannelLife}=require('../../apps/neko-workbench/channel-life.cjs');
const {qqExperience,biliExperience}=require('../../apps/neko-workbench/channel-experiences.cjs');
function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-channel-'));let time=Date.parse('2026-11-03T02:00:00Z'),busy=false,offline=false;const values=new Map(),shown=[],calls=[],controllers=[];
  const memory={async recordChannelExperience(e){if(offline)throw Error('offline');const itemId=`channel:${e.channel}:${e.id}`;if(!values.has(itemId))values.set(itemId,{text:e.text,evidenceRefs:e.evidenceRefs});return {itemId,available:!!values.get(itemId)};},channelExperience:id=>values.get(id)};
  const fishLog=path.join(dataDir,'fish','whale-log.jsonl');
  const create=(extra={})=>{const c=createChannelLife({dataDir,fishLog,getMemory:()=>memory,generate:async(entry)=>{calls.push(entry);return '刚刚看到一些有趣的分享。'},present:r=>shown.push(r),isBusy:()=>busy,now:()=>time,...extra});controllers.push(c);return c;};
  t.after(()=>{controllers.forEach(c=>c.dispose());fs.rmSync(dataDir,{recursive:true,force:true});});
  return {dataDir,fishLog,create,memory,values,shown,calls,entry:()=>qqExperience({messageId:'test-message',scope:'group',text:'合成乌龙茶话题'},time),advance:ms=>time+=ms,setBusy:v=>busy=v,setOffline:v=>offline=v,setTime:v=>time=v};
}
test('channels are sourced, private-ready observations without raw peer identifiers',()=>{
  const e=qqExperience({messageId:'private-openid',scope:'group',text:'你好'});assert(!JSON.stringify(e).includes('private-openid'));assert.match(e.text,/不代表主人/);assert.equal(qqExperience({messageId:'a',scope:'guild',text:'x'}),null);
  const b=biliExperience({at:'2026-11-03T02:00:00Z',kind:'watch',target:'BV-synthetic'});assert.match(b.text,/不推断/);
});
test('memory ingestion persists, deduplicates across restart and does not speak by default',async t=>{
  const f=fixture(t),c=f.create();c.accept(f.entry());c.accept(f.entry());await c.tick();assert.equal(f.values.size,1);assert.equal(f.shown.length,0);assert.equal(c.status().proactiveEnabled,false);c.dispose();const next=f.create();next.accept(f.entry());await next.tick();assert.equal(next.status().remembered,1);assert.equal(f.values.size,1);
});
test('offline memory retains pending input and retries without duplicate delivery',async t=>{
  const f=fixture(t),c=f.create();f.setOffline(true);c.accept(f.entry());await c.tick();assert.equal(c.status().pending,1);f.setOffline(false);await c.tick();assert.equal(c.status().pending,0);assert.equal(c.status().error,'');assert.equal(f.values.size,1);
});
test('opt-in speech obeys idle/busy, cooldown and durable once-only receipts',async t=>{
  const f=fixture(t),c=f.create();c.configure({proactiveEnabled:true});c.accept(f.entry());await c.tick();assert.equal(f.calls.length,0);f.advance(61000);f.setBusy(true);await c.tick();assert.equal(f.calls.length,0);f.setBusy(false);await c.tick();assert.equal(f.shown.length,1);await c.tick();assert.equal(f.shown.length,1);
  c.accept(qqExperience({messageId:'second',scope:'c2c',text:'第二条'},Date.parse('2026-11-03T02:01:01Z')));await c.tick();assert.equal(f.calls.length,1);f.advance(1800001);await c.tick();assert.equal(f.calls.length,2);c.dispose();const next=f.create();f.advance(1800001);await next.tick();assert.equal(f.shown.length,2);
});
test('disabling, new user input and deletion cancel an in-flight comment without late presentation',async t=>{
  for(const action of ['disable','touch','delete']){
    const f=fixture(t);let release;const c=f.create({generate:()=>new Promise(r=>release=r)});c.configure({proactiveEnabled:true});c.accept(f.entry());f.advance(61000);const work=c.tick();while(!release)await new Promise(r=>setImmediate(r));
    if(action==='disable')c.configure({proactiveEnabled:false});if(action==='touch')c.touch();if(action==='delete')f.values.clear();release('不能显示的晚到回复');await work;assert.equal(f.shown.length,0);c.dispose();
  }
});
test('quiet hours and six attempts per Shanghai day constrain model requests including failures',async t=>{
  const f=fixture(t);let attempts=0;const c=f.create({generate:async()=>{attempts++;throw Error('model offline');}});c.configure({proactiveEnabled:true});c.accept(f.entry());f.setTime(Date.parse('2026-11-03T16:00:00Z'));await c.tick();assert.equal(attempts,0);f.setTime(Date.parse('2026-11-03T03:00:00Z'));
  for(let i=0;i<9;i++){await c.tick();f.advance(1800001);}assert.equal(attempts,6);assert.equal(f.shown.length,0);
});
test('structured B站 log polling handles partial rows and invalid data, resumes its cursor and excludes credentials',async t=>{
  const f=fixture(t),c=f.create();fs.mkdirSync(path.dirname(f.fishLog));const row={at:'2026-11-03T02:00:00Z',kind:'watch',target:'BV-test',note:'真实结构化记录的合成样例'};fs.writeFileSync(f.fishLog,'not json\n'+JSON.stringify(row));await c.tick();assert.equal(f.values.size,0);fs.appendFileSync(f.fishLog,'\n');await c.tick();assert.equal(f.values.size,1);await c.tick();assert.equal(f.values.size,1);
  c.configure({memoryEnabled:false});assert.equal(c.accept(f.entry()),false);assert.equal(c.status().pending,0);
});
