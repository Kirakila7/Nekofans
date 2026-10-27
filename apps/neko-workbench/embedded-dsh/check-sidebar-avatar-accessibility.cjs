// Offline structural fixture: no Electron, no native buttons, no session API.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const code=fs.readFileSync(path.join(__dirname,'sidebar-avatar-accessibility-patch.js'),'utf8');
function fixture({nested=true,portals=true}={}){
  let cursor=0,refCursor=0,effectCursor=0,tree;const states=[],refs=[],effects=[],queued=[],hosts=[],listeners=new Map(),frames=[];
  let outerClicks=0,sets=0,uploads=0,geometry={left:16,top:26,width:24,height:24,right:40,bottom:50};
  const body={appendChild(host){hosts.push(host);host.isConnected=true;host.parentElement=body}};
  const anchor={isConnected:true,parentElement:body,closest:()=>nested?{tag:'native-new-chat'}:null,getBoundingClientRect:()=>geometry};
  const pop={open:false,pos:{left:16,top:56},triggerRef:{current:null},panelRef:{current:null},setOpen:v=>pop.open=v,close:()=>pop.open=false};
  const store={setAvatar:()=>sets++,uploadAvatar:()=>uploads++,clearNotice:()=>{}};
  const snapshot={state:{avatar:{builtinId:'yui',customDataUrl:'data:image/png;base64,fixture'}},pending:{},notice:null,preview:false};
  const h=(tag,props,...children)=>({tag,props:props||{},children});
  const observers=[];
  class Observer{constructor(cb){this.cb=cb;this.disconnected=false;observers.push(this)}observe(){}disconnect(){this.disconnected=true}}
  const sandbox={
    React:{Fragment:'fragment'},ReactDOM:portals?{createPortal:(children,host)=>({portal:true,children,host})}:null,
    h,useRef:()=>refs[refCursor++]|| (refs[refCursor-1]={current:null}),
    useState:initial=>{const i=cursor++;if(!(i in states))states[i]=initial;return[states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}]},
    useEffect:(fn,deps)=>{const i=effectCursor++,old=effects[i];if(!old||deps.some((v,j)=>v!==old.deps[j]))queued.push(()=>{old?.cleanup?.();effects[i]={deps,cleanup:fn()}})},
    useStore:()=>[snapshot,store],usePopover:()=>pop,usePopoverId:()=> 'avatar-picker-fixture',
    PICKER_PLACEMENT:{side:'bottom',align:'start',width:252},PICKER_WIDTH:252,CUSTOM_NAME:'自定义',
    AVATARS:[{id:'yui',name:'YUi'},{id:'devcat',name:'开发喵'},{id:'bigfish',name:'大肥鱼'},{id:'claude',name:'Claude娘'},{id:'gemini',name:'Gemini小猫'}],
    builtinSrc:id=>'builtin:'+id,avatarName:id=>id,selectedSrc:()=> 'selected-avatar',
    AvatarImg:p=>h('img',p),PickerTile:p=>h('button',{onClick:()=>p.onPick(p.id),'data-avatar':p.id}),
    Panel:p=>p.popover.open?h('div',{role:'dialog'},...p.children):null,Notice:()=>null,
    stop:event=>event.stopPropagation(),
    document:{body,documentElement:{},createElement:()=>({style:{},setAttribute(){},remove(){const i=hosts.indexOf(this);if(i>=0)hosts.splice(i,1);this.isConnected=false}})},
    window:{innerWidth:1100,innerHeight:780,addEventListener:(n,fn,c)=>listeners.set(n+!!c,fn),removeEventListener:(n,fn,c)=>{if(listeners.get(n+!!c)===fn)listeners.delete(n+!!c)},requestAnimationFrame:fn=>{frames.push(fn);return frames.length},cancelAnimationFrame(){}},
    MutationObserver:Observer,ResizeObserver:Observer,getComputedStyle:()=>({visibility:'visible'}),setTimeout,clearTimeout,
  };
  vm.runInNewContext(code+'\nglobalThis.Component=SidebarMark;',sandbox);
  function resolve(node){
    if(node==null||typeof node!=='object')return node;
    if(node.portal)return {...node,children:resolve(node.children)};
    if(typeof node.tag==='function')return resolve(node.tag({...node.props,children:node.children}));
    return {...node,children:node.children.map(resolve)};
  }
  function commit(node){if(!node||typeof node!=='object')return;if(node.portal){commit(node.children);return}if(node.props?.ref){node.props.ref.current=node.props['data-neko-avatar-anchor']!==undefined?anchor:{focus(){},getBoundingClientRect:()=>geometry}}for(const c of node.children||[])commit(c)}
  function render(){cursor=refCursor=effectCursor=0;tree=resolve(sandbox.Component({size:24}));commit(tree);while(queued.length)queued.shift()();return tree}
  function walk(node,predicate,insidePortal=false,out=[]){if(!node||typeof node!=='object')return out;if(node.portal){walk(node.children,predicate,true,out);return out}if(predicate(node,insidePortal))out.push(node);for(const c of node.children||[])walk(c,predicate,insidePortal,out);return out}
  function mountedButtons(insidePortal){return walk(tree,(n,p)=>n.tag==='button'&&p===insidePortal)}
  function event(){return {stopped:false,stopPropagation(){this.stopped=true}}}
  return {render,hosts,listeners,observers,pop,store,mountedButtons,walk,get tree(){return tree},click(button){const e=event();button.props.onClick(e);if(!e.stopped)outerClicks++},get outerClicks(){return outerClicks},get sets(){return sets},get uploads(){return uploads},event,scroll(){geometry={...geometry,left:32,right:56,top:38,bottom:62};listeners.get('scrolltrue')();while(frames.length)frames.shift()();render()},cleanup(){for(const e of effects)e?.cleanup?.()}};
}
const live=fixture();live.render();live.render();assert.equal(live.hosts.length,1);assert.equal(live.mountedButtons(false).length,0,'native brand slot must contain no nested button');
const trigger=live.mountedButtons(true).find(n=>n.props.className==='neko-avatar-btn');assert(trigger);assert.equal(trigger.props['aria-haspopup'],'dialog');
live.click(trigger);assert(live.pop.open);assert.equal(live.outerClicks,0,'avatar click must not reach native new-chat owner');
for(const key of ['onKeyDown','onKeyUp','onPointerDown']){const e=live.event();trigger.props[key](e);assert(e.stopped,key+' must stop synthetic portal bubbling')}
live.render();const tiles=live.walk(live.tree,n=>n.props?.['data-avatar']);assert.equal(tiles.length,6,'five builtins and uploaded custom avatar remain');tiles[1].props.onClick();assert.equal(live.sets,1);
const upload=live.walk(live.tree,n=>n.tag==='button'&&n.props.className==='neko-btn neko-picker__upload')[0];assert(upload);upload.props.onClick();assert.equal(live.uploads,1);
live.scroll();assert.equal(live.hosts[0].style.left,'32px');assert.equal(live.hosts[0].style.top,'38px');
live.cleanup();assert.equal(live.hosts.length,0);assert.equal(live.listeners.size,0);assert(live.observers.every(o=>o.disconnected));
const plain=fixture({nested:false});plain.render();plain.render();assert.equal(plain.hosts.length,0);assert.equal(plain.mountedButtons(false).length,1,'ordinary standalone fixture retains one real avatar button');plain.cleanup();
const unsupported=fixture({nested:true,portals:false});unsupported.render();unsupported.render();assert.equal(unsupported.hosts.length,0);assert.equal(unsupported.mountedButtons(false).length,0,'missing portal support fails open with a passive image');unsupported.cleanup();
console.log('PASS no nested avatar button; independent portal click/key handling; builtins/custom/upload retained; geometry tracking; complete cleanup; standalone/fail-open modes');
