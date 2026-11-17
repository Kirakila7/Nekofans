import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync,chmodSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gameRuntimeFiles as gameServiceRuntimeFiles} from './neko-game-runtime-files.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const release=JSON.parse(readFileSync(join(root,'config/daily-release.json'),'utf8'));
function run(command,args,options={}){const r=spawnSync(command,args,{encoding:'utf8',...options});if(r.status!==0)throw Error(r.stderr||'Build command failed: '+command);return r.stdout;}
const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const gameRuntimeFiles=['apps/neko-workbench/game-account-contract.cjs','apps/neko-workbench/lobby-agent-bridge.cjs','apps/neko-workbench/private-game-runtime.cjs','apps/neko-workbench/private-own-rule-store.cjs','apps/neko-workbench/private-agent-session.cjs','apps/neko-workbench/companion-account-provider.cjs','apps/neko-workbench/prototype-model-relay.cjs',...gameServiceRuntimeFiles];
if(process.platform==='win32'){
  const {buildWindowsDaily}=await import('./build-neko-windows.mjs');
  await buildWindowsDaily({root,release,args,gameRuntimeFiles});
  process.exit(0);
}
const runtime=value('--electron-zip'),output=value('--output');
const baseCommit=value('--base-source-commit');
const dshApp=value('--dsh-app'),dshInstaller=value('--dsh-installer'),dshExpected=value('--dsh-installer-sha256'),dshLicenses=value('--dsh-license-dir');
const retainedManifestPath=value('--retain-manifest'),reuseDshFrom=value('--reuse-dsh-from');
const manifestOnly=args.includes('--manifest-only');
if(manifestOnly&&(!retainedManifestPath||baseCommit))throw Error('Manifest-only build requires a retained manifest and no base commit');
if([dshApp,dshInstaller,dshExpected,dshLicenses].some(Boolean)&&![dshApp,dshInstaller,dshExpected,dshLicenses].every(Boolean))throw Error('DSH packaging requires --dsh-app, --dsh-installer, --dsh-installer-sha256 and --dsh-license-dir');
if(reuseDshFrom&&dshApp)throw Error('Choose either a verified installed DSH bundle or the original installer inputs');
if(baseCommit&&!/^[0-9a-f]{40}$/.test(baseCommit))throw Error('Invalid base source commit');
if(!runtime||!output)throw Error('Usage: node scripts/build-neko-daily.mjs --electron-zip <official cached runtime.zip> --output <new staging directory>');
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('The current daily build targets darwin-arm64.');
const stage=resolve(output);if(existsSync(stage))throw Error('Refusing to overwrite an existing release directory.');mkdirSync(stage,{recursive:true});
run('/usr/bin/ditto',['-x','-k',resolve(runtime),stage]);
const app=join(stage,release.appName);renameSync(join(stage,'Electron.app'),app);
const resources=join(app,'Contents/Resources'),destination=join(resources,'workbench');mkdirSync(destination,{recursive:true});
// A separately supplied base commit permits building a reviewed working tree
// without modifying an existing checkout's index. Record actual file hashes
// and differences; the base commit alone does not identify these changes.
const baseEntries=baseCommit?run('git',['ls-tree','-r','-z',baseCommit],{cwd:root}).split('\0').filter(Boolean).map(row=>{const i=row.indexOf('\t'),head=row.slice(0,i).split(' ');if(i<0||head[1]!=='blob')throw Error('Unsupported source tree entry');return {name:row.slice(i+1),sha:head[2]};}):null;
const tracked=manifestOnly?[]:baseEntries?baseEntries.map(x=>x.name):run('git',['ls-files','-z'],{cwd:root}).split('\0').filter(Boolean);
const files=tracked.filter(p=>p.startsWith('apps/neko-workbench/')||p.startsWith('packages/')||p.startsWith('config/')||p.startsWith('services/neko-memory/')||p==='scripts/install-neko-daily.cjs');
for(const name of gameRuntimeFiles)if(!files.includes(name))files.push(name);
for(const name of ['community-social-client.cjs','community-oauth.cjs','community-friends.cjs','activity-memory.cjs']){
  const entry='apps/neko-workbench/'+name;
  if(!files.includes(entry))files.push(entry);
}
if(!files.includes('apps/neko-workbench/story-game-contract.cjs'))files.push('apps/neko-workbench/story-game-contract.cjs');
if(!files.includes('apps/neko-workbench/story-prototype-launcher.cjs'))files.push('apps/neko-workbench/story-prototype-launcher.cjs');
// Retain assets recorded by the installed build even when that build included
// reviewed files outside its base Git tree. Bytes are always read from root.
let previousManifest;
if(retainedManifestPath){
  const previous=previousManifest=JSON.parse(readFileSync(resolve(retainedManifestPath),'utf8'));
  if(previous.repository!==release.repository||!previous.files||typeof previous.files!=='object')throw Error('Installed source manifest does not match this repository');
  for(const name of Object.keys(previous.files)){
    if(name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'||['.venv','node_modules','.git'].includes(p))||name.startsWith('apps/neko-workbench/data/')||name.startsWith('apps/neko-workbench/workspaces/')||!(name.startsWith('apps/neko-workbench/')||name.startsWith('packages/')||name.startsWith('config/')||name.startsWith('services/neko-memory/')||gameRuntimeFiles.includes(name)||name==='scripts/install-neko-daily.cjs'))throw Error('Unsafe retained source path: '+name);
    if(!files.includes(name))files.push(name);
  }
}
// Include the local user-approved appearance even before it is committed to
// the release base, so the bundle and its source manifest stay in sync.
for(const name of ['apps/neko-workbench/assets/doubao-work/working.webp','apps/neko-workbench/assets/doubao-work/still.png','apps/neko-workbench/assets/doubao-work/SOURCE.json'])if(!files.includes(name))files.push(name);
const hashes={},sourceChanges=[],baseHashes=new Map((baseEntries||[]).map(x=>[x.name,x.sha]));for(const name of files){if(name.split('/').some(p=>['.venv','node_modules','.git'].includes(p))||name.startsWith('apps/neko-workbench/data/')||name.startsWith('apps/neko-workbench/workspaces/'))throw Error('Private runtime path in release: '+name);const source=join(root,name);if(!existsSync(source))throw Error('Missing tracked source: '+name);mkdirSync(dirname(join(destination,name)),{recursive:true});cpSync(source,join(destination,name),{verbatimSymlinks:true});const data=readFileSync(source);hashes[name]=createHash('sha256').update(data).digest('hex');if(baseCommit&&createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')!==baseHashes.get(name)||manifestOnly&&previousManifest.files[name]!==hashes[name])sourceChanges.push(name);}
const entry=join(resources,'app');mkdirSync(entry,{recursive:true});cpSync(join(root,'apps/neko-workbench/trial-bootstrap.cjs'),join(entry,'bootstrap.cjs'));
writeFileSync(join(entry,'package.json'),JSON.stringify({name:'neko-workbench-daily',version:release.version,main:'bootstrap.cjs'},null,2)+'\n');
run('/usr/bin/plutil',['-replace','CFBundleIdentifier','-string',release.bundleIdentifier,join(app,'Contents/Info.plist')]);
for(const [key,text] of [['CFBundleName','Nekofans'],['CFBundleDisplayName','Nekofans'],['CFBundleShortVersionString',release.version],['CFBundleVersion',release.build]])run('/usr/bin/plutil',['-replace',key,'-string',text,join(app,'Contents/Info.plist')]);
run('/usr/bin/plutil',['-insert','CFBundleURLTypes','-json',JSON.stringify([{CFBundleURLName:release.bundleIdentifier+'.game-invite',CFBundleURLSchemes:['nekofans']}]),join(app,'Contents/Info.plist')]);
// The app icon is a separately generated asset, included and hashed explicitly
// because a new local asset may not be present in the base commit's tree.
const iconSource=join(root,'apps/neko-workbench/assets/nekofuns-bigfish.icns');
if(!existsSync(iconSource))throw Error('Missing Big Fish macOS icon: '+iconSource);
cpSync(iconSource,join(resources,'bigfish-macos.icns'));
run('/usr/bin/plutil',['-replace','CFBundleIconFile','-string','bigfish-macos.icns',join(app,'Contents/Info.plist')]);
let embeddedDsh;
if(dshApp){
  const appPath=resolve(dshApp),installerSha256=createHash('sha256').update(readFileSync(resolve(dshInstaller))).digest('hex');
  if(!/^[0-9a-f]{64}$/.test(dshExpected)||installerSha256!==dshExpected)throw Error('DSH installer checksum mismatch');
  const version=run('/usr/libexec/PlistBuddy',['-c','Print CFBundleShortVersionString',join(appPath,'Contents/Info.plist')]).trim();
  if(version!=='0.2.1-rc.3')throw Error('Unsupported DSH version: '+version);
  run('/usr/bin/codesign',['--verify','--deep','--strict',appPath]);
  const target=join(resources,'dsh-runtime','DeepSeek Harness.app');mkdirSync(dirname(target),{recursive:true});run('/usr/bin/ditto',[appPath,target]);
  const targetNotices=join(resources,'third-party-notices','deepseek-harness');mkdirSync(targetNotices,{recursive:true});
  for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md']){const source=join(resolve(dshLicenses),name);if(!existsSync(source))throw Error('Missing DSH notice: '+name);cpSync(source,join(targetNotices,name));}
  embeddedDsh={version,source:'https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.1-rc.3-mac-arm64.dmg',installerSha256,license:'MIT; see bundled third-party notices'};
}
if(reuseDshFrom){
  const prior=resolve(reuseDshFrom),priorResources=join(prior,'Contents/Resources'),priorManifest=JSON.parse(readFileSync(join(priorResources,'WORKBENCH_BUILD.json'),'utf8'));
  const previous=priorManifest.embeddedDsh,appPath=join(priorResources,'dsh-runtime','DeepSeek Harness.app');
  if(priorManifest.repository!==release.repository||previous?.version!=='0.2.1-rc.3'||!/^https:\/\/download\.deepseek\.com\//.test(previous.source||'')||!/^[0-9a-f]{64}$/.test(previous.installerSha256||''))throw Error('Installed DSH provenance is not verified');
  run('/usr/bin/codesign',['--verify','--deep','--strict',appPath]);
  const version=run('/usr/libexec/PlistBuddy',['-c','Print CFBundleShortVersionString',join(appPath,'Contents/Info.plist')]).trim();
  if(version!==previous.version)throw Error('Installed DSH version does not match its manifest');
  const target=join(resources,'dsh-runtime','DeepSeek Harness.app');mkdirSync(dirname(target),{recursive:true});run('/usr/bin/ditto',[appPath,target]);
  const targetNotices=join(resources,'third-party-notices','deepseek-harness');mkdirSync(targetNotices,{recursive:true});
  for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])cpSync(join(priorResources,'third-party-notices','deepseek-harness',name),join(targetNotices,name));
  embeddedDsh={...previous,reusedFrom:'verified installed application'};
}
const manifest={...release,sourceCommit:manifestOnly?previousManifest.sourceCommit:baseCommit||run('git',['rev-parse','HEAD'],{cwd:root}).trim(),...(manifestOnly?{sourceState:'canonical working tree compared with installed manifest; base commit unavailable',sourceChanges,referenceManifestSha256:createHash('sha256').update(readFileSync(resolve(retainedManifestPath))).digest('hex')}:baseCommit?{sourceState:sourceChanges.length?'base commit plus working-tree modifications':'base commit',sourceChanges}:{}),runtimeArchiveSha256:createHash('sha256').update(readFileSync(runtime)).digest('hex'),appIcon:{source:'apps/neko-workbench/assets/nekofuns-bigfish.icns',sha256:createHash('sha256').update(readFileSync(iconSource)).digest('hex')},...(embeddedDsh?{embeddedDsh}:{}),files:hashes};
writeFileSync(join(resources,'WORKBENCH_BUILD.json'),JSON.stringify(manifest,null,2)+'\n');
for(const attr of ['com.apple.FinderInfo','com.apple.ResourceFork'])spawnSync('/usr/bin/xattr',['-dr',attr,app]);
// Electron archives may contain helpers whose signatures require rebuilding.
// Sign only Electron's own nested code; the separately verified official DSH
// bundle lives under Resources and must retain its original signature.
if(embeddedDsh){const frameworks=join(app,'Contents/Frameworks');for(const name of readdirSync(frameworks).filter(n=>n.endsWith('.framework')||n.endsWith('.app'))){const item=join(frameworks,name),check=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',item],{encoding:'utf8'});if(check.status!==0)run('/usr/bin/codesign',['--force','--deep','--sign','-',item]);}}
run('/usr/bin/codesign',['--force',...(embeddedDsh?[]:['--deep']),'--sign','-',app]);run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const installer=join(stage,'安装日常版.command');writeFileSync(installer,'#!/bin/zsh\nset -e\nNEKO_INSTALL_DIR="${0:A:h}"\nexec env ELECTRON_RUN_AS_NODE=1 "$NEKO_INSTALL_DIR/'+release.appName+'/Contents/MacOS/Electron" "$NEKO_INSTALL_DIR/'+release.appName+'/Contents/Resources/workbench/scripts/install-neko-daily.cjs"\n');chmodSync(installer,0o755);
writeFileSync(join(stage,'安装说明.txt'),'Nekofans '+release.version+'（build '+release.build+'）\n\n请先退出旧工作台，双击“安装日常版.command”。安装到个人 Applications 中同一个应用位置，保留存档，并准备原生记忆组件。\n'+(embeddedDsh?'已内置 DSH，无需单独安装 DeepSeek Harness。':'需要先安装 DeepSeek Harness。')+'记忆环境需要 uv 和 Python 3.11，安装可能从官方包源下载锁定依赖。\n完成后打开 '+release.appName+'。只使用这一份日常版；QA 目录为开发验证用途。\n\n源码：'+release.repository+'\n基线提交：'+manifest.sourceCommit+'\n');
console.log(JSON.stringify({app,version:release.version,build:release.build,files:files.length,sourceCommit:manifest.sourceCommit}));
