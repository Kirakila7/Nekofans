'use strict';
// Explicit native Windows filesystem fixture. It locks only files created in
// this invocation's independent temporary directory; no app/profile is opened.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{performance}=require('node:perf_hooks');
const {writeAtomicStateFileSync}=require('../../apps/neko-workbench/atomic-state-file.cjs');
const allowedCodes=new Set(['EPERM','EACCES','EBUSY']);
const lockScript=[
 "$ErrorActionPreference = 'Stop'",
 "$lockTarget = [Environment]::GetEnvironmentVariable('NEKO_ATOMIC_QA_TARGET')",
 "$lockMilliseconds = [int][Environment]::GetEnvironmentVariable('NEKO_ATOMIC_QA_MILLISECONDS')",
 "$lockStream = [System.IO.File]::Open($lockTarget, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)",
 "try {",
 "  [Console]::Out.WriteLine('LOCKED')",
 "  [Console]::Out.Flush()",
 "  $lockCommand = [Console]::In.ReadLine()",
 "  if ($lockCommand -eq 'GO') { Start-Sleep -Milliseconds $lockMilliseconds }",
 "  elseif ($lockCommand -ne 'RELEASE') { throw 'Invalid fixture lock command' }",
 "} finally { $lockStream.Dispose() }",
 "[Console]::Out.WriteLine('UNLOCKED')",
].join('\n');

function startLock(executable,file,milliseconds){
 const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',lockScript],{
  windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,NEKO_ATOMIC_QA_TARGET:file,NEKO_ATOMIC_QA_MILLISECONDS:String(milliseconds)},
 });
 let stdout='',stderr='',started=false,settled=false,readyResolve,readyReject,doneResolve,doneReject;
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const done=new Promise((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});
 // A subprocess can fail before its promise is awaited during setup.
 done.catch(()=>{});ready.catch(()=>{});
 const deadline=setTimeout(()=>{child.kill();const error=Error('Native lock fixture exceeded its bounded lifetime');readyReject(error);doneReject(error);},10000);
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.split(/\r?\n/).includes('LOCKED'))readyResolve();});
 child.stderr.on('data',chunk=>{stderr+=chunk;});
 child.on('error',error=>{clearTimeout(deadline);settled=true;readyReject(error);doneReject(error);});
 child.on('close',code=>{clearTimeout(deadline);settled=true;if(code===0&&stdout.includes('UNLOCKED'))doneResolve();else{const error=Error('PowerShell native lock fixture failed: '+stderr.trim());readyReject(error);doneReject(error);}});
 const send=command=>{if(started||settled)return;started=true;child.stdin.end(command+'\n');};
 return {ready,done,begin:()=>send('GO'),release:()=>send('RELEASE')};
}
function observedFileSystem(){
 const attempts=[],errors=[];
 return {attempts,errors,io:{...fs,renameSync(from,to){
  attempts.push({from,to,at:performance.now()});
  try{return fs.renameSync(from,to);}catch(error){errors.push(error.code);throw error;}
 }}};
}
async function run(){
 if(process.platform!=='win32'){console.log(JSON.stringify({skipped:true,reason:'requires native Windows FileShare.None'}));return;}
 // Only the installed Windows PowerShell is used, with a fixed literal script.
 const windowsRoot=path.resolve(process.env.SystemRoot||'C:\\Windows');
 const executable=fs.realpathSync(path.join(windowsRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'));
 assert.equal(path.relative(windowsRoot,executable).toLowerCase(),'system32\\windowspowershell\\v1.0\\powershell.exe');
 const temporaryRoot=path.resolve(os.tmpdir()),directory=fs.mkdtempSync(path.join(temporaryRoot,'neko-atomic-state-native-'));
 const target=path.join(directory,'state.json'),otherWriter=path.join(directory,'state.json.tmp'),holders=[];
 const old=JSON.stringify({generation:'old-synthetic-state'}),next=JSON.stringify({generation:'new-synthetic-state'});
 const metrics={};
 const hold=async milliseconds=>{const holder=startLock(executable,target,milliseconds);holders.push(holder);await holder.ready;return holder;};
 try{
  fs.writeFileSync(target,old);
  const legacyTemporary=path.join(directory,'legacy-candidate.tmp');fs.writeFileSync(legacyTemporary,next);
  const originalLock=await hold(200);originalLock.begin();
  let originalError;
  try{fs.renameSync(legacyTemporary,target);}catch(error){originalError=error.code;}
  assert(allowedCodes.has(originalError),'the original rename without retries must fail on a real exclusive Windows target lock');
  await originalLock.done;assert.equal(fs.readFileSync(target,'utf8'),old);assert.equal(fs.readFileSync(legacyTemporary,'utf8'),next);fs.unlinkSync(legacyTemporary);
  metrics.originalRenameError=originalError;

  fs.writeFileSync(otherWriter,'independent-writer-sentinel');
  const short=await hold(200),recovery=observedFileSystem();short.begin();
  const recoveryStart=performance.now();writeAtomicStateFileSync(target,next,{io:recovery.io});metrics.recoveryMilliseconds=Math.round(performance.now()-recoveryStart);
  await short.done;
  assert.equal(fs.readFileSync(target,'utf8'),next);assert(recovery.attempts.length>1&&recovery.attempts.length<=5);
  assert(recovery.errors.every(code=>allowedCodes.has(code)));assert.equal(new Set(recovery.attempts.map(x=>x.from)).size,1,'one invocation retries its own unique temporary file');
  const recoveredTemporary=recovery.attempts[0].from;
  assert.equal(path.dirname(recoveredTemporary),directory);assert.match(path.basename(recoveredTemporary),/^\.state\.json\.[0-9a-f-]{36}\.tmp$/i);
  assert.equal(fs.existsSync(recoveredTemporary),false);assert.equal(fs.readFileSync(otherWriter,'utf8'),'independent-writer-sentinel');
  metrics.recoveredRenameAttempts=recovery.attempts.length;

  fs.writeFileSync(target,old);
  const long=await hold(2000),bounded=observedFileSystem();long.begin();
  const failureStart=performance.now();let failure;
  try{writeAtomicStateFileSync(target,next,{io:bounded.io});}catch(error){failure=error;}
  metrics.failureMilliseconds=Math.round(performance.now()-failureStart);
  assert(failure&&allowedCodes.has(failure.code));assert.equal(bounded.attempts.length,5);
  assert(metrics.failureMilliseconds>=300&&metrics.failureMilliseconds<1500,'retry stops before the long lock is released');
  assert(bounded.errors.every(code=>allowedCodes.has(code)));
  const failedTemporary=bounded.attempts[0].from;
  assert.notEqual(failedTemporary,recoveredTemporary,'later invocations cannot reuse the prior writer temporary name');
  assert.equal(fs.existsSync(failedTemporary),false,'bounded failure removes only this invocation temporary file');
  await long.done;assert.equal(fs.readFileSync(target,'utf8'),old,'the previous target survives every failed rename');
  assert.equal(fs.readFileSync(otherWriter,'utf8'),'independent-writer-sentinel');
  assert.deepEqual(fs.readdirSync(directory).sort(),['state.json','state.json.tmp']);
  metrics.boundedRenameAttempts=bounded.attempts.length;
  console.log(JSON.stringify({ok:true,platform:process.platform,realFileShareNone:true,onlySyntheticTemporaryFiles:true,oldTargetPreserved:true,otherWriterUntouched:true,uniqueTemporaryNames:true,ownTemporaryCleanup:true,...metrics}));
 }finally{
  for(const holder of holders){holder.release();await holder.done.catch(()=>{});}
  // Recursive cleanup is restricted to the exact fresh directory above.
  assert.equal(path.dirname(path.resolve(directory)),temporaryRoot);assert(path.basename(directory).startsWith('neko-atomic-state-native-'));
  fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});
 }
}
run().catch(error=>{console.error(error.stack||String(error));process.exitCode=1;});
