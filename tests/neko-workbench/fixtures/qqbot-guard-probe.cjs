'use strict';
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs');
const {DENIAL}=require(path.resolve(__dirname,'../../../apps/neko-workbench/vendor/dsh-qqbot-workbench/agent-guard.cjs'));
const {CHAT_PROMPT}=require(path.resolve(__dirname,'../../../apps/neko-workbench/vendor/dsh-qqbot-workbench/chat-policy.cjs'));
exports.name='neko-qq-session-guard-probe';exports.inject=['agents','agentPresets','tools','systemPrompt'];
exports.apply=function(ctx){
 setTimeout(async()=>{let manager,normal;try{
  globalThis[Symbol.for('neko.qqbot.runtime')]=()=>({active:()=>true,report(){}});
  const {SessionManager}=await import(pathToFileURL(path.join(process.env.NEKO_QQ_TEST_PKG,'dist/session/session-manager.js')).href);
  const log={info(){},warn(){},error(){},debug(){}};
  manager=new SessionManager(ctx,ctx.agents,{appId:'fixture-id',cwd:process.cwd(),sessionIdleTimeout:600000,historyLimit:0},log);
  const peer='fixture-peer',scope='c2c',reply={scope:'c2c',targetId:peer}, key=manager.sessionKey(scope,peer);
  let qCount=0,nCount=0;
  const execute=async(agent,name,id,args={})=>{
    if(typeof ctx.tools.checkGuards==='function'){
      const batch=await ctx.tools.execute({agent,calls:[{type:'tool-call',id,name,arguments:JSON.stringify(args)}],signal:new AbortController().signal});
      return batch.results[0].result;
    }
    return ctx.tools.execute({name,agent,callId:id,arguments:args,signal:new AbortController().signal});
  };
  const denial=agent=>typeof ctx.tools.checkGuards==='function'?ctx.tools.checkGuards({agent}):ctx.tools.guardReason({agent});
  const def=(fn)=>({name:'neko_qq_guard_probe',description:'controlled test',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render(_args,value){return [{type:'text',text:value}]}},async execute(){fn();return 'fixture-success'}});
  const run=async(agent,id)=>{
    const assembly=await ctx.systemPrompt.assemble({agent,scope:agent});
    if(assembly.tools.length!==0||assembly.sections.length!==1||assembly.sections[0].text!==CHAT_PROMPT)throw Error('chat prompt or tools not isolated '+id);
    const fiber=agent.ctx.inject(['tools'],c=>{c.tools.register(def(()=>qCount++))});await fiber;
    const result=await execute(agent,'neko_qq_guard_probe',id);
    const why=denial(agent);await fiber.dispose();
    if(result.isError!==true||why!==DENIAL||qCount!==0)throw Error('guard failed '+id);
  };
  let record=await manager.getOrCreate(scope,peer,peer,reply);await run(record.agent,'created');
  const select=await manager.setPresetOverride(scope,peer,'minimal');if(!select.ok)throw Error('preset failed');
  await manager.remove(scope,peer);record=await manager.getOrCreate(scope,peer,peer,reply);if(record.agentPreset!==undefined)throw Error('QQ must not mount coding presets');await run(record.agent,'after-preset-new');
  let modelBlocked=false,rebuildBlocked=false;try{await manager.setModelOverride(scope,peer,{provider:'fixture',model:'fixture'});}catch{modelBlocked=true;}try{await manager.rebuildSession(record,{});}catch{rebuildBlocked=true;}if(!modelBlocked||!rebuildBlocked)throw Error('model command not blocked');

  const oldId=record.sessionId;await record.handle.dispose();manager.sessions.delete(key);
  record=await manager.getOrCreate(scope,peer,peer,reply);await run(record.agent,'resumed');
  normal=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:process.cwd()},setup:async c=>{await ctx.agentPresets.mount(c,'standard');}});
  const normalNames=[...ctx.tools.view(normal.agent).visible.keys()];
  const realTools=normalNames.filter(name=>/^(bash|read|write|edit|terminal_send|read_file|write_file)$/.test(name));
  if(!realTools.length)throw Error('no file or terminal tool available for the negative test');
  for(const name of realTools){
    const result=await execute(record.agent,name,'real-'+name);
    if(result.isError!==true||denial(record.agent)!==DENIAL)throw Error('real tool not denied '+name);
  }
  const nf=normal.agent.ctx.inject(['tools'],c=>{c.tools.register(def(()=>nCount++))});await nf;
  const nr=await execute(normal.agent,'neko_qq_guard_probe','normal');
  if(nr.isError||nCount!==1||denial(normal.agent)!==undefined)throw Error('normal agent affected');
  await nf.dispose();
  const {createReadingScope}=await import(pathToFileURL(path.resolve(__dirname,'../../../apps/neko-workbench/vendor/dsh-bili-whale/lib/read-scope.js')).href);
  const material=path.join(process.cwd(),'fixture-material.txt'),diary=path.join(process.cwd(),'fixture-diary.md'),outside=path.join(process.cwd(),'fixture-outside.txt');
  fs.writeFileSync(material,'fixture public material');
  const restricted=await createReadingScope(normal.agent,{cwd:process.cwd(),files:[material,diary],readOnlyFiles:[material]});
  const visible=[...ctx.tools.view(normal.agent).visible.keys()].sort();
  if(JSON.stringify(visible)!==JSON.stringify(['edit','read','write']))throw Error('manual reading exposed other tools');
  const read=await execute(normal.agent,'read','manual-read',{file_path:material});
  const write=await execute(normal.agent,'write','manual-write',{file_path:diary,content:'fixture diary'});
  const blocked=await execute(normal.agent,'write','manual-outside',{file_path:outside,content:'must not be written'});
  const immutable=await execute(normal.agent,'write','manual-material',{file_path:material,content:'must not be written'});
  if(read.isError||write.isError||!blocked.isError||!immutable.isError||fs.existsSync(outside)||fs.readFileSync(material,'utf8')!=='fixture public material')throw Error('manual reading file scope failed');
  await restricted.dispose();
  console.log('NEKO_QQ_GUARD_PROBE='+JSON.stringify({created:'denied',preset:'denied',rebuild:'blocked',resume:'denied',sameSession:oldId===record.sessionId,realTools,normal:nCount,qCount}));
 }catch(e){console.log('NEKO_QQ_GUARD_PROBE_ERROR='+String(e?.stack||e).replaceAll('\n',' | '));}finally{await manager?.disposeAll?.();await normal?.dispose?.();}},1000);
};
