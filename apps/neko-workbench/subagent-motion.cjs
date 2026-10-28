'use strict';

const FRAME_MS = 40, EXPLORE_SPEED = 90, RETURN_SPEED = 260, HOME_REST_MS = 1300;
const {clampBounds,bodyBounds,clusterLayout,neighbourClusters,fountainOrigin,fountainFrame,separation}=require('./pet-swarm.cjs');
const contains = (r, p) => p && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
function homeTarget(home, size, area, index = 0) {
  // Gather at the main character's feet; stagger helpers into a small fan.
  const side = index % 2 ? 1 : -1, ring = Math.floor(index / 2) + 1;
  return clampBounds({ ...size, x: home.x + home.width / 2 - size.width / 2 + side * Math.min(54, size.width * .25) * ring,
    y: home.y + home.height - size.height - Math.floor(index / 4) * 24 }, area);
}
function exploreTarget(bounds, area, random = Math.random) {
  const margin = 12, width = Math.max(0, area.width - bounds.width - margin * 2), height = Math.max(0, area.height - bounds.height - margin * 2);
  // Choose resting waypoints near the desktop edges.
  const edge = Math.floor(random() * 3), along = random();
  return clampBounds({ ...bounds, x: area.x + margin + (edge === 0 ? width * along : edge === 1 ? 0 : width),
    y: area.y + margin + (edge === 0 ? height : height * (.3 + along * .7)) }, area);
}
function stepToward(from, target, distance) {
  const dx = target.x - from.x, dy = target.y - from.y, length = Math.hypot(dx, dy);
  if (length <= distance || length < .5) return { ...from, x: target.x, y: target.y, arrived: true };
  return { ...from, x: from.x + dx / length * distance, y: from.y + dy / length * distance, arrived: false };
}

function createSubagentMotion({ now = Date.now, random = Math.random, getHome, getArea, getCursor = () => null,
  reducedMotion = () => false, isPaused = () => false, onPose = () => {}, onReturned = () => {}, onForeground = () => {},
  schedule = callback => setInterval(callback, FRAME_MS), unschedule = clearInterval } = {}) {
  const records = new Map(), seen = new Map(); let timer = null, lastTick = now(), nextSlot = 0, layoutKey='', layout=null,lastClusters=0;
  let layoutHome='',layoutGeometry=new Map();
  const needsTick=()=>[...records.values()].some(r=>r.birth||r.returning||r.cluster||r.active&&r.explore);
  const boundsOf = w => w.getBounds?.() || { ...w.bounds, x: w.getPosition()[0], y: w.getPosition()[1] };
  function pose(record, phase, moving, direction = record.direction || -1, extra = {}) {
    const value = { phase, moving, direction, retire:record.retire!==false, ...extra };
    if(record.cluster) value.clusterId=layout?.labels.get(record.id)??-1;
    const key = JSON.stringify(value);
    if (record.pose !== key) { record.pose = key; record.direction = direction; onPose(record.id, value); }
  }
  function keepPosition(id, desired, area) {
    const record = records.get(id);
    if (!record || record.window.isDestroyed()) return desired;
    const at = boundsOf(record.window);
    return clampBounds({ ...desired, x: at.x, y: at.y }, getArea(at) || area);
  }
  function sync(entries) {
    const live = new Set(entries.map(entry => entry.id));
    for (const [id] of records) if (!live.has(id)) { records.delete(id); onPose(id, null); }
    for (const entry of entries) {
      let record = records.get(entry.id);
      if (!record || record.window !== entry.window) {
        const identity=String(entry.sessionId||entry.id),fresh=!seen.has(identity),homeSlot=seen.get(identity)??nextSlot++;
        seen.set(identity,homeSlot);if(seen.size>4096)seen.delete(seen.keys().next().value);
        record = { id: entry.id, window: entry.window, point: boundsOf(entry.window), target: null, until: now(), direction: -1, homeSlot,
          birth:fresh&&entry.fountain===true&&entry.active&&!reducedMotion()?{start:null}:null };
        records.set(entry.id, record);
      }
      if (entry.returning !== record.returning || entry.active !== record.active) { record.target = null; record.arrivedAt = null; record.until = now(); }
      Object.assign(record, { active: entry.active, returning: entry.returning, explore:entry.explore!==false,
        cluster:entry.cluster===true,body:entry.body,retire:entry.retire!==false });
      Object.assign(record.point,{width:boundsOf(entry.window).width,height:boundsOf(entry.window).height});
      if(entry.fountain===false||entry.returning||reducedMotion())record.birth=null;
      if (!entry.active && !entry.returning) pose(record, 'resting', false);
    }
    layoutKey='';
    const home=getHome();
    if(home)for(const record of records.values())if(record.birth?.start===null){
      const area=getArea(home);record.point=fountainOrigin(boundsOf(record.window),record.body,home,area);
      record.window.setPosition(record.point.x,record.point.y,false);onForeground(record.id);
      pose(record,'spawning',false,record.direction,{progress:0,lean:0});
    }
    const needed = needsTick();
    if (needed && !timer) { lastTick = now(); timer = schedule(tick); timer?.unref?.(); }
    if (!needed && timer) { unschedule(timer); timer = null; }
  }
  function tick() {
    const time = now(), dt = Math.max(0, Math.min(.12, (time - lastTick) / 1000)); lastTick = time;
    const home = getHome(), cursor = getCursor(), completed = [], peers=[...records.values()];
    if(home&&peers.some(r=>r.cluster)) {
      const key=JSON.stringify([home,...peers.map(r=>[r.id,r.point.width,r.point.height,r.body])]);
      if(key!==layoutKey){
        const homeKey=JSON.stringify(home),geometry=new Map(peers.map(r=>[r.id,JSON.stringify([r.point.width,r.point.height,r.body])]));
        const preserve=homeKey===layoutHome&&[...geometry].every(([id,value])=>!layoutGeometry.has(id)||layoutGeometry.get(id)===value);
        layout=clusterLayout(peers,home,getArea(home),preserve?layout?.targets:null);layoutKey=key;layoutHome=homeKey;layoutGeometry=geometry;
      }
      if(time-lastClusters>=240){layout.labels=neighbourClusters(peers).labels;lastClusters=time;}
    }
    for (const record of records.values()) {
      const w = record.window;
      if(w.isDestroyed()){records.delete(record.id);onPose(record.id,null);continue;}
      if (!w.isVisible() || (!record.active && !record.returning && !record.cluster)) continue;
      const bounds = boundsOf(w), area = getArea((record.returning||record.cluster) && home ? home : bounds);
      const hovering=contains(record.cluster||record.birth?bodyBounds(bounds,record.body):bounds,cursor)&&(!record.birth||!home||!contains(bodyBounds(home),cursor));
      if (isPaused(record.id) || w.isFocused?.() || hovering || time<record.manualUntil) {
        record.point = bounds; record.target = null; record.arrivedAt = null;
        record.birth=null;
        pose(record, record.returning ? 'returning' : 'exploring', false); continue;
      }
      const samePosition = Math.abs(record.point.x - bounds.x) < 1.1 && Math.abs(record.point.y - bounds.y) < 1.1;
      if (!samePosition) record.point = bounds;
      else Object.assign(record.point,{width:bounds.width,height:bounds.height});
      if(reducedMotion())record.birth=null;
      if(record.birth&&home&&!reducedMotion()) {
        if(record.birth.start===null){record.birth.start=time;record.birth.origin=fountainOrigin(bounds,record.body,home,area);
          record.birth.target=layout?.targets.get(record.id)||homeTarget(home,bounds,area,record.homeSlot);onForeground(record.id);}
        const frame=fountainFrame({origin:record.birth.origin,target:record.birth.target,area,slot:record.homeSlot,
          lift:Math.max(70,bodyBounds(home).height*1.05),elapsed:time-record.birth.start});
        record.point=frame.point;w.setPosition(frame.point.x,frame.point.y,false);
        pose(record,'spawning',!frame.done,frame.point.x<bounds.x?-1:1,{progress:Math.round(frame.progress*100)/100,lean:Math.round(frame.lean*10)/10});
        if(!frame.done)continue;
        record.birth=null;record.until=time+220;
      }
      if(record.birth)continue;
      if(!record.returning&&!record.explore&&!record.cluster){pose(record,'resting',false);continue;}
      let target;
      if (record.returning) {
        if (!home) { pose(record, 'returning', false); continue; }
        target = record.cluster&&layout?.targets.get(record.id)||homeTarget(home, bounds, area, record.homeSlot);
      } else if(record.cluster&&(!record.explore||!record.active)) {
        if(!home){pose(record,'resting',false);continue;}
        target=layout.targets.get(record.id);
        if(reducedMotion()){pose(record,'clustered',false);continue;}
      } else {
        if (reducedMotion()) { pose(record, 'exploring', false); continue; }
        if (time < record.until) { pose(record, 'exploring', false); continue; }
        if (!record.target) record.target = exploreTarget(bounds, area, random);
        target = clampBounds({ ...bounds, ...record.target, width: bounds.width, height: bounds.height }, area);
      }
      const speed=record.returning||record.cluster&&!record.explore?RETURN_SPEED:EXPLORE_SPEED;
      let step = stepToward(record.point, target, reducedMotion() ? Infinity : speed * dt);
      if(record.cluster&&!reducedMotion()&&!step.arrived) {
        const away=separation(record,peers),dx=step.x-record.point.x+away.x*dt,dy=step.y-record.point.y+away.y*dt,length=Math.hypot(dx,dy),limit=speed*dt;
        const ratio=length>limit?limit/length:1;step={...step,x:record.point.x+dx*ratio,y:record.point.y+dy*ratio};
      }
      record.point = clampBounds({ ...bounds, x: step.x, y: step.y }, area);
      // Keep fractional progress across frames; only native coordinates round.
      record.point.x = Math.max(area.x, Math.min(area.x + Math.max(0, area.width - bounds.width), step.x));
      record.point.y = Math.max(area.y, Math.min(area.y + Math.max(0, area.height - bounds.height), step.y));
      const x = Math.round(record.point.x), y = Math.round(record.point.y);
      if (bounds.x !== x || bounds.y !== y) w.setPosition(x, y, false);
      pose(record, record.returning ? step.arrived ? 'gathered' : 'returning' : record.cluster&&(!record.explore||!record.active) ? step.arrived?'clustered':'gathering':'exploring', !step.arrived, target.x < bounds.x ? -1 : target.x > bounds.x ? 1 : record.direction);
      if (step.arrived) {
        if (record.returning) {
          record.arrivedAt ??= time;
          if (time - record.arrivedAt >= HOME_REST_MS) completed.push(record.id);
        } else { record.target = null; record.until = time + 1000 + random() * 2000; }
      } else record.arrivedAt = null;
    }
    // Callbacks can reconcile/delete records, so run after iteration.
    for (const id of completed) {
      const record=records.get(id);if(!record?.returning||record.active)continue;
      if(record.retire===false){record.returning=false;record.arrivedAt=null;pose(record,record.cluster?'clustered':'resting',false);}
      else{records.delete(id);onPose(id,null);}
      onReturned(id);
    }
    if (!needsTick() && timer) { unschedule(timer); timer = null; }
  }
  function resumeFromDrag(id) {
    const record = records.get(id); if (!record) return;
    record.point = boundsOf(record.window); record.birth=null;record.target = null; record.arrivedAt = null; record.until = now() + 3000;record.manualUntil=record.until;
  }
  function dispose() { if (timer) unschedule(timer); timer = null; for (const id of records.keys()) onPose(id, null); records.clear();seen.clear();layout=null;layoutKey=''; }
  function replay(id) { const record = records.get(id); if (record?.pose) onPose(id, JSON.parse(record.pose)); }
  function snapshot(){return [...records.values()].map(r=>({id:r.id,position:{x:r.point.x,y:r.point.y},target:layout?.targets.get(r.id),phase:r.pose?JSON.parse(r.pose).phase:null,clusterId:layout?.labels.get(r.id)??-1,spawning:!!r.birth}));}
  return Object.freeze({ sync, keepPosition, resumeFromDrag, replay, tick, dispose, snapshot });
}

module.exports = { FRAME_MS, HOME_REST_MS, clampBounds, homeTarget, exploreTarget, stepToward, createSubagentMotion };
