'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const valid=platform=>platform==='bilibili'||platform==='youtube';
function createVideoPlatform(file){
  let platform='bilibili';
  try { if(fs.statSync(file).size<1024){const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&valid(value.platform))platform=value.platform;} } catch { /* Missing or corrupt preference falls back to B站. */ }
  return {
    get(){return {platform};},
    set(next){
      if(!valid(next))throw Error('视频平台设置无效');
      fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temporary=file+'.'+randomUUID()+'.tmp';
      try {fs.writeFileSync(temporary,JSON.stringify({platform:next})+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);platform=next;}
      finally {fs.rmSync(temporary,{force:true});}
      return {platform};
    },
  };
}
module.exports={createVideoPlatform};
