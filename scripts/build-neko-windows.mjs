import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,statSync,openSync,readSync,writeSync,closeSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {packageWindowsInstaller} from './windows-installer.mjs';

const run=(command,args,options={})=>{const r=spawnSync(command,args,{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,...options});if(r.status!==0)throw Error(r.stderr||r.stdout||r.error?.message||'Build command failed');return r.stdout;};
function sha(file){const hash=createHash('sha256'),fd=openSync(file,'r'),buffer=Buffer.allocUnsafe(1024*1024);try{let n;while((n=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));}finally{closeSync(fd);}return hash.digest('hex');}
function inventory(dir,prefix=''){return readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{if(e.isSymbolicLink())throw Error('Package links are not supported');const rel=prefix?prefix+'/'+e.name:e.name;return e.isDirectory()?inventory(join(dir,e.name),rel):[rel];});}
export async function buildWindowsDaily({root,release,args}){
  const value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  const required=name=>{const v=value(name);if(!v)throw Error('Missing '+name);return resolve(v);};
  const output=required('--output');
  const format=value('--package-format')||'installer';
  if(!['installer','portable'].includes(format))throw Error('Invalid --package-format (installer or portable)');
  const sourceRoot=value('--source-root')?resolve(value('--source-root')):root;
  const sourceManifest=value('--source-manifest')?JSON.parse(readFileSync(resolve(value('--source-manifest')),'utf8')):null;
  if(sourceRoot!==root&&(!sourceManifest||!Array.isArray(sourceManifest.files)||! /^[a-f0-9]{40}$/.test(sourceManifest.sourceCommit)))throw Error('A separate source root requires a pinned source manifest');
  if(args.includes('--resume-package')){
    const manifest=JSON.parse(readFileSync(join(output,'application/resources/WORKBENCH_BUILD.json'),'utf8'));
    if(manifest.version!==release.version||String(manifest.build)!==String(release.build))throw Error('Staged application version changed; restage before packaging');
    if(sourceManifest&&sourceManifest.sourceCommit!==manifest.sourceCommit)throw Error('Staged source revision changed');
    const integrity=JSON.parse(readFileSync(join(output,'APPLICATION_SHA256.json'),'utf8'));
    if(inventory(join(output,'application')).length!==Object.keys(integrity).length)throw Error('Unexpected files in staged application');
    for(const [name,expected] of Object.entries(integrity))if(sha(join(output,'application',name))!==expected)throw Error('Staged file changed: '+name);
    return packageWindowsStage({root,release,args,output});
  }
  const electron=required('--electron-dir'),node=required('--node-dir');
  if(existsSync(output))throw Error('Refusing to overwrite existing output');
  for(const file of [join(electron,'electron.exe'),join(node,'node.exe')])if(!existsSync(file))throw Error('Missing runtime: '+file);
  for(const input of [root,sourceRoot,electron,node]){const rel=relative(input,output);if(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\'))throw Error('Output must be outside input trees');}
  const dir=join(output,'application');mkdirSync(dir,{recursive:true});
  cpSync(electron,dir,{recursive:true,filter:src=>!src.endsWith('default_app.asar')&&!/\.(?:log|dmp|dpapi|sqlite)$/i.test(src)});
  renameSync(join(dir,'electron.exe'),join(dir,'NEKOfuns.exe'));
  mkdirSync(join(dir,'node'),{recursive:true});
  for(const name of ['node.exe','LICENSE'])if(existsSync(join(node,name)))cpSync(join(node,name),join(dir,'node',name));
  // QQ's official adapter installs its dependencies through npm-cli.js.
  // Keep the npm bundled by the verified Node distribution, including its
  // nested dependencies and licenses; node.exe alone is insufficient.
  let bundledNpm=null;
  const npmRoot=join(node,'node_modules/npm');
  if(existsSync(npmRoot)){
    const npm=JSON.parse(readFileSync(join(npmRoot,'package.json'),'utf8'));
    if(npm.name!=='npm'||typeof npm.version!=='string'||!/^\d+\.\d+\.\d+/.test(npm.version)||!existsSync(join(npmRoot,'bin/npm-cli.js')))throw Error('Incomplete bundled npm in Node runtime');
    cpSync(npmRoot,join(dir,'node/node_modules/npm'),{recursive:true});
    bundledNpm={version:npm.version,cli:'node/node_modules/npm/bin/npm-cli.js'};
  }
  for(const [flag,name] of [['--memory-runtime','memory-runtime'],['--memory-python-libs','memory-python-libs']]){
    const source=value(flag);if(source)cpSync(resolve(source),join(dir,name),{recursive:true,filter:src=>!src.split(/[\\/]/).some(p=>['__pycache__','.git'].includes(p))&&!/\.(?:pyc|log)$/i.test(src)});
  }
  const dshResources=value('--dsh-resources')?resolve(value('--dsh-resources')):null;
  if(dshResources){
    for(const name of ['app.asar','app.asar.unpacked','runtime/primary-runtime','runtime/office-skills'])if(!existsSync(join(dshResources,name)))throw Error('Incomplete bundled DSH: '+name);
    const dshTarget=join(dir,'resources/dsh');mkdirSync(dshTarget,{recursive:true});
    for(const name of ['app.asar','app.asar.unpacked','runtime'])cpSync(join(dshResources,name),join(dshTarget,name),{recursive:true,filter:src=>!src.split(/[\\/]/).some(p=>['.git','__pycache__'].includes(p))&&!/\.(?:log|dmp|dpapi|sqlite)$/i.test(src)});
    writeFileSync(join(dshTarget,'RUNTIME_ORIGIN.json'),JSON.stringify({product:'DeepSeek Harness',version:value('--dsh-version')||'unknown',archiveSha256:sha(join(dshTarget,'app.asar')),bundledSupport:['app.asar.unpacked','runtime/primary-runtime','runtime/office-skills']},null,2)+'\n');
  }
  const destination=join(dir,'resources/workbench'),tracked=sourceManifest?.files||run('git',['ls-files','-z'],{cwd:root}).split('\0').filter(Boolean);
  const files=tracked.filter(p=>p.startsWith('apps/neko-workbench/')||p.startsWith('packages/')||p.startsWith('config/')||p.startsWith('services/neko-memory/'));
  // Include the new bootstrap even before its first commit.
  const packagingFiles=['apps/neko-workbench/windows-bootstrap.cjs','apps/neko-workbench/windows-dsh-runtime.cjs'];
  files.push(...packagingFiles);
  // New local UI modules must ship even before their first source commit.
  for(const name of ['video-float-controller.cjs','video-float-preload.cjs','video-float.html','video-float.css','video-float.js']){
    const file='apps/neko-workbench/'+name;if(existsSync(join(sourceRoot,file)))files.push(file);
  }
  const hashes={};for(const file of [...new Set(files)].sort()){
    if(isAbsolute(file)||file.split(/[\\/]/).some(p=>['..','.git','.venv','node_modules'].includes(p))||/^(?:apps\/neko-workbench|services\/neko-memory)\/(?:data|workspaces|logs)\//.test(file)||/(?:^|\/)\.env(?:\.|$)|\.(?:dpapi|log|sqlite|key)$/i.test(file))throw Error('Private file in source selection: '+file);
    const source=join(packagingFiles.includes(file)?root:sourceRoot,file),target=join(destination,file);mkdirSync(dirname(target),{recursive:true});cpSync(source,target,{verbatimSymlinks:true});hashes[file]=sha(source);
  }
  const entry=join(dir,'resources/app');mkdirSync(entry,{recursive:true});
  cpSync(join(root,'apps/neko-workbench/windows-bootstrap.cjs'),join(entry,'bootstrap.cjs'));
  writeFileSync(join(entry,'package.json'),JSON.stringify({name:'nekofans-workbench',productName:'Nekofans',version:release.version,main:'bootstrap.cjs',private:true},null,2)+'\n');
  const local={};for(const [flag,key] of [['--data-dir','dataDir'],['--workspace-dir','workspaceDir']])if(value(flag))local[key]=resolve(value(flag));
  if(value('--profile-name'))local.profileName=value('--profile-name');
  if(value('--trial-label'))local.trialLabel=value('--trial-label');
  if(dshResources)local.bundledDshOnly=true;
  if(Object.keys(local).length)writeFileSync(join(dir,'NEKOfuns.local.json'),JSON.stringify(local,null,2)+'\n');
  const commit=sourceManifest?.sourceCommit||run('git',['rev-parse','HEAD'],{cwd:root}).trim();
  const manifest={version:release.version,build:release.build,platform:'win32-x64',sourceCommit:commit,sourceVariant:sourceManifest?.variant||'local',sourcePullRequest:sourceManifest?.pullRequest||null,packagingAdditions:packagingFiles,bundledDsh:dshResources?{version:value('--dsh-version')||'unknown',archiveSha256:sha(join(dir,'resources/dsh/app.asar'))}:null,bundledNpm,localChanges:run('git',['status','--porcelain'],{cwd:root}).trim().split('\n').filter(Boolean),builtAt:new Date().toISOString(),electronSha256:sha(join(dir,'NEKOfuns.exe')),nodeSha256:sha(join(dir,'node/node.exe')),files:hashes};
  writeFileSync(join(dir,'resources/WORKBENCH_BUILD.json'),JSON.stringify(manifest,null,2)+'\n');
  // Inventory the entire shipped application, including cached official runtimes.
  const integrity={};for(const file of inventory(dir)){
    if(/(?:^|\/)(?:\.env(?:\..*)?|credentials\.yaml|dsh-pets\.json)$|\.(?:dpapi|sqlite|log)$/i.test(file))throw Error('Private file in application: '+file);
    integrity[file]=sha(join(dir,file));
  }
  writeFileSync(join(output,'APPLICATION_SHA256.json'),JSON.stringify(integrity,null,2)+'\n');
  return packageWindowsStage({root,release,args,output});
}
function packageWindowsStage({root,release,args,output}){
  const value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  const dir=join(output,'application'),manifest=JSON.parse(readFileSync(join(dir,'resources/WORKBENCH_BUILD.json'),'utf8'));
  const commit=manifest.sourceCommit,hashes=manifest.files,dshResources=!!manifest.bundledDsh;
  const integrity=JSON.parse(readFileSync(join(output,'APPLICATION_SHA256.json'),'utf8'));
  const local=existsSync(join(dir,'NEKOfuns.local.json'))?JSON.parse(readFileSync(join(dir,'NEKOfuns.local.json'),'utf8')):{};
  if(args.includes('--stage-only')){
    const receipt={kind:'stage',application:dir,sourceCommit:commit,sourceFiles:Object.keys(hashes).length,applicationFiles:Object.keys(integrity).length};
    console.log(JSON.stringify(receipt));return receipt;
  }
  if((value('--package-format')||'installer')==='installer')return packageWindowsInstaller({root,release,args,output,application:dir,manifest,integrity,local});
  // Explicit legacy compatibility only. New releases use the standard installer.
  const payload=join(output,'payload-'+Date.now()+'.zip');
  console.log(JSON.stringify({phase:'compressing',files:Object.keys(integrity).length,sourceFiles:Object.keys(hashes).length}));
  const python=value('--archive-python')||join(dir,'memory-runtime/python.exe');
  if(!existsSync(python))throw Error('Archive creation requires --archive-python or the bundled Python runtime');
  run(python,['-I','-B',join(root,'scripts/windows-package-archive.py'),dir,payload]);
  const csc=join(process.env.WINDIR||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const stub=join(output,'launcher.exe');
  run(csc,['/nologo','/target:winexe','/platform:x64','/optimize+','/reference:System.Windows.Forms.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll','/out:'+stub,join(root,'scripts/windows-portable-launcher.cs')]);
  const filename=value('--artifact-name')||'Nekofans-'+release.version+'-Windows-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'.exe';
  if(filename.includes('/')||filename.includes('\\')||!filename.endsWith('.exe'))throw Error('Invalid artifact filename');
  const exe=join(output,filename);
  const target=openSync(exe,'wx');try{for(const file of [stub,payload]){const input=openSync(file,'r'),buffer=Buffer.allocUnsafe(1024*1024);try{let n;while((n=readSync(input,buffer,0,buffer.length,null))>0)writeSync(target,buffer,0,n);}finally{closeSync(input);}}const footer=Buffer.alloc(48);footer.write('NEKOSFX1',0,'ascii');footer.writeBigInt64LE(BigInt(statSync(payload).size),8);Buffer.from(sha(payload),'hex').copy(footer,16);writeSync(target,footer);}finally{closeSync(target);}
  const receipt={exe,bytes:statSync(exe).size,sha256:sha(exe),sourceCommit:commit,sourceFiles:Object.keys(hashes).length,applicationFiles:Object.keys(integrity).length};
  writeFileSync(join(output,'BUILD_RECEIPT.json'),JSON.stringify(receipt,null,2)+'\n');
  writeFileSync(join(output,'使用说明.txt'),'Nekofans '+release.version+' Windows'+(local.trialLabel?' · '+local.trialLabel:'')+'\r\n\r\n双击 '+filename+' 启动。首次会解包程序，之后直接打开。\r\n'+(dshResources?'已内置 DSH、工具依赖、Node 和记忆运行环境，无需单独安装 DSH。账号登录仍在工作台中进行。':'需要本机已安装 DeepSeek Harness。程序包含 Node 和记忆运行环境。')+'\r\n'+(local.profileName?'试用版使用独立存档，不替换日常工作台。':'本机配置只引用现有聊天数据和工作区。')+'程序包不包含聊天记录、账号凭据或用户文件。\r\n来源提交：'+commit+'（附加清单内的 Windows 打包入口）\r\n');
  console.log(JSON.stringify(receipt));return receipt;
}
