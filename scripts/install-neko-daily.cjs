'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),release=JSON.parse(fs.readFileSync(path.join(root,'config/daily-release.json'),'utf8'));
const source=path.resolve(root,'../../..'),target=path.join(os.homedir(),'Applications',release.appName);
function run(command,args,options={}){const r=spawnSync(command,args,{stdio:'inherit',...options});if(r.status!==0)throw Error('安装步骤未完成：'+path.basename(command));}
function cleanCopy(from,to){fs.cpSync(from,to,{recursive:true,verbatimSymlinks:true,mode:fs.constants.COPYFILE_FICLONE});}
function assertAppsStopped(appPaths,query=spawnSync){
  const listing=query('/bin/ps',['-axo','command='],{encoding:'utf8'});
  if(listing.status!==0)throw Error('无法检查已有工作台；请先退出工作台再安装。');
  const commands=listing.stdout.split('\n').map(line=>line.trim());
  if(appPaths.some(app=>commands.some(command=>command.startsWith(app+'/Contents/'))))throw Error('请先退出 Nekofans 和旧版工作台，再重新运行安装。');
}
function identifyApplication(app,expected,query=spawnSync){
  const result=query('/usr/libexec/PlistBuddy',['-c','Print CFBundleIdentifier',path.join(app,'Contents/Info.plist')],{encoding:'utf8'});
  if(result.status!==0||result.stdout.trim()!==expected)throw Error('发现同名但身份不匹配的应用，已停止安装：'+app);
}
// Copy and verify before touching either existing application. A renamed old
// application is retained as a recoverable backup; it is never silently trashed.
function installApplication({source,target,legacy,expectedId,verify,checkStopped=assertAppsStopped,identify=identifyApplication,afterCommit=()=>{},makeId=()=>crypto.randomUUID()}){
  const appPaths=[...new Set([target,legacy].filter(Boolean))];
  checkStopped(appPaths);
  const targetExists=fs.existsSync(target),legacyExists=legacy&&legacy!==target&&fs.existsSync(legacy);
  if(targetExists&&legacyExists)throw Error('新旧工作台同时存在，无法安全决定替换哪一份；请先整理应用。');
  if(targetExists)identify(target,expectedId);
  if(legacyExists)identify(legacy,expectedId);
  if(source===target){afterCommit();return {target,backup:null};}
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const id=makeId(),pending=target+'.installing-'+id,existing=targetExists?target:legacyExists?legacy:null;
  const backup=existing?path.join(path.dirname(target),'.Nekofans-backups',id,path.basename(existing)):null;
  let moved=false,promoted=false;
  try{
    cleanCopy(source,pending);
    verify(pending);
    identify(pending,expectedId);
    checkStopped(appPaths);
    // Do not overwrite an application that appeared while the candidate was copied.
    if(fs.existsSync(target)!==targetExists||(legacy&&legacy!==target&&fs.existsSync(legacy)!==!!legacyExists))throw Error('安装期间应用状态发生变化，已停止安装。');
    if(existing)identify(existing,expectedId);
    if(existing){fs.mkdirSync(path.dirname(backup),{recursive:true});fs.renameSync(existing,backup);moved=true;}
    fs.renameSync(pending,target);promoted=true;
    afterCommit();
    return {target,backup};
  }catch(error){
    try{
      if(promoted)fs.renameSync(target,pending);
      if(moved)fs.renameSync(backup,existing);
    }catch(rollbackError){throw Error('安装未完成，自动恢复失败；旧应用备份位于 '+backup+'。原因：'+rollbackError.message);}
    throw error;
  }finally{if(fs.existsSync(pending))fs.rmSync(pending,{recursive:true,force:true});}
}
function ensureMemoryEnvironment({environment,project,env,probe=spawnSync,execute=run}){
  const python=path.join(environment,'bin/python'),imports=['-c','import fastapi,openai,anthropic,numpy,sqlalchemy'];
  if(fs.existsSync(python)&&probe(python,imports,{env,stdio:'ignore'}).status===0){console.log('现有记忆运行环境可用，保留不变。');return;}
  execute('uv',['sync','--project',project,'--frozen','--python','3.11'],{env});
  execute(python,imports,{env});
}
function ensureProjectLink({data,projectRoot,repository,query=spawnSync}){
  const file=path.join(data,'workbench-project.json');
  if(fs.existsSync(file)){console.log('保留已有工作区绑定。');return false;}
  if(!projectRoot||!path.isAbsolute(projectRoot)||!fs.existsSync(path.join(projectRoot,'.git')))return false;
  const remote=query('git',['-C',projectRoot,'remote','get-url','origin'],{encoding:'utf8'});
  if(remote.status!==0||!['https://github.com/'+repository+'.git','git@github.com:'+repository+'.git'].includes(remote.stdout.trim()))return false;
  try{fs.writeFileSync(file,JSON.stringify({root:projectRoot,repository:'https://github.com/'+repository},null,2)+'\n',{mode:0o600,flag:'wx'});}
  catch(error){if(error.code==='EEXIST')return false;throw error;}
  console.log('默认项目已绑定：'+projectRoot);return true;
}
function main(){
  if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('这个日常版用于 Apple Silicon macOS。');
  if(!fs.existsSync(path.join(source,'Contents/Info.plist')))throw Error('请从下载包运行安装入口。');
  const data=path.join(os.homedir(),'Library/Application Support/N.E.K.O. Workbench'),environment=path.join(data,'runtime/neko-memory');
  const project=path.join(target,'Contents/Resources/workbench/services/neko-memory');
  const env={...process.env,UV_PROJECT_ENVIRONMENT:environment,PATH:[path.join(os.homedir(),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin',process.env.PATH||'/usr/bin:/bin'].join(path.delimiter)};
  delete env.ELECTRON_RUN_AS_NODE;
  const result=installApplication({source,target,legacy:path.join(os.homedir(),'Applications','N.E.K.O.工作台试用.app'),expectedId:release.bundleIdentifier,
    verify:pending=>run('/usr/bin/codesign',['--verify','--deep','--strict',pending]),
    afterCommit:()=>ensureMemoryEnvironment({environment,project,env})});
  const flag=process.argv.indexOf('--project'),projectRoot=flag>=0?process.argv[flag+1]:path.join(os.homedir(),'Documents/ChatGPT/猫娘计划/neko-workbench');
  ensureProjectLink({data,projectRoot,repository:release.repository});
  console.log('已安装 Nekofans '+release.version+'（build '+release.build+'）。聊天存档和账号配置保留。');
  console.log('应用位置：'+target);
  if(result.backup)console.log('原工作台备份：'+result.backup);
}
if(require.main===module)try{main();}catch(error){console.error(error.message);process.exitCode=1;}
module.exports={ensureMemoryEnvironment,ensureProjectLink,assertAppsStopped,identifyApplication,installApplication};
