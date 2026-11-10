'use strict';
const path=require('node:path'),{createHash}=require('node:crypto');
const {parseHomeScene,sceneFingerprint}=require('./our-home-scene.cjs');

// Observe the native tool registry's FINAL result. Never infer a mutation from
// a prompt, elapsed time, fs watcher, bash command text, or a renderer total.
function homeBuildReceipt(exec,result,{sessionId,sceneFile}){
 const session=exec?.agent?.session;
 if(!sessionId||String(session?.id)!==String(sessionId)||result?.isError!==false||!['write','edit'].includes(exec.name))return null;
 const value=result.value;
 if(!value||typeof value.path!=='string'||!path.isAbsolute(value.path)||path.resolve(value.path)!==path.resolve(sceneFile)||typeof value.after!=='string'||!(value.before===null||typeof value.before==='string'))return null;
 let items,beforeHash,afterHash;
 try{items=parseHomeScene(value.after);beforeHash=sceneFingerprint(value.before===null?[]:parseHomeScene(value.before));afterHash=sceneFingerprint(items);}catch{return null;}
 if(beforeHash===afterHash)return null;
 const events=typeof session.snapshotEvents==='function'?session.snapshotEvents():session.events,rootId=exec.rootCallId||exec.callId;
 const call=events?.findLast(e=>e.type==='tool/call'&&e.data?.callId===rootId);
 if(!call||!Number.isSafeInteger(call.data.turn)||!Number.isSafeInteger(call.data.step))return null;
 const message=events.findLast(e=>e.type==='assistant/message'&&e.data?.turn===call.data.turn&&e.data?.step===call.data.step&&!e.data.interrupted);
 // DSH's normalized total already includes any applicable cache usage. Do not
 // add cache/reasoning fields a second time or guess an absent provider total.
 const usage=message?.data?.usage,total=usage?.totalTokens;
 const tokens=Number.isSafeInteger(total)&&total>=0?total:null;
 const key=createHash('sha256').update(JSON.stringify([sessionId,call.data.turn,call.data.step])).digest('hex');
 return {key,beforeHash,afterHash,items,tokens};
}
module.exports={homeBuildReceipt};
