'use strict';
const form=document.getElementById('settings'),sendTime=document.getElementById('sendTime'),style=document.getElementById('style'),save=document.getElementById('save'),result=document.getElementById('result');
let ready=false;
function show(value){sendTime.value=value.sendTime;style.value=value.style;}
window.communityDailySettings.read().then(value=>{show(value);ready=true;save.disabled=false;result.textContent='设置只影响之后的日常，不会重复发送今天已提交的内容。';}).catch(()=>{result.textContent='设置读取失败，请关闭后重试。';});
form.addEventListener('submit',async event=>{
 event.preventDefault();if(!ready||save.disabled||!form.reportValidity())return;
 save.disabled=true;result.textContent='正在保存…';
 try{show(await window.communityDailySettings.save({sendTime:sendTime.value,style:style.value}));result.textContent='已保存。开启自动分享后，会按这个时间和风格发送。';}
 catch{result.textContent='未能保存，请检查发送时间与内容风格后重试。';}
 finally{save.disabled=false;}
});
