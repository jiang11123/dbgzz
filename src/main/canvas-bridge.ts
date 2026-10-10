import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserView } from 'electron';
import type { Account } from '../shared/types';
import { ensureComposerMode, readComposerSettings, selectPageSetting } from './page-composer';

export type CanvasBridgeStatus =
  | 'queued' | 'assigned' | 'submitting' | 'generating' | 'downloading'
  | 'completed' | 'needs_attention' | 'failed' | 'cancelled';

type CanvasReference = { src: string; mediaType?: 'image' | 'video'; name?: string };
export type CanvasTaskRequest = { targetAccountId?: number; sourceAccountId?: number; sharedChatId?: string; sourceUrl?: string; sourceDraftText?: string; referencePaths?: string[]; prompt?: string; model?: string; ratio?: string; referenceAssets?: CanvasReference[] };

export type CanvasBridgeTask = {
  id: string;
  targetAccountId?: number;
  sourceAccountId?: number;
  sharedChatId?: string;
  sourceUrl?: string;
  sourceDraftText?: string;
  videoBaseline?: string[];
  prompt: string;
  ratio: string;
  model?: string;
  status: CanvasBridgeStatus;
  statusText: string;
  accountId: number | null;
  pageUrl: string | null;
  referencePaths: string[];
  videoPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type Runtime = {
  accounts: () => Account[];
  openAccount: (accountId: number) => BrowserView | null;
  viewForAccount: (accountId: number) => BrowserView | null;
  onTaskChanged: () => void;
};

const terminal = new Set<CanvasBridgeStatus>(['completed', 'needs_attention', 'failed', 'cancelled']);
const contentType = (filePath: string) => /\.webm$/i.test(filePath) ? 'video/webm' : /\.mov$/i.test(filePath) ? 'video/quicktime' : 'video/mp4';

export function pickAvailableAccount(accounts: Account[], busyAccountIds: Set<number>) {
  const preferredAccounts = accounts.filter((account) => account.isLoggedIn && account.name.includes('旺仔'));
  if (preferredAccounts.length > 0) {
    return preferredAccounts.find((account) => !busyAccountIds.has(account.id)) ?? null;
  }
  const candidates = accounts
    .filter((account) => account.isLoggedIn && !busyAccountIds.has(account.id));
  return candidates[0] ?? null;
}

export function shouldRecoverTaskPage(currentUrl: string, taskUrl: string | null, attempts: number) {
  return Boolean(taskUrl && currentUrl !== taskUrl && attempts < 1);
}

function json(response: ServerResponse, code: number, value: unknown) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (Buffer.concat(chunks).length > 12 * 1024 * 1024) throw new Error('请求过大');
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as CanvasTaskRequest;
}

function imageExtension(dataUrl: string) {
  const mime = /^data:([^;,]+)/i.exec(dataUrl)?.[1]?.toLowerCase() ?? 'image/png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'png';
}

function writeReferences(root: string, taskId: string, references: CanvasReference[]) {
  const directory = path.join(root, taskId);
  mkdirSync(directory, { recursive: true });
  return references
    .filter((reference) => reference.mediaType !== 'video' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(reference.src))
    .slice(0, 12)
    .map((reference, index) => {
      const encoded = reference.src.slice(reference.src.indexOf(',') + 1);
      const destination = path.join(directory, `reference-${index + 1}.${imageExtension(reference.src)}`);
      writeFileSync(destination, Buffer.from(encoded, 'base64'));
      return destination;
    });
}

async function runInPage(view: BrowserView, script: string) {
  if (!view.webContents || view.webContents.isDestroyed()) throw new Error('豆包网页已关闭');
  return view.webContents.executeJavaScript(script, true);
}

export async function uploadReferences(view: BrowserView, paths: string[], confirmPreview = false) {
  if (!paths.length) return;
  const target = await runInPage(view, `(() => {
    const inputs=[...document.querySelectorAll('input[type=file]')];
    const eligible=inputs.filter(n=>!n.disabled && (!n.accept || /image|png|jpg|jpeg|webp/i.test(n.accept)));
    const input=eligible.find(n=>/image|png|jpg|jpeg|webp/i.test(n.accept)) || eligible[0];
    return input ? { index:inputs.indexOf(input), multiple:input.multiple } : null;
  })()`);
  if (!target) throw new Error('未找到参考图上传控件');
  if (paths.length > 1 && !target.multiple) throw new Error('执行账号当前上传入口一次只支持一张参考图');
  const debuggerClient = view.webContents.debugger;
  const owned = !debuggerClient.isAttached();
  try {
    if (owned) debuggerClient.attach('1.3');
    const { root } = await debuggerClient.sendCommand('DOM.getDocument');
    const { nodeIds } = await debuggerClient.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector:'input[type=file]' });
    const nodeId=nodeIds[target.index];
    if (!nodeId) throw new Error('未找到参考图上传控件');
    // Reusing the same original file must trigger the site's upload handler again.
    await runInPage(view, `document.querySelectorAll('input[type=file]')[${target.index}].value=''`);
    await debuggerClient.sendCommand('DOM.setFileInputFiles', { files: paths, nodeId });
  } finally { if (owned && debuggerClient.isAttached()) debuggerClient.detach(); }
  // Allow page upload handlers to start before checking their visible state.
  await new Promise(resolve=>setTimeout(resolve,1000));
  for (let attempt=0;attempt<60;attempt++) {
    const state = await runInPage(view, `(() => {
      const input=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0);
      let scope=input?.parentElement;
      for(let level=0;scope && level<6;level++,scope=scope.parentElement) {
        if(scope.querySelector('input[type=file]') || scope.querySelector('button[aria-label*=发送]')) break;
      }
      const text=scope?.innerText || '';
      if (/上传失败|图片过大|不支持.*图片/.test(text)) return 'failed';
      if (/上传中|正在上传|图片处理中/.test(text) || scope?.querySelector('[role=progressbar],[aria-busy=true]')) return 'loading';
      if (${confirmPreview}) {
        const rect=input?.getBoundingClientRect();
        const previews=[...(scope?.querySelectorAll('img') || [])].filter(n=>{
          const r=n.getBoundingClientRect();
          return rect && r.width>20 && r.height>20 && r.bottom>=rect.top-360 && r.top<=rect.bottom+120
            && !n.closest('[data-message-id],[data-message-role],article') && n.complete && n.naturalWidth>0;
        });
        if(previews.length<${paths.length}) return 'loading';
      }
      return 'ready';
    })()`);
    if (state==='failed') throw new Error('参考图片上传失败，请在执行账号检查');
    if (state==='ready') return;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('参考图片上传超时，请在执行账号检查');
}

async function openVideoGenerationWorkspace(view: BrowserView) {
  let outcome: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    outcome = await runInPage(view, `(() => {
      const button = Array.from(document.querySelectorAll('button,[role=button]')).find((node) => /视频生成/.test((node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, '')));
      if (!(button instanceof HTMLElement)) return { ok: false };
      button.click();
      return { ok: true };
    })()`);
    if ((outcome as { ok?: boolean })?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  if (!(outcome as { ok?: boolean }).ok) throw new Error((outcome as { reason?: string }).reason || '无法进入视频生成页');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const ready = await runInPage(view, `(() => {
    const composer = document.querySelector('[role=textbox][contenteditable=true], [role=textbox], [contenteditable=true]');
    const labels = Array.from(document.querySelectorAll('button')).map((node) => (node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, '')).filter(Boolean).slice(0, 40);
    return { ready: composer instanceof HTMLElement, labels };
  })()`);
  if (!(ready as { ready?: boolean }).ready) {
    throw new Error(`未成功进入视频生成模式（可见按钮：${((ready as { labels?: string[] }).labels || []).slice(0, 8).join('、')}）`);
  }
}

async function selectDoubaoVideoModel(view: BrowserView, model?: string) {
  if (!model) return;
  const label = model === 'seedance-2-mini' ? 'Seedance 2.0 Mini' : model === 'seedance-2-fast' ? 'Seedance 2.0 Fast' : model;
  await selectPageSetting(view, 'model', label);
}
async function selectDoubaoVideoAspectRatio(view: BrowserView, ratio: string) {
  await selectPageSetting(view, 'ratio', ratio);
}


async function submitToDoubao(view: BrowserView, task: CanvasBridgeTask) {
  const fillOutcome = await runInPage(view, `(() => {
    try {
      const text = ${JSON.stringify(task.prompt)};
      const candidates = Array.from(document.querySelectorAll('[role=textbox][contenteditable=true],[role=textbox],[contenteditable=true],textarea'))
        .filter((node) => node instanceof HTMLElement && !node.closest('[aria-hidden=true]') && !(node instanceof HTMLTextAreaElement && node.disabled));
      const input = candidates[0];
      const labels = Array.from(document.querySelectorAll('button')).map((node) => (node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, '')).filter(Boolean).slice(0, 30);
      if (!input) return { ok: false, reason: '未找到提示词输入框（页面可能未登录、尚未打开视频创作页，或正在显示验证）', labels };
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, '');
      } else {
        input.focus();
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, labels };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  })()`) as { ok?: boolean; reason?: string; labels?: string[] };
  if (!fillOutcome.ok) return fillOutcome;
  await view.webContents.insertText(task.prompt);
  await new Promise((resolve) => setTimeout(resolve, 650));
  const target = await runInPage(view, `(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((node) =>
      !node.hasAttribute('disabled') && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0
    );
    const input = Array.from(document.querySelectorAll('[role=textbox][contenteditable=true],[role=textbox],[contenteditable=true],textarea'))
      .find((node) => node instanceof HTMLElement && !node.closest('[aria-hidden=true]'));
    const inputRect = input instanceof HTMLElement ? input.getBoundingClientRect() : null;
    const composerSubmit = inputRect
      ? buttons
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.left >= inputRect.right - 140 && rect.top >= inputRect.top - 120 && rect.bottom <= inputRect.bottom + 120;
          })
          .sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            return rightRect.right - leftRect.right || rightRect.bottom - leftRect.bottom;
          })[0]
      : null;
    const labelled = buttons.find((node) => /生成视频|立即生成|开始生成/.test((node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, '')));
    const primary = composerSubmit || labelled || buttons.filter((node) => /bg-dbx-text-highlight/.test(String(node.className))).pop();
    if (!(primary instanceof HTMLElement)) {
      return { ok: false, reason: '未找到视频模式的提交按钮', labels: buttons.map((node) => (node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, '')).filter(Boolean).slice(-12) };
    }
    const rect = primary.getBoundingClientRect();
    return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (!(target as { ok?: boolean }).ok) return target;
  const point = target as { x: number; y: number };
  view.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  view.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return runInPage(view, `(() => {
    const prompt = ${JSON.stringify(task.prompt)};
    const draft = Array.from(document.querySelectorAll('[role=textbox][contenteditable=true],[role=textbox],[contenteditable=true],textarea,input')).some((node) => {
      const value = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : node.textContent || '';
      return value.trim() === prompt.trim();
    });
    const posted = Array.from(document.querySelectorAll('body *')).some((node) => {
      if (node.closest('[contenteditable=true],textarea,input')) return false;
      return (node.textContent || '').includes(prompt);
    });
    if (draft) return { ok: false, reason: '豆包未确认发送，提示词仍停留在输入框' };
    return posted ? { ok: true } : { ok: false, reason: '豆包未确认提交，聊天记录中没有出现本次提示词' };
  })()`);
}

export class CanvasBridge {
  private server = createServer((request, response) => void this.handle(request, response));
  private tasks = new Map<string, CanvasBridgeTask>();
  private busyAccountIds = new Set<number>();
  private downloadSources = new Map<string, string>();
  private downloadPaths = new Map<string, string>();
  private exhaustedAccountIds = new Set<number>();
  private videoBaselines = new Map<string, string[]>();
  private downloadBaselines = new Map<string, number>();
  private taskPageRecoveryAttempts = new Map<string, number>();
  private readonly uploadRoot: string;
  private readonly taskStorePath: string;

  constructor(private readonly runtime: Runtime, userDataPath: string) {
    this.uploadRoot = path.join(userDataPath, 'canvas-bridge-references');
    this.taskStorePath = path.join(userDataPath, 'canvas-bridge-tasks.json');
    this.restoreTasks();
  }

  start(port = 3219) {
    this.server.listen(port, '127.0.0.1');
    setTimeout(() => this.dispatchNextQueuedTask(), 0);
  }
  stop() { this.server.close(); }
  list() { return [...this.tasks.values()].map(task => ({ ...task })); }
  isBusy(id: number) { return this.busyAccountIds.has(id); }
  task(id: string) { return this.tasks.get(id) ?? null; }

  completeFromDownload(accountId: number, videoPath: string) {
    const task = [...this.tasks.values()].find(candidate => candidate.accountId === accountId && candidate.status === 'downloading' && this.downloadPaths.get(candidate.id) === videoPath);
    if (!task || !existsSync(videoPath)) return false;
    this.update(task, { status: 'completed', statusText: task.sourceAccountId ? '视频已返回共享工作区' : '视频已下载并可回写画布', videoPath, error: null });
    this.busyAccountIds.delete(accountId);
    this.dispatchNextQueuedTask();
    return true;
  }

  trackDownload(accountId: number, sourceUrl: string, filePath: string) {
    const task = [...this.tasks.values()].find(candidate => candidate.accountId === accountId && candidate.status === 'downloading' && this.downloadSources.get(candidate.id) === sourceUrl);
    if (task) this.downloadPaths.set(task.id, filePath);
  }

  failDownload(accountId: number, filePath: string) {
    const task = [...this.tasks.values()].find(candidate => candidate.accountId === accountId && this.downloadPaths.get(candidate.id) === filePath);
    if (!task) return;
    this.update(task, { status: 'needs_attention', statusText: '视频下载失败，请在执行账号重新下载并关联结果', error: '下载被中断' });
    this.busyAccountIds.delete(accountId); this.dispatchNextQueuedTask();
  }

  attachResult(id: string, videoPath: string) {
    const task = this.task(id);
    if (!task || !existsSync(videoPath)) throw new Error('任务或视频文件不存在');
    if (!['generating', 'downloading', 'needs_attention'].includes(task.status)) throw new Error('该任务当前不能关联结果');
    Object.assign(task, { status: 'completed' as const, statusText: '已手动关联视频结果', videoPath, error: null, updatedAt: new Date().toISOString() });
    if (task.accountId) this.busyAccountIds.delete(task.accountId);
    this.persistTasks(); this.runtime.onTaskChanged(); this.dispatchNextQueuedTask();
  }

  async tryDownloadCompletedVideo(accountId: number) {
    const task = [...this.tasks.values()].find(candidate => candidate.accountId === accountId && ['generating', 'downloading'].includes(candidate.status));
    if (!task) return false;
    if (Date.now() - Date.parse(task.createdAt) > 30 * 60 * 1000 || (task.status === 'downloading' && Date.now() - Date.parse(task.updatedAt) > 3 * 60 * 1000)) {
      this.update(task, { status: 'needs_attention', statusText: '等待生成或下载超时，请检查执行账号并手动关联结果', error: '未能确认视频结果' });
      this.busyAccountIds.delete(accountId); this.dispatchNextQueuedTask(); return false;
    }
    if (task.status === 'downloading') return false;
    const view = this.runtime.viewForAccount(accountId);
    if (!view?.webContents || view.webContents.isDestroyed()) return false;
    try {
      const currentUrl = view.webContents.getURL();
      const attempts = this.taskPageRecoveryAttempts.get(task.id) ?? 0;
      if (shouldRecoverTaskPage(currentUrl, task.pageUrl, attempts)) {
        this.taskPageRecoveryAttempts.set(task.id, attempts + 1);
        this.update(task, { statusText: '豆包页面意外回到首页，正在恢复本次任务页面' });
        await view.webContents.loadURL(task.pageUrl as string);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      } else if (task.pageUrl && currentUrl !== task.pageUrl) {
        this.busyAccountIds.delete(accountId);
        this.update(task, {
          status: 'needs_attention',
          statusText: '豆包任务页已丢失，已停止重复刷新；请在豆包确认是否已生成后重新从画布提交',
          error: '任务页未能恢复，桥接没有确认到已提交的豆包消息',
        });
        this.dispatchNextQueuedTask();
        return false;
      }
      const pageState = await runInPage(view, `(() => (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(-6000))()`);
      const message = String(pageState);
      if (/免费次数用完|额度不足|创作额度.*不足|暂时无法使用.*视频|视频生成失败|生成失败/.test(message)) {
        this.busyAccountIds.delete(accountId);
        this.exhaustedAccountIds.add(accountId);
        this.update(task, { status: 'needs_attention', statusText: '豆包账号当前无可用视频额度，请切换有额度账号后重试', error: '豆包页面提示：当前账号视频生成额度不足或不可用' });
        return false;
      }
      const videoSource = await runInPage(view, `(() => {
        const videos = Array.from(document.querySelectorAll('video'));
        const baseline = ${JSON.stringify(this.videoBaselines.get(task.id) ?? [])};
        const latest = videos.filter(v => !baseline.includes(v.currentSrc || v.src)).at(-1);
        return latest ? (latest.currentSrc || latest.src || latest.querySelector('source')?.src || '') : '';
      })()`);
      if (typeof videoSource === 'string' && videoSource) {
        this.downloadSources.set(task.id, videoSource);
        this.update(task, { status: 'downloading', statusText: '正在下载豆包生成的视频' });
        if (videoSource.startsWith('blob:')) {
          const clicked = await runInPage(view, `(() => {
            const video = Array.from(document.querySelectorAll('video')).at(-1);
            const source = video?.currentSrc || video?.src || video?.querySelector('source')?.src;
            if (!source) return false;
            const anchor = document.createElement('a'); anchor.href = source; anchor.download = 'doubao-video.mp4'; anchor.style.display = 'none';
            document.body.appendChild(anchor); anchor.click(); anchor.remove(); return true;
          })()`);
          if (clicked) this.update(task, { status: 'downloading', statusText: '正在下载豆包生成的视频' });
          return Boolean(clicked);
        }
        if (/^https?:\/\//.test(videoSource)) {
          view.webContents.downloadURL(videoSource);
          return true;
        }
      }
      if (/你的视频生成好了/.test(message)) {
        const opened = await runInPage(view, `(() => {
          const complete = Array.from(document.querySelectorAll('*')).filter((node) => (node.textContent || '').trim() === '你的视频生成好了。').at(-1);
          if (!complete) return false;
          let scope = complete.parentElement;
          for (let level = 0; scope && level < 7; level += 1, scope = scope.parentElement) {
            const media = Array.from(scope.querySelectorAll('video,img,[role=button],button,a')).reverse().find((node) => {
              const rect = node.getBoundingClientRect();
              return rect.width > 80 && rect.height > 40;
            });
            if (!(media instanceof HTMLElement)) continue;
            const target = media.closest('button,a,[role=button]') || media;
            target.click();
            return true;
          }
          return false;
        })()`);
        if (opened) return false;
      }
      const outcome = await runInPage(view, `(() => {
        const buttons = [...document.querySelectorAll('button,a')].filter((node) => {
          const label = (node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, '');
          return /下载(视频)?|保存视频/.test(label) && !node.hasAttribute('disabled');
        });
        const baseline = ${JSON.stringify(this.downloadBaselines.get(task.id) ?? 0)};
        if (buttons.length <= baseline) return false;
        const item = buttons[buttons.length - 1];
        item.click();
        return true;
      })()`);
      if (outcome) this.update(task, { status: 'downloading', statusText: '正在下载豆包生成的视频' });
      return Boolean(outcome);
    } catch {
      return false;
    }
  }

  private update(task: CanvasBridgeTask, patch: Partial<CanvasBridgeTask>) {
    if (terminal.has(task.status) && patch.status && patch.status !== task.status) return;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.persistTasks();
    this.runtime.onTaskChanged();
  }

  private dispatchNextQueuedTask() {
    const next = [...this.tasks.values()].find(task => task.status === 'queued' && (!task.targetAccountId || !this.busyAccountIds.has(task.targetAccountId))); 
    if (next) void this.dispatch(next);
  }

  private restoreTasks() {
    try {
      const persisted = JSON.parse(readFileSync(this.taskStorePath, 'utf8')) as CanvasBridgeTask[];
      for (const task of persisted) {
        if (!task?.id) continue;
        delete (task as CanvasBridgeTask & { duration?: number }).duration;
        if (task.status === 'queued') {
          this.tasks.set(task.id, task);
          continue;
        }
        if (task.status === 'completed' && task.videoPath && existsSync(task.videoPath)) {
          this.tasks.set(task.id, task);
          continue;
        }
        if (!task.accountId || !['generating', 'downloading'].includes(task.status)) continue;
        this.tasks.set(task.id, task);
        this.busyAccountIds.add(task.accountId);
        this.videoBaselines.set(task.id, task.videoBaseline || []);
      }
    } catch {
      // No prior bridge task state is normal on a first launch.
    }
  }

  private persistTasks() {
    const directory = path.dirname(this.taskStorePath);
    mkdirSync(directory, { recursive: true });
    writeFileSync(this.taskStorePath, JSON.stringify([...this.tasks.values()], null, 2), 'utf8');
  }

  async create(body: CanvasTaskRequest) {
    const prompt = body.prompt?.trim() ?? '';
    if (!prompt) throw new Error('缺少视频提示词');
    const id = `canvas-video-${randomUUID()}`;
    const task: CanvasBridgeTask = { id, targetAccountId: body.targetAccountId, sourceAccountId: body.sourceAccountId, sharedChatId: body.sharedChatId, sourceUrl: body.sourceUrl, sourceDraftText: body.sourceDraftText, prompt, model: body.model, ratio: /^\d+:\d+$/.test(body.ratio || '') ? body.ratio! : '16:9', status: 'queued', statusText: '等待分配豆包账号', accountId: null, pageUrl: null, referencePaths: [], videoPath: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    task.referencePaths = [...(body.referencePaths ?? []), ...writeReferences(this.uploadRoot, id, body.referenceAssets ?? [])];
    this.tasks.set(id, task);
    this.persistTasks();
    void this.dispatch(task);
    return task;
  }

  private async dispatch(task: CanvasBridgeTask) {
    const unavailableAccountIds = new Set([...this.busyAccountIds, ...this.exhaustedAccountIds]);
    const account = task.targetAccountId
      ? this.runtime.accounts().find(a => a.id === task.targetAccountId && a.platform === 'doubao')
      : pickAvailableAccount(this.runtime.accounts(), unavailableAccountIds);
    if (account && this.busyAccountIds.has(account.id)) { this.update(task, { status: 'queued', statusText: `等待 ${account.name} 完成前一个任务` }); return; }
    if (!account) {
      if (task.targetAccountId) { this.update(task, { status: 'needs_attention', statusText: '执行账号不存在或不是豆包账号', error: '请选择可用的豆包执行账号' }); return; }
      const hasPreferredAccount = this.runtime.accounts().some((candidate) => candidate.isLoggedIn && candidate.name.includes('旺仔'));
      this.update(task, hasPreferredAccount
        ? { status: 'queued', statusText: '旺仔账号正在生成其他视频，任务将自动排队', error: null }
        : { status: 'needs_attention', statusText: '没有可用的已登录豆包账号', error: '没有可用账号' });
      return;
    }
    this.busyAccountIds.add(account.id);
    this.update(task, { status: 'assigned', statusText: `已分配账号：${account.name}`, accountId: account.id });
      const view = this.runtime.viewForAccount(account.id) ?? this.runtime.openAccount(account.id);
    if (!view) {
      this.busyAccountIds.delete(account.id);
      this.update(task, { status: 'needs_attention', statusText: '无法打开已登录的豆包工作台页面', error: '无法打开豆包页面' });
      return;
    }
    try {
      this.update(task, { status: 'submitting', statusText: '正在向豆包工作台提交任务' });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (task.targetAccountId && task.targetAccountId !== task.sourceAccountId) {
        const draft = await runInPage(view, `(() => { const input=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0); return input ? (input.value || input.innerText || '').trim() : ''; })()`);
        if (draft) throw new Error('执行账号已有未发送草稿，请先处理该草稿再重试');
      }
      if (task.targetAccountId) await ensureComposerMode(view, { mode: 'video' });
      else await openVideoGenerationWorkspace(view);
      await selectDoubaoVideoModel(view, task.model);
      await selectDoubaoVideoAspectRatio(view, task.ratio);
      const existingDownloads = await runInPage(view, `(() => [...document.querySelectorAll('button,a')].filter((node) => /下载(视频)?|保存视频/.test((node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, ''))).length)()`);
      this.downloadBaselines.set(task.id, Number(existingDownloads) || 0);
      const baseline = await runInPage(view, `Array.from(document.querySelectorAll('video')).map(v => v.currentSrc || v.src)`);
      this.videoBaselines.set(task.id, baseline); this.update(task, { videoBaseline: baseline });
      await uploadReferences(view, task.referencePaths);
      view.webContents.send('account-send:bypass', true);
      const outcome = await submitToDoubao(view, task) as unknown as { ok?: boolean; reason?: string; labels?: string[] };
      if (!outcome?.ok) {
        const labels = Array.isArray(outcome?.labels) ? `（当前可见按钮：${outcome.labels.slice(0, 8).join('、')}）` : '';
        throw new Error(`${outcome?.reason || '页面提交未完成'}${labels}`);
      }
      this.update(task, { status: 'generating', statusText: '豆包正在生成视频', pageUrl: view.webContents.getURL() });
    } catch (error) {
      this.busyAccountIds.delete(account.id);
      this.update(task, { status: 'needs_attention', statusText: `需要在豆包窗口处理：${error instanceof Error ? error.message : '页面自动化失败'}`, error: error instanceof Error ? error.message : '页面自动化失败' });
    } finally { if (!view.webContents.isDestroyed()) view.webContents.send('account-send:bypass', false); this.dispatchNextQueuedTask(); }
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url || '/', 'http://127.0.0.1:3219');
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { ok: true, service: 'doubao-workspace-canvas-bridge', queued: [...this.tasks.values()].filter((task) => !terminal.has(task.status)).length }); return;
    }
    if (request.method === 'GET' && url.pathname === '/accounts') {
      json(response, 200, { accounts: this.runtime.accounts().map((account) => ({ id: account.id, name: account.name, isLoggedIn: account.isLoggedIn, busy: this.busyAccountIds.has(account.id) })) }); return;
    }
    if (request.method === 'POST' && url.pathname === '/tasks') {
      try { const body = await requestBody(request); delete body.referencePaths; const task = await this.create(body); json(response, 202, { task }); } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : '创建任务失败' }); }
      return;
    }
    const taskMatch = /^\/tasks\/([^/]+)(?:\/(video|cancel|screenshot))?$/.exec(url.pathname);
    if (!taskMatch) { json(response, 404, { error: '未找到接口' }); return; }
    const task = this.task(decodeURIComponent(taskMatch[1]));
    if (!task) { json(response, 404, { error: '未找到任务' }); return; }
    if (request.method === 'GET' && taskMatch[2] === 'video') {
      if (task.status !== 'completed' || !task.videoPath || !existsSync(task.videoPath)) { json(response, 409, { error: '视频尚未完成' }); return; }
      response.writeHead(200, { 'Content-Type': contentType(task.videoPath), 'Content-Length': String(require('node:fs').statSync(task.videoPath).size), 'Cache-Control': 'no-store' });
      createReadStream(task.videoPath).pipe(response); return;
    }
    if (request.method === 'GET' && taskMatch[2] === 'screenshot') {
      const view = task.accountId ? this.runtime.viewForAccount(task.accountId) : null;
      if (!view?.webContents || view.webContents.isDestroyed()) { json(response, 409, { error: '豆包页面不可用' }); return; }
      const snapshot = await view.webContents.capturePage();
      const image = snapshot.toPNG();
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(image.length) });
      response.end(image); return;
    }
    if (request.method === 'POST' && taskMatch[2] === 'cancel') {
      this.update(task, { status: 'cancelled', statusText: '已取消', error: null }); if (task.accountId) this.busyAccountIds.delete(task.accountId); json(response, 200, { task }); return;
    }
    if (request.method === 'GET' && !taskMatch[2]) { json(response, 200, { task, videoUrl: task.status === 'completed' ? `http://127.0.0.1:3219/tasks/${encodeURIComponent(task.id)}/video` : null }); return; }
    json(response, 405, { error: '不支持的方法' });
  }
}
