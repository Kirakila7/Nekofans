'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
function createHomePetAssets({root=path.join(__dirname,'assets/original-status')}={}){
 let flight;const cache=new Map();
 async function manifest(){return flight??=fs.readFile(path.join(__dirname,'original/work-config.js'),'utf8').then(async text=>{
  const config=JSON.parse(text.replace(/^window\.DshPetWorkConfig=/,'').replace(/;\s*$/,'')),a=config.animations;
  const available=new Set((await fs.readdir(root)).filter(n=>n.endsWith('.webm')).map(n=>n.slice(0,-5)));
  const filter=list=>(list||[]).filter(n=>typeof n==='string'&&!/[\\/\0]/.test(n)&&available.has(n));
  return {idle:filter(a.idle),turn:filter(a.turn),drag:filter(a.drag),clicks:filter(a.clicks),moves:filter([...a.moves.actions.map(n=>n.name),'子代理-持续奔跑']),actions:filter(a.categories.flatMap(n=>n.actions))};
 });}
 return {manifest,async load(name){const groups=await manifest();if(typeof name!=='string'||!Object.values(groups).some(names=>names.includes(name)))throw Error('小鱼动作不可用');
  if(cache.has(name))return cache.get(name);const file=path.join(root,name+'.webm'),st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>12*1024*1024)throw Error('小鱼动作素材无效');
  const bytes=await fs.readFile(file);if(bytes.length>12*1024*1024)throw Error('小鱼动作过大');const value={name,src:'data:video/webm;base64,'+bytes.toString('base64')};if(cache.size>=3)cache.delete(cache.keys().next().value);cache.set(name,value);return value;
 }};
}
module.exports={createHomePetAssets};
