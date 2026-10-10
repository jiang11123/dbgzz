import type { BrowserView } from 'electron';
import fs from 'node:fs';

import { attachmentDomScript } from './attachment-dom';
import { assertVisibleImage } from './image-data';

// Keep attachment order while ignoring transparent placeholders and DOM layers.
export const chatImagesScript = (kind: 'draft' | 'latest' | 'loaded') => `(() => {
  ${attachmentDomScript}
  if(!input) throw new Error('未找到来源聊天输入框');
  const candidates=collect();
  let selected=candidates.filter(item=>${JSON.stringify(kind)}==='draft'?isDraft(item):!isDraft(item));
  if(${JSON.stringify(kind)}==='latest' && selected.length){
    const last=selected[selected.length-1].node.closest(messages);
    selected=last?selected.filter(item=>last.contains(item.node)):[selected[selected.length-1]];
  }
  if(selected.length>12) throw new Error('当前范围超过12张图片，请选最近一条消息或只加载需要的记录');
  return selected.map((item,i)=>({src:item.src,name:item.node.alt || '聊天图片-'+(i+1),original:item.node.closest('a[href]')?.href}));
})()`;

export const draftImageStateScript = `(async() => {
  ${attachmentDomScript}
  if(!input) return {count:0,loading:true,failed:false};
  const images=collect().filter(isDraft);
  await Promise.all(images.filter(item=>item.background).map(async item=>{
    const img=new Image();img.src=item.src;
    await Promise.race([img.decode().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,500))]);
    item.ready=img.complete && img.naturalWidth>0 && !transparent(img);
  }));
  let scope=input.parentElement;
  for(let i=0;scope && i<5 && !scope.querySelector('input[type=file]');i++)scope=scope.parentElement;
  const text=scope?.innerText || '';
  return {count:images.filter(item=>item.ready).length,
    loading:images.some(item=>!item.ready) || /上传中|正在上传|处理中/.test(text) || Boolean(scope?.querySelector('[role=progressbar],[aria-busy=true]')),
    failed:/上传失败|图片过大|不支持.*图片/.test(text)};
})()`;

export async function reimportOrderedImages(view: BrowserView, paths: string[]) {
  for(const file of paths) assertVisibleImage(fs.readFileSync(file));
  const initial=await view.webContents.executeJavaScript(draftImageStateScript);
  if(initial.count || initial.loading) throw new Error('目标输入框已有图片，请先处理，避免覆盖或打乱顺序');
  for(let i=0;i<paths.length;i++) {
    const bytes=fs.readFileSync(paths[i]);
    const ext=paths[i].split('.').pop()?.toLowerCase();
    const mime=ext==='jpg' || ext==='jpeg'?'image/jpeg':`image/${ext}`;
    const data=bytes.toString('base64');
    // Prefer the site's native file upload. Synthetic clipboard files can create
    // attachment cards without completing the site's upload pipeline.
    const uploadIndex=await view.webContents.executeJavaScript(`(()=>{
      const input=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0);
      const nodes=[...document.querySelectorAll('input[type=file]')];
      const eligible=n=>!n.disabled && /image|png|jpe?g|webp/i.test(n.accept);
      for(let scope=input?.parentElement;scope;scope=scope.parentElement){
        const file=[...scope.querySelectorAll('input[type=file]')].find(eligible);
        if(file)return nodes.indexOf(file);
      }
      return -1;
    })()`);
    if(uploadIndex>=0){
      const client=view.webContents.debugger;const owned=!client.isAttached();
      try{
        if(owned)client.attach('1.3');
        await view.webContents.executeJavaScript(`document.querySelectorAll('input[type=file]')[${uploadIndex}].value=''`);
        const {root}=await client.sendCommand('DOM.getDocument');
        const {nodeIds}=await client.sendCommand('DOM.querySelectorAll',{nodeId:root.nodeId,selector:'input[type=file]'});
        await client.sendCommand('DOM.setFileInputFiles',{nodeId:nodeIds[uploadIndex],files:[paths[i]]});
      }finally{if(owned && client.isAttached())client.detach();}
    }else{
    // Re-upload the original as a new File via the chat editor's paste handler.
    // This avoids selecting an unrelated hidden file input on complex real pages.
    await view.webContents.executeJavaScript(`(async()=>{
      const input=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0);
      if(!input) throw new Error('未找到目标输入框');input.focus();
      const blob=await (await fetch('data:'+${JSON.stringify(mime)}+';base64,'+${JSON.stringify(data)})).blob();
      const transfer=new DataTransfer();transfer.items.add(new File([blob],${JSON.stringify(`图片-${i+1}.${ext}`)},{type:${JSON.stringify(mime)}}));
      input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
    })()`);
    }
    let confirmed=false;
    for(let attempt=0;attempt<60;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,250));
      const state=await view.webContents.executeJavaScript(draftImageStateScript);
      if(state.failed) throw new Error(`第${i+1}张图片上传失败，已停止同步`);
      if(state.count===i+1 && !state.loading){confirmed=true;break;}
      if(state.count>i+1) throw new Error('目标图片数量发生变化，已停止，避免重复导入');
      if(uploadIndex<0 && attempt===7 && state.count===i && !state.loading) {
        // A site without a paste handler can still use its image-specific upload input.
        const client=view.webContents.debugger;const owned=!client.isAttached();
        try {
          if(owned)client.attach('1.3');
          const index=await view.webContents.executeJavaScript(`(()=>{const nodes=[...document.querySelectorAll('input[type=file]')];const image=nodes.find(n=>!n.disabled && /image|png|jpe?g|webp/i.test(n.accept));return image?nodes.indexOf(image):-1;})()`);
          if(index<0) throw new Error('目标窗口没有可用的图片重新上传入口');
          await view.webContents.executeJavaScript(`document.querySelectorAll('input[type=file]')[${index}].value=''`);
          const {root}=await client.sendCommand('DOM.getDocument');
          const {nodeIds}=await client.sendCommand('DOM.querySelectorAll',{nodeId:root.nodeId,selector:'input[type=file]'});
          await client.sendCommand('DOM.setFileInputFiles',{nodeId:nodeIds[index],files:[paths[i]]});
        } finally {if(owned && client.isAttached())client.detach();}
      }
    }
    if(!confirmed) throw new Error(`未确认第${i+1}张图片进入目标聊天框，已停止。请检查目标窗口，文字尚未发送`);
  }
}
