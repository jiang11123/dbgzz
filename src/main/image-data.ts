import { nativeImage } from 'electron';

export function assertVisibleImage(bytes: Buffer) {
  const image=nativeImage.createFromBuffer(bytes);
  if(image.isEmpty()) throw new Error('图片文件无法解码，请重新选择原图');
  const pixels=image.toBitmap();
  for(let i=3;i<pixels.length;i+=4) if(pixels[i]>0) return;
  throw new Error('读取到的是透明占位图，未同步。请从图片资产重新添加原图后重试');
}

/** Identify the actual file format, rather than trusting a browser MIME label. */
export function decodeImageData(src:string){
  const match=/^data:([^,]*),([A-Za-z0-9+/=\r\n]+)$/i.exec(src);
  if(!match || !/(?:^|;)base64(?:;|$)/i.test(match[1]))throw new Error('图片读取结果不是可用的文件数据');
  const bytes=Buffer.from(match[2],'base64');
  if(!bytes.length || bytes.length>30*1024*1024)throw new Error('参考图片过大或为空');
  let extension:string;
  if(bytes.length>=8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))extension='png';
  else if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255)extension='jpg';
  else if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii')))extension='gif';
  else if(bytes.subarray(0,4).toString('ascii')==='RIFF' && bytes.subarray(8,12).toString('ascii')==='WEBP')extension='webp';
  else throw new Error('当前图片格式暂不支持重新导入，请使用 PNG、JPG、WEBP 或 GIF 原图');
  return {bytes,extension};
}

export function browserPngScript(src:string){
  return `(async()=>{
    const response=await fetch(${JSON.stringify(src)});const blob=await response.blob();
    const bitmap=await createImageBitmap(blob);
    try {
      if(!bitmap.width || !bitmap.height || bitmap.width*bitmap.height>40000000)throw new Error('图片尺寸过大，无法转换');
      const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
      const context=canvas.getContext('2d');if(!context)throw new Error('图片转换不可用');context.drawImage(bitmap,0,0);
      return canvas.toDataURL('image/png');
    }finally{bitmap.close();}
  })()`;
}

export function imageDataDiagnostic(src:string){
  const match=/^data:([^,]*),(.*)$/s.exec(src);
  if(!match)return {type:'not-data-url',length:src.length};
  const payload=match[2];
  const bytes=Buffer.from(payload.slice(0,64),'base64');
  return {type:match[1].split(';')[0].slice(0,60),length:src.length,header:bytes.subarray(0,12).toString('hex')};
}
export function renderedPngScript(src:string){
  return `(async()=>{
    const image=[...document.querySelectorAll('img')].find(n=>(n.currentSrc || n.src)===${JSON.stringify(src)} && n.complete && n.naturalWidth>0);
    if(!image)throw new Error('未找到已加载的网页图片');
    if(image.naturalWidth*image.naturalHeight>40000000)throw new Error('图片尺寸过大');
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const context=canvas.getContext('2d');if(!context)throw new Error('无法读取已显示图片');
    context.drawImage(image,0,0);return canvas.toDataURL('image/png');
  })()`;
}
