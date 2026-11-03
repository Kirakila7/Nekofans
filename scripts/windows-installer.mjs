import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {closeSync,existsSync,lstatSync,openSync,readFileSync,readSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve,toNamespacedPath} from 'node:path';

export const NSIS_VERSION='3.13';
export const NSIS_ARCHIVE_SHA256='ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8';
const sha=file=>{const hash=createHash('sha256'),fd=openSync(file,'r'),buffer=Buffer.allocUnsafe(1024*1024);try{let length;while((length=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,length));}finally{closeSync(fd);}return hash.digest('hex');};
const value=(args,name)=>{const index=args.indexOf(name);return index<0?null:args[index+1];};
const inventory=(dir,prefix='')=>readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
  if(entry.isSymbolicLink())throw Error('Installer input cannot contain links');
  const name=prefix?prefix+'/'+entry.name:entry.name;
  return entry.isDirectory()?inventory(join(dir,entry.name),name):[name];
});
export function nsisLiteral(value){
  if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value)||value.includes('${'))throw Error('Invalid installer text');
  return '"'+value.replaceAll('$',()=> '$$').replaceAll('"',()=> '$\\"')+'"';
}
function compilerLiteral(value){
  if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value)||value.includes('${'))throw Error('Invalid installer compiler path');
  // File/OutFile/!include consume compile-time paths; $$ there is literally two
  // dollars. Only runtime instructions such as SetOutPath use nsisLiteral.
  return '"'+value.replaceAll('"',()=> '$\\"')+'"';
}
const relativeFile=name=>typeof name==='string'&&name&&!isAbsolute(name)&&!name.includes('\\')&&!name.split('/').some(part=>!part||part==='.'||part==='..')&&!/[\x00-\x1f\x7f:*?"<>|]/.test(name);

export function installerOptions({args,release}){
  const testId=value(args,'--installer-test-id'),testRoot=value(args,'--installer-install-dir'),testGroup=value(args,'--installer-shortcut-group');
  if((testRoot||testGroup)&&!testId)throw Error('Isolated installer location/group require --installer-test-id');
  if(testId&&(!/^NEKOfuns-QA-[A-Za-z0-9_-]{1,64}$/.test(testId)||!testRoot||!isAbsolute(testRoot)||!testGroup||!/^NEKOfuns-QA-[A-Za-z0-9 _-]{1,64}$/.test(testGroup)))throw Error('Invalid isolated installer settings');
  const filename=value(args,'--artifact-name')||'Nekofans-'+release.version+'-Setup.exe';
  if(basename(filename)!==filename||!filename.endsWith('.exe')||/[\x00-\x1f\x7f:*?"<>|\\/]/.test(filename))throw Error('Invalid installer artifact filename');
  if(!/^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9.-]+)?$/.test(release.version)||!/^\d+$/.test(String(release.build)))throw Error('Invalid installer version');
  const numeric=release.version.split(/[.-]/).slice(0,3).map(Number),build=Number(release.build);
  if([...numeric,build].some(n=>!Number.isInteger(n)||n<0||n>65535))throw Error('Installer version fields must fit a Windows version');
  return {appId:testId||'NEKOfuns-Workbench',group:testGroup||'NEKOfuns',displayName:testId?'Nekofans · 隔离验收':'Nekofans',installRoot:testRoot?resolve(testRoot):null,desktopShortcut:!testId&&!args.includes('--no-desktop-shortcut'),filename,numericVersion:[...numeric,build].join('.'),testMode:!!testId};
}

export function verifyInstallerInput(application,integrity){
  const names=Object.keys(integrity).sort();
  if(!names.includes('NEKOfuns.exe')||!names.length)throw Error('Installer payload has no application executable');
  if(names.some(name=>!relativeFile(name)))throw Error('Unsafe installer payload path');
  if(names.some(name=>/(?:^|\/)(?:\.env(?:\..*)?|credentials\.yaml|dsh-pets\.json)$|\.(?:dpapi|sqlite|log)$/i.test(name)))throw Error('Private runtime data in installer payload');
  if(JSON.stringify(inventory(application).sort())!==JSON.stringify(names))throw Error('Installer payload inventory changed');
  for(const name of names)if(!/^[a-f0-9]{64}$/.test(integrity[name])||sha(join(application,name))!==integrity[name])throw Error('Installer payload changed: '+name);
  return names;
}

export function verifyNsisTool(compiler,receiptFile){
  if(!compiler||!receiptFile)throw Error('Installer requires --nsis-compiler and --nsis-receipt from the verified official NSIS portable tool');
  const receipt=JSON.parse(readFileSync(receiptFile,'utf8').replace(/^\uFEFF/,'')),toolRoot=dirname(resolve(compiler));
  if(receipt.version!==NSIS_VERSION||receipt.archiveSha256!==NSIS_ARCHIVE_SHA256||receipt.officialPublishedSha256!==NSIS_ARCHIVE_SHA256||receipt.compilerSha256!==sha(compiler)||resolve(receipt.compiler)!==resolve(compiler)||!receipt.files||typeof receipt.files!=='object')throw Error('NSIS tool receipt does not match the official compiler');
  if(!Object.keys(receipt.files).length)throw Error('NSIS tool receipt has no file inventory');
  if(!receipt.archive||!existsSync(receipt.archive)||sha(receipt.archive)!==NSIS_ARCHIVE_SHA256)throw Error('Official NSIS archive is unavailable or changed');
  for(const [name,hash] of Object.entries(receipt.files)){
    if(!relativeFile(name)||!existsSync(join(toolRoot,name))||lstatSync(join(toolRoot,name)).isSymbolicLink()||sha(join(toolRoot,name))!==hash)throw Error('Verified NSIS tool changed: '+name);
  }
  return {version:receipt.version,archiveSha256:receipt.archiveSha256,compilerSha256:receipt.compilerSha256,source:receipt.source};
}

export function generateInstallerFiles({root,output,application,release,integrity,args}){
  const options=installerOptions({args,release}),names=verifyInstallerInput(application,integrity),exe=join(output,options.filename);
  if(existsSync(exe))throw Error('Refusing to overwrite an existing installer');
  const script=join(output,'NEKOfuns-installer.nsi'),files=join(output,'NEKOfuns-installer-files.nsh');
  let folder=null;const body=[];
  for(const name of names){
    const parent=name.includes('/')?name.slice(0,name.lastIndexOf('/')):'';
    if(parent!==folder){folder=parent;const target='"$INSTDIR'+(parent?'\\'+parent.replaceAll('/','\\').replaceAll('$',()=> '$$'):'')+'"';body.push('Push '+target,'Call CheckSafePath','${If} $SafePath != 1','Goto install_failed','${EndIf}','SetOutPath '+target);}
    body.push('Push "$INSTDIR\\'+name.replaceAll('/','\\').replaceAll('$',()=> '$$')+'"','Call CheckSafePath','${If} $SafePath != 1','Goto install_failed','${EndIf}');
    // makensis itself can use legacy-length Win32 paths even though the
    // generated installer is long-path-aware. Keep the complete payload and
    // explicitly address its source files through the Win32 namespace.
    body.push('FileWriteUTF16LE $ManagedLog '+nsisLiteral(name)+'\nFileWriteUTF16LE $ManagedLog "$\\r$\\n"','IfErrors install_failed','File '+compilerLiteral(toNamespacedPath(join(application,name))),'IfErrors install_failed');
  }
  writeFileSync(files,'\uFEFF'+body.join('\n')+'\n');
  const definitions={NEKO_APP_ID:options.appId,NEKO_DISPLAY_NAME:options.displayName,NEKO_GROUP:options.group,NEKO_VERSION:release.version,NEKO_NUMERIC_VERSION:options.numericVersion};
  const lines=['# -*- coding: utf-8 -*-'];for(const [key,text] of Object.entries(definitions))lines.push('!define '+key+' '+nsisLiteral(text));
  lines.push('!define NEKO_OUTPUT '+compilerLiteral(exe),'!define NEKO_FILES_INCLUDE '+compilerLiteral(files));
  lines.push('!define NEKO_INSTALL_ROOT '+(options.installRoot?nsisLiteral(options.installRoot):'"$LOCALAPPDATA\\Programs\\NEKOfuns"'));
  if(options.desktopShortcut)lines.push('!define NEKO_DESKTOP_SHORTCUT');
  lines.push('!define NEKO_ESTIMATED_KB '+Math.ceil(names.reduce((n,name)=>n+statSync(join(application,name)).size,0)/1024));
  lines.push('!include '+compilerLiteral(join(root,'scripts/windows-installer.nsi')));
  writeFileSync(script,'\uFEFF'+lines.join('\n')+'\n');
  return {...options,script,files,exe,payloadFiles:names.length};
}

export function packageWindowsInstaller({root,release,args,output,application,manifest,integrity,local={}}){
  const compiler=value(args,'--nsis-compiler'),receiptFile=value(args,'--nsis-receipt'),tool=verifyNsisTool(compiler,receiptFile);
  const generated=generateInstallerFiles({root,output,application,release,integrity,args});
  const result=spawnSync(resolve(compiler),['/NOCONFIG','/NOCD','/V2',generated.script],{cwd:output,windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,NSISDIR:dirname(resolve(compiler))}});
  writeFileSync(join(output,'NSIS_BUILD.log'),(result.stdout||'')+(result.stderr||''));
  if(result.status!==0)throw Error(result.error?.message||result.stderr||result.stdout||'NSIS compiler failed');
  const receipt={kind:'installer',exe:generated.exe,bytes:statSync(generated.exe).size,sha256:sha(generated.exe),sourceCommit:manifest.sourceCommit,sourceFiles:Object.keys(manifest.files).length,applicationFiles:generated.payloadFiles,installer:{tool,...generated,profileName:local.profileName||null,uninstallPreservesUserData:true,runningProcessPolicy:'prompt-close-no-termination'}};
  writeFileSync(join(output,'BUILD_RECEIPT.json'),JSON.stringify(receipt,null,2)+'\n');
  writeFileSync(join(output,'使用说明.txt'),'Nekofans '+release.version+' Windows 安装版\r\n\r\n双击 '+generated.filename+'，选择安装位置后点击“安装”（默认当前用户的 Programs\\NEKOfuns）。安装后创建开始菜单'+(generated.desktopShortcut?'和桌面':'')+'快捷方式。无需管理员权限。\r\n升级或卸载前请自行关闭该安装目录里的工作台和任务；安装器不会强制结束任务。\r\n账号存档和项目目录保持现有位置，卸载默认保留；程序包不包含账号凭据、聊天记录或用户文件。\r\n静默安装：'+generated.filename+' /S；静默不会自动运行工作台。卸载请使用系统“已安装的应用”或开始菜单的卸载入口。\r\n来源提交：'+manifest.sourceCommit+'\r\n');
  console.log(JSON.stringify(receipt));return receipt;
}
