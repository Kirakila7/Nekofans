/**
 * N.E.K.O. 工作台 · 皮肤层 — client bundle (hand-written, no build step).
 *
 * A skin is ONLY: one palette (theme alias tokens, light + dark) and an
 * optional chip in the product strip (label + monochrome badge). Product
 * identity (name, cat-head mark, hero, title, favicon) lives in
 * @bigfish/dsh-client-ui-white-label and cannot be changed from here.
 *
 * Skins:
 *   neko-mist  默认：N.E.K.O. 雾蓝，无皮肤徽标
 *   bigfish    大肥鱼：海雾蓝调色板 + 猫耳鲸鱼徽标（仅出现在底部条皮肤位）
 *
 * Selection, first known value wins, unknown values fall back to DEFAULT_SKIN:
 *   1. cookie `neko_skin`   set by the pet main process from PET_DSH_SKIN.
 *      Cookies are scoped by host, not port, so the choice survives the
 *      random `--port 0` DSH picks on every launch.
 *   2. localStorage `neko:skin`  handy for a fixed-port browser session.
 *
 * Reversible through ctx.effect: token layer and <style> removed on unload.
 */
window.__ModuleLoader__.load({
  id: '@bigfish/dsh-client-ui-skin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const PKG = '@bigfish/dsh-client-ui-skin'
    const STORAGE_KEY = 'neko:skin'
    const COOKIE_NAME = 'neko_skin'
    const DEFAULT_SKIN = 'neko-mist'

    /**
     * Tokens a skin may set. All verified in DSH 0.2.1-rc.3. Anything else in
     * a skin definition is rejected by validateSkin().
     *
     * Contrast contract (enforced by scripts/smoke.mjs, WCAG AA):
     *   brand-text, link, label-*  >= 4.5:1 on every bg-* / sidebar surface
     *   label-primary-inverted     >= 4.5:1 on button-primary-fill and -hover
     * brand-primary is the mark / accent fill and is kept separate from text.
     */
    const ALLOWED_TOKENS = Object.freeze([
      '--dsw-alias-brand-primary',
      '--dsw-alias-brand-text',
      '--dsw-alias-link',
      '--dsw-alias-button-primary-fill',
      '--dsw-alias-button-primary-hover',
      '--dsw-alias-label-primary-inverted',
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-overlay',
      '--dsw-specific-sidebar-fill',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
    ])

    /** Build a token map from a compact { light, dark } palette. */
    function palette(light, dark) {
      const keys = ['brand', 'brandText', 'link', 'btn', 'btnHover', 'onBtn', 'base', 'l1', 'l2', 'overlay', 'sidebar', 'b1', 'b2', 'ink', 'ink2']
      const tokens = {}
      keys.forEach((key, i) => {
        tokens[ALLOWED_TOKENS[i]] = { light: light[key], dark: dark[key] }
      })
      return tokens
    }

    /**
     * Cat-eared whale silhouette, 24x24, used as a CSS mask (alpha only), so it
     * takes the skin's brand-primary color. Belongs to the bigfish skin only.
     */
    const BIGFISH_BADGE =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill-rule="evenodd" d="' +
      'M5.4 13.3C4.2 11.2 2.7 10 1.2 10.1c.2 1.6 1 2.6 2.1 3.2-1.1.6-1.8 1.7-1.9 3.1 1.5-.1 2.9-1.2 4-3.1Z' +
      'M4 13.4C5.8 9.7 9.4 7.7 13.8 7.7c4.4 0 7.5 2.5 7.5 5.9s-2.9 5.4-7 5.4c-4.4 0-8-2.1-10.3-5.6Z' +
      'M19.2 12.3a.85.85 0 1 0-1.7 0 .85.85 0 0 0 1.7 0Z"/>' +
      '<path d="M12.4 8.6 13.1 4l3.2 3.9ZM17 7.8 20 4.6l.3 4.6Z"/></svg>'

    const SKINS = Object.freeze({
      'neko-mist': Object.freeze({
        label: 'N.E.K.O. 雾蓝',
        tokens: palette(
          { brand: '#2C66A6', brandText: '#2A609E', link: '#2A609E', btn: '#2C66A6', btnHover: '#24578F', onBtn: '#FFFFFF',
            base: '#EDF3F8', l1: '#FCFDFF', l2: '#E4ECF4', overlay: '#FFFFFF', sidebar: '#E5EDF5',
            b1: '#D3DEE9', b2: '#B8C8D8', ink: '#17283A', ink2: '#4C5F73' },
          { brand: '#8CBDEB', brandText: '#8CBDEB', link: '#9CC7F0', btn: '#8CBDEB', btnHover: '#A9CFF2', onBtn: '#0F1C2B',
            base: '#131C27', l1: '#19232F', l2: '#212D3B', overlay: '#273545', sidebar: '#111A24',
            b1: '#2D3B4C', b2: '#3C4D61', ink: '#E3ECF4', ink2: '#9DB0C3' },
        ),
        chip: null,
      }),
      bigfish: Object.freeze({
        label: '大肥鱼',
        tokens: palette(
          { brand: '#1F6E9C', brandText: '#1D6895', link: '#1D6895', btn: '#1F6E9C', btnHover: '#195B81', onBtn: '#FFFFFF',
            base: '#EAF3F6', l1: '#FBFEFF', l2: '#DFECF1', overlay: '#FFFFFF', sidebar: '#E0EDF2',
            b1: '#CDE0E8', b2: '#AFCAD6', ink: '#132A36', ink2: '#47616E' },
          { brand: '#7CC4E4', brandText: '#7CC4E4', link: '#8FCDEA', btn: '#7CC4E4', btnHover: '#9AD3EC', onBtn: '#0B1E28',
            base: '#10202A', l1: '#152833', l2: '#1C3340', overlay: '#223B49', sidebar: '#0D1B24',
            b1: '#29424F', b2: '#385463', ink: '#E0EEF3', ink2: '#98B4C1' },
        ),
        chip: Object.freeze({ label: '大肥鱼皮肤', badgeSvg: BIGFISH_BADGE }),
      }),
    })

    /** A skin may carry a label, palette tokens and a chip. Nothing else. */
    function validateSkin(id, skin) {
      const extra = Object.keys(skin).filter((key) => !['label', 'tokens', 'chip'].includes(key))
      if (extra.length) throw new Error(`skin ${id}: unsupported keys ${extra.join(', ')}`)
      for (const [name, value] of Object.entries(skin.tokens)) {
        if (!ALLOWED_TOKENS.includes(name)) throw new Error(`skin ${id}: token ${name} not allowed`)
        if (typeof value?.light !== 'string' || typeof value?.dark !== 'string') {
          throw new Error(`skin ${id}: ${name} needs light and dark`)
        }
      }
      return skin
    }

    function isKnownSkin(id) {
      return typeof id === 'string' && Object.hasOwn(SKINS, id)
    }

    function readCookie() {
      try {
        for (const part of String(document.cookie || '').split(';')) {
          const [key, ...rest] = part.trim().split('=')
          if (key === COOKIE_NAME) return decodeURIComponent(rest.join('='))
        }
      } catch {}
      return null
    }

    function readLocal() {
      try {
        return window.localStorage?.getItem(STORAGE_KEY) ?? null
      } catch {
        return null
      }
    }

    function resolveSkinId(...candidates) {
      return candidates.find(isKnownSkin) ?? DEFAULT_SKIN
    }

    /** CSS string literal for `content:`; escapes quotes and backslashes. */
    function cssString(text) {
      return '"' + String(text).replace(/[\\"]/g, '\\$&').replace(/\n/g, ' ') + '"'
    }

    /** Variables the product strip reads to show (or hide) the skin chip. */
    function chipCss(skin) {
      if (!skin.chip) return ':root { --neko-skin-display: none; }'
      const badge = 'url("data:image/svg+xml,' + encodeURIComponent(skin.chip.badgeSvg) + '")'
      return (
        ':root {' +
        ' --neko-skin-display: inline-flex;' +
        ` --neko-skin-label: ${cssString(skin.chip.label)};` +
        ` --neko-skin-badge: ${badge};` +
        ' --neko-skin-badge-size: 12px;' +
        ' }'
      )
    }

    const STYLE_ID = `${PKG}:style`

    function installFeedbackRemoval(doc = document) {
      if (!doc.documentElement || typeof MutationObserver !== 'function') return () => {}
      const marked = new Set()
      const normalize = node => String(node.querySelector('._itemLabel_4ub78_190')?.textContent || node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, '').toLowerCase()
      const sync = () => {
        const selected = new Set()
        for (const menu of doc.querySelectorAll('[data-menu-material][role="menu"], [data-menu-material]._list_4ub78_7')) {
          const items = Array.from(menu.querySelectorAll('[role="menuitem"]'))
          const labels = items.map(normalize)
          if (!labels.some(s => /^(设置|settings)$/.test(s)) ||
              !labels.some(s => /^(登录|退出|退出登录|登出|signin|signout|logout)$/.test(s))) continue
          items.forEach((item, i) => {
            if (/^(联系我们|意见反馈|反馈意见|contactus|contact|feedback|sendfeedback)$/.test(labels[i])) selected.add(item)
          })
        }
        for (const node of marked) if (!selected.has(node)) { node.removeAttribute('data-neko-hide-feedback'); marked.delete(node) }
        for (const node of selected) if (!marked.has(node)) { node.setAttribute('data-neko-hide-feedback', ''); marked.add(node) }
      }
      const observer = new MutationObserver(sync)
      observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true })
      sync()
      return () => { observer.disconnect(); for (const node of marked) node.removeAttribute('data-neko-hide-feedback'); marked.clear() }
    }

    function installGetStartedDismissal(doc = document) {
      if (!doc.documentElement || typeof MutationObserver !== 'function') return () => {}
      const dismiss = () => {
        for (const dialog of doc.querySelectorAll('.J8V0KW_dialog')) {
          const title = dialog.querySelector('.J8V0KW_title')?.textContent?.trim()
          const description = dialog.querySelector('.J8V0KW_description')?.textContent || ''
          if ((title === '开始使用' && description.includes('登录 DeepSeek 账号')) ||
              (title === 'Get started' && description.includes('Sign in to your DeepSeek account'))) {
            dialog.querySelector('.J8V0KW_close')?.click()
          }
        }
      }
      const observer = new MutationObserver(dismiss)
      observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true })
      dismiss()
      return () => observer.disconnect()
    }

    // Hide the Session Log upload preference without changing the stored setting.
    function installSessionLogRowRemoval(doc = document) {
      if (!doc.documentElement || !doc.head || typeof MutationObserver !== 'function') return () => {};
      const marked = new Set();
      const style = doc.createElement('style');
      style.textContent = '[data-neko-hide-session-log-row] { display: none !important; }';
      doc.head.appendChild(style);
      const titles = new Set([
        '在使用官方模型 API 时上传 Session Log',
        'Upload Session Log when using the official model API',
      ]);
      function sync() {
        const selected = new Set();
        for (const heading of doc.querySelectorAll('div')) {
          if (heading.children.length || !titles.has(heading.textContent.trim())) continue;
          const row = heading.parentElement?.parentElement;
          if (row?.querySelector('[role="switch"], input[type="checkbox"]')) selected.add(row);
        }
        for (const node of marked) if (!selected.has(node)) { node.removeAttribute('data-neko-hide-session-log-row'); marked.delete(node); }
        for (const node of selected) if (!marked.has(node)) { node.setAttribute('data-neko-hide-session-log-row', ''); marked.add(node); }
      }
      const observer = new MutationObserver(sync);
      observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
      sync();
      return () => {
        observer.disconnect();
        for (const node of marked) node.removeAttribute('data-neko-hide-session-log-row');
        style.remove();
      };
    }

    function installStyles(css) {
      document.getElementById(STYLE_ID)?.remove()
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = css + '\n[data-neko-hide-feedback]{display:none!important}'
      document.head.appendChild(element)
      const disposeFeedback = installFeedbackRemoval()
      const disposeGetStarted = installGetStartedDismissal()
      const disposeSessionLog = installSessionLogRowRemoval()
      return () => { disposeSessionLog(); disposeGetStarted(); disposeFeedback(); element.remove() }
    }

    function apply(ctx) {
      const id = resolveSkinId(readCookie(), readLocal())
      const skin = validateSkin(id, SKINS[id])
      ctx.effect(() => installStyles(chipCss(skin)), `neko-skin: chip (${id})`)
      ctx.effect(() => ctx.theme.overrideTokens(PKG, skin.tokens), `neko-skin: tokens (${id})`)
    }

    exports.apply = apply
    exports.inject = ['theme']
    // Exposed for tests/tools only; not used by the loader.
    exports.SKINS = SKINS
    exports.DEFAULT_SKIN = DEFAULT_SKIN
    exports.STORAGE_KEY = STORAGE_KEY
    exports.COOKIE_NAME = COOKIE_NAME
    exports.ALLOWED_TOKENS = ALLOWED_TOKENS
    exports.validateSkin = validateSkin
    exports.resolveSkinId = resolveSkinId
    exports.installFeedbackRemoval = installFeedbackRemoval
    return module.exports
  },
})

