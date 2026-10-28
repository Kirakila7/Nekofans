'use strict';
// Manual, opt-in real DSH composition test. It installs pinned public runtime
// dependencies into an isolated temporary directory but never contacts QQ.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const project=path.resolve(__dirname,'../..');process.chdir(project);
const {resolveRuntimePaths,prepareRuntimeDirectories,buildDshPatch,buildDshLaunch}=require(path.join(project,'apps/neko-workbench/runtime-config.cjs'));
const electron='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const modules='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai';
if(process.platform!=='darwin'||!fs.existsSync(electron)){console.error('需要 macOS 已安装 DeepSeek Harness 才能运行此实机检查。');process.exit(2);}
const base=fs.mkdtempSync(path.join(os.tmpdir(),'neko-qq-agent-guard-'));
const env={...process.env,NEKO_WORKBENCH_DATA_DIR:path.join(base,'data'),NEKO_WORKBENCH_WORKSPACE:path.join(base,'workspace'),NEKO_WORKBENCH_ELECTRON_USER_DATA:path.join(base,'electron'),NEKO_WORKBENCH_DSH_MODULES:modules};
const pkgroot=path.join(env.NEKO_WORKBENCH_DATA_DIR,'qqbot-runtime');env.NEKO_WORKBENCH_QQBOT_PROFILE=pkgroot;
const installer=path.join(project,'apps/neko-workbench/vendor/dsh-qqbot-workbench/install.cjs');
const setup=cp.spawnSync(electron,['-e','const {install}=require(process.argv[1]);install(process.argv[2],process.argv[3]).then(()=>{},()=>process.exitCode=1)',installer,pkgroot,modules],{cwd:project,env:{...env,ELECTRON_RUN_AS_NODE:'1'},stdio:'ignore',timeout:90000});
if(setup.status!==0){fs.rmSync(base,{recursive:true,force:true});console.error('无法安装测试所需的固定依赖。');process.exit(1);}
env.NEKO_QQ_TEST_PKG=path.join(pkgroot,'node_modules/@tencent-connect/dsh-qqbot');
const runtime=resolveRuntimePaths({env,baseDir:path.join(project,'apps/neko-workbench')});prepareRuntimeDirectories(runtime);
const patch=buildDshPatch(runtime);patch.at(-1).insert.push({id:'neko-qq-guard-probe',name:path.join(__dirname,'fixtures/qqbot-guard-probe.cjs')});fs.writeFileSync(path.join(runtime.dataDir,'bridge.patch.json'),JSON.stringify(patch));
const launch=buildDshLaunch(runtime,{env});const child=cp.spawn(launch.command,launch.args,launch.options);let buf='',done=false;let timer=setTimeout(()=>finish('真实 DSH 测试超时。'),30000);
function finish(error,out){if(done)return;done=true;clearTimeout(timer);child.stdin.end();child.kill('SIGTERM');if(error){console.error(error);process.exitCode=1;}else console.log('PASS：QQ 新建、切换模式、恢复均拒绝工具；远程模型重建已禁用；普通 Agent 不受影响。',JSON.stringify(out));}
child.stderr.on('data',()=>{});child.stdout.on('data',x=>{buf+=x;for(;;){const i=buf.indexOf('\n');if(i<0)break;const line=buf.slice(0,i);buf=buf.slice(i+1);const key='NEKO_QQ_GUARD_PROBE=',j=line.indexOf(key);if(j>=0){const out=JSON.parse(line.slice(j+key.length));if(out.qCount!==0||out.normal!==1||out.created!=='denied'||out.preset!=='denied'||out.rebuild!=='blocked'||out.resume!=='denied'||!out.sameSession)finish('QQ 工具防护结果不符合预期。');else finish(null,out);}const e='NEKO_QQ_GUARD_PROBE_ERROR=',k=line.indexOf(e);if(k>=0)finish('QQ 防护测试失败：'+line.slice(k+e.length));}});
child.on('error',()=>finish('无法启动隔离 DSH。'));child.on('exit',c=>{if(!done)finish('隔离 DSH 提前退出：'+c);fs.rmSync(base,{recursive:true,force:true});});
