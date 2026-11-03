(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkbenchQuestions=api;})(globalThis,function(){
  'use strict';
  const str=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n;
  function normalize(value){
    if(!value||!str(value.sessionId,512)||!str(value.key,1024)||!Number.isSafeInteger(value.revision)||value.revision<1||!['question','plan-review','unsupported'].includes(value.kind))return null;
    if(!Array.isArray(value.questions)||value.questions.length>8||value.kind!=='unsupported'&&!value.questions.length)return null;
    const questions=[],ids=new Set();
    for(const q of value.questions){
      if(!q||!str(q.id,256)||ids.has(q.id)||!str(q.question,8000)||!Array.isArray(q.options)||q.options.length>16||typeof q.detail==='string'&&q.detail.length>30000)return null;
      ids.add(q.id);const options=[];
      for(const o of q.options){if(!o||!str(o.label,2000))return null;options.push({label:o.label,...(typeof o.description==='string'?{description:o.description.slice(0,4000)}:{})});}
      questions.push({id:q.id,question:q.question,header:typeof q.header==='string'?q.header.slice(0,200):'',multiSelect:q.multiSelect===true,options,...(typeof q.detail==='string'?{detail:q.detail.slice(0,30000)}:{})});
    }
    return {sessionId:value.sessionId,key:value.key,revision:value.revision,kind:value.kind,questions,canAnswer:value.canAnswer===true,submitting:value.submitting===true,submitted:value.submitted===true,state:value.state==='continued'?'continued':'open',error:typeof value.error==='string'?value.error.slice(0,240):'',remainingMs:Number.isFinite(value.remainingMs)?Math.max(0,value.remainingMs):null};
  }
  function fingerprint(q){return JSON.stringify([q.sessionId,q.key,q.kind,q.questions]);}
  function answersFor(question,answers){
    if(!question||question.kind==='unsupported'||!Array.isArray(answers)||answers.length!==question.questions.length)return null;
    const seen=new Set(),result=[];
    for(const a of answers){
      const q=question.questions.find(q=>q.id===a?.id);
      if(!q||seen.has(q.id)||!Array.isArray(a.selected)||a.selected.length>q.options.length||a.selected.some(label=>typeof label!=='string'||!q.options.some(o=>o.label===label))||new Set(a.selected).size!==a.selected.length)return null;
      if(a.custom!==undefined&&(typeof a.custom!=='string'||a.custom.length>8000))return null;
      const custom=a.custom?.trim();if(!q.multiSelect&&(a.selected.length>1||custom&&a.selected.length))return null;
      seen.add(q.id);result.push({id:q.id,selected:[...a.selected],...(custom?{custom}:{})});
    }
    return result;
  }
  function mount({host,onAction,onVisibility=()=>{},toggleButton,storage}){
    const d=host.ownerDocument,make=(tag,text,cls)=>{const n=d.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
    host.classList.add('compact-questions');host.setAttribute('aria-label','任务选项');
    const header=make('header'),heading=make('strong'),counter=make('small'),close=make('button','×');close.type='button';close.title='收起选项';close.setAttribute('aria-label','收起任务选项');header.append(heading,counter,close);
    const content=make('div',undefined,'cq-content'),status=make('p',undefined,'cq-status'),footer=make('footer'),prev=make('button','‹'),next=make('button','›'),customToggle=make('button','自定义'),skip=make('button','跳过'),submit=make('button','提交');
    for(const b of [prev,next,customToggle,skip,submit])b.type='button';prev.title='上一题';next.title='下一题';submit.className='cq-submit';footer.append(prev,next,customToggle,skip,submit);host.replaceChildren(header,content,status,footer);
    let value=null,open=false,disposed=false,localBusy=false,focused=false,page=0,renderKey='',error='',storageNotice='',identity='';const drafts=new Map();
    if(storage===undefined){try{storage=d.defaultView?.localStorage;}catch{storage=null;}}
    const storageKey=()=>value?'neko.questions.draft.v1:'+encodeURIComponent(value.sessionId)+':'+encodeURIComponent(value.key):'';
    function persist(){
      if(!value)return;try{
        const data=JSON.stringify({signature:identity,page,answers:value.questions.map(q=>({id:q.id,...(drafts.get(identity+'\0'+q.id)||{selected:[],custom:'',customOpen:false,skipped:false})}))});
        if(data.length>512000||!storage)throw Error('unavailable');storage.setItem(storageKey(),data);storageNotice='';
      }catch{storageNotice='选项草稿暂未保存，请保持窗口打开';}
    }
    function restore(){
      try{const saved=JSON.parse(storage?.getItem(storageKey())||'null');if(!saved||saved.signature!==identity||!Array.isArray(saved.answers))return;
        for(const q of value.questions){const a=saved.answers.find(a=>a?.id===q.id);if(!a||!Array.isArray(a.selected)||typeof a.custom!=='string'||a.custom.length>8000||!answersFor({...value,questions:[q]},[{id:q.id,selected:a.selected,...(a.customOpen&&a.custom.trim()?{custom:a.custom}:{})}]))continue;
          drafts.set(identity+'\0'+q.id,{selected:[...a.selected],custom:a.custom,customOpen:a.customOpen===true,skipped:a.skipped===true});}
        if(Number.isSafeInteger(saved.page)&&saved.page>=0&&saved.page<value.questions.length)page=saved.page;
      }catch{}
    }
    const draft=()=>{const q=value?.questions[page];if(!q)return null;const key=identity+'\0'+q.id;if(!drafts.has(key))drafts.set(key,{selected:[],custom:'',customOpen:false,skipped:false});return drafts.get(key);};
    const answered=(q)=>{const a=drafts.get(identity+'\0'+q.id);return !!a&&(a.skipped||a.selected.length>0||a.customOpen&&!!a.custom.trim());};
    function releaseFocus(){if(!focused)return;focused=false;void Promise.resolve(action('blur')).catch(()=>{});}
    function visible(nextOpen){const next=!!value&&nextOpen;if(open!==next){if(!next)releaseFocus();open=next;onVisibility(open,value);}host.hidden=!open;if(toggleButton){toggleButton.hidden=!value;toggleButton.setAttribute('aria-expanded',String(open));toggleButton.title=open?'收起任务选项':'有待回答的任务选项';}}
    async function action(type,extra={}){if(!value||disposed)return;return onAction({type,sessionId:value.sessionId,key:value.key,revision:value.revision,...extra});}
    const engage=()=>{void Promise.resolve(action('engage')).catch(()=>{});};
    function controls(){
      const busy=localBusy||value?.submitting||value?.submitted,disabled=busy||!value?.canAnswer;
      host.setAttribute('aria-busy',String(!!busy));
      for(const n of content.querySelectorAll('button,textarea'))n.disabled=value?.kind==='unsupported'?false:!!disabled;
      prev.disabled=page===0;next.disabled=page>=(value?.questions.length||0)-1;
      customToggle.disabled=skip.disabled=!!disabled;customToggle.hidden=skip.hidden=value?.kind==='unsupported';
      submit.hidden=value?.kind==='unsupported';submit.disabled=!!disabled||!value?.questions.every(answered);
      status.textContent=error||value?.error||storageNotice||(value?.kind==='unsupported'?'请在工作区查看完整问题。':value?.submitted?'已提交，等待会话确认…':!value?.canAnswer?'正在等待回答通道…':value?.state==='continued'?'已继续工作，仍可回答':'');status.hidden=!status.textContent;
      counter.textContent=value?`${Math.min(page+1,value.questions.length)} / ${value.questions.length}`:'';
      if(value?.remainingMs!==null&&value?.remainingMs!==undefined)counter.textContent+=' · '+Math.ceil(value.remainingMs/1000)+'s';
    }
    function render(){
      if(!value){visible(false);content.replaceChildren();renderKey='';return;}
      const q=value.questions[page],a=draft();heading.textContent=q?.header||'选择任务';
      const key=JSON.stringify([identity,page,a?.selected,a?.customOpen,a?.skipped]);
      if(key!==renderKey){
        renderKey=key;const nodes=[];
        if(value.kind==='unsupported'){
          const b=make('button','在工作区查看完整问题');b.type='button';b.addEventListener('click',()=>{void Promise.resolve(action('open')).catch(()=>{error='未能打开工作区，请稍后重试';controls();});});nodes.push(b);
        }else if(q){
          const title=make('p',q.question,'cq-question');title.title=q.question;nodes.push(title);
          if(q.detail){const detail=make('details'),summary=make('summary','查看完整内容');detail.append(summary,make('pre',q.detail));nodes.push(detail);}
          const choices=make('div',undefined,'cq-choices');
          q.options.forEach((o,index)=>{const b=make('button',o.label,'cq-option');b.type='button';b.title=o.description||o.label;b.dataset.option=String(index);b.setAttribute('aria-pressed',String(a.selected.includes(o.label)&&!a.skipped));b.addEventListener('click',()=>{if(localBusy||!value?.canAnswer||value.submitted)return;a.skipped=false;if(q.multiSelect)a.selected=a.selected.includes(o.label)?a.selected.filter(x=>x!==o.label):[...a.selected,o.label];else{a.selected=[o.label];a.customOpen=false;}persist();engage();render();content.querySelector(`[data-option="${index}"]`)?.focus();});choices.append(b);});nodes.push(choices);
          if(a.customOpen){const input=make('textarea');input.setAttribute('aria-label','输入你的答案');input.placeholder='输入你的答案';input.maxLength=8000;input.rows=2;input.value=a.custom;input.addEventListener('input',()=>{a.custom=input.value;a.skipped=false;if(!q.multiSelect)a.selected=[];persist();engage();controls();});nodes.push(input);}
        }
        content.replaceChildren(...nodes);
      }
      visible(open);controls();
    }
    close.addEventListener('click',()=>visible(false));toggleButton?.addEventListener('click',()=>{visible(!open);render();});
    prev.addEventListener('click',()=>{if(page>0){page--;persist();render();}});next.addEventListener('click',()=>{if(page<value.questions.length-1){page++;persist();render();}});
    customToggle.addEventListener('click',()=>{const a=draft();if(!a)return;a.customOpen=!a.customOpen;a.skipped=false;if(a.customOpen&&!value.questions[page].multiSelect)a.selected=[];persist();engage();render();content.querySelector('textarea')?.focus();});
    skip.addEventListener('click',()=>{const a=draft();if(!a)return;a.skipped=true;engage();if(page<value.questions.length-1)page++;persist();render();});
    submit.addEventListener('click',async()=>{
      if(submit.disabled||!value)return;const expected=identity;
      const answers=answersFor(value,value.questions.map(q=>{const a=drafts.get(identity+'\0'+q.id);return {id:q.id,selected:a.skipped?[]:[...a.selected],...(!a.skipped&&a.customOpen&&a.custom.trim()?{custom:a.custom.trim()}:{})};}));
      if(!answers)return;localBusy=true;error='';controls();
      try{const result=await action('answer',{answers});if(result?.ok===false)throw Error('回答未确认，请核对后重试');}
      catch{if(identity===expected)error='回答未确认，请核对后重试';}
      finally{if(identity===expected){localBusy=false;controls();}}
    });
    const focus=()=>{if(!open||focused||disposed)return;focused=true;void Promise.resolve(action('focus')).catch(()=>{});};
    host.addEventListener('focusin',focus);
    host.addEventListener('focusout',event=>{if(!host.contains(event.relatedTarget))releaseFocus();});
    const windowFocus=()=>{if(host.contains(d.activeElement))focus();};d.defaultView?.addEventListener('blur',releaseFocus);d.defaultView?.addEventListener('focus',windowFocus);
    host.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopPropagation();visible(false);}});
    return {update(next){if(disposed)return;const normalized=normalize(next),nextIdentity=normalized?fingerprint(normalized):'';if(nextIdentity!==identity)releaseFocus();value=normalized;if(nextIdentity!==identity){identity=nextIdentity;page=0;renderKey='';localBusy=false;error='';storageNotice='';if(drafts.size>128)drafts.clear();if(value)restore();visible(!!value);}if(!value)visible(false);render();},show(){visible(true);render();},hide(){visible(false);},isOpen:()=>open,dispose(){releaseFocus();disposed=true;value=null;visible(false);d.defaultView?.removeEventListener('blur',releaseFocus);d.defaultView?.removeEventListener('focus',windowFocus);host.replaceChildren();drafts.clear();}};
  }
  return Object.freeze({normalize,fingerprint,answersFor,mount});
});
