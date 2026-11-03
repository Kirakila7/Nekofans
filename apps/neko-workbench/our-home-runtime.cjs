'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const {validateHomeItems,homeContext}=require('./our-home-scene.cjs');
// A fixed, data-only scene file is shared with DSH. No script, URL, external
// resource or filesystem path from the scene is ever executed or followed.
function createOurHomeRuntime({workspaceDir,getStorage,onError=()=>{},intervalMs=1000}){
 const directory=path.join(workspaceDir,'our-home'),file=path.join(directory,'scene.json');let timer,stopped=false,reading=false,lastHash='',snapshot=null,error='',unsubscribe;
 async function refresh(){if(stopped||reading)return;reading=true;try{
  const dir=await fs.lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('小窝共建目录无效');const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>160000)throw Error('小窝场景文件过大或不是普通文件');
  const real=await fs.realpath(file),parent=await fs.realpath(directory);if(path.dirname(real)!==parent)throw Error('小窝场景路径无效');
  const handle=await fs.open(file,'r');let raw;try{const opened=await handle.stat();if(opened.ino!==st.ino||opened.dev!==st.dev||!opened.isFile())throw Error('小窝场景在读取前发生变化');const buffer=Buffer.alloc(160001);let count=0;while(count<buffer.length){const result=await handle.read(buffer,count,buffer.length-count,count);if(!result.bytesRead)break;count+=result.bytesRead;}if(count>160000)throw Error('小窝场景文件过大');raw=buffer.subarray(0,count).toString('utf8');}finally{await handle.close();}
  const hash=createHash('sha256').update(raw).digest('hex');if(hash===lastHash&&!error)return;const plan=JSON.parse(raw);if(plan?.version!==1||Object.keys(plan).some(k=>!['version','items'].includes(k)))throw Error('小窝场景格式无效');const items=validateHomeItems(plan.items),store=await getStorage();await store.command({action:'furnish',items});lastHash=hash;error='';
 }catch(e){error=e.code==='ENOENT'?'':e.message||'小窝场景未能更新';if(error)onError(error);}finally{reading=false;}}
 async function start(){const storage=await getStorage();snapshot=storage.state();unsubscribe=storage.subscribe(value=>snapshot=value);await fs.mkdir(directory,{recursive:true});const dir=await fs.lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('小窝共建目录不能是链接');
  try{await fs.writeFile(file,JSON.stringify({version:1,items:snapshot.items||[]},null,2)+'\n',{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  const instructions='小窝共建项目\n\n编辑同目录 scene.json，保存后工作台会自动更新。保持 version:1、items 数组；每件物品需要唯一 id、kind、name、x、z。\nkind: bed, desk, table, chair, sofa, shelf, plant, lamp, rug, plush, screen, box, wall, window。\nx:-4.5..4.5；z:-3.5..3.5；y 默认 0；width/height/depth 可选 0.02..5；rotation 为度；color 为 #RRGGBB。\n只提交 JSON 数据；不要输出脚本、外部 URL 或资源路径。不要声称已完成，先保存 scene.json 并核对文件内容。\n默认只有地板，用户提出需要后再增添家具。保留已有物品，除非用户明确要求删除或重布置。\n';await fs.writeFile(path.join(directory,'README.txt'),instructions);try{await fs.writeFile(path.join(directory,'AGENTS.md'),instructions,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}await refresh();timer=setInterval(()=>void refresh(),intervalMs);timer.unref?.();return {directory,file};}
 return {start,refresh,context:()=>snapshot?homeContext(snapshot):'',status:()=>({directory,file,error}),dispose(){stopped=true;clearInterval(timer);unsubscribe?.();}};
}
module.exports={createOurHomeRuntime};
