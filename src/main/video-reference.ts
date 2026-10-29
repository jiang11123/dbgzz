import type { BrowserView } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** Composer 定位逻辑（观察与清理脚本共用，保持单一来源）。 */
const videoReferenceLocatorScript = String.raw`
  const visible=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none' && !n.closest('[aria-hidden=true]');};
  const messages='[data-message-id],[data-message-role],[data-testid*=message],article,aside,nav,header';
  const editors=[...document.querySelectorAll('[contenteditable=true],textarea')].filter(n=>visible(n) && !n.disabled && !n.closest(messages));
  const eligible=n=>!n.disabled && (!n.accept || /image|png|jpe?g|webp|apng|gif/i.test(n.accept));
  let file=null;
  let scope=null,multiple=false;
  for(let n=editors.length?editors[0]:null,parent=n?n.parentElement:null,level=0;parent && parent!==document.body && parent!==document.documentElement && level<20;n=parent,parent=n.parentElement,level++){
    if(parent.querySelector('[data-testid=message-list],[data-testid=message_list]'))break;
    const found=[...parent.querySelectorAll('input[type=file]')].filter(eligible);
    if(found.length>1){multiple=true;break;}
    if(found.length===1){scope=parent;file=found[0];break;}
  }
  // Real Doubao video composer evidence: [data-testid=attachment_area] wraps
  // [data-testid=attachment-image-card], which holds the decoded <img>, a
  // [role=progressbar][aria-valuenow] while uploading, and the delete button once committed.
  // The attachment strip is not always inside the ancestor that owns the file input, so fall
  // back to the one strip that sits directly above this composer.
  let area=scope ? scope.querySelector('[data-testid=attachment_area]') : null;
  if(!area && scope){
    const editorRect=editors[0].getBoundingClientRect();
    const strips=[...document.querySelectorAll('[data-testid=attachment_area]')].filter(strip=>{
      const rect=strip.getBoundingClientRect();
      return rect.width>0 && rect.height>0 && rect.bottom<=editorRect.top+8 && editorRect.top-rect.bottom<480 && rect.right>editorRect.left-40 && rect.left<editorRect.right+40;
    });
    if(strips.length===1)area=strips[0];
    else if(strips.length>1)area=strips.sort((a,b)=>Math.abs(a.getBoundingClientRect().bottom-editorRect.top)-Math.abs(b.getBoundingClientRect().bottom-editorRect.top))[0];
  }
`;

/** No send/paste fallback: a preview or populated FileList is not an upload receipt. */
export const videoReferenceDomScript = videoReferenceLocatorScript + String.raw`
  let state={count:0,ready:0,loading:false,failed:false,error:''};
  if(!editors.length){
    state.error='视频参考图：未找到作曲器输入框';
  } else {
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
  }`;

/** 逐个点击残留附件的删除按钮；返回本轮点击数（0 = 没有可点的删除按钮）。 */
export const videoReferenceClearScript = "(()=>{" + videoReferenceLocatorScript + String.raw`
  let cleared=0;
  if(area){
    for(const button of [...area.querySelectorAll('[data-testid=attachment-delete-btn]')]){
      try{button.click();cleared+=1;}catch(error){break;}
    }
  }
  return cleared;
})()`;

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

/**
 * 豆包 3.0：composer 里残留的附件（上次任务未发送/中断留下）会挡住本次参考图。
 * 自动逐个点删除按钮清空；等当前上传结束、清不掉时才抛错（消息里保留人工指引）。
 */
async function clearExistingAttachments(view: BrowserView, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // 卡片先渲染、删除按钮晚 1~2 帧才出现：连续多轮都点不到才判失败，避免对渲染时序零容忍造成误报。
  // （固定轮数：默认 pollMs=200ms 时约 1s 宽限，不被小 pollMs 放大成分钟级。）
  const BUTTON_RENDER_GRACE_ROUNDS = 5;
  let emptyClickRounds = 0;
  // 没有卡片但残留"上传失败"文案：等提示自行消失（通常是即时 toast），只给有限耐心。
  const FAILED_BANNER_GRACE_ROUNDS = 10;
  let failedBannerRounds = 0;
  // 页面瞬间跳转/重渲染会让 evaluate 短暂失败：有限重试，不立刻中止清理。
  let readFailures = 0;
  while (Date.now() < deadline) {
    let state: VideoReferenceState;
    try {
      state = await readState(view);
      readFailures = 0;
    } catch (error) {
      readFailures += 1;
      if (readFailures > 5) throw error;
      await pause(pollMs);
      continue;
    }
    if (state.count === 0 && !state.loading && !state.failed) return;
    if (state.loading) {
      // 附件还在上传中：等它落定（commit 或 fail）再删，此时点删除不可靠。
      await pause(pollMs);
      continue;
    }
    if (state.count === 0 && state.failed) {
      failedBannerRounds += 1;
      if (failedBannerRounds >= FAILED_BANNER_GRACE_ROUNDS) {
        throw new Error('视频参考图：残留的"上传失败"提示长时间未消失，请打开豆包窗口手动处理后重试');
      }
      await pause(pollMs);
      continue;
    }
    const raw = await view.webContents.executeJavaScript(videoReferenceClearScript);
    const clicked = Number(raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>) ? (raw as { value: unknown }).value : raw) || 0;
    if (clicked === 0) {
      emptyClickRounds += 1;
      if (emptyClickRounds >= BUTTON_RENDER_GRACE_ROUNDS) {
        throw new Error('视频参考图：作曲器已有 ' + state.count + ' 个残留附件且无法自动清理（连续 ' + emptyClickRounds + ' 轮未找到删除按钮），请打开豆包窗口手动删除后重试');
      }
    } else {
      emptyClickRounds = 0;
    }
    await pause(pollMs);
  }
  throw new Error('视频参考图：清理残留附件超时，请打开豆包窗口手动处理后重试');
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

  // Mode/settings changes can briefly unmount the composer. Reuse the strict upload locator.
  const composerDeadline = Date.now() + Math.min(timeoutMs, 15_000);
  let initial: VideoReferenceState;
  for (;;) {
    try { initial = await readState(view); break; }
    catch (error) {
      if (view.webContents.isDestroyed() || Date.now() >= composerDeadline
        || !(error instanceof Error) || !/未找到作曲器输入框|没有唯一的 composer 图片上传入口/.test(error.message)) throw error;
      await pause(pollMs);
    }
  }
  if (initial.failed || initial.loading || initial.count > 0) {
    await clearExistingAttachments(view, timeoutMs, pollMs);
  }

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
