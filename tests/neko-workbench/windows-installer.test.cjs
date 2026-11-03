'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),workspace=path.dirname(root),modulePromise=import('../../scripts/windows-installer.mjs'),release={version:'1.2.3',build:'4'};
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function directory(t){const parent=path.join(workspace,'.neko-windows-build');fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'installer-unit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function payload(t){const dir=directory(t),application=path.join(dir,'application'),output=path.join(dir,'output');fs.mkdirSync(application);fs.mkdirSync(output);fs.mkdirSync(path.join(application,'assets/$sprite'),{recursive:true});fs.writeFileSync(path.join(application,'NEKOfuns.exe'),'MZ-SYNTHETIC-NOT-RUN');fs.writeFileSync(path.join(application,'assets/$sprite/鱼.txt'),'synthetic');const integrity=Object.fromEntries(['NEKOfuns.exe','assets/$sprite/鱼.txt'].map(name=>[name,hash(path.join(application,name))]));return {dir,application,output,integrity};}

test('installer defaults are per-user and isolated QA overrides require a separate identity and shortcut group',async()=>{
 const {installerOptions,nsisLiteral}=await modulePromise,defaults=installerOptions({args:[],release});assert.equal(defaults.appId,'NEKOfuns-Workbench');assert.equal(defaults.group,'NEKOfuns');assert.equal(defaults.installRoot,null);assert(defaults.desktopShortcut);assert.equal(defaults.numericVersion,'1.2.3.4');
 const args=['--installer-test-id','NEKOfuns-QA-fixture','--installer-install-dir',path.resolve('synthetic-install'),'--installer-shortcut-group','NEKOfuns-QA-fixture'];const isolated=installerOptions({args,release});assert(isolated.testMode);assert(!isolated.desktopShortcut);assert.equal(isolated.appId,isolated.group);
 for(const args of [['--installer-install-dir',path.resolve('unsafe')],['--installer-shortcut-group','NEKOfuns-QA-test'],['--installer-test-id','NEKOfuns-Workbench'],['--artifact-name','../replace.exe'],['--artifact-name','bad$\n.exe']])assert.throws(()=>installerOptions({args,release}));
 assert.equal(nsisLiteral('a$"b'),String.raw`"a$$$\"b"`);assert.throws(()=>nsisLiteral('bad\ntext'));
});

test('installer input integrity rejects changed, extra, traversal and private runtime files',async t=>{
 const {verifyInstallerInput}=await modulePromise,f=payload(t);assert.equal(verifyInstallerInput(f.application,f.integrity).length,2);
 assert.throws(()=>verifyInstallerInput(f.application,{...f.integrity,'../outside':'a'.repeat(64)}),/Unsafe/);
 assert.throws(()=>verifyInstallerInput(f.application,{...f.integrity,'credentials.yaml':'a'.repeat(64)}),/Private/);
 fs.writeFileSync(path.join(f.application,'extra.txt'),'extra');assert.throws(()=>verifyInstallerInput(f.application,f.integrity),/inventory changed/);fs.unlinkSync(path.join(f.application,'extra.txt'));
 fs.writeFileSync(path.join(f.application,'NEKOfuns.exe'),'changed');assert.throws(()=>verifyInstallerInput(f.application,f.integrity),/payload changed/);
});

test('NSIS generation includes only inventoried files, escapes dollar paths and keeps uninstall and running-process guards',async t=>{
 const {generateInstallerFiles}=await modulePromise,f=payload(t),result=generateInstallerFiles({...f,root,release,args:[]}),script=fs.readFileSync(result.script,'utf8'),files=fs.readFileSync(result.files,'utf8'),template=fs.readFileSync(path.join(root,'scripts/windows-installer.nsi'),'utf8');
 assert(script.includes('"$LOCALAPPDATA\\Programs\\NEKOfuns"'));assert(files.includes('SetOutPath "$INSTDIR\\assets\\$$sprite"'));assert.equal((files.match(/^File "/gm)||[]).length,2);assert(files.includes('FileWriteUTF16LE'));
 for(const expected of ['RequestExecutionLevel user','SetShellVarContext current','WriteRegStr HKCU','CreateShortcut','WriteUninstaller','QueryFullProcessImageNameW','Process32FirstW','un.RequireClosedApplication','GetFullPathNameW','GetFullPathName $3 "$INSTDIR\\$0"','GetFileAttributesW','& 0x400','Call un.CheckSafePath','FileSeek $ManagedLog 0 END'])assert(template.includes(expected),expected);
 assert(files.includes('Push "$INSTDIR\\assets\\$$sprite\\鱼.txt"'),'individual existing payload files are checked for reparse links too');
 assert(!/RMDir\s+\/r|TerminateProcess|taskkill|NEKOSFX1|ELECTRON_RUN_AS_NODE|ExecutionPolicy/i.test(template));assert(!/Delete[^\r\n]*\$(?:APPDATA|LOCALAPPDATA|DOCUMENTS)/i.test(template));assert.throws(()=>generateInstallerFiles({...f,root,release,args:['--artifact-name','x/y.exe']}));
 fs.writeFileSync(result.exe,'existing artifact');assert.throws(()=>generateInstallerFiles({...f,root,release,args:[]}),/overwrite/);
});

test('stage-only and verified resume prepare no installer and keep the existing PR52 profile unchanged',async t=>{
 const {buildWindowsDaily}=await import('../../scripts/build-neko-windows.mjs'),dir=directory(t),source=path.join(dir,'source'),electron=path.join(dir,'electron'),node=path.join(dir,'node'),output=path.join(dir,'stage');for(const folder of [path.join(source,'apps/neko-workbench'),electron,node])fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(source,'apps/neko-workbench/fixture.cjs'),'synthetic');fs.writeFileSync(path.join(electron,'electron.exe'),'SYNTHETIC-ELECTRON-NOT-RUN');fs.writeFileSync(path.join(node,'node.exe'),'SYNTHETIC-NODE-NOT-RUN');const manifest=path.join(dir,'source-manifest.json');fs.writeFileSync(manifest,JSON.stringify({files:['apps/neko-workbench/fixture.cjs'],sourceCommit:'a'.repeat(40),variant:'installer unit fixture'}));
 const npm=path.join(node,'node_modules/npm');fs.mkdirSync(path.join(npm,'bin'),{recursive:true});fs.mkdirSync(path.join(npm,'node_modules/synthetic-dependency'),{recursive:true});fs.writeFileSync(path.join(npm,'package.json'),JSON.stringify({name:'npm',version:'11.17.0'}));fs.writeFileSync(path.join(npm,'bin/npm-cli.js'),'SYNTHETIC-NPM-NOT-RUN');fs.writeFileSync(path.join(npm,'node_modules/synthetic-dependency/index.js'),'SYNTHETIC-NESTED-DEPENDENCY');
 const args=['--output',output,'--electron-dir',electron,'--node-dir',node,'--source-root',source,'--source-manifest',manifest,'--profile-name','NEKOfuns-PR52-Trial','--stage-only'];const staged=await buildWindowsDaily({root,release,args});assert.equal(staged.kind,'stage');const local=JSON.parse(fs.readFileSync(path.join(output,'application/NEKOfuns.local.json'),'utf8'));assert.deepEqual(local,{profileName:'NEKOfuns-PR52-Trial'});assert(!fs.readdirSync(output).some(name=>name.endsWith('.exe')||name.endsWith('.zip')));
 const shippedNpm=path.join(output,'application/node/node_modules/npm');assert.equal(fs.readFileSync(path.join(shippedNpm,'bin/npm-cli.js'),'utf8'),'SYNTHETIC-NPM-NOT-RUN');assert.equal(fs.readFileSync(path.join(shippedNpm,'node_modules/synthetic-dependency/index.js'),'utf8'),'SYNTHETIC-NESTED-DEPENDENCY');assert.equal(JSON.parse(fs.readFileSync(path.join(output,'application/resources/WORKBENCH_BUILD.json'),'utf8')).bundledNpm.version,'11.17.0');
 const resumed=await buildWindowsDaily({root,release,args:['--output',output,'--resume-package','--stage-only']});assert.equal(resumed.kind,'stage');await assert.rejects(buildWindowsDaily({root,release:{...release,build:5},args:['--output',output,'--resume-package','--stage-only']}),/version changed/);fs.writeFileSync(path.join(output,'application/node/node.exe'),'tampered');await assert.rejects(buildWindowsDaily({root,release,args:['--output',output,'--resume-package','--stage-only']}),/Staged file changed/);
});

test('only the pinned official NSIS tool receipt can be used for the compiler',async()=>{
 const {verifyNsisTool}=await modulePromise;assert.throws(()=>verifyNsisTool(null,null),/requires/);
 const receipt=path.join(workspace,'.neko-windows-build/tools/NSIS_TOOL_RECEIPT.json');if(!fs.existsSync(receipt))return;const data=JSON.parse(fs.readFileSync(receipt,'utf8').replace(/^\uFEFF/,''));const result=verifyNsisTool(data.compiler,receipt);assert.equal(result.version,'3.13');assert.equal(result.archiveSha256,data.officialPublishedSha256);
});

test('verified NSIS compiles a tiny synthetic installer without executing it',{skip:!process.env.NEKO_NSIS_COMPILE_FIXTURE},async t=>{
 const {packageWindowsInstaller}=await modulePromise,f=payload(t),receipt=path.join(workspace,'.neko-windows-build/tools/NSIS_TOOL_RECEIPT.json'),tool=JSON.parse(fs.readFileSync(receipt,'utf8').replace(/^\uFEFF/,''));
 const long='assets/'+('long-'.repeat(20))+'/'+('deep-'.repeat(10))+'/长路径.txt',source=path.join(f.application,long);assert(source.length>260);fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,'complete long-path source');f.integrity[long]=hash(source);
 const args=['--nsis-compiler',tool.compiler,'--nsis-receipt',receipt,'--installer-test-id','NEKOfuns-QA-compile','--installer-install-dir',path.join(f.dir,'not-installed'),'--installer-shortcut-group','NEKOfuns-QA-compile'];const result=packageWindowsInstaller({...f,root,release,args,manifest:{sourceCommit:'a'.repeat(40),files:{}},local:{profileName:'NEKOfuns-PR52-Trial'}});assert.equal(result.kind,'installer');assert(result.bytes>10000);assert(fs.readFileSync(result.installer.files,'utf8').includes(path.toNamespacedPath(source)));assert(!fs.existsSync(path.join(f.dir,'not-installed')),'compilation never installs or starts a program');
});
