const {app,BrowserWindow,WebContentsView,ipcMain,screen,shell,Menu,Tray,nativeImage,dialog,nativeTheme,safeStorage,clipboard,desktopCapturer,systemPreferences} = require('electron');
const {spawn} = require('node:child_process');
const {resolveRuntimePaths,prepareRuntimeDirectories,assertDshRuntime,buildDshPatch,buildDshLaunch}=require('./runtime-config.cjs');
const {createDshLifecycle}=require('./dsh-lifecycle.cjs');
const {chatReply}=require('./vendor/dsh-qqbot-workbench/chat-policy.cjs');
const {createSocialController}=require('./community-config.cjs');
const {createNativeDividerController}=require('./native-divider-controller.cjs');
const {createNativeComposerController}=require('./native-composer-controller.cjs');
const {workbenchWindowOptions,updateWorkbenchWindowTheme}=require('./workbench-window.cjs');
const {createVideoFloatController}=require('./video-float-controller.cjs');
const {createDshLoginBrowser}=require('./dsh-login-browser.cjs');
const {createAgentQuestionRelay}=require('./agent-question-relay.cjs');
const {createPetQuestionController}=require('./pet-question-controller.cjs');
const {createDshLoopbackCookieFilter}=require('./dsh-loopback-cookie-filter.cjs');
const {createYuiHomeIpc}=require('./yui-home-ipc.cjs');
const {createOurHomeRuntime}=require('./our-home-runtime.cjs');
const {createCommunityAccount}=require('./community-account.cjs');
const {createUnifiedNekoLogin}=require('./unified-neko-login.cjs');
const {createNekoSsoWindow}=require('./neko-sso-window.cjs');
const {WorkbenchSecretStore,atomicBytes}=require('./main-chat-secret.cjs');
const {createWeixinClawBot}=require('./weixin-clawbot.cjs');
const {createSubagentMotion,motionOptions}=require('./subagent-motion.cjs');
const {createScreenShare}=require('./screen-share-controller.cjs');
const {WorkbenchMainChat,trustedLocalCaller,PERSONA}=require('./main-chat-runtime.cjs');
const {createMemoryViewer}=require('./memory-viewer.cjs');
const {createCompanionAccountProvider}=require('./companion-account-provider.cjs');
const {createFeedback}=require('./feedback.cjs');
const feedback=createFeedback({openExternal:url=>shell.openExternal(url),copyText:text=>clipboard.writeText(text)});
const usesMainChatService=backend=>backend==='chat-api'||backend==='deepseek-account';
const {createVisitsController}=require('./visits/controller.cjs');
const {createRtcTransport}=require('./visits/rtc-transport.cjs');
const {pathToFileURL}=require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {writeAtomicStateFileSync}=require('./atomic-state-file.cjs');
const readline = require('node:readline');
const originalWork = require('./original/work-status.cjs');
const {normalizeLimit,orderedHelpers,displayName,nickname,actorKind,desktopHomeId,orderedDesktopPets,orderedTaskPets,selectDesktopPets,nextDesktopRefreshAt,beginReturnHome,expireReturnHomes}=require('./pet-roster.cjs');
const {readOriginalSize,petLayout,petPlacement}=require('./pet-layout.cjs');
const {migrateChatRouting,actorBySession:findDshActor}=require('./chat-routing.cjs');
const petAppearance=require('./pet-appearance.js');
const {importAppearanceImage}=require('./pet-appearance-import.cjs');
const {decodeAnimationPoster}=require('./pet-image-decoder.cjs');
const {prepareFishCare}=require('./fish-care.cjs');
const {createChannelLife}=require('./channel-life.cjs');
const {createCommunityDaily}=require('./community-daily.cjs');
const {createCoordinator}=require('./fish-qq-coordinator.cjs');
const {restoreDesktopActor,syncTaskRecord,acceptTaskRoster,promoteTaskRecord}=require('./task-pets.cjs');
const {NekoChat,localBase}=require('./neko-chat.cjs');
const {skinPatch,applySkinCookie}=require('./embedded-dsh/dsh-skin-patch.cjs');
const {createAppearanceStore}=require('./workbench-appearance.cjs');
const {createRolesStore}=require('./workbench-roles.cjs');
const {createWorkspaceLayout}=require('./workspace-layout.cjs');
const {createPaneLayout}=require('./pane-layout.cjs');
const {createVideoPlatform}=require('./video-platform.cjs');
const {createWorkspaceController,companionSnapshot}=require('./workspace-controller.cjs');
const {createCodexWorkspace}=require('./codex-workspace.cjs');
const {createCodexModelChoices}=require('./codex-model-choices.cjs');
const {createCodexAccountService}=require('./codex-account.cjs');
const {CODEX_AVAILABLE,assertCodexActionAllowed}=require('./codex-availability.cjs');
const codexAccount=createCodexAccountService();
let dshSkin=null;
const dshCookieFilter=createDshLoopbackCookieFilter();
let visitsWindow,visitsController;
let communityDailySettingsWindow;
const workbenchOnly=process.env.PET_WORKBENCH_ONLY==='1'; // Local visual QA only; normal launches show every pet.
const {cleanPrompt,humanMessage,activity,acceptHuman}=require('./pet-context.js');
const base=__dirname, runtimePaths=resolveRuntimePaths({baseDir:base});
prepareRuntimeDirectories(runtimePaths);
const data=runtimePaths.dataDir,workspace=runtimePaths.workspaceDir;
const workbenchAppearance=createAppearanceStore(path.join(data,'workbench-appearance.json'));
const workbenchRoles=createRolesStore(path.join(data,'workbench-roles.json'));
const memoryViewer=createMemoryViewer({getRuntime:()=>mainChatRuntime,getRoles:()=>workbenchRoles.get()});
const workspaceLayout=createWorkspaceLayout(path.join(data,'workspace-layout.json'));
const paneLayout=createPaneLayout(path.join(data,'pane-layout.json'));
const videoPlatform=createVideoPlatform(path.join(data,'video-platform.json'));
const codexModelChoices=createCodexModelChoices(path.join(data,'codex-model-choices.json'));
let workspaceRevision=0, codexHadActiveWork=false;
const codexWorkspace=createCodexWorkspace({defaultCwd:workspace,onState:value=>{
  if(dshWindow&&!dshWindow.isDestroyed()&&isWorkbenchOrigin(dshWindow.webContents.getURL()))dshWindow.webContents.send('workbench:office-state',value);
  const active=value.status==='working'||!!value.approvals?.length;
  if(!CODEX_AVAILABLE&&active!==codexHadActiveWork){codexHadActiveWork=active;workspaceRevision++;broadcast();}
}});
const workspaceController=createWorkspaceController({layout:workspaceLayout,codex:codexWorkspace,readDsh:params=>{
  if(state.connection!=='ready')throw Error('DSH 尚未就绪');return rpc('workspace-catalog',params);
}});
app.setName('N.E.K.O. 桌宠工作台');
app.setPath('userData',runtimePaths.userDataDir);
if(!globalThis.__nekoTrialInstanceLocked&&!app.requestSingleInstanceLock())app.quit();
let state={version:3,rootId:null,memory:[],diary:[],preferences:{helpersVisible:true},positions:{},actors:[
  {id:'main',name:'大肥鱼',sessionId:null,status:'idle',present:true,messages:[]}
]};
try {state={...state,...JSON.parse(fs.readFileSync(path.join(data,'state.json'),'utf8'))};}catch{}
state.version=5;state.preferences=petAppearance.normalizePreferences({helpersVisible:true,...state.preferences});state.preferences.helperLimit=normalizeLimit(state.preferences.helperLimit);state.positions||={};state.catalogOrder=[];state.taskOrder=[];
state.originalPet=readOriginalSize(data);
state.actors=state.actors.filter(a=>a.id==='main'||a.sessionId).map(a=>{
  if(petAppearance.valid(a.appearanceId))a.appearanceId=petAppearance.normalizeId(a.appearanceId);
  if(a.id!=='main'){
    a=restoreDesktopActor(a,state.positions);a.name=displayName(a);
  }else a.present=true;
  if(['working','stopping'].includes(a.status))a.status='stopped';
  return {...a,screenReply:undefined,active:false,teamWork:undefined,displayWork:undefined,notice:null,stopRequested:false,work:{state:null,task:null,tick:0},workFlags:{goalRound:false,closing:null}};
});
migrateChatRouting(state);
state.connection='starting';state.error='';
state.fish={enabled:false,phase:'paused',reason:'已暂停'};
state.qqbot={enabled:false,phase:'paused',reason:'QQ 机器人已暂停。',bound:false,connected:false,scopeConfigured:false};
let memoryWindow,settingsWindow,nekoSettingsWindow,chatSettingsWindow,chatMemoryWindow,nekoWindow,dshWindow,dshLaunchUrl,tray,child,childLifecycle,quitting=false,rpcId=0,startPromise,stderr='',rosterTimer,nekoRetry,mainChatRuntime,activeApiRequest,workbenchNavigation=null,questionRelay,petQuestionController;
const localWindows=new WeakMap();
const nekoChat=new NekoChat();
let communityAccount,unifiedNekoLogin;
function publishNekoAccount(){if(dshWindow&&!dshWindow.isDestroyed()&&isWorkbenchOrigin(dshWindow.webContents.getURL()))dshWindow.webContents.send('workbench:neko-account-state',nekoAccountSnapshot());}
const nekoSsoWindow=createNekoSsoWindow({BrowserWindow,getParent:()=>dshWindow,openExternal:url=>shell.openExternal(url),onCancel:()=>unifiedNekoLogin?.cancel()});
const nativeDividerController=createNativeDividerController({WebContentsView,ipcMain});
const nativeComposerController=createNativeComposerController({WebContentsView,BrowserWindow,screen,ipcMain});
const communityController=createSocialController({WebContentsView,openExternal:url=>shell.openExternal(url),copyText:text=>clipboard.writeText(text),
  onHide:()=>communityAccount?.cancel(),
  onAccountState:value=>{unifiedNekoLogin?.communityChanged(value);publishNekoAccount();},
  onState:(host,value)=>{if(host===dshWindow&&!host.isDestroyed()&&isWorkbenchOrigin(host.webContents.getURL())){host.webContents.send('workbench:community-state',value);nativeDividerController.setEnabled(communityController.hasVisibleView);nativeDividerController.raise(value.status==='ready');nativeComposerController.raise();}},
  onExternalError:()=>dialog.showErrorBox('链接未打开','系统浏览器未能打开这个链接，请稍后重试。')});
const videoFloatController=createVideoFloatController({BrowserWindow,WebContentsView,ipcMain,screen,shell,clipboard});
const dshLoginBrowser=createDshLoginBrowser({openExternal:url=>shell.openExternal(url),onError:message=>{if(dshWindow&&!dshWindow.isDestroyed())void dialog.showMessageBox(dshWindow,{type:'info',title:'DSH 登录',message,buttons:['好']}).catch(()=>{});}});
communityAccount=createCommunityAccount({getBaseUrl:()=>state.neko.baseUrl,
  getCommunityUrl:()=>process.env.NEKO_WORKBENCH_COMMUNITY_URL,
  openExternal:url=>shell.openExternal(url),handoff:url=>communityController.handoff(dshWindow,url),
  onState:value=>{if(dshWindow&&!dshWindow.isDestroyed()&&isWorkbenchOrigin(dshWindow.webContents.getURL()))dshWindow.webContents.send('workbench:community-account-state',value);}});
// Public lobby (频道). Optional and contained: a missing module, bad config or any lobby failure leaves a
// no-op controller, so workbench:companion and the private chat never depend on it.
const lobbyOffline=Object.freeze({request:async()=>({ok:false,error:'频道暂不可用',state:null}),snapshot:()=>null,refresh(){},processPending(){},dispose(){}});
function createLobby(){
  try{
    const {createLobbyController}=require('./lobby-controller.cjs'),{providerGetter,readWorkbenchPersona}=require('./lobby-cat.cjs');
    const chatApi=()=>usesMainChatService(mainChatRuntime?.backend)&&!mainChatRuntime.closed?mainChatRuntime:null;
    return createLobbyController({env:process.env,dataDir:path.join(data,'lobby'),
      secretStore:new WorkbenchSecretStore(path.join(data,'lobby','secrets','refresh-token.encrypted'),safeStorage),
      openExternal:url=>nekoSsoWindow.open(url),
      getChatProvider:()=>{const runtime=chatApi();return providerGetter({runtime,createChatApiProvider:runtime?.shared?.createChatApiProvider})();},
      getChatProviderState:()=>chatApi()?.lobbyProviderState(),
      getPersona:id=>{const runtime=chatApi();return runtime&&id===PERSONA?readWorkbenchPersona(path.join(runtime.personasDir,PERSONA+'.json')):null;},
      recallMemory:async(query,budget,signal)=>{const memory=chatApi()?.lobbyMemory();return memory?memory.recall(query,budget,signal):[];},
      recordSharedExperience:async entry=>{const memory=chatApi()?.lobbyMemory();if(!memory)throw new Error('大厅记忆仅在主聊天模式可用');return memory.recordSharedExperience(entry);},
      onState:value=>{if(dshWindow&&!dshWindow.isDestroyed()&&isWorkbenchOrigin(dshWindow.webContents.getURL()))dshWindow.webContents.send('workbench:lobby-state',value);unifiedNekoLogin?.lobbyChanged();publishNekoAccount();}});
  }catch{return lobbyOffline;}
}
const lobbyController=createLobby();
unifiedNekoLogin=createUnifiedNekoLogin({getCommunity:()=>communityController.accountState,getLobby:()=>lobbyController.snapshot(),requestCommunityLogin:()=>communityController.requestLogin(),cancelCommunityLogin:()=>communityController.cancelLoginRequest(),
  signInLobby:()=>lobbyController.request({action:'sign-in'}),reauthorizeLobby:()=>lobbyController.reauthorize?.()||Promise.resolve({ok:false}),verifyLobbyIdentity:()=>lobbyController.verifyIdentity?.()||Promise.resolve(null),
  cancelLobby:()=>lobbyController.request({action:'sign-in-cancel'}),closeAuthorization:()=>nekoSsoWindow.close(),onState:()=>publishNekoAccount()});
const pending=new Map(), petWindows=new Map(),renameWindows=new Map();
const draggingPets=new Set(),petGeometry=new Map();
const motionInputs=new Set();
const catMotion=createSubagentMotion({
  getHome:id=>{const actor=state.actors.find(a=>a.id===id),homeId=desktopHomeId(actor,state.actors);let home=state.actors.find(a=>a.id===homeId),w=petWindows.get(homeId);if(!w||w.isDestroyed()||!w.isVisible()){home=state.actors.find(a=>a.id==='main');w=petWindows.get('main');}if(!w||w.isDestroyed())return null;const bounds=windowBounds(w);return {...bounds,anchorId:home.id,body:motionBody(home,w,bounds)};},
  getArea:bounds=>screen.getDisplayMatching?.(bounds)?.workArea||screen.getPrimaryDisplay().workArea,
  getCursor:()=>screen.getCursorScreenPoint?.(),reducedMotion:()=>nativeTheme.shouldUseReducedMotion===true,
  isPaused:id=>draggingPets.has(id)||motionInputs.has(id)||petQuestionController?.isOpen(id),
  onPose:(id,value)=>{const w=petWindows.get(id);if(w&&!w.isDestroyed())w.webContents.send('pet:motion',value);},
  onForeground:keepMainInFront,
  onReturned:id=>{const a=state.actors.find(a=>a.id===id);if(a&&!a.active&&a.returningHome){a.returningHome=false;a.displayUntil=0;update();}}
});
const earlyFrames=new Map();
const terminalTimers=new Map();
const busy=a=>['working','stopping'].includes(a.status);
const screenShare=createScreenShare({WebContentsView,desktopCapturer,systemPreferences,dataDir:data,repositoryRoot:path.resolve(base,'../..'),safeStorage,
  getChat:()=>mainChatRuntime,getHost:()=>dshWindow,isChatBusy:()=>!!activeApiRequest||busy(state.actors[0]),
  onReply:reply=>{if(quitting)return;state.actors[0].screenReply=reply;if(reply)state.actors[0].notice=null;broadcast();},
  onOpen:async()=>{await communityController.action(dshWindow,{action:'hide'});}});
const channelRevisions={fish:0,qqbot:0};
const channelIntents={fish:0,qqbot:0};
const fishQqCoordinator=createCoordinator({
  fishAction:action=>channelAction('fish',action),
  qqbotAction:action=>channelAction('qqbot',action),
  getSelection:()=>state.preferences.fishQqSelection,
  saveSelection:selection=>{const previous=state.preferences.fishQqSelection;state.preferences.fishQqSelection=selection;try{save();}catch(error){state.preferences.fishQqSelection=previous;throw error;}},
  notify:()=>broadcast()
});
const channelLife=createChannelLife({dataDir:data,fishLog:path.join(workspace,'fish-care/profile/whale-log.jsonl'),
  getMemory:()=>usesMainChatService(mainChatRuntime?.backend)?mainChatRuntime?.memorySystem:null,
  isBusy:()=>quitting||!!activeApiRequest||state.actors.some(a=>busy(a))||(state.dshRoot&&busy(state.dshRoot))||motionInputs.has('main')||screenShare.read().phase==='sharing'||workbenchOnly||(mainChatRuntime?.backend==='deepseek-account'&&state.connection!=='ready'),
  generate:(entry,signal)=>mainChatRuntime.generateProactive(entry,signal),
  present:reply=>{if(quitting)return;const a=state.actors[0];a.notice=null;a.screenReply=null;a.chatReply={id:reply.id,text:reply.text,streaming:false,proactive:true};a.messages.push({id:reply.id,role:'assistant',text:reply.text,time:Date.now(),proactive:true});broadcast();const w=createPetWindow(a);if(!workbenchOnly){if(w.isMinimized?.())w.restore();if(!w.webContents.isLoading())w.showInactive();}}
});
function save(){const f=path.join(data,'state.json');const actors=state.actors.map(a=>a.id==='main'&&usesMainChatService(a.chatBackend)?{...a,messages:[],chatReply:undefined,lastUserMessage:undefined}:a).map(a=>({...a,screenReply:undefined,returningHome:undefined}));writeAtomicStateFileSync(f,JSON.stringify({...state,actors,mainChat:undefined,connection:undefined},null,2));}
const communityDaily=createCommunityDaily({dataDir:data,
  getIdentity:()=>visitsController?.communityIdentity()||null,
  getInteractions:()=>mainChatRuntime.history(),
  generate:(rows,signal,options)=>mainChatRuntime.generateCommunityDaily(rows,signal,options),
  publish:request=>visitsController.publishDaily(request),
  isBusy:()=>quitting||workbenchOnly||!usesMainChatService(mainChatRuntime?.backend)||(mainChatRuntime?.backend==='deepseek-account'&&state.connection!=='ready')||!!activeApiRequest||!!mainChatRuntime?.proactiveAbort||busy(state.actors[0])||motionInputs.has('main')||screenShare.read().phase==='sharing'||mainChatRuntime?.opened?.service.state().phase==='replying'||channelLife.status().generating
});
questionRelay=createAgentQuestionRelay({getHost:()=>dshWindow,getSessionId:id=>id!=='main'?state.actors.find(a=>a.id===id)?.sessionId:null,onChange:()=>publishPetQuestions()});
petQuestionController=createPetQuestionController({BrowserWindow,screen,ipcMain,request:(id,value)=>questionRelay.request(id,value)});
function publishPetQuestions(){if(!questionRelay||!petQuestionController)return;for(const [id,w] of petWindows)if(w&&!w.isDestroyed()&&localWindows.has(w))petQuestionController.sync(id,w,questionRelay.forActor(id));}
function broadcast(){for(const w of [...petWindows.values(),...renameWindows.values(),memoryWindow,settingsWindow,nekoSettingsWindow,chatSettingsWindow,chatMemoryWindow])if(w&&!w.isDestroyed()&&localWindows.has(w))w.webContents.send('pet:state',state);publishPetQuestions();if(dshWindow&&!dshWindow.isDestroyed()&&isWorkbenchOrigin(dshWindow.webContents.getURL()))dshWindow.webContents.send('workbench:state',workbenchState());}
function loadLocalFile(window,query){const url=pathToFileURL(path.join(base,'index.html'));for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);localWindows.set(window,url.href);window.webContents.on('will-navigate',(event,target)=>{if(target!==url.href)event.preventDefault();});window.webContents.setWindowOpenHandler(()=>({action:'deny'}));return window.loadURL(url.href);}
function assertLocalCaller(event,window){if(!trustedLocalCaller(event,window,localWindows.get(window)))throw new Error('请从本应用的原始窗口操作');}
function editCommunityDailySettings(){
  if(communityDailySettingsWindow&&!communityDailySettingsWindow.isDestroyed()){communityDailySettingsWindow.show();communityDailySettingsWindow.focus();return;}
  const w=new BrowserWindow({width:520,height:540,minWidth:420,minHeight:460,title:'社区日常设置',show:false,backgroundColor:'#f7fbff',webPreferences:{preload:path.join(base,'community-daily-settings-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  communityDailySettingsWindow=w;const url=pathToFileURL(path.join(base,'community-daily-settings.html')).href;localWindows.set(w,url);
  w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',event=>event.preventDefault());
  w.webContents.on('did-finish-load',()=>w.show());w.on('closed',()=>{localWindows.delete(w);if(communityDailySettingsWindow===w)communityDailySettingsWindow=null;});void w.loadURL(url).catch(()=>{if(!w.isDestroyed())w.destroy();});
}
ipcMain.handle('workbench:community-daily-settings',async(event,action,payload)=>{
  assertLocalCaller(event,communityDailySettingsWindow);
  if(action==='read')return communityDaily.status();
  if(action==='save'){communityDaily.saveSettings(payload);return communityDaily.status();}
  throw Error('未知社区日常设置操作');
});
function ensureVisitsController(){
  return visitsController??=createVisitsController({dataDir:data,repositoryRoot:path.resolve(base,'../..'),safeStorage,
    openExternal:url=>shell.openExternal(url),getModelConfig:()=>mainChatRuntime?.read().settings,
    getModelSecret:()=>mainChatRuntime?.secretStore.get(),
    createTransport:(grant,signal)=>createRtcTransport({BrowserWindow,ipcMain,grant,signal}),
    config:{baseUrl:process.env.NEKO_VISIT_COMMUNITY_URL,authorizationUrl:process.env.NEKO_VISIT_AUTHORIZATION_URL,
      tokenUrl:process.env.NEKO_VISIT_TOKEN_URL,clientId:process.env.NEKO_VISIT_OAUTH_CLIENT_ID,redirectUri:process.env.NEKO_VISIT_REDIRECT_URI},
    onChange:snapshot=>{if(visitsWindow&&!visitsWindow.isDestroyed())visitsWindow.webContents.send('workbench:visits-state',snapshot);}});
}
function openVisits(){
  if(visitsWindow&&!visitsWindow.isDestroyed()){visitsWindow.show();visitsWindow.focus();return;}
  try{ensureVisitsController();}catch{dialog.showErrorBox('串门暂不可用','请检查串门服务配置与本机存储。配置说明：docs/TEXT_VISITS.md');return;}
  void visitsController.initialize().catch(()=>{});
  const w=new BrowserWindow({width:1040,height:760,minWidth:700,minHeight:520,title:'猫娘串门',show:false,
    backgroundColor:'#edf5fb',webPreferences:{preload:path.join(base,'visits/panel-preload.cjs'),sandbox:true,
      contextIsolation:true,nodeIntegration:false,webSecurity:true,partition:'neko-visits-panel'}});
  visitsWindow=w;
  const url=pathToFileURL(path.join(base,'visits/panel.html')).href;localWindows.set(w,url);
  w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  w.webContents.on('will-navigate',event=>event.preventDefault());
  w.webContents.on('will-attach-webview',event=>event.preventDefault());
  w.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  w.webContents.session.setPermissionCheckHandler(()=>false);
  w.webContents.on('did-finish-load',()=>{w.webContents.send('workbench:visits-state',visitsController.snapshot());w.show();});
  w.on('closed',()=>{if(visitsWindow===w)visitsWindow=null;void visitsController?.action({action:'stop'}).catch(()=>{});});
  void w.loadURL(url).catch(()=>{if(!w.isDestroyed())w.destroy();});
}
ipcMain.handle('workbench:visits',async(event,payload)=>{
  assertLocalCaller(event,visitsWindow);
  if(!visitsController||!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('串门操作无效');
  // The controller returns a public projection; secrets and raw service errors stay in main.
  try{return await visitsController.action(payload);}catch{throw new Error('串门操作未完成，请检查设置后重试');}
});
function isWorkbenchOrigin(candidate){try{const target=new URL(candidate),launch=new URL(dshLaunchUrl);return launch.protocol==='http:'&&launch.hostname==='127.0.0.1'&&target.origin===launch.origin;}catch{return false;}}
function assertWorkbenchCaller(event){if(!dshWindow||dshWindow.isDestroyed()||event.sender!==dshWindow.webContents||event.senderFrame!==event.sender.mainFrame||!isWorkbenchOrigin(event.senderFrame?.url))throw new Error('请从工作台操作');}
function rolesState(){return {...workbenchRoles.get(),workspaceSessionId:state.dshRoot?.sessionId??null};}
function publishRoles(){if(dshWindow&&!dshWindow.isDestroyed()&&isWorkbenchOrigin(dshWindow.webContents.getURL()))dshWindow.webContents.send('workbench:roles-state',rolesState());}
async function chooseAvatar(title='上传工作台头像'){
  const result=await dialog.showOpenDialog(dshWindow,{title,buttonLabel:'使用这张图片',properties:['openFile'],filters:[{name:'头像图片',extensions:['png','jpg','jpeg','webp']}]});
  if(result.canceled||!result.filePaths[0])return null;
  const file=result.filePaths[0];if(!/\.(png|jpe?g|webp)$/i.test(file)||fs.statSync(file).size>12*1024*1024)throw new Error('请选择 12 MB 以内的 PNG、JPEG 或 WebP 图片');
  const image=nativeImage.createFromPath(file);if(image.isEmpty())throw new Error('无法读取这张图片');
  const size=image.getSize();if(size.width>8192||size.height>8192)throw new Error('图片尺寸过大，请使用 8192 像素以内的图片');
  const side=Math.min(size.width,size.height),png=image.crop({x:Math.floor((size.width-side)/2),y:Math.floor((size.height-side)/2),width:side,height:side}).resize({width:256,height:256,quality:'best'}).toPNG();
  return 'data:image/png;base64,'+png.toString('base64');
}
const weixinSyncPath=path.join(data,'weixin','sync.json');
const weixinClawBot=createWeixinClawBot({
  secretStore:new WorkbenchSecretStore(path.join(data,'secrets','weixin-clawbot.encrypted'),safeStorage),
  syncStore:{
    read(){try{return JSON.parse(fs.readFileSync(weixinSyncPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;return null;}},
    write(value){atomicBytes(weixinSyncPath,Buffer.from(JSON.stringify(value)));},
  },
  onMessage:text=>replyToChannelMessage(text,'wechat'),
  onChange:broadcast,
});
function workbenchState(){return {avatar:workbenchAppearance.get(),workspaceRoot:workspace,workspaceRevision,companion:companionSnapshot(state),navigation:workbenchNavigation,fish:state.fish,qqbot:state.qqbot,fishQq:fishQqCoordinator.snapshot(),weixin:weixinClawBot.snapshot(),neko:{enabled:state.neko.enabled===true,connection:state.neko.connection,character:state.neko.character,error:String(state.neko.error||'').slice(0,300)},workbench:{connection:state.connection,error:String(state.error||'').slice(0,300)}};}
async function openFishSettings(){screenShare.hide();workbenchNavigation={...workbenchNavigation,fishSettingsRevision:(workbenchNavigation?.fishSettingsRevision||0)+1};await openDsh();await communityController.action(dshWindow,{action:'hide'});broadcast();}
function projectChannelState(name,value){
  const phases=['paused','checking','starting','login-required','model-login-required','scope-required','bound','connecting','running','error'];
  const next={enabled:value?.enabled===true,phase:phases.includes(value?.phase)?value.phase:'error',reason:String(value?.reason||'服务状态无法确认，请重试。').slice(0,300)};
  if(name==='qqbot')Object.assign(next,{bound:value?.bound===true,connected:value?.connected===true,scopeConfigured:value?.scopeConfigured===true});
  return next;
}
function acceptChannelState(name,value){
  const next=projectChannelState(name,value);
  channelRevisions[name]++;state[name]=next;fishQqCoordinator.updateChannel(name,next);return next;
}
async function channelAction(name,action){
  if(!['status','start','pause'].includes(action))throw Error('未知渠道操作');
  if(action==='pause')channelIntents[name]++;
  if(state.connection!=='ready')throw Error('工作台尚未连接，请稍后重试。');
  // An older initial status response must not invalidate a newer user action.
  // Advance when the action is issued, then allow genuinely newer channel
  // notifications or actions to supersede its eventual RPC response.
  if(action!=='status')channelRevisions[name]++;
  const revision=channelRevisions[name];
  const value=await rpc(name==='fish'?'fish-care':'qqbot-care',{action});
  if(action==='status')return revision===channelRevisions[name]?projectChannelState(name,value):{...state[name]};
  if(revision===channelRevisions[name])acceptChannelState(name,value);
  return {...state[name]};
}
async function fishAction(action){
  if(!['status','start','pause'].includes(action))throw Error('未知养鱼操作');
  if(action==='start'){const intent=channelIntents.fish;await fishQqCoordinator.setSelection({fish:true});if(intent!==channelIntents.fish)return {...state.fish};}
  const value=await channelAction('fish',action);
  if(action==='start'&&['login-required','model-login-required','error'].includes(value.phase))await openFishSettings();
  return value;
}
async function qqbotAction(action){
  if(!['status','start','pause'].includes(action))throw Error('未知 QQ 机器人操作');
  if(action==='start'){const intent=channelIntents.qqbot;await fishQqCoordinator.setSelection({qqbot:true});if(intent!==channelIntents.qqbot)return {...state.qqbot};}
  return channelAction('qqbot',action);
}
async function fishQqAction(request){
  if(!request||!['status','start','pause','select'].includes(request.action))throw Error('未知养鱼与 QQ 操作');
  if(request.action==='select')return fishQqCoordinator.setSelection(request.selection);
  if(request.action==='status')return fishQqCoordinator.status();
  if(request.action==='pause')return fishQqCoordinator.pause();
  const pendingStart=fishQqCoordinator.start();
  const [result]=await Promise.all([pendingStart,openFishSettings()]);
  return result;
}
function fishQqActive(){const value=fishQqCoordinator.snapshot();return value.unified||['fish','qqbot'].some(name=>value.selection[name]&&(value[name].enabled||['checking','starting','login-required','model-login-required','scope-required','bound','connecting'].includes(value[name].phase)));}
function showConnectionStatus(){return dialog.showMessageBox(dshWindow&&!dshWindow.isDestroyed()?dshWindow:petWindows.get('main'),{type:'info',message:'N.E.K.O.：'+(state.neko.connection==='ready'?'已连接':'未连接')+' · 工作台：'+(state.connection==='ready'?'已连接':'未连接'),detail:[state.neko.error,state.error].filter(Boolean).join('\n')||'主角色聊天与工作台任务分别连接。',buttons:['好']});}
async function workbenchAction(name){
  switch(name){
    case 'fish-settings':await openFishSettings();break;
    case 'screen-share':await openDsh();await screenShare.open();break;
    case 'open-companion-chat':showInput();break;
    case 'chat-settings':editChatSettings();break;
    case 'chat-memory':editChatMemory();break;
    case 'open-visits':openVisits();break;
    case 'open-community':throw new Error('请使用工作台社区入口打开内嵌社区');
    case 'neko-settings':editChatSettings();break;
    case 'open-neko':await openNeko();break;
    case 'task-notes':editMemory();break;
    case 'connect-neko':if(!mainChatRuntime)throw new Error('聊天服务尚未就绪');await mainChatRuntime.selectBackend('neko');activeApiRequest=null;state.neko.enabled=true;await connectNeko();if(state.neko.connection!=='ready')throw new Error(state.neko.error||'N.E.K.O. 服务尚未连接');break;
    case 'connection-status':showConnectionStatus();break;
    case 'reconnect-workbench':restart();break;
    default:throw new Error('未知工作台选项');
  }
  return {ok:true};
}
function workbenchOptions(){return [
  {label:'屏幕陪伴…',click:()=>workbenchAction('screen-share').catch(error=>{notice(state.actors[0],error.message);broadcast();})},
  {label:'猫娘串门…',click:openVisits},
  {label:'养鱼设置…',click:()=>openFishSettings().catch(engineError)},
  {label:'聊天 API 设置…',click:editChatSettings},
  {label:'鱼的记忆',click:editChatMemory},
  {label:'N.E.K.O. 聊天设置…',click:editNekoSettings},
  {label:'打开 N.E.K.O.',click:()=>workbenchAction('open-neko').catch(error=>{notice(state.actors[0],error.message);update();})},
  {label:'任务备注…',click:editMemory},
  {type:'separator'},
  {label:'连接 N.E.K.O.（可选）',click:()=>workbenchAction('connect-neko').catch(()=>{})},
  {label:'N.E.K.O.：'+(state.neko.connection==='ready'?'已连接':'未连接'),enabled:false},
  {label:'工作台：'+(state.connection==='ready'?'已连接':'未连接'),enabled:false},
  {label:'连接状态…',click:showConnectionStatus}
];}
function applyMainChat(snapshot){
  if(quitting)return;
  const a=state.actors[0],oldBackend=a.chatBackend,previous=state.mainChat?.chat;
  if(oldBackend!==snapshot.backend)screenShare.interrupt();
  state.mainChat=snapshot;
  if(oldBackend!==snapshot.backend){
    if(oldBackend==='neko')state.neko.history=a.messages;
    a.messages=snapshot.backend==='neko'?(state.neko.history||[]):[];
    a.chatReply=null;a.lastUserMessage=null;a.status='idle';a.active=false;setWork(a,null);
  }
  a.chatBackend=snapshot.backend;a.sessionId=null;
  if(usesMainChatService(snapshot.backend)){
    state.neko.enabled=false;clearTimeout(nekoRetry);
    // Invalidate pending character fetches even before a WebSocket exists.
    nekoChat.close();state.neko.connection='disabled';state.neko.error='';
    const chat=snapshot.chat,aBusy=['connecting','replying'].includes(chat.phase);
    a.active=aBusy;a.status=aBusy?'working':chat.phase==='error'?'error':'idle';a.currentActivity=aBusy?'正在聊天':'';
    setWork(a,aBusy?'thinking':null);
    if(activeApiRequest&&typeof chat.reply==='string')a.chatReply={id:activeApiRequest.id,text:chat.reply,streaming:aBusy};
    if(chat.lastUserMessage)acceptHuman(a,{text:chat.lastUserMessage,time:Date.now()});
    if(chat.phase==='error'&&(previous?.phase!=='error'||previous?.errorMessage!==chat.errorMessage))notice(a,chat.errorMessage||'聊天暂不可用');
  }else state.neko.enabled=true;
  update();
}
async function refreshApiHistory(){
  const runtime=mainChatRuntime;if(!runtime||!usesMainChatService(runtime.backend))return;
  try{
    const messages=await runtime.history();if(quitting||runtime!==mainChatRuntime||!usesMainChatService(runtime.backend))return;
    const a=state.actors[0];a.messages=messages.map(m=>({id:m.id,role:m.role,text:m.text,time:m.createdAt,...(m.attachments?.length?{attachments:m.attachments}:{})}));
    if(!activeApiRequest){const last=messages.at(-1);a.chatReply=last?.role==='assistant'?{id:last.id,text:last.text,streaming:false}:null;}
    update();
  }catch{if(!quitting){state.mainChat={...state.mainChat,error:'聊天记录暂不可读取'};broadcast();}}
}
async function startMainChat(){
  await homeReady;
  mainChatRuntime=new WorkbenchMainChat({dataDir:data,repositoryRoot:path.resolve(base,'../..'),safeStorage,accountProvider:createCompanionAccountProvider(rpc),lobbyAccountProvider:createCompanionAccountProvider(rpc,{namespace:'lobby'}),proactiveAccountProvider:createCompanionAccountProvider(rpc,{namespace:'proactive'}),memoryAccountProvider:createCompanionAccountProvider(rpc,{namespace:'memory'}),environmentContext:()=>[ourHomeRuntime.context(),channelLife.context()].filter(Boolean).join('\n\n'),initialBackend:state.neko.enabled?'neko':'deepseek-account'});
  await mainChatRuntime.start();mainChatRuntime.subscribe(value=>{applyMainChat(value);lobbyController.refresh();});await refreshApiHistory();
  if(state.connection==='ready')await mainChatRuntime.refreshLobbyAccount();
  lobbyController.processPending();
}
function mainChatFailure(){state.mainChat={ready:false,backend:'chat-api',error:'聊天服务未能装配，请检查 Electron 的 Node 24 与 SQLite 支持',voiceStatus:'未接入'};state.actors[0].chatBackend='chat-api';notice(state.actors[0],state.mainChat.error);update();}
function cancelMainChat(){
  channelLife.interrupt();
  const dailyCancelled=communityDaily.interrupt();
  if(activeApiRequest?.preflight){
    activeApiRequest=null;const a=state.actors[0];a.active=false;a.status='idle';a.currentActivity='';setWork(a,null);update();return true;
  }
  return mainChatRuntime?.cancel()||dailyCancelled;
}
async function startApiPrompt(text,{waitForReply=false,source}={}){
  channelLife.touch();
  communityDaily.interrupt();
  if(!mainChatRuntime||!state.mainChat?.ready)throw new Error(state.mainChat?.error||'聊天服务尚未就绪');
  if(typeof text!=='string'||!text.trim()||text.length>8000)throw new Error('请输入 1～8000 字的消息');
  screenShare.interrupt();
  if(activeApiRequest||busy(state.actors[0]))throw new Error('我还在回复，等我一下。');
  const runtime=mainChatRuntime,backend=runtime.backend;
  const request={id:randomUUID(),opened:runtime.opened,preflight:false},a=state.actors[0];activeApiRequest=request;a.notice=null;
  if(backend==='deepseek-account'){
    request.preflight=true;a.active=true;a.status='working';a.currentActivity='正在检查账号';setWork(a,'thinking',null);update();
    let accountStatus='unavailable';
    try {if(state.connection==='ready'){const result=await rpc('companion-account-status');if(['signed-in','signed-out','unavailable'].includes(result?.status))accountStatus=result.status;}} catch {}
    if(activeApiRequest!==request||runtime!==mainChatRuntime||runtime.backend!==backend||runtime.opened!==request.opened){
      if(activeApiRequest===request){activeApiRequest=null;a.active=false;a.status='idle';a.currentActivity='';setWork(a,null);update();}
      throw Error('聊天已取消或连接已切换');
    }
    request.preflight=false;
    if(accountStatus!=='signed-in'){
      activeApiRequest=null;a.active=false;a.status='idle';a.currentActivity='';setWork(a,null);update();
      throw Error(accountStatus==='signed-out'?'请先登录 DeepSeek 工作台账号。':'工作台账号状态暂不可用，请检查连接。');
    }
  }
  const turn=mainChatRuntime.send(text,source);
  turn.then(async result=>{
    if(quitting||activeApiRequest!==request)return;activeApiRequest=null;
    if(!usesMainChatService(mainChatRuntime.backend)||mainChatRuntime.opened!==request.opened)return;
    if(result.status==='cancelled'){a.chatReply=null;notice(a,'已停止回复');}
    else if(result.status==='error')notice(a,result.message);
    await refreshApiHistory();update();
  },()=>{if(!quitting&&activeApiRequest===request){activeApiRequest=null;a.active=false;a.status='error';setWork(a,null);notice(a,'聊天暂不可用，请重试');update();}});
  if(waitForReply)return turn;
  return {requestId:request.id,backend:mainChatRuntime.backend};
}
function editChatSettings(){
  if(chatSettingsWindow&&!chatSettingsWindow.isDestroyed()){chatSettingsWindow.show();chatSettingsWindow.focus();return;}
  const w=new BrowserWindow({...options(),width:520,height:650,minWidth:440,minHeight:560,title:'聊天 API 设置',backgroundColor:'#f1f8fe'});chatSettingsWindow=w;
  loadLocalFile(w,{view:'chat-settings'});w.webContents.on('did-finish-load',()=>{broadcast();w.show();});w.on('closed',()=>{if(chatSettingsWindow===w)chatSettingsWindow=null;});
}
function editChatMemory(){
  if(chatMemoryWindow&&!chatMemoryWindow.isDestroyed()){chatMemoryWindow.webContents.send('pet:memory-open');chatMemoryWindow.show();chatMemoryWindow.focus();return;}
  const w=new BrowserWindow({...options(),width:1160,height:850,minWidth:440,minHeight:450,title:'鱼的记忆',backgroundColor:'#f1f8fe'});chatMemoryWindow=w;
  loadLocalFile(w,{view:'chat-memory'});w.webContents.on('did-finish-load',()=>{broadcast();w.show();});w.on('closed',()=>{if(chatMemoryWindow===w)chatMemoryWindow=null;});
}
const pinnedCount=()=>orderedDesktopPets(state.actors,{taskOrder:state.taskOrder,catalogOrder:state.catalogOrder}).filter(a=>a.pinned).length;
function exploringCat(a){return a.id!=='main'&&a.kind!=='task'&&a.metadataReady&&a.metadataSource==='dsh-subagent-catalog'&&state.preferences.subagentExploration!==false&&petAppearance.selected(state,a)===petAppearance.CAT;}
function nativePet(a){return a.id!=='main'&&a.metadataReady&&['dsh-subagent-catalog','dsh-task-session'].includes(a.metadataSource);}
function motionPet(a){return nativePet(a)&&(state.preferences.subagentFountain!==false||state.preferences.subagentClustering!==false||exploringCat(a));}
function gathersHome(a){const motion=motionOptions(a,state.preferences,exploringCat(a));return nativePet(a)&&(motion.cluster||motion.explore);}
function motionBody(a,w,bounds){
  const zoom=w.webContents.getZoomFactor?.()||1,scale=petAppearance.scaleFor(state,a),height=(a.stageWidth||239)*9/16*scale*zoom;
  const original=petAppearance.selected(state,a)===petAppearance.ORIGINAL;
  return {width:original?(a.stageWidth||239)*.38*scale*zoom:height*petAppearance.frameAspect(state,a),
    height:height*(original?.78:.94),bottomInset:Math.max(0,bounds.height-76*zoom-height*(original?.94:1))};
}
function keepMainInFront(id){
  const actor=state.actors.find(a=>a.id===id),homeId=desktopHomeId(actor,state.actors);
  const main=petWindows.get(homeId)||petWindows.get('main'),helper=petWindows.get(id);
  if(!main||!helper||main.isDestroyed()||helper.isDestroyed())return;
  // Electron moveAbove changes z-order without focusing the main character.
  try{const source=helper.getMediaSourceId?.();if(source)main.moveAbove?.(source);}catch{}
}
function windowBounds(w){if(w.getBounds)return w.getBounds();const [x,y]=w.getPosition();return {...w.bounds,x,y};}
function reconcilePets(){
  clearTimeout(rosterTimer);
  const now=Date.now(),orders={taskOrder:state.taskOrder,catalogOrder:state.catalogOrder};
  expireReturnHomes(state.actors,now);
  for(const a of state.actors)if(a.returningHome&&(a.active||!gathersHome(a))){a.returningHome=false;if(!a.active)a.displayUntil=now+10000;}
  const selected=state.preferences.helpersVisible?selectDesktopPets(state.actors,orders,state.preferences.helperLimit,now):[];
  const ids=new Set(selected.map(a=>a.id));
  const visible=[state.actors.find(a=>a.id==='main'),...selected];
  const layouts=visible.map(a=>petLayout(actorKind(a),state.originalPet,petAppearance.layoutOptions(state,a)));
  const explorers=[];
  for(const a of state.actors){
    if(a.id!=='main')a.present=ids.has(a.id);
    const index=visible.indexOf(a),geometry=index>=0?desktopGeometry(a,index,layouts):null;
    if(geometry&&motionPet(a))geometry.bounds=catMotion.keepPosition(a.id,geometry.bounds,screen.getDisplayMatching?.(geometry.bounds)?.workArea||screen.getPrimaryDisplay().workArea);
    if(geometry)a.stageWidth=geometry.stageWidth;
    const w=a.present?createPetWindow(a,geometry):petWindows.get(a.id);
    if(!w||w.isDestroyed())continue;
    if(geometry&&!draggingPets.has(a.id)){
      const key=JSON.stringify(geometry.bounds);
      if(petGeometry.get(a.id)!==key){w.setBounds(geometry.bounds);w.webContents.setZoomFactor?.(geometry.scale);petGeometry.set(a.id,key);}
    }
    w.setTitle(a.name);
    if(a.present&&motionPet(a)&&!workbenchOnly)explorers.push({id:a.id,sessionId:a.sessionId,window:w,active:!!a.active,returning:!!a.returningHome,
      ...motionOptions(a,state.preferences,exploringCat(a)),
      body:motionBody(a,w,windowBounds(w)),retire:!a.pinned});
    if(a.present){if(!workbenchOnly&&!w.webContents.isLoading()&&!w.isVisible())w.showInactive();}else if(w.isVisible())w.hide();
  }
  catMotion.sync(explorers);
  const all=orderedDesktopPets(state.actors,orders);
  state.helperDisplay={active:all.filter(a=>a.active).length,visible:selected.length,pinned:pinnedCount(),limit:state.preferences.helperLimit,selectedSessionIds:selected.map(a=>a.sessionId),tasks:selected.filter(a=>actorKind(a)==='task').length,subagents:selected.filter(a=>actorKind(a)==='subagent').length};
  const expires=state.actors.filter(a=>!a.active&&a.displayUntil>now).map(a=>a.displayUntil);
  const rotation=state.preferences.helpersVisible?nextDesktopRefreshAt(state.actors,orders,state.preferences.helperLimit,now):null;if(rotation>now)expires.push(rotation);
  if(expires.length)rosterTimer=setTimeout(update,Math.max(1,Math.min(...expires)-now));
}
function desktopGeometry(a,index,layouts){const layout=petLayout(actorKind(a),state.originalPet,petAppearance.layoutOptions(state,a)),area=screen.getPrimaryDisplay().workArea;const placed=petPlacement({area,layout,saved:state.positions[a.id],index,layouts});return {stageWidth:layout.stageWidth,scale:placed.scale,bounds:{x:placed.x,y:placed.y,width:placed.width,height:placed.height}};}
function update(){reconcilePets();save();broadcast();}
function finishAppearance(a){if(a.kind==='task'&&a.backgroundJobs>0){a.active=true;a.status='working';a.displayUntil=0;setWork(a,'working',a.task);return;}a.active=false;if(a.id!=='main'){if(gathersHome(a)){if(!a.returningHome)beginReturnHome(a);}else{a.returningHome=false;a.displayUntil=(['success','error'].includes(a.work.state)||a.kind==='task')?Date.now()+10000:0;}}}
function notice(a,text){a.notice={id:randomUUID(),text};}
function setWork(a,next,task=a.work.task){
  if(!next)task=null;
  if(a.work.state===next&&a.work.task===task)return false;
  a.work={state:next,task,tick:a.work.tick+1};return true;
}
function observeWork(a,e){
  if(e.type==='turn/start'){a.messageStart=a.messages.length;a.workFlags={goalRound:false,closing:null};setWork(a,'thinking',null);}
  if(e.type==='user/message'&&e.data?.source?.kind==='goal')a.workFlags.goalRound=true;
  if(e.type==='todo/write'){setWork(a,a.work.state,originalWork.currentTaskFromTodo(e));return;}
  if(e.type==='tool/call'&&e.data?.name==='update_goal'){
    const action=originalWork.goalUpdateAction(String(e.data.arguments||''));if(action)a.workFlags.closing=action;
  }
  const next=originalWork.reduceWorkStatus(e,a.workFlags);
  if(!next&&e.type!=='turn/end')return;
  if(!setWork(a,next))return;
  clearTimeout(terminalTimers.get(a.id));terminalTimers.delete(a.id);
  if(next==='success'||next==='error')terminalTimers.set(a.id,setTimeout(()=>{setWork(a,null);terminalTimers.delete(a.id);update();},60000));
}
function actorBySession(id){return findDshActor(state,id);}
function settleTask(a){
  const outcome=a.taskOutcome,reason=a.lastTaskStopReason;
  const cancelled=['cancelled','user','aborted'].includes(reason),turnFailed=!!reason&&reason!=='completed'&&!cancelled;
  a.status=outcome==='failed'||turnFailed?'error':outcome==='killed'||cancelled?'stopped':outcome==='unknown'?'idle':outcome==='completed'||reason==='completed'?'success':'idle';
  a.stopRequested=false;setWork(a,['success','error'].includes(a.status)?a.status:null);
  if(a.status==='stopped')notice(a,'任务已停止');
  else if(a.status==='idle')notice(a,'任务已结束，结果请在工作台查看。');
  else if(outcome==='failed')notice(a,'后台任务执行失败，请在工作台查看结果。');
}
function syncTask(meta){
  const change=syncTaskRecord(state,meta);if(!change)return;
  const {actor:a,wasActive}=change;
  if(change.oldId){const old=petWindows.get(change.oldId);if(old&&!old.isDestroyed())old.destroy();petWindows.delete(change.oldId);petGeometry.delete(change.oldId);draggingPets.delete(change.oldId);}
  if(a.active){a.status='working';a.displayUntil=0;setWork(a,'working',a.task);}
  else if(wasActive){settleTask(a);finishAppearance(a);}
  const frames=earlyFrames.get(meta.sessionId);earlyFrames.delete(meta.sessionId);
  for(const frame of frames||[])receive(frame,true);
  update();
}
function syncAgent(meta){
  if(meta.source!=='dsh-subagent-catalog'||!meta.sessionId||!meta.parentSessionId)return;
  const promoted=promoteTaskRecord(state,meta);
  if(promoted){const old=petWindows.get(promoted.oldId);if(old&&!old.isDestroyed())old.destroy();petWindows.delete(promoted.oldId);const rename=renameWindows.get(promoted.oldId);if(rename&&!rename.isDestroyed())rename.close();renameWindows.delete(promoted.oldId);}
  let a=actorBySession(meta.sessionId);
  if(!a||a===state.dshRoot){a={id:'subagent-'+meta.sessionId,kind:'subagent',sessionId:meta.sessionId,status:'idle',present:false,messages:[],notice:null,work:{state:null,task:null,tick:0},workFlags:{goalRound:false,closing:null}};state.actors.push(a);}
  Object.assign(a,{dshName:meta.name,label:meta.label,title:meta.title,task:meta.task,mode:meta.mode,parentSessionId:meta.parentSessionId,metadataReady:true,metadataSource:meta.source});a.name=displayName(a);
  if(meta.running){a.active=true;a.displayUntil=0;}
  update();
  const frames=earlyFrames.get(meta.sessionId);earlyFrames.delete(meta.sessionId);for(const frame of frames||[])receive(frame,true);
}
function rpc(method,params={}){return new Promise((resolve,reject)=>{
  if(!child||child.killed)return reject(new Error('还没连上，右键大肥鱼可重新连接。'));
  const id=++rpcId,timer=setTimeout(()=>{pending.delete(id);reject(new Error('等得有点久，右键大肥鱼查看连接。'));},90000);
  pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');
});}
function textContent(value){if(!value)return '';if(typeof value==='string')return value;if(Array.isArray(value))return value.map(textContent).join('');if(value.type==='text')return value.text||'';return textContent(value.content||value.message?.content||value.blocks);}
function shortReply(text){return text.replace(/```[\s\S]*?```/g,'').replace(/[*#`]/g,'').trim().slice(0,100);}
async function replyToChannelMessage(text,source){
  const runtime=mainChatRuntime,backend=runtime?.backend;
  if(!usesMainChatService(backend))return '请在 Nekofans 启用大肥鱼的 DeepSeek 账号或聊天 API。';
  if(activeApiRequest||busy(state.actors[0]))return '大肥鱼正在回复，等她一下。';
  const result=await startApiPrompt(text,{waitForReply:true,source});
  if(result.status!=='completed'||runtime!==mainChatRuntime||backend!==runtime.backend)return '这次回复未完成，请稍后再试。';
  const reply=chatReply(result.text);
  return reply.length<=1500?reply:reply.slice(0,1470)+'…（完整回复见工作台）';
}
async function continueQQChat(id){
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)||!child||quitting)return;
  const source=child;
  try{
    const request=await rpc('qqbot-companion-take',{id});
    if(!request||child!==source||quitting)return;
    const text=await replyToChannelMessage(request.text,'qq');
    if(child===source&&!quitting)await rpc('qqbot-companion-reply',{id,text});
  }catch{
    if(child===source&&!quitting)await rpc('qqbot-companion-reply',{id,text:'大肥鱼暂时无法回复，请检查工作台连接后再试。'}).catch(()=>{});
  }
}
function receive(message,replay=false){
  if(message?.method==='qqbot-companion-request'){if(!replay)void continueQQChat(message.params?.id);return;}
  if(message?.method==='home-build'){if(!replay)void homeReady.then(ready=>ready&&ourHomeRuntime.acceptBuild(message.params));return;}
  if(message?.method==='channel-experience'){if(!replay)try{channelLife.accept(message.params);}catch{}return;}
  if(message?.method==='event'&&message.params?.event?.type==='turn/start')channelLife.interrupt();
  // Consume private authorization projections before generic event logging.
  if(message?.method==='dsh-login-attempt'){if(!replay)dshLoginBrowser.accept(message.params);return;}
  if(message.id){const p=pending.get(message.id);if(p){clearTimeout(p.timer);pending.delete(message.id);message.error?p.reject(new Error(message.error)):p.resolve(message.result);}return;}
  const p=message.params||{};
  if(message.method==='fish-care-state'){acceptChannelState('fish',p);return;}
  if(message.method==='qqbot-care-state'){acceptChannelState('qqbot',p);return;}
  if(message.method==='ready'){connect().catch(engineError);return;}
  if(!replay)fs.appendFileSync(path.join(data,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...message})+'\n');
  if(message.method==='agent-meta'){syncAgent(p);return;}
  if(message.method==='task-meta'){syncTask(p);return;}
  if(message.method==='task-roster'&&acceptTaskRoster(state,p)){update();return;}
  if(message.method==='agent-roster'&&p.source==='dsh-subagent-catalog'&&Array.isArray(p.sessionIds)){state.catalogOrder=[...new Set(p.sessionIds.map(String))];update();return;}
  const a=actorBySession(p.sessionId);
  if(!a){
    if(p.sessionId&&['event','status','subagent-activity','session-context'].includes(message.method)){
      if(!earlyFrames.has(p.sessionId)&&earlyFrames.size>=16)earlyFrames.delete(earlyFrames.keys().next().value);
      const frames=earlyFrames.get(p.sessionId)||[];if(frames.length>=100)frames.shift();frames.push(message);earlyFrames.set(p.sessionId,frames);
    }return;
  }
  if(message.method==='session-context'){
    if(p.delegatedPromptTime!==null&&p.delegatedPromptTime===a.lastUserMessage?.time)a.lastUserMessage=null;
    const local=a.messages.findLast(m=>m.role==='user');if(local)acceptHuman(a,{text:cleanPrompt(local.text),time:local.time});
    acceptHuman(a,p.lastUserMessage);a.title=p.title||a.title;a.currentActivity=p.currentActivity||'';
    if(a.id==='main'&&a.lastUserMessage)a.task=cleanPrompt(a.lastUserMessage.text);
  }
  if(message.method==='status'){
    a.status=p.status==='running'?'working':(['stopped','stopping'].includes(a.status)?'stopped':a.status==='error'?'error':'success');
    if(p.status==='running'){a.active=true;a.displayUntil=0;}
    else if(a.active)finishAppearance(a);
  }
  if(message.method==='subagent-activity'){
    if(p.phase==='start'){a.active=true;a.displayUntil=0;}
    else finishAppearance(a);
  }
  if(message.method==='subagent-activity'&&p.local===false){
    a.status=p.phase==='start'?'working':p.stopReason==='completed'?'success':'error';
    setWork(a,p.phase==='start'?'thinking':p.stopReason==='completed'?'success':['aborted','cancelled'].includes(p.stopReason)?null:'error');
    if(p.phase==='end')finishAppearance(a);
  }
  if(message.method==='failure'){a.status='error';a.messages.push({role:'error',text:p.message,time:Date.now()});setWork(a,'error');finishAppearance(a);}
  if(message.method==='event'){
    const e=p.event;
    if(e.type==='turn/start'){a.active=true;a.displayUntil=0;a.currentActivity='';if(a.kind==='task')delete a.lastTaskStopReason;}
    const human=p.delegatedPrompt?null:humanMessage(e);if(human){acceptHuman(a,human);if(a.id==='main')a.task=human.text;}
    if(e.type==='session/title')a.title=String(e.data?.title||'');
    const action=activity(e);if(action)a.currentActivity=action;
    observeWork(a,e);
    if(e.type==='assistant/message'){const t=textContent(e.data?.message||e);if(t)a.messages.push({role:'assistant',text:t,time:Date.now()});}
    if(e.type==='turn/end'){
      const reason=e.data?.reason?.kind||e.stopReason;
      if(a.kind==='task')a.lastTaskStopReason=reason;
      const final=a.messages.slice(a.messageStart??a.messages.length).filter(m=>m.role==='assistant').at(-1)?.text;
      if(reason==='completed'){
        a.status='success';
        if(final){state.diary.unshift({actor:a.name,text:final.slice(0,500),time:Date.now()});state.diary=state.diary.slice(0,80);}
      }else if(['cancelled','user','aborted'].includes(reason)){a.status='stopped';}
      else{a.status='error';}
      if(a.kind==='task'&&a.backgroundJobs===0)settleTask(a);
      a.stopRequested=false;
      finishAppearance(a);
    }
  }
  update();
}
function engineError(error){state.connection='error';state.error=String(error.message||error);void fishQqCoordinator.pause();acceptChannelState('fish',{enabled:false,phase:'error',reason:'工作台连接已中断，养鱼状态无法确认。'});acceptChannelState('qqbot',{enabled:false,phase:'error',reason:'工作台连接已中断，QQ 状态无法确认。'});for(const a of state.actors.filter(a=>a.id!=='main')){a.active=false;a.returningHome=false;a.displayUntil=0;}update();}
async function connect(){
  const r=await rpc('init',{rootId:state.rootId,resume:!!state.rootId,parentIds:[...new Set(state.actors.map(a=>a.parentSessionId).filter(Boolean))],taskIds:state.actors.filter(a=>a.kind==='task').map(a=>a.sessionId)});
  const url=new URL(r.uiUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('DSH 窗口地址不在本机。');
  dshLaunchUrl=url.href;dshCookieFilter.setUrl(dshLaunchUrl);state.rootId=r.sessionId;state.dshRoot.sessionId=r.sessionId;state.connection='ready';state.error='';
  void mainChatRuntime?.refreshLobbyAccount({force:true});
  await Promise.all(['fish','qqbot'].map(async name=>{const revision=channelRevisions[name];try{const value=await channelAction(name,fishQqCoordinator.snapshot().selection[name]?'status':'pause');if(revision===channelRevisions[name])acceptChannelState(name,value);}catch{acceptChannelState(name,{enabled:false,phase:'error',reason:'渠道服务尚未就绪，请稍后重试。'});}}));
  const frames=earlyFrames.get(r.sessionId);earlyFrames.delete(r.sessionId);for(const frame of frames||[])receive(frame,true);
  update();
  if(dshWindow&&!dshWindow.isDestroyed()){await applySkinCookie(dshWindow.webContents.session,dshLaunchUrl,dshSkin);await dshWindow.loadURL(dshLaunchUrl);}
}
function startEngine(){
  if(startPromise)return startPromise;
  startPromise=(async()=>{
    state.connection='starting';broadcast();
    assertDshRuntime(runtimePaths);
    prepareFishCare(runtimePaths,{baseDir:base});
    const skin=skinPatch(path.join(base,'embedded-dsh','b0-skin','packages'),{log:m=>fs.appendFileSync(path.join(data,'engine.log'),m)});dshSkin=skin.skin;
    fs.writeFileSync(path.join(data,'bridge.patch.json'),JSON.stringify(buildDshPatch(runtimePaths,{baseDir:base,skin}),null,2));
    const launch=buildDshLaunch(runtimePaths);
    child=spawn(launch.command,launch.args,launch.options);
    const ownedChild=child;
    childLifecycle=createDshLifecycle(ownedChild,{onError:engineError,onClose:({code,error})=>{
      if(child!==ownedChild)return;
      for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('DSH 已退出。'));}pending.clear();
      child=null;childLifecycle=null;dshLaunchUrl=null;dshCookieFilter.setUrl(null);startPromise=null;
      if(!quitting&&!error)engineError(new Error('DSH 已退出 ('+code+')。'+stderr.slice(-600)));
    }});
    child.stderr.on('data',d=>{stderr=(stderr+d.toString()).slice(-20000);fs.appendFileSync(path.join(data,'engine.log'),d);});
    readline.createInterface({input:child.stdout}).on('line',line=>{if(child!==ownedChild)return;try{receive(JSON.parse(line));}catch{fs.appendFileSync(path.join(data,'engine.log'),line+'\n');}});
  })();
  startPromise.catch(()=>{if(!child)startPromise=null;});
  return startPromise;
}
function restart(){
  const current=childLifecycle;
  if(!current||current.closed){startEngine().catch(engineError);return;}
  current.stop().then(()=>{
    if(!current.closed)throw new Error('工作台进程仍未退出，请稍后重试。');
    if(!quitting)return startEngine();
  }).catch(engineError);
}
function options(){return {show:false,webPreferences:{preload:path.join(base,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}};}
function showInput(id='main'){const a=state.actors.find(a=>a.id===id);if(!a)return;if(id!=='main'&&a.kind!=='task'){openDsh().catch(engineError);return;}if(id!=='main'&&!a.present){openDsh().catch(engineError);return;}const w=createPetWindow(a);w.show();w.webContents.send('pet:input');setTimeout(()=>{app.focus({steal:true});w.focus();w.webContents.focus();},0);}
async function openTaskSession(a){if(a.kind!=='task'||!a.metadataReady)throw new Error('这个任务会话尚未就绪');screenShare.hide();workbenchNavigation={sessionId:a.sessionId,revision:(workbenchNavigation?.revision||0)+1};await openDsh();broadcast();}
function popupMainMenu(){const w=petWindows.get('main');if(w){w.show();setTimeout(()=>{app.focus({steal:true});w.focus();mainMenu().popup({window:w});},0);}}
async function openDsh(){
  // Reopening the workbench must also recover a hidden/minimized desktop pet.
  // Do this before loading the engine so an offline engine cannot hide her.
  if(!workbenchOnly){const main=state.actors.find(a=>a.id==='main');if(main){
    const pet=createPetWindow(main);
    if(pet.isMinimized?.())pet.restore();
    if(!pet.webContents.isLoading())pet.showInactive();
  }}
  if(dshWindow&&!dshWindow.isDestroyed()){dshWindow.show();app.focus({steal:true});dshWindow.focus();return;}
  const workArea=screen.getDisplayNearestPoint?.(screen.getCursorScreenPoint?.())?.workArea || screen.getPrimaryDisplay().workArea;
  dshWindow=new BrowserWindow({...workbenchWindowOptions(process.platform,workArea,nativeTheme.shouldUseDarkColors),title:'Nekofans',backgroundColor:nativeTheme.shouldUseDarkColors?'#131C27':'#EDF3F8',show:false,webPreferences:{preload:path.join(base,'workbench-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,partition:'persist:pet-dsh'}});
  dshCookieFilter.bind(dshWindow.webContents.session);
  communityController.bindHost(dshWindow);nativeDividerController.bind(dshWindow);nativeComposerController.bind(dshWindow);
  const clearAccountMenuLayer=()=>{nativeComposerController.setAccountMenuRect(null);videoFloatController.setAccountMenuRect(null);questionRelay.clear();};
  dshWindow.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)clearAccountMenuLayer();});
  dshWindow.webContents.on('render-process-gone',clearAccountMenuLayer);
  dshWindow.on('closed',()=>questionRelay.clear());
  dshWindow.webContents.on('did-finish-load',()=>{if(isWorkbenchOrigin(dshWindow.webContents.getURL())&&typeof dshWindow.webContents.executeJavaScript==='function')void dshWindow.webContents.executeJavaScript(fs.readFileSync(path.join(base,'screen-share-host.js'),'utf8')).catch(()=>{});});
  dshWindow.on('close',event=>{if(!quitting){event.preventDefault();dshWindow.hide();}});
  dshWindow.webContents.on('will-navigate',(event,url)=>{if(!/^https?:/.test(url))event.preventDefault();});
  dshWindow.webContents.setWindowOpenHandler(({url})=>/^https?:/.test(url)?{action:'allow',overrideBrowserWindowOptions:{webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,partition:'persist:pet-dsh'}}}:{action:'deny'});
  if(dshLaunchUrl){await applySkinCookie(dshWindow.webContents.session,dshLaunchUrl,dshSkin);await dshWindow.loadURL(dshLaunchUrl);}
  else await dshWindow.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<meta charset="utf-8"><title>Nekofans</title><style>:root{color-scheme:light dark}body{margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui,sans-serif;background:#EDF3F8;color:#4C5F73}@media (prefers-color-scheme:dark){body{background:#131C27;color:#9DB0C3}}</style><p>正在连接 Nekofans…</p>'));
  dshWindow.show();app.focus({steal:true});dshWindow.focus();
}
function editMemory(){
  if(memoryWindow&&!memoryWindow.isDestroyed()){memoryWindow.show();memoryWindow.focus();return;}
  memoryWindow=new BrowserWindow({...options(),width:360,height:275,resizable:false,title:'任务备注',backgroundColor:'#f8f7f0',minimizable:false,fullscreenable:false});
  loadLocalFile(memoryWindow,{view:'memory'});
  memoryWindow.webContents.on('did-finish-load',()=>{broadcast();memoryWindow.show();});
  memoryWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
}
function editSettings(){
  if(settingsWindow&&!settingsWindow.isDestroyed()){settingsWindow.show();settingsWindow.focus();return;}
  settingsWindow=new BrowserWindow({...options(),width:360,height:230,resizable:false,title:'任务与帮手形象数量',backgroundColor:'#f1f8fe',minimizable:false,fullscreenable:false});
  loadLocalFile(settingsWindow,{view:'settings'});
  settingsWindow.webContents.on('did-finish-load',()=>{broadcast();settingsWindow.show();});
  settingsWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
}
function editNekoSettings(){
  if(nekoSettingsWindow&&!nekoSettingsWindow.isDestroyed()){nekoSettingsWindow.show();nekoSettingsWindow.focus();return;}
  nekoSettingsWindow=new BrowserWindow({...options(),width:390,height:285,resizable:false,title:'N.E.K.O. 聊天',backgroundColor:'#f1f8fe',minimizable:false,fullscreenable:false});
  loadLocalFile(nekoSettingsWindow,{view:'neko-settings'});
  nekoSettingsWindow.webContents.on('did-finish-load',()=>{broadcast();nekoSettingsWindow.show();});
  nekoSettingsWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
}
async function openNeko(){
  if(nekoWindow&&!nekoWindow.isDestroyed()){nekoWindow.show();nekoWindow.focus();return;}
  nekoWindow=new BrowserWindow({width:1000,height:740,title:'N.E.K.O.',backgroundColor:'#ffffff',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  nekoWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  nekoWindow.webContents.on('will-navigate',(event,url)=>{try{if(new URL(url).origin!==localBase(state.neko.baseUrl))event.preventDefault();}catch{event.preventDefault();}});
  await nekoWindow.loadURL(localBase(state.neko.baseUrl)+'/chat');
}
async function connectNeko(){clearTimeout(nekoRetry);if(!state.neko.enabled||mainChatRuntime?.backend!=='neko'){state.neko.connection='disabled';state.neko.error='';update();return;}try{await nekoChat.connect(state.neko);}catch{}finally{if(!quitting&&state.neko.enabled&&mainChatRuntime?.backend==='neko'&&state.neko.connection!=='ready')nekoRetry=setTimeout(connectNeko,10000);}}
nekoChat.on('connection',info=>{if(quitting||mainChatRuntime?.backend!=='neko')return;Object.assign(state.neko,info);if(info.connection==='disconnected'&&state.neko.enabled){clearTimeout(nekoRetry);nekoRetry=setTimeout(connectNeko,10000);}update();});
nekoChat.on('characters',({names,character})=>{if(quitting||mainChatRuntime?.backend!=='neko')return;state.neko.characters=names;state.neko.character=character;state.actors[0].nekoCharacter=character;update();});
nekoChat.on('profile-created',info=>{if(quitting||mainChatRuntime?.backend!=='neko')return;state.neko.profileCreated={...info,at:new Date().toISOString()};update();});
nekoChat.on('start',()=>{if(quitting||mainChatRuntime?.backend!=='neko')return;const a=state.actors[0];a.active=true;a.status='working';a.currentActivity='正在聊天';setWork(a,'thinking',null);update();});
nekoChat.on('reply',({requestId,text})=>{
  if(quitting||mainChatRuntime?.backend!=='neko')return;
  const a=state.actors[0];let reply=a.messages.find(m=>m.requestId===requestId&&m.role==='assistant');
  if(!reply){reply={role:'assistant',requestId,text:'',time:Date.now()};a.messages.push(reply);}reply.text=text;a.chatReply={id:requestId,text,streaming:true};update();
});
nekoChat.on('complete',({requestId,text})=>{if(quitting||mainChatRuntime?.backend!=='neko')return;const a=state.actors[0];state.neko.history=a.messages;a.status='idle';a.active=false;a.currentActivity='';a.chatReply={id:requestId,text,streaming:false};setWork(a,null);update();});
nekoChat.on('failure',error=>{if(quitting||mainChatRuntime?.backend!=='neko')return;const a=state.actors[0];a.status='error';a.active=false;a.currentActivity='';if(a.chatReply)a.chatReply.streaming=false;notice(a,error.message);setWork(a,null);update();});
function setHelperLimit(value){const n=normalizeLimit(value);if(n<pinnedCount())return false;state.preferences.helperLimit=n;update();return true;}
function pinHelper(a,pinned){
  if(pinned&&!orderedDesktopPets(state.actors,{taskOrder:state.taskOrder,catalogOrder:state.catalogOrder}).includes(a))return false;
  if(pinned&&!a.pinned&&pinnedCount()>=state.preferences.helperLimit)return false;
  a.pinned=!!pinned;update();return true;
}
function editName(a){
  const existing=renameWindows.get(a.id);if(existing&&!existing.isDestroyed()){existing.show();existing.focus();return;}
  const w=new BrowserWindow({...options(),width:340,height:220,resizable:false,title:'修改名字',backgroundColor:'#f1f8fe',minimizable:false,fullscreenable:false});
  renameWindows.set(a.id,w);loadLocalFile(w,{view:'rename',actor:a.id});
  w.webContents.on('did-finish-load',()=>{broadcast();w.show();w.focus();});
  w.on('closed',()=>renameWindows.delete(a.id));w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
}
async function importPetAppearance(a){
  const result=await dialog.showOpenDialog(petWindows.get(a.id),{title:'导入'+a.name+'的动态形象',buttonLabel:'使用这个形象',properties:['openFile'],filters:[{name:'动态角色图片',extensions:['gif','webp']}]});
  if(result.canceled||!result.filePaths[0]||quitting)return;
  try{const value=await importAppearanceImage(result.filePaths[0],dataUrl=>decodeAnimationPoster(BrowserWindow,dataUrl));if(!quitting&&state.actors.includes(a)&&petAppearance.setCustom(a,value))update();}
  catch(error){dialog.showErrorBox('形象导入失败',error.code?'图片未能读取，请重新选择。':error.message);}
}
function appearanceSizeMenu(a){return [{label:'默认大小',type:'radio',checked:!Number.isFinite(a.appearanceScale),click:()=>{petAppearance.setScale(a,null);update();}},...[.4,.55,.65,.8,1].map(value=>({label:Math.round(value*100)+'%',type:'radio',checked:a.appearanceScale===value,click:()=>{petAppearance.setScale(a,value);update();}}))];}
function appearanceMenu(a){return [
  {label:'跟随默认',type:'radio',checked:!petAppearance.explicit(a),click:()=>{petAppearance.setActor(a,null);update();}},
  ...petAppearance.choices.map(choice=>({label:choice.label,type:'radio',checked:a.appearanceId===choice.id,click:()=>{petAppearance.setActor(a,choice.id);update();}})),
  ...(petAppearance.validCustom(a.customAppearance)?[{label:'自定义：'+a.customAppearance.name,type:'radio',checked:a.appearanceId==='custom',click:()=>{petAppearance.setActor(a,'custom');update();}}]:[]),
  {type:'separator'},{label:'导入自定义动图…',click:()=>importPetAppearance(a)},{label:'形象大小',submenu:appearanceSizeMenu(a)}
];}
function defaultAppearanceMenu(tier){const key=petAppearance.preferenceKey(tier);return petAppearance.choices.map(choice=>({label:choice.label,type:'radio',checked:state.preferences[key]===choice.id,click:()=>{petAppearance.setDefault(state,tier,choice.id);update();}}));}
function childMenu(a){return Menu.buildFromTemplate([
  {label:'形象',submenu:appearanceMenu(a)},
  ...(a.kind==='task'?[{label:'在工作台继续任务',click:()=>openTaskSession(a).catch(error=>dialog.showErrorBox('任务会话未打开',error.message))},{type:'separator'}]:[]),
  {label:'常驻桌面',type:'checkbox',checked:!!a.pinned,enabled:!!a.pinned||pinnedCount()<state.preferences.helperLimit,toolTip:'常驻占用一个形象名额，任务完成和重启后仍保留。',click:item=>pinHelper(a,item.checked)},
  {label:'修改名字…',click:()=>editName(a)},
  {label:'恢复 DSH 名称',enabled:!!a.nickname,click:()=>{a.nickname='';a.name=displayName(a);update();}},
  {type:'separator'},
  {label:'说话显示时长',submenu:speechDurationMenu()}
]);}
function artifacts(){
  const files=[];
  function walk(dir,depth){if(depth>3||files.length>=200)return;for(const f of fs.readdirSync(dir,{withFileTypes:true})){if(f.name.startsWith('.')||f.name==='node_modules'||depth===0&&f.name==='fish-care')continue;const full=path.join(dir,f.name);if(f.isDirectory())walk(full,depth+1);else if(f.isFile())files.push(path.relative(workspace,full));}}
  walk(workspace,0);for(const name of ['whale-diary.md','whale-diary-private.md']){const rel=path.join('fish-care','profile',name);if(fs.existsSync(path.join(workspace,rel)))files.push(rel);}return files;
}
async function preview(name){
  const real=fs.realpathSync(path.resolve(workspace,name));if(!real.startsWith(workspace+path.sep)||!fs.statSync(real).isFile())return;
  const w=new BrowserWindow({width:860,height:700,title:path.basename(real),backgroundColor:'#f7f5ee',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,partition:'pet-artifact-preview'}});
  w.webContents.session.webRequest.onBeforeRequest((details,done)=>done({cancel:!['file:','data:','devtools:'].some(prefix=>details.url.startsWith(prefix))}));
  w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',(event,url)=>{if(url!==require('node:url').pathToFileURL(real).href)event.preventDefault();});
  if(/\.(html?|png|jpe?g|gif|webp|mp4|webm|wav|mp3)$/i.test(real))return w.loadFile(real);
  const content=fs.readFileSync(real,'utf8').slice(0,300000).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  return w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{margin:30px;background:#f7f5ee;color:#374c3d}pre{font:14px/1.9 monospace;white-space:pre-wrap;overflow-wrap:anywhere}</style><pre>'+content+'</pre>'));
}
async function stop(a){
  if(!busy(a))return;
  if(a.id==='main')return;
  const previous=a.status;a.stopRequested=true;a.status='stopping';update();
  try{if(!a.sessionId)throw new Error('missing session');const result=await rpc('stop',{sessionId:a.sessionId});if(result?.accepted!==true)throw new Error('stop not accepted');}
  catch{a.stopRequested=false;if(a.status==='stopping')a.status=previous;notice(a,'任务未能停止，请在工作台检查任务状态后重试。');update();}
}
async function capture(){
  const metrics={version:13,mainChatBackend:state.actors[0].chatBackend,neko:{enabled:state.neko.enabled,baseUrl:state.neko.baseUrl,character:state.neko.character,connection:state.neko.connection},dshRootSessionId:state.dshRoot.sessionId,capturedAt:new Date().toISOString(),originalPet:state.originalPet,helperDisplay:state.helperDisplay,catalogOrder:state.catalogOrder,mainSessionWork:state.actors[0].work,mainDisplayWork:state.actors[0].displayWork,windows:[]};
  for(const [id,w] of petWindows){
    if(!w.isVisible())continue;
    fs.writeFileSync(path.join(runtimePaths.diagnosticsDir,'极简桌宠_'+id+'.png'),(await w.webContents.capturePage()).toPNG());
    metrics.windows.push({id,chatBackend:state.actors.find(a=>a.id===id)?.chatBackend||'dsh',name:state.actors.find(a=>a.id===id)?.name,dshName:state.actors.find(a=>a.id===id)?.dshName,pinned:!!state.actors.find(a=>a.id===id)?.pinned,sessionId:state.actors.find(a=>a.id===id)?.sessionId,task:state.actors.find(a=>a.id===id)?.task,bounds:w.getBounds(),...await w.webContents.executeJavaScript(`(()=>{
      const chat=document.querySelector('.chat'),bubble=document.querySelector('.pet-bubble'),character=document.querySelector('.character'),front=document.querySelector('video.is-front'),tag=document.querySelector('.pet-logo');
      const visible=!bubble.hidden&&getComputedStyle(bubble).visibility!=='hidden';
      const r=character.getBoundingClientRect(),l=tag?.getBoundingClientRect(),headTop=r.top+r.height*.2,inspector=document.querySelector('.task-inspector');
      const extra={inputHeadGap:headTop-chat.getBoundingClientRect().bottom,inspectorVisible:!!inspector&&!inspector.hidden,inspectorRows:Array.from(inspector?.querySelectorAll('dd')||[],e=>({key:e.dataset.field,text:e.textContent,singleLine:getComputedStyle(e).whiteSpace==='nowrap',ellipsis:getComputedStyle(e).textOverflow==='ellipsis',overflowing:e.scrollWidth>e.clientWidth})),nativeHoverTitle:character.getAttribute('title')};
      return {...extra,nameDecorationVisible:!!tag&&!tag.hidden&&getComputedStyle(tag).display!=='none',logoLetter:tag?.textContent,logoName:tag?.getAttribute('aria-label'),logoUpperRight:!!l&&l.left>r.left+r.width/2&&l.top<r.top+r.height/3,whaleLogo:!!tag?.querySelector('svg'),stageWidth:r.width,stageHeight:r.height,inputs:document.querySelectorAll('input[type=text]').length,textareas:document.querySelectorAll('textarea').length,inputVisible:!chat.hidden,inputAboveCharacter:!chat.hidden&&chat.getBoundingClientRect().bottom<=r.top,bubble:visible?bubble.textContent:null,bubbleVisible:visible,bubbleActive:!bubble.hidden,workState:document.querySelector('.pet').dataset.workState,workbench:!!document.querySelector('.panel'),animation:decodeURIComponent(front?.src.split('/').at(-1)||''),loop:front?.loop};
    })()`)});
  }
  if(dshWindow&&!dshWindow.isDestroyed()){
    metrics.dsh={embedded:true,visible:dshWindow.isVisible(),loading:dshWindow.webContents.isLoading(),title:dshWindow.webContents.getTitle(),origin:dshLaunchUrl?new URL(dshLaunchUrl).origin:null,sameEngine:true,webPreferences:{nodeIntegration:dshWindow.webContents.getLastWebPreferences().nodeIntegration,contextIsolation:dshWindow.webContents.getLastWebPreferences().contextIsolation,sandbox:dshWindow.webContents.getLastWebPreferences().sandbox}};
    if(!dshWindow.webContents.isLoading())metrics.dsh.surface=await dshWindow.webContents.executeJavaScript(`(()=>{const input=document.querySelector('textarea,[contenteditable=true]')||document.body;const style=getComputedStyle(input);return {documentTitle:document.title,brand:document.querySelector('.neko-wordmark')?.textContent||null,productStrip:document.querySelector('.neko-strip__name')?.textContent||null,skin:${JSON.stringify(dshSkin)},skinChip:document.querySelector('.neko-strip__skin')?getComputedStyle(document.querySelector('.neko-strip__skin'),'::after').content:null,heroImage:(()=>{const img=document.querySelector('.neko-hero-art');return img?{complete:img.complete,width:img.naturalWidth,height:img.naturalHeight}:null})(),brandStyleIds:Array.from(document.querySelectorAll('style[id]'),e=>e.id).filter(id=>id.includes('@bigfish/')),favicon:document.querySelector('link[rel~=icon]')?.getAttribute('type'),workbenchBridge:typeof window.nekoWorkbench?.getState==='function',rolesBridge:typeof window.nekoRoles?.getState==='function',nativeTools:(()=>{const n=document.querySelector('nav[data-neko-tools]');if(!n)return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{state:n.getAttribute('data-neko-tools'),rect:{x:r.x,y:r.y,width:r.width,height:r.height},display:s.display,visibility:s.visibility,buttons:Array.from(n.querySelectorAll('button'),b=>({label:b.getAttribute('aria-label')||b.textContent,rect:(()=>{const r=b.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()}))}})(),roleRows:Array.from(document.querySelectorAll('.neko-role'),e=>({id:e.dataset.role,enabled:e.dataset.enabled,active:e.dataset.active,name:e.querySelector('.neko-role__name')?.textContent})),accountHabitat:(()=>{const e=document.querySelector('[data-neko-account-owned=launcher]'),p=document.querySelector('[data-neko-account-owned=menu-card]');return{name:e?.querySelector('.neh-developer-name')?.textContent,petCount:e?.querySelectorAll('.neh-pet').length||0,worldBackground:e?.querySelector('.neh-world')?getComputedStyle(e.querySelector('.neh-world')).backgroundColor:null,hasWalletValue:!!e?.querySelector('.neh-wallet')?.textContent.match(/^(USD|CNY) 余额/),menuCardVisible:!!p,videoPlaying:Array.from(e?.querySelectorAll('video')||[],v=>({ready:v.readyState,paused:v.paused,width:v.videoWidth,height:v.videoHeight}))}})(),avatarTheme:document.body.getAttribute('data-neko-avatar-theme'),accountBranding:(()=>{const e=document.querySelector('[data-slot="settings.launcher"] button.hjANda_trigger[aria-haspopup="menu"][data-collapsed][data-signed-out]');if(!e)return null;return{name:getComputedStyle(e,'::after').content,avatar:getComputedStyle(e,'::before').backgroundImage.startsWith('url('),collapsed:e.dataset.collapsed,expanded:e.getAttribute('aria-expanded')}})(),avatarImages:Array.from(document.querySelectorAll('[class*=neko] img,img[class*=neko]')).map(img=>({alt:img.alt,complete:img.complete,width:img.naturalWidth,height:img.naturalHeight})),nekoButtons:Array.from(document.querySelectorAll('button[class*=neko]')).map(b=>({label:(b.getAttribute('aria-label')||b.title||b.textContent).replace(/(?:USD|CNY) 余额 [-<¥$0-9.,]+/g,'余额 [已读取]'),expanded:b.getAttribute('aria-expanded')})),legacyHeadlineVisible:Array.from(document.querySelectorAll('span')).some(e=>e.textContent==='探索未至之境'&&e.getClientRects().length>0),tokens:Object.fromEntries(['--dsw-alias-brand-primary','--dsw-alias-bg-base','--dsw-alias-bg-layer-1','--dsw-alias-label-primary','--dsw-specific-sidebar-fill'].map(key=>[key,style.getPropertyValue(key).trim()])),inputs:document.querySelectorAll('textarea,[contenteditable=true]').length};})()`);
    if(dshWindow.isVisible())fs.writeFileSync(path.join(runtimePaths.diagnosticsDir,'内置DSH_实测.png'),(await dshWindow.webContents.capturePage()).toPNG());
  }
  const appearance=workbenchAppearance.get();metrics.workbenchAvatar={builtinId:appearance.builtinId,hasCustomAvatar:!!appearance.customDataUrl};metrics.workbenchRoles={activeId:rolesState().activeId,workspaceSessionId:rolesState().workspaceSessionId,roles:rolesState().roles.map(({customDataUrl,...role})=>({...role,hasCustomAvatar:!!customDataUrl}))};
  fs.writeFileSync(path.join(runtimePaths.diagnosticsDir,'minimal-ui.json'),JSON.stringify(metrics,null,2));
}
function memoryMenu(){
  const snapshot=state.mainChat?.memorySystem||{},enabled=usesMainChatService(mainChatRuntime?.backend);
  const act=async input=>{try{const result=await mainChatRuntime.memoryAction(input);if(result?.ok===false)notice(state.actors[0],result.message);}catch{notice(state.actors[0],'记忆操作未完成，请打开 N.E.K.O. 记忆设置检查。');}update();};
  return [
    {label:'N.E.K.O.：'+(snapshot.providerStates?.neko||'待连接'),enabled:false},
    {label:'立即处理待存记忆',enabled,click:()=>act({action:'sync'})},
    {label:'记忆与模型设置…',click:editChatMemory}
  ];
}
function channelLifeMenu(){
  const snapshot=channelLife.status(),change=patch=>{try{channelLife.configure(patch);}catch{notice(state.actors[0],'渠道记忆设置未能保存');broadcast();}};
  return [
    {label:'保存 B站 / QQ 经历到主角色记忆',type:'checkbox',checked:snapshot.memoryEnabled,click:item=>change({memoryEnabled:item.checked})},
    {label:'根据经历主动搭话（仅桌面）',type:'checkbox',checked:snapshot.proactiveEnabled,enabled:snapshot.memoryEnabled,click:item=>change({proactiveEnabled:item.checked})},
    {label:'检查经历并同步',click:()=>void channelLife.tick()},
    {label:`已存 ${snapshot.remembered} 条 · 待存 ${snapshot.pending} 条${snapshot.generating?' · 正在酝酿回复':''}`,enabled:false},
    {label:'北京时间 08–23 点；间隔 30 分钟；每天最多 6 次；忙碌时避让',enabled:false},
    ...(snapshot.error?[{label:snapshot.error,enabled:false}]:[])
  ];
}
async function signInForCommunityDaily(){
  openVisits();
  const visits=visitsController,window=visitsWindow;
  if(!visits||!window)return;
  await visits.initialize().catch(()=>{});
  if(quitting||visitsWindow!==window||window.isDestroyed())return;
  if(!visits.communityIdentity()&&!visits.snapshot().busy)await visits.action({action:'login'}).catch(()=>{});
}
function communityDailyMenu(){
  const snapshot=communityDaily.status();
  const report=()=>{const s=communityDaily.status();notice(state.actors[0],s.error||(s.today==='published'?'今天的社区日常已发布':s.today==='none'?'暂无可发布内容，或主角色正在忙':'今天已提交过发布，请到社区核对'));broadcast();};
  return [
    {label:'自动公开分享今日主聊天摘要',type:'checkbox',checked:snapshot.enabled,click:item=>{try{communityDaily.configure(item.checked);}catch(error){notice(state.actors[0],error.message);broadcast();}}},
    {label:`北京时间 ${snapshot.sendTime||'20:00'}；每个账号每天最多一条；主角色忙时延后`,enabled:false},
    {label:'仅当前主会话的今日互动；不读取 QQ 私聊或私人记忆',enabled:false},
    {label:snapshot.connected?'已授权社区账号（猫娘串门）…':'登录并授权社区账号…',click:()=>void signInForCommunityDaily()},
    {label:'立即检查并分享今日小记',enabled:snapshot.connected&&snapshot.enabled&&!snapshot.generating,click:()=>void communityDaily.tick({force:true}).then(report)},
    {label:`今日状态：${({none:'尚未发布',sending:'已提交待核对',published:'已发布',uncertain:'结果待核对'})[snapshot.today]}${snapshot.generating?' · 正在生成':''}`,enabled:false},
    ...(snapshot.error?[{label:snapshot.error,enabled:false}]:[]),
    {label:'发送时间与内容风格…',click:editCommunityDailySettings}
  ];
}
function speechDurationMenu(){
  const configured=state.preferences.petSpeechDurationMs,duration=Number.isFinite(configured)&&configured>=5000&&configured<=3600000?configured:60000;
  return [[5000,'5 秒'],[15000,'15 秒'],[30000,'30 秒'],[60000,'1 分钟（默认）'],[120000,'2 分钟'],[300000,'5 分钟'],[600000,'10 分钟']].map(([ms,label])=>({label,type:'radio',checked:duration===ms,click:()=>{state.preferences.petSpeechDurationMs=ms;update();}}));
}
function mainMenu(){return Menu.buildFromTemplate([
  {label:fishQqActive()?'暂停养鱼':'开始养鱼',enabled:state.connection==='ready',click:()=>fishQqAction({action:fishQqActive()?'pause':'start'}).catch(()=>{notice(state.actors[0],'养鱼与 QQ 操作未完成，请在连接与生活设置中重试。');update();})},
  {label:'形象',submenu:appearanceMenu(state.actors.find(a=>a.id==='main'))},
  {label:'养鱼',submenu:[{label:'聊天 API 设置…',click:editChatSettings},{label:'N.E.K.O. 记忆',submenu:memoryMenu()},{label:'渠道经历与主动搭话',submenu:channelLifeMenu()},{label:'社区日常',submenu:communityDailyMenu()},{label:'生活与 QQ 设置…',click:()=>openFishSettings().catch(engineError)}]},
  {type:'separator'},
  {label:'打开工作台',click:()=>openDsh().catch(engineError)},
  {label:'串门',click:openVisits},
  {label:'说话显示时长',submenu:speechDurationMenu()},
  {type:'separator'},
  {label:'设置',submenu:[
    {label:'社区日常发送时间与风格…',click:editCommunityDailySettings},
    {label:'主角色默认形象',submenu:defaultAppearanceMenu('main')},
    {label:'任务默认形象',submenu:defaultAppearanceMenu('task')},
    {label:'子代理默认形象',submenu:defaultAppearanceMenu('subagent')},
    {label:'当前任务',submenu:orderedTaskPets(state.actors,state.taskOrder,{catalogOrder:state.catalogOrder}).filter(a=>a.active||a.present).map(a=>({label:a.name,toolTip:a.task||a.title||'',click:()=>showInput(a.id)})).concat(orderedTaskPets(state.actors,state.taskOrder,{catalogOrder:state.catalogOrder}).some(a=>a.active||a.present)?[]:[{label:'暂无运行中的任务',enabled:false}])},
    {label:'常驻任务',submenu:orderedTaskPets(state.actors,state.taskOrder,{catalogOrder:state.catalogOrder}).map(a=>({label:a.name,type:'checkbox',checked:!!a.pinned,enabled:!!a.pinned||pinnedCount()<state.preferences.helperLimit,click:item=>pinHelper(a,item.checked)})).concat(orderedTaskPets(state.actors,state.taskOrder,{catalogOrder:state.catalogOrder}).length?[]:[{label:'暂无任务记录',enabled:false}])},
    {label:'当前子代理',submenu:orderedHelpers(state.actors,state.catalogOrder).some(a=>a.active||a.present)?orderedHelpers(state.actors,state.catalogOrder).filter(a=>a.active||a.present).map(a=>({label:a.name+(a.present?'':'（在工作台中查看）'),toolTip:a.task||a.title||'',click:()=>showInput(a.id)})):[{label:'暂无运行中的子代理',enabled:false}]},
    {label:'常驻子代理',submenu:orderedHelpers(state.actors,state.catalogOrder).length?orderedHelpers(state.actors,state.catalogOrder).map(a=>({label:a.name,type:'checkbox',checked:!!a.pinned,enabled:!!a.pinned||pinnedCount()<state.preferences.helperLimit,click:item=>pinHelper(a,item.checked)})):[{label:'暂无子代理',enabled:false}]},
    {label:'任务与帮手数量上限：'+state.preferences.helperLimit,submenu:[...[1,2,3,5,8,10,16,32].map(n=>({label:String(n),type:'radio',enabled:n>=pinnedCount(),checked:state.preferences.helperLimit===n,click:()=>setHelperLimit(n)})),{type:'separator'},{label:'自定义…',click:editSettings}]},
    {label:'显示任务与小帮手',type:'checkbox',checked:state.preferences.helpersVisible,click:item=>{state.preferences.helpersVisible=item.checked;update();}},
    {label:'任务与子代理喷泉出场',type:'checkbox',checked:state.preferences.subagentFountain!==false,click:item=>{state.preferences.subagentFountain=item.checked;update();}},
    {label:'DBSCAN 邻近聚类与避让',type:'checkbox',checked:state.preferences.subagentClustering!==false,click:item=>{state.preferences.subagentClustering=item.checked;update();}},
    {label:'子代理小猫自由探索',type:'checkbox',checked:state.preferences.subagentExploration!==false,click:item=>{state.preferences.subagentExploration=item.checked;update();}},
    {label:'保存桌宠截图',accelerator:'CommandOrControl+Shift+S',click:capture}
  ]},
  {label:'鱼的记忆',click:editChatMemory},
  {label:'重新连接工作台',click:restart},
  {type:'separator'},
  {label:'退出',click:()=>app.quit()}
]);}
function createPetWindow(a,geometry){
  if(petWindows.has(a.id)&&!petWindows.get(a.id).isDestroyed())return petWindows.get(a.id);
  const isMain=a.id==='main';
  if(!geometry){const actors=[state.actors.find(item=>item.id==='main'),...state.actors.filter(item=>item.id!=='main'&&(item.present||item===a))];geometry=desktopGeometry(a,Math.max(0,actors.indexOf(a)),actors.map(item=>petLayout(actorKind(item),state.originalPet,petAppearance.layoutOptions(state,item))));}
  const {width,height,x,y}=geometry.bounds,stageWidth=geometry.stageWidth;a.stageWidth=stageWidth;
  const w=new BrowserWindow({...options(),width,height,x,y,title:a.name,transparent:true,frame:false,resizable:false,hasShadow:false,alwaysOnTop:true,skipTaskbar:true,fullscreenable:false});
  w.setIgnoreMouseEvents?.(true,{forward:true});
  w.webContents.setZoomFactor?.(geometry.scale);
  w.setAlwaysOnTop(true,'floating');w.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  loadLocalFile(w,{view:'pet',actor:a.id,stageWidth:String(stageWidth)});
  w.webContents.on('did-finish-load',()=>{broadcast();catMotion.replay(a.id);if(!workbenchOnly&&(isMain||a.present))w.showInactive();if(!isMain)keepMainInFront(a.id);});
  const windowId=a.id;w.webContents.setWindowOpenHandler(()=>({action:'deny'}));petWindows.set(windowId,w);petGeometry.set(windowId,JSON.stringify(geometry.bounds));w.once('closed',()=>{if(petWindows.get(windowId)===w){petWindows.delete(windowId);petGeometry.delete(windowId);draggingPets.delete(windowId);motionInputs.delete(windowId);}});return w;
}
function createWindows(){
  createPetWindow(state.actors.find(a=>a.id==='main'));
  if(process.platform==='win32'){
    const icon=nativeImage.createFromPath(path.join(base,'assets','icons','bigfish.ico'));
    tray=new Tray(icon.isEmpty()?nativeImage.createFromPath(path.join(base,'assets','icons','bigfish.png')):icon);
  }else{
    tray=new Tray(nativeImage.createEmpty());
    tray.setTitle('🐾');
  }
  tray.setToolTip('N.E.K.O. 桌宠');
  tray.on('right-click',()=>tray.popUpContextMenu(mainMenu()));tray.on('click',()=>showInput());
}
const yuiHomeIpc=createYuiHomeIpc({assertCaller:assertWorkbenchCaller,userDataDirectory:runtimePaths.userDataDir,
  publish:value=>{if(dshWindow&&!dshWindow.isDestroyed()&&isWorkbenchOrigin(dshWindow.webContents.getURL()))dshWindow.webContents.send('workbench:home-state',value);}});
ipcMain.handle('workbench:home',yuiHomeIpc);
const ourHomeRuntime=createOurHomeRuntime({workspaceDir:workspace,getStorage:yuiHomeIpc.getStorage,onError:()=>{void yuiHomeIpc.getStorage().then(store=>{if(dshWindow&&!dshWindow.isDestroyed()&&isWorkbenchOrigin(dshWindow.webContents.getURL()))dshWindow.webContents.send('workbench:home-state',{...store.state(),buildError:'共建数据暂未更新，请检查后重试；已保留上次布置。'});}).catch(()=>{});}});
const homeReady=ourHomeRuntime.start().catch(()=>null);
ipcMain.handle('screen-share:call',(event,method,value)=>screenShare.action(event,method,value));
ipcMain.handle('workbench:screen-share',async(event,method)=>{assertWorkbenchCaller(event);if(method==='hide'){screenShare.hide();return {ok:true};}throw new Error('未知屏幕操作');});
ipcMain.handle('workbench:lobby',async(event,request)=>{
  assertWorkbenchCaller(event);
  if(request?.action==='sign-out'||request?.action==='sign-in-cancel')unifiedNekoLogin.cancel();
  if(request?.action==='open'){screenShare.hide();await communityController.action(dshWindow,{action:'hide'});}
  if(['state','open','cat-save','mode-set','suggest'].includes(request?.action))await mainChatRuntime?.refreshLobbyAccount({force:request.action!=='state'});
  return lobbyController.request(request);
});
ipcMain.handle('workbench:community',async(event,request)=>{
  assertWorkbenchCaller(event);
  if(request?.action==='open')screenShare.hide();
  try{return await communityController.action(dshWindow,request);}
  finally{nativeDividerController.setEnabled(communityController.hasVisibleView);nativeDividerController.raise(request?.action==='open');nativeComposerController.raise();}
});
ipcMain.handle('workbench:divider',(event,request)=>{assertWorkbenchCaller(event);return nativeDividerController.place(dshWindow,request);});
ipcMain.handle('workbench:video-window',(event,request)=>{assertWorkbenchCaller(event);return videoFloatController.action(dshWindow,request);});
ipcMain.handle('workbench:account-menu-layer',(event,request)=>{
  assertWorkbenchCaller(event);
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).join(',')!=='rect')throw Error('无效账号菜单区域');
  const r=request.rect;
  if(r!==null&&(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='height,width,x,y'||!Object.values(r).every(value=>Number.isFinite(value)&&Math.abs(value)<100000)||r.width<=0||r.height<=0))throw Error('无效账号菜单区域');
  nativeComposerController.setAccountMenuRect(r);videoFloatController.setAccountMenuRect(r);
  return {ok:true};
});
ipcMain.handle('workbench:questions',(event,request)=>{assertWorkbenchCaller(event);return questionRelay.accept(event.sender,request);});
ipcMain.handle('workbench:native-composer',(event,request)=>{
  assertWorkbenchCaller(event);
  if(request?.action==='update')return nativeComposerController.update(request.state);
  if(request?.action==='place'||request?.action==='remove'){
    const result=nativeComposerController.place(dshWindow,request);
    // The work composer is also needed over the chatroom or home, where no
    // community WebContentsView exists. Its own place/remove lifecycle owns
    // visibility; site view changes only affect stacking order.
    nativeComposerController.setEnabled(request.action==='place');nativeComposerController.raise();return result;
  }
  throw new Error('未知工作区浮窗操作');
});
ipcMain.handle('workbench:community-account',async(event,action)=>{
  assertWorkbenchCaller(event);
  if(action!=='cancel'&&!communityController.isOpen)throw new Error('请先打开社区');
  return communityAccount.action(action);
});
ipcMain.on('workbench:community-web-account',(event,value)=>{
  communityController.acceptAccountState(event,value);
});
function nekoAccountSnapshot(){
  const lobby=lobbyController.snapshot();return {community:communityController.accountState,lobby:{status:lobby?.auth?.status||'unavailable'},login:unifiedNekoLogin?.snapshot()||{status:'idle',message:'',error:''}};
}
ipcMain.handle('workbench:roles',async(event,method,p={})=>{
  assertWorkbenchCaller(event);
  if(method==='state')return rolesState();
  if(method==='update'){workbenchRoles.update(p.id,p.patch);publishRoles();return rolesState();}
  if(method==='select'){screenShare.hide();workbenchRoles.select(p.id);publishRoles();return rolesState();}
  if(method==='upload'){
    const role=workbenchRoles.get().roles.find(item=>item.id===p.id);if(!role)throw new Error('未知角色');
    const image=await chooseAvatar('上传'+role.name+'头像');if(!image)return null;
    workbenchRoles.upload(role.id,image);publishRoles();return rolesState();
  }
  throw new Error('未知角色选项');
});
ipcMain.handle('workbench:call',async(event,method,value)=>{
  assertWorkbenchCaller(event);
  if(method==='feedback')return feedback(value);
  if(method==='window-theme'){updateWorkbenchWindowTheme(dshWindow,value);return {ok:true};}
  if(method==='state')return workbenchState();
  if(method==='workspace'){
    const p=value;
    if(!p||typeof p!=='object'||Array.isArray(p))throw Error('工作台请求无效');
    assertCodexActionAllowed(p.action);
    if(p.action==='state')return workspaceController.state();
    if(p.action==='home-session'){
      if(!await homeReady)throw Error('小窝共建目录暂不可用');if(state.connection!=='ready')throw Error('工作台尚未连接');
      const result=await rpc('home-session',{sessionId:state.homeSessionId||null});state.homeSessionId=result.sessionId;update();return result;
    }
    if(p.action==='pane-layout')return paneLayout.get();
    if(p.action==='set-pane-layout')return paneLayout.set(p.layout);
    if(p.action==='video-platform')return videoPlatform.get();
    if(p.action==='set-video-platform')return videoPlatform.set(p.platform);
    if(p.action==='update'){workspaceController.update(p.patch);workspaceRevision++;broadcast();return workspaceController.state();}
    if(p.action==='catalog')return workspaceController.catalog({force:p.force===true,dshOffset:p.dshOffset??0});
    if(p.action==='resolve-project')return workspaceController.resolveProject(p.projectId);
    if(p.action==='update-seat'){workspaceController.updateSeat(p.id,p.patch);workspaceRevision++;broadcast();return workspaceController.state();}
    if(p.action==='upload-seat'){
      if(!workspaceLayout.get().seats.some(s=>s.id===p.id))throw Error('工作入口不存在');
      const image=await chooseAvatar('上传工作 agent 头像');if(image){workspaceController.uploadSeat(p.id,image);workspaceRevision++;}broadcast();return workspaceController.state();
    }
    if(p.action==='codex-read')return codexWorkspace.read(p.id);
    if(p.action==='codex-state')return codexWorkspace.snapshot();
    if(p.action==='codex-models')return CODEX_AVAILABLE?codexWorkspace.models({force:p.force===true}):{models:[]};
    if(p.action==='codex-model-choices')return CODEX_AVAILABLE?codexModelChoices.get():{};
    if(p.action==='codex-model-choice')return codexModelChoices.set(p.id,{model:p.model,effort:p.effort});
    if(p.action==='codex-send')return codexWorkspace.send({id:p.id,cwd:p.cwd,message:p.message,model:p.model,effort:p.effort});
    if(p.action==='codex-stop')return codexWorkspace.stop();
    if(p.action==='codex-approve')return codexWorkspace.approve(p.key,p.decision);
    if(p.action==='choose-project'){
      const result=await dialog.showOpenDialog(dshWindow,{title:'选择工作项目',properties:['openDirectory']});
      return result.canceled?null:codexWorkspace.allowRoot(result.filePaths[0]);
    }
    throw Error('未知工作台请求');
  }
  if(method==='companion'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('聊天请求无效');
    if(value.action==='read')return companionSnapshot(state);
    if(value.action==='history')return mainChatRuntime.history({beforeId:typeof value.beforeId==='string'?value.beforeId:undefined,limit:value.limit});
    if(value.action==='qq-history'||value.action==='wechat-history')return mainChatRuntime.history({source:value.action==='qq-history'?'qq':'wechat',beforeId:typeof value.beforeId==='string'?value.beforeId:undefined,limit:40});
    if(value.action==='weixin-begin')return weixinClawBot.begin();
    if(value.action==='weixin-pin')return weixinClawBot.pin(value.code);
    if(value.action==='weixin-cancel')return weixinClawBot.cancel();
    if(value.action==='weixin-disconnect')return weixinClawBot.disconnect();
    if(value.action==='weixin-resume')return weixinClawBot.resume();
    if(value.action==='media')return mainChatRuntime.readMedia(value.id);
    if(value.action==='stop'){if(usesMainChatService(mainChatRuntime?.backend))cancelMainChat();else nekoChat.close();return companionSnapshot(state);}
    if(value.action==='send'){
      let text=String(value.text||'').trim();
      if(value.attachments?.length){if(!usesMainChatService(mainChatRuntime?.backend))throw Error('当前聊天线路暂不支持附加图片');if(activeApiRequest||busy(state.actors[0]))throw Error('我还在回复，等我一下。');text=mainChatRuntime.prepareMedia(text,value.attachments);}
      if(!text||text.length>8000)throw Error('请输入 1–8000 字的消息');
      const a=state.actors[0];
      if(usesMainChatService(mainChatRuntime?.backend))return startApiPrompt(text);
      if(!state.neko.enabled)throw Error('请先设置主 agent 的聊天连接');
      if(busy(a))throw Error('主 agent 正在回复');
      if(state.neko.connection!=='ready')await connectNeko();
      if(state.neko.connection!=='ready')throw Error('主 agent 聊天尚未连接，请检查设置');
      const result=nekoChat.send(text,{environmentContext:ourHomeRuntime.context()});a.messages.push({role:'user',text,time:Date.now(),requestId:result.requestId});acceptHuman(a,{text,time:Date.now()});update();return result;
    }
    throw Error('未知聊天请求');
  }
  if(method==='accounts'){
    if(value==null||typeof value!=='object'||Array.isArray(value))throw new Error('账号读取参数无效');
    const codex=CODEX_AVAILABLE?await codexAccount.read({includeQuota:value.includeQuota===true,force:value.force===true}):{status:'testing',authType:null,planType:null,quota:{status:'unavailable',buckets:[]}};
    return {neko:nekoAccountSnapshot(),codex};
  }
  if(method==='community-login'||method==='neko-sign-in')return unifiedNekoLogin.begin(value===undefined?{}:value);
  if(method==='neko-sign-in-cancel')return unifiedNekoLogin.cancel();
  if(method==='fish'){return fishAction(value);}
  if(method==='qqbot'){return qqbotAction(value);}
  if(method==='fish-qq'){return fishQqAction(value);}
  if(method==='avatar'){workbenchAppearance.select(value);broadcast();return workbenchState();}
  if(method==='upload-avatar'){
    const image=await chooseAvatar();if(!image)return null;
    workbenchAppearance.upload(image);broadcast();return workbenchState();
  }
  if(method==='action')return workbenchAction(value);
  throw new Error('未知工作台操作');
});
ipcMain.handle('pet:call',async(event,method,p={})=>{
  const sender=BrowserWindow.fromWebContents(event.sender),senderId=[...petWindows.entries()].find(([,w])=>w===sender)?.[0];
  const renameId=[...renameWindows.entries()].find(([,w])=>w===sender)?.[0];
  if(!senderId&&!renameId&&sender!==memoryWindow&&sender!==settingsWindow&&sender!==nekoSettingsWindow&&sender!==chatSettingsWindow&&sender!==chatMemoryWindow)throw new Error('未知窗口');
  assertLocalCaller(event,sender);
  if(method==='open-workbench'){if(!senderId)throw new Error('请从桌宠打开工作台');await openDsh();return true;}
  if(method==='state')return state;
  if(method==='question-reveal'){const actor=state.actors.find(a=>a.id===senderId);return !!actor&&actor.id!=='main'&&nativePet(actor)&&petQuestionController.reveal(senderId);}
  if(method==='motion-input'&&senderId==='main'&&p.active)channelLife.touch();
  if(method==='prompt')channelLife.touch();
  if(method==='chat-settings-read'){if(sender!==chatSettingsWindow)throw new Error('请从聊天设置操作');return mainChatRuntime?.read({checkSecureStorage:true})||state.mainChat;}
  if(method==='chat-open-neko-settings'){if(sender!==chatSettingsWindow)throw new Error('请从聊天设置操作');editNekoSettings();return true;}
  if(method==='chat-open-memory'){if(sender!==chatSettingsWindow)throw new Error('请从聊天设置操作');editChatMemory();return true;}
  if(method==='chat-use-deepseek-account'){
    if(sender!==chatSettingsWindow||!mainChatRuntime)throw new Error('请从聊天设置操作');
    screenShare.interrupt();cancelMainChat();
    try{const result=await mainChatRuntime.selectBackend('deepseek-account');activeApiRequest=null;await refreshApiHistory();return result;}
    catch{throw new Error('工作台账号聊天暂不可用，请检查连接后重试。');}
  }
  if(method==='chat-settings-save'){
    if(sender!==chatSettingsWindow||!mainChatRuntime)throw new Error('聊天设置尚未就绪');
    screenShare.interrupt();
    const result=await mainChatRuntime.saveApi(p);activeApiRequest=null;await refreshApiHistory();return result;
  }
  if(method==='chat-memory-read'){if(sender!==chatMemoryWindow||!mainChatRuntime)throw new Error('请从聊天记忆窗口操作');return memoryViewer.read(p.personaId);}
  if(method==='chat-history'){if(sender!==chatMemoryWindow||!mainChatRuntime)throw new Error('请从聊天记忆窗口操作');return memoryViewer.history(p.personaId);}
  if(method==='chat-memory-action'){
    if(sender!==chatMemoryWindow||!mainChatRuntime)throw new Error('请从聊天记忆窗口操作');
    try{return await memoryViewer.action(p);}catch{throw new Error('记忆操作未完成，请刷新后重试');}
  }
  if(method==='chat-cancel'){if(senderId!=='main'||!usesMainChatService(mainChatRuntime?.backend))throw new Error('请从主角色聊天操作');return cancelMainChat();}
  if(method==='neko-settings'){
    if(sender!==nekoSettingsWindow)throw new Error('请从主角色右键菜单打开聊天设置。');
    const baseUrl=localBase(p.baseUrl),character=String(p.character||'').trim();if(character.length>80||!mainChatRuntime)throw new Error('聊天设置尚未就绪');
    await mainChatRuntime.selectBackend('neko');activeApiRequest=null;state.neko.enabled=true;state.neko.baseUrl=baseUrl;state.neko.character=character;await connectNeko();
    if(state.neko.connection!=='ready')throw new Error(state.neko.error||'N.E.K.O. 连接失败');return true;
  }
  if(method==='rename'){const a=state.actors.find(a=>a.id===renameId);if(!a||a.id==='main')throw new Error('请从子代理右键菜单修改名字。');a.nickname=nickname(p.name);a.name=displayName(a);update();setTimeout(()=>{if(!sender.isDestroyed())sender.close();},100);return true;}
  if(method==='settings'){if(sender!==settingsWindow)throw new Error('请从主角色右键菜单打开设置。');const n=Number(p.helperLimit);if(!Number.isInteger(n)||n<1||n>32)throw new Error('请输入 1～32 的整数。');if(!setHelperLimit(n))throw new Error('上限不能少于已常驻的 '+pinnedCount()+' 只角色。');return true;}
  if(method==='menu'){const a=state.actors.find(a=>a.id===senderId);if(a)(senderId==='main'?mainMenu():childMenu(a)).popup({window:sender});return true;}
  if(method==='open-task'){const a=state.actors.find(a=>a.id===senderId);if(a?.kind!=='task')throw new Error('请从任务角色打开对应会话');await openTaskSession(a);return true;}
  if(method==='move'){if(senderId){draggingPets.add(senderId);const [x,y]=sender.getPosition();sender.setPosition(x+Math.round(Math.max(-500,Math.min(500,p.dx||0))),y+Math.round(Math.max(-500,Math.min(500,p.dy||0))));}return true;}
  if(method==='move-end'){if(senderId){draggingPets.delete(senderId);catMotion.resumeFromDrag(senderId);const [x,y]=sender.getPosition();state.positions[senderId]={x,y};save();}return true;}
  if(method==='motion-input'){if(senderId){if(p.active===true)motionInputs.add(senderId);else motionInputs.delete(senderId);}return true;}
  if(method==='pass-through'){if(senderId)sender.setIgnoreMouseEvents?.(p.ignore===true,{forward:true});return true;}
  if(method==='memory'){if(sender!==memoryWindow)throw new Error('请从主角色右键菜单打开记忆。');state.memory=String(p.text||'').split('\n').map(x=>x.trim()).filter(Boolean).slice(0,40);update();return true;}
  if(method==='prompt'){
    const a=state.actors.find(x=>x.id===senderId),text=String(p.text||'').trim();
    if(!a||p.id!==a.id||!text||text.length>30000)throw new Error('请输入消息。');
    if(a.id==='main'){
      screenShare.interrupt();
      if(usesMainChatService(mainChatRuntime?.backend))return startApiPrompt(text);
      if(!state.neko.enabled)throw new Error('请从右键菜单打开聊天 API 设置。');
      if(busy(a))throw new Error('我还在回复，等我一下。');
      if(state.neko.connection!=='ready')await connectNeko();
      if(state.neko.connection!=='ready')throw new Error(state.neko.error||'N.E.K.O. 未连接');
      const result=nekoChat.send(text,{environmentContext:ourHomeRuntime.context()});a.messages.push({role:'user',text,time:Date.now(),requestId:result.requestId});acceptHuman(a,{text,time:Date.now()});a.task='与 '+state.neko.character+' 聊天';update();return result;
    }
    if(state.connection!=='ready')throw new Error('还没连上，右键大肥鱼可重新连接。');
    if(a.id!=='main'&&a.mode!=='continuable')throw new Error('这个 DSH 子任务是只读记录，请在内置 DSH 查看。');
    if(busy(a))throw new Error('我还在做，等我一下。');
    clearTimeout(terminalTimers.get(a.id));terminalTimers.delete(a.id);
    a.messageStart=a.messages.length;a.stopRequested=false;a.messages.push({role:'user',text,time:Date.now()});acceptHuman(a,{text:cleanPrompt(text),time:Date.now()});a.currentActivity='';if(a.id==='main')a.task=cleanPrompt(text);a.status='working';a.active=true;a.displayUntil=0;a.notice=null;setWork(a,'thinking',null);update();
    const memory=state.memory.length?'\n工作台任务备注（不作为人格记忆或用户确认事实）：\n'+state.memory.map(x=>'- '+x).join('\n'):'';
    const prompt=`${text}\n\n[桌宠本地上下文]${memory}\n工作目录：${workspace}。需要保存的代码、文字、数据放在这个目录。可以按任务需要使用 DSH 的原生子代理；子代理由 DSH 按实际任务命名。任务结果用中文简短回复，失败时如实说明。`;
    try{const r=await rpc('prompt',{sessionId:a.sessionId,text:prompt});a.sessionId=r.sessionId;a.parentSessionId=r.parentSessionId||a.parentSessionId;if(a.stopRequested)await rpc('stop',{sessionId:a.sessionId});update();return r;}
    catch(error){a.status='error';a.messages.push({role:'error',text:error.message,time:Date.now()});setWork(a,'error');finishAppearance(a);update();throw error;}
  }
  throw new Error('未知操作');
});
// Opt-in read-only native evidence capture; disabled for normal launches.
if(process.env.PET_CAPTURE_SIGNAL==='1')process.on('SIGUSR1',()=>capture().catch(error=>fs.appendFileSync(path.join(data,'capture-error.log'),String(error)+'\n')));
app.on('second-instance',()=>{openDsh().catch(engineError);});
app.on('activate',()=>{if(workbenchOnly&&dshWindow&&!dshWindow.isDestroyed()&&dshWindow.isVisible()){dshWindow.focus();return;}if(petWindows.size&&![...petWindows.values()].some(w=>!w.isDestroyed()&&w.isVisible()))showInput();});
app.whenReady().then(async()=>{
  prepareRuntimeDirectories(runtimePaths);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'N.E.K.O.',submenu:[{label:'和大肥鱼说话',click:()=>showInput()},{label:'猫娘串门…',click:openVisits},{label:'主角色菜单',click:popupMainMenu},{label:'保存桌宠截图',accelerator:'CommandOrControl+Shift+S',click:capture},{label:'退出',role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]}]));
  createWindows();try{await startMainChat();}catch{if(!quitting)mainChatFailure();}
  if(quitting)return;
  void weixinClawBot.initialize();
  if(communityDaily.status().enabled){try{void ensureVisitsController().initialize().catch(()=>{}).finally(()=>communityDaily.start());}catch{communityDaily.start();}}else communityDaily.start();
  channelLife.start();startEngine().catch(engineError);connectNeko();if(process.env.PET_OPEN_WORKBENCH==='1')openDsh().catch(engineError);
});
let shutdownStarted=false,shutdownComplete=false;
app.on('before-quit',event=>{
  if(shutdownComplete)return;
  event.preventDefault();
  if(shutdownStarted)return;
  channelLife.dispose();
  weixinClawBot.dispose();
  communityDaily.dispose();
  dshLoginBrowser.dispose();
  questionRelay.dispose();petQuestionController.dispose();
  shutdownStarted=true;quitting=true;unifiedNekoLogin.dispose();nekoSsoWindow.dispose();ourHomeRuntime.dispose();videoFloatController.dispose();nativeComposerController.dispose();nativeDividerController.dispose();communityController.dispose();communityAccount.cancel();lobbyController.dispose();screenShare.dispose();catMotion.dispose();clearTimeout(nekoRetry);clearTimeout(rosterTimer);for(const timer of terminalTimers.values())clearTimeout(timer);terminalTimers.clear();nekoChat.close();save();
  const current=childLifecycle;
  Promise.allSettled([visitsController?.close(),mainChatRuntime?.close(),current?.stop(),codexAccount.dispose(),codexWorkspace.dispose()]).finally(()=>{shutdownComplete=true;app.quit();});
});
process.on('SIGTERM',()=>app.quit());
process.on('SIGINT',()=>app.quit());
app.on('window-all-closed',()=>{if(quitting)app.quit();});
