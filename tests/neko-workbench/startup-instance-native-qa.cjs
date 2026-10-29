'use strict';
// Opt-in native Electron check; uses an isolated temporary profile.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const runtime = process.env.NEKO_STARTUP_QA_ELECTRON;
  if (!runtime || !path.isAbsolute(runtime)) throw Error('Set NEKO_STARTUP_QA_ELECTRON to a raw Electron executable');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-startup-lock-'));
  fs.writeFileSync(path.join(tmp,'package.json'), JSON.stringify({name:'neko-startup-isolated-qa',version:'1.0.0',main:'bootstrap.cjs'}));
  fs.writeFileSync(path.join(tmp,'bootstrap.cjs'), 'require('+JSON.stringify(__filename)+');\n');
  const env={ ...process.env, NEKO_STARTUP_QA_ROOT:tmp, ELECTRON_RUN_AS_NODE:'' };
  const run=kind=>spawn(runtime,[tmp,kind],{env,stdio:'ignore'});
  const wait=async (file)=>{for(let i=0;i<120;i++){if(fs.existsSync(path.join(tmp,file)))return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out waiting for '+file);};
  (async()=>{let first;
    try {
      first=run('first'); const firstExit=new Promise((resolve,reject)=>first.on('exit',code=>code===0?resolve():reject(Error('first exited '+code)))); await wait('locked');
      const second=run('second'); await new Promise((resolve,reject)=>second.on('exit',code=>code===0?resolve():reject(Error('second exited '+code))));
      await wait('early');
      fs.writeFileSync(path.join(tmp,'release'),''); await wait('raised'); await firstExit;
      const third=run('third'); await new Promise((resolve,reject)=>third.on('exit',code=>code===0?resolve():reject(Error('third exited '+code))));
      await wait('reacquired'); console.log(JSON.stringify({isolated:true,secondInstanceNotified:true,lockReacquiredAfterRelease:true}));
    } finally { if(first?.exitCode===null)first.kill(); fs.rmSync(tmp,{recursive:true,force:true}); }
  })().catch(e=>{console.error(e.message);process.exitCode=1;});
} else {
  const { app } = require('electron');
  const { claimWorkbenchInstance, queueEarlyInstanceNotifications } = require('../../apps/neko-workbench/startup-conflict.cjs');
  const dir=process.env.NEKO_STARTUP_QA_ROOT, kind=process.argv.at(-1);
  const write=name=>fs.writeFileSync(path.join(dir,name),'');
  const locked=claimWorkbenchInstance(app,path.join(dir,'profile'));
  if(kind==='first') {
    if(!locked) process.exit(2);
    const queue=queueEarlyInstanceNotifications(app); app.once('second-instance',()=>write('early'));
    app.whenReady().then(()=>{write('locked');const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,'release'))){clearInterval(timer);app.on('second-instance',()=>{write('raised');app.releaseSingleInstanceLock();app.quit();});queue.forward();}},30);});
  } else if(kind==='second') { if(locked)process.exit(3); app.quit(); }
  else if(kind==='third') { if(!locked)process.exit(4);write('reacquired');app.releaseSingleInstanceLock();app.quit(); }
  else process.exit(5);
}
