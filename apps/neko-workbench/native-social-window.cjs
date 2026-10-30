'use strict';

// Compute a window shape around the original renderer controls. All inputs are
// integer device-independent pixels in the social view's local coordinate space.
function subtractRectangles(width,height,holes) {
  let regions=[{x:0,y:0,width,height}];
  for(const hole of holes){
    const next=[];
    for(const r of regions){
      const x1=Math.max(r.x,hole.x),y1=Math.max(r.y,hole.y),x2=Math.min(r.x+r.width,hole.x+hole.width),y2=Math.min(r.y+r.height,hole.y+hole.height);
      if(x1>=x2||y1>=y2){next.push(r);continue;}
      if(y1>r.y)next.push({x:r.x,y:r.y,width:r.width,height:y1-r.y});
      if(y2<r.y+r.height)next.push({x:r.x,y:y2,width:r.width,height:r.y+r.height-y2});
      if(x1>r.x)next.push({x:r.x,y:y1,width:x1-r.x,height:y2-y1});
      if(x2<r.x+r.width)next.push({x:x2,y:y1,width:r.x+r.width-x2,height:y2-y1});
    }
    regions=next;
  }
  return regions;
}

function localHoles(bounds, holes) {
  return holes.map(h=>({x:Math.max(0,h.x-bounds.x),y:Math.max(0,h.y-bounds.y),
    width:Math.max(0,Math.min(bounds.x+bounds.width,h.x+h.width)-Math.max(bounds.x,h.x)),
    height:Math.max(0,Math.min(bounds.y+bounds.height,h.y+h.height)-Math.max(bounds.y,h.y))})).filter(h=>h.width>0&&h.height>0);
}

// A shaped owned window preserves the original DSH composer and its React
// state; the existing social WebContentsView is reparented without navigating.
function createNativeSocialWindow({BaseWindow,host,view}) {
  if(typeof BaseWindow!=='function'||process.platform!=='win32')return null;
  const window=new BaseWindow({parent:host,frame:false,show:false,skipTaskbar:true,resizable:false,focusable:true,hasShadow:false});
  // Alt+F4 on a focused social view must not destroy the preserved WebContents.
  window.on('close',event=>event.preventDefault());
  let attached=false,closed=false;
  try{if(typeof window.setShape!=='function')throw Error('Window shapes unavailable');}
  catch(error){window.destroy();throw error;}
  return {
    attach(){if(closed)throw Error('Social window closed');if(!attached){window.contentView.addChildView(view);attached=true;}},
    place(bounds,holes){
      if(closed)throw Error('Social window closed');
      const shape=subtractRectangles(bounds.width,bounds.height,localHoles(bounds,holes));
      if(!shape.length)throw Error('Social view fully covered');
      const origin=host.getContentBounds();
      window.setBounds({x:origin.x+bounds.x,y:origin.y+bounds.y,width:bounds.width,height:bounds.height});
      view.setBounds({x:0,y:0,width:bounds.width,height:bounds.height});
      window.setShape(shape);
      if(host.isVisible()&&!host.isMinimized())window.showInactive();else window.hide();
    },
    detach(){if(attached&&!window.isDestroyed()){window.contentView.removeChildView(view);attached=false;}},
    destroy(){if(closed)return;this.detach();closed=true;if(!window.isDestroyed())window.destroy();},
  };
}
module.exports={subtractRectangles,localHoles,createNativeSocialWindow};
