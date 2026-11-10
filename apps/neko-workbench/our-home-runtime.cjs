'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {validateHomeItems,homeContext,parseHomeScene,sceneFingerprint}=require('./our-home-scene.cjs');
// A fixed, data-only scene file is shared with DSH. No script, URL, external
// resource or filesystem path from the scene is ever executed or followed.
function createOurHomeRuntime({workspaceDir,getStorage,onError=()=>{},intervalMs=1000}){
 const directory=path.join(workspaceDir,'our-home'),file=path.join(directory,'scene.json');let timer,stopped=false,lastHash='',snapshot=null,error='',unsubscribe,tail=Promise.resolve();const pending=new Map();
 function refresh(){const task=tail.catch(()=>{}).then(readScene);tail=task;return task;}
 async function readScene(){if(stopped)return;const observed=new Map(pending);try{
  const dir=await fs.lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('小窝共建目录无效');const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>160000)throw Error('小窝场景文件过大或不是普通文件');
  const real=await fs.realpath(file),parent=await fs.realpath(directory);if(path.dirname(real)!==parent)throw Error('小窝场景路径无效');
  const handle=await fs.open(file,'r');let raw;try{const opened=await handle.stat();if(opened.ino!==st.ino||opened.dev!==st.dev||!opened.isFile())throw Error('小窝场景在读取前发生变化');const buffer=Buffer.alloc(160001);let count=0;while(count<buffer.length){const result=await handle.read(buffer,count,buffer.length-count,count);if(!result.bytesRead)break;count+=result.bytesRead;}if(count>160000)throw Error('小窝场景文件过大');raw=buffer.subarray(0,count).toString('utf8');}finally{await handle.close();}
  const items=parseHomeScene(raw),hash=sceneFingerprint(items),receipts=[],reachable=new Set([hash]),waiting=[...observed.values()],store=await getStorage();
  for(let found=true;found;){found=false;for(let i=waiting.length-1;i>=0;i--){const receipt=waiting[i];if(reachable.has(receipt.afterHash)){receipts.push(receipt);reachable.add(receipt.beforeHash);waiting.splice(i,1);found=true;}}}
  if(hash!==lastHash||error||receipts.length||store.state().persistence?.status==='save-error'){
   if(hash!==sceneFingerprint(store.state().items||[])||receipts.length||store.state().persistence?.status==='save-error'){
    if(store.applyScene)await store.applyScene(items,receipts);else await store.command({action:'furnish',items});
   }
   lastHash=hash;error='';
  }
  // Each receipt describes a specific successful native write. Do not retain
  // an unmatched receipt for an unrelated future scene that happens to match.
  for(const [key,receipt]of observed)if(pending.get(key)===receipt)pending.delete(key);
 }catch(e){error=e.code==='ENOENT'?'':e.message||'小窝场景未能更新';if(error)onError(error);}}
 function acceptBuild(receipt){try{if(!receipt||!(/^[a-f0-9]{64}$/.test(receipt.key))||!(/^[a-f0-9]{64}$/.test(receipt.beforeHash))||receipt.beforeHash===receipt.afterHash||sceneFingerprint(validateHomeItems(receipt.items))!==receipt.afterHash||!(receipt.tokens===null||Number.isSafeInteger(receipt.tokens)&&receipt.tokens>=0))return Promise.resolve();pending.set(receipt.key,receipt);return refresh();}catch{return Promise.resolve();}}
 async function start(){const storage=await getStorage();snapshot=storage.state();unsubscribe=storage.subscribe(value=>snapshot=value);await fs.mkdir(directory,{recursive:true});const dir=await fs.lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('小窝共建目录不能是链接');
  try{await fs.writeFile(file,JSON.stringify({version:1,items:snapshot.items||[]},null,2)+'\n',{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  const accounting='\n<!-- neko-home-build-accounting-v1 -->\n修改 scene.json 时使用原生 write 或 edit 工具，便于工作台以真实修改结果和模型 usage 记录建造 Token。不要用 bash、脚本或 str_replace_editor 改写场景。普通讨论、查看文件和手动布置不计入价值；不要自行编造或修改累计值。\n';
  const instructions='小窝共建项目\n\n编辑同目录 scene.json，保存后工作台会自动更新。保持 version:1、items 数组；每件物品需要唯一 id、kind、name、x、z。\nkind: bed, desk, table, chair, sofa, shelf, plant, lamp, rug, plush, screen, box, wall, window。\nx:-4.5..4.5；z:-3.5..3.5；y 默认 0；width/height/depth 可选 0.02..5；rotation 为度；color 为 #RRGGBB。\n只提交 JSON 数据；不要输出脚本、外部 URL 或资源路径。不要声称已完成，先保存 scene.json 并核对文件内容。\n默认只有地板，用户提出需要后再增添家具。保留已有物品，除非用户明确要求删除或重布置。\n'+accounting;await fs.writeFile(path.join(directory,'README.txt'),instructions);const agentFile=path.join(directory,'AGENTS.md');try{await fs.writeFile(agentFile,instructions,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;const st=await fs.lstat(agentFile);if(st.isFile()&&!st.isSymbolicLink()&&st.size<160000){const existing=await fs.readFile(agentFile,'utf8');if(!existing.includes('<!-- neko-home-build-accounting-v1 -->'))await fs.appendFile(agentFile,accounting);}}await refresh();timer=setInterval(()=>void refresh(),intervalMs);timer.unref?.();return {directory,file};}
 return {start,refresh,acceptBuild,context:()=>snapshot?homeContext(snapshot):'',status:()=>({directory,file,error}),dispose(){stopped=true;clearInterval(timer);unsubscribe?.();}};
}
module.exports={createOurHomeRuntime};
