(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PetChatPresentation=api;})(globalThis,function(){
  'use strict';
  function createReplyPresenter(feedback){
    let shownReply,shownNotice,active=false;
    function reset(){const changed=active;active=false;shownReply=shownNotice=undefined;if(changed)feedback.showLocal('');return changed;}
    function render(actor){
      active=true;
      const reply=actor.screenReply||actor.chatReply,text=typeof reply?.text==='string'?reply.text:'';
      const key=reply?JSON.stringify([reply.id,text,reply.streaming]):null;
      const notice=actor.notice,noticeId=notice?.id;
      const changed=key!==shownReply,noticeChanged=noticeId!==shownNotice;
      shownReply=key;shownNotice=noticeId;
      // A failed turn must not replace its error with an empty or older reply.
      if(notice?.text){if(noticeChanged)feedback.showLocal(notice.text,{persistent:true});return;}
      if(changed||noticeChanged)feedback.showLocal(text,{persistent:!!text});
    }
    return Object.freeze({render,reset});
  }
  return Object.freeze({createReplyPresenter});
});
