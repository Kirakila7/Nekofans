'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

// Only the trusted host configures the project directory. The renderer
// supplies neither a path nor a command. The bridge credential remains in the main
// process and the child environment, and is never returned to the renderer.
function createStoryPrototypeLauncher({projectDir, executable, relay, fetchImpl=fetch}) {
  const root = typeof projectDir === 'string' && path.isAbsolute(projectDir) ? projectDir : null;
  let child = null;
  let starting = false, opening = false, generation = 0, whiteRoom = null;
  async function stop() {
    generation++;
    whiteRoom = null;
    const running = child;
    child = null;
    if (running && running.exitCode === null) {
      await new Promise(resolve => {
        const timer=setTimeout(()=>{
          if(running.exitCode===null&&running.signalCode===null)running.kill('SIGKILL');
          finish();
        },1500);
        function finish(){clearTimeout(timer);running.removeListener('exit',finish);resolve();}
        running.once('exit', finish);
        running.kill('SIGTERM');
      });
    }
    return relay.stop('story-stopped');
  }
  async function start() {
    if (starting) return {status:'busy'};
    if (child && child.exitCode === null) return {status:'running'};
    if (!root || !fs.statSync(path.join(root, 'server.js'), {throwIfNoEntry:false})?.isFile()) {
      return {status:'missing-project'};
    }
    starting = true;
    const current = generation;
    try {
      await relay.stop('story-restart');
      if(current!==generation)return {status:'cancelled'};
      const info = await relay.start({ttlMs:2 * 60 * 60 * 1000});
      if(current!==generation){await relay.stop('story-cancelled');return {status:'cancelled'};}
      if (info.status !== 'started' || !info.token || !info.baseUrl) return {status:'bridge-unavailable'};
      const baseEnv = Object.fromEntries(['HOME','PATH','TMPDIR','LANG','LC_ALL','LC_CTYPE','USER','SHELL'].filter(key => typeof process.env[key] === 'string').map(key => [key,process.env[key]]));
      const p = spawn(executable, [path.join(root, 'server.js')], {
        cwd:root,
        env:{...baseEnv, ELECTRON_RUN_AS_NODE:'1', PORT:'8787', NEKO_AI_BRIDGE_URL:info.baseUrl, NEKO_AI_BRIDGE_TOKEN:info.token, NEKO_AI_MODEL:info.model, NEKO_AI_BRIDGE_LABEL:info.label},
        stdio:['ignore','pipe','pipe'],
      });
      child = p;
      const result = await new Promise(resolve => {
        let out = '', done = false;
        const timer = setTimeout(() => finish('timeout'), 10000);
        function finish(status) { if(done)return; done=true; clearTimeout(timer); resolve(status); }
        p.stdout.on('data', chunk => { out = (out + chunk.toString()).slice(-4096); if(out.includes('127.0.0.1:8787（仅本机')) finish('started'); });
        p.stderr.on('data', () => {});
        p.once('error', () => finish('failed'));
        p.once('exit', () => finish('failed'));
      });
      if(current!==generation)return {status:'cancelled'};
      if (result !== 'started') { await stop(); return {status:result}; }
      p.once('exit', () => { if (child === p) {child=null;whiteRoom=null;void relay.stop('story-exited').catch(()=>{});} });
      return {status:'started',origin:'http://127.0.0.1:8787'};
    } catch { await stop(); return {status:'failed'}; }
    finally { starting = false; }
  }
  async function openRoom(openExternal) {
    if(opening)return {status:'busy'};
    opening=true;
    const origin='http://127.0.0.1:8787';
    const current=generation;
    try{
      const previous=relay.status();
      if(previous.bound&&(!whiteRoom||whiteRoom.id!==previous.roomId))return {status:'already-bound'};
      const startup=await start();
      if(!['started','running'].includes(startup.status))return {status:startup.status};
      if(current!==generation)return {status:'cancelled'};
      const status=relay.status();
      if(status.status!=='running')return {status:'bridge-unavailable'};
      if(status.bound&&(!whiteRoom||whiteRoom.id!==status.roomId))return {status:'already-bound'};
      if(!whiteRoom){
        const response=await fetchImpl(origin+'/api/rooms',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
          headers:{'content-type':'application/json'},body:JSON.stringify({scenario:'story-v1',reviewMode:'manual',guessLimit:3})});
        if(!response.ok)return {status:'room-unavailable'};
        const {ok,roomId,links}=await response.json();
        if(!ok||!/^r-[0-9a-f]{8}$/.test(roomId))return {status:'room-unavailable'};
        const roomUrl=new URL(links?.white);
        if(roomUrl.origin!==origin||roomUrl.username||roomUrl.password||roomUrl.hash||roomUrl.pathname!=='/room/'+roomId||
          roomUrl.searchParams.size!==1||!roomUrl.searchParams.get('token'))return {status:'room-unavailable'};
        if(current!==generation)return {status:'cancelled'};
        whiteRoom={id:roomId,url:roomUrl.href};
      }
      const room=whiteRoom;
      if(!status.bound){
        const binding=await relay.bind({roomId:room.id,prototypeOrigin:origin});
        if(binding.status!=='bound')return {status:binding.status};
      }
      if(current!==generation)return {status:'cancelled'};
      await openExternal(room.url);
      return {status:'opened',roomId:room.id};
    }catch{return {status:'room-unavailable'};}
    finally{opening=false;}
  }
  return {start,stop,openRoom};
}
module.exports = {createStoryPrototypeLauncher};
