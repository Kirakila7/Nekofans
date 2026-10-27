const fs=require('node:fs'),path=require('node:path');
const packageRoot=__dirname;
function jsonc(file){return JSON.parse(fs.readFileSync(file,'utf8').replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,s=>s.startsWith('"')?s:'').replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,(s,end)=>end||s));}
function readOriginalSize(dataDir){
  const defaultFile=path.join(packageRoot,'assets/config.jsonc');
  let size=462,source='dsh-pet 0.3.7 default';
  const valid=n=>Number.isFinite(n)&&n>0;
  try{const p=jsonc(defaultFile).pets?.find(p=>p.id==='main');if(valid(p?.size)){size=p.size;source=defaultFile;}}catch{}
  for(const name of ['pet-config.jsonc','pet-config.json']){
    const file=path.join(dataDir,name);
    if(!fs.existsSync(file))continue;
    try{const p=jsonc(file).pets?.find(p=>p.id==='main');if(valid(p?.size)){size=p.size;source=file;}}catch{}
    break;
  }
  return {stageWidth:size,stageHeight:size*9/16,source};
}
const DEFAULT_MAIN_WIDTH=462,LEGACY_HELPER_WIDTH=239;
function petLayout(kind,original,presentation={}){
  const mainWidth=Number.isFinite(original?.stageWidth)&&original.stageWidth>0?original.stageWidth:DEFAULT_MAIN_WIDTH;
  // Boolean callers retain their original fixed helper size. New actors use
  // proportions so a customized main still has three correctly ordered tiers.
  let stageWidth;
  if(kind===true||kind==='main')stageWidth=mainWidth;
  else if(kind===false)stageWidth=LEGACY_HELPER_WIDTH;
  else if(kind==='task')stageWidth=Math.max(1,Math.round(mainWidth*.7));
  else if(kind==='subagent')stageWidth=Math.max(1,Math.round(mainWidth*LEGACY_HELPER_WIDTH/DEFAULT_MAIN_WIDTH));
  else throw new TypeError('Unknown desktop pet kind');
  if(presentation.compact){
    const scale=Number.isFinite(presentation.scale)&&presentation.scale>=.4&&presentation.scale<=1?presentation.scale:1;
    const aspect=Number.isFinite(presentation.aspect)&&presentation.aspect>0&&presentation.aspect<=16/9?presentation.aspect:16/9;
    const frameHeight=stageWidth*9/16*scale,frameWidth=frameHeight*aspect;
    return {stageWidth,width:Math.max(aspect===16/9?255:200,Math.ceil(frameWidth+(aspect===16/9?16:60))),height:Math.ceil(76+frameHeight+6)};
  }
  return {stageWidth,width:Math.max(255,Math.ceil(stageWidth+16)),height:Math.ceil(76+stageWidth*9/16+43)};
}

function finite(value,fallback){return Number.isFinite(value)?value:fallback;}
function workArea(area){return {x:finite(area?.x,0),y:finite(area?.y,0),width:Math.max(1,finite(area?.width,1)),height:Math.max(1,finite(area?.height,1))};}
function dimensions(layout){return {width:Math.max(1,finite(layout?.width,255)),height:Math.max(1,finite(layout?.height,254))};}
function packPetLayouts({area,layouts=[],gap=12,edge=18}={}){
  const screen=workArea(area),spacing=Math.max(0,finite(gap,12));
  const inset=Math.max(0,Math.min(finite(edge,18),Math.floor((Math.min(screen.width,screen.height)-1)/2)));
  const left=screen.x+inset,right=screen.x+screen.width-inset,top=screen.y+inset,bottom=screen.y+screen.height-inset;
  const sizes=layouts.map(dimensions);
  function place(scale){
    let x=right,rowBottom=bottom,rowHeight=0,rowCount=0,fits=true;
    const result=sizes.map(size=>{
      const width=Math.max(1,Math.ceil(size.width*scale)),height=Math.max(1,Math.ceil(size.height*scale));
      if(rowCount&&x-width<left){rowBottom-=rowHeight+spacing;x=right;rowHeight=0;rowCount=0;}
      const bounds={x:x-width,y:rowBottom-height,width,height,scale,overflow:false};
      if(bounds.x<left||bounds.y<top||width>right-left||height>bottom-top)fits=false;
      x=bounds.x-spacing;rowHeight=Math.max(rowHeight,height);rowCount++;
      return bounds;
    });
    return {fits,result};
  }
  let packed=place(1);
  if(!packed.fits){
    // Scale all windows together only when the work area cannot hold their
    // actual widths/heights. This keeps the three tier proportions intact.
    let low=0,high=1;
    for(let attempt=0;attempt<28;attempt++){
      const mid=(low+high)/2;
      if(place(mid).fits)low=mid;else high=mid;
    }
    // If even one-pixel windows plus gaps cannot all fit, report overflow but
    // never return scale=0 (Electron cannot use a zero zoom factor).
    const minimum=sizes.length?Math.min(1,...sizes.map(size=>1/Math.max(size.width,size.height))):1;
    packed=place(Math.max(low,minimum));
  }
  return packed.result.map(bounds=>({...bounds,
    x:Math.round(Math.max(screen.x,Math.min(screen.x+screen.width-bounds.width,bounds.x))),
    y:Math.round(Math.max(screen.y,Math.min(screen.y+screen.height-bounds.height,bounds.y))),
    overflow:!packed.fits}));
}

function petPlacement({area,layout,saved,index=0,layouts,gap=12,edge=18}={}){
  const position=Number.isInteger(index)&&index>=0?index:0;
  const sequence=Array.isArray(layouts)&&layouts.length?layouts:Array.from({length:position+1},()=>layout);
  const packed=packPetLayouts({area,layouts:sequence,gap,edge});
  const bounds=packed[position]||packPetLayouts({area,layouts:[layout],gap,edge})[0];
  const screen=workArea(area);
  if(!saved||!Number.isFinite(saved.x)||!Number.isFinite(saved.y))return bounds;
  return {...bounds,
    x:Math.round(Math.max(screen.x,Math.min(screen.x+screen.width-bounds.width,saved.x))),
    y:Math.round(Math.max(screen.y,Math.min(screen.y+screen.height-bounds.height,saved.y)))};
}
module.exports={readOriginalSize,petLayout,packPetLayouts,petPlacement};
