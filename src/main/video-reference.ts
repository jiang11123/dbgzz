import type { BrowserView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** No send/paste fallback: a preview or populated FileList is not an upload receipt. */
export const videoReferenceDomScript = String.raw`
  // Returns a plain state object; never throws, so the message survives Electron serialization.
  const visible=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none' && !n.closest('[aria-hidden=true]');};
  const messages='[data-message-id],[data-message-role],[data-testid*=message],article,aside,nav,header';
  const editors=[...document.querySelectorAll('[contenteditable=true],textarea')].filter(n=>visible(n) && !n.disabled && !n.closest(messages));
  const eligible=n=>!n.disabled && (!n.accept || /image|png|jpe?g|webp|apng|gif/i.test(n.accept));
  let file=null;
  let state={count:0,ready:0,loading:false,failed:false,error:''};
  if(!editors.length){
    state.error='视频参考图：未找到作曲器输入框';
  } else {
    const editor=editors[0];
    let scope=null,multiple=false;
    for(let n=editor.parentElement,level=0;n && n!==document.body && n!==document.documentElement && level<20;n=n.parentElement,level++){
      if(n.querySelector('[data-testid=message-list],[data-testid=message_list]'))break;
      const found=[...n.querySelectorAll('input[type=file]')].filter(eligible);
      if(found.length>1){multiple=true;break;}
      if(found.length===1){scope=n;file=found[0];break;}
    }
    // Real Doubao video composer evidence: [data-testid=attachment_area] wraps
    // [data-testid=attachment-image-card], which holds the decoded <img>, a
    // [role=progressbar][aria-valuenow] while uploading, and the delete button once committed.
    // The attachment strip is not always inside the ancestor that owns the file input, so fall
    // back to the one strip that sits directly above this composer.
    let area=scope ? scope.querySelector('[data-testid=attachment_area]') : null;
    if(!area && scope){
      const editorRect=editor.getBoundingClientRect();
      const strips=[...document.querySelectorAll('[data-testid=attachment_area]')].filter(strip=>{
        const rect=strip.getBoundingClientRect();
        return rect.width>0 && rect.height>0 && rect.bottom<=editorRect.top+8 && editorRect.top-rect.bottom<480 && rect.right>editorRect.left-40 && rect.left<editorRect.right+40;
      });
      if(strips.length===1)area=strips[0];
      else if(strips.length>1)area=strips.sort((a,b)=>Math.abs(a.getBoundingClientRect().bottom-editorRect.top)-Math.abs(b.getBoundingClientRect().bottom-editorRect.top))[0];
    }
    const cards=area ? [...area.querySelectorAll('[data-testid=attachment-image-card]')] : [];
    const cardState=cards.map(card=>{
      const image=card.querySelector('img');
      const decoded=Boolean(image && image.complete && image.naturalWidth>0 && image.naturalHeight>0);
      const progress=card.querySelector('[role=progressbar]');
      const percent=Number(progress ? progress.getAttribute('aria-valuenow') : 100);
      const busy=Boolean(progress) || (Number.isFinite(percent) && percent<100) || /上传中|正在上传|处理中/.test(card.innerText||'');
      const failed=/上传失败|图片过大|不支持/.test(card.innerText||'') || Boolean(card.querySelector('[data-kind=error],[data-upload-status=failed]'));
      const committed=Boolean(card.querySelector('[data-testid=attachment-delete-btn],[data-kind=image]')) && !busy;
      return {ready:decoded && committed && !failed,busy,failed};
    });
    const text=area ? (area.innerText || '') : '';
    state={count:cards.length,ready:cardState.filter(c=>c.ready).length,
      loading:cardState.some(c=>c.busy) || /上传中|正在上传|处理中/.test(text) || Boolean(area && area.querySelector('[role=progressbar],[aria-busy=true]')),
      failed:cardState.some(c=>c.failed) || /上传失败|图片过大|不支持/.test(text),error:''};
    if(multiple)state.error='视频参考图：composer 内存在多个图片上传入口';
    else if(!scope || !file)state.error='视频参考图：没有唯一的 composer 图片上传入口（不会使用全页控件）';
  }
`;

/** Serializable, composer-scoped observation, also usable for no-submit diagnostics. */
export const videoReferenceStateScript = "(()=>{" + videoReferenceDomScript + " return state;})()";

export interface VideoReferenceUploadOptions { timeoutMs?: number; pollMs?: number }

interface VideoReferenceState { count: number; ready: number; loading: boolean; failed: boolean; error?: string }

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_POLL_MS = 200;
/** Consecutive healthy polls required before the cards count as committed. */
const STABLE_POLLS = 3;

const IMAGE_MAGIC: number[][] = [
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38],
  [0x52, 0x49, 0x46, 0x46],
];

function assertImageFile(filePath: string): void {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    throw new Error('视频参考图：无法读取文件 ' + path.basename(filePath));
  }
  const supported = IMAGE_MAGIC.some(bytes => bytes.every((value, index) => buffer[index] === value));
  if (!supported) throw new Error('视频参考图：文件格式不支持（仅支持 png/jpeg/webp/gif）：' + path.basename(filePath));
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function readState(view: BrowserView): Promise<VideoReferenceState> {
  const raw = await view.webContents.executeJavaScript(videoReferenceStateScript);
  const state = raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)
    ? (raw as { value: VideoReferenceState }).value
    : (raw as VideoReferenceState);
  if (!state || typeof state.count !== 'number') throw new Error('视频参考图：无法读取作曲器附件状态');
  if (state.error) throw new Error(state.error);
  return { count: state.count, ready: state.ready, loading: Boolean(state.loading), failed: Boolean(state.failed) };
}

/** Resolves the composer file input through CDP so no synthetic change event is required. */
async function attachFiles(view: BrowserView, files: string[]): Promise<void> {
  const debuggerApi = view.webContents.debugger;
  const owned = !debuggerApi.isAttached();
  if (owned) debuggerApi.attach('1.3');
  try {
    const target = await debuggerApi.sendCommand('Runtime.evaluate', {
      // A persisting input value blocks re-selecting the same file, so clear it before selecting.
      expression: "(()=>{" + videoReferenceDomScript + " try{file.value='';}catch(error){void error;} return file;})()",
    }) as { result?: { objectId?: string } };
    const objectId = target?.result?.objectId;
    if (!objectId) throw new Error('视频参考图：无法定位作曲器上传入口');
    await debuggerApi.sendCommand('DOM.getDocument');
    const { nodeId } = await debuggerApi.sendCommand('DOM.requestNode', { objectId }) as { nodeId: number };
    await debuggerApi.sendCommand('Runtime.releaseObject', { objectId });
    await debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId, files });
  } finally {
    if (owned && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

/**
 * Uploads reference images into the video composer and only resolves once every card is
 * committed. Any doubt (no card, still uploading, error state, count drift) throws, so the
 * caller must never fall back to sending text without the references.
 */
export async function uploadVideoReferences(
  view: BrowserView,
  paths: string[],
  options: VideoReferenceUploadOptions = {},
): Promise<void> {
  if (!paths.length) return;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  for (const filePath of paths) assertImageFile(filePath);
  if (!view?.webContents || view.webContents.isDestroyed()) throw new Error('视频参考图：账号窗口已关闭');

  const initial = await readState(view);
  if (initial.failed) throw new Error('视频参考图：作曲器已有附件处于上传失败状态');
  if (initial.loading) throw new Error('视频参考图：作曲器已有附件正在上传（已有附件）');
  if (initial.count > 0) throw new Error('视频参考图：作曲器已有 ' + initial.count + ' 个附件（已有附件），不会覆盖');

  const deadline = Date.now() + timeoutMs;
  for (let index = 0; index < paths.length; index += 1) {
    await attachFiles(view, [paths[index]]);
    const expected = index + 1;
    let appeared = false;
    while (Date.now() < deadline) {
      const state = await readState(view);
      if (state.failed) throw new Error('视频参考图：第 ' + expected + ' 张上传失败');
      if (state.count > expected) throw new Error('视频参考图：附件数量异常（期望 ' + expected + '，实际 ' + state.count + '）');
      if (state.count === expected) { appeared = true; break; }
      await pause(pollMs);
    }
    if (!appeared) throw new Error('未确认第 ' + expected + ' 张视频参考图出现，已停止发送');
  }

  const total = paths.length;
  let committed = false;
  let stable = 0;
  while (Date.now() < deadline) {
    const state = await readState(view);
    if (state.failed) throw new Error('视频参考图：上传失败，已停止发送');
    if (state.count > total) throw new Error('视频参考图：附件数量异常（期望 ' + total + '，实际 ' + state.count + '）');
    if (committed && state.count < total) throw new Error('视频参考图：附件状态发生变化，已停止发送');
    if (state.count === total && state.ready === total) committed = true;
    if (committed && !state.loading && state.count === total && state.ready === total) {
      stable += 1;
      if (stable >= STABLE_POLLS) return;
    } else {
      stable = 0;
    }
    await pause(pollMs);
  }
  throw new Error('未确认第 ' + total + ' 张视频参考图上传完成（超时），已停止发送');
}
