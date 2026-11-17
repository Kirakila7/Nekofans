'use strict';
const fs=require('node:fs'),path=require('node:path');
function readWindowsDshVersion(resources){
  const file=path.join(resources,'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/package.json');
  const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
  if(manifest.name!=='@deepseek-ai/dsh-desktop-host'||typeof manifest.version!=='string'||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))throw Error('Invalid DSH runtime manifest');
  return manifest.version;
}
function resolveWindowsDsh({resourcesPath,homeDir,programFiles='C:/Program Files',explicitInstall,bundledOnly=false,exists=fs.existsSync}){
  const bundled=path.join(resourcesPath,'dsh');
  if(exists(path.join(bundled,'app.asar'))&&exists(path.join(bundled,'app.asar.unpacked'))&&exists(path.join(bundled,'runtime/primary-runtime')))return {resources:bundled,bundled:true};
  if(bundledOnly)return null;
  const candidates=[explicitInstall,path.join(homeDir,'AppData/Local/Programs/DeepSeek Harness'),path.join(programFiles,'DeepSeek Harness')].filter(Boolean);
  for(const install of candidates){const resources=path.join(install,'resources');if(exists(path.join(resources,'app.asar')))return {resources,bundled:false};}
  return null;
}
module.exports={resolveWindowsDsh,readWindowsDshVersion};
