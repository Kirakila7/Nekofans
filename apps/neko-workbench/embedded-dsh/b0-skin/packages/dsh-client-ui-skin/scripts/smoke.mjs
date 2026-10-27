/**
 * Offline smoke test for the N.E.K.O. skin bundle (does not boot DSH).
 *
 * Checks: loader wrapper/id, exports, skin selection + fallback, that skins
 * only carry palette tokens and a chip (no product identity), WCAG AA
 * contrast for every skin in both modes, and unload.
 *
 *   node scripts/smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

// --- fake browser surface ---------------------------------------------------

const head = { children: [], appendChild(el) { this.children.push(el) } }
const document = {
  cookie: '',
  head,
  getElementById(id) { return head.children.find((c) => c.id === id) ?? null },
  createElement(tag) {
    return {
      tag, id: '', textContent: '',
      remove() { const i = head.children.indexOf(this); if (i >= 0) head.children.splice(i, 1) },
    }
  },
}
const store = new Map()
const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }

const sandbox = { window: { localStorage }, document, console }
sandbox.window.__ModuleLoader__ = { load(entry) { this.entry = entry } }
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: join(root, 'lib', 'client.js') })

const entry = sandbox.window.__ModuleLoader__?.entry
assert.ok(entry, 'bundle must call window.__ModuleLoader__.load({ id, factory })')
assert.equal(entry.id, manifest.name, 'bundle id must equal the package name')
const exports = entry.factory((id) => { throw new Error(`unexpected external module: ${id}`) })
assert.equal(typeof exports.apply, 'function')
assert.deepEqual([...exports.inject], ['theme'])

// --- skins carry palette + chip only ----------------------------------------

const { SKINS, DEFAULT_SKIN, ALLOWED_TOKENS, STORAGE_KEY, COOKIE_NAME } = exports
assert.equal(COOKIE_NAME, 'neko_skin')
assert.equal(DEFAULT_SKIN, 'neko-mist')
assert.deepEqual(Object.keys(SKINS).sort(), ['bigfish', 'neko-mist'])
for (const [id, skin] of Object.entries(SKINS)) {
  exports.validateSkin(id, skin)
  assert.deepEqual(Object.keys(skin.tokens).sort(), [...ALLOWED_TOKENS].sort(), `${id}: full token set`)
  const text = JSON.stringify(skin)
  assert.ok(!/N\.E\.K\.O\. 工作台|productName|PRODUCT/.test(text), `${id}: skins must not carry product identity`)
}
assert.equal(SKINS['neko-mist'].chip, null, 'default skin has no chip')
assert.equal(SKINS.bigfish.chip.label, '大肥鱼皮肤')
assert.throws(() => exports.validateSkin('x', { label: 'x', tokens: {}, chip: null, name: 'Other' }), /unsupported keys/)
assert.throws(() => exports.validateSkin('x', { label: 'x', tokens: { '--dsw-alias-font': { light: 'a', dark: 'b' } }, chip: null }), /not allowed/)
assert.equal(exports.resolveSkinId('bigfish'), 'bigfish')
assert.equal(exports.resolveSkinId('nope'), 'neko-mist')
assert.equal(exports.resolveSkinId('__proto__'), 'neko-mist')
assert.equal(exports.resolveSkinId(null), 'neko-mist')
assert.equal(exports.resolveSkinId('nope', 'bigfish'), 'bigfish', 'first known candidate wins')

// --- contrast (WCAG 2.x AA) -------------------------------------------------

const lum = (hex) => {
  const c = hex.match(/\w\w/g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const SURFACES = ['bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-overlay'].map((k) => '--dsw-alias-' + k).concat('--dsw-specific-sidebar-fill')
const TEXT = ['brand-text', 'link', 'label-primary', 'label-secondary'].map((k) => '--dsw-alias-' + k)
for (const [id, skin] of Object.entries(SKINS)) {
  for (const mode of ['light', 'dark']) {
    const t = (k) => skin.tokens[k][mode]
    for (const bg of SURFACES) for (const fg of TEXT) {
      const r = contrast(t(fg), t(bg))
      assert.ok(r >= 4.5, `${id}/${mode}: ${fg} on ${bg} = ${r.toFixed(2)}`)
    }
    for (const fill of ['--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover']) {
      const r = contrast(t('--dsw-alias-label-primary-inverted'), t(fill))
      assert.ok(r >= 4.5, `${id}/${mode}: inverted label on ${fill} = ${r.toFixed(2)}`)
    }
  }
}

// --- apply() + unload --------------------------------------------------------

function run() {
  const calls = { effects: [], layers: [] }
  const disposers = []
  const ctx = {
    effect(fn, label) { calls.effects.push(label); const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    theme: {
      overrideTokens(source, tokens) {
        const layer = { source, tokens, live: true }
        calls.layers.push(layer)
        return () => { layer.live = false }
      },
    },
  }
  exports.apply(ctx)
  return { calls, unload: () => { for (const d of disposers.reverse()) d() } }
}

// default
let { calls, unload } = run()
assert.deepEqual(calls.effects, ['neko-skin: chip (neko-mist)', 'neko-skin: tokens (neko-mist)'])
assert.equal(calls.layers[0].source, manifest.name)
assert.equal(calls.layers[0].tokens, SKINS['neko-mist'].tokens)
let style = document.getElementById(`${manifest.name}:style`)
assert.match(style.textContent, /--neko-skin-display: none/)
unload()
assert.equal(document.getElementById(`${manifest.name}:style`), null, 'style removed on unload')
assert.equal(calls.layers[0].live, false, 'token layer disposed on unload')

// bigfish via localStorage
store.set(STORAGE_KEY, 'bigfish')
;({ calls, unload } = run())
assert.equal(calls.layers[0].tokens, SKINS.bigfish.tokens)
style = document.getElementById(`${manifest.name}:style`)
assert.match(style.textContent, /--neko-skin-display: inline-flex/)
assert.match(style.textContent, /--neko-skin-label: "大肥鱼皮肤"/)
assert.match(style.textContent, /--neko-skin-badge: url\("data:image\/svg\+xml,/)
// re-apply replaces, never duplicates
run()
assert.equal(head.children.filter((c) => c.tag === 'style').length, 1)

// unknown stored value falls back to default
store.set(STORAGE_KEY, 'rainbow')
;({ calls } = run())
assert.equal(calls.layers[0].tokens, SKINS['neko-mist'].tokens)

// cookie (set by the pet main process) wins over localStorage
document.cookie = 'other=1; neko_skin=bigfish'
store.set(STORAGE_KEY, 'neko-mist')
;({ calls } = run())
assert.equal(calls.layers[0].tokens, SKINS.bigfish.tokens)
document.cookie = 'neko_skin=neko-mist'
store.set(STORAGE_KEY, 'bigfish')
;({ calls } = run())
assert.equal(calls.layers[0].tokens, SKINS['neko-mist'].tokens)

console.log('ok: skin wrapper, selection, identity separation, contrast (2 skins x 2 modes) and unload are consistent')
