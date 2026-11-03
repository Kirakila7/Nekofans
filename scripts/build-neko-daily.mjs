import {cpSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync,chmodSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const release=JSON.parse(readFileSync(join(root,'config/daily-release.json'),'utf8'));
function run(command,args,options={}){const r=spawnSync(command,args,{encoding:'utf8',...options});if(r.status!==0)throw Error(r.stderr||'Build command failed: '+command);return r.stdout;}
const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
if(process.platform==='win32'){
  const {buildWindowsDaily}=await import('./build-neko-windows.mjs');
  await buildWindowsDaily({root,release,args});
  process.exit(0);
}
const runtime=value('--electron-zip'),output=value('--output');
if(!runtime||!output)throw Error('Usage: node scripts/build-neko-daily.mjs --electron-zip <official cached runtime.zip> --output <new staging directory>');
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('The current daily build targets darwin-arm64.');
const stage=resolve(output);if(existsSync(stage))throw Error('Refusing to overwrite an existing release directory.');mkdirSync(stage,{recursive:true});
run('/usr/bin/ditto',['-x','-k',resolve(runtime),stage]);
const app=join(stage,release.appName);renameSync(join(stage,'Electron.app'),app);
const resources=join(app,'Contents/Resources'),destination=join(resources,'workbench');mkdirSync(destination,{recursive:true});
const tracked=run('git',['ls-files','-z'],{cwd:root}).split('\0').filter(Boolean);
const files=tracked.filter(p=>p.startsWith('apps/neko-workbench/')||p.startsWith('packages/')||p.startsWith('config/')||p.startsWith('services/neko-memory/')||p==='scripts/install-neko-daily.cjs');
const hashes={};for(const name of files){if(name.split('/').some(p=>['.venv','node_modules','.git'].includes(p))||name.startsWith('apps/neko-workbench/data/')||name.startsWith('apps/neko-workbench/workspaces/'))throw Error('Private runtime path in release: '+name);const source=join(root,name);if(!existsSync(source))throw Error('Missing tracked source: '+name);mkdirSync(dirname(join(destination,name)),{recursive:true});cpSync(source,join(destination,name),{verbatimSymlinks:true});hashes[name]=createHash('sha256').update(readFileSync(source)).digest('hex');}
const entry=join(resources,'app');mkdirSync(entry,{recursive:true});cpSync(join(root,'apps/neko-workbench/trial-bootstrap.cjs'),join(entry,'bootstrap.cjs'));
writeFileSync(join(entry,'package.json'),JSON.stringify({name:'neko-workbench-daily',version:release.version,main:'bootstrap.cjs'},null,2)+'\n');
run('/usr/bin/plutil',['-replace','CFBundleIdentifier','-string',release.bundleIdentifier,join(app,'Contents/Info.plist')]);
for(const [key,text] of [['CFBundleName','Nekofans'],['CFBundleDisplayName','Nekofans'],['CFBundleShortVersionString',release.version],['CFBundleVersion',release.build]])run('/usr/bin/plutil',['-replace',key,'-string',text,join(app,'Contents/Info.plist')]);
const manifest={...release,sourceCommit:run('git',['rev-parse','HEAD'],{cwd:root}).trim(),runtimeArchiveSha256:createHash('sha256').update(readFileSync(runtime)).digest('hex'),files:hashes};
writeFileSync(join(resources,'WORKBENCH_BUILD.json'),JSON.stringify(manifest,null,2)+'\n');
for(const attr of ['com.apple.FinderInfo','com.apple.ResourceFork'])spawnSync('/usr/bin/xattr',['-dr',attr,app]);
run('/usr/bin/codesign',['--force','--deep','--sign','-',app]);run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const installer=join(stage,'安装日常版.command');writeFileSync(installer,'#!/bin/zsh\nset -e\nNEKO_INSTALL_DIR="${0:A:h}"\nexec env ELECTRON_RUN_AS_NODE=1 "$NEKO_INSTALL_DIR/'+release.appName+'/Contents/MacOS/Electron" "$NEKO_INSTALL_DIR/'+release.appName+'/Contents/Resources/workbench/scripts/install-neko-daily.cjs"\n');chmodSync(installer,0o755);
writeFileSync(join(stage,'安装说明.txt'),'Nekofans '+release.version+'（build '+release.build+'）\n\n请先退出旧工作台，双击“安装日常版.command”。安装到个人 Applications 中同一个应用位置，保留存档，并准备原生记忆组件。\n需要已安装 DeepSeek Harness，以及 uv；记忆环境使用 Python 3.11。安装可能从官方包源下载锁定依赖。\n完成后打开 '+release.appName+'。只使用这一份日常版；QA 目录为开发验证用途。\n\n源码：'+release.repository+'\n提交：'+manifest.sourceCommit+'\n');
console.log(JSON.stringify({app,version:release.version,build:release.build,files:files.length,sourceCommit:manifest.sourceCommit}));
