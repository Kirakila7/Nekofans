'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {createYuiHomeSession} = require('./yui-home-session.cjs');

// userDataDirectory must come from the workbench main process, never a renderer.
// The storage path is fixed and independent of the original Yui/Minecraft data.
function createYuiHomeFileStore(userDataDirectory, io = fs) {
  if (typeof userDataDirectory !== 'string' || !path.isAbsolute(userDataDirectory)) throw new Error('工作台数据目录无效');
  const directory = path.join(userDataDirectory, 'yui-home');
  const target = path.join(directory, 'world.json');
  async function write(text, initial) {
    await io.mkdir(directory, {recursive: true, mode: 0o700});
    const tmp = path.join(directory, `.world-${crypto.randomBytes(12).toString('hex')}.tmp`);
    try {
      await io.writeFile(tmp, text, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
      // A newly-created world must never replace a file created concurrently.
      if (initial) await io.link(tmp, target);
      else await io.rename(tmp, target);
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

function worldDocument(state) {
  return {version: 1, blocks: state.blocks, camera: state.camera, perspective: state.perspective, avatar: state.avatar};
}

function restoreWorld(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4_000_000) throw new Error('存档格式无效');
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || !Array.isArray(data.blocks) || data.blocks.length > 10000 || !data.camera || !data.avatar || !['orbit','yui'].includes(data.perspective)) throw new Error('存档格式无效');
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
  world.command({action:'perspective', mode:data.perspective});
  return world;
}

async function createYuiHomeStorage({store}) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new Error('家园存储无效');
  let world, loadError = null, saveError = null, pending = 0, needsInitialSave = false;
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
          world = restoreWorld(await store.load());
          needsInitialSave = false;
        } else saveError = '家园更改尚未保存，请检查工作台存储空间与权限';
      }
    } else world = restoreWorld(text);
  } catch {
    world = createYuiHomeSession();
    loadError = '工作台家园存档读取失败，原文件已保留';
  }
  let tail = Promise.resolve();
  const listeners = new Set();
  function state() {
    return {...world.state(), storage:'workbench-local', synced:false,
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
  async function command(input) {
    if (input?.action === 'status') return state();
    if (loadError) throw new Error(loadError + '，暂不能修改');
    const updated = input?.action === 'retry-save' ? world.state() : world.command(input);
    const document = JSON.stringify(worldDocument(updated));
    pending++;
    publish();
    const write = tail.catch(() => {}).then(async () => {
      if (needsInitialSave) {
        await (store.saveInitial || store.save)(document);
        needsInitialSave = false;
      } else await store.save(document);
    });
    tail = write;
    try {
      await write;
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
  return {state, command, subscribe};
}

module.exports = {createYuiHomeFileStore, createYuiHomeStorage};
