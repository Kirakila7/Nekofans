'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WorkbenchSecretStore, atomicBytes } = require('./main-chat-secret.cjs');

const PERSONA = 'bigfish';
const BACKENDS = new Set(['chat-api', 'neko']);
const clone = value => structuredClone(value);
const atomicJson = (file, value) => atomicBytes(file, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
const failure = () => new Error('聊天设置保存失败，请检查配置与系统加密存储后重试');

async function loadSharedModules(repositoryRoot) {
  const load = relative => import(pathToFileURL(path.join(repositoryRoot, relative)).href);
  const [chat, api, history] = await Promise.all([
    load('packages/chat-service/src/config.ts'), load('packages/chat-api/src/index.ts'),
    load('packages/conversation-store/src/index.ts'),
  ]);
  return { ...chat, validateConfig: api.validateConfig, SqliteConversationStore: history.SqliteConversationStore };
}

function field(value, max) {
  if (typeof value !== 'string' || value.length > max) throw failure();
  return value.trim();
}
function parseApiInput(input, shared) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure();
  const settings = shared.parseMainChatConfig({ personaId: PERSONA,
    protocol: field(input.protocol, 40), baseUrl: field(input.baseUrl, 2048), model: field(input.model, 200),
    requestTimeoutMs: input.requestTimeoutMs, maxOutputTokens: input.maxOutputTokens });
  if (settings.requestTimeoutMs > 300000) throw failure();
  if (settings.baseUrl || settings.model) {
    shared.validateConfig(settings);
    const url = new URL(settings.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw failure();
  }
  const raw = input.key;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure();
  let key;
  if (['keep', 'clear'].includes(raw.action)) key = { action: raw.action };
  else if (raw.action === 'replace') {
    const value = field(raw.value, 16384);
    if (!value || /[\r\n]/.test(value)) throw failure();
    key = { action: 'replace', value };
  } else throw failure();
  return { settings, key };
}

class WorkbenchMainChat {
  constructor({ dataDir, repositoryRoot, safeStorage, fetch: fetchImpl, initialBackend = 'chat-api', sharedModules, memoryWorker } = {}) {
    this.dataDir = path.join(dataDir, 'main-chat');
    this.repositoryRoot = repositoryRoot;
    this.personasDir = path.join(this.dataDir, 'personas');
    this.configFile = path.join(this.dataDir, 'app-config.json');
    this.secretStore = new WorkbenchSecretStore(path.join(this.dataDir, 'secrets', 'chat-api-key.encrypted'), safeStorage);
    this.memorySecretStore = new WorkbenchSecretStore(path.join(this.dataDir, 'secrets', 'memory-api-key.encrypted'), safeStorage);
    this.memoryConfigFile = path.join(this.dataDir, 'memory-model.json');
    this.memoryWorker = memoryWorker;
    this.fetch = fetchImpl; this.initialBackend = BACKENDS.has(initialBackend) ? initialBackend : 'chat-api';
    this.shared = sharedModules; this.opened = null; this.listeners = new Set(); this.tail = Promise.resolve();
    this.closed = false; this.backend = this.initialBackend; this.configError = '';
  }
  serial(task) {
    const run = this.tail.then(task); this.tail = run.catch(() => {}); return run;
  }
  async start() {
    return this.serial(async () => {
      if (this.closed) throw new Error('聊天服务已关闭');
      this.shared ??= await loadSharedModules(this.repositoryRoot);
      fs.mkdirSync(this.personasDir, { recursive: true, mode: 0o700 });
      const personaFile = path.join(this.personasDir, PERSONA + '.json');
      if (!fs.existsSync(personaFile)) fs.copyFileSync(path.join(this.repositoryRoot, 'config/personas/bigfish.json'), personaFile, fs.constants.COPYFILE_EXCL);
      this.readConfig();
      const { WorkbenchMemory } = await import(pathToFileURL(path.join(this.repositoryRoot, 'apps/neko-workbench/memory/controller.mjs')).href);
      this.memorySystem = new WorkbenchMemory({directory:path.join(this.dataDir,'memory'),dataDir:this.dataDir,repositoryRoot:this.repositoryRoot,
        worker:this.memoryWorker,getModel:()=>this.memoryModel(),getPersona:async()=>{
          const persona=JSON.parse(fs.readFileSync(path.join(this.personasDir,PERSONA+'.json'),'utf8'));
          return {id:PERSONA,name:'大肥鱼',prompt:[persona.persona,...persona.boundaries].join('\n')};
        },getLegacy:async()=>this.opened?({items:await this.opened.memory?.list()||[],summaries:await this.opened.summaries?.list()||[],conversationId:this.opened.service.conversationId}):null,notify:()=>this.publish()});
      this.openNow();
      await this.memorySystem.localSync();
      if(this.backend==='chat-api')void this.memorySystem.connect().catch(()=>{});
      return this.read();
    });
  }
  readConfig() {
    this.configError = '';
    try {
      const value = fs.existsSync(this.configFile) ? JSON.parse(fs.readFileSync(this.configFile, 'utf8')) : {};
      if (value.backend !== undefined && !BACKENDS.has(value.backend)) throw failure();
      this.settings = this.shared.parseMainChatConfig(value.mainChat);
      if (this.settings.personaId !== PERSONA) throw failure();
      this.backend = value.backend || this.initialBackend;
    } catch {
      this.settings = this.shared.parseMainChatConfig({}); this.backend = 'chat-api';
      this.configError = '聊天配置无法读取，请重新保存设置';
    }
  }
  openNow() {
    if (this.closed) throw new Error('聊天服务已关闭');
    this.opened = this.shared.openMainChat({ settings: this.settings, personasDir: this.personasDir,
      dataDir: this.dataDir, secretStore: this.secretStore, ...(this.fetch ? { fetch: this.fetch } : {}),
      memoryContext:(personaId,query,budget,signal)=>this.memorySystem.recall(personaId,query,budget,signal),
      localMemoryProcessing:false,
      onTurnSaved:()=>this.memorySystem.recordTurn() });
    this.offState = this.opened.service.subscribe(() => this.publish());
    this.offMemory = this.opened.memory?.subscribe(() => this.publish());
    this.offSummaries = this.opened.summaries?.subscribe(() => this.publish());
    this.publish();
  }
  closeOpened() {
    const opened = this.opened; this.opened = null;
    this.offState?.(); this.offMemory?.(); this.offSummaries?.();
    this.offState = this.offMemory = this.offSummaries = null;
    opened?.service.cancel(); opened?.close();
  }
  read() {
    return clone({ backend: this.backend, settings: this.settings || null, hasKey: this.secretStore.has(),
      secureStorageAvailable: this.secretStore.available(), ready: !!this.opened, error: this.configError,
      memoryAvailable: this.backend === 'chat-api' && !!this.opened?.memory,
      memorySystem: this.memorySystem?.status(),
      voiceStatus: '未接入', chat: this.opened?.service.state() || { personaId: PERSONA, phase: 'idle' } });
  }
  subscribe(listener) { this.listeners.add(listener); listener(this.read()); return () => this.listeners.delete(listener); }
  publish() { for (const listener of this.listeners) { try { listener(this.read()); } catch {} } }
  cancel() { return this.opened?.service.cancel() || false; }
  async send(text) {
    if (this.closed || this.backend !== 'chat-api' || !this.opened) throw new Error('请先启用聊天 API');
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('请输入 1～8000 字的消息');
    return this.opened.service.send(text);
  }
  selectBackend(backend) {
    return this.serial(async () => {
      if (this.closed || !BACKENDS.has(backend)) throw new Error('聊天方式无效');
      try { atomicJson(this.configFile, { backend, mainChat: this.settings }); }
      catch { throw new Error('聊天方式未能保存，请检查本机存储'); }
      this.backend = backend; this.configError = ''; this.cancel();
      if(backend==='chat-api')void this.memorySystem?.connect().catch(()=>{});
      this.publish(); return this.read();
    });
  }
  saveApi(input) {
    return this.serial(async () => {
      if (this.closed || !this.shared) throw failure();
      let change;
      try { change = parseApiInput(input, this.shared); } catch { throw failure(); }
      const previous = fs.existsSync(this.configFile) ? fs.readFileSync(this.configFile) : null;
      const oldSettings = this.settings, oldBackend = this.backend, oldError = this.configError;
      const restoreSecret = await this.secretStore.prepareRollback();
      try {
        this.closeOpened();
        if(this.readMemoryModel().useChatApi)await this.memorySystem?.worker.stop();
        if (change.key.action === 'replace') await this.secretStore.set(change.key.value);
        else if (change.key.action === 'clear') await this.secretStore.clear();
        if (this.closed) throw failure();
        this.settings = change.settings; this.backend = 'chat-api'; this.configError = '';
        atomicJson(this.configFile, { backend: this.backend, mainChat: this.settings });
        this.openNow();
      } catch {
        this.closeOpened();
        try {
          await restoreSecret();
          if (previous === null) fs.rmSync(this.configFile, { force: true }); else atomicBytes(this.configFile, previous);
          this.settings = oldSettings; this.backend = oldBackend; this.configError = oldError;
          if (!this.closed) this.openNow();
        } catch { this.configError = '聊天配置恢复失败，请重新保存设置'; }
        this.publish(); throw failure();
      }
      void this.memorySystem?.connect().catch(()=>{});
      this.publish(); return this.read();
    });
  }
  async history() {
    if (!this.opened || this.closed) throw new Error('聊天记录暂不可用');
    const store = new this.shared.SqliteConversationStore(path.join(this.dataDir, 'conversations.sqlite'));
    try { return await store.recent(PERSONA, this.opened.service.conversationId, 200); }
    finally { store.close(); }
  }
  async memories() {
    if (this.closed || this.backend !== 'chat-api' || !this.opened?.memory) throw new Error('请在聊天 API 模式管理 N.E.K.O. 记忆');
    const [items, summaries] = await Promise.all([this.opened.memory.list(), this.opened.summaries?.list() || []]);
    return { items: items.map(({ audioRef, ...item }) => item), summaries, replication:await this.memorySystem.view(),
      memoryModel:this.readMemoryModel() };
  }
  readMemoryModel() {
    let settings={useChatApi:true};
    if(fs.existsSync(this.memoryConfigFile))settings=JSON.parse(fs.readFileSync(this.memoryConfigFile,'utf8'));
    return {...settings,hasKey:this.memorySecretStore.has()};
  }
  async memoryModel() {
    const config=this.readMemoryModel(),settings=config.useChatApi?this.settings:config;
    this.shared.validateConfig(settings);
    return {...settings,apiKey:await (config.useChatApi?this.secretStore:this.memorySecretStore).get()};
  }
  async configureMemory(input) {
    if(input.enabled===false)throw new Error('当前统一使用 N.E.K.O. 记忆');
    if(typeof input.useChatApi!=='boolean')throw new Error('请选择记忆整理模型');
    let config={useChatApi:true};
    const rollback=await this.memorySecretStore.prepareRollback(),previous=fs.existsSync(this.memoryConfigFile)?fs.readFileSync(this.memoryConfigFile):null;
    try{
      if(!input.useChatApi){
        const change=parseApiInput({...input,maxOutputTokens:1024},this.shared);
        if(change.key.action==='replace')await this.memorySecretStore.set(change.key.value);
        else if(change.key.action==='clear')await this.memorySecretStore.clear();
        config={...change.settings,useChatApi:false};
      }
      atomicJson(this.memoryConfigFile,config);
    }catch{
      await rollback();if(previous===null)fs.rmSync(this.memoryConfigFile,{force:true});else atomicBytes(this.memoryConfigFile,previous);throw new Error('记忆模型设置未能保存');
    }
    await this.memorySystem.activeSync?.catch(()=>{});
    await this.memorySystem.worker.stop();
    return this.memorySystem.connect();
  }
  async memoryAction(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['action', 'id', 'text','mode','enabled','revisionIds','useChatApi','protocol','baseUrl','model','requestTimeoutMs','key'].includes(key))) throw new Error('记忆操作无效');
    if (this.closed || this.backend !== 'chat-api' || !this.opened?.memory) throw new Error('记忆服务未就绪');
    if(['configure-neko','sync'].includes(input.action)||String(input.action).startsWith('event-')){
      try{
        if(input.action==='configure-neko')await this.configureMemory(input);
        else if(input.action==='sync')await this.memorySystem.sync();
        else await this.memorySystem.change(input);
        return {ok:true,...await this.memories()};
      }catch{return {ok:false,message:this.memorySystem.status().error||'记忆操作未完成，请刷新后重试',...await this.memories()};}
    }
    const { action } = input, id = field(input.id, 200);
    if (!id) throw new Error('记忆操作无效');
    if (action === 'confirm') await this.opened.memory.confirm(id);
    else if (action === 'update') await this.opened.memory.update(id, field(input.text, 500));
    else if (action === 'remove') await this.opened.memory.remove(id);
    else if (action === 'remove-summary') await this.opened.summaries.remove(id);
    else if (action === 'sources') return (await this.opened.summaries.sources(id)).map(item => ({ ...item, text: item.text.slice(0, 4000) }));
    else throw new Error('记忆操作无效');
    await this.memorySystem.localSync();
    if(this.memorySystem.settings.autoSync)void this.memorySystem.sync().catch(()=>{});
    return this.memories();
  }
  close() { this.closed = true; this.cancel(); return this.serial(async () => { await this.memorySystem?.close(); this.closeOpened(); this.listeners.clear(); }); }
}

function trustedLocalCaller(event, window, expectedUrl) {
  return !!window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === expectedUrl
    && window.webContents.getURL() === expectedUrl;
}

module.exports = { WorkbenchMainChat, loadSharedModules, parseApiInput, trustedLocalCaller, PERSONA };
