'use strict';
const {validImageDataUrl}=require('./pet-appearance.js');
async function decodeAnimationPoster(BrowserWindow,dataUrl){
  if(!validImageDataUrl({dataUrl}))throw Error('动图数据无效');
  const window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,partition:'pet-image-decoder'}});
  let timer;
  try{
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
    await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; connect-src \'none\'; frame-src \'none\'"><title>形象图片解码</title>'));
    // Chromium decodes animated GIF/WebP; nativeImage cannot decode every
    // animated input. The sandbox receives only a bounded raster data URL.
    const decode=window.webContents.executeJavaScript(`(async()=>{const image=new Image();image.src=${JSON.stringify(dataUrl)};await image.decode();const width=image.naturalWidth,height=image.naturalHeight;if(!width||!height||width>2048||height>2048)throw Error('invalid dimensions');const ratio=Math.min(1,512/Math.max(width,height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);return {width,height,stillDataUrl:canvas.toDataURL('image/png')};})()`);
    const result=await Promise.race([decode,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('decode timeout')),10000);})]);
    if(!Number.isInteger(result?.width)||!Number.isInteger(result?.height)||result.width<1||result.height<1||result.width>2048||result.height>2048||!result.stillDataUrl?.startsWith('data:image/png;base64,')||!validImageDataUrl({dataUrl:result.stillDataUrl}))throw Error('invalid decoded image');
    return result;
  }catch(cause){throw new Error('动图未能解码，请选择不超过 2048 像素的 GIF 或 WebP',{cause});}
  finally{clearTimeout(timer);if(!window.isDestroyed())window.destroy();}
}
module.exports={decodeAnimationPoster};
