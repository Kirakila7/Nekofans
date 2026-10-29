const path=require('node:path');
const {app}=require('electron');
const out=path.resolve(process.resourcesPath,'../../..');
const data=path.join(app.getPath('appData'),'N.E.K.O. Workbench');
let linkedProject=null;
try{const value=JSON.parse(require('node:fs').readFileSync(path.join(data,'workbench-project.json'),'utf8'));if(typeof value.root==='string'&&path.isAbsolute(value.root)&&require('node:fs').statSync(value.root).isDirectory())linkedProject=value.root;}catch{}
process.env.PATH=[path.join(app.getPath('home'),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin',process.env.PATH||'/usr/bin:/bin'].join(path.delimiter);
const memoryPython=path.join(data,'runtime/neko-memory',process.platform==='win32'?'Scripts/python.exe':'bin/python');
if(require('node:fs').existsSync(memoryPython))process.env.NEKO_WORKBENCH_MEMORY_PYTHON=memoryPython;
Object.assign(process.env,{
 NEKO_WORKBENCH_DATA_DIR:data,
 NEKO_WORKBENCH_ELECTRON_USER_DATA:path.join(data,'electron'),
 NEKO_WORKBENCH_WORKSPACE:linkedProject||path.join(app.getPath('documents'),'ChatGPT','猫娘计划','workspaces','NEKO工作台'),
 NEKO_WORKBENCH_DSH_HOME:path.join(app.getPath('home'),'.dsh'),
 NEKO_WORKBENCH_DSH_PROFILE:'desktop',
 PET_OPEN_WORKBENCH:'1',PET_WORKBENCH_ONLY:'0'
});
delete process.env.ELECTRON_RUN_AS_NODE;
const {execFileSync}=require('node:child_process');
const sharedProfile=path.join(app.getPath('home'),'.dsh/profiles/desktop');
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
