const fs=require('node:fs'),path=require('node:path');
const BUILTIN_IDS=Object.freeze(['yui','devcat','bigfish','claude','gemini']);
const PNG_HEADER=Buffer.from([137,80,78,71,13,10,26,10]);
function validCustom(value){
  if(typeof value!=='string'||!value.startsWith('data:image/png;base64,')||value.length>1400000)return false;
  const bytes=Buffer.from(value.slice(22),'base64');
  return bytes.length>8&&bytes.length<=1024*1024&&bytes.subarray(0,8).equals(PNG_HEADER);
}
function createAppearanceStore(file){
  let value={builtinId:'yui',customDataUrl:null};
  try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(validCustom(saved.customDataUrl))value.customDataUrl=saved.customDataUrl;if(BUILTIN_IDS.includes(saved.builtinId)||(saved.builtinId==='custom'&&value.customDataUrl))value.builtinId=saved.builtinId;}catch{}
  const get=()=>({...value});
  function save(){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2));fs.renameSync(file+'.tmp',file);return get();}
  return {get,select(id){if(!BUILTIN_IDS.includes(id)&&!(id==='custom'&&value.customDataUrl))throw new Error('请选择内置头像或先上传图片。');value.builtinId=id;return save();},upload(dataUrl){if(!validCustom(dataUrl))throw new Error('头像必须是有效的 PNG 图片，且不超过 1 MB。');value={builtinId:'custom',customDataUrl:dataUrl};return save();}};
}
module.exports={BUILTIN_IDS,validCustom,createAppearanceStore};
