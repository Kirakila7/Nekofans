'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),release=JSON.parse(fs.readFileSync(path.join(root,'config/daily-release.json'),'utf8'));
const source=path.resolve(root,'../../..'),target=path.join(os.homedir(),'Applications',release.appName);
function run(command,args,options={}){const r=spawnSync(command,args,{stdio:'inherit',...options});if(r.status!==0)throw Error('安装步骤未完成：'+path.basename(command));}
function cleanCopy(from,to){fs.cpSync(from,to,{recursive:true,verbatimSymlinks:true});}
function main(){
  if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('这个日常版用于 Apple Silicon macOS。');
  if(!fs.existsSync(path.join(source,'Contents/Info.plist')))throw Error('请从下载包运行安装入口。');
  const listing=spawnSync('/bin/ps',['-axo','command='],{encoding:'utf8'});
  if(listing.status!==0)throw Error('无法检查已有工作台；请先退出工作台再安装。');
  const executable=path.join(target,'Contents/MacOS/Electron');
  if(listing.stdout.split('\n').some(line=>line.trim()===executable))throw Error('请先从工作台菜单退出当前工作台，再重新运行安装。');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  if(source!==target){
    const pending=target+'.installing-'+crypto.randomUUID(),previous=target+'.previous-'+crypto.randomUUID();let moved=false;
    try{cleanCopy(source,pending);run('/usr/bin/codesign',['--verify','--deep','--strict',pending]);if(fs.existsSync(target)){fs.renameSync(target,previous);moved=true;}fs.renameSync(pending,target);}
    catch(error){if(moved&&!fs.existsSync(target))fs.renameSync(previous,target);throw error;}
    finally{if(fs.existsSync(pending))fs.rmSync(pending,{recursive:true,force:true});}
    if(moved)run('/usr/bin/trash',[previous]);
  }
  const data=path.join(os.homedir(),'Library/Application Support/N.E.K.O. Workbench'),environment=path.join(data,'runtime/neko-memory');
  const project=path.join(target,'Contents/Resources/workbench/services/neko-memory');
  const env={...process.env,UV_PROJECT_ENVIRONMENT:environment,PATH:[path.join(os.homedir(),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin',process.env.PATH||'/usr/bin:/bin'].join(path.delimiter)};
  delete env.ELECTRON_RUN_AS_NODE;
  run('uv',['sync','--project',project,'--frozen','--python','3.11'],{env});
  run(path.join(environment,'bin/python'),['-c','import fastapi,openai,anthropic,numpy,sqlalchemy'],{env});
  const flag=process.argv.indexOf('--project'),projectRoot=flag>=0?process.argv[flag+1]:path.join(os.homedir(),'Documents/ChatGPT/猫娘计划/neko-workbench');
  if(projectRoot&&path.isAbsolute(projectRoot)&&fs.existsSync(path.join(projectRoot,'.git'))){
    const remote=spawnSync('git',['-C',projectRoot,'remote','get-url','origin'],{encoding:'utf8'});
    if(remote.status===0&&['https://github.com/'+release.repository+'.git','git@github.com:'+release.repository+'.git'].includes(remote.stdout.trim())){
      const file=path.join(data,'workbench-project.json'),temporary=file+'.tmp';
      fs.writeFileSync(temporary,JSON.stringify({root:projectRoot,repository:'https://github.com/'+release.repository},null,2)+'\n',{mode:0o600});fs.renameSync(temporary,file);
      console.log('默认项目已绑定：'+projectRoot);
    }
  }
  console.log('已安装 NEKOfuns '+release.version+'（build '+release.build+'）。聊天存档和账号配置保留。');
  console.log('应用位置：'+target);
}
try{main();}catch(error){console.error(error.message);process.exitCode=1;}
