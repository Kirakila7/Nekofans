'use strict';

function clampBounds(bounds, area) {
  return { ...bounds,
    x: Math.round(Math.max(area.x, Math.min(area.x + Math.max(0, area.width - bounds.width), bounds.x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + Math.max(0, area.height - bounds.height), bounds.y))) };
}

// Standard DBSCAN; minPoints includes the point itself. Noise is -1.
function dbscan(points, epsilon, minPoints = 2) {
  if (!(Number.isFinite(epsilon) && epsilon > 0) || !Number.isInteger(minPoints) || minPoints < 1 ||
      points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new TypeError('Invalid DBSCAN input');
  const labels = points.map(() => -2), square = epsilon * epsilon;
  const neighbours = i => points.flatMap((p, j) => (p.x-points[i].x)**2 + (p.y-points[i].y)**2 <= square ? [j] : []);
  let cluster = 0;
  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== -2) continue;
    const queue = neighbours(i);
    if (queue.length < minPoints) { labels[i] = -1; continue; }
    labels[i] = cluster;
    const seen = new Set(queue);
    for (const j of queue) {
      if (labels[j] === -1) labels[j] = cluster;
      if (labels[j] !== -2) continue;
      labels[j] = cluster;
      const next = neighbours(j);
      if (next.length >= minPoints) for (const k of next) if (!seen.has(k)) { seen.add(k); queue.push(k); }
    }
    cluster++;
  }
  return labels;
}

// Work with the visible character, not its transparent input/bubble window.
function bodyBounds(bounds, body = bounds.body) {
  const width = Math.min(bounds.width, Math.max(1, body?.width || bounds.width * .45));
  const height = Math.min(bounds.height, Math.max(1, body?.height || bounds.height * .48));
  const inset = Math.max(0, Math.min(bounds.height-height, body?.bottomInset ?? bounds.height * .06));
  return { x: bounds.x + (bounds.width-width)/2, y: bounds.y+bounds.height-inset-height, width, height };
}
const centre = r => ({ x: r.x+r.width/2, y: r.y+r.height/2 });
function atBody(bounds, body, x, bottom, area) {
  const visible = bodyBounds(bounds, body);
  return clampBounds({ ...bounds, x: x-bounds.width/2, y: bounds.y+bottom-visible.y-visible.height }, area);
}
function overlap(a,b,gap=6) {
  return Math.max(0, Math.min(a.x+a.width+gap,b.x+b.width+gap)-Math.max(a.x,b.x)) *
    Math.max(0, Math.min(a.y+a.height+gap,b.y+b.height+gap)-Math.max(a.y,b.y));
}

function neighbourClusters(records) {
  const bodies=records.map(r=>bodyBounds(r.point,r.body));
  const epsilon=Math.max(64,bodies.map(b=>b.width).sort((a,b)=>a-b)[Math.floor(bodies.length/2)]*2.4||64);
  const labels=dbscan(bodies.map(centre),epsilon,2);
  return {epsilon,labels:new Map(records.map((r,i)=>[r.id,labels[i]]))};
}
function clusterLayout(records, home, area, previous = null) {
  const ordered = [...records].sort((a,b) => a.homeSlot-b.homeSlot || a.id.localeCompare(b.id));
  if (!ordered.length) return { targets: new Map(), labels: new Map(), epsilon: 64 };
  const bodies = ordered.map(r => bodyBounds(r.point, r.body));
  const epsilon = Math.max(64, bodies.map(b => b.width).sort((a,b)=>a-b)[Math.floor(bodies.length/2)] * 2.4);
  const labels = dbscan(bodies.map(centre), epsilon, 2);
  const byId = new Map(ordered.map((r,i) => [r.id,labels[i]]));
  // Allocate neighbours together, while keeping every colony attached to the main pet.
  const groups = new Map();
  ordered.forEach((r,i) => { const key=labels[i]<0?'noise-'+r.id:labels[i]; if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r); });
  const main = bodyBounds(home), anchor = centre(main), placed = [], targets = new Map();
  // Completion/visibility changes must not reshuffle surviving characters.
  for(const record of ordered){
    const old=previous?.get(record.id);if(!old)continue;
    const kept=clampBounds({...old,width:record.point.width,height:record.point.height},area);
    if(kept.x!==old.x||kept.y!==old.y)continue;
    targets.set(record.id,kept);placed.push(bodyBounds(kept,record.body));
  }
  const stepX = Math.max(...bodies.map(b=>b.width))+12, stepY = Math.max(...bodies.map(b=>b.height))+10;
  const radius = Math.max(3,Math.ceil(Math.sqrt(ordered.length))+2);
  for (const group of groups.values()) {
    const neighbours = group.filter(r=>targets.has(r.id)).map(r=>centre(bodyBounds(targets.get(r.id),r.body)));
    for (const record of group) {
      if(targets.has(record.id))continue;
      let best = null;
      const seen = new Set();
      for (let row=-2;row<=radius+2;row++) for (let col=-radius;col<=radius;col++) {
        const candidate = atBody(record.point,record.body,anchor.x+col*stepX,
          main.y+main.height-row*stepY,area);
        const key=candidate.x+','+candidate.y;if(seen.has(key))continue;seen.add(key);
        const b=bodyBounds(candidate,record.body),c=centre(b);
        const collisions=overlap(b,main)+placed.reduce((sum,p)=>sum+overlap(b,p),0);
        const affinity=neighbours.length?Math.min(...neighbours.map(n=>(c.x-n.x)**2+(c.y-n.y)**2))*.18:0;
        const score=collisions*1e6+(c.x-anchor.x)**2+(c.y-anchor.y)**2*.8+affinity+(row<0?400:0);
        if(!best||score<best.score)best={score,candidate,b,c};
      }
      targets.set(record.id,best.candidate);placed.push(best.b);neighbours.push(best.c);
    }
  }
  return { targets, labels: byId, epsilon };
}

function fountainOrigin(bounds, body, home, area) {
  const main=bodyBounds(home);
  return atBody(bounds,body,main.x+main.width/2,main.y+main.height*.78,area);
}
function fountainFrame({origin,target,area,slot=0,lift=100,elapsed,duration=900}) {
  const delay=Math.min(280,slot%8*40),u=Math.max(0,Math.min(1,(elapsed-delay)/duration));
  const side=slot%2?1:-1;
  const point=clampBounds({...origin,x:origin.x+(target.x-origin.x)*u+side*Math.sin(Math.PI*u)*origin.width*.10,
    y:origin.y+(target.y-origin.y)*u-4*lift*u*(1-u)},area);
  return {point,done:elapsed>=delay+duration,progress:u,lean:Math.sin(Math.PI*u)*side*5};
}

function separation(record, peers) {
  const a=bodyBounds(record.point,record.body),at=centre(a);let x=0,y=0;
  for(const other of peers) {
    if(other===record||other.birth||other.window?.isDestroyed()||!other.window?.isVisible())continue;
    const b=bodyBounds(other.point,other.body),to=centre(b),rx=(a.width+b.width)/2+8,ry=(a.height+b.height)/2+7;
    let dx=(at.x-to.x)/rx,dy=(at.y-to.y)/ry,d=Math.hypot(dx,dy);
    if(d>=1.15)continue;
    if(d<.001){dx=record.homeSlot<other.homeSlot?-1:1;dy=-.25;d=.01;}
    const force=Math.max(0,1.15-d)*120;x+=dx/d*force;y+=dy/d*force;
  }
  const length=Math.hypot(x,y);return length>130?{x:x/length*130,y:y/length*130}:{x,y};
}

module.exports={clampBounds,dbscan,bodyBounds,atBody,clusterLayout,neighbourClusters,fountainOrigin,fountainFrame,separation};
