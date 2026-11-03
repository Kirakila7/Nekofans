/**
 * Copy these function declarations into the white-label client factory.
 * No imports, globals, credentials access or authentication ownership.
 * Account actions delegate to the existing workbench/native auth owners.
 *
 * installNekoAccountHabitat(ctx, {
 *   cssText: ACCOUNT_HABITAT_CSS, developerAvatarSrc: builtinSrc('devcat'),
 *   idleVideoSrc: ORIGINAL_IDLE_WEBM_DATA_URL, idlePosterSrc: ACCOUNT_PET_ART.still,
 *   version: '0.2.1-rc.3'
 * }) -> disposer
 *
 * ORIGINAL_IDLE_WEBM_DATA_URL must contain the unchanged assets/idle.webm.
 * Stop the old installAccountMenuSkin() effect before installing this adapter.
 * exports.inject must include 'remote', 'remote.account', 'locale' as well as
 * the existing 'slots'/'uiWorkspace'. The client manifest must depend on
 * @deepseek-ai/dsh-api-remotes and @deepseek-ai/dsh-client-locale.
 */

function formatNekoWalletBalance(decimal, currency) {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : null;
  if (!symbol || typeof decimal !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(decimal)) return null;
  const negative = decimal[0] === '-';
  const unsigned = decimal.replace(/^[+-]/, '');
  const parts = unsigned.split('.');
  const integer = parts[0].replace(/^0+(?=\d)/, '');
  const fraction = parts[1] || '';
  const nonzero = /[1-9]/.test(integer + fraction);
  if (!nonzero) return symbol + '0.00';
  if (integer === '0' && !/[1-9]/.test(fraction.slice(0, 2))) return negative ? '-' + symbol + '0.01' : '<' + symbol + '0.01';
  let cents = BigInt(integer) * 100n + BigInt((fraction + '00').slice(0, 2));
  // Match the native AccountSection's positive truncation/negative rounding.
  if (negative && (fraction[2] || '0') >= '5') cents += 1n;
  const whole = String(cents / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (negative ? '-' : '') + symbol + whole + '.' + String(cents % 100n).padStart(2, '0');
}

// Keep the original USD helper for existing bundle test callers.
function formatNekoUsdWallet(decimal) { return formatNekoWalletBalance(decimal, 'USD'); }

function nekoAccountBalanceLabel(snapshot) {
  if (snapshot.status === 'ready' && snapshot.amount !== null && ['CNY', 'USD'].includes(snapshot.currency)) return snapshot.currency + ' 余额 ' + snapshot.amount;
  return '暂不可读取';
}

function createNekoAccountBalanceReader(ctx, options) {
  options = options || {};
  const source = '官方充值钱包';
  const listeners = new Set();
  let generation = 0, disposed = false, pending = null;
  let snapshot = Object.freeze({ signedIn: null, status: 'unavailable', amount: null, currency: null, source, fetchedAt: null });
  function publish(next) {
    if (disposed) return;
    snapshot = Object.freeze(next);
    for (const listener of Array.from(listeners)) {
      try { listener(snapshot); } catch (_) {}
    }
  }
  function unavailable(signedIn, status) {
    return { signedIn, status: status || 'unavailable', amount: null, currency: null, source, fetchedAt: null };
  }
  function unwrap(result) {
    if (!result || result.ok !== true) throw new Error('账号读取失败');
    return result.value;
  }
  function metadata() {
    let locale = 'zh-CN';
    try { locale = ctx.locale.getSnapshot().active || locale; } catch (_) {}
    return {
      version: options.version || '0.2.1-rc.3',
      locale,
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    };
  }
  function invalidate(signedIn) {
    generation++;
    pending = null;
    publish(unavailable(typeof signedIn === 'boolean' ? signedIn : null));
  }
  function refresh() {
    if (disposed) return Promise.resolve(snapshot);
    if (pending) return pending.promise;
    const own = { generation: ++generation, promise: null };
    const live = () => !disposed && own.generation === generation;
    publish(unavailable(snapshot.signedIn, 'loading'));
    own.promise = (async () => {
      try {
        const account = ctx.remote && ctx.remote.account;
        if (!account || typeof account.getState !== 'function' || typeof account.getBalance !== 'function') throw new Error('账号服务未就绪');
        const before = unwrap(await account.getState());
        if (!live()) return snapshot;
        if (!before || before.status !== 'credential-stored') {
          publish(unavailable(false, 'signed-out'));
          return snapshot;
        }
        const client = metadata();
        const balance = unwrap(await account.getBalance(client));
        if (!live()) return snapshot;
        // The Host returns null if the grant changed during a balance request.
        if (!balance || balance.status !== 'ready' || !Array.isArray(balance.value)) {
          publish(unavailable(true));
          return snapshot;
        }
        // Prefer the UI's native currency without conversion or summation. If
        // both exist, Chinese locales choose CNY; other locales choose USD.
        const preferred = /^zh(?:[-_]|$)/i.test(String(client.locale)) ? ['CNY', 'USD'] : ['USD', 'CNY'];
        const currency = preferred.find(code => balance.value.some(wallet => wallet && wallet.currency === code)) || null;
        const wallets = currency ? balance.value.filter(wallet => wallet && wallet.currency === currency) : [];
        const amount = wallets.length === 1 ? formatNekoWalletBalance(wallets[0].balance, currency) : null;
        if (amount === null) {
          publish(unavailable(true));
          return snapshot;
        }
        const after = unwrap(await account.getState());
        if (!live()) return snapshot;
        if (!after || after.status !== 'credential-stored' || (options.isStillSignedIn && !options.isStillSignedIn())) {
          publish(unavailable(false, 'signed-out'));
          return snapshot;
        }
        publish({ signedIn: true, status: 'ready', amount, currency, source, fetchedAt: new Date().toISOString() });
      } catch (_) {
        if (live()) publish(unavailable(snapshot.signedIn));
      } finally {
        if (pending === own) pending = null;
      }
      return snapshot;
    })();
    pending = own;
    return own.promise;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    invalidate,
    refresh,
    dispose() { disposed = true; generation++; pending = null; listeners.clear(); },
  };
}

function installNekoAccountHabitat(ctx, options) {
  options = options || {};
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  if (!doc || !doc.body || !win || typeof win.MutationObserver !== 'function') return () => {};
  const triggerSelector = '[data-slot="settings.launcher"] button[aria-haspopup="menu"][data-collapsed][data-signed-out]';
  const menuSelector = '[data-menu-material][role="menu"], [data-menu-material]._list_4ub78_7';
  const style = doc.createElement('style');
  style.id = options.styleId || 'neko-account-habitat-style';
  style.textContent = options.cssText || '';
  if (doc.getElementById(style.id)) return () => {};
  doc.head.appendChild(style);
  let stopped = false, scheduled = false, launcher = null, menuRecord = null, nativeSignedIn = null;
  const accountsBridge = options.accountsBridge || (typeof win.nekoWorkbench?.getAccounts === 'function' ? win.nekoWorkbench : null);
  let accountPending = null;
  let menuLayerKey=null,menuLayerResizeObserver=null,menuLayerResizeTarget=null,loginDialogElement=null;
  function reportMenuLayer(){
    if(typeof accountsBridge?.accountMenuLayer!=='function')return;
    const node=!stopped&&doc.visibilityState!=='hidden'?(loginDialogElement?.isConnected?loginDialogElement:menuRecord?.element):null;
    if(node!==menuLayerResizeTarget){menuLayerResizeObserver?.disconnect();menuLayerResizeTarget=node;if(node&&typeof win.ResizeObserver==='function'){menuLayerResizeObserver??=new win.ResizeObserver(reportMenuLayer);menuLayerResizeObserver.observe(node);}}
    const box=node?.getBoundingClientRect();
    const rect=box&&[box.left,box.top,box.width,box.height].every(value=>Number.isFinite(value)&&Math.abs(value)<100000)&&box.width>0&&box.height>0?{x:box.left,y:box.top,width:box.width,height:box.height}:null;
    const key=JSON.stringify(rect);if(key===menuLayerKey)return;menuLayerKey=key;
    try{Promise.resolve(accountsBridge.accountMenuLayer({rect})).catch(()=>{if(menuLayerKey===key)menuLayerKey=null;});}catch{menuLayerKey=null;}
  }
  let nekoSnapshot = null, nekoRevision = 0, nekoActionPending = false, nekoCancelPending = false, nekoActionEpoch = 0, nekoActionError = '',nekoRelayFlowId=null;
  let reduced = false, lastAnnouncement = '';
  const releases = [];
  const motion = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  reduced = !!(motion && motion.matches);
  const reader = createNekoAccountBalanceReader(ctx, {
    version: options.version,
    isStillSignedIn: () => !!launcher && launcher.element.isConnected && launcher.element.getAttribute('data-signed-out') === 'false',
  });
  const announcement = doc.createElement('span');
  announcement.className = 'neh-screen-reader';
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  announcement.setAttribute('data-neko-account-owned', 'announcement');
  doc.body.appendChild(announcement);

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function mediaSource(value, video) {
    if (typeof value !== 'string' || !value) return '';
    if (video ? /^data:video\/webm;base64,[A-Za-z0-9+/]+=*$/.test(value) : /^data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]/.test(value)) return value;
    try {
      const url = new URL(value, doc.baseURI);
      if (url.origin === win.location.origin && ['http:', 'https:', 'blob:'].includes(url.protocol)) return url.href;
    } catch (_) {}
    return '';
  }
  const developerSrc = mediaSource(options.developerAvatarSrc, false);
  const signedOutSrc = mediaSource(options.signedOutIconSrc, false);
  const videoSrc = mediaSource(options.idleVideoSrc, true);
  const posterSrc = mediaSource(options.idlePosterSrc, false);
  function pauseMedia(root) {
    if (!root) return;
    for (const video of root.querySelectorAll('video')) {
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
    }
  }
  function clearOwned(root) {
    pauseMedia(root);
    root.replaceChildren();
  }
  function addPet(world) {
    const pet = element('span', 'neh-pet');
    pet.setAttribute('aria-hidden', 'true');
    if (reduced || !videoSrc || doc.visibilityState === 'hidden') {
      if (posterSrc) {
        const image = element('img', 'neh-pet-poster');
        image.src = posterSrc; image.alt = ''; image.draggable = false;
        pet.appendChild(image);
      }
    } else {
      const video = element('video', 'neh-pet-video');
      video.muted = true; video.defaultMuted = true; video.autoplay = true;
      video.loop = true; video.playsInline = true; video.preload = 'metadata';
      video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
      if (posterSrc) video.poster = posterSrc;
      video.src = videoSrc;
      pet.appendChild(video);
      // Playback failure keeps the original video's poster, not a replacement animation.
      try { const playing = video.play(); if (playing && playing.catch) playing.catch(() => {}); } catch (_) {}
    }
    world.appendChild(pet);
  }
  function balanceLabel(snap) {
    return nekoAccountBalanceLabel(snap);
  }
  function effectiveSignedIn(snap) { return nativeSignedIn === true && snap.signedIn !== false; }
  function dshLoginLabel(snap) { return nativeSignedIn === null ? '检测中' : effectiveSignedIn(snap) ? '已登录' : '未登录'; }
  function refreshNekoAccount(force = false) {
    if (!accountsBridge || stopped) return Promise.resolve();
    if (accountPending) return accountPending.promise;
    const own = { promise: null, nekoRevision };
    own.promise = Promise.resolve().then(() => accountsBridge.getAccounts({ includeQuota: false, force })).then(result => {
      if (!stopped && result?.neko && own.nekoRevision === nekoRevision) nekoSnapshot=result.neko;
    }, () => {}).finally(() => {
      if (accountPending === own) accountPending = null;
      if (!stopped) render();
    });
    accountPending = own;
    return own.promise;
  }
  function nekoLabel(value) { return ({'signed-in':'已登录','signed-out':'未登录',checking:'检测中',authorizing:'授权中',unknown:'待打开社区',unavailable:'暂不可读取',unconfigured:'未连接'})[value?.status] || '暂不可读取'; }
  function nekoSummary() { return nekoSnapshot ? '，N.E.K.O. 社区 '+nekoLabel(nekoSnapshot.community)+'，聊天室 '+nekoLabel(nekoSnapshot.lobby) : ''; }
  function nekoFlowBusy() { return ['checking','community','chatroom'].includes(nekoSnapshot?.login?.status); }
  function closeAccountMenu() { if (launcher?.element.getAttribute('aria-expanded') === 'true') launcher.element.click(); }
  function afterMenuClosed(callback) { closeAccountMenu(); win.setTimeout(() => { if (!stopped) callback(); }, 0); }
  function workbenchSettings() {
    const button=element('button','neh-workbench-settings','工作台设置');button.type='button';button.dataset.nekoWorkbenchSettings='';
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();const returnFocus=launcher?.element;afterMenuClosed(()=>{doc.dispatchEvent(new win.CustomEvent('neko-workbench-open-settings',{detail:{tab:'general',returnFocus}}));});});
    return button;
  }
  async function openNekoCommunity(startLogin,isCurrent=()=>true) {
    const detail={login:startLogin,source:'account',isCurrent};doc.dispatchEvent(new win.CustomEvent('neko-account-open-community',{detail}));
    if(detail.handled){const result=await detail.promise;if(result?.ok===false)throw Error('unavailable');return;}
    doc.dispatchEvent(new win.CustomEvent('neko-unified-open-community',{detail}));await detail.promise;
    if(startLogin&&!stopped&&isCurrent()){const login=accountsBridge.nekoSignIn||accountsBridge.communityLogin;if(typeof login!=='function')throw Error('unavailable');const result=await login.call(accountsBridge);if(result?.ok===false)throw Error('unavailable');}
  }
  async function startNekoLogin({reauthorize=false}={}) {
    if(nekoActionPending||nekoCancelPending||nekoFlowBusy())return;const epoch=++nekoActionEpoch;nekoActionPending=true;nekoActionError='';nekoRevision++;render();closeAccountMenu();
    try{if(typeof accountsBridge.nekoSignIn==='function'){const result=await accountsBridge.nekoSignIn({source:'account',...(reauthorize?{reauthorize:true}:{})});if(result?.ok===false)throw Error('unavailable');if(!stopped&&epoch===nekoActionEpoch)await relayAccountLogin(result?.state,()=>!stopped&&epoch===nekoActionEpoch);}else await openNekoCommunity(true,()=>!stopped&&epoch===nekoActionEpoch);}catch{if(!stopped&&epoch===nekoActionEpoch&&!nekoSnapshot?.login?.error)nekoActionError='N.E.K.O. 登录未能开始，请重试。';}
    finally{if(epoch===nekoActionEpoch){nekoActionPending=false;if(!stopped){render();void refreshNekoAccount(true);}}}
  }
  async function relayAccountLogin(flow,isCurrent=()=>!stopped){
    if(flow?.source!=='account'||flow.status!=='community'||!Number.isSafeInteger(flow.flowId)||nekoRelayFlowId===flow.flowId)return;
    if(nekoSnapshot?.login?.flowId===flow.flowId&&nekoSnapshot.login.status!=='community')return;
    nekoRelayFlowId=flow.flowId;await openNekoCommunity(false,isCurrent);
  }
  async function cancelNekoLogin() {
    if(nekoCancelPending||typeof accountsBridge.nekoSignInCancel!=='function')return;const epoch=++nekoActionEpoch;nekoCancelPending=true;nekoActionPending=false;nekoActionError='';nekoRevision++;render();
    try{await accountsBridge.nekoSignInCancel();}catch{if(!stopped)nekoActionError='授权暂未取消，请重试或关闭授权窗口。';}
    finally{if(epoch===nekoActionEpoch){nekoCancelPending=false;if(!stopped){render();void refreshNekoAccount(true);}}}
  }
  function nekoAccountCard() {
    const card=element('section','neh-provider-card neh-neko-account');card.setAttribute('aria-label','N.E.K.O. 账号与聊天室授权');
    const community=nekoSnapshot?.community,lobby=nekoSnapshot?.lobby,ready=community?.status==='signed-in'&&lobby?.status==='signed-in',reconnect=!ready&&['error','canceled'].includes(nekoSnapshot?.login?.status),busy=nekoActionPending||nekoCancelPending||nekoFlowBusy();
    card.append(providerStatus('N.E.K.O. 账号',nekoLabel(community),community?.status==='signed-in'),providerStatus('聊天室授权',lobby?.status==='signed-in'?'已授权':nekoLabel(lobby),lobby?.status==='signed-in'));
    if(community?.name||lobby?.name)card.append(element('span','neh-provider-source',String(community?.name||lobby?.name).slice(0,80)));
    const actions=element('div','neh-neko-actions'),login=element('button','neh-account-refresh neh-neko-primary',busy?'正在授权…':ready?'打开社区':reconnect?'重新连接 N.E.K.O.':community?.status==='signed-in'?'连接聊天室':'一键登录 N.E.K.O.');login.type='button';login.dataset.nekoLogin='account';login.disabled=busy;login.setAttribute('aria-busy',String(busy));
    login.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(ready)afterMenuClosed(()=>{void openNekoCommunity(false).catch(()=>{nekoActionError='社区暂未打开，请重试。';render();});});else void startNekoLogin();});actions.append(login);
    if((nekoActionPending||nekoCancelPending||nekoFlowBusy())&&typeof accountsBridge.nekoSignInCancel==='function'){const cancel=element('button','neh-account-refresh',nekoCancelPending?'正在取消…':'取消授权');cancel.type='button';cancel.dataset.nekoLogin='cancel';cancel.disabled=nekoCancelPending;cancel.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void cancelNekoLogin();});actions.append(cancel);}
    if(lobby?.status==='signed-in'){const open=element('button','neh-account-refresh','进入聊天室');open.type='button';open.dataset.nekoLogin='lobby';open.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();afterMenuClosed(()=>{const detail={returnFocus:launcher?.element};doc.dispatchEvent(new win.CustomEvent('neko-account-open-lobby',{detail}));if(!detail.handled){doc.querySelector('.neko-room-entry')?.click();doc.querySelector('button[aria-label="打开公共聊天室"]')?.click();}});});actions.append(open);}
    if(lobby?.status==='signed-in'&&typeof accountsBridge.nekoSignIn==='function'){const reauthorize=element('button','neh-account-refresh','重新授权聊天室');reauthorize.type='button';reauthorize.dataset.nekoLogin='reauthorize';reauthorize.disabled=busy;reauthorize.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void startNekoLogin({reauthorize:true});});actions.append(reauthorize);}
    card.append(actions);
    const flow=nekoSnapshot?.login,message=nekoActionError||(nekoCancelPending?'正在取消本次授权…':nekoActionPending&&!nekoFlowBusy()?'正在打开 N.E.K.O. 登录…':flow?.error||flow?.message||(!ready?'登录后继续完成聊天室授权，首次可能需要确认。':''));
    if(message){const note=element('p','neh-neko-auth-note',String(message).slice(0,220));note.setAttribute('role',nekoActionError||!busy&&flow?.status==='error'?'alert':'status');note.setAttribute('aria-live','polite');card.append(note);}
    return card;
  }
  function providerStatus(name, label, signedIn) {
    const row = element('span', 'neh-provider-status');
    const status = element('span', 'neh-provider-login', label);
    status.dataset.connected = signedIn ? 'true' : 'false';
    row.append(element('strong', '', name), status);
    return row;
  }
  function renderUnifiedMenu(snap) {
    const active=menuRecord.owned.contains(doc.activeElement)?doc.activeElement:null,focused=active?.dataset.nekoAccountRefresh==='',focusedLogin=active?.dataset.nekoLogin;
    clearOwned(menuRecord.owned);
    const heading = element('div', 'neh-menu-heading');
    const refresh = element('button', 'neh-account-refresh', '刷新');
    refresh.type = 'button'; refresh.dataset.nekoAccountRefresh = ''; refresh.setAttribute('aria-label', '刷新 DSH、N.E.K.O. 和聊天室登录状态');
    refresh.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation(); reader.refresh(); refreshNekoAccount(true);
    });
    heading.append(element('h3', '', '账号与设置'), refresh);
    const dsh = element('section', 'neh-provider-card'); dsh.setAttribute('aria-label', 'DSH 账号与余额');
    dsh.append(providerStatus('DSH', dshLoginLabel(snap), effectiveSignedIn(snap)),
      element('strong', 'neh-provider-balance', effectiveSignedIn(snap) ? balanceLabel(snap) : '登录后查看钱包余额'),
      element('span', 'neh-provider-source', '官方充值钱包'));
    menuRecord.owned.append(heading);
    menuRecord.owned.append(workbenchSettings());
    if (nekoSnapshot||typeof accountsBridge.nekoSignIn==='function'||typeof accountsBridge.communityLogin==='function')menuRecord.owned.append(nekoAccountCard());
    menuRecord.owned.append(dsh, element('p', 'neh-menu-help', 'DSH 沿用本机工作账号；N.E.K.O. 登录与聊天室授权会自动衔接。'));
    if (focused) refresh.focus({ preventScroll: true });
    else if(focusedLogin)[...menuRecord.owned.querySelectorAll('[data-neko-login]')].find(button=>button.dataset.nekoLogin===focusedLogin&&!button.disabled)?.focus({preventScroll:true});
  }
  function habitat(snap, inMenu) {
    const column = element('span', 'neh-habitat-column');
    const overhead = element('span', 'neh-overhead');
    overhead.append(element('strong', 'neh-wallet', balanceLabel(snap)), element('span', 'neh-source', snap.source));
    const world = element('span', 'neh-world');
    world.setAttribute('aria-hidden', 'true');
    world.appendChild(element('span', 'neh-ground'));
    if (effectiveSignedIn(snap)) addPet(world);
    else world.appendChild(element('span', 'neh-empty-world', '未登录'));
    column.append(overhead, world);
    if (inMenu) column.classList.add('neh-habitat-column--menu');
    return column;
  }
  function rememberSet(record, name, value) {
    const current = record.element.getAttribute(name);
    const previous = record.attributes.get(name);
    if (!previous || current !== previous.owned) record.attributes.set(name, { original: current, owned: value });
    else previous.owned = value;
    if (current !== value) record.element.setAttribute(name, value);
  }
  function restoreAttributes(record) {
    for (const [name, values] of record.attributes) {
      if (record.element.getAttribute(name) !== values.owned) continue;
      if (values.original === null) record.element.removeAttribute(name);
      else record.element.setAttribute(name, values.original);
    }
  }
  function releaseLauncher() {
    if (!launcher) return;
    pauseMedia(launcher.owned); launcher.owned.remove(); restoreAttributes(launcher);
    launcher = null;
  }
  function releaseMenu() {
    if (!menuRecord) return;
    pauseMedia(menuRecord.owned); menuRecord.owned.remove(); restoreAttributes(menuRecord);
    menuRecord = null;
    reportMenuLayer();
  }
  function renderLauncher(snap) {
    if (!launcher) return;
    const key = JSON.stringify([snap, nativeSignedIn, reduced, doc.visibilityState, launcher.element.getAttribute('data-collapsed'),nekoSnapshot]);
    if (launcher.renderKey === key) return;
    launcher.renderKey = key;
    clearOwned(launcher.owned);
    if (accountsBridge) {
      const identity = element('span', 'neh-identity');
      identity.appendChild(element('span', 'neh-developer-name', '账号'));
      const avatar = element('img', 'neh-developer-avatar'); avatar.alt = ''; avatar.draggable = false;
      if (developerSrc) avatar.src = developerSrc;
      identity.appendChild(avatar);
      const providers = element('span', 'neh-providers');
      providers.append(providerStatus('DSH', dshLoginLabel(snap), effectiveSignedIn(snap)));
      if(nekoSnapshot)providers.append(providerStatus('N.E.K.O.',nekoLabel(nekoSnapshot.community),nekoSnapshot.community?.status==='signed-in'));
      launcher.owned.append(identity, providers);
      rememberSet(launcher,'data-neko-community-login',nekoSnapshot?.community?.status||'unknown');
      rememberSet(launcher, 'aria-label', '账号与设置：DSH ' + dshLoginLabel(snap)+nekoSummary());
      rememberSet(launcher, 'title', '账号与设置 · N.E.K.O.、聊天室和工作账号');
      return;
    }
    if (!nativeSignedIn) {
      const icon = element('img', 'neh-signed-out-icon');
      icon.alt = ''; icon.draggable = false;
      if (signedOutSrc) icon.src = signedOutSrc;
      launcher.owned.appendChild(icon);
      rememberSet(launcher, 'aria-label', '登录 DeepSeek 账号');
      rememberSet(launcher, 'title', '登录 DeepSeek 账号');
      return;
    }
    const identity = element('span', 'neh-identity');
    identity.appendChild(element('span', 'neh-developer-name', '开发喵'));
    const avatar = element('img', 'neh-developer-avatar');
    avatar.alt = ''; avatar.draggable = false;
    if (developerSrc) avatar.src = developerSrc;
    identity.appendChild(avatar);
    launcher.owned.append(identity, habitat(snap, false));
    rememberSet(launcher, 'aria-label', '开发喵账号菜单，' + (effectiveSignedIn(snap) ? '已登录，' : '未登录，') + balanceLabel(snap) + '，来源：' + snap.source);
    rememberSet(launcher, 'title', '开发喵 · 账号菜单');
  }
  function renderMenu(snap) {
    if (!menuRecord) return;
    const key = JSON.stringify([snap, nativeSignedIn, reduced, doc.visibilityState,nekoSnapshot,nekoActionPending,nekoCancelPending,nekoActionError]);
    if (menuRecord.renderKey === key) return;
    menuRecord.renderKey = key;
    if (accountsBridge) { renderUnifiedMenu(snap); return; }
    clearOwned(menuRecord.owned);
    const heading = element('div', 'neh-menu-heading');
    heading.append(element('h3', '', '账号与生活'), element('span', 'neh-login-status', effectiveSignedIn(snap) ? '已登录' : '未登录'));
    const summary = element('div', 'neh-service-summary');
    summary.append(element('strong', '', '账号'), element('span', '', '工作台账号'));
    const help = effectiveSignedIn(snap) ? '账号和充值可在下方设置中管理。' : '使用下方登录按钮连接账号。';
    menuRecord.owned.append(heading,workbenchSettings(),summary,habitat(snap,true),element('p','neh-menu-help',help));
  }
  function render() {
    if (stopped) return;
    const snap = reader.getSnapshot();
    renderLauncher(snap); renderMenu(snap);
    const message = accountsBridge ? 'DSH ' + dshLoginLabel(snap)+nekoSummary() : effectiveSignedIn(snap) ? '账号，' + balanceLabel(snap) + '，来源：' + snap.source : '账号未登录，余额暂不可读取';
    if (message !== lastAnnouncement) { announcement.textContent = message; lastAnnouncement = message; }
    reportMenuLayer();
  }
  function matchAccountMenu(menu) {
    const buttons = Array.from(menu.querySelectorAll('button[role="menuitem"]'));
    const labels = buttons.map(button => {
      const label = button.querySelector('._itemLabel_4ub78_190');
      return (label || button).textContent.replace(/\s+/g, '').toLowerCase();
    });
    const accountAction = nativeSignedIn === true
      ? /^(退出|退出登录|登出|signout|logout)$/
      : /^(登录|登入|登陆|signin|login)$/;
    return labels.length === 3 && /^(设置|settings)$/.test(labels[0]) &&
      /^(联系我们|意见反馈|反馈意见|contactus|contact|feedback|sendfeedback)$/.test(labels[1]) &&
      accountAction.test(labels[2]);
  }
  // Only the native login dialog's exact introductory sentence is adapted.
  // Do not rewrite general page content, conversation messages, or links.
  const loginCopy = new Map([
    ['登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。', '登录账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。'],
    ['Sign in to your DeepSeek account or add an API Key to get started. Your projects and files are stored locally.', 'Sign in to your account or add an API Key to get started. Your projects and files are stored locally.'],
  ]);
  const loginCopyChanges = new Map();
  function adaptLoginDialog() {
    loginDialogElement=null;
    for (const dialog of doc.querySelectorAll('[role="dialog"]')) {
      const title = dialog.querySelector('h2');
      if (!title || !/^(开始使用|Get started)$/.test(title.textContent.trim())) continue;
      const labels = Array.from(dialog.querySelectorAll('button')).map(button => button.textContent.trim());
      if (!labels.some(label => /^(登录|Sign in)$/.test(label)) || !labels.some(label => /^(添加 API Key|Add API Key)$/.test(label))) continue;
      loginDialogElement=dialog;
      for (const paragraph of dialog.querySelectorAll('p')) {
        const node = paragraph.firstChild;
        if (!node || node.nodeType !== 3 || paragraph.childNodes.length !== 1) continue;
        const replacement = loginCopy.get(node.nodeValue);
        if (!replacement) continue;
        loginCopyChanges.set(node, { original: node.nodeValue, owned: replacement });
        node.nodeValue = replacement;
      }
    }
  }
  function sync() {
    scheduled = false;
    if (stopped) return;
    adaptLoginDialog();
    const trigger = doc.querySelector(triggerSelector);
    if (!trigger) { releaseMenu(); releaseLauncher(); nativeSignedIn = null; reader.invalidate(null); return; }
    if (!launcher || launcher.element !== trigger || !launcher.owned.isConnected) {
      releaseLauncher();
      const own = element('span', 'neh-launcher');
      own.setAttribute('data-neko-account-owned', 'launcher');
      own.setAttribute('aria-hidden', 'true');
      launcher = { element: trigger, owned: own, attributes: new Map(), renderKey: null };
      rememberSet(launcher, 'data-neko-account-habitat', '');
      if (accountsBridge) rememberSet(launcher, 'data-neko-unified-account', '');
      trigger.appendChild(own);
      nativeSignedIn = null;
    }
    const signedIn = trigger.getAttribute('data-signed-out') === 'false';
    if (signedIn !== nativeSignedIn) {
      nativeSignedIn = signedIn;
      reader.invalidate(signedIn);
      if (signedIn && !accountsBridge) reader.refresh();
    }
    const menus = trigger.getAttribute('aria-expanded') === 'true' ? Array.from(doc.querySelectorAll(menuSelector)).filter(matchAccountMenu) : [];
    if (menus.length !== 1) releaseMenu();
    else {
      const menu = menus[0];
      const viewport = menu.querySelector('._viewport_4ub78_19[role="presentation"]') || menu.querySelector('[role="presentation"]');
      if (!viewport) releaseMenu();
      else if (!menuRecord || menuRecord.element !== menu || !menuRecord.owned.isConnected) {
        releaseMenu();
        const own = element('div', 'neh-menu-card');
        own.setAttribute('data-neko-account-owned', 'menu-card');
        own.setAttribute('role', 'presentation');
        menuRecord = { element: menu, owned: own, attributes: new Map(), renderKey: null };
        rememberSet(menuRecord, 'data-neko-account-habitat-menu', '');
        viewport.prepend(own); // Only our node is inserted; original buttons are untouched.
        if (accountsBridge) { if (signedIn) reader.refresh(); refreshNekoAccount(); }
      }
    }
    render();
  }
  function schedule() {
    if (stopped || scheduled) return;
    scheduled = true;
    Promise.resolve().then(sync);
  }
  function invalidateAndRead() {
    reader.invalidate(null); // Synchronous clearing; old in-flight requests cannot commit.
    schedule();
    if (nativeSignedIn === true && (!accountsBridge || menuRecord)) reader.refresh();
  }
  const unsubscribe = reader.subscribe(render);
  const observer = new win.MutationObserver(schedule);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'data-signed-out', 'data-collapsed', 'style'] });
  function listen(target, name, callback, capture) {
    target.addEventListener(name, callback, capture);
    releases.push(() => target.removeEventListener(name, callback, capture));
  }
  listen(win,'resize',reportMenuLayer);
  listen(doc,'scroll',reportMenuLayer,true);
  listen(doc, 'click', event => {
    const target = event.target && event.target.closest ? event.target.closest(triggerSelector) : null;
    if (!target) return;
    schedule();
    if (target.getAttribute('data-signed-out') === 'false') reader.refresh();
    refreshNekoAccount(true);
  }, true);
  listen(doc, 'visibilitychange', () => {
    if (launcher) launcher.renderKey = null;
    if (menuRecord) menuRecord.renderKey = null;
    render();
    if (doc.visibilityState !== 'hidden' && nativeSignedIn === true && (!accountsBridge || menuRecord)) reader.refresh();
    if (doc.visibilityState !== 'hidden') refreshNekoAccount();
  });
  listen(win, 'focus', () => { if (doc.visibilityState !== 'hidden') refreshNekoAccount(true); });
  if (motion) {
    const changed = event => { reduced = !!event.matches; render(); };
    if (typeof motion.addEventListener === 'function') { motion.addEventListener('change', changed); releases.push(() => motion.removeEventListener('change', changed)); }
    else if (typeof motion.addListener === 'function') { motion.addListener(changed); releases.push(() => motion.removeListener(changed)); }
  }
  // Subscribe only to invalidation notices. Never read credential payloads or
  // start a second account.watch/authentication owner.
  if (ctx.remote && typeof ctx.remote.$on === 'function') {
    for (const name of ['credentials/reference-updated', 'deepseek-account/session-expired']) {
      try { const off = ctx.remote.$on(name, invalidateAndRead); if (typeof off === 'function') releases.push(off); } catch (_) {}
    }
  }
  if (typeof ctx.on === 'function') {
    try { const off = ctx.on('connection/reset', invalidateAndRead); if (typeof off === 'function') releases.push(off); } catch (_) {}
  }
  const interval = win.setInterval(() => {
    if (nativeSignedIn === true && doc.visibilityState !== 'hidden' && (!accountsBridge || menuRecord)) reader.refresh();
    if (doc.visibilityState !== 'hidden') refreshNekoAccount();
  }, Math.max(15000, options.pollIntervalMs || 60000));
  if(typeof accountsBridge?.subscribeNekoAccount==='function')releases.push(accountsBridge.subscribeNekoAccount(value=>{nekoRevision++;nekoSnapshot=value;if(['checking','community','chatroom','signed-in','connected','canceled'].includes(value?.login?.status))nekoActionError='';render();void relayAccountLogin(value?.login).catch(()=>{if(!stopped){nekoActionError='N.E.K.O. 登录页面未能打开，请重试。';render();}});}));
  if(typeof accountsBridge?.subscribeLobby==='function')releases.push(accountsBridge.subscribeLobby(value=>{nekoRevision++;nekoSnapshot={...(nekoSnapshot||{community:{status:'unknown'}}),lobby:{status:value?.auth?.status||'unavailable'}};render();}));
  sync();
  refreshNekoAccount();
  return () => {
    if (stopped) return;
    stopped = true;
    loginDialogElement=null;menuLayerResizeObserver?.disconnect();reportMenuLayer();
    observer.disconnect();
    win.clearInterval(interval);
    for (const release of releases.reverse()) { try { release(); } catch (_) {} }
    unsubscribe(); reader.dispose();
    for (const [node, values] of loginCopyChanges) if (node.nodeValue === values.owned) node.nodeValue = values.original;
    loginCopyChanges.clear();
    releaseMenu(); releaseLauncher();
    announcement.remove(); style.remove();
  };
}
