'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomicBytes}=require('./main-chat-secret.cjs');
const dayOf=time=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(time);
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DEFAULT_STYLE='温暖自然，像和朋友分享生活，简短不夸张';
const RETRYABLE_PUBLICATION = {
 daily_login_required:'社区授权已失效或账号已切换，请重新登录后重试',
 daily_not_submitted:'未能验证社区账号，本次未发帖，请稍后重试',
 daily_post_forbidden:'社区拒绝了此账号的发帖请求，请检查社区发帖权限后重试',
};
function dailySettings(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['sendTime','style'].includes(k)))throw Error('社区日常设置无效');
 const sendTime=value.sendTime??'20:00',style=value.style??DEFAULT_STYLE;
 if(typeof sendTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)||typeof style!=='string'||style.length>300||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(style))throw Error('请填写有效发送时间和 300 字以内的内容风格');
 return {sendTime,style:style.trim()||DEFAULT_STYLE};
}
// Conservative public-text gate: source turns containing these are excluded,
// and the generated public result must pass the same gate before transmission.
const sensitive=text=>/(?:https?:\/\/|[A-Z]:\\|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b1[3-9]\d{9}\b|(?:api[_ -]?key|password|passwd|authorization|access[_ -]?token|secret|密码|验证码|身份证|手机号|私钥|密钥)\s*[:：=]|\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}|```|<tool_call|DSML)/i.test(text);
function interactions(rows,time){
 return (Array.isArray(rows)?rows:[]).filter(m=>['user','assistant'].includes(m.role)&&!m.proactive&&typeof m.text==='string'&&Number.isFinite(m.createdAt??m.time)&&dayOf(m.createdAt??m.time)===dayOf(time)&&!sensitive(m.text))
   .slice(-40).map(m=>({role:m.role,text:m.text.trim().slice(0,500)})).filter(m=>m.text);
}
function createCommunityDaily({dataDir,getIdentity,getInteractions,generate,publish,isBusy=()=>false,now=Date.now,intervalMs=60000}){
 const file=path.join(dataDir,'community-daily.json');let state={version:1,enabled:false,ownerId:null,receipts:[],...dailySettings()},error='',running=false,disposed=false,epoch=0,timer,aborter,lastAttempt=0;
 try{const raw=JSON.parse(fs.readFileSync(file,'utf8'));if(raw.version!==1||typeof raw.enabled!=='boolean'||!Array.isArray(raw.receipts)||raw.receipts.length>90||raw.receipts.some(r=>!r||typeof r.day!=='string'||typeof r.ownerId!=='string'||!['sending','published','uncertain'].includes(r.status))||raw.enabled&&typeof raw.ownerId!=='string')throw Error('invalid journal');state={...raw,...dailySettings({sendTime:raw.sendTime,style:raw.style})};}catch(e){if(e.code!=='ENOENT')error='社区日常记录不可读，自动分享保持关闭';}
 const save=()=>{fs.mkdirSync(dataDir,{recursive:true});atomicBytes(file,Buffer.from(JSON.stringify(state,null,2)+'\n'));};
 const status=()=>{const ownerId=getIdentity()?.userId;return {enabled:state.enabled,connected:!!ownerId,sendTime:state.sendTime,style:state.style,generating:running,error,today:state.receipts.find(r=>r.day===dayOf(now())&&r.ownerId===ownerId)?.status||'none'};};
 const interrupt=()=>{const active=!!aborter;epoch++;aborter?.abort();return active;};
 function saveSettings(patch){
  if(disposed)throw Error('社区日常已关闭');
  dailySettings(patch);const settings=dailySettings({sendTime:state.sendTime,style:state.style,...patch}),previous=state;state={...state,...settings};try{save();}catch(error){state=previous;throw error;}
  interrupt();lastAttempt=0;error='';return status();
 }
 function configure(enabled){
  if(disposed||typeof enabled!=='boolean')throw Error('社区日常设置无效');
  const identity=getIdentity();if(enabled&&!identity?.userId)throw Error('请先在“猫娘串门”中登录社区账号');
  const previous=state;state={...state,enabled,ownerId:enabled?identity.userId:state.ownerId};try{save();}catch(e){state=previous;throw e;}
  epoch++;aborter?.abort();error='';
 }
 async function tick({force=false}={}){
  if(disposed||running||!state.enabled)return;const time=now(),day=dayOf(time),clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(time);
  if(!force&&(clock<state.sendTime||time-lastAttempt<600000)||isBusy())return;
  const identity=getIdentity();if(!identity||identity.userId!==state.ownerId){error='社区账号未连接或已切换，请连接原账号或重新开启分享';return;}
  if(state.receipts.some(r=>r.day===day&&r.ownerId===identity.userId))return;
  running=true;lastAttempt=time;const generation=epoch,controller=aborter=new AbortController();
  const current=()=>!disposed&&generation===epoch&&!controller.signal.aborted&&state.enabled&&dayOf(now())===day&&JSON.stringify(getIdentity())===JSON.stringify(identity)&&!isBusy();
  let receipt;
  try{
   const rows=interactions(await getInteractions(),time);if(!current()||!rows.some(m=>m.role==='user'))return;
   const inputDigest=digest(rows),text=await generate(rows,AbortSignal.any([controller.signal,AbortSignal.timeout(45000)]),{style:state.style});
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
   if(receipt&&Object.hasOwn(RETRYABLE_PUBLICATION,e?.code)){
    const previous=state.receipts;state.receipts=previous.filter(r=>r!==receipt);
    try{save();error=RETRYABLE_PUBLICATION[e.code];return;}catch{state.receipts=previous;}
   }
   if(receipt){receipt.status='uncertain';try{save();}catch{}error='本次发布结果待核对，今天不会自动重复发送';}
   else if(!controller.signal.aborted)error='社区日常暂未发布，请检查账号、模型或今日互动内容';
  }finally{controller.abort();if(aborter===controller)aborter=null;running=false;}
 }
 return Object.freeze({status,configure,saveSettings,tick,interrupt,start(){if(!timer&&!disposed){timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();void tick();}},dispose(){disposed=true;interrupt();clearInterval(timer);}});
}
module.exports={createCommunityDaily,interactions,dayOf,sensitive,dailySettings};
