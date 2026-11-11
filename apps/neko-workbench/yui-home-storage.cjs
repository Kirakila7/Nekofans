'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {createYuiHomeSession} = require('./yui-home-session.cjs');
const {sceneFingerprint}=require('./our-home-scene.cjs');

// userDataDirectory must come from the workbench main process, never a renderer.
// The storage path is fixed and independent of the original Yui/Minecraft data.
function createYuiHomeFileStore(userDataDirectory, io = fs) {
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory)) throw new Error('工作台数据目录无效');
  const directory = path.join(userDataDirectory, 'our-home');
  const target = path.join(directory, 'world.json');
  async function atomicCommit(operation) {
    // Windows scanners can briefly retain a handle to an otherwise writable
    // save. Retry the atomic operation; never delete the previous save first.
    for(let attempt=0;;attempt++){
      try{return await operation();}catch(error){
        if(process.platform!=='win32'||attempt>=4||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
        await new Promise(resolve=>setTimeout(resolve,25*2**attempt));
      }
    }
  }
  async function write(text, initial) {
    await io.mkdir(directory, {recursive: true, mode: 0o700});
    const tmp = path.join(directory, `.world-${crypto.randomBytes(12).toString('hex')}.tmp`);
    try {
      await io.writeFile(tmp, text, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
      // A newly-created world must never replace a file created concurrently.
      if (initial) await atomicCommit(()=>io.link(tmp, target));
      else await atomicCommit(()=>io.rename(tmp, target));
    } finally {
      await io.unlink(tmp).catch(() => {});
    }
  }
  return {
    async load() {
      try {
        const st = await io.lstat(target);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 4_000_000) throw new Error('存档不是有效文件');
        return await io.readFile(target, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    save:text=>write(text,false),
    saveInitial:text=>write(text,true),
  };
}

function worldDocument(state,buildLedger={}) {
  return {version: 3, blocks: state.blocks,items:state.items||[], camera: state.camera, perspective: state.perspective, avatar: state.avatar,buildLedger};
}

function restoreWorld(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4_000_000) throw new Error('存档格式无效');
  const data = JSON.parse(text);
  if (!data || ![1,2,3].includes(data.version) || !Array.isArray(data.blocks) || data.blocks.length > 10000 || !data.camera || !data.avatar || !['orbit','yui','agent'].includes(data.perspective)) throw new Error('存档格式无效');
  const world = createYuiHomeSession({empty:true});
  const seen = new Set();
  for (const block of data.blocks) {
    if (!block || typeof block !== 'object') throw new Error('存档方块无效');
    const key = `${block.x},${block.y},${block.z}`;
    if (seen.has(key)) throw new Error('存档方块重复');
    seen.add(key);
    world.command({action:'place', x:block.x, y:block.y, z:block.z, material:block.material});
  }
  for (const k of ['azimuth','elevation','zoom']) if (typeof data.camera[k] !== 'number' || !Number.isFinite(data.camera[k])) throw new Error('存档视角无效');
  world.command({action:'camera', azimuth:data.camera.azimuth, elevation:data.camera.elevation, zoom:data.camera.zoom});
  world.command({action:'avatar', position:data.avatar});
  if(data.version>=2)world.command({action:'furnish',items:data.items});
  world.command({action:'perspective', mode:data.perspective});
  return world;
}

async function createYuiHomeStorage({store}) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new Error('家园存储无效');
  let world, buildLedger={}, loadError = null, saveError = null, pending = 0, needsInitialSave = false;
  function restore(text){const restored=restoreWorld(text),data=JSON.parse(text),ledger=data.version===3?data.buildLedger:{};if(!ledger||typeof ledger!=='object'||Array.isArray(ledger)||Object.entries(ledger).some(([key,tokens])=>!(/^[a-f0-9]{64}$/.test(key))||!(tokens===null||Number.isSafeInteger(tokens)&&tokens>=0)))throw Error('小窝价值记录无效');const total=Object.values(ledger).reduce((n,t)=>n+(t||0),0);if(!Number.isSafeInteger(total))throw Error('小窝价值记录超出范围');buildLedger=ledger;return restored;}
  try {
    const text = await store.load();
    if (text === null) {
      world = createYuiHomeSession();
      needsInitialSave = true;
      try {
        await (store.saveInitial || store.save)(JSON.stringify(worldDocument(world.state())));
        needsInitialSave = false;
      } catch (error) {
        if (error?.code === 'EEXIST') {
          world = restore(await store.load());
          needsInitialSave = false;
        } else saveError = '家园更改尚未保存，请检查工作台存储空间与权限';
      }
    } else world = restore(text);
  } catch {
    world = createYuiHomeSession();
    loadError = '工作台家园存档读取失败，原文件已保留';
  }
  let tail = Promise.resolve();
  const listeners = new Set();
  function state() {
    const values=Object.values(buildLedger);
    return {...world.state(), storage:'workbench-local', synced:false,
      homeValue:{tokens:values.reduce((n,t)=>n+(t||0),0),unknownCalls:values.filter(t=>t===null).length,status:loadError?'unavailable':'recorded'},
      persistence:{status:loadError?'load-error':pending?'saving':saveError?'save-error':'saved', error:loadError || saveError}};
  }
  function publish() {
    for (const listener of listeners) { try { listener(state()); } catch {} }
  }
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('监听器无效');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function enqueue(operation){const result=tail.catch(()=>{}).then(operation);tail=result;return result;}
  async function persist(input,receipts=[]) {
    if (input?.action === 'status') return state();
    if (loadError) throw new Error(loadError + '，暂不能修改');
    const updated = input?.action === 'retry-save' ? world.state() : world.command(input);
    const nextLedger={...buildLedger};
    const accepted=new Set([sceneFingerprint(updated.items)]),remaining=[...receipts];
    while(remaining.length){const index=remaining.findIndex(r=>accepted.has(r.afterHash));if(index<0)throw Error('小窝价值凭据未对应已保存场景');const [receipt]=remaining.splice(index,1);if(!receipt||!(/^[a-f0-9]{64}$/.test(receipt.key))||!(/^[a-f0-9]{64}$/.test(receipt.beforeHash))||sceneFingerprint(receipt.items)!==receipt.afterHash||receipt.beforeHash===receipt.afterHash||!(receipt.tokens===null||Number.isSafeInteger(receipt.tokens)&&receipt.tokens>=0))throw Error('小窝价值凭据无效');accepted.add(receipt.beforeHash);if(!Object.hasOwn(nextLedger,receipt.key)||nextLedger[receipt.key]===null)nextLedger[receipt.key]=receipt.tokens;}
    if(!Number.isSafeInteger(Object.values(nextLedger).reduce((n,t)=>n+(t||0),0)))throw Error('小窝价值超出范围');
    const document = JSON.stringify(worldDocument(updated,nextLedger));
    if(Buffer.byteLength(document)>4_000_000)throw Error('小窝存档过大，暂不能保存');
    pending++;
    publish();
    const write = (async () => {
      if (needsInitialSave) {
        await (store.saveInitial || store.save)(document);
        needsInitialSave = false;
      } else await store.save(document);
    })();
    try {
      await write;
      buildLedger=nextLedger;
      saveError = null;
    } catch {
      saveError = '家园更改尚未保存，请检查工作台存储空间与权限';
      throw new Error(saveError);
    } finally {
      pending--;
      publish();
    }
    return state();
  }
  function command(input){return input?.action==='status'?Promise.resolve(state()):enqueue(()=>persist(input));}
  // Main-process-only path: scene and deduplicated model-call receipt share
  // one atomic save. It is deliberately absent from the renderer IPC actions.
  function applyScene(items,receipts=[]){return enqueue(()=>persist({action:'furnish',items},receipts));}
  return {state, command, applyScene, subscribe};
}

module.exports = {createYuiHomeFileStore, createYuiHomeStorage};
