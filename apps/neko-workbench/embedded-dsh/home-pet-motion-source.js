// Local room interaction, not model/tool execution. Only the authoritative
// home bridge commits movement; hidden or manually controlled rooms stay idle.
function homePetClear(items,x,z){
 if(!Number.isFinite(x)||!Number.isFinite(z)||Math.abs(x)>4.1||Math.abs(z)>3.1)return false;
 return !(items||[]).some(o=>{if(o.kind==='rug'||o.y>1.35)return false;const r=o.rotation*Math.PI/180,dx=x-o.x,dz=z-o.z;return Math.abs(dx*Math.cos(r)-dz*Math.sin(r))<o.width/2+.2&&Math.abs(dx*Math.sin(r)+dz*Math.cos(r))<o.depth/2+.2;});
}
function homePetPathClear(items,a,b){const distance=Math.hypot(b.x-a.x,b.z-a.z),steps=Math.max(1,Math.ceil(distance/.06));for(let i=1;i<=steps;i++)if(!homePetClear(items,a.x+(b.x-a.x)*i/steps,a.z+(b.z-a.z)*i/steps))return false;return true;}
function createHomePetMotion({getState,move,onActivity,blocked=()=>false,now=Date.now,random=Math.random}){
 let goal=null,nextAt=now()+3000,lastMove=0,running=false,disposed=false,enabled=true;
 const pause=(ms=15000)=>{goal=null;nextAt=now()+ms;};
 async function tick(){
  if(disposed||running)return;const state=getState(),a=state?.avatar,time=now();
  if(!enabled||!a?.atHome||state.perspective!=='orbit'||blocked()){pause(3000);return;}
  if(time<nextAt)return;
  if(!goal){
   if(random()<.45){for(let i=0;i<30;i++){const p={x:(random()-.5)*7.6,z:(random()-.5)*5.6};if(Math.hypot(p.x-a.position.x,p.z-a.position.z)>.7&&homePetPathClear(state.items,a.position,p)){goal=p;break;}}}
   if(!goal){onActivity(random()<.7?'action':'idle');nextAt=time+4000+random()*8000;return;}
   onActivity('move');lastMove=time-1000;
  }
  if(time-lastMove<1000)return;lastMove=time;
  const dx=goal.x-a.position.x,dz=goal.z-a.position.z,distance=Math.hypot(dx,dz),amount=Math.min(.45,distance);
  const to={x:a.position.x+dx/distance*amount,z:a.position.z+dz/distance*amount};
  if(distance<.08||!homePetPathClear(state.items,a.position,to)){goal=null;onActivity('idle');nextAt=time+3000+random()*5000;return;}
  running=true;try{await move({action:'avatar_walk',dx:to.x-a.position.x,dz:to.z-a.position.z});}catch{pause(10000);onActivity('idle');}finally{running=false;}
 }
 return {tick,pause,setEnabled(value){enabled=value===true;pause(1000);onActivity('idle');},dispose(){disposed=true;goal=null;}};
}
