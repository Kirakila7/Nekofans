'use strict';
const {createYuiHomeFileStore, createYuiHomeStorage} = require('./yui-home-storage.cjs');
const {createYuiHomeTextures} = require('./yui-home-textures.cjs');
const {createHomePetAssets}=require('./home-pet-assets.cjs');

const fields = Object.freeze({
  status: [], textures: [], 'textures-retry': [], 'retry-save': [], place: ['x','y','z','material'], remove: ['x','y','z'], clear: [],
  camera: ['azimuth','elevation','zoom'], perspective: ['mode'],
  avatar: ['position'], avatar_checkpoint: ['position'], avatar_reset: [],
  'return-home':[],'avatar_look':['yaw','pitch'],'avatar_walk':['dx','dz'],
  'pet-animations':[],'pet-animation':['name'],'avatar_place':['x','z'],
});

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string' || !Object.hasOwn(fields, request.action)) throw new Error('家园操作无效');
  if (Object.keys(request).some(key => key !== 'action' && !fields[request.action].includes(key))) throw new Error('家园操作参数无效');
  // World commands validate the contents, including finite coordinates and material allowlist.
  return request;
}

function createYuiHomeIpc({assertCaller, userDataDirectory, publish, createStorage = createYuiHomeStorage, createStore = createYuiHomeFileStore, textureProvider = createYuiHomeTextures()}) {
  if (typeof assertCaller !== 'function' || typeof publish !== 'function') throw new Error('家园桥接配置无效');
  let initialization;
  const petAssets=createHomePetAssets();
  function getStorage() {
    if (!initialization) {
      initialization = Promise.resolve().then(() => createStorage({store:createStore(userDataDirectory)})).then(storage => {
        storage.subscribe(state => publish(state));
        return storage;
      }).catch(() => { initialization = null; throw new Error('工作台家园初始化失败'); });
    }
    return initialization;
  }
  const handle=async function handle(event, request) {
    assertCaller(event);
    validateRequest(request);
    if(request.action==='pet-animations')return {ok:true,animations:await petAssets.manifest()};
    if(request.action==='pet-animation')return {ok:true,animation:await petAssets.load(request.name)};
    if (request.action === 'textures' || request.action === 'textures-retry') {
      if (request.action === 'textures-retry') textureProvider.clearCache();
      const result = await textureProvider.load();
      assertCaller(event);
      return result;
    }
    const storage = await getStorage();
    assertCaller(event);
    return request.action === 'status' ? storage.state() : storage.command(request);
  };
  handle.getStorage=getStorage;return handle;
}
module.exports = {createYuiHomeIpc};
