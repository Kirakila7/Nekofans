import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { capabilities, validateEvents } from './event-store.mjs';

export function memoryLaunch({directory,python,uv='uv',env=process.env}){
  const script=join(directory,'workbench_server.py'),direct=env.NEKO_WORKBENCH_MEMORY_PYTHON_DIRECT;
  if(direct){
    const libs=env.NEKO_WORKBENCH_MEMORY_PYTHON_LIBS;
    if(!isAbsolute(direct)||!existsSync(direct)||!libs||!isAbsolute(libs)||!existsSync(libs))throw Error('内置记忆运行环境不完整，请重新安装工作台');
    // Process .pth files too: pywin32 needs its DLL/bootstrap paths on Windows.
    // Paths are argv, never shell code; credentials still travel only on stdin.
    return {command:direct,args:['-B','-c','import runpy,site,sys; site.addsitedir(sys.argv[1]); script=sys.argv[2]; sys.argv=[script]; runpy.run_path(script,run_name="__main__")',libs,script]};
  }
  const configured=python||env.NEKO_WORKBENCH_MEMORY_PYTHON;
  if(!configured&&!existsSync(join(directory,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')))throw Error('请先运行 npm run setup:neko-memory 安装记忆组件');
  return {command:uv,args:configured?['run','--no-project','--offline','--no-python-downloads','--python',configured,'python','-B',script]:['run','--frozen','--no-sync','python','-B',script]};
}

/** Parent-owned process lifecycle adapted from f750605's NekoNativeProvider.
 * Uses the same EOF ownership protocol, with a private memory-only listener.
 */
export class NekoMemoryWorker {
  constructor({repositoryRoot,dataRoot,getModel,getPersona,python,uv='uv',startupTimeoutMs=90000}){
    Object.assign(this,{repositoryRoot,dataRoot,getModel,getPersona,python,uv,startupTimeoutMs});this.generation=0;this.closed=false;
  }
  async ensure(){
    if(this.closed)throw Error('记忆服务已关闭');
    if(this.starting)return this.starting;
    if(this.url)return;
    const generation=this.generation;
    const starting=this.start(generation);this.starting=starting;
    try{return await starting;}finally{if(this.starting===starting)this.starting=null;}
  }
  async start(generation){
    const model=await this.getModel(),persona=await this.getPersona();
    if(!model?.baseUrl||!model.model||!model.apiKey)throw Error('请先配置记忆整理模型');
    if(this.closed||generation!==this.generation)throw Error('记忆启动已取消');
    const directory=join(this.repositoryRoot,'services/neko-memory');
    const launch=memoryLaunch({directory,python:this.python,uv:this.uv});
    const child=spawn(launch.command,launch.args,{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUNBUFFERED:'1'}});
    this.child=child;const instanceId=randomUUID(),token=randomBytes(32).toString('hex');
    child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
    try{
      const marker=await new Promise((resolve,reject)=>{
        let buffer='',settled=false;
        const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
        const timer=setTimeout(()=>finish(Error('记忆组件启动超时')),this.startupTimeoutMs);
        child.once('error',()=>finish(Error('记忆组件无法启动，请检查 uv 和本机资源')));
        child.once('exit',()=>{if(this.child===child){this.url=null;this.child=null;}finish(Error('记忆组件未能就绪'));});
        child.stdout.on('data',chunk=>{buffer=(buffer+chunk.toString()).slice(-8192);for(const line of buffer.split(/\r?\n/)){if(!line.startsWith('NEKO_MEMORY_READY '))continue;try{const value=JSON.parse(line.slice(18));if(value.instanceId===instanceId&&Number.isInteger(value.port)&&value.port>0&&value.port<65536)finish(null,value);}catch{}}});
        child.stdin.write(JSON.stringify({dataRoot:this.dataRoot,instanceId,token,model,persona:{...persona,id:'bigfish',name:'大肥鱼'},port:0})+'\n');
      });
      if(this.closed||generation!==this.generation||child.exitCode!==null)throw Error('记忆启动已取消');
      this.url='http://127.0.0.1:'+marker.port;this.token=token;this.instanceId=instanceId;
      const health=await this.request('/health',undefined,5000,false);
      if(!health.ready||health.instanceId!==instanceId||health.personaId!=='bigfish')throw Error('记忆组件身份或存储未就绪');
    }catch(error){await this.stopChild(child);if(this.child===child)this.child=null;this.url=null;throw error;}
  }
  async request(route,body,timeout=15000,start=true,signal){
    if(start)await this.ensure();
    if(!this.url)throw Error('N.E.K.O. 记忆尚未连接');
    const control=AbortSignal.timeout(timeout),combined=signal?AbortSignal.any([control,signal]):control;
    const response=await fetch(this.url+'/workbench-memory'+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+this.token,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:combined,redirect:'error'});
    if(!response.ok)throw Error('记忆操作未完成，数据已保留，可稍后同步');
    const reader=response.body.getReader();let size=0,chunks=[];
    try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>8*1024*1024)throw Error('记忆响应超过限制');chunks.push(Buffer.from(next.value));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async stopChild(child){
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    child.stdin.end();
    await new Promise(resolve=>{const timer=setTimeout(resolve,12000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
    if(child.exitCode===null&&child.signalCode===null&&child.pid){
      if(process.platform==='win32')await new Promise(resolve=>{const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('exit',resolve);killer.once('error',resolve);});
      else {child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}
    }
  }
  async stop(){this.generation++;const child=this.child;this.url=null;this.child=null;await this.stopChild(child);await this.starting?.catch(()=>{});}
  async close(){this.closed=true;await this.stop();}
}

export class NekoMemoryAdapter {
  constructor({worker,personaId='bigfish',isConfigured=()=>true}){this.worker=worker;this.personaId=personaId;this.isConfigured=isConfigured;}
  async health(){if(!this.isConfigured())return {ready:false,capabilities,reason:'N.E.K.O. 待配置'};return this.worker.request('/health');}
  async pull(cursor='0'){
    const events=[];let size=0;
    while(true){const value=await this.worker.request('/pull?cursor='+encodeURIComponent(cursor),undefined,90000);if(!Array.isArray(value.events)||typeof value.nextCursor!=='string')throw Error('记忆响应格式无效');
      size+=JSON.stringify(value.events).length;if(size>50*1024*1024)throw Error('同步批次超过限制，请分批整理存档');events.push(...value.events);
      if(value.hasMore&&value.nextCursor===cursor)throw Error('记忆游标未前进');cursor=value.nextCursor;if(!value.hasMore)return {events,nextCursor:cursor};}
  }
  async push(events){
    validateEvents(events,this.personaId,events);const acknowledged=[];let batch=[],size=0;
    const send=async()=>{if(!batch.length)return;const value=await this.worker.request('/push',{personaId:this.personaId,events:batch},180000);if(!Array.isArray(value.ackedEventIds))throw Error('记忆确认格式无效');acknowledged.push(...value.ackedEventIds);batch=[];size=0;};
    try{for(const event of events){const bytes=Buffer.byteLength(JSON.stringify(event));if(batch.length>=4||size+bytes>2*1024*1024)await send();batch.push(event);size+=bytes;}await send();}
    catch(error){if(!acknowledged.length)throw error;}
    return {ackedEventIds:acknowledged};
  }
  async recall(query,tokenBudget,signal){const value=await this.worker.request('/recall',{personaId:this.personaId,query,tokenBudget},15000,true,signal);if(!Array.isArray(value.values))throw Error('记忆响应格式无效');return value.values;}
  close(){return this.worker.close();}
}
