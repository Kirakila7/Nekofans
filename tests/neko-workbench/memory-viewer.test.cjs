'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createMemoryViewer}=require('../../apps/neko-workbench/memory-viewer.cjs');
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'neko-memory-viewer-')),calls=[];
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const roles={roles:[{id:'bigfish',name:'大肥鱼',avatarId:'bigfish'},{id:'yui',name:'Yui',avatarId:'yui'},{id:'claude',name:'Claude小姐',avatarId:'claude'}]};
  const runtime={dataDir:directory,closed:false,memories:async()=>({items:[],summaries:[],replication:{records:[{itemId:'main-private'}]},memoryModel:{useChatApi:true}}),history:async()=>[{text:'主角色私聊'}],memoryAction:async command=>{calls.push(command);return {ok:true};}};
  return {directory,roles,runtime,calls,viewer:createMemoryViewer({getRuntime:()=>runtime,getRoles:()=>roles})};
}
test('character viewer routes native Bigfish data and actions without changing chat selection',async t=>{
  const f=fixture(t),result=await f.viewer.read();assert.equal(result.character.id,'bigfish');assert.equal(result.readOnly,false);assert.equal(result.characters.length,3);assert.equal(result.replication.records[0].itemId,'main-private');
  assert.deepEqual(await f.viewer.history(),[{text:'主角色私聊'}]);await f.viewer.action({personaId:'bigfish',action:'event-priority',id:'x',priority:80,pinned:true});assert.deepEqual(f.calls,[{action:'event-priority',id:'x',priority:80,pinned:true}]);
});
test('other personas read only their own existing facts, summaries and latest conversation',async t=>{
  const f=fixture(t),db=new DatabaseSync(path.join(f.directory,'memories.sqlite'));
  db.exec('CREATE TABLE memories(seq INTEGER PRIMARY KEY,id TEXT,persona_id TEXT,kind TEXT,text TEXT,confirmation TEXT,source_message_ids TEXT,created_at INTEGER,updated_at INTEGER);CREATE TABLE conversation_summaries(seq INTEGER PRIMARY KEY,id TEXT,persona_id TEXT,text TEXT,source_ids TEXT,updated_at INTEGER)');
  const insert=db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?)');
  for(const [n,id,text] of [[1,'bigfish','不可泄漏的主角色记忆'],[2,'claude','Claude独立记忆'],[3,'yui','Yui独立记忆']])insert.run(n,'same-id',id,'fact',text,'confirmed','["source"]',1000,2000);
  db.prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?)').run(1,'same-id','claude','Claude独立摘要','["claude-source"]',3000);db.close();
  const chat=new DatabaseSync(path.join(f.directory,'conversations.sqlite'));chat.exec('CREATE TABLE messages(seq INTEGER PRIMARY KEY,id TEXT,persona_id TEXT,conversation_id TEXT,role TEXT,text TEXT,created_at INTEGER)');
  const message=chat.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)');message.run(1,'a','bigfish','same-conversation','user','不可泄漏的主角色聊天',1000);message.run(2,'b','claude','old','user','旧会话',1000);message.run(3,'c','claude','same-conversation','user','Claude独立聊天',2000);message.run(4,'d','yui','same-conversation','user','Yui独立聊天',2000);chat.close();
  const result=await f.viewer.read('claude');assert.equal(result.readOnly,true);assert.deepEqual(result.replication.records.map(r=>r.value.text),['Claude独立记忆','Claude独立摘要']);assert.equal(new Set(result.replication.records.map(r=>r.itemId)).size,2);assert(result.replication.records.every(r=>r.heads[0].personaId==='claude'));
  assert.deepEqual((await f.viewer.history('claude')).map(m=>m.text),['Claude独立聊天']);assert(!JSON.stringify(result).includes('不可泄漏'));assert.deepEqual((await f.viewer.read('yui')).replication.records.map(r=>r.value.text),['Yui独立记忆']);
});
test('unknown characters and cross-persona writes fail closed; missing archives stay empty',async t=>{
  const f=fixture(t);assert.equal((await f.viewer.read('yui')).replication.records.length,0);assert.deepEqual(await f.viewer.history('yui'),[]);assert.deepEqual(fs.readdirSync(f.directory),[]);
  await assert.rejects(f.viewer.read('../bigfish'));await assert.rejects(f.viewer.history('unknown'));assert.throws(()=>f.viewer.action({personaId:'claude',action:'event-delete',id:'main-private'}));assert.equal(f.calls.length,0);
  f.runtime.closed=true;await assert.rejects(f.viewer.read('claude'));
});
