'use strict';
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const {DENIAL}=require(path.resolve(__dirname,'../../../apps/neko-workbench/vendor/dsh-qqbot-workbench/agent-guard.cjs'));
exports.name='neko-qq-session-guard-probe';exports.inject=['agents','agentPresets','tools'];
exports.apply=function(ctx){
 setTimeout(async()=>{let manager,normal;try{
  const {SessionManager}=await import(pathToFileURL(path.join(process.env.NEKO_QQ_TEST_PKG,'dist/session/session-manager.js')).href);
  const log={info(){},warn(){},error(){},debug(){}};
  manager=new SessionManager(ctx,ctx.agents,{appId:'fixture-id',cwd:process.cwd(),sessionIdleTimeout:600000,historyLimit:0},log);
  const peer='fixture-peer',scope='c2c',reply={scope:'c2c',targetId:peer}, key=manager.sessionKey(scope,peer);
  let qCount=0,nCount=0;
  const def=(fn)=>({name:'neko_qq_guard_probe',description:'controlled test',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render(_args,value){return [{type:'text',text:value}]}},async execute(){fn();return 'fixture-success'}});
  const run=async(agent,id)=>{
    const fiber=agent.ctx.inject(['tools'],c=>{c.tools.register(def(()=>qCount++))});await fiber;
    const result=await ctx.tools.execute({name:'neko_qq_guard_probe',agent,callId:id,arguments:{},signal:new AbortController().signal});
    const why=ctx.tools.guardReason({agent});await fiber.dispose();
    if(result.isError!==true||why!==DENIAL||qCount!==0)throw Error('guard failed '+id);
  };
  let record=await manager.getOrCreate(scope,peer,peer,reply);await run(record.agent,'created');
  const select=await manager.setPresetOverride(scope,peer,'minimal');if(!select.ok)throw Error('preset failed');
  await manager.remove(scope,peer);record=await manager.getOrCreate(scope,peer,peer,reply);if(record.agentPreset!=='minimal')throw Error('preset did not switch');await run(record.agent,'after-preset-new');
  let modelBlocked=false,rebuildBlocked=false;try{await manager.setModelOverride(scope,peer,{provider:'fixture',model:'fixture'});}catch{modelBlocked=true;}try{await manager.rebuildSession(record,{});}catch{rebuildBlocked=true;}if(!modelBlocked||!rebuildBlocked)throw Error('model command not blocked');

  const oldId=record.sessionId;await record.handle.dispose();manager.sessions.delete(key);
  record=await manager.getOrCreate(scope,peer,peer,reply);await run(record.agent,'resumed');
  normal=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:process.cwd()},setup:async c=>{await ctx.agentPresets.mount(c,'standard');}});
  const normalNames=[...ctx.tools.view(normal.agent).visible.keys()];
  const realTools=normalNames.filter(name=>/^(bash|read|write|edit|terminal_send|read_file|write_file)$/.test(name));
  if(!realTools.length)throw Error('no file or terminal tool available for the negative test');
  for(const name of realTools){
    const result=await ctx.tools.execute({name,agent:record.agent,callId:'real-'+name,arguments:{},signal:new AbortController().signal});
    if(result.isError!==true||ctx.tools.guardReason({agent:record.agent})!==DENIAL)throw Error('real tool not denied '+name);
  }
  const nf=normal.agent.ctx.inject(['tools'],c=>{c.tools.register(def(()=>nCount++))});await nf;
  const nr=await ctx.tools.execute({name:'neko_qq_guard_probe',agent:normal.agent,callId:'normal',arguments:{},signal:new AbortController().signal});
  if(nr.isError||nCount!==1||ctx.tools.guardReason({agent:normal.agent})!==undefined)throw Error('normal agent affected');
  console.log('NEKO_QQ_GUARD_PROBE='+JSON.stringify({created:'denied',preset:'denied',rebuild:'blocked',resume:'denied',sameSession:oldId===record.sessionId,realTools,normal:nCount,qCount}));
 }catch(e){console.log('NEKO_QQ_GUARD_PROBE_ERROR='+String(e?.stack||e).replaceAll('\n',' | '));}finally{await manager?.disposeAll?.();await normal?.dispose?.();}},1000);
};
