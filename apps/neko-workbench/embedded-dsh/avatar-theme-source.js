// @neko-avatar-theme:start
/*
 * Inline this source inside the white-label bundle factory, before apply().
 * Install with ctx.effect(() => installAvatarTheme(), 'neko-brand: avatar theme').
 * It only reads the existing preload bridge and changes its own color layer.
 */
const NekoAvatarTheme = (() => {
  'use strict'
  const STYLE_ID = '@bigfish/dsh-client-ui-white-label:avatar-theme'
  const ATTR = 'data-neko-avatar-theme'
  const HEX = /^#[0-9a-f]{6}$/i
  const TOKEN_KEYS = Object.freeze({
    brand: '--dsw-alias-brand-primary', brandText: '--dsw-alias-brand-text', link: '--dsw-alias-link',
    btn: '--dsw-alias-button-primary-fill', btnHover: '--dsw-alias-button-primary-hover', onBtn: '--dsw-alias-label-primary-inverted',
    base: '--dsw-alias-bg-base', l1: '--dsw-alias-bg-layer-1', l2: '--dsw-alias-bg-layer-2', overlay: '--dsw-alias-bg-overlay',
    sidebar: '--dsw-specific-sidebar-fill', b1: '--dsw-alias-border-l1', b2: '--dsw-alias-border-l2',
    ink: '--dsw-alias-label-primary', ink2: '--dsw-alias-label-secondary',
    habitat: '--neko-account-habitat-bg', accent: '--neko-avatar-accent', focus: '--neko-avatar-focus',
  })
  const freeze = (value) => {
    for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child)
    return Object.freeze(value)
  }
  const rgb = (hex) => hex.slice(1).match(/../g).map((v) => parseInt(v, 16))
  const hex = (values) => '#' + values.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase()
  const mix = (a, b, amount) => hex(rgb(a).map((v, i) => v * (1 - amount) + rgb(b)[i] * amount))
  const luminance = (color) => rgb(color).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((v, x, i) => v + x * [.2126, .7152, .0722][i], 0)
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
  function hsl(h, s, l) {
    const chroma = (1 - Math.abs(2 * l - 1)) * s
    const hp = (((h % 360) + 360) % 360) / 60
    const x = chroma * (1 - Math.abs(hp % 2 - 1))
    const c = hp < 1 ? [chroma, x, 0] : hp < 2 ? [x, chroma, 0] : hp < 3 ? [0, chroma, x] : hp < 4 ? [0, x, chroma] : hp < 5 ? [x, 0, chroma] : [chroma, 0, x]
    return hex(c.map((v) => (v + l - chroma / 2) * 255))
  }
  function readableAccent(candidate, backgrounds, mode) {
    let value = candidate
    for (let i = 0; i < 30 && backgrounds.some((bg) => contrast(value, bg) < 4.6); i++) value = mix(value, mode === 'dark' ? '#FFFFFF' : '#000000', .075)
    return value
  }
  function modePalette(input, mode) {
    const backgrounds = ['base', 'l1', 'l2', 'overlay', 'sidebar', 'habitat'].map((key) => input[key])
    const accent = readableAccent(input.brand, backgrounds, mode)
    const btn = mode === 'dark' ? accent : readableAccent(accent, ['#FFFFFF'], 'light')
    const onBtn = mode === 'dark' ? '#171923' : '#FFFFFF'
    return {
      ...input, brand: accent, brandText: accent, link: accent, accent, focus: accent,
      btn, btnHover: mix(btn, mode === 'dark' ? '#FFFFFF' : '#000000', .12), onBtn,
    }
  }
  function builtin(light, dark) { return { light: modePalette(light, 'light'), dark: modePalette(dark, 'dark') } }
  const PALETTES = freeze({
    yui: builtin(
      {base:'#EEF2FB',l1:'#FDFEFF',l2:'#E5EAF7',overlay:'#FFFFFF',sidebar:'#E5EAF7',habitat:'#DCE4F4',brand:'#3F5F9E',b1:'#CDD6EA',b2:'#B1BEDA',ink:'#1F293D',ink2:'#4B5A73'},
      {base:'#171D2C',l1:'#1E2738',l2:'#263247',overlay:'#2C3A51',sidebar:'#141A28',habitat:'#293A55',brand:'#B4C7F2',b1:'#35445C',b2:'#4B5C78',ink:'#F0F3FA',ink2:'#C0CADE'}),
    devcat: builtin(
      {base:'#FAF4EA',l1:'#FFFDFA',l2:'#F2E7D6',overlay:'#FFFFFF',sidebar:'#F2E7D6',habitat:'#EBDDC8',brand:'#8A5D2E',b1:'#E0CDB4',b2:'#CBB393',ink:'#39291F',ink2:'#66513E'},
      {base:'#241E18',l1:'#2C251D',l2:'#352D23',overlay:'#40362A',sidebar:'#201A15',habitat:'#3C3023',brand:'#E8C495',b1:'#51432F',b2:'#6A583E',ink:'#FAF1E5',ink2:'#D2C1A9'}),
    bigfish: builtin(
      {base:'#EAF4F8',l1:'#FBFEFF',l2:'#DDEDF4',overlay:'#FFFFFF',sidebar:'#DDEDF4',habitat:'#D0E5EF',brand:'#246B91',b1:'#C4DBE6',b2:'#A6C5D4',ink:'#17303D',ink2:'#456171'},
      {base:'#12232D',l1:'#192D39',l2:'#203846',overlay:'#284351',sidebar:'#0F1E28',habitat:'#203B4A',brand:'#9BD2E9',b1:'#304C5C',b2:'#446577',ink:'#E8F5FA',ink2:'#B3CBD8'}),
    claude: builtin(
      {base:'#FFF1EA',l1:'#FFFDFA',l2:'#F8E2D5',overlay:'#FFFFFF',sidebar:'#F8E2D5',habitat:'#F0D5C4',brand:'#99542F',b1:'#E7C7B4',b2:'#D1A98F',ink:'#3D2921',ink2:'#6E5141'},
      {base:'#2A1D18',l1:'#32241E',l2:'#3C2D25',overlay:'#49362B',sidebar:'#241914',habitat:'#422D22',brand:'#F0BD9C',b1:'#5B4132',b2:'#755540',ink:'#FFF0E6',ink2:'#DCC2B0'}),
    gemini: builtin(
      {base:'#F5EFFB',l1:'#FEFCFF',l2:'#EBE1F5',overlay:'#FFFFFF',sidebar:'#EBE1F5',habitat:'#E1D3EF',brand:'#705090',b1:'#D6C5E7',b2:'#BDA6D4',ink:'#30233E',ink2:'#60516F'},
      {base:'#211A2D',l1:'#2A2238',l2:'#352A44',overlay:'#403252',sidebar:'#1C1627',habitat:'#38294A',brand:'#D2B8EE',b1:'#503C64',b2:'#6B5280',ink:'#F6EFFC',ink2:'#CEC0DF'}),
  })
  function customPalette(hue = 220) {
    const light = {
      base:hsl(hue,.28,.966), l1:hsl(hue,.25,.995), l2:hsl(hue,.26,.928), overlay:'#FFFFFF',
      sidebar:hsl(hue,.26,.928), habitat:hsl(hue,.27,.88), brand:hsl(hue,.44,.32),
      b1:hsl(hue,.20,.80), b2:hsl(hue,.20,.70), ink:'#242738', ink2:'#4D5468',
    }
    const dark = {
      base:hsl(hue,.24,.12),l1:hsl(hue,.23,.155),l2:hsl(hue,.23,.19),overlay:hsl(hue,.22,.235),
      sidebar:hsl(hue,.24,.10),habitat:hsl(hue,.23,.205),brand:hsl(hue,.48,.79),
      b1:hsl(hue,.22,.29),b2:hsl(hue,.22,.38),ink:'#F3F2FA',ink2:'#C7C5D5',
    }
    return freeze(builtin(light,dark))
  }
  function tokensFor(palette, mode) {
    const values = palette[mode]
    const tokens = {}
    for (const [key,name] of Object.entries(TOKEN_KEYS)) {
      if (!HEX.test(values[key])) throw new Error('Invalid avatar color')
      tokens[name] = values[key]
    }
    // Existing native interactive surfaces continue to use real alias tokens.
    tokens['--dsw-alias-interactive-bg-hover'] = values.l2
    tokens['--dsw-alias-interactive-bg-active'] = values.habitat
    tokens['--dsw-alias-state-business-primary'] = values.brand
    tokens['--dsw-alias-state-business-tertiary'] = values.l2
    tokens['--dsw-alias-bg-module-platform'] = values.sidebar
    return tokens
  }
  function cssFor(palette) {
    const declarations = (mode) => Object.entries(tokensFor(palette, mode)).map(([name,value]) => `${name}:${value} !important;`).join('')
    // DSH's theme owner places data-ds-dark-theme on body for explicit dark and
    // follow-system dark alike. Observe it through CSS; never change preference.
    return `body[${ATTR}]{${declarations('light')}}\nbody[${ATTR}][data-ds-dark-theme]{${declarations('dark')}}`
  }
  function dominantHue(data) {
    const bins = Array.from({length:24},() => ({weight:0,x:0,y:0}))
    for (let i=0; i<data.length; i+=4) {
      if (data[i+3] < 96) continue
      const r=data[i]/255,g=data[i+1]/255,b=data[i+2]/255
      const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min,l=(max+min)/2
      if (d < .10 || l < .12 || l > .90) continue
      let hue = max===r ? ((g-b)/d)%6 : max===g ? (b-r)/d+2 : (r-g)/d+4
      hue=(hue*60+360)%360
      const weight=d*(data[i+3]/255)*(1-Math.abs(l-.5))
      const bin=bins[Math.floor(hue/15)%24],angle=hue*Math.PI/180
      bin.weight+=weight;bin.x+=Math.cos(angle)*weight;bin.y+=Math.sin(angle)*weight
    }
    const best=bins.reduce((a,b)=>b.weight>a.weight?b:a,bins[0])
    return best.weight ? (Math.atan2(best.y,best.x)*180/Math.PI+360)%360 : 220
  }
  function install(options = {}) {
    const win=options.window || (typeof window!=='undefined' ? window : null)
    const doc=options.document || (typeof document!=='undefined' ? document : null)
    const bridge=options.bridge || win?.nekoWorkbench
    if (!doc?.body || !doc?.head || doc.getElementById(STYLE_ID)) return () => {}
    const body=doc.body, prior=body.getAttribute(ATTR)
    const style=doc.createElement('style');style.id=STYLE_ID;doc.head.appendChild(style)
    let stopped=false,revision=0,lastId=null,lastData=null,unsubscribe=null,pendingImage=null,pushRevision=0
    const paint=(id,palette) => {
      if(stopped)return
      style.textContent=cssFor(palette)
      body.setAttribute(ATTR,id)
    }
    const apply=(state) => {
      if(stopped)return
      const avatar=state?.avatar || {},known=Object.hasOwn(PALETTES,avatar.builtinId)
      const id=avatar.builtinId==='claude' ? 'bigfish' : known ? avatar.builtinId : avatar.builtinId==='custom' ? 'custom' : 'yui'
      const data=id==='custom' && typeof avatar.customDataUrl==='string' ? avatar.customDataUrl : ''
      if(id===lastId && data===lastData)return
      lastId=id;lastData=data
      const ticket=++revision
      if(pendingImage){pendingImage.onload=null;pendingImage.onerror=null;pendingImage=null}
      if(id!=='custom'){paint(id,PALETTES[id]);return}
      paint('custom',customPalette())
      // Raster data URLs only. No HTTP/file requests, SVG execution or logging.
      if(data.length>1500000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(data) || typeof win?.Image!=='function')return
      const image=new win.Image();pendingImage=image
      image.onload=()=>{
        if(stopped || revision!==ticket)return
        try{
          const canvas=doc.createElement('canvas');canvas.width=canvas.height=48
          const ctx=canvas.getContext('2d',{willReadFrequently:true})
          if(!ctx || !image.naturalWidth || !image.naturalHeight)return
          ctx.drawImage(image,0,0,48,48)
          const hue=dominantHue(ctx.getImageData(0,0,48,48).data)
          if(!stopped && revision===ticket)paint('custom',customPalette(hue))
        }catch{}finally{if(pendingImage===image)pendingImage=null;image.onload=null;image.onerror=null}
      }
      image.onerror=()=>{if(pendingImage===image)pendingImage=null;image.onload=null;image.onerror=null}
      image.src=data
    }
    apply({avatar:{builtinId:'yui'}})
    if(bridge && typeof bridge.getState==='function' && typeof bridge.subscribe==='function') {
      try{unsubscribe=bridge.subscribe((state)=>{pushRevision++;apply(state)})}catch{}
      const initialRevision=pushRevision
      try{Promise.resolve(bridge.getState()).then((state)=>{if(!stopped && pushRevision===initialRevision)apply(state)},()=>{})}catch{}
    }
    return () => {
      if(stopped)return
      stopped=true;revision++
      if(typeof unsubscribe==='function')try{unsubscribe()}catch{}
      if(pendingImage){pendingImage.onload=null;pendingImage.onerror=null;pendingImage=null}
      style.remove()
      if(body.getAttribute(ATTR)===lastId){if(prior===null)body.removeAttribute(ATTR);else body.setAttribute(ATTR,prior)}
    }
  }
  return freeze({PALETTES,TOKEN_KEYS,customPalette,tokensFor,cssFor,contrast,dominantHue,install})
})()
function installAvatarTheme(options) { return NekoAvatarTheme.install(options) }

// @neko-avatar-theme:end
