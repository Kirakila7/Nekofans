'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomicBytes}=require('./main-chat-secret.cjs');
const dayOf=time=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(time);
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Conservative public-text gate: source turns containing these are excluded,
// and the generated public result must pass the same gate before transmission.
const sensitive=text=>/(?:https?:\/\/|[A-Z]:\\|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b1[3-9]\d{9}\b|(?:api[_ -]?key|password|passwd|authorization|access[_ -]?token|secret|密码|验证码|身份证|手机号|私钥|密钥)\s*[:：=]|\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}|```|<tool_call|DSML)/i.test(text);
function interactions(rows,time){
 return (Array.isArray(rows)?rows:[]).filter(m=>['user','assistant'].includes(m.role)&&!m.proactive&&typeof m.text==='string'&&Number.isFinite(m.createdAt??m.time)&&dayOf(m.createdAt??m.time)===dayOf(time)&&!sensitive(m.text))
   .slice(-40).map(m=>({role:m.role,text:m.text.trim().slice(0,500)})).filter(m=>m.text);
}
function createCommunityDaily({dataDir,getIdentity,getInteractions,generate,publish,isBusy=()=>false,now=Date.now,intervalMs=60000}){
 const file=path.join(dataDir,'community-daily.json');let state={version:1,enabled:false,ownerId:null,receipts:[]},error='',running=false,disposed=false,epoch=0,timer,aborter,lastAttempt=0;
 try{const raw=JSON.parse(fs.readFileSync(file,'utf8'));if(raw.version!==1||typeof raw.enabled!=='boolean'||!Array.isArray(raw.receipts)||raw.receipts.length>90||raw.receipts.some(r=>!r||typeof r.day!=='string'||typeof r.ownerId!=='string'||!['sending','published','uncertain'].includes(r.status))||raw.enabled&&typeof raw.ownerId!=='string')throw Error('invalid journal');state=raw;}catch(e){if(e.code!=='ENOENT')error='社区日常记录不可读，自动分享保持关闭';}
 const save=()=>{fs.mkdirSync(dataDir,{recursive:true});atomicBytes(file,Buffer.from(JSON.stringify(state,null,2)+'\n'));};
 const status=()=>({enabled:state.enabled,generating:running,error,today:state.receipts.find(r=>r.day===dayOf(now())&&r.ownerId===getIdentity()?.userId)?.status||'none'});
 const interrupt=()=>{const active=!!aborter;epoch++;aborter?.abort();return active;};
 function configure(enabled){
  if(disposed||typeof enabled!=='boolean')throw Error('社区日常设置无效');
  const identity=getIdentity();if(enabled&&!identity?.userId)throw Error('请先在“猫娘串门”中登录社区账号');
  const previous=state;state={...state,enabled,ownerId:enabled?identity.userId:state.ownerId};try{save();}catch(e){state=previous;throw e;}
  epoch++;aborter?.abort();error='';
 }
 async function tick({force=false}={}){
  if(disposed||running||!state.enabled)return;const time=now(),day=dayOf(time),hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(time));
  if(!force&&(hour<20||hour>=23||time-lastAttempt<600000)||isBusy())return;
  const identity=getIdentity();if(!identity||identity.userId!==state.ownerId){error='社区账号未连接或已切换，请连接原账号或重新开启分享';return;}
  if(state.receipts.some(r=>r.day===day&&r.ownerId===identity.userId))return;
  running=true;lastAttempt=time;const generation=epoch,controller=aborter=new AbortController();
  const current=()=>!disposed&&generation===epoch&&!controller.signal.aborted&&state.enabled&&dayOf(now())===day&&JSON.stringify(getIdentity())===JSON.stringify(identity)&&!isBusy();
  let receipt;
  try{
   const rows=interactions(await getInteractions(),time);if(!current()||!rows.some(m=>m.role==='user'))return;
   const inputDigest=digest(rows),text=await generate(rows,AbortSignal.any([controller.signal,AbortSignal.timeout(45000)]));
   if(!current()||digest(interactions(await getInteractions(),now()))!==inputDigest)return;
   if(typeof text!=='string'||text.trim()==='[安静]')return;
   let body=text.trim();if(!body||body.length>480||sensitive(body))throw Error('unsafe public summary');
   if(!body.endsWith('大肥鱼 · AI日常'))body+='\n\n大肥鱼 · AI日常';
   // Durable reservation BEFORE the only outbound write: a timeout/crash cannot
   // cause an automatic duplicate when the server has no idempotency contract.
   const previous=state.receipts;receipt={ownerId:identity.userId,day,status:'sending',at:now(),inputDigest};state.receipts=[...previous.filter(r=>r.day>=dayOf(time-60*86400000)).slice(-89),receipt];
   try{save();}catch(e){state.receipts=previous;receipt=null;throw e;}
   if(!current()){receipt.status='uncertain';save();return;}
   const result=await publish({identity,title:`大肥鱼的今日小记 · ${day}`,body,signal:controller.signal,assertCurrent:()=>{if(!current())throw Error('daily_cancelled');}});
   receipt.status='published';receipt.postId=result.id;save();error='';
  }catch(e){
   if(receipt){receipt.status='uncertain';try{save();}catch{}error='本次发布结果待核对，今天不会自动重复发送';}
   else if(!controller.signal.aborted)error='社区日常暂未发布，请检查账号、模型或今日互动内容';
  }finally{controller.abort();if(aborter===controller)aborter=null;running=false;}
 }
 return Object.freeze({status,configure,tick,interrupt,start(){if(!timer&&!disposed){timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();void tick();}},dispose(){disposed=true;interrupt();clearInterval(timer);}});
}
module.exports={createCommunityDaily,interactions,dayOf,sensitive};
