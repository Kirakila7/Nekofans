// Own navigation only. Native avatar and account React controls keep their
// original owners, parents, login handlers and popup anchoring.
function installWorkbenchSideRail(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  const bridge = options.bridge || win?.nekoWorkbench;
  if (!doc?.body || !win?.MutationObserver || typeof bridge?.action !== 'function' ||
      typeof options.openBilibiliHome !== 'function' || doc.querySelector('[data-neko-side-rail]')) return () => {};
  const rail = doc.createElement('aside');
  rail.className = 'neko-side-rail'; rail.dataset.nekoSideRail = '';
  rail.setAttribute('aria-label', '工作台快捷导航');
  const theme = doc.createElement('div'); theme.className = 'neko-side-rail__theme'; theme.setAttribute('aria-hidden', 'true');
  const space = doc.createElement('div'); space.className = 'neko-side-rail__space'; space.setAttribute('aria-hidden', 'true');
  const bottom = doc.createElement('nav'); bottom.className = 'neko-side-rail__bottom'; bottom.setAttribute('aria-label', 'B站与养鱼');
  const bili = doc.createElement('button'); bili.type = 'button'; bili.className = 'neko-side-rail__button neko-side-rail__bilibili neko-community neko-bilibili';
  bili.setAttribute('aria-label', '哔哩哔哩主页'); bili.title = '哔哩哔哩主页';
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [key, value] of Object.entries({ x: 3, y: 6, width: 18, height: 14, rx: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 })) rect.setAttribute(key, value);
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  for (const [key, value] of Object.entries({ d: 'M7 2.5 10 6m7-3.5L14 6M8 11v3m8-3v3M9 20l-1 1m7-1 1 1', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' })) path.setAttribute(key, value);
  svg.append(rect, path); bili.appendChild(svg);
  const fish = doc.createElement('button'); fish.type = 'button'; fish.className = 'neko-side-rail__button neko-side-rail__fish';
  fish.setAttribute('aria-label', options.fishLabel || '养鱼界面'); fish.title = options.fishLabel || '养鱼界面';
  const image = doc.createElement('img'); image.alt = ''; image.draggable = false;
  if (/^data:image\/(?:png|webp|jpeg);base64,/.test(options.fishAvatar || '')) image.src = options.fishAvatar;
  fish.appendChild(image);
  const account = doc.createElement('button'); account.type = 'button'; account.className = 'neko-side-rail__button neko-side-rail__account';
  account.setAttribute('aria-label', '账号与额度'); account.setAttribute('aria-haspopup', 'menu'); account.title = '账号与额度';
  const accountImage = doc.createElement('img'); accountImage.alt = ''; accountImage.draggable = false;
  if (/^data:image\/(?:png|webp|jpeg);base64,/.test(options.accountAvatar || '')) accountImage.src = options.accountAvatar;
  account.appendChild(accountImage);
  const notice = doc.createElement('p'); notice.className = 'neko-side-rail__notice'; notice.hidden = true; notice.setAttribute('role', 'status');
  bottom.append(bili, fish, account); rail.append(theme, space, bottom, notice);
  const style = doc.createElement('style'); style.dataset.nekoSideRailStyle = ''; style.textContent = options.cssText || '';
  const originalBodyMarker = doc.body.getAttribute('data-neko-side-rail-layout');
  const claimed = new Map(); let stopped = false, queued = false, pending = false, appRoot = null, nativeAccount = null;
  function mark(node, name, value = '') {
    if (!node) return;
    if (!claimed.has(node)) claimed.set(node, new Map());
    const attrs = claimed.get(node);
    if (!attrs.has(name)) attrs.set(name, { before: node.getAttribute(name), owned: value });
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }
  function release(node, name) {
    const attrs = claimed.get(node);
    if (!attrs?.has(name)) return;
    if (node.getAttribute(name) === attrs.get(name).owned) {
      const before = attrs.get(name).before;
      if (before === null) node.removeAttribute(name); else node.setAttribute(name, before);
    }
    attrs.delete(name); if (!attrs.size) claimed.delete(node);
  }
  function sync() {
    queued = false; if (stopped) return;
    const sidebar = doc.querySelector('[data-slot="sidebar"]');
    let next = sidebar;
    while (next?.parentElement && next.parentElement !== doc.body) next = next.parentElement;
    if (!next || next === doc.body || next === rail || next.parentElement !== doc.body) next = null;
    if (appRoot !== next) { if (appRoot) release(appRoot, 'data-neko-rail-app'); appRoot = next; }
    if (appRoot) mark(appRoot, 'data-neko-rail-app');
    const nextAccount = doc.querySelector('[data-slot="settings.launcher"] button.hjANda_trigger[aria-haspopup="menu"]');
    if (nativeAccount !== nextAccount) {
      if (nativeAccount) { release(nativeAccount, 'data-neko-rail-account-original'); release(nativeAccount, 'tabindex'); release(nativeAccount, 'aria-hidden'); }
      nativeAccount = nextAccount;
    }
    account.disabled = !nativeAccount;
    if (nativeAccount) {
      mark(nativeAccount, 'data-neko-rail-account-original'); mark(nativeAccount, 'tabindex', '-1');
      mark(nativeAccount, 'aria-hidden', 'true');
      const label = nativeAccount.getAttribute('aria-label') || '账号与额度';
      if (account.getAttribute('aria-label') !== label) account.setAttribute('aria-label', label);
      const expanded = nativeAccount.getAttribute('aria-expanded') === 'true' ? 'true' : 'false';
      if (account.getAttribute('aria-expanded') !== expanded) account.setAttribute('aria-expanded', expanded);
    }
    const selected = new Set();
    for (const button of (appRoot || sidebar)?.querySelectorAll('button') || []) {
      const label = button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent.trim();
      if (label === '养鱼设置') { mark(button, 'data-neko-rail-fish-original'); selected.add(button); }
    }
    for (const [node, attrs] of [...claimed]) if (attrs.has('data-neko-rail-fish-original') && !selected.has(node)) release(node, 'data-neko-rail-fish-original');
  }
  function schedule() { if (stopped || queued) return; queued = true; Promise.resolve().then(sync); }
  async function act(button, callback) {
    if (pending || stopped) return;
    pending = true; button.setAttribute('aria-busy', 'true'); notice.hidden = true;
    try { await callback(); }
    catch { if (!stopped) { notice.textContent = button === bili ? 'B站未能打开，请重试' : '养鱼界面未能打开，请重试'; notice.hidden = false; } }
    finally { pending = false; if (!stopped) button.removeAttribute('aria-busy'); }
  }
  const onBili = () => act(bili, () => options.openBilibiliHome());
  const onFish = () => act(fish, () => bridge.action('fish-settings'));
  const onAccount = () => {
    if (!nativeAccount?.isConnected || stopped) return;
    options.beforeAccount?.(); nativeAccount.click();
  };
  const onFocus = event => {
    if (event.target !== nativeAccount) return;
    Promise.resolve().then(() => { if (!stopped && nativeAccount?.getAttribute('aria-expanded') !== 'true') account.focus(); });
  };
  bili.addEventListener('click', onBili); fish.addEventListener('click', onFish);
  account.addEventListener('click', onAccount); doc.addEventListener('focusin', onFocus);
  doc.head.appendChild(style); doc.body.prepend(rail); doc.body.setAttribute('data-neko-side-rail-layout', '');
  const observer = new win.MutationObserver(schedule);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'aria-expanded'] });
  sync();
  return () => {
    if (stopped) return; stopped = true; observer.disconnect();
    bili.removeEventListener('click', onBili); fish.removeEventListener('click', onFish);
    account.removeEventListener('click', onAccount); doc.removeEventListener('focusin', onFocus);
    for (const [node, attrs] of [...claimed]) for (const name of [...attrs.keys()]) release(node, name);
    if (doc.body.getAttribute('data-neko-side-rail-layout') === '') {
      if (originalBodyMarker === null) doc.body.removeAttribute('data-neko-side-rail-layout');
      else doc.body.setAttribute('data-neko-side-rail-layout', originalBodyMarker);
    }
    rail.remove(); style.remove();
  };
}
