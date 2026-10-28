/*
 * Replacement SidebarMark for the existing white-label factory.
 * Requires existing React, ReactDOM, hooks, useStore/usePopover and UI helpers.
 * The native sidebar's brand button remains untouched and is never clicked.
 */
function SidebarMark({ size }) {
  const [snap, store] = useStore()
  const pop = usePopover(PICKER_PLACEMENT)
  const panelId = usePopoverId('neko-avatar-picker')
  const px = Math.max(24, size ?? 24)
  const { state, pending, notice } = snap
  const current = state.avatar.builtinId
  const locked = Boolean(pending.avatar || pending.upload)
  const anchorRef = useRef(null)
  const [dock, setDock] = useState({ kind: 'probe', host: null, rect: null })

  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor || !document.body || typeof anchor.closest !== 'function') return undefined
    let stopped = false, frame = 0, host = null
    const supportsPortal = ReactDOM && typeof ReactDOM.createPortal === 'function'
    const seen = new Set()
    const requestFrame = window.requestAnimationFrame || ((fn) => setTimeout(fn, 0))
    const cancelFrame = window.cancelAnimationFrame || clearTimeout
    const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule)
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    function schedule() { if (!stopped && !frame) frame = requestFrame(sync) }
    function publish(kind, nextHost, rect) {
      setDock((prev) => {
        const sameRect = prev.rect === rect || (prev.rect && rect &&
          prev.rect.left === rect.left && prev.rect.top === rect.top &&
          prev.rect.width === rect.width && prev.rect.height === rect.height &&
          prev.rect.right === rect.right && prev.rect.bottom === rect.bottom)
        return prev.kind === kind && prev.host === nextHost && sameRect ? prev : { kind, host: nextHost, rect }
      })
    }
    function watchAncestors() {
      let node = anchor
      while (node && node !== document.documentElement) {
        if (!seen.has(node)) {
          seen.add(node)
          if (mutation) mutation.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden'], childList: true })
          if (resize && node !== document.body) resize.observe(node)
        }
        node = node.parentElement
      }
    }
    function removeHost() {
      if (host) host.remove()
      host = null
    }
    function sync() {
      frame = 0
      if (stopped || !anchor.isConnected) return
      watchAncestors()
      const outerButton = anchor.closest('button')
      if (!outerButton) {
        removeHost()
        publish('direct', null, null)
        return
      }
      if (!supportsPortal) {
        // Unknown renderer: leave a passive image in the native brand button.
        // Do not intercept, rewrite, click or disable that native button.
        removeHost()
        pop.close(false)
        publish('fallback', null, null)
        return
      }
      if (!host) {
        host = document.createElement('div')
        host.className = 'neko-avatar-portal'
        host.setAttribute('data-neko-avatar-portal', '')
        document.body.appendChild(host)
      }
      const r = anchor.getBoundingClientRect()
      const viewportWidth = window.innerWidth || 1100
      const viewportHeight = window.innerHeight || 780
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
        r.top < viewportHeight && r.left < viewportWidth &&
        (typeof getComputedStyle !== 'function' || getComputedStyle(anchor).visibility !== 'hidden')
      host.style.visibility = visible ? 'visible' : 'hidden'
      if (!visible) {
        pop.close(false)
        publish('portal', host, null)
        return
      }
      const rect = { left:r.left, top:r.top, width:r.width, height:r.height, right:r.right, bottom:r.bottom }
      Object.assign(host.style, { left:`${rect.left}px`, top:`${rect.top}px`, width:`${rect.width}px`, height:`${rect.height}px` })
      publish('portal', host, rect)
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    // Ancestor changes can reparent a still-mounted slot without changing size.
    if (mutation) mutation.observe(document.body, { childList: true })
    sync()
    return () => {
      stopped = true
      if (frame) cancelFrame(frame)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (mutation) mutation.disconnect()
      if (resize) resize.disconnect()
      removeHost()
    }
  }, [px])

  const tiles = AVATARS.map((a) => h(PickerTile, {
    key:a.id, id:a.id, name:a.name, src:builtinSrc(a.id),
    selected:current === a.id, busy:pending.avatar === a.id, disabled:locked,
    onPick:(id) => store.setAvatar(id),
  }))
  if (state.avatar.customDataUrl) tiles.push(h(PickerTile, {
    key:'custom', id:'custom', name:CUSTOM_NAME, src:state.avatar.customDataUrl,
    selected:current === 'custom', busy:pending.avatar === 'custom', disabled:locked,
    onPick:(id) => store.setAvatar(id),
  }))
  const trigger = h('button', {
    type:'button', className:'neko-avatar-btn', ref:pop.triggerRef,
    'aria-haspopup':'dialog', 'aria-expanded':pop.open ? 'true' : 'false',
    'aria-controls':pop.open ? panelId : undefined,
    'aria-label':`头像：${avatarName(current)}，点击切换主题`, title:'更换头像与主题',
    // Portal events still bubble through their React owners. Keep every native
    // brand-button handler outside this independent avatar interaction.
    onPointerDown:stop, onKeyDown:stop, onKeyUp:stop, onDoubleClick:stop,
    onClick:(event) => {
      event.stopPropagation()
      if (pop.open) pop.close(false)
      else { store.clearNotice('avatar'); pop.setOpen(true) }
    },
  }, h(AvatarImg, { src:selectedSrc(state), size:px, className:'neko-avatar--mark' }))
  let pickerPopover = pop
  if (dock.kind === 'portal' && dock.rect && pop.open) {
    const vw = window.innerWidth || 1100, vh = window.innerHeight || 780
    pickerPopover = { ...pop, pos:{
      left:Math.max(8, Math.min(dock.rect.left, vw - PICKER_WIDTH - 8)),
      top:Math.min(dock.rect.bottom + 6, vh - 48),
    } }
  }
  const panel = h(Panel, {
    id:panelId, label:'头像与主题', className:'neko-picker', popover:pickerPopover, width:PICKER_WIDTH,
  },
    h('div', {className:'neko-pop__head'},
      h('span', {className:'neko-pop__title'}, '头像与主题'),
      h('span', {className:'neko-pop__hint'}, '角色头像与配色同步切换，模型和记忆保持不变')),
    h('div', {className:'neko-picker__grid', role:'group', 'aria-label':'内置头像'}, ...tiles),
    h('button', {
      type:'button', className:'neko-btn neko-picker__upload', disabled:locked,
      'aria-busy':pending.upload ? 'true' : undefined, onClick:() => store.uploadAvatar(),
    }, pending.upload ? '等待选择图片…' : '上传图片…'),
    snap.preview ? h('p', {className:'neko-pop__hint neko-pop__foot'}, '预览模式：选择不会保存') : null,
    h(Notice, {notice, scope:'avatar'}))
  const direct = dock.kind === 'direct'
  return h(React.Fragment, null,
    h('span', {
      ref:anchorRef, className:'neko-avatar-anchor', 'data-neko-avatar-anchor':'',
      'aria-hidden':direct ? undefined : 'true',
      style:{width:`${px}px`, height:`${px}px`},
    }, direct ? trigger : h(AvatarImg, {
      src:selectedSrc(state), size:px,
      className:dock.kind === 'portal' ? 'neko-avatar--placeholder' : 'neko-avatar--mark',
    })),
    dock.kind === 'portal' && dock.host
      ? ReactDOM.createPortal(h(React.Fragment, null, trigger, panel), dock.host)
      : direct ? panel : null)
}
