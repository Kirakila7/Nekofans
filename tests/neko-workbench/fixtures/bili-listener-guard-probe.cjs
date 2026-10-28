'use strict';
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs');
exports.name='neko-bili-listener-guard-probe';
exports.inject=['agents','agentPresets','tools'];
exports.apply=function(ctx){
 setTimeout(async()=>{let normal,scope,fiber;try{
  normal=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:process.cwd()},setup:async c=>{await ctx.agentPresets.mount(c,'standard');}});
  const {createListeningScope}=await import(pathToFileURL(path.resolve(__dirname,'../../../apps/neko-workbench/vendor/dsh-bili-whale/lib/read-scope.js')).href);
  let count=0,allow=false;
  const def={name:'neko_listener_probe',description:'local controlled test',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render(_args,value){return [{type:'text',text:value}]}},async execute(){count++;return 'fixture-success'}};
  fiber=normal.agent.ctx.inject(['tools'],c=>{c.tools.register(def)});await fiber;
  const execute=async(name,id,args={})=>{
   if(typeof ctx.tools.checkGuards==='function'){
    const batch=await ctx.tools.execute({agent:normal.agent,calls:[{type:'tool-call',id,name,arguments:JSON.stringify(args)}],signal:new AbortController().signal});
    return batch.results[0].result;
   }
   return ctx.tools.execute({name,agent:normal.agent,callId:id,arguments:args,signal:new AbortController().signal});
  };
  const diary=path.join(process.cwd(),'listener-diary.md'),outside=path.join(process.cwd(),'listener-outside.txt');
  scope=await createListeningScope(normal.agent,{cwd:process.cwd(),files:[diary],isWriteAllowed:()=>allow});
  const denied=await execute('neko_listener_probe','deny');if(!denied.isError||count!==0)throw Error('read-only allowed generic tool');
  const names=[...ctx.tools.view(normal.agent).visible.keys()];
  const shell=names.find(n=>/^(bash|terminal_send)$/.test(n));if(!shell)throw Error('no real shell tool for audit');
  const shellResult=await execute(shell,'shell',{command:'echo must-not-run'});if(!shellResult.isError)throw Error('shell not blocked');
  const diaryWrite=await execute('write','diary',{file_path:diary,content:'local note'});
  const outsideWrite=await execute('write','outside',{file_path:outside,content:'must not be written'});
  if(diaryWrite.isError||!outsideWrite.isError||fs.existsSync(outside))throw Error('file scope failed');
  allow=true;const enabled=await execute('neko_listener_probe','enable');if(enabled.isError||count!==1)throw Error('opt-in blocked');
  allow=false;const revoked=await execute('neko_listener_probe','revoke');if(!revoked.isError||count!==1)throw Error('revocation failed');
  console.log('NEKO_BILI_LISTENER_PROBE='+JSON.stringify({shell,readOnly:'denied',diary:'allowed',outside:'denied',optin:'allowed',revoked:'denied'}));
 }catch(e){console.log('NEKO_BILI_LISTENER_PROBE_ERROR='+String(e?.stack||e).replaceAll('\n',' | '));}
 finally{await scope?.dispose?.();await fiber?.dispose?.();await normal?.dispose?.();}},1000);
};
