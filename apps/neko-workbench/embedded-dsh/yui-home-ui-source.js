// Workbench-local building surface. The original Yui home remains separate.
async function mountYuiBlockHome(stage, options = {}) {
  const doc = stage.ownerDocument, win = options.window || doc.defaultView, bridge = options.bridge || win?.nekoWorkbench;
  if (typeof bridge?.home !== 'function') throw new Error('工作台家园连接不可用。');
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const ui = el('div', 'neko-home');
  const description = el('p', 'neko-home__description', '工作台本地版 · 点击格子叠放或移除顶部方块。');
  const toolbar = el('div', 'neko-home__toolbar');
  const materialLabel = el('label', 'neko-home__material-label', '材料');
  const material = el('select', 'neko-home__material');
  material.setAttribute('aria-label', '选择方块材料'); materialLabel.append(material);
  const action = el('button', 'neko-home__tool', '放置'); action.type = 'button'; action.setAttribute('aria-pressed', 'true');
  const remove = el('button', 'neko-home__tool', '移除'); remove.type = 'button'; remove.setAttribute('aria-pressed', 'false');
  toolbar.append(materialLabel, action, remove);
  const viewControls = el('div', 'neko-home__view-controls');
  viewControls.setAttribute('role','group'); viewControls.setAttribute('aria-label','视角控制');
  const viewButton = (text,label) => { const b=el('button','neko-home__view-button',text); b.type='button'; b.setAttribute('aria-label',label); b.title=label; viewControls.append(b); return b; };
  const turnLeft=viewButton('↶','向左旋转视角'), turnRight=viewButton('↷','向右旋转视角');
  const zoomOut=viewButton('−','缩小视角'), zoomIn=viewButton('＋','放大视角'), resetView=viewButton('正面','重置正面视角');
  const viewValue=el('span','neko-home__view-value','100%');viewValue.setAttribute('aria-live','polite');viewControls.append(viewValue);
  const viewport = el('div', 'neko-home__viewport');
  const canvas = el('canvas', 'neko-home__canvas'); canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '家园搭建区域；方向键选择格子，回车放置，Delete 删除');
  viewport.append(canvas);
  const hint = el('p', 'neko-home__hint', '拖动画面旋转，滚轮缩放；点击搭建。方向键选格，回车放置，Delete 移除。');
  const saving = el('p', 'neko-home__saving', '正在读取工作台本地存档…'); saving.setAttribute('role', 'status'); saving.setAttribute('aria-live', 'polite');
  const textureStatus = el('p', 'neko-home__description neko-home__texture-status', '正在检查本机材质…'); textureStatus.setAttribute('aria-live', 'polite');
  const retryTextures = el('button', 'neko-home__retry-save neko-home__retry-textures', '重新检测材质'); retryTextures.type = 'button'; retryTextures.hidden = true;
  const retrySave = el('button', 'neko-home__retry-save', '重试保存'); retrySave.type = 'button'; retrySave.hidden = true;
  ui.append(description, toolbar, viewControls, viewport, hint, saving, textureStatus, retrySave, retryTextures); stage.appendChild(ui);
  const names = {grass:'草地',dirt:'泥土',stone:'石头',cobblestone:'圆石',oak_planks:'橡木',oak_log:'原木',glass:'玻璃',bricks:'砖块',cherry_planks:'樱花木',cherry_log:'樱花原木',white_wool:'白色羊毛',red_wool:'红色羊毛',poppy:'虞美人',dandelion:'蒲公英',bookshelf:'书架',glowstone:'萤石'};
  let state = null, mode = 'place', selected = {x:0,z:0}, busy = false, retrying = false, disposed = false, unsubscribe = null, observer = null;
  let textureImages = Object.create(null), textureLoading = false;
  let width = 1, height = 1, unit = 1, originX = 0, originY = 0, angle = 0, zoom = 1, drag = null, suppressClick = false;
  function controls() {
    const disabled = busy || !state || state.persistence?.status === 'load-error';
    material.disabled = action.disabled = remove.disabled = disabled;
    retrySave.hidden = !retrying && state?.persistence?.status !== 'save-error';
    retrySave.disabled = busy || state?.persistence?.status !== 'save-error';
    retrySave.textContent = retrying ? '正在保存…' : '重试保存';
    canvas.setAttribute('aria-disabled', String(disabled));
    action.setAttribute('aria-pressed', String(mode === 'place')); remove.setAttribute('aria-pressed', String(mode === 'remove'));
  }
  function refreshStatus() {
    if (!state) { saving.textContent = '正在读取工作台本地存档…'; return; }
    const status = state.persistence?.status;
    saving.textContent = status === 'saving' ? '正在保存到工作台本地…' : status === 'load-error' ? (state.persistence.error || '工作台存档读取失败，原文件已保留，暂不能修改。') : status === 'save-error' ? (state.persistence.error || '更改尚未保存，请重试。') : status === 'saved' ? '已保存到工作台本地 · 尚未同步原家园' : '本地存档状态不可用';
  }
  const depth = (x,z) => x*Math.sin(angle)+z*Math.cos(angle);
  function point(x,z,y=0) { return [originX+(x*Math.cos(angle)-z*Math.sin(angle))*unit,originY+depth(x,z)*unit*.27-y*unit*.82]; }
  function blocksAt(x,z) { return (state?.blocks || []).filter(b=>b.x===x && b.z===z && b.y>=0).sort((a,b)=>a.y-b.y); }
  function polygon(ctx, pts, fill, stroke) { ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);for(const p of pts.slice(1))ctx.lineTo(p[0],p[1]);ctx.closePath();ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.stroke();} }
  function corners(x,z,y=0) {
    const cells=[[x-.5,z-.5],[x+.5,z-.5],[x+.5,z+.5],[x-.5,z+.5]];
    let front=0;for(let i=1;i<4;i++)if(depth(...cells[i])>depth(...cells[front])+1e-9)front=i;
    return Array.from({length:4},(_,i)=>point(...cells[(front+2+i)%4],y));
  }
  function contains(pts,x,y) {
    let sign=0;
    for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length],cross=(b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]);if(Math.abs(cross)<1e-6)continue;const next=Math.sign(cross);if(sign&&next!==sign)return false;sign=next;}return true;
  }
  function orderedCells() { const result=[];for(let x=-4;x<=4;x++)for(let z=-4;z<=4;z++)result.push({x,z});return result.sort((a,b)=>depth(a.x,a.z)-depth(b.x,b.z)||a.x-b.x||a.z-b.z); }
  function draw() {
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const ratio = Math.min(win.devicePixelRatio || 1, 2); ctx.setTransform(ratio,0,0,ratio,0,0); ctx.clearRect(0,0,width,height);
    const visible=(state?.blocks || []).filter(b=>b.x>=-4&&b.x<=4&&b.z>=-4&&b.z<=4&&b.y>=0);
    const tallest=Math.max(0,...visible.map(b=>b.y+1));
    const span=Math.abs(Math.cos(angle))+Math.abs(Math.sin(angle));
    const low=-4.5*span*.27-tallest*.82, high=4.5*span*.27;
    unit=Math.max(1,Math.min(width*.91/(9*span),height*.88/(high-low||1))*zoom);
    originX=width/2;originY=height/2-(low+high)*unit/2;
    const blocks=new Map();for(const b of visible){const key=`${b.x},${b.z}`;if(!blocks.has(key))blocks.set(key,[]);blocks.get(key).push(b);}for(const column of blocks.values())column.sort((a,b)=>a.y-b.y);
    for(const {x,z} of orderedCells()){
      polygon(ctx,corners(x,z),'rgba(0,0,0,0)','rgba(128,128,128,0.28)');
      const column=blocks.get(`${x},${z}`)||[];
      for(const block of column){const base=corners(x,z,block.y),raised=corners(x,z,block.y+1);drawYuiHomeBlock(ctx,raised,base,block.material,textureImages[block.material]);}
      if(selected.x===x&&selected.z===z){const pts=corners(x,z,column.length?column.at(-1).y+1:0);ctx.beginPath();ctx.moveTo(...pts[0]);for(const p of pts.slice(1))ctx.lineTo(...p);ctx.closePath();ctx.strokeStyle='#599ad3';ctx.lineWidth=2;ctx.stroke();ctx.lineWidth=1;}
    }
    viewValue.textContent=Math.round(zoom*100)+'%';
  }
  function resize() {
    if(disposed)return;
    const rect=viewport.getBoundingClientRect(); width=Math.max(1,Math.floor(rect.width));height=Math.max(1,Math.floor(rect.height));
    const ratio=Math.min(win.devicePixelRatio || 1,2);canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);draw();
  }
  async function loadTextures(retry = false) {
    if (textureLoading || disposed) return;
    textureLoading = true; retryTextures.disabled = true;
    if (retry) textureStatus.textContent = '正在重新检测材质…';
    try {
      const pack = await bridge.home({action:retry?'textures-retry':'textures'});
      if (disposed) return;
      if (!['available','partial'].includes(pack?.status) || !['yui-original','minecraft-local'].includes(pack.source) || !pack.materials || typeof pack.materials !== 'object' || typeof win.Image !== 'function') throw new Error('材质不可用');
      const cache = new Map();
      function decode(url) {
        if (typeof url !== 'string' || url.length > 350000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(url)) return Promise.resolve(null);
        if (!cache.has(url)) cache.set(url,new Promise(resolve=>{
          const image = new win.Image();
          const timer=win.setTimeout(()=>finish(null),5000);
          function finish(value){win.clearTimeout(timer);image.onload=null;image.onerror=null;resolve(value);}
          image.onload=()=>finish(image.naturalWidth > 0 && image.naturalHeight > 0 && image.naturalWidth <= 4096 && image.naturalHeight <= 4096 ? image : null);
          image.onerror=()=>finish(null);image.src=url;
        }));
        return cache.get(url);
      }
      const entries=await Promise.all(Object.keys(names).map(async key=>{
        const item=pack.materials[key];if(!item || typeof item !== 'object')return [key,null];
        const [top,side]=await Promise.all([decode(item.top),decode(item.side)]);
        return [key,top || side ? {top,side} : null];
      }));
      if(disposed)return;
      const decoded=Object.fromEntries(entries.filter(([,item])=>item));
      const count=entries.filter(([,item])=>item && item.top && item.side).length;
      if(!Object.keys(decoded).length)throw new Error('材质解码失败');
      textureImages=decoded;
      const source=pack.source === 'yui-original' ? '原 Yui 家园材质' : '本机 Minecraft 材质（与原家园尚未比对）';
      textureStatus.textContent=count===entries.length && pack.status==='available' ? source : source+' · 部分方块使用基础材质';
      retryTextures.hidden=pack.source==='yui-original' && count===entries.length && pack.status==='available';
      draw();
    } catch {
      if(!disposed){textureStatus.textContent=retry && Object.keys(textureImages).length ? '材质检测失败 · 保留当前材质' : '本机材质暂不可用 · 使用基础材质';retryTextures.hidden=false;}
    } finally {
      textureLoading=false;
      if(!disposed)retryTextures.disabled=false;
    }
  }
  function setState(next) {
    if(disposed || !next || next.ok !== true)return;
    state=next;
    if(!material.options.length){for(const value of next.materials || []){if(!names[value])continue;const option=el('option','',names[value]);option.value=value;material.appendChild(option);} material.value='oak_planks';}
    refreshStatus();controls();draw();
  }
  async function edit(kind = mode) {
    if(busy || !state || state.persistence?.status === 'load-error')return;
    busy=true;controls();
    try { const column=blocksAt(selected.x,selected.z),top=column.at(-1)?.y ?? -1;
      if(kind==='remove' && top<0){saving.textContent='这里还没有方块。';return;}
      if(kind==='place' && top>=63){saving.textContent='此处已达到最高高度。';return;}
      const input={action:kind,x:selected.x,y:kind==='place'?top+1:top,z:selected.z};if(kind==='place')input.material=material.value;setState(await bridge.home(input)); }
    catch(error) { saving.textContent=error?.message || '家园修改失败，请重试。'; }
    finally {busy=false;controls();}
  }
  action.addEventListener('click',()=>{mode='place';controls();});remove.addEventListener('click',()=>{mode='remove';controls();});
  retryTextures.addEventListener('click',()=>{void loadTextures(true);});
  retrySave.addEventListener('click',async()=>{
    if(busy || state?.persistence?.status !== 'save-error')return;
    busy=true;retrying=true;controls();
    try { setState(await bridge.home({action:'retry-save'})); }
    catch(error) { saving.textContent=error?.message || '保存失败，请检查工作台存储后重试。'; }
    finally { busy=false;retrying=false;controls(); }
  });
  const setZoom=value=>{zoom=Math.max(.6,Math.min(2.5,value));draw();};
  turnLeft.addEventListener('click',()=>{angle-=Math.PI/8;draw();});turnRight.addEventListener('click',()=>{angle+=Math.PI/8;draw();});
  zoomIn.addEventListener('click',()=>setZoom(zoom*1.2));zoomOut.addEventListener('click',()=>setZoom(zoom/1.2));
  resetView.addEventListener('click',()=>{angle=0;zoom=1;draw();});
  canvas.addEventListener('wheel',event=>{if(event.ctrlKey||event.metaKey)return;event.preventDefault();if(event.deltaY)setZoom(zoom*(event.deltaY<0?1.12:1/1.12));},{passive:false});
  canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;drag={id:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,moved:false};canvas.setPointerCapture?.(event.pointerId);});
  canvas.addEventListener('pointermove',event=>{if(!drag||drag.id!==event.pointerId)return;if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>4)drag.moved=true;if(drag.moved){angle+=(event.clientX-drag.lastX)*.012;draw();}drag.lastX=event.clientX;});
  function endDrag(event){if(!drag||drag.id!==event.pointerId)return;suppressClick=drag.moved;drag=null;}
  canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',()=>{drag=null;suppressClick=false;});
  canvas.addEventListener('click',event=>{
    if(suppressClick){suppressClick=false;return;}if(canvas.getAttribute('aria-disabled')==='true')return;
    const rect=canvas.getBoundingClientRect(),px=event.clientX-rect.left,py=event.clientY-rect.top;
    const cells=orderedCells().reverse();let hit=null;
    for(const cell of cells){const column=blocksAt(cell.x,cell.z);for(const block of [...column].reverse()){const base=corners(cell.x,cell.z,block.y),raised=corners(cell.x,cell.z,block.y+1);if(contains(raised,px,py)||contains([raised[1],raised[2],base[2],base[1]],px,py)||contains([raised[2],raised[3],base[3],base[2]],px,py)){hit=cell;break;}}if(hit)break;if(contains(corners(cell.x,cell.z),px,py)){hit=cell;break;}}
    if(!hit)return;selected=hit;draw();void edit();
  });
  canvas.addEventListener('keydown',event=>{
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const delta={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[event.key];selected={x:Math.max(-4,Math.min(4,selected.x+delta[0])),z:Math.max(-4,Math.min(4,selected.z+delta[1]))};draw();}
    else if(event.key==='Enter' || event.key===' '){event.preventDefault();void edit();}
    else if(event.key==='Delete' || event.key==='Backspace'){event.preventDefault();void edit('remove');}
  });
  try {
    if(typeof bridge.subscribeHome === 'function')unsubscribe=bridge.subscribeHome(setState);
    setState(await bridge.home({action:'status'}));
    if(!state)throw new Error('工作台家园状态不可用。');
    if(typeof win.ResizeObserver==='function'){observer=new win.ResizeObserver(resize);observer.observe(viewport);}
    win.addEventListener('resize',resize);resize();void loadTextures();
  } catch(error) { if(typeof unsubscribe==='function')unsubscribe();ui.remove();throw error; }
  return () => { if(disposed)return;disposed=true;observer?.disconnect();win.removeEventListener('resize',resize);if(typeof unsubscribe==='function')unsubscribe();ui.remove(); };
}
