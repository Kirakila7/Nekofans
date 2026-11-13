const fs = require('node:fs'),path = require('node:path'),vm = require('node:vm'),assert = require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'avatar-theme-source.js'),'utf8');
const sandbox={};vm.runInNewContext(source+'\nglobalThis.api=NekoAvatarTheme;',sandbox);const api=sandbox.api;
const modes=['light','dark'],text=['brandText','link','ink','ink2'],surfaces=['base','l1','l2','overlay','sidebar','habitat'];
let pairs=0;
for(const [id,p] of [...Object.entries(api.PALETTES),...Array.from({length:72},(_,i)=>['custom-'+i*5,api.customPalette(i*5)])])for(const mode of modes){
 const c=p[mode];
 for(const fg of text)for(const bg of surfaces){const r=api.contrast(c[fg],c[bg]);assert(r>=4.5,`${id}/${mode} ${fg}/${bg}: ${r.toFixed(2)}`);pairs++;}
 for(const fill of ['btn','btnHover'])assert(api.contrast(c.onBtn,c[fill])>=4.5,`${id}/${mode} button text contrast`);
 assert(api.contrast(c.focus,c.base)>=3,`${id}/${mode} focus visible on base`);
}
assert.deepEqual(Object.keys(api.PALETTES),['yui','devcat','bigfish','claude','gemini']);
assert.equal(api.dominantHue(new Uint8ClampedArray([255,0,0,255,255,255,255,255,0,0,0,0])),0);
assert.equal(api.dominantHue(new Uint8ClampedArray([255,255,255,255,0,0,0,255])),220);
assert(Math.abs(api.dominantHue(new Uint8ClampedArray([0,0,255,255]))-240)<.01);
for(const p of Object.values(api.PALETTES)){
 const css=api.cssFor(p);assert(css.includes('body[data-neko-avatar-theme][data-ds-dark-theme]'));
 assert(!/font|width|height|display|content:|url\(/.test(css),'color layer must not change layout or load assets');
 assert(!/localStorage|token|credential/.test(css));
}
function harness(){
 const attrs=new Map([['data-neko-avatar-theme','before']]);const nodes=[];let callback,disposals=0,resolveInitial;
 const body={getAttribute:k=>attrs.has(k)?attrs.get(k):null,setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k)};
 const doc={body,head:{appendChild:n=>nodes.push(n)},getElementById:id=>nodes.find(n=>n.id===id),createElement:tag=>({tag,textContent:'',remove(){const i=nodes.indexOf(this);if(i>=0)nodes.splice(i,1)}})};
 const bridge={getState:()=>new Promise(r=>resolveInitial=r),subscribe:cb=>{callback=cb;return()=>{disposals++;callback=null}}};
 const cleanup=api.install({document:doc,window:{},bridge});
 return{attrs,nodes,cleanup,push:s=>callback?.(s),resolve:s=>resolveInitial(s),get disposals(){return disposals}};
}
(async()=>{
 const h=harness();assert.equal(h.attrs.get('data-neko-avatar-theme'),'yui');assert.equal(h.nodes.length,1);
 h.push({avatar:{builtinId:'claude'}});assert.equal(h.attrs.get('data-neko-avatar-theme'),'bigfish','retired claude avatar falls back to bigfish');assert(h.nodes[0].textContent.includes(api.PALETTES.bigfish.light.base));
 h.resolve({avatar:{builtinId:'bigfish'}});await Promise.resolve();await Promise.resolve();assert.equal(h.attrs.get('data-neko-avatar-theme'),'bigfish','stale initial read must not replace a newer push');
 h.push({avatar:{builtinId:'custom',customDataUrl:'https://example.invalid/avatar.png'}});assert.equal(h.attrs.get('data-neko-avatar-theme'),'custom');assert(h.nodes[0].textContent.includes(api.customPalette().light.base));
 h.cleanup();h.cleanup();assert.equal(h.disposals,1);assert.equal(h.nodes.length,0);assert.equal(h.attrs.get('data-neko-avatar-theme'),'before');
 h.push({avatar:{builtinId:'gemini'}});assert.equal(h.nodes.length,0);
 const second=harness();second.attrs.set('data-neko-avatar-theme','another-owner');second.cleanup();assert.equal(second.attrs.get('data-neko-avatar-theme'),'another-owner','do not delete another owner attribute');
 console.log(`PASS 5 builtin and 72 custom hue palettes, ${pairs} text/surface contrast pairs; read-only bridge updates, stale-read protection and full cleanup`);
})().catch(e=>{console.error(e);process.exitCode=1});
