import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { BrowserView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Account } from '../shared/types';
import type { ImageAssetStore } from './image-assets';
import type { CanvasBridge } from './canvas-bridge';
import { assertVisibleImage, browserPngScript, decodeImageData, imageDataDiagnostic, renderedPngScript } from './image-data';
import { chatImagesScript, reimportOrderedImages } from './chat-images';
import { assertEmptyDraft, clickComposerSend, ensureComposerMode, prepareText, waitForComposer } from './page-composer';

type Runtime = {
  accounts: () => Account[];
  views: Map<number, BrowserView>;
  current: () => BrowserView | null;
  main: () => BrowserWindow | null;
  rendererUrl: () => string;
  preload: string;
  bridge: () => CanvasBridge | null;
  assets: () => ImageAssetStore;
  upload: (ids: string[], accountId: number) => Promise<boolean>;
  staged: Map<number, string[]>;
  stagedUrls: Map<number, string>;
  openAccount: (id: number, background?: boolean) => BrowserView | null;
};

export function setupAccountSend(runtime: Runtime) {
  const sendingAccounts = new Set<number>();
  let imageSyncWindow: BrowserWindow | null=null;
  let imageSyncDraft: (SendDraft & {id:string;targetId:number;kind:string;warning?:string}) | null=null;
  const accountFor = (view: BrowserView | null) => [...runtime.views].find(([, item]) => item === view)?.[0] ?? null;
  const validView = (id: number) => {
    const view = runtime.views.get(id);
    if (!view || view.webContents.isDestroyed() || view.webContents.isLoading()) throw new Error('请先打开账号聊天页面，并等待加载完成');
    return view;
  };
  const saveImages = (references: { src: string; name?: string }[]) => {
    const folder = path.join(app.getPath('userData'), 'shared-image-import'); fs.mkdirSync(folder, { recursive: true });
    const ids: string[] = [];
    for (const reference of references.slice(0, 12)) {
      const {bytes,extension}=decodeImageData(reference.src);
      assertVisibleImage(bytes);
      const originalName = path.basename(reference.name || `参考图-${randomUUID()}`);
      const safeName = `${path.parse(originalName).name}.${extension}`;
      const file = path.join(folder, `${randomUUID()}-${safeName.replace(/[<>:"/\\|?*]/g, '_')}`);
      try { fs.writeFileSync(file, bytes); const item = runtime.assets().import([file], true)[0]; ids.push(item.id); }
      finally { fs.rmSync(file, { force: true }); }
    }
    return ids;
  };
  async function readImageFiles(view:BrowserView,references:{src:string;name?:string}[]) {
    const ids:string[]=[];
    for(const reference of references) {
      let src=reference.src;
      try{decodeImageData(src);}catch{
        try{src=await view.webContents.executeJavaScript(browserPngScript(src));}
        catch(error){
          const detail=imageDataDiagnostic(src);
          fs.appendFileSync(path.join(app.getPath('userData'),'image-sync-diagnostics.jsonl'),JSON.stringify({time:new Date().toISOString(),stage:'browser-convert',...detail,error:String(error).slice(0,300)})+'\n');
          throw new Error(`图片读取失败：类型=${detail.type}，文件头=${detail.header || '无'}；转换错误=${String(error).slice(0,180)}。可从菜单打开按顺序重导入口`);
        }
      }
      ids.push(...saveImages([{...reference,src}]));
    }
    return ids;
  }
  const report = (error: unknown) => runtime.main()?.webContents.send('browser:error', error instanceof Error ? error.message : String(error));
  async function targetView(id: number, visible = true) {
    const view = runtime.openAccount(id, !visible);
    if (!view) throw new Error('目标账号已不存在');
    await waitForComposer(view); return view;
  }
  type SendDraft = { sourceAccountId: number; sourceUrl: string; prompt: string; assetIds: string[]; warning?:string };
  async function sendToAccount(captured: SendDraft, targetId: number, send: boolean) {
    const target=runtime.accounts().find(a=>a.id===targetId);
    if (!target || !runtime.accounts().some(a=>a.id===captured.sourceAccountId)) throw new Error('来源或目标账号已不存在');
    if (!captured.prompt && !captured.assetIds.length) throw new Error('请先读取图片或填写消息');
    if (targetId===captured.sourceAccountId) throw new Error('请选择其他账号，当前账号可直接左键发送');
    if (sendingAccounts.has(targetId) || runtime.bridge()?.isBusy(targetId)) throw new Error('目标账号正在处理任务，请等待完成');
    sendingAccounts.add(targetId);
    try {
      const view=await targetView(targetId);
      await assertEmptyDraft(view);
      await ensureComposerMode(view,{mode:'chat'});
      if (captured.assetIds.length) await reimportOrderedImages(view,captured.assetIds.map(id=>runtime.assets().resolve(id)));
      if (captured.prompt) await prepareText(view,captured.prompt);
      if (send) {
        await clickComposerSend(view,captured.prompt);
        const source=runtime.views.get(captured.sourceAccountId);
        if(source && !source.webContents.isDestroyed() && source.webContents.getURL()===captured.sourceUrl) {
          await source.webContents.executeJavaScript(`(() => {
            const input=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0);
            if(!input || (input.value || input.innerText || '').trim()!==${JSON.stringify(captured.prompt)}) return;
            if(input instanceof HTMLTextAreaElement) Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,''); else input.textContent='';
            input.dispatchEvent(new Event('input',{bubbles:true}));
          })()`);
        }
      }
      runtime.main()?.webContents.send('account-send:status',send ? `已发送到 ${target.name} 的窗口` : `已放入 ${target.name} 的输入框，请检查后发送`);
    } finally { sendingAccounts.delete(targetId); }
  }
  const popup = (items: MenuItemConstructorOptions[]) => {
    const owner=runtime.main(); if(owner && !owner.isDestroyed()) Menu.buildFromTemplate(items).popup({window:owner});
  };
  ipcMain.on('account-send:context',(event,value:{prompt:string;references:{src:string;name?:string}[];previewCount?:number;x:number;y:number})=>{
    const source=runtime.current(); const sourceId=accountFor(source);
    if (!source || !sourceId || source.webContents.id!==event.sender.id) return;
    void (async()=>{
      if (typeof value.prompt!=='string' || value.prompt.length>50000) throw new Error('发送内容无效或过长');
      const references=Array.isArray(value.references)?value.references:[];
      // The preload's raw <img> count includes transparent/overlapping layers.
      // Use the same logical previews used by extraction and upload confirmation.
      const previews=await source.webContents.executeJavaScript(chatImagesScript('draft')) as {src:string}[];
      const previewCount=previews.length;
      let assets:string[]=[];
      let readError='';
      // Asset imports retain the original files independently of the site's preview
      // markup. Missing thumbnails must not silently turn an image draft into text.
      const staged = runtime.stagedUrls.get(sourceId)===source.webContents.getURL() ? runtime.staged.get(sourceId) || [] : [];
      const library=runtime.assets().list();
      const named=references.map(ref=>staged.find(id=>library.find(a=>a.id===id)?.name===ref.name));
      if(references.length && named.every(Boolean))assets=named as string[];
      else if(references.length){try{assets=await readImageFiles(source,references);}catch(error){readError=String(error);}}
      // Read visible draft attachments automatically when original file inputs or
      // staged assets are unavailable. Do not copy unrelated images from history.
      if (readError || (previewCount && (assets.length || staged.length) !== previewCount) || (!assets.length && !staged.length)) {
        try {
          const draftImages = await readOrderedImages(sourceId, 'draft');
          if (draftImages.length) { assets = draftImages; readError = ''; }
        } catch (error) { readError = String(error); }
      }
      if(!assets.length && !staged.length && value.previewCount && !previewCount) readError='只读取到透明占位图，请重新添加原图后重试';
      const incomplete=Boolean(readError || (previewCount && (assets.length || staged.length)!==previewCount));
      const captured:SendDraft={sourceAccountId:sourceId,sourceUrl:source.webContents.getURL(),prompt:value.prompt,
        assetIds:assets.length?assets:staged,warning:readError};
      const accounts=runtime.accounts().filter(a=>a.id!==sourceId);
      popup([
        {label:`同步聊天消息到其他账号 · ${captured.assetIds.length} 张图片${readError?' · 图片读取失败':''}`,enabled:false},
        ...accounts.map(account=>{
          const locked=sendingAccounts.has(account.id)||runtime.bridge()?.isBusy(account.id);
          return {label:`${account.name}${locked?' · 忙碌':''}`,enabled:!locked,submenu:[
            {label:'发送到此账号',enabled:!incomplete,click:()=>void sendToAccount(captured,account.id,true).catch(report)},
            {label:'同步到此账号',enabled:!incomplete,click:()=>void sendToAccount(captured,account.id,false).catch(report)},
          ]};
        }),
        ...(!accounts.length?[{label:'没有其他账号，请先在顶部添加账号',enabled:false}]:[]),
      ]);
    })().catch(report);
  });
  async function readOrderedImages(sourceId:number,kind:'draft'|'latest'|'loaded') {
    const view=validView(sourceId);
    const images: {src:string;name:string;original?:string}[]=await view.webContents.executeJavaScript(chatImagesScript(kind));
    const ids:string[]=[];
    for(const [index,image] of images.entries()) {
      let src=await view.webContents.executeJavaScript(`(async()=>{
        const urls=${JSON.stringify([image.original,image.src].filter(Boolean))};
        for(const url of urls){try{
          const response=await fetch(url);if(!response.ok)continue;const blob=await response.blob();
          if(blob.size>30*1024*1024 || (blob.type && !blob.type.startsWith('image/') && blob.type!=='application/octet-stream'))continue;
          return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
        }catch{}}
        throw new Error('第${index+1}张聊天图片无法读取，请打开原图后重试');
      })()`);
      try{ids.push(...await readImageFiles(view,[{src,name:image.name}]));}
      catch(original){
        try{src=await view.webContents.executeJavaScript(renderedPngScript(image.src));ids.push(...saveImages([{src,name:image.name}]));}
        catch(fallback){throw new Error(`${String(original)}；读取已显示图片失败：${String(fallback).slice(0,200)}`);}
      }
    }
    return ids;
  }
  async function openImageSync(captured:SendDraft,targetId:number) {
    // Always show the preview even if one reader fails. The fallback controls must
    // remain reachable instead of sending the user back to the same failing path.
    let ids:string[]=[];let kind='draft';let warning=captured.warning || '';
    try {
      ids=await readOrderedImages(captured.sourceAccountId,'draft');
      if(!ids.length && !captured.assetIds.length){ids=await readOrderedImages(captured.sourceAccountId,'latest');kind='latest';}
    }catch(error){warning=String(error);}
    imageSyncDraft={...captured,id:randomUUID(),assetIds:ids.length?ids:captured.assetIds,targetId,kind,warning};
    if(imageSyncWindow && !imageSyncWindow.isDestroyed()){imageSyncWindow.show();imageSyncWindow.focus();imageSyncWindow.webContents.send('message-sync:changed');return;}
    imageSyncWindow=new BrowserWindow({parent:runtime.main() ?? undefined,width:960,height:740,title:'按顺序重新导入聊天图片',autoHideMenuBar:true,backgroundColor:'#f7f9fc',webPreferences:{preload:runtime.preload,contextIsolation:true,sandbox:true,nodeIntegration:false}});
    const url=new URL(runtime.rendererUrl());url.searchParams.set('panel','message-sync');
    void imageSyncWindow.loadURL(url.toString());imageSyncWindow.on('closed',()=>{imageSyncWindow=null;});
  }
  ipcMain.on('account-send:failed', (event, message: string) => {
    if ([...runtime.views.values()].some(view => !view.webContents.isDestroyed() && view.webContents.id === event.sender.id)) runtime.main()?.webContents.send('browser:error', `读取发送内容失败：${String(message).slice(0, 200)}。请检查输入内容和参考图后，重新右键发送按钮。`);
  });
  // Only the local renderer may issue privileged account-send commands.
  const handle = (name: string, fn: (...args: any[]) => any) => ipcMain.handle(name, (event, ...args) => {
    if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('只能在工作站窗口操作');
    return fn(...args);
  });
  handle('message-sync:state',()=>({draft:imageSyncDraft,accounts:runtime.accounts(),images:imageSyncDraft?.assetIds.map(id=>runtime.assets().list().find(a=>a.id===id)) || []}));
  handle('message-sync:read',async(kind:'draft'|'latest'|'loaded')=>{
    if(!imageSyncDraft || !['draft','latest','loaded'].includes(kind))throw new Error('请重新打开图片同步预览');
    const source=validView(imageSyncDraft.sourceAccountId);
    if(source.webContents.getURL()!==imageSyncDraft.sourceUrl)throw new Error('来源聊天已切换，请重新读取');
    const ids=await readOrderedImages(imageSyncDraft.sourceAccountId,kind);
    imageSyncDraft={...imageSyncDraft,id:randomUUID(),assetIds:ids,kind,warning:''};return true;
  });
  handle('message-sync:submit',async(request:{id:string;targetId:number;assetIds:string[];send:boolean})=>{
    const captured=imageSyncDraft;
    if(!captured || captured.id!==request.id)throw new Error('图片预览已更新，请重新检查');
    if(!Array.isArray(request.assetIds) || !request.assetIds.length || request.assetIds.some(id=>!captured.assetIds.includes(id)))throw new Error('请先读取并选择要重新导入的图片');
    await sendToAccount({...captured,assetIds:request.assetIds},request.targetId,Boolean(request.send));return true;
  });
}
