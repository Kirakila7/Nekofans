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
const processes=execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n');
const busy=processes.some(line=>line.includes('dsh-desktop-host/lib/index.js')&&line.includes(sharedProfile)||line.includes('dsh-desktop-host/lib/cli.js --profile desktop')||line.includes('/dsh-shared-desktop-host.cjs'));
if(busy){app.whenReady().then(async()=>{await require('electron').dialog.showMessageBox({type:'info',message:'请先退出原版 DSH 或另一个共享配置的工作台',detail:'此版本直接共用你的账号、插件和会话。正常退出原版后，再打开本应用。',buttons:['好']});app.quit();});}
else require(path.join(process.resourcesPath,'workbench/apps/neko-workbench/main.cjs'));
