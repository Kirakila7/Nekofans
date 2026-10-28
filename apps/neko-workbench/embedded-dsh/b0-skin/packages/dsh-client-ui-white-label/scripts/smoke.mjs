/**
 * Offline smoke test for the white-label bundle (no dependencies, no DSH).
 *
 * Verifies the loader wrapper/id, exports, product identity (N.E.K.O.; the
 * 大肥鱼 name appears only as one of five avatars), slots, title rewrite,
 * favicon, scoped hero CSS, avatar assets (placeholder or embedded), bridge
 * state sanitizing, the store against a fake window.nekoWorkbench (set,
 * upload, cancel, actions, errors, subscribe), and unload restore.
 *
 *   node scripts/smoke.mjs        (NEKO_BUNDLE=/path/client.js to test another copy)
 * Interactive DOM behaviour is covered by scripts/dom-check.mjs.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// NEKO_BUNDLE lets CI smoke a copy with embedded avatars.
const bundlePath = process.env.NEKO_BUNDLE || join(root, 'lib', 'client.js')
const code = readFileSync(bundlePath, 'utf8')

// --- fake browser surface ---------------------------------------------------

const head = {
  children: [],
  appendChild(element) { if (!this.children.includes(element)) this.children.push(element) },
}
function makeElement(tag) {
  return {
    tag, id: '', rel: '', type: '', href: '', textContent: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v) },
    remove() { const i = head.children.indexOf(this); if (i >= 0) head.children.splice(i, 1) },
  }
}
const document = {
  title: '',
  head,
  getElementById(id) { return head.children.find((c) => c.id === id) ?? null },
  createElement: makeElement,
  querySelectorAll(selector) {
    if (selector !== 'link[rel~="icon"]') return []
    return head.children.filter((c) => c.tag === 'link' && /\bicon\b/.test(c.rel))
  },
}
const observers = []
class MutationObserver {
  constructor(callback) { this.callback = callback; observers.push(this) }
  observe() { this.observing = true }
  disconnect() { this.observing = false }
}
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'Fragment' }

const official = makeElement('link')
official.rel = 'icon'
official.href = '/favicon.ico'
head.appendChild(official)

const sandbox = { window: {}, document, MutationObserver, console, setTimeout, clearTimeout }
sandbox.window.__ModuleLoader__ = { load(entry) { this.entry = entry } }
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: bundlePath })
const entry = sandbox.window.__ModuleLoader__?.entry
assert.ok(entry, 'bundle must call window.__ModuleLoader__.load({ id, factory })')
assert.equal(entry.id, manifest.name, 'bundle id must equal the package name')

const requested = []
const exports = entry.factory((id) => {
  requested.push(id)
  if (id === 'react') return React
  if (id === 'react-dom') return { createPortal: (node, host) => ({ portal: node, host }) }
  throw new Error(`unexpected external module: ${id}`)
})
assert.deepEqual(requested, ['react', 'react-dom'], 'only react and react-dom are required')
assert.equal(typeof exports.apply, 'function')
assert.deepEqual([...exports.inject], ['slots', 'uiWorkspace', 'workspaces', 'remote', 'remote.account', 'locale'])
assert.equal(exports.PRODUCT_BRAND.name, 'N.E.K.O. 工作台')
assert.equal(exports.PRODUCT_BRAND.shortName, 'N.E.K.O.')

const fakeCtx = { uiWorkspace: { selection: { getSnapshot: () => ({ sessionId: 's1' }) } }, get: () => ({ list: { getSnapshot: () => ({ phase: 'ready', items: [{ workspaceId: 'w1', title: 'Project', path: '/tmp/project', sessionIds: ['s1'] }] }) } }) }
assert.equal(exports.readSharedWorkspace(fakeCtx).project.path, '/tmp/project')
assert.equal(exports.readSharedWorkspace({}).phase, 'loading')
fakeCtx.uiWorkspace.selection.getSnapshot = () => ({ sessionId: 'missing' })
assert.equal(exports.readSharedWorkspace(fakeCtx).phase, 'missing')

assert.ok(Object.isFrozen(exports.PRODUCT_BRAND))

// --- avatars ----------------------------------------------------------------

const IDS = ['yui', 'devcat', 'bigfish', 'claude', 'gemini']
assert.deepEqual([...exports.AVATARS.map((a) => a.id)], IDS)
assert.deepEqual([...exports.AVATARS.map((a) => a.name)], ['YUi', '开发喵', '大肥鱼', 'Claude娘', 'Gemini小猫'])
assert.deepEqual([...exports.ACTION_NAMES], ['neko-settings', 'open-neko', 'task-notes', 'connect-neko', 'connection-status', 'reconnect-workbench', 'open-community', 'open-bilibili'])
for (const id of IDS) assert.match(exports.PLACEHOLDERS[id], /^data:image\/svg\+xml,/, `placeholder ${id}`)
const art = exports.AVATAR_ART
const embedded = Object.keys(art)
assert.ok(embedded.length === 0 || embedded.length === 5, 'all five avatars embedded or none')
for (const id of embedded) {
  assert.ok(IDS.includes(id))
  assert.match(art[id], /^data:image\/(webp|png);base64,/, `${id} uses an embedded raster`)
  const bytes = Buffer.from(art[id].split(',')[1], 'base64')
  assert.ok(bytes.length > 0 && bytes.length <= 200 * 1024, `${id} within 200 KB`)
  if (art[id].startsWith('data:image/webp;')) {
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP')
  }
}
console.log(`  avatars: ${embedded.length ? 'embedded raster x5' : 'SVG placeholders'}`)

// Bigfish may identify an avatar, a live role or the connected account, never the product brand.
const codeOnly = code
  .replace(/\/\/ @neko-account-habitat:start[\s\S]*?\/\/ @neko-account-habitat:end/g, '')
  .replace(/\/\/ @neko-avatar-theme:start[\s\S]*?\/\/ @neko-avatar-theme:end/g, '')
  .replace("name.textContent = '大肥鱼'", "name.textContent = ''")
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')
  .replaceAll('@bigfish/dsh-client-ui-white-label', '')
  .replace(/^.*(id: 'bigfish'|bigfish: \{|bigfish: 'data:|'yui', 'devcat', 'bigfish'|const LIVE_ROLE = 'bigfish').*$/gm, '')
assert.ok(!/大肥鱼|bigfish|whale|鲸/i.test(codeOnly), 'no bigfish identity outside approved avatar, role and account labels')
assert.ok(!/大肥鱼|whale|鲸/.test(JSON.stringify(exports.PRODUCT_BRAND) + exports.faviconSvg()))

// --- apply() ---------------------------------------------------------------

function runApply() {
  const registrations = []
  const disposers = []
  const effects = []
  const injected = []
  const ctx = {
    uiWorkspace: { openSession(id) { opened.push(id) } },
    effect(fn, label) { effects.push(label); const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    slots: {
      inject(key, callback) { injected.push(key); const d = callback(); disposers.push(d); return d },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => { registrations.splice(registrations.findIndex((r) => r.spec === spec), 1) }
      },
    },
  }
  exports.apply(ctx)
  return { registrations, disposers, effects, injected }
}
const opened = []

document.title = 'Fix the parser — DeepSeek Harness'
const run = runApply()
assert.deepEqual(run.registrations.map((r) => r.spec.name),
  ['shell.overlay', 'settings.onboarding', 'shell.overlay', 'sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark', 'shell.bottom'])
assert.deepEqual(run.injected.slice(0, 4), ['shell.overlay', 'settings.onboarding', 'sidebar.panellist', 'shell.overlay'], 'role adapter nested in the sidebar declaration')
assert.deepEqual({ ...run.registrations[1].spec }, { name: 'settings.onboarding', id: 'welcome-notice', order: -100, priority: -1 })
assert.equal(run.registrations[2].spec.id, 'neko.role-sidebar-adapter')
assert.equal(run.registrations[6].spec.order, 100)
assert.ok(!run.registrations.some((r) => /^sidebar\.(panellist|workspaces)/.test(r.spec.name)), 'no native sidebar slot replaced')
assert.ok(!run.registrations.some((r) => /hero\.brand\.name|hero\.(workspace|agentPreset|options)/.test(r.spec.name)), 'feature slots untouched')
assert.deepEqual(run.effects, ['neko-brand: styles', 'neko-brand: Codex styles', 'neko-brand: native account habitat', 'neko-brand: avatar theme', 'neko-brand: favicon', 'neko-brand: title observer', 'neko-brand: workbench bridge', 'neko-brand: roles bridge', 'neko-brand: community coding pane', 'neko-brand: compact running status'])
const byName = Object.fromEntries(run.registrations.map((r) => [r.spec.name, r.component.name]))
assert.deepEqual(byName, {
  'sidebar.brand.mark': 'SidebarMark', 'sidebar.brand.name': 'SidebarName',
  'conversation.hero.brand.mark': 'HeroGallery', 'shell.bottom': 'ProductStrip', 'shell.overlay': 'RolesSidebarAdapter',
  'settings.onboarding': 'SkipWelcomeNotice',
})
assert.equal(run.registrations[4].component().children[0], 'N.E.K.O. 工作台')

assert.equal(document.title, 'Fix the parser — N.E.K.O. 工作台')
document.title = 'New chat — DeepSeek Harness'
observers[0].callback()
assert.equal(document.title, 'New chat — N.E.K.O. 工作台')

const icons = document.querySelectorAll('link[rel~="icon"]')
assert.equal(icons.length, 1)
const svg = decodeURIComponent(icons[0].href.slice('data:image/svg+xml,'.length))
assert.match(svg, /prefers-color-scheme: dark/)
assert.equal((svg.match(/<path /g) || []).length, exports.MARK.length)

// --- CSS: hero takeover is scoped to the headline holding our gallery -------

const style = document.getElementById(`${manifest.name}:style`)
assert.ok(style)
const css = style.textContent
assert.match(css, /prefers-reduced-motion/)
assert.match(css, /display: var\(--neko-skin-display, none\)/)
assert.match(css, /content: var\(--neko-skin-label, ""\)/)
const hideRules = css.split('}').filter((rule) => /display:\s*none/.test(rule)).map((rule) => rule.split('{')[0].replace(/\/\*[\s\S]*?\*\//g, '').trim())
for (const selector of hideRules) {
  const ok = /:has\(> span > \.neko-gallery/.test(selector) || /^\.neko-/.test(selector) || /^@media/.test(selector) ||
    selector === 'nav[data-neko-tools="folded"]' ||
    selector === 'button[data-neko-new-session="plus"] > *' ||
    selector.split(',').every((part) => {
      const base = '[data-slot="settings.launcher"] button.hjANda_trigger[aria-haspopup="menu"][data-collapsed][data-signed-out]'
      return [' > .hjANda_avatar', ' > .hjANda_label', ' > svg', '[data-collapsed="true"]::after'].some((suffix) => part.trim() === base + suffix)
    })
  assert.ok(ok, `display:none only on scoped selectors, got: ${selector}`)
}
assert.ok(!/(^|\})\s*(h1|h2|h3|header|\[class\*=)/m.test(css), 'no global heading rules')

// --- state sanitizing -----------------------------------------------------

const { sanitizeState, describeConnection, createStore } = exports
const clean = sanitizeState({
  avatar: { builtinId: 'custom', customDataUrl: 'javascript:alert(1)' },
  neko: { enabled: 'yes', connection: 'connected', character: 'x'.repeat(500), token: 'secret' },
  workbench: { connection: 'error', error: 'port busy', history: ['msg'] },
  secret: 'nope',
})
assert.equal(clean.avatar.builtinId, 'yui', 'custom without a valid image falls back')
assert.equal(clean.avatar.customDataUrl, null, 'non-image URLs rejected')
assert.equal(clean.neko.enabled, false, 'only boolean true enables')
assert.equal(clean.neko.character.length, 160, 'text capped')
assert.deepEqual([...Object.keys(clean)].sort(), ['avatar', 'neko', 'workbench'])
assert.deepEqual([...Object.keys(clean.neko)].sort(), ['character', 'connection', 'enabled', 'error'])
assert.deepEqual([...Object.keys(clean.workbench)].sort(), ['connection', 'error'])
assert.equal(sanitizeState(null).avatar.builtinId, 'yui')
assert.equal(sanitizeState({ avatar: { builtinId: 'evil' } }).avatar.builtinId, 'yui')
const tinyPng = 'data:image/png;base64,iVBORw0KGgo='
assert.equal(sanitizeState({ avatar: { builtinId: 'custom', customDataUrl: tinyPng } }).avatar.builtinId, 'custom')
assert.deepEqual({ ...describeConnection('connected', '', true) }, { label: '已连接', tone: 'ok' })
assert.deepEqual({ ...describeConnection('connected', '', false) }, { label: '未启用', tone: 'off' })
assert.equal(describeConnection('reconnecting', '').tone, 'busy')
assert.equal(describeConnection('disconnected', 'refused').tone, 'error')

// --- store against a fake bridge -------------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 0))
function fakeBridge() {
  let state = {
    avatar: { builtinId: 'devcat', customDataUrl: null },
    neko: { enabled: true, connection: 'connected', character: 'YUi', error: '' },
    workbench: { connection: 'connected', error: '' },
  }
  const subs = new Set()
  const calls = []
  return {
    calls, subs,
    push(next) { state = next; for (const fn of subs) fn(next) },
    getState: async () => { calls.push(['getState']); return state },
    setAvatar: async (id) => {
      calls.push(['setAvatar', id])
      if (id === 'claude') throw new Error('disk full')
      state = { ...state, avatar: { ...state.avatar, builtinId: id } }
      return state
    },
    uploadAvatar: async () => {
      calls.push(['uploadAvatar'])
      if (calls.filter((c) => c[0] === 'uploadAvatar').length === 1) return null // cancelled
      state = { ...state, avatar: { builtinId: 'custom', customDataUrl: tinyPng } }
      return state
    },
    action: async (name) => { calls.push(['action', name]); if (name === 'open-neko') return { ok: false }; return { ok: true } },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
  }
}

const bridge = fakeBridge()
const store = createStore(bridge)
await tick()
assert.equal(store.get().preview, false)
assert.equal(store.get().state.avatar.builtinId, 'devcat', 'initial getState applied')
await store.setAvatar('gemini')
assert.equal(store.get().state.avatar.builtinId, 'gemini')
assert.equal(store.get().pending.avatar, null)
await store.setAvatar('evil')
assert.ok(!bridge.calls.some((c) => c[1] === 'evil'), 'unknown ids never reach the bridge')
await store.setAvatar('claude')
assert.equal(store.get().state.avatar.builtinId, 'gemini', 'failed switch keeps the previous avatar')
assert.equal(store.get().notice.scope, 'avatar')
assert.match(store.get().notice.text, /disk full/)
await store.uploadAvatar()
assert.equal(store.get().state.avatar.builtinId, 'gemini', 'cancelled upload changes nothing')
assert.equal(store.get().pending.upload, false)
await store.uploadAvatar()
assert.equal(store.get().state.avatar.builtinId, 'custom')
assert.equal(await store.runAction('task-notes'), true)
assert.equal(await store.runAction('rm -rf'), false)
assert.ok(!bridge.calls.some((c) => c[1] === 'rm -rf'), 'only allowlisted actions reach the bridge')
assert.equal(await store.runAction('open-neko'), false, 'unconfirmed action reported')
assert.equal(store.get().notice.tone, 'error')
bridge.push({ ...store.get().state, workbench: { connection: 'reconnecting', error: '' } })
assert.equal(store.get().state.workbench.connection, 'reconnecting', 'subscribe pushes state')
assert.equal(bridge.subs.size, 1)
store.dispose()
assert.equal(bridge.subs.size, 0, 'dispose unsubscribes from the bridge')

// Preview mode: no bridge, in-memory only, actions explain themselves.
const preview = createStore(null)
assert.equal(preview.get().preview, true)
await preview.setAvatar('bigfish')
assert.equal(preview.get().state.avatar.builtinId, 'bigfish')
assert.equal(await preview.runAction('open-neko'), false)
assert.match(preview.get().notice.text, /预览模式/)
preview.dispose()

// --- sidebar roles (window.nekoRoles) ---------------------------------------

const { sanitizeRoles, checkRoleName, createRolesStore } = exports
const J = (v) => JSON.parse(JSON.stringify(v))
assert.deepEqual([...exports.ROLE_DEFAULTS.map((r) => r.name)], ['Yui', '大肥鱼', 'Claude小姐'])
assert.equal(exports.LIVE_ROLE, 'bigfish')
const rolesDefault = sanitizeRoles(null)
assert.deepEqual(J(rolesDefault.roles.map((r) => [r.id, r.enabled])), [['yui', false], ['bigfish', true], ['claude', false]])
assert.equal(rolesDefault.activeId, 'bigfish')
assert.equal(rolesDefault.workspaceSessionId, null)
const rolesDirty = sanitizeRoles({
  activeId: 'yui',
  workspaceSessionId: 'abc def<script>',
  roles: [
    { id: 'yui', name: 'Y‮ui', avatarId: 'custom', customDataUrl: null, enabled: true, backend: 'x' },
    { id: 'claude', name: '  小克  ', avatarId: 'gemini', customDataUrl: 'data:image/webp;base64,AAAA' },
    { id: 'intruder', name: 'x', enabled: true },
  ],
})
assert.deepEqual(J(rolesDirty.roles.map((r) => r.id)), ['yui', 'bigfish', 'claude'], 'fixed ids, order and count')
assert.equal(rolesDirty.roles[0].enabled, false, 'host cannot enable a placeholder role')
assert.equal(rolesDirty.roles[0].name, 'Yui', 'bidi/control names fall back')
assert.equal(rolesDirty.roles[0].avatarId, 'yui', 'custom without image falls back')
assert.equal(rolesDirty.roles[2].name, '小克')
assert.equal(rolesDirty.roles[2].avatarId, 'gemini')
assert.equal(rolesDirty.roles[2].customDataUrl, null, 'role images are PNG only')
assert.equal(rolesDirty.activeId, 'bigfish', 'disabled role cannot be active')
assert.equal(rolesDirty.workspaceSessionId, null, 'malformed session id rejected')
assert.ok(!('backend' in rolesDirty.roles[0]))
assert.equal(sanitizeRoles({ roles: [{ id: 'bigfish', enabled: false }] }).roles[1].enabled, false, 'host may disable the live role')
assert.equal(checkRoleName('a'.repeat(25)).error !== undefined, true)
assert.equal(checkRoleName('😺'.repeat(24)).name.length, 48, '24 code points, not UTF-16 units')
assert.ok(checkRoleName('   ').error)

function fakeRoles() {
  let state = {
    activeId: 'bigfish',
    workspaceSessionId: 'sess_root-01',
    roles: [
      { id: 'yui', name: 'Yui', avatarId: 'yui', customDataUrl: null, enabled: false },
      { id: 'bigfish', name: '大肥鱼', avatarId: 'bigfish', customDataUrl: null, enabled: true },
      { id: 'claude', name: 'Claude小姐', avatarId: 'claude', customDataUrl: null, enabled: false },
    ],
  }
  const calls = []
  const subs = new Set()
  return {
    calls, subs,
    set(next) { state = next },
    getState: async () => state,
    selectRole: async (id) => {
      calls.push(['selectRole', id])
      if (id !== 'bigfish') throw new Error('暂未接入')
      return state
    },
    updateRole: async (id, patch) => {
      calls.push(['updateRole', id, patch])
      if (patch.name === 'boom') throw new Error('磁盘已满')
      state = { ...state, roles: state.roles.map((r) => (r.id === id ? { ...r, ...patch } : r)) }
      return state
    },
    uploadAvatar: async (id) => {
      calls.push(['uploadAvatar', id])
      if (calls.filter((c) => c[0] === 'uploadAvatar').length === 1) return null
      state = { ...state, roles: state.roles.map((r) => (r.id === id ? { ...r, avatarId: 'custom', customDataUrl: tinyPng } : r)) }
      return state
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn) },
  }
}

const rb = fakeRoles()
const sessions = []
const rs = createRolesStore(rb, { openSession: (id) => sessions.push(id) })
await tick()
assert.equal(rs.get().state.workspaceSessionId, 'sess_root-01')
assert.equal(await rs.enter('bigfish'), true)
assert.deepEqual(rb.calls.at(-1), ['selectRole', 'bigfish'])
assert.deepEqual(sessions, ['sess_root-01'], 'opens the bridge-provided real root session')
assert.equal(await rs.enter('yui'), false)
assert.ok(!rb.calls.some((c) => c[0] === 'selectRole' && c[1] === 'yui'), 'placeholder roles never reach selectRole')
assert.match(rs.get().notice.text, /暂未接入/)
assert.equal(rs.get().notice.scope, 'yui')
assert.equal(await rs.enter('intruder'), false)
rb.set({ ...(await rb.getState()), workspaceSessionId: null })
assert.equal(await rs.enter('bigfish'), false, 'no session id: no fake session')
assert.equal(sessions.length, 1)
assert.match(rs.get().notice.text, /会话尚未就绪/)
rb.set({ ...(await rb.getState()), workspaceSessionId: 'sess_root-01' })
const throwing = createRolesStore(rb, { openSession: () => { throw new Error('session gone') } })
await tick()
assert.equal(await throwing.enter('bigfish'), false)
assert.match(throwing.get().notice.text, /session gone/, 'real openSession error surfaces')
throwing.dispose()

assert.equal(await rs.update('claude', { name: '  小克  ' }), true)
assert.deepEqual(J(rb.calls.at(-1)), ['updateRole', 'claude', { name: '小克' }])
assert.equal(rs.get().state.roles[2].name, '小克')
assert.equal(await rs.update('claude', { name: '' }), false)
assert.ok(!rb.calls.some((c) => c[0] === 'updateRole' && c[2].name === ''), 'invalid names stay local')
assert.equal(await rs.update('claude', { avatarId: 'custom' }), false, 'custom needs an upload first')
assert.equal(await rs.update('yui', { avatarId: 'gemini', enabled: true, customDataUrl: 'x' }), true)
assert.deepEqual(J(rb.calls.at(-1)), ['updateRole', 'yui', { avatarId: 'gemini' }], 'only name/avatarId are sent')
assert.equal(await rs.update('claude', { name: 'boom' }), false)
assert.equal(rs.get().state.roles[2].name, '小克', 'failed save keeps the old name')
assert.match(rs.get().notice.text, /磁盘已满/)
await rs.upload('yui')
assert.equal(rs.get().state.roles[0].avatarId, 'gemini', 'cancelled upload changes nothing')
await rs.upload('yui')
assert.equal(rs.get().state.roles[0].avatarId, 'custom')
assert.deepEqual(rb.calls.filter((c) => c[0] === 'uploadAvatar').map((c) => c[1]), ['yui', 'yui'])
assert.equal(rs.get().state.roles[0].enabled, false, 'customizing never connects a role')
assert.equal(rb.subs.size, 1)
rs.dispose()
assert.equal(rb.subs.size, 0)

const rolesPreview = createRolesStore(null, { openSession: (id) => sessions.push(id) })
assert.equal(await rolesPreview.enter('bigfish'), false)
assert.match(rolesPreview.get().notice.text, /预览模式/)
assert.equal(await rolesPreview.update('bigfish', { name: '肥鱼' }), true)
assert.equal(rolesPreview.get().state.roles[1].name, '肥鱼')
assert.equal(sessions.length, 1, 'preview never opens sessions')
rolesPreview.dispose()

assert.ok(!/deepseek-(flash|account|official)/i.test(codeOnly))
assert.ok(!/localStorage|sessionStorage|prompt\(|token/i.test(codeOnly), 'no web storage, prompts or tokens')

// --- unload restores everything ---------------------------------------------

for (const dispose of run.disposers.reverse()) dispose()
assert.equal(run.registrations.length, 0)
assert.equal(document.getElementById(`${manifest.name}:style`), null)
assert.deepEqual(document.querySelectorAll('link[rel~="icon"]'), [official])
assert.equal(document.title, 'New chat — DeepSeek Harness')
assert.ok(observers.every((o) => !o.observing))

console.log('ok: white-label wrapper, slots, avatars, bridge store, title, favicon and unload restore are consistent')
