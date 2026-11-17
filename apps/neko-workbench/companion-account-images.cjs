'use strict';
const {imageMime}=require('./companion-media.cjs');

// Only the private companion channel accepts image bytes. Public, proactive
// and memory channels retain their independent text-only context boundaries.
function decodeAccountImages(messages,namespace){
 let count=0,total=0;
 return messages.map(message=>{
  const images=message.images===undefined?[]:message.images;
  if(!Array.isArray(images)||images.length>4||images.length&&(namespace!=='companion'||message.role!=='user'))throw Error('陪伴聊天图片用途无效。');
  return {...message,images:images.map(image=>{
   if(!image||typeof image.data!=='string'||image.data.length>6*1024*1024||!image.data.length)throw Error('陪伴聊天图片无效或过大。');
   const data=Buffer.from(image.data,'base64');count++;total+=data.length;
   if(data.toString('base64')!==image.data||data.length>4*1024*1024||total>12*1024*1024||count>4)throw Error('陪伴聊天图片超出限制。');
   let mime;try{mime=imageMime(data);}catch{throw Error('陪伴聊天图片格式无效。');}
   if(mime!==image.mime)throw Error('陪伴聊天图片格式无效。');
   return {data,mediaType:mime,name:typeof image.name==='string'?image.name.replace(/[\r\n\0]/g,'').slice(0,100):'图片'};
  })};
 });
}

async function accountImageContent(images,{ctx,signal,loadImageDecoder}){
 if(!images.length)return [];
 const store=ctx.get?.('attachments')||ctx.attachments;
 if(typeof store?.saveImages!=='function')throw Error('陪伴聊天图片服务尚未就绪，请重启工作台。');
 const content=[];
 for(const image of images){
  signal.throwIfAborted();let inputs=[image],frames;
  if(image.mediaType==='image/gif'){
   if(typeof loadImageDecoder!=='function')throw Error('陪伴聊天动图解码服务尚未就绪。');
   const sharp=loadImageDecoder();const meta=await sharp(image.data,{limitInputPixels:16777216,failOn:'error'}).metadata();
   const pages=meta.pages||1;
   if(!Number.isInteger(pages)||pages<1||pages>300)throw Error('陪伴聊天动图帧数超出限制（最多 300 帧）。');
   frames=[...new Set([0,Math.floor((pages-1)/2),pages-1])];inputs=[];
   for(const page of frames){signal.throwIfAborted();const data=await sharp(image.data,{page,pages:1,limitInputPixels:16777216,failOn:'error'}).resize({width:1280,height:1280,fit:'inside',withoutEnlargement:true}).png().toBuffer();inputs.push({data,mediaType:'image/png',name:image.name+' · 第 '+(page+1)+' 帧'});}
   content.push({type:'text',text:'[GIF 动图「'+image.name+'」，共 '+pages+' 帧；以下为按时间排列的 '+frames.length+' 张采样帧（帧号 '+frames.map(n=>n+1).join('、')+'），仅据这些画面理解，不代表完整视频。]'});
  }
  const refs=await store.saveImages(inputs);signal.throwIfAborted();
  if(!Array.isArray(refs)||refs.length!==inputs.length)throw Error('陪伴聊天图片保存失败。');
  for(const attachment of refs)content.push({type:'image',attachment});
 }
 return content;
}
module.exports={decodeAccountImages,accountImageContent};
