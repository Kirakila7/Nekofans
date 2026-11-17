'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {atomicBytes}=require('./main-chat-secret.cjs');
const {biliExperience,validExperience}=require('./channel-experiences.cjs');
const DAY=86400000,GAP=30*60000;
function createChannelLife({dataDir,fishLog,getMemory,generate,present,isBusy=()=>false,now=Date.now,onState=()=>{},intervalMs=15000}){
  const file=path.join(dataDir,'channel-life.json');let state={version:1,memoryEnabled:true,proactiveEnabled:false,entries:[],lastAttempt:0,day:'',attempts:0,replies:[],fish:{offset:0}},error='',timer,running=false,disposed=false,aborter,epoch=0,lastHuman=now();
  try{const raw=JSON.parse(fs.readFileSync(file,'utf8'));if(raw.version!==1||!Array.isArray(raw.entries)||raw.entries.length>128)throw Error('invalid channel journal');state={...state,...raw,entries:raw.entries.filter(e=>validExperience(e.entry)),memoryEnabled:raw.memoryEnabled===true,proactiveEnabled:raw.proactiveEnabled===true};}catch(e){if(e.code!=='ENOENT'){state.memoryEnabled=false;state.proactiveEnabled=false;error='渠道记忆记录不可读取，请检查本机文件后重启';}}
  const save=()=>{fs.mkdirSync(dataDir,{recursive:true});atomicBytes(file,Buffer.from(JSON.stringify(state,null,2)+'\n'));};
  const status=()=>({memoryEnabled:state.memoryEnabled,proactiveEnabled:state.proactiveEnabled,pending:state.entries.filter(e=>!e.remembered).length,remembered:state.entries.filter(e=>e.remembered).length,generating:!!aborter,error});
  const publish=()=>{if(!disposed)onState(status());};
  function interrupt(){epoch++;aborter?.abort();}
  function touch(){lastHuman=now();interrupt();}
  function configure(patch){if(disposed)throw Error('渠道记忆已关闭');if(Object.keys(patch).some(k=>!['memoryEnabled','proactiveEnabled'].includes(k))||Object.values(patch).some(v=>typeof v!=='boolean'))throw Error('渠道记忆设置无效');const previous={...state};Object.assign(state,patch);try{save();}catch(e){state=previous;throw e;}interrupt();publish();}
  function accept(entry){
    if(disposed||!state.memoryEnabled||!validExperience(entry))return false;
    if(entry.occurredAt>now()+300000||entry.occurredAt<now()-DAY)return true;
    if(state.entries.some(e=>e.entry.channel===entry.channel&&e.entry.id===entry.id))return true;
    state.entries=state.entries.filter(e=>!e.remembered||e.entry.occurredAt>now()-DAY);
    if(state.entries.length>=128){error='渠道记忆队列已满，待处理后重试';publish();return false;}
    state.entries.push({entry:structuredClone(entry),remembered:false,spoken:false});try{save();}catch(e){state.entries.pop();throw e;}publish();return true;
  }
  async function pollFish(){
    if(!fishLog||!state.memoryEnabled)return;
    let handle;try{
      const stat=await fsp.lstat(fishLog);if(!stat.isFile()||stat.isSymbolicLink())throw Error('invalid fish log');
      let offset=Number.isSafeInteger(state.fish?.offset)?state.fish.offset:0,skip=state.fish?.skip===true;
      if(state.fish?.ino!==stat.ino||offset>stat.size){offset=Math.max(0,stat.size-262144);skip=offset>0;}
      handle=await fsp.open(fishLog,'r');const opened=await handle.stat();if(opened.ino!==stat.ino||opened.dev!==stat.dev)throw Error('fish log changed');
      const buffer=Buffer.alloc(Math.min(262144,Math.max(0,stat.size-offset)));const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);const bytes=buffer.subarray(0,bytesRead);let consumed=0;
      for(let end=bytes.indexOf(10);end>=0;end=bytes.indexOf(10,consumed)){
        const line=bytes.subarray(consumed,end);if(!skip&&line.length<=16384){try{const entry=biliExperience(JSON.parse(line.toString('utf8')));if(entry&&!accept(entry))break;}catch(e){if(e instanceof SyntaxError){}else throw e;}}
        skip=false;consumed=end+1;
      }
      if(!consumed&&bytesRead===262144){consumed=bytesRead;skip=true;}
      state.fish={offset:offset+consumed,ino:stat.ino,skip};save();
    }catch(e){if(e.code!=='ENOENT'){error='B站经历读取失败，保留游标待重试';publish();return false;}}finally{await handle?.close();}
    return true;
  }
  async function tick(){
    if(disposed||running)return;running=true;
    try{
      const fishOk=await pollFish();if(disposed||!state.memoryEnabled)return;
      const memory=getMemory();if(!memory)return;
      for(const row of state.entries.filter(e=>!e.remembered).slice(0,8)){
        const result=await memory.recordChannelExperience(row.entry);if(disposed||!state.memoryEnabled||getMemory()!==memory)return;row.remembered=true;row.itemId=result.itemId;if(!result.available)row.spoken=true;save();
      }
      if(fishOk!==false&&state.entries.every(e=>e.remembered))error='';publish();
      const time=now(),day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(time),hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(time));
      if(!state.proactiveEnabled||isBusy()||time-lastHuman<60000||time-state.lastAttempt<GAP||hour<8||hour>=23)return;
      if(state.day!==day){state.day=day;state.attempts=0;}
      if(state.attempts>=6)return;
      const row=[...state.entries].reverse().find(e=>e.remembered&&!e.spoken&&e.entry.occurredAt>=time-DAY&&memory.channelExperience(e.itemId));if(!row)return;
      state.lastAttempt=time;state.attempts++;save();const generation=epoch,controller=aborter=new AbortController();publish();
      try{
        const source=memory.channelExperience(row.itemId);if(!source)return;
        const text=await generate({...row.entry,text:source.text},AbortSignal.any([controller.signal,AbortSignal.timeout(45000)]));
        if(disposed||generation!==epoch||controller.signal.aborted||isBusy()||!state.memoryEnabled||!state.proactiveEnabled||getMemory()!==memory||JSON.stringify(memory.channelExperience(row.itemId))!==JSON.stringify(source))return;
        if(typeof text!=='string'||!text.trim())throw Error('empty proactive response');
        const reply=text.trim();if(reply!=='[安静]'){
          if(reply.length>400)throw Error('proactive response too long');
          // Save the delivery receipt before displaying: a crash must not repeat it.
          row.spoken=true;state.replies.push({itemId:row.itemId,text:reply,at:now()});state.replies=state.replies.slice(-40);save();
          present({id:'channel-'+row.entry.id,text:reply,source:row.entry.channel});
        }else{row.spoken=true;save();}
        error='';
      }catch(e){if(generation===epoch&&!controller.signal.aborted)throw e;}finally{if(aborter===controller)aborter=null;publish();}
    }catch(e){if(!disposed&&!aborter?.signal.aborted){error='渠道记忆或主动搭话暂不可用，记录已保留待重试';publish();}}finally{running=false;}
  }
  function context(){const latest=state.replies.at(-1);return latest?'主角色最近主动对主人说（这是角色自己的发言，不是主人发言，也不表示主人同意）：\n'+JSON.stringify({at:new Date(latest.at).toISOString(),text:latest.text}):'';}
  return Object.freeze({accept,tick,status,context,configure,touch,interrupt,start(){if(!timer&&!disposed){timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();void tick();}},dispose(){disposed=true;interrupt();clearInterval(timer);}});
}
module.exports={createChannelLife};
