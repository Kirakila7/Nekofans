const path=require('node:path');
const {app}=require('electron');
const fs=require('node:fs');
const manifest=JSON.parse(fs.readFileSync(path.join(process.resourcesPath,'WORKBENCH_BUILD.json'),'utf8'));
const previewRoot=manifest.isolatedPreview===true?path.join(app.getPath('appData'),'Nekofans Game Preview'):null;
const data=previewRoot?path.join(previewRoot,'data'):path.join(app.getPath('appData'),'N.E.K.O. Workbench');
const dshHome=previewRoot?path.join(previewRoot,'dsh'):path.join(app.getPath('home'),'.dsh');
let linkedProject=null;
if(!previewRoot)try{const value=JSON.parse(fs.readFileSync(path.join(data,'workbench-project.json'),'utf8'));if(typeof value.root==='string'&&path.isAbsolute(value.root)&&fs.statSync(value.root).isDirectory())linkedProject=value.root;}catch{}
process.env.PATH=[path.join(app.getPath('home'),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin',process.env.PATH||'/usr/bin:/bin'].join(path.delimiter);
const memoryPython=path.join(data,'runtime/neko-memory',process.platform==='win32'?'Scripts/python.exe':'bin/python');
if(fs.existsSync(memoryPython))process.env.NEKO_WORKBENCH_MEMORY_PYTHON=memoryPython;
Object.assign(process.env,{
 NEKO_WORKBENCH_DATA_DIR:data,
 NEKO_WORKBENCH_ELECTRON_USER_DATA:path.join(data,'electron'),
 NEKO_WORKBENCH_WORKSPACE:previewRoot?path.join(previewRoot,'workspaces'):linkedProject||path.join(app.getPath('documents'),'ChatGPT','猫娘计划','workspaces','NEKO工作台'),
 NEKO_WORKBENCH_DSH_HOME:dshHome,
 NEKO_WORKBENCH_DSH_PROFILE:'desktop',
 PET_OPEN_WORKBENCH:'1',PET_WORKBENCH_ONLY:previewRoot?'1':'0'
});
delete process.env.ELECTRON_RUN_AS_NODE;
const {execFileSync}=require('node:child_process');
const sharedProfile=path.join(dshHome,'profiles/desktop');
const {sharedProfileStatus,waitForSharedProfile,claimWorkbenchInstance,queueEarlyInstanceNotifications}=require(path.join(process.resourcesPath,'workbench/apps/neko-workbench/startup-conflict.cjs'));
const readProcesses=()=>execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'});
const locked=claimWorkbenchInstance(app,process.env.NEKO_WORKBENCH_ELECTRON_USER_DATA);
if(!locked)app.quit();
else {
  globalThis.__nekoTrialInstanceLocked=true;
  const early=queueEarlyInstanceNotifications(app);
  const start=()=>{require(path.join(process.resourcesPath,'workbench/apps/neko-workbench/main.cjs'));early.forward();};
  if(sharedProfileStatus(readProcesses,sharedProfile)==='free')start();
  else app.whenReady().then(async()=>{
    if(await waitForSharedProfile({readProcesses,sharedProfile,showMessageBox:options=>require('electron').dialog.showMessageBox(options)}))start();
    else { early.discard(); app.releaseSingleInstanceLock(); app.quit(); }
  }).catch(()=>{early.discard();app.releaseSingleInstanceLock();app.quit();});
}
