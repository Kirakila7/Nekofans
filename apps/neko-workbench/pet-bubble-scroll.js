(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PetBubbleScroll=api;})(globalThis,function(){
  'use strict';
  function install(bubble){
    const doc=bubble.ownerDocument,win=doc.defaultView;
    const content=doc.createElement('div');content.className='pet-bubble-content';content.tabIndex=0;
    content.setAttribute('role','region');content.setAttribute('aria-label','大肥鱼回复全文');
    const controls=doc.createElement('div');controls.className='pet-bubble-scroll-controls';controls.setAttribute('aria-label','回复滚动');
    function button(label,symbol,direction){const b=doc.createElement('button');b.type='button';b.textContent=symbol;b.title=label;b.setAttribute('aria-label',label);b.addEventListener('click',()=>{content.scrollTop+=direction*Math.max(24,Math.floor(content.clientHeight*.8));update();});controls.appendChild(b);return b;}
    const up=button('向上滚动回复','↑',-1),down=button('向下滚动回复','↓',1);
    bubble.replaceChildren(content,controls);bubble.classList.add('has-scroll-controls');
    let text='',frame=null,disposed=false;
    function update(){
      if(disposed)return;
      const overflow=content.scrollHeight>content.clientHeight+1;
      controls.hidden=!overflow;up.disabled=!overflow||content.scrollTop<=1;down.disabled=!overflow||content.scrollTop+content.clientHeight>=content.scrollHeight-1;
    }
    function schedule(){if(frame!==null)win.cancelAnimationFrame(frame);frame=win.requestAnimationFrame(()=>{frame=null;update();});}
    const observer=typeof win.ResizeObserver==='function'?new win.ResizeObserver(schedule):null;observer?.observe(bubble);observer?.observe(content);
    content.addEventListener('scroll',update);win.addEventListener('resize',schedule);
    return Object.freeze({render(value){const next=String(value||'');if(next!==text){const top=next.startsWith(text)?content.scrollTop:0;content.textContent=next;content.scrollTop=top;text=next;}schedule();},dispose(){disposed=true;observer?.disconnect();if(frame!==null)win.cancelAnimationFrame(frame);content.removeEventListener('scroll',update);win.removeEventListener('resize',schedule);}});
  }
  return Object.freeze({install});
});
