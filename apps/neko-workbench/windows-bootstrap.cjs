'use strict';
const fs=require('node:fs'),path=require('node:path');
const {app,dialog}=require('electron');
const base=path.dirname(process.execPath);
let local={};
try{local=JSON.parse(fs.readFileSync(path.join(base,'NEKOfuns.local.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(local.profileName!==undefined&&(typeof local.profileName!=='string'||! /^[A-Za-z0-9._ -]{1,80}$/.test(local.profileName)))throw Error('Invalid workbench profile name');
const data=process.env.NEKO_WORKBENCH_DATA_DIR||local.dataDir||path.join(app.getPath('appData'),local.profileName||'N.E.K.O. Workbench');
const workspace=process.env.NEKO_WORKBENCH_WORKSPACE||local.workspaceDir||path.join(app.getPath('documents'),'NEKOfuns',...(local.profileName?[local.profileName]:[]),'workspaces');
for(const value of [data,workspace])if(typeof value!=='string'||!path.isAbsolute(value))throw Error('工作台数据和工作区需要绝对路径');
const {resolveWindowsDsh}=require(path.join(process.resourcesPath,'workbench/apps/neko-workbench/windows-dsh-runtime.cjs'));
const dsh=resolveWindowsDsh({resourcesPath:process.resourcesPath,homeDir:app.getPath('home'),programFiles:process.env.ProgramFiles,explicitInstall:local.dshInstall,bundledOnly:local.bundledDshOnly===true});
delete process.env.ELECTRON_RUN_AS_NODE;
if(!dsh){app.whenReady().then(()=>{dialog.showErrorBox('工作引擎未找到',local.bundledDshOnly?'内置工作引擎不完整，请重新解包 NEKOfuns。':'请先安装 DeepSeek Harness，再打开 NEKOfuns。');app.quit();});}
else {
  Object.assign(process.env,{
    NEKO_WORKBENCH_DATA_DIR:data,NEKO_WORKBENCH_WORKSPACE:workspace,
    NEKO_WORKBENCH_ELECTRON_USER_DATA:path.join(data,'electron'),
    NEKO_WORKBENCH_DSH_CLI:path.join(dsh.resources,'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'),
    NEKO_WORKBENCH_DSH_MODULES:path.join(dsh.resources,'app.asar/dsh/node_modules/@deepseek-ai'),
    NEKO_WORKBENCH_DSH_HOME:'',NEKO_WORKBENCH_DSH_PROFILE:'web',DSH_DESKTOP_NODE_EXECUTABLE:'',
    PET_OPEN_WORKBENCH:'1',PET_WORKBENCH_ONLY:''
  });
  const python=path.join(base,'memory-runtime/python.exe');
  if(fs.existsSync(python)){
    process.env.NEKO_WORKBENCH_MEMORY_PYTHON_DIRECT=python;
    process.env.NEKO_WORKBENCH_MEMORY_PYTHON_LIBS=path.join(base,'memory-python-libs');
  }
  process.env.PATH=path.join(base,'node')+path.delimiter+(process.env.PATH||'');
  app.setName('NEKOfuns');
  if(local.trialLabel){
    app.on('browser-window-created',(_event,window)=>{
      if(window.webContents.getLastWebPreferences().preload?.endsWith('workbench-preload.cjs'))window.on('page-title-updated',(event,title)=>{event.preventDefault();window.setTitle(title+' · '+String(local.trialLabel).slice(0,60));});
    });
  }
  require(path.join(process.resourcesPath,'workbench/apps/neko-workbench/main.cjs'));
}
