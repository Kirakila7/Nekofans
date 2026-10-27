/**
 * Interactive DOM check: real React 18 + jsdom, mock DSH hero markup copied
 * from the 0.2.1-rc.3 HeroShell structure, and a fake window.nekoWorkbench.
 *
 * Dev-only deps (not shipped). Install them anywhere and point NEKO_DOM_DEPS
 * at that folder:
 *   mkdir /tmp/neko-dom && cd /tmp/neko-dom && npm i react@18.3.1 react-dom@18.3.1 jsdom@24.1.3
 *   NEKO_DOM_DEPS=/tmp/neko-dom node scripts/dom-check.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const deps = createRequire(join(process.env.NEKO_DOM_DEPS || root, 'package.json'))
const { JSDOM } = deps('jsdom')

const dom = new JSDOM(
  `<!doctype html><html><head><title>New chat — DeepSeek Harness</title></head><body>
  <div data-slot="sidebar" style="display:contents"><div class="kB3qhq_root" id="sb-root">
    <div class="kB3qhq_topStrip"></div>
    <div class="kB3qhq_logoRow"><span id="seat-sidebar-mark"></span><span id="seat-sidebar-name"></span></div>
    <button class="kB3qhq_newSession" id="new-session" aria-label="新建会话">新建会话</button>
    <nav class="kB3qhq_panelList" id="native-nav" data-x="keep">
      <button class="kB3qhq_panelRow" id="nav-plugins">插件</button>
      <button class="kB3qhq_panelRow" id="nav-schedules">自动化任务</button>
      <span><button id="nav-more" aria-haspopup="menu" aria-expanded="false">更多</button></span>
    </nav>
    <div class="kB3qhq_regionArea"><div data-slot="sidebar.workspaces"><nav id="ws-nav"><button>工作区 A</button></nav></div></div>
    <div class="kB3qhq_footArea"><button>设置</button></div>
  </div></div>
  <div id="seat-shell-overlay"></div>
  <main>
    <h1 class="otherHeading">会话</h1>
    <div class="HeroShell_headline">
      <span class="HeroShell_fishHitbox" id="seat-hero-mark"></span>
      <span class="HeroShell_titleGroup"><span>探索未至之境</span><span class="HeroShell_previewBadge">预览</span></span>
    </div>
    <div class="HeroShell_body"><button id="workspace-picker">选择工作区</button></div>
    <textarea id="composer" aria-label="输入"></textarea>
  </main>
  <footer id="seat-shell-bottom"></footer>
</body></html>`,
  { pretendToBeVisual: true, url: 'http://127.0.0.1:43123/' },
)
const { window } = dom
Object.defineProperty(window, 'innerWidth', { value: 1100 })
Object.defineProperty(window, 'innerHeight', { value: 780 })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = deps('react')
const ReactDOMClient = deps('react-dom/client')
const ReactDOM = deps('react-dom')
const act = React.act || deps('react-dom/test-utils').act
const document = window.document
// jsdom has no layout engine. Supply a changing sidebar geometry to verify
// that the native button remains in its original React-owned row.
let sidebarWidth = 216
const originalRect = window.HTMLElement.prototype.getBoundingClientRect
window.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.id === 'sb-root' || this.id === 'react-sidebar') return { left:0, right:sidebarWidth+32, top:0, bottom:752, width:sidebarWidth+32, height:752 }
  if (this.classList.contains('neko-strip')) return { left:0, right:1100, top:752, bottom:780, width:1100, height:28 }
  if (this.classList.contains('neko-community-pane__toolbar')) return { top:0, height:48 }
  const isNew = this.id === 'new-session' || this.id === 'new-session-2'
  const isHost = this.hasAttribute('data-neko-role-host')
  if (!isNew && !isHost) return originalRect.call(this)
  const width = isNew ? (Number.parseFloat(this.style.getPropertyValue('--neko-new-session-size')) || sidebarWidth) : sidebarWidth
  const top = isNew ? 96 : 136
  return { x:16, y:top, left:16, right:16+width, top, bottom:top+36, width, height:36, toJSON() {} }
}
let newSessionClicks = 0
document.getElementById('new-session').addEventListener('click', () => { newSessionClicks++ })

// Count document/window listeners so leaks show up.
const live = new Map()
for (const target of [window.document, window]) {
  const add = target.addEventListener.bind(target)
  const remove = target.removeEventListener.bind(target)
  target.addEventListener = (type, fn, opts) => { live.set(fn, type); return add(type, fn, opts) }
  target.removeEventListener = (type, fn, opts) => { live.delete(fn); return remove(type, fn, opts) }
}
let baseline = live.size

// --- fake native bridge -----------------------------------------------------

const calls = []
const subs = new Set()
const communitySubs = new Set()
let state = {
  avatar: { builtinId: 'yui', customDataUrl: null },
  neko: { enabled: true, connection: 'connected', character: 'YUi', error: '' },
  workbench: { connection: 'connected', error: '' },
}
let deferred = null
window.nekoWorkbench = {
  community: async request => { calls.push(['community', request]); return { ok: true } },
  subscribeCommunity(fn) { communitySubs.add(fn); return () => communitySubs.delete(fn) },
  getState: async () => state,
  setAvatar: async (id) => { calls.push(['setAvatar', id]); state = { ...state, avatar: { ...state.avatar, builtinId: id } }; return state },
  uploadAvatar: async () => { calls.push(['uploadAvatar']); return null },
  action: (name) => {
    calls.push(['action', name])
    if (name === 'task-notes') return new Promise((resolve) => { deferred = resolve })
    if (name === 'open-neko') return Promise.reject(new Error('桌宠未运行'))
    return Promise.resolve({ ok: true })
  },
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
}

let roleState = {
  activeId: 'bigfish',
  workspaceSessionId: 'root-session-1',
  roles: [
    { id: 'yui', name: 'Yui', avatarId: 'yui', customDataUrl: null, enabled: false },
    { id: 'bigfish', name: '大肥鱼', avatarId: 'bigfish', customDataUrl: null, enabled: true },
    { id: 'claude', name: 'Claude小姐', avatarId: 'claude', customDataUrl: null, enabled: false },
  ],
}
const roleCalls = []
const roleSubs = new Set()
window.nekoRoles = {
  getState: async () => roleState,
  selectRole: async (id) => { roleCalls.push(['selectRole', id]); if (id !== 'bigfish') throw new Error('未接入'); return roleState },
  updateRole: async (id, patch) => {
    roleCalls.push(['updateRole', id, patch])
    roleState = { ...roleState, roles: roleState.roles.map((r) => (r.id === id ? { ...r, ...patch } : r)) }
    return roleState
  },
  uploadAvatar: async (id) => {
    roleCalls.push(['uploadAvatar', id])
    roleState = { ...roleState, roles: roleState.roles.map((r) => (r.id === id ? { ...r, avatarId: 'custom', customDataUrl: 'data:image/png;base64,iVBORw0KGgo=' } : r)) }
    return roleState
  },
  subscribe(fn) { roleSubs.add(fn); return () => roleSubs.delete(fn) },
}

// --- load bundle + mount seats --------------------------------------------

const code = readFileSync(process.env.NEKO_BUNDLE || join(root, 'lib', 'client.js'), 'utf8')
let entry
window.__ModuleLoader__ = { load(e) { entry = e } }
window.eval(code)
const exportsObj = entry.factory((id) => {
  if (id === 'react') return React
  if (id === 'react-dom') return ReactDOM
  throw new Error(`unexpected ${id}`)
})
const seats = {}
const seatSpecs = {}
const disposers = []
const opened = []
const ctx = {
  uiWorkspace: { openSession(id) { opened.push(id); if (id === 'boom') throw new Error('会话已失效') } },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  slots: {
    inject(_key, cb) { const d = cb(); disposers.push(d); return () => {} },
    register(spec, component) { seats[spec.name] = component; seatSpecs[spec.name] = spec; return () => { delete seats[spec.name]; delete seatSpecs[spec.name] } },
  },
}
exportsObj.apply(ctx)
assert.equal(document.title, 'New chat — N.E.K.O. 工作台')

// The welcome notice is overridden only by its own list id. Rendering it
// advances the existing queue once without creating content or persistence.
assert.deepEqual({ ...seatSpecs['settings.onboarding'] }, {
  name: 'settings.onboarding', id: 'welcome-notice', order: -100, priority: -1,
})
const welcomeHost = document.createElement('div')
document.body.appendChild(welcomeHost)
const welcomeRoot = ReactDOMClient.createRoot(welcomeHost)
let welcomeCompleted = 0
await act(async () => { welcomeRoot.render(React.createElement(seats['settings.onboarding'], { complete: () => { welcomeCompleted++ } })) })
assert.equal(welcomeCompleted, 1)
assert.equal(welcomeHost.childNodes.length, 0)
await act(async () => welcomeRoot.unmount())
welcomeHost.remove()

// Native DSH RunningStatus markup, including TextShimmer's plain text and
// its aria-hidden decoration. Transcript content and tool labels can contain
// the same words but must never be rewritten.
const runningFixture = document.createElement('section')
runningFixture.innerHTML = `
  <div data-chat-running="true">
    <span role="status" aria-live="polite" aria-atomic="true">深度求索中</span>
    <span data-shimmer="true"><span><span id="running-live">深度求索中，用时 27 秒 ···</span></span>
      <span aria-hidden="true" inert><span data-shimmer-text="深度求索中，用时 27 秒 ···"></span></span></span>
  </div>
  <div id="actual-message">深度求索中，用时 27 秒 ···</div>
  <button data-process-activity="read">正在读取文件</button>`
document.body.appendChild(runningFixture)
await new Promise((resolve) => setTimeout(resolve, 0))
const liveStatus = runningFixture.querySelector('[role="status"]')
const liveText = runningFixture.querySelector('#running-live')
const shimmerText = runningFixture.querySelector('[data-shimmer-text]')
assert.equal(liveStatus.textContent, '思考中…')
assert.equal(liveStatus.getAttribute('aria-live'), 'polite')
assert.equal(liveText.textContent, '思考中 · 27 秒')
assert.equal(shimmerText.getAttribute('data-shimmer-text'), '思考中 · 27 秒')
assert.equal(runningFixture.querySelector('#actual-message').textContent, '深度求索中，用时 27 秒 ···')
assert.equal(runningFixture.querySelector('[data-process-activity]').textContent, '正在读取文件')
liveText.firstChild.nodeValue = '深度求索中，用时 28 秒 ···'
shimmerText.setAttribute('data-shimmer-text', '深度求索中，用时 28 秒 ···')
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(liveText.textContent, '思考中 · 28 秒', 'real elapsed time keeps updating')
assert.equal(shimmerText.getAttribute('data-shimmer-text'), '思考中 · 28 秒')
assert.equal(exportsObj.compactRunningStatus('深度思考中'), '思考中…')
assert.equal(exportsObj.compactRunningStatus('正在读取文件'), '正在读取文件')

// Exercise React-owned nodes as the native elapsed clock rerenders and then
// disappears at turn end. Changing their text/attribute must not break React.
const reactStatusHost = document.createElement('div')
document.body.appendChild(reactStatusHost)
const reactStatusRoot = ReactDOMClient.createRoot(reactStatusHost)
const nativeRunning = (seconds) => React.createElement('div', { 'data-chat-running': 'true' },
  React.createElement('span', { role: 'status', 'aria-live': 'polite' }, '深度求索中'),
  React.createElement('span', { 'data-shimmer': 'true' },
    React.createElement('span', null, `深度求索中，用时 ${seconds} 秒 ···`),
    React.createElement('span', { 'aria-hidden': 'true', 'data-shimmer-text': `深度求索中，用时 ${seconds} 秒 ···` })))
await act(async () => { reactStatusRoot.render(nativeRunning(30)); await new Promise((resolve) => setTimeout(resolve, 0)) })
assert.match(reactStatusHost.textContent, /思考中 · 30 秒/)
await act(async () => { reactStatusRoot.render(nativeRunning(31)); await new Promise((resolve) => setTimeout(resolve, 0)) })
assert.match(reactStatusHost.textContent, /思考中 · 31 秒/)
assert.equal(reactStatusHost.querySelector('[data-shimmer-text]').getAttribute('data-shimmer-text'), '思考中 · 31 秒')
await act(async () => { reactStatusRoot.unmount(); reactStatusHost.remove() })

const mounts = {
  'sidebar.brand.mark': ['seat-sidebar-mark', { size: 24 }],
  'sidebar.brand.name': ['seat-sidebar-name', {}],
  'conversation.hero.brand.mark': ['seat-hero-mark', { size: 34, className: 'HeroShell_fish' }],
  'shell.bottom': ['seat-shell-bottom', {}],
  'shell.overlay': ['seat-shell-overlay', {}],
}
const roots = []
await act(async () => {
  for (const [name, [id, props]] of Object.entries(mounts)) {
    const r = ReactDOMClient.createRoot(document.getElementById(id))
    r.render(React.createElement(seats[name], props))
    roots.push(r)
  }
})
await act(async () => { await new Promise((r) => setTimeout(r, 5)) })
// React itself adds a document listener (selectionchange) per root; measure leaks from here.
baseline = live.size

const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]
const click = async (el) => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const key = async (el, k) => act(async () => { el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true })) })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 5)) })

// --- hero gallery + scoped CSS -----------------------------------------------

const picks = $$('.neko-hero-pick')
assert.equal(picks.length, 5)
assert.deepEqual(picks.map((p) => p.textContent), ['YUi', '开发喵', '大肥鱼', 'Claude娘', 'Gemini小猫'])
assert.equal($('.neko-gallery__row').getAttribute('role'), 'radiogroup')
assert.equal(picks[0].getAttribute('aria-checked'), 'true')
assert.deepEqual(picks.map((p) => p.tabIndex), [0, -1, -1, -1, -1], 'roving tab stop')
const css = $('style[id$=":style"]').textContent
const headlineSel = 'div:has(> span > .neko-gallery, > span > * > .neko-gallery)'
assert.ok(css.includes(headlineSel))
assert.deepEqual($$(headlineSel).map((e) => e.className), ['HeroShell_headline'], 'only the hero headline is targeted')
assert.deepEqual($$(`${headlineSel} > span:not(:has(.neko-gallery))`).map((e) => e.className), ['HeroShell_titleGroup'], 'only titleGroup is hidden')
assert.equal($$('h1, .HeroShell_body, #workspace-picker, #composer').filter((e) => e.matches(`${headlineSel} *`)).length, 0, 'composer and workspace untouched')

await click(picks[1])
await flush()
assert.deepEqual(calls.at(-1), ['setAvatar', 'devcat'])
assert.equal($$('.neko-hero-pick')[1].getAttribute('aria-checked'), 'true')
$$('.neko-hero-pick')[1].focus()
await key($$('.neko-hero-pick')[1], 'ArrowRight')
await flush()
assert.deepEqual(calls.at(-1), ['setAvatar', 'bigfish'], 'arrow keys move and select')
assert.equal(document.activeElement, $$('.neko-hero-pick')[2])
assert.match($('.neko-avatar-btn').getAttribute('aria-label'), /大肥鱼/, 'top-left avatar follows hero selection')

// --- top-left picker --------------------------------------------------------

const trigger = $('.neko-avatar-btn')
assert.equal(trigger.getAttribute('aria-expanded'), 'false')
await click(trigger)
await flush()
assert.equal(trigger.getAttribute('aria-expanded'), 'true')
let picker = $('.neko-picker')
assert.ok(picker && picker.getAttribute('role') === 'dialog')
assert.equal(trigger.getAttribute('aria-controls'), picker.id)
assert.equal($$('.neko-picker .neko-tile').length, 5)
assert.equal(document.activeElement, $('.neko-tile[aria-pressed="true"]'), 'focus moves to the selected tile')
assert.ok(live.size > baseline, 'listeners while open')
await click($$('.neko-picker .neko-tile')[3])
await flush()
assert.deepEqual(calls.at(-1), ['setAvatar', 'claude'])
assert.equal($$('.neko-picker .neko-tile')[3].getAttribute('aria-pressed'), 'true')
await click($('.neko-picker__upload'))
await flush()
assert.deepEqual(calls.at(-1), ['uploadAvatar'])
assert.ok($('.neko-picker'), 'cancelled upload keeps the picker open')
await key(document.activeElement || document.body, 'Escape')
await flush()
assert.equal($('.neko-picker'), null, 'escape closes')
assert.equal(document.activeElement, trigger, 'focus returns to the avatar')
assert.equal(live.size, baseline, 'no listeners left after close')

// Outside dismissal.
await click(trigger)
await flush()
await act(async () => { $('#composer').dispatchEvent(new window.Event('pointerdown', { bubbles: true })) })
await flush()
assert.equal($('.neko-picker'), null, 'outside pointerdown closes')

// Native push updates both seats.
await act(async () => {
  state = { ...state, avatar: { builtinId: 'custom', customDataUrl: 'data:image/png;base64,iVBORw0KGgo=' } }
  for (const fn of subs) fn(state)
})
assert.equal($('.neko-avatar-btn img').getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=')
assert.ok($$('.neko-hero-pick').every((p) => p.getAttribute('aria-checked') === 'false'), 'custom: no builtin checked')
assert.equal($$('.neko-hero-pick')[0].tabIndex, 0)
await click(trigger)
await flush()
assert.equal($$('.neko-picker .neko-tile').length, 6, 'custom tile appears')
await key(document.activeElement, 'Escape')
await flush()

// --- 工作台选项 ---------------------------------------------------------------

const optBtn = $('.neko-strip__options')
assert.equal(optBtn.textContent, '工作台选项')
await click(optBtn)
await flush()
const panel = $('.neko-options')
assert.ok(panel)
assert.equal(panel.getAttribute('aria-label'), '工作台选项')
const statusText = $('.neko-statuses').textContent
assert.match(statusText, /N\.E\.K\.O\.已连接/)
assert.match(statusText, /工作台已连接/)
assert.match(statusText, /角色：YUi/)
const labels = $$('.neko-action').map((b) => b.firstChild.textContent)
assert.deepEqual(labels, ['N.E.K.O. 聊天设置', '打开 N.E.K.O.', '任务备注', '连接 N.E.K.O.', '重新连接工作台'])
assert.equal($('.neko-link').textContent, '连接详情')

// Pending: buttons disabled while the native action runs.
await click($$('.neko-action')[2])
assert.equal($$('.neko-action')[2].getAttribute('aria-busy'), 'true')
assert.ok($$('.neko-action').every((b) => b.disabled))
await act(async () => { deferred({ ok: true }) })
await flush()
assert.equal($('.neko-options'), null, 'handing off to a native window closes the panel')
assert.equal(document.activeElement, optBtn)

// Error surfaced inline; status action keeps panel open.
await click(optBtn)
await flush()
await click($$('.neko-action')[1])
await flush()
assert.match($('.neko-options .neko-notice--error').textContent, /桌宠未运行/)
await click($('.neko-link'))
await flush()
assert.deepEqual(calls.at(-1), ['action', 'connection-status'])
assert.ok($('.neko-options'))
await click($$('.neko-action')[4])
await flush()
assert.deepEqual(calls.at(-1), ['action', 'reconnect-workbench'])
assert.ok($('.neko-options'), 'reconnect keeps the panel open to show state')
await act(async () => {
  state = { ...state, workbench: { connection: 'error', error: '端口被占用' } }
  for (const fn of subs) fn(state)
})
assert.match($('.neko-statuses').textContent, /工作台连接出错端口被占用/)
assert.ok($('.neko-strip__options .neko-dot--error'), 'strip dot shows error')
await key(document.activeElement, 'Escape')
await flush()
assert.equal($('.neko-options'), null)
assert.ok(calls.filter((c) => c[0] === 'action').every((c) => exportsObj.ACTION_NAMES.includes(c[1])))

// --- sidebar roles + folded native tools ----------------------------------------

const nativeNav = $('#native-nav')
const nativeButtons = [...nativeNav.querySelectorAll('button')]
let pluginClicks = 0
$('#nav-plugins').addEventListener('click', () => { pluginClicks++ })
// Native More: local menu portalled to body, like the real sidebar.
$('#nav-more').addEventListener('click', () => {
  const btn = $('#nav-more')
  const open = btn.getAttribute('aria-expanded') !== 'true'
  btn.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    const menu = document.createElement('div')
    menu.setAttribute('data-slot', 'sidebar.panellist.actions')
    menu.innerHTML = '<div role="menu"><button role="menuitem" id="more-browse">浏览更多插件</button><button role="menuitem" id="more-future">未来条目</button></div>'
    document.body.appendChild(menu)
  } else {
    document.querySelector('[data-slot="sidebar.panellist.actions"]')?.remove()
  }
})
await flush()
const roleHost = $('[data-neko-role-host]')
assert.ok(roleHost, 'own host created')
assert.equal($$('[data-neko-role-host]').length, 1, 'exactly one host')
assert.equal(roleHost.previousElementSibling, $('#new-session'), 'host sits right under 新会话')
assert.equal(roleHost.nextElementSibling, nativeNav, 'native nav keeps its place')
const originalNewSession = $('#new-session')
const originalNewParent = originalNewSession.parentElement
assert.equal(originalNewSession.getAttribute('data-neko-new-session'), 'plus')
assert.equal(originalNewSession.getAttribute('aria-label'), '新建会话')
assert.equal(originalNewSession.parentElement, originalNewParent, 'native React node was not moved')
assert.equal(roleHost.hasAttribute('data-neko-actions-paired'), true)
assert.equal(roleHost.style.getPropertyValue('--neko-community-top'), '-40px')
assert.equal(roleHost.style.getPropertyValue('--neko-community-left'), '44px')
assert.equal($$('.neko-community').length, 2)
await click(originalNewSession)
assert.equal(newSessionClicks, 1, 'the original new-session click still runs exactly once')
const communityEntry = $('.neko-community')
assert.equal(communityEntry.disabled, false)
const [workMode, leisureMode] = $$('.neko-mode-switch__button')
assert.equal(workMode.textContent, '工作区')
assert.equal(leisureMode.textContent, '休闲区')
assert.equal(workMode.getAttribute('aria-pressed'), 'true')
assert.equal(leisureMode.getAttribute('aria-pressed'), 'false')
$('#composer').value = '保留未发送的草稿'
await click(leisureMode)
assert.equal($('.neko-community-pane').hidden, false, 'leisure uses the existing native community pane')
assert.equal(leisureMode.getAttribute('aria-pressed'), 'true')
assert.equal(workMode.getAttribute('aria-pressed'), 'false')
assert.equal($('#composer').value, '保留未发送的草稿')
await click(workMode)
assert.equal($('.neko-community-pane').hidden, true)
assert.equal(workMode.getAttribute('aria-pressed'), 'true')
assert.equal(leisureMode.getAttribute('aria-pressed'), 'false')
assert.equal($('#composer').value, '保留未发送的草稿')
await click(communityEntry)
assert.equal(calls.at(-1)[0], 'community')
assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)[1])), { action:'open', site:'community', bounds:{x:248,y:48,width:852,height:704} })
assert.equal($('.neko-community-pane').hidden, false)
assert.equal($('main').hasAttribute('inert'), true, 'covered coding content leaves keyboard navigation')
assert.equal($('textarea').value, '保留未发送的草稿', 'coding composer stays mounted')
const coveredDivInput = document.createElement('input')
document.body.appendChild(coveredDivInput)
coveredDivInput.focus()
assert.equal(document.activeElement, $('.neko-community-pane__toolbar button'), 'non-main covered inputs cannot retain focus')
coveredDivInput.remove()
assert.equal(opened.length, 0, 'community does not select a DSH session')
for (const width of [60, 40, 216]) {
  sidebarWidth = width
  await act(async () => { window.dispatchEvent(new window.Event('resize')) })
  await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
  const plus = Number.parseFloat(originalNewSession.style.getPropertyValue('--neko-new-session-size'))
  const left = Number.parseFloat(roleHost.style.getPropertyValue('--neko-community-left'))
  const remaining = Number.parseFloat(roleHost.style.getPropertyValue('--neko-community-width'))
  assert(plus >= 16 && remaining >= 16)
  assert(left > plus)
  assert.equal(left + remaining, width, 'collapsed/expanded row stays inside the sidebar')
}
await click($('.neko-community-pane__toolbar button'))
assert.equal($('.neko-community-pane').hidden, true)
assert.equal(workMode.getAttribute('aria-pressed'), 'true', 'native return synchronizes mode')
assert.equal($('main').hasAttribute('inert'), false)
assert.equal(document.activeElement, communityEntry)
const biliEntry = $('.neko-bilibili')
assert.equal(biliEntry.parentElement, communityEntry.parentElement, 'B站 and community share the existing action row')
await click(biliEntry)
assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)[1])), { action:'open', site:'bilibili', bounds:{x:248,y:48,width:852,height:704} })
assert.equal($('.neko-community-pane strong').textContent, 'B站')
assert.equal(biliEntry.getAttribute('aria-pressed'), 'true')
assert.equal(communityEntry.getAttribute('aria-pressed'), 'false')
await act(async () => { for (const fn of communitySubs) fn({status:'hidden',site:'community'}) })
assert.equal($('.neko-community-pane').hidden, false, 'a late hidden event from community cannot close B站')
await act(async () => { for (const fn of communitySubs) fn({status:'ready',site:'bilibili',canGoBack:true}) })
const pageBack = $('[aria-label="返回上一页"]')
assert.equal(pageBack.disabled, false)
await click(pageBack)
assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)[1])), {action:'back'})
await click($('.neko-community-pane__toolbar button'))
assert.equal(document.activeElement, biliEntry)
await click(communityEntry)
await act(async () => { for (const fn of subs) fn({ ...state, navigation: { fishSettingsRevision: 1 } }) })
assert.equal($('.neko-community-pane').hidden, true, 'fish settings navigation releases the covered workbench')
assert.equal(workMode.getAttribute('aria-pressed'), 'true', 'fish settings navigation synchronizes mode')
await click(communityEntry)
await click(originalNewSession)
assert.equal($('.neko-community-pane').hidden, true, 'native plus returns to coding without replacing the original node')
assert.equal(workMode.getAttribute('aria-pressed'), 'true', 'new session navigation synchronizes mode')
assert.equal(newSessionClicks, 2)
await click(communityEntry)
await act(async () => { $('.neko-role__tools').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles:true })) })
assert.equal($('.neko-community-pane').hidden, true, 'local tools are never covered by the native remote view')
assert.equal(workMode.getAttribute('aria-pressed'), 'true', 'local menus synchronize mode')
assert.equal(nativeNav.parentElement, $('#sb-root'), 'native nav not moved')
assert.deepEqual([...nativeNav.querySelectorAll('button')], nativeButtons, 'native buttons untouched (same nodes)')
assert.equal(nativeNav.getAttribute('data-neko-tools'), 'folded')
assert.equal(nativeNav.id, 'native-nav', 'existing id kept')
assert.equal($('#ws-nav').hasAttribute('data-neko-tools'), false, 'workspace browser nav ignored')
const css2 = $('style[id$=":style"]').textContent
assert.match(css2, /nav\[data-neko-tools="folded"\] \{ display: none !important; \}/)

const rows = $$('.neko-role')
assert.deepEqual(rows.map((r) => r.querySelector('.neko-role__name').textContent), ['Yui', '大肥鱼', 'Claude小姐'])
assert.deepEqual(rows.map((r) => r.dataset.enabled), ['false', 'true', 'false'])
assert.deepEqual(rows.map((r) => (r.querySelector('.neko-role__tag') || {}).textContent || ''), ['未接入', '', '未接入'])
assert.equal($$('.neko-role__tools').length, 1, 'only the live role has tools')
assert.ok(rows[1].querySelector('.neko-role__tools'))
assert.equal($$('.neko-role__settings').length, 3, 'every role has settings')
assert.equal($$('button button').length, 0, 'no nested buttons')
assert.equal(rows[1].dataset.active, 'true')

// Enter the live role: selectRole then openSession(real id).
await click(rows[1].querySelector('.neko-role__main'))
await flush()
assert.deepEqual(roleCalls.at(-1), ['selectRole', 'bigfish'])
assert.deepEqual(opened, ['root-session-1'], 'existing root session opened')
// Placeholder role: no select, no session, clear message.
await click(rows[0].querySelector('.neko-role__main'))
await flush()
assert.ok(!roleCalls.some((c) => c[0] === 'selectRole' && c[1] === 'yui'))
assert.equal(opened.length, 1)
assert.match($('.neko-role[data-role="yui"] .neko-role__notice').textContent, /暂未接入/)
// openSession error is reported, not faked.
await act(async () => {
  roleState = { ...roleState, workspaceSessionId: 'boom' }
  for (const fn of roleSubs) fn(roleState)
})
await click($('.neko-role[data-role="bigfish"] .neko-role__main'))
await flush()
assert.match($('.neko-role[data-role="bigfish"] .neko-role__notice').textContent, /会话已失效/)
await act(async () => {
  roleState = { ...roleState, workspaceSessionId: 'root-session-1' }
  for (const fn of roleSubs) fn(roleState)
})

// Tools overlay = the ORIGINAL nav, shown in place.
const toolsBtn = $('.neko-role__tools')
assert.equal(toolsBtn.getAttribute('aria-controls'), 'native-nav')
await click(toolsBtn)
await flush()
assert.equal(toolsBtn.getAttribute('aria-expanded'), 'true')
assert.equal(nativeNav.getAttribute('data-neko-tools'), 'open')
assert.match(nativeNav.style.getPropertyValue('--neko-tools-top'), /px$/)
assert.equal(document.activeElement, $('#nav-plugins'), 'focus moves to first native tool')
await click($('#nav-plugins'))
await flush()
assert.equal(pluginClicks, 1, 'native handler ran')
assert.equal(nativeNav.getAttribute('data-neko-tools'), 'folded', 'navigating folds the tools')
// More menu: its portal counts as inside; items close everything.
await click(toolsBtn)
await flush()
await click($('#nav-more'))
await flush()
const browse = $('#more-browse')
assert.ok(browse && $('#more-future'), 'native More items (incl. future) render')
await act(async () => { browse.dispatchEvent(new window.Event('pointerdown', { bubbles: true })) })
await flush()
assert.equal(nativeNav.getAttribute('data-neko-tools'), 'open', 'pointerdown in More portal keeps tools open')
await key(browse, 'Escape')
await flush()
assert.equal(nativeNav.getAttribute('data-neko-tools'), 'open', 'Escape goes to native More first')
await click(browse)
await flush()
assert.equal(nativeNav.getAttribute('data-neko-tools'), 'folded', 'More item folds the tools')
assert.equal($('#nav-more').getAttribute('aria-expanded'), 'false', 'native More closed through its own click')
assert.equal($('[data-slot="sidebar.panellist.actions"]'), null)
// Escape / outside.
await click(toolsBtn)
await flush()
await key(document.activeElement, 'Escape')
await flush()
assert.equal(nativeNav.getAttribute('data-neko-tools'), 'folded')
assert.equal(document.activeElement, toolsBtn, 'focus returns to tools trigger')
await click(toolsBtn)
await flush()
await act(async () => { $('#composer').dispatchEvent(new window.Event('pointerdown', { bubbles: true })) })
await flush()
assert.equal(nativeNav.getAttribute('data-neko-tools'), 'folded', 'outside pointerdown folds')
assert.equal(live.size, baseline, 'no listeners left after tools close')

// Role settings: rename + builtin avatar + PNG upload; global avatar untouched.
const globalSrc = $('.neko-avatar-btn img').getAttribute('src')
const claudeRow = () => $('.neko-role[data-role="claude"]')
await click(claudeRow().querySelector('.neko-role__settings'))
await flush()
const rp = $('.neko-role-panel')
assert.ok(rp)
assert.match(rp.textContent, /未接入/)
const input = rp.querySelector('input')
assert.equal(document.activeElement, input)
const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
await act(async () => { setValue.call(input, '  克劳德  '); input.dispatchEvent(new window.Event('input', { bubbles: true })) })
await act(async () => { rp.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) })
await flush()
assert.deepEqual(roleCalls.at(-1), ['updateRole', 'claude', { name: '克劳德' }])
assert.equal(claudeRow().querySelector('.neko-role__name').textContent, '克劳德')
await click($$('.neko-role-panel .neko-tile')[4])
await flush()
assert.deepEqual(roleCalls.at(-1), ['updateRole', 'claude', { avatarId: 'gemini' }])
await click($('.neko-role-panel .neko-picker__upload'))
await flush()
assert.deepEqual(roleCalls.at(-1), ['uploadAvatar', 'claude'])
assert.equal(claudeRow().querySelector('.neko-role__img').getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=')
assert.equal($$('.neko-role-panel .neko-tile').length, 6, 'custom tile appears for the role')
assert.equal(claudeRow().dataset.enabled, 'false', 'customizing does not connect the role')
assert.equal($('.neko-avatar-btn img').getAttribute('src'), globalSrc, 'global avatar unchanged')
await key(document.activeElement, 'Escape')
await flush()
assert.equal($('.neko-role-panel'), null)
assert.equal(calls.filter((c) => c[0] === 'setAvatar').length, 3, 'roles never call nekoWorkbench.setAvatar')

// A native new-session React render may replace its button. The old node
// restores cleanly and the next original node keeps its own click handler.
const replacementNewSession = document.createElement('button')
replacementNewSession.id = 'new-session-2'
replacementNewSession.setAttribute('aria-label', 'New chat')
replacementNewSession.textContent = 'New chat'
let replacementClicks = 0
replacementNewSession.addEventListener('click', () => { replacementClicks++ })
await act(async () => { originalNewSession.replaceWith(replacementNewSession) })
await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
assert.equal(originalNewSession.getAttribute('data-neko-new-session'), null)
assert.equal(originalNewSession.style.getPropertyValue('--neko-new-session-size'), '')
assert.equal(replacementNewSession.getAttribute('data-neko-new-session'), 'plus')
await click(replacementNewSession)
assert.equal(replacementClicks, 1)
assert.equal($$('.neko-community').length, 2)

// Sidebar re-render: native nav replaced -> adapter follows, no duplicate host.
const freshNav = nativeNav.cloneNode(true)
freshNav.id = 'native-nav-2'
await act(async () => { nativeNav.replaceWith(freshNav) })
await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
assert.equal($$('[data-neko-role-host]').length, 1)
assert.equal($('[data-neko-role-host]').nextElementSibling, freshNav)
assert.equal(freshNav.getAttribute('data-neko-tools'), 'folded')
assert.equal($('.neko-role__tools').getAttribute('aria-controls'), 'native-nav-2')

// The actual native controls can be React-owned: replacing or unmounting
// them must not throw removeChild errors caused by moving their nodes.
const originalSidebar = document.querySelector('[data-slot="sidebar"]')
const nativeFixture = document.createElement('div')
const nativeRoot = ReactDOMClient.createRoot(nativeFixture)
let reactNewClicks = 0
const renderNative = (key) => nativeRoot.render(React.createElement('div', { 'data-slot':'sidebar' },
  React.createElement('div', { id:'react-sidebar' },
    React.createElement('button', { key, id:'new-session', 'aria-label':'新建会话', onClick:()=>{reactNewClicks++} }, '新建会话'),
    React.createElement('nav', { id:'react-native-nav' }, React.createElement('button', null, '插件')),
    React.createElement('div', { 'data-slot':'sidebar.workspaces' }, '会话列表'))))
await act(async () => { originalSidebar.remove(); document.body.prepend(nativeFixture); renderNative('first') })
await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
const reactOriginal = $('#new-session')
assert.equal(reactOriginal.parentElement.id, 'react-sidebar')
assert.equal(reactOriginal.getAttribute('data-neko-new-session'), 'plus')
await click(reactOriginal)
assert.equal(reactNewClicks, 1)
await act(async () => { renderNative('second') })
await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
assert.notEqual($('#new-session'), reactOriginal)
assert.equal($('#new-session').parentElement.id, 'react-sidebar')
assert.equal(reactOriginal.getAttribute('data-neko-new-session'), null)
assert.equal($('#new-session').getAttribute('data-neko-new-session'), 'plus')
assert.equal($$('.neko-community').length, 2)
await click($('#new-session'))
assert.equal(reactNewClicks, 2, 'React click dispatch remains intact after native re-render')
await act(async () => { nativeRoot.unmount(); nativeFixture.remove() })
await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
assert.equal($$('[data-neko-role-host]').length, 0)
await act(async () => { document.body.prepend(originalSidebar) })
await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
assert.equal($$('[data-neko-role-host]').length, 1)
assert.equal(replacementNewSession.getAttribute('data-neko-new-session'), 'plus')

// --- unload ---------------------------------------------------------------

await click(optBtn)
await flush()
await act(async () => { for (const r of roots) r.unmount() })
for (const d of disposers.reverse()) d()
assert.equal(subs.size, 0, 'bridge unsubscribed')
// jsdom's hover tracker and React's selection delegation live for the document.
// All plugin listeners, including permanent row resize/scroll observers, must go.
assert.deepEqual([...live.values()].sort(), ['mouseout', 'mouseover', 'selectionchange'], 'only jsdom/React document listeners remain after unload')
assert.equal(document.title, 'New chat — DeepSeek Harness')
assert.equal($('style[id$=":style"]'), null)
assert.equal($('.neko-pop'), null)
assert.equal($('.neko-community-pane'), null)
assert.equal($('[data-neko-role-host]'), null, 'role host removed')
assert.equal($$('[data-neko-tools]').length, 0, 'no tools markers left')
assert.equal(freshNav.getAttribute('style') || '', '', 'no inline vars left')
assert.equal(roleSubs.size, 0, 'roles bridge unsubscribed')
assert.equal(replacementNewSession.getAttribute('data-neko-new-session'), null)
assert.equal(replacementNewSession.style.getPropertyValue('--neko-new-session-size'), '')
assert.equal(replacementNewSession.parentElement, originalNewParent)
assert.equal(replacementNewSession.getAttribute('aria-label'), 'New chat')
assert.equal(freshNav.parentElement, $('#sb-root'))
assert.equal(liveStatus.textContent, '深度求索中', 'native live status restored on unload')
assert.equal(liveText.textContent, '深度求索中，用时 28 秒 ···', 'native latest elapsed text restored on unload')
assert.equal(shimmerText.getAttribute('data-shimmer-text'), '深度求索中，用时 28 秒 ···')

console.log('ok: hero gallery, avatar picker, workbench options, plus/community row, sidebar roles, native running status, folded tools, focus, dismissal, pending/error states and unload are consistent')
