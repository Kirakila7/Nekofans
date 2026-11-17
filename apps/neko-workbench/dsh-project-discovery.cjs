'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto');
const MAX_REGISTRY_BYTES=4*1024*1024,MAX_PROJECTS=5000;
const pathApi=value=>/^(?:[A-Za-z]:[\\/]|\\\\)/.test(value)?path.win32:path.posix;
const rootKey=value=>{const api=pathApi(value),normalized=api.normalize(value);return api===path.win32?normalized.toLowerCase():normalized;};
function validRoot(value,platform=process.platform){
 if(typeof value!=='string'||!value||value.length>4096||/[\p{Cc}\p{Cf}]/u.test(value))return false;
 if(platform!=='win32')return path.posix.isAbsolute(value);
 const root=path.win32.parse(value).root;
 return path.win32.isAbsolute(value)&&root!=='\\'&&root!=='/'&&!/^\\\\\.\\/.test(value);
}
const safeId=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\p{Cc}\p{Cf}]/u.test(value);
const timestamp=value=>typeof value==='number'&&Number.isFinite(value)?value:Number.isFinite(Date.parse(value))?Date.parse(value):0;
const projectName=(value,cwd)=>String(typeof value==='string'?value:'').replace(/[\p{Cc}\p{Cf}]/gu,'').trim().slice(0,160)||pathApi(cwd).basename(cwd)||cwd;
const workspaceProjectId=id=>'dsh-workspace:'+encodeURIComponent(id);
const installedProjectId=id=>'installed-dsh:'+encodeURIComponent(id);
const historyProjectId=cwd=>'dsh-history:'+createHash('sha256').update(rootKey(cwd)).digest('hex');

// This is the documented dsh-base storage-json workspace domain, not a scan of
// profiles, session logs, arbitrary projects, credentials or user documents.
// Official 0.2.1-rc.3: <DSH_HOME>/storages/workspace.json, unit workspace/v2.
function projectRegistryRows(document,{platform=process.platform}={}){
 const fail=()=>{throw Error('DSH workspace registry unavailable');};
 if(!document||document.unit?.name!=='workspace'||document.unit.version!==2||document.global?.initialized!==true||document.global.pendingMutation!=null)fail();
 const ids=document.global.workspaceIds,table=document.tables?.workspaces;
 if(!Array.isArray(ids)||ids.length>MAX_PROJECTS||!table||typeof table!=='object'||Array.isArray(table)||Object.keys(table).length!==ids.length||new Set(ids).size!==ids.length)fail();
 const roots=new Set();
 return ids.map(id=>{
  if(!safeId(id)||!Object.hasOwn(table,id))fail();const row=table[id];
  if(!row||!validRoot(row.path,platform)||typeof row.title!=='string'||!Array.isArray(row.sessionIds)||row.sessionIds.length>100000||!row.sessionIds.every(safeId)||typeof row.createdAt!=='string'||typeof row.updatedAt!=='string')fail();
  const key=rootKey(row.path);if(roots.has(key))fail();roots.add(key);
  return {id:installedProjectId(id),provider:'dsh',workspaceId:null,cwd:row.path,name:projectName(row.title,row.path),source:'installed-dsh',needsRegistration:true,sessionIds:[],updatedAt:timestamp(row.updatedAt)};
 });
}
function createDshProjectDiscovery({homeDir=os.homedir(),dshHome=path.join(homeDir,'.dsh'),platform=process.platform,now=Date.now,cacheMs=20000}={}){
 if(!path.isAbsolute(dshHome))throw Error('DSH registry home must be absolute');
 let cached=null,checkedAt=0,pending=null;
 async function read(){
  try{
   const home=await fs.realpath(dshHome),file=path.join(home,'storages','workspace.json');
   const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_REGISTRY_BYTES)throw Error('Invalid workspace registry');
   const actual=await fs.realpath(file),relative=path.relative(home,actual);
   if(relative!=='storages'+path.sep+'workspace.json')throw Error('Workspace registry escapes its declared home');
   const handle=await fs.open(actual,'r');let text;
   try{const info=await handle.stat();if(!info.isFile()||info.size>MAX_REGISTRY_BYTES)throw Error('Invalid workspace registry');const bytes=Buffer.alloc(MAX_REGISTRY_BYTES+1);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);if(bytesRead>MAX_REGISTRY_BYTES)throw Error('Workspace registry too large');text=bytes.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}
   return {status:'ready',workspaces:projectRegistryRows(JSON.parse(text),{platform})};
  }catch(error){return {status:error?.code==='ENOENT'?'not-found':'unavailable',workspaces:[]};}
 }
 async function list({force=false}={}){
  if(!force&&cached&&now()-checkedAt<cacheMs)return structuredClone(cached);
  if(!pending){const operation=read().then(value=>{cached=value;checkedAt=now();return value;}).finally(()=>{if(pending===operation)pending=null;});pending=operation;}
  return structuredClone(await pending);
 }
 return Object.freeze({list});
}
module.exports={createDshProjectDiscovery,projectRegistryRows,workspaceProjectId,installedProjectId,historyProjectId,validRoot,rootKey,projectName,timestamp};
