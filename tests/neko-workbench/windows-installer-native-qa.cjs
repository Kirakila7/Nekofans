'use strict';
// Opt-in installation smoke test. It uses a tiny official Node payload, its own
// HKCU identity and Start-menu folder, and never opens a workbench/user profile.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),workspace=path.dirname(root),buildRoot=path.join(workspace,'.neko-windows-build');
const powerShell=path.join(process.env.WINDIR||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const reg=path.join(process.env.WINDIR||'C:/Windows','System32/reg.exe');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,label){for(let i=0;i<150;i++){if(predicate())return;await delay(100);}throw Error('Timed out: '+label);}
const query=key=>spawnSync(reg,['query',key,'/reg:64'],{encoding:'utf8',windowsHide:true});
const run=(file,args,extra={})=>{const result=spawnSync(file,args,{encoding:'utf8',windowsHide:true,timeout:30000,...extra});if(result.error)throw result.error;return result;};
async function main(){
 if(process.platform!=='win32'||process.env.NEKO_INSTALLER_NATIVE_QA!=='1')throw Error('Windows native QA requires explicit NEKO_INSTALLER_NATIVE_QA=1; this test installs only an isolated synthetic application');
 const {packageWindowsInstaller}=await import('../../scripts/windows-installer.mjs');
 const toolReceipt=path.join(buildRoot,'tools/NSIS_TOOL_RECEIPT.json'),tool=JSON.parse(fs.readFileSync(toolReceipt,'utf8').replace(/^\uFEFF/,''));
 fs.mkdirSync(buildRoot,{recursive:true});
 const dir=fs.mkdtempSync(path.join(buildRoot,'installer-native-')),id='NEKOfuns-QA-'+path.basename(dir),install=path.join(dir,'installed'),profile=path.join(dir,'synthetic-user-projects');
 const registry='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+id;
 const menuResult=run(powerShell,['-NoLogo','-NoProfile','-NonInteractive','-Command',"[Environment]::GetFolderPath('Programs')"]);assert.equal(menuResult.status,0,menuResult.stderr);
 const menu=path.join(menuResult.stdout.trim(),id);assert(!fs.existsSync(menu));assert.notEqual(query(registry).status,0,'QA identity must be new');
 fs.mkdirSync(profile);fs.writeFileSync(path.join(profile,'keep.txt'),'synthetic project outside installation');
 const checks=[];let task;
 try{
  function compile(version,revision){
   const application=path.join(dir,'payload-'+revision),output=path.join(dir,'package-'+revision);fs.mkdirSync(application);fs.mkdirSync(output);
   fs.copyFileSync(process.execPath,path.join(application,'NEKOfuns.exe'));fs.mkdirSync(path.join(application,'assets/$sprite'),{recursive:true});fs.writeFileSync(path.join(application,'assets/$sprite/鱼.txt'),'revision-'+revision);
   fs.writeFileSync(path.join(application,revision===1?'old-owned.txt':'new-owned.txt'),'owned-'+revision);
   const names=['NEKOfuns.exe','assets/$sprite/鱼.txt',revision===1?'old-owned.txt':'new-owned.txt'];
   const integrity=Object.fromEntries(names.map(name=>[name,digest(path.join(application,name))]));
   const args=['--nsis-compiler',tool.compiler,'--nsis-receipt',toolReceipt,'--installer-test-id',id,'--installer-install-dir',path.join(dir,'unselected-default'),'--installer-shortcut-group',id];
   return {integrity,...packageWindowsInstaller({root,release:{version,build:'1'},args,output,application,integrity,manifest:{sourceCommit:'a'.repeat(40),files:{}},local:{profileName:'NEKOfuns-QA-Never-Opened'}})};
  }
  const first=compile('1.2.3',1),occupied=path.join(dir,'occupied');fs.mkdirSync(occupied);fs.writeFileSync(path.join(occupied,'keep.txt'),'unrelated');
  assert.equal(run(first.exe,['/S','/D='+occupied],{windowsVerbatimArguments:true}).status,1603,'the final selected directory must be validated');
  assert.equal(fs.readFileSync(path.join(occupied,'keep.txt'),'utf8'),'unrelated');assert(!fs.existsSync(path.join(occupied,'.nekofuns-install-id')));assert.notEqual(query(registry).status,0);
  assert.equal(run(first.exe,['/S','/D='+install],{windowsVerbatimArguments:true}).status,0,'silent installation into a selected directory');
  assert(!fs.existsSync(path.join(dir,'unselected-default')),'installation must use the final directory rather than the initial default');
  checks.push('selected directory is revalidated before writing; unrelated nonempty directories are rejected');
  for(const [name,hash] of Object.entries(first.integrity))assert.equal(digest(path.join(install,name)),hash,name);
  assert.equal(query(registry).status,0);for(const name of ['NEKOfuns.lnk','卸载 NEKOfuns.lnk'])assert(fs.existsSync(path.join(menu,name)),name);
  checks.push('isolated per-user installation, Unicode/dollar paths, HKCU uninstall and Start-menu shortcuts');
  fs.mkdirSync(path.join(install,'my-project'));fs.writeFileSync(path.join(install,'my-project/keep.txt'),'unknown file must survive');
  const second=compile('1.2.4',2);
  task=spawn(path.join(install,'NEKOfuns.exe'),['-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit(0));console.log('QA_READY')"],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Synthetic Node task did not start')),10000);task.once('error',reject);task.stdout.on('data',data=>{text+=data;if(text.includes('QA_READY')){clearTimeout(timer);resolve();}});task.once('exit',code=>reject(Error('Synthetic Node task exited early: '+code)));});
  assert.equal(run(second.exe,['/S','/D='+install],{windowsVerbatimArguments:true}).status,1618,'upgrade must wait for a running task');
  assert.equal(task.exitCode,null,'installer must not terminate the task');
  const blockedUninstall=run(path.join(install,'Uninstall.exe'),['/S','_?='+install],{windowsVerbatimArguments:true});
  assert.equal(blockedUninstall.status,1618,'uninstall must wait for a running task');assert.equal(task.exitCode,null);
  task.stdin.end();await new Promise(resolve=>task.once('exit',resolve));task=null;
  checks.push('running application blocks silent upgrade/uninstall without terminating its task');
  assert.equal(run(second.exe,['/S','/D='+install],{windowsVerbatimArguments:true}).status,0,'upgrade after closing task');
  for(const [name,hash] of Object.entries(second.integrity))assert.equal(digest(path.join(install,name)),hash,name);
  const managed=fs.readFileSync(path.join(install,'.nekofuns-managed-files'),'utf16le');
  for(const name of ['old-owned.txt','new-owned.txt','assets/$sprite/鱼.txt'])assert(managed.includes(name),'managed history keeps '+name);
  assert.equal(fs.readFileSync(path.join(install,'my-project/keep.txt'),'utf8'),'unknown file must survive');
  checks.push('upgrade preserves unknown files and updates only managed payload');
  assert.equal(run(path.join(install,'Uninstall.exe'),['/S']).status,0,'standard uninstall launcher');
  await waitFor(()=>query(registry).status!==0&&!fs.existsSync(path.join(install,'Uninstall.exe')),'native uninstall to finish');
  for(const name of new Set([...Object.keys(first.integrity),...Object.keys(second.integrity)]))assert(!fs.existsSync(path.join(install,name)),name+' removed');
  assert(!fs.existsSync(menu));assert.equal(fs.readFileSync(path.join(install,'my-project/keep.txt'),'utf8'),'unknown file must survive');assert.equal(fs.readFileSync(path.join(profile,'keep.txt'),'utf8'),'synthetic project outside installation');
  checks.push('uninstall removes managed files/registry/shortcuts and keeps projects/unknown files');
  const receipt={ok:true,kind:'native-isolated-synthetic-installer-qa',directory:dir,identity:id,checks,realWorkbenchLaunched:false,realAccountsRead:false};
  fs.writeFileSync(path.join(dir,'NATIVE_QA_RECEIPT.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
 }finally{if(task){task.stdin.end();await Promise.race([new Promise(resolve=>task.once('exit',resolve)),delay(5000)]);}}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
