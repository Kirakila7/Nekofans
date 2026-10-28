'use strict';
const fs=require('node:fs'),path=require('node:path');
const {install}=require('./install.cjs');
const GUARD=Symbol.for('neko.qqbot.connection.guard');
let context=null,entryId=null,started=false,phase='paused',reason='QQ 机器人未启动。',generation=0,pending=null,profileRoot='',pluginDir='',updateTail=Promise.resolve(),aborter=null;
function snapshot(){return {enabled:started,phase,reason};}
function trusted(req){
  try { const conn=context?.get?.('connection'); if(!conn||typeof conn.requestRejection!=='function')return false;const value=conn.requestRejection(req);return value===undefined||value===null||value===false; }
  catch{return false;}
}
function config(){
  const yaml=require(path.join(profileRoot,'node_modules/js-yaml'));
  const entries=yaml.load(fs.readFileSync(path.join(profileRoot,'cordis.patch.yml'),'utf8'));
  if(!Array.isArray(entries))throw Error('QQ 配置不可读取');
  const saved=entries.find(e=>e&&e.id==='im-qqbot')?.config||{};
  const access=saved.access&&typeof saved.access==='object'?saved.access:{c2cMode:'disabled',c2cAllow:[],groupMode:'disabled',groupAllow:[]};
  return {...saved,appId:typeof saved.appId==='string'?saved.appId:'',appSecret:typeof saved.appSecret==='string'?saved.appSecret:'',cwd:path.join(profileRoot,'workspace'),access,sendFile:{restrictPaths:true,extraRoots:[],sendPresentedFiles:false,maxFiles:0},media:{enabled:false,maxMB:0,ttlHours:24},debug:false};
}
function refresh(){
  const revision=generation;
  updateTail=updateTail.then(async()=>{if(!started||!entryId||revision!==generation)return; await context.loader.update(entryId,{config:config()});await context.loader.await();}).catch(()=>{if(revision===generation&&started){phase='error';reason='QQ 配置保存后重新加载失败，请暂停并重试。';}});
}
async function start(){
  if(started)return snapshot();if(pending)return pending;
  const revision=++generation;phase='starting';reason='正在准备 QQ 机器人插件…';aborter=new AbortController();
  pending=(async()=>{
    try {
      if(!context||!context.loader||typeof context.loader.create!=='function')throw Error('loader unavailable');
      const data=process.env.NEKO_WORKBENCH_DATA_DIR,modules=process.env.NEKO_WORKBENCH_DSH_MODULES;
      if(!data||!path.isAbsolute(data)||!modules||!path.isAbsolute(modules))throw Error('runtime unavailable');
      profileRoot=path.join(data,'qqbot-runtime');
      const installed=await install(profileRoot,modules,{signal:aborter.signal});if(revision!==generation)return snapshot();
      pluginDir=installed.pkg;fs.mkdirSync(path.join(profileRoot,'workspace'),{recursive:true,mode:0o700});
      process.env.NEKO_WORKBENCH_QQBOT_PROFILE=profileRoot;
      globalThis[GUARD]=trusted;
      const id=await context.loader.create({id:'neko-qqbot-active',name:path.join(pluginDir,'dist/index.js'),config:config()});
      entryId=id;await context.loader.await();
      if(revision!==generation){context.loader.remove(id);entryId=null;return snapshot();}
      const entry=context.loader.resolve(id);
      if(!entry||!entry.fiber||entry.fiber.state!==2)throw Error('plugin did not load');
      started=true;phase='running';reason='插件已加载；请在下方绑定 QQ 机器人。绑定状态不代表消息连接已验证。';
      return snapshot();
    } catch {if(entryId&&context?.loader){context.loader.remove(entryId);entryId=null;}if(revision===generation){started=false;phase='error';reason='QQ 插件准备或加载失败，请检查 npm、网络和 DSH 运行环境后重试。';}return snapshot();}
    finally {pending=null;aborter=null;}
  })();return pending;
}
async function pause(){
  const inflight=pending;++generation;aborter?.abort();started=false;phase='paused';reason='QQ 机器人已暂停。';
  if(inflight)await inflight;
  await updateTail;
  if(entryId&&context?.loader){const entry=context.loader.resolve(entryId);context.loader.remove(entryId);entryId=null;try{await entry?.fiber?.dispose?.();}catch{phase='error';reason='QQ 机器人停止状态未能确认。';}}
  return snapshot();
}
async function qqbotAction(action){if(action==='status')return snapshot();if(action==='start')return start();if(action==='pause')return pause();throw Error('未知 QQ 机器人操作');}
exports.name='neko-qqbot-workbench';
exports.inject=['loader','connection'];
exports.apply=function apply(ctx){
  context=ctx;process.on('neko-qqbot-config-changed',refresh);
  ctx.inject(['webServer'],scoped=>{
    const dispose=scoped.webServer.register({kind:'exact',path:'/qqbot-workbench/client.js',handler(req,res){
      if(!trusted(req)){res.statusCode=403;res.end();return;}
      if(req.method!=='GET'||!started||!pluginDir){res.statusCode=404;res.end();return;}
      try{const content=fs.readFileSync(path.join(pluginDir,'lib/client.js'));res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(content);}catch{res.statusCode=503;res.end();}
    }});
    scoped.effect(()=>dispose,'neko.qqbot.client');
  });
  ctx.on('dispose',()=>{process.removeListener('neko-qqbot-config-changed',refresh);delete globalThis[GUARD];void pause();context=null;});
};
exports.qqbotAction=qqbotAction;
