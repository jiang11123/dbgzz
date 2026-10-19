import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserView } from 'electron';
import type { Account } from '../shared/types';
import { ensureComposerMode, readComposerSettings, selectPageSetting, selectVideoDuration, selectDoubaoVideoSettings, prepareText, clickComposerSend, waitForComposer, assertEmptyDraft } from './page-composer';
import { reimportOrderedImages } from './chat-images';
import { pageReplySnapshotScript, createPageReplyBaseline, collectPageReplies, normalizePageReplyText, type PageReplyBaseline, type PageReplySnapshot } from './page-replies';
import { uploadVideoReferences } from './video-reference';
import { submitVideoTask } from './doubao-video';
import { AccountPool, type FailureKind } from './account-pool';

export type CanvasBridgeStatus =
  | 'queued' | 'assigned' | 'submitting' | 'awaiting_reply' | 'awaiting_confirmation' | 'generating' | 'downloading'
  | 'completed' | 'needs_attention' | 'failed' | 'cancelled';

type CanvasReference = { src: string; mediaType?: 'image' | 'video'; name?: string };
export type CanvasTaskRequest = { gatewayThreadId?: string; gatewayReplyMessageId?: number; conversationId?: string; targetAccountId?: number; sourceAccountId?: number; sourceUrl?: string; sourceDraftText?: string; referencePaths?: string[]; prompt?: string; model?: string; ratio?: string; duration?: number; referenceAssets?: CanvasReference[] };

export type CanvasBridgeTask = {
  id: string;
  targetAccountId?: number;
  sourceAccountId?: number;
  sourceUrl?: string;
  sourceDraftText?: string;
  videoBaseline?: string[];
  prompt: string;
  ratio: string;
  model?: string;
  duration?: number;
  status: CanvasBridgeStatus;
  statusText: string;
  accountId: number | null;
  pageUrl: string | null;
  referencePaths: string[];
  latestReply?: string | null;
  latestReplyId?: string;
  replyBaseline?: PageReplyBaseline;
  sentPrompt?: string;
  referenceUploaded?: boolean;
  gatewayThreadId?: string;
  conversationId?: string;
  gatewayReplyMessageId?: number;
  videoPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type Runtime = {
  accounts: () => Account[];
  openAccount: (accountId: number) => BrowserView | null;
  viewForAccount: (accountId: number) => BrowserView | null;
  /** True when the view is attached to a window; capturePage needs that. */
  isViewAttached?: (view: BrowserView) => boolean;
  onTaskChanged: (task?: CanvasBridgeTask) => void;
  downloadHDVideo?: (view: BrowserView, task: CanvasBridgeTask) => Promise<string | null>;
};

export function videoReplyState(text: string): Pick<CanvasBridgeTask, 'status' | 'statusText'> {
  if (/请[^。！？]*确认|[^。！？]*确认[^。！？]*(?:后|再)[^。！？]*(?:生成|开始)|是否[^。！？]*(?:生成|上传|开始)|请[^。！？]*(?:上传|提供|补充)[^。！？]*(?:图片|参考图)/.test(text))
    return { status: 'awaiting_confirmation', statusText: '豆包等待你的回复，请直接在此发送补充消息' };
  if (/正在生成|已开始生成|生成中|正在排队|排队中|预计等待|生成进度/.test(text))
    return { status: 'generating', statusText: '豆包已返回生成进度' };
  return { status: 'awaiting_reply', statusText: '已收到豆包回复，可继续发送消息' };
}

const terminal = new Set<CanvasBridgeStatus>(['completed', 'needs_attention', 'failed', 'cancelled']);
const contentType = (filePath: string) => /\.webm$/i.test(filePath) ? 'video/webm' : /\.mov$/i.test(filePath) ? 'video/quicktime' : 'video/mp4';

const QUOTA_PATTERN = /免费次数用完|额度不足|创作额度.*不足|暂时无法使用|额度已用尽|今日.*上限/;
const CAPTCHA_PATTERN = /710022004|人机验证|安全验证|滑块/;
const SESSION_PATTERN = /未登录|登录已过期|请先登录|会话失效/;

/** Maps a page-level failure message onto the account pool's failure taxonomy. */
export function classifyDispatchFailure(message: string): FailureKind {
  if (CAPTCHA_PATTERN.test(message)) return 'captcha';
  if (QUOTA_PATTERN.test(message)) return 'quota';
  if (SESSION_PATTERN.test(message)) return 'logged_out';
  return 'transient';
}

/** Strips trailing slashes and hash so cosmetic URL drift is not treated as page loss. */
export function normalizeTaskUrl(url: string | null | undefined): string {
  return String(url ?? '').trim().replace(/#.*$/, '').replace(/\/+$/, '');
}

export function shouldRecoverTaskPage(currentUrl: string, taskUrl: string | null, attempts: number) {
  // A doubao video render takes minutes and the page drifts off its task URL while it
  // works (progress views, hash changes, a redirect home). Recover generously, but keep a
  // cap so a genuinely lost page still surfaces to the user instead of looping forever.
  if (!taskUrl) return false;
  return normalizeTaskUrl(currentUrl) !== normalizeTaskUrl(taskUrl) && attempts < 8;
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
      const inputs=[...document.querySelectorAll('[contenteditable=true],textarea,[role=textbox]')].filter(n=>!n.disabled); const input=inputs.find(n=>n.getBoundingClientRect().width>0 || n.offsetWidth>0) || inputs[0];
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

async function selectDoubaoVideoModel(view: BrowserView, model?: string, duration?: number) {
  let targetModel = model;
  if (duration && duration < 10 && (!targetModel || /Seedance\s*2\.5/i.test(targetModel))) {
    targetModel = 'Seedance 2.0 Fast';
  }
  if (!targetModel) return;
  const label = targetModel === 'seedance-2-mini' ? 'Seedance 2.0 Mini' : targetModel === 'seedance-2-fast' ? 'Seedance 2.0 Fast' : targetModel;
  await selectPageSetting(view, 'model', label);
}

export function formatVideoPrompt(prompt: string, ratio?: string, duration?: number, modelOrHasRef?: string | boolean, hasReferenceImages = false): string {
  const trimmed = (prompt || '').trim();
  const hasRef = typeof modelOrHasRef === 'boolean' ? modelOrHasRef : hasReferenceImages;
  const model = typeof modelOrHasRef === 'string' ? modelOrHasRef : undefined;
  let effectiveModel = model;
  if (duration && duration < 10 && (!effectiveModel || /Seedance\s*2\.5/i.test(effectiveModel))) {
    effectiveModel = 'Seedance 2.0 Fast';
  }
  const modelSpec = effectiveModel ? `使用 ${effectiveModel} 模型` : '';
  const ratioSpec = ratio && /^\d+:\d+$/.test(ratio) ? `按比例 ${ratio}` : '';
  const durationSpec = duration && duration > 0 ? `时长 ${duration} 秒` : '';
  const specs = [modelSpec, ratioSpec, durationSpec].filter(Boolean).join('、');
  const specInstruction = specs ? `请${specs}生成，直接开始，无需确认。` : '直接开始生成，无需确认。';

  if (hasRef) {
    if (/参考图|垫图|图生视频|以图生视频/.test(trimmed)) {
      return trimmed.endsWith('。') || trimmed.endsWith('！') ? `${trimmed}${specInstruction}` : `${trimmed}。${specInstruction}`;
    }
    return `请根据参考图生成视频：${trimmed}。${specInstruction}`;
  }

  if (/生成视频|视频生成/.test(trimmed)) {
    return trimmed.endsWith('。') || trimmed.endsWith('！') ? `${trimmed}${specInstruction}` : `${trimmed}。${specInstruction}`;
  }
  return `生成视频：${trimmed}。${specInstruction}`;
}

export async function uploadTaskReferences(view: BrowserView, paths: string[]) {
  if (!paths || !paths.length) return;
  await uploadVideoReferences(view, paths);
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
      return { ok: false, reason: '未找到提交按钮', labels: buttons.map((node) => (node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, '')).filter(Boolean).slice(-12) };
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
  /** Tasks currently inside dispatch(); keeps concurrent triggers from double-dispatching. */
  private dispatchingTasks = new Set<string>();
  private downloadSources = new Map<string, string>();
  private downloadPaths = new Map<string, string>();
  private videoBaselines = new Map<string, string[]>();
  private downloadBaselines = new Map<string, number>();
  /** HD (shareService) attempts per task, so a slow player cannot block the fallback forever. */
  private hdAttempts = new Map<string, number>();
  private taskPageRecoveryAttempts = new Map<string, number>();
  private pollingAccounts = new Set<number>();
  private followingUp = new Set<string>();
  /** Last time the poller actually looked at each task, to spot ghost tasks holding an account. */
  private lastPolledAt = new Map<string, number>();
  private lastPollError: string | null = null;
  private readonly uploadRoot: string;
  private readonly taskStorePath: string;
  private readonly pool: AccountPool;
  private startupError: string | null = null;

  constructor(private readonly runtime: Runtime, userDataPath: string) {
    this.uploadRoot = path.join(userDataPath, 'canvas-bridge-references');
    this.taskStorePath = path.join(userDataPath, 'canvas-bridge-tasks.json');
    this.pool = new AccountPool(path.join(userDataPath, 'account-pool.json'));
    this.restoreTasks();
  }

  /** Last page-evaluation failure seen while polling, for diagnostics. */
  lastPollFailure(): string | null { return this.lastPollError; }
  /**
   * Checks whether a blocked account can serve again, by loading its page.
   *
   * A captcha block is terminal unless something re-tests the account: the pool never
   * picks it, so it can never succeed and can never clear itself. Opening the page is
   * enough — doubao redirects to a verification page when the block is still active, and
   * lands on the chat home when it is not.
   */
  async probeAccount(accountId: number): Promise<{ ok: boolean; reason?: string }> {
    const account = this.runtime.accounts().find(item => item.id === accountId);
    if (!account) return { ok: false, reason: '账号不存在' };
    const view = this.runtime.viewForAccount(accountId) ?? this.runtime.openAccount(accountId);
    if (!view?.webContents || view.webContents.isDestroyed()) return { ok: false, reason: '账号页面不可用' };
    try {
      await view.webContents.loadURL('https://www.doubao.com/chat/');
      await new Promise(resolve => setTimeout(resolve, 2500));
      const state = await runInPage(view, `(() => ({ url: location.pathname, text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) }))()`) as { url: string; text: string };
      const blocked = /人机验证|安全验证|滑块|verify|captcha/i.test(state.url + ' ' + state.text);
      if (blocked) return { ok: false, reason: '账号仍需人机验证' };
      this.pool.markOk(accountId);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  /** Console-facing account pool state: health, cooldown, daily usage. */
  poolSnapshot() { return this.pool.snapshot(this.runtime.accounts(), this.busyAccountIds); }
  clearAccountCooldown(accountId: number) { this.pool.clearCooldown(accountId); this.dispatchNextQueuedTask(); }
  forgetAccount(accountId: number) { this.pool.forget(accountId); }

  start(port = 3219) {
    // Another instance may already own the port. Keep the UI usable and surface
    // the conflict rather than letting an unhandled 'error' event kill the app.
    this.server.on('error', (error: NodeJS.ErrnoException) => {
      this.startupError = error.code === 'EADDRINUSE'
        ? `本地桥接端口 ${port} 已被占用，画布桥接未启动；请关闭其他豆包工作站实例后重启。`
        : `画布桥接启动失败：${error.message}`;
    });
    this.server.listen(port, '127.0.0.1');
    setTimeout(() => this.dispatchNextQueuedTask(), 0);
  }

  /** Non-null when the bridge port could not be bound. */
  get bridgeError() { return this.startupError; }
  stop() { this.server.close(); }
  list() { return [...this.tasks.values()].map(task => ({ ...task })); }
  isBusy(id: number) { return this.busyAccountIds.has(id); }
  /** Live view of accounts currently executing a task, shared with the gateway. */
  busyIds(): ReadonlySet<number> { return this.busyAccountIds; }
  /** The shared account pool, so the gateway and the canvas bridge agree on health. */
  get poolRef(): AccountPool { return this.pool; }
  task(id: string) { return this.tasks.get(id) ?? null; }

  completeFromDownload(accountId: number, videoPath: string) {
    const task = [...this.tasks.values()].find(candidate => candidate.accountId === accountId && candidate.status === 'downloading' && this.downloadPaths.get(candidate.id) === videoPath);
    if (!task || !existsSync(videoPath)) return false;
    this.update(task, { status: 'completed', statusText: task.sourceAccountId ? '视频已返回共享工作区' : '视频已下载并可回写画布', videoPath, error: null });
    this.busyAccountIds.delete(accountId);
    this.pool.markOk(accountId);
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
    if (!['awaiting_reply', 'awaiting_confirmation', 'generating', 'downloading', 'needs_attention'].includes(task.status)) throw new Error('该任务当前不能关联结果');
    Object.assign(task, { status: 'completed' as const, statusText: '已手动关联视频结果', videoPath, error: null, updatedAt: new Date().toISOString() });
    if (task.accountId) this.busyAccountIds.delete(task.accountId);
    this.persistTasks(); this.runtime.onTaskChanged(); this.dispatchNextQueuedTask();
  }

  linkChatTask(taskId: string, threadId: string, replyMessageId: number, resetReply = false) {
    const task = this.task(taskId);
    if (!task) throw new Error('视频任务不存在');
    this.update(task, { gatewayThreadId: threadId, gatewayReplyMessageId: replyMessageId, ...(resetReply ? {latestReply:null,latestReplyId:undefined,statusText:'正在转交补充消息…'} : {}) });
  }

  async confirmTask(taskId: string, text: string): Promise<boolean> {
    const task = this.task(taskId);
    if (!task?.accountId || !task.pageUrl || !text.trim() || !['awaiting_reply', 'awaiting_confirmation', 'generating'].includes(task.status)) return false;
    if (this.followingUp.has(taskId)) throw new Error('上一条补充消息正在发送，请稍候');
    this.followingUp.add(taskId);
    let view: BrowserView | null = null;
    try {
      view = this.runtime.viewForAccount(task.accountId);
      if (!view || view.webContents.isDestroyed()) return false;
      if (normalizeTaskUrl(view.webContents.getURL()) !== normalizeTaskUrl(task.pageUrl)) {
        await view.webContents.loadURL(task.pageUrl);
        await waitForComposer(view);
      }
      await assertEmptyDraft(view);
      if (task.referencePaths.length && !task.referenceUploaded) {
        await uploadTaskReferences(view, task.referencePaths);
        this.update(task, { referenceUploaded: true });
      }
      const snapshot = await runInPage(view, pageReplySnapshotScript) as PageReplySnapshot;
      const baseline = createPageReplyBaseline(snapshot, { prompt: text.trim() });
      await prepareText(view, text.trim());
      view.webContents.send('account-send:bypass', true);
      await clickComposerSend(view, text.trim());
      this.update(task, { replyBaseline: baseline, sentPrompt: text.trim(), latestReply: null, latestReplyId: undefined,
        status: 'awaiting_reply', statusText: '补充消息已转交，等待豆包实际回复', pageUrl: view.webContents.getURL() });
      return true;
    } finally {
      this.followingUp.delete(taskId);
      if (view && !view.webContents.isDestroyed()) view.webContents.send('account-send:bypass', false);
    }
  }

  private async syncTaskReply(task: CanvasBridgeTask, view: BrowserView) {
    if (this.followingUp.has(task.id)) return;
    const snapshot = await runInPage(view, pageReplySnapshotScript) as PageReplySnapshot;
    if (snapshot.error) throw new Error('读取豆包回复失败：' + snapshot.error);
    let baseline = task.replyBaseline;
    if (!baseline) {
      const prompt = task.sentPrompt || formatVideoPrompt(task.prompt, task.ratio, task.duration, task.model, Boolean(task.referencePaths.length));
      let anchor = -1;
      for (let i = snapshot.messages.length - 1; i >= 0; i--) { const m = snapshot.messages[i]; if (m.role === 'user' && normalizePageReplyText(m.text) === normalizePageReplyText(prompt)) { anchor = i; break; } }
      baseline = createPageReplyBaseline({ ...snapshot, messages: anchor >= 0 ? snapshot.messages.slice(0, anchor) : snapshot.messages }, { prompt });
    }
    const result = collectPageReplies(baseline, snapshot);
    task.replyBaseline = result.baseline;
    if (result.latestText) {
      const state = videoReplyState(result.latestText);
      this.update(task, { latestReply: result.latestText, latestReplyId: result.replies.at(-1)?.id, ...state });
    }
  }

  async tryDownloadCompletedVideo(accountId: number) {
    if (this.pollingAccounts.has(accountId)) return false;
    this.pollingAccounts.add(accountId);
    try { return await this.pollVideoTask(accountId); }
    finally { this.pollingAccounts.delete(accountId); }
  }

  private async pollVideoTask(accountId: number) {
    const task = [...this.tasks.values()].find(candidate => candidate.accountId === accountId && ['awaiting_reply', 'awaiting_confirmation', 'generating', 'downloading'].includes(candidate.status));
    if (!task) return false;
    if ((task.status !== 'awaiting_confirmation' && Date.now() - Date.parse(task.updatedAt) > 30 * 60 * 1000) || (task.status === 'downloading' && Date.now() - Date.parse(task.updatedAt) > 3 * 60 * 1000)) {
      this.update(task, { status: 'needs_attention', statusText: '等待生成或下载超时，请检查执行账号并手动关联结果', error: '未能确认视频结果' });
      this.busyAccountIds.delete(accountId); this.dispatchNextQueuedTask(); return false;
    }
    if (task.status === 'downloading') return false;
    const view = this.runtime.viewForAccount(accountId);
    if (!view?.webContents || view.webContents.isDestroyed()) return false;
    // Liveness is only proven once a real page evaluation is possible; a closed window must
    // not keep the account locked forever.
    this.lastPolledAt.set(task.id, Date.now());
    try {
      const currentUrl = view.webContents.getURL();
      const attempts = this.taskPageRecoveryAttempts.get(task.id) ?? 0;
      if (shouldRecoverTaskPage(currentUrl, task.pageUrl, attempts)) {
        this.taskPageRecoveryAttempts.set(task.id, attempts + 1);
        this.update(task, { statusText: '豆包页面意外回到首页，正在恢复本次任务页面' });
        await view.webContents.loadURL(task.pageUrl as string);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      } else if (task.pageUrl && normalizeTaskUrl(currentUrl) !== normalizeTaskUrl(task.pageUrl)) {
        this.busyAccountIds.delete(accountId);
        this.update(task, {
          status: 'needs_attention',
          statusText: '豆包任务页已丢失，已停止重复刷新；请在豆包确认是否已生成后重新从画布提交',
          error: '任务页未能恢复，桥接没有确认到已提交的豆包消息',
        });
        this.dispatchNextQueuedTask();
        return false;
      }
      // Repeated evaluation failures mean the task page is unusable; stop waiting on it.
      const stalls = (this.taskPageRecoveryAttempts.get(task.id) ?? 0);
      if (stalls >= 8) {
        this.busyAccountIds.delete(accountId);
        this.update(task, { status: 'needs_attention', statusText: '豆包任务页面长时间无响应，请手动确认生成结果', error: this.lastPollError || '任务页面无响应' });
        this.dispatchNextQueuedTask();
        return false;
      }
      await this.syncTaskReply(task, view);
      const message = task.latestReply || '';
      if (/免费次数用完|额度不足|额度用完|创作额度|额度已用|暂时无法使用.*视频|视频生成失败|生成失败/.test(message)) {
        this.busyAccountIds.delete(accountId);
        this.pool.markFailure(accountId, 'quota', '豆包页面提示：当前账号视频生成额度不足或不可用');
        this.update(task, { status: 'needs_attention', statusText: '豆包账号当前无可用视频额度，已标记该账号并自动切换其他账号', error: '豆包页面提示：当前账号视频生成额度不足或不可用' });
        this.dispatchNextQueuedTask();
        return false;
      }
      if (/710022004|人机验证|安全验证|滑块/.test(message)) {
        this.busyAccountIds.delete(accountId);
        this.pool.markFailure(accountId, 'captcha', '豆包要求人机验证，需要人工处理该账号');
        this.update(task, { status: 'needs_attention', statusText: '该账号触发人机验证，已停用；请在豆包窗口完成验证后清除冷却', error: '豆包要求人机验证（710022004）' });
        this.dispatchNextQueuedTask();
        return false;
      }
      if (['awaiting_reply', 'awaiting_confirmation'].includes(task.status) && !/视频[^。！？]*(?:已生成|生成好了)|你的视频生成好了/.test(message)) return false;

      // Prefer the user's HD unwatermarked method (shareService) over the site's own
      // watermarked download button. The player data can lag the "生成好了" message, so
      // retry a bounded number of polls before falling back to the regular download.
      if (/你的视频生成好了|视频生成好了|视频已生成|生成好了/.test(message) && this.runtime.downloadHDVideo) {
        const attempts = this.hdAttempts.get(task.id) ?? 0;
        if (attempts < 8) {
          this.hdAttempts.set(task.id, attempts + 1);
          const hdPath = await this.runtime.downloadHDVideo(view, task).catch(() => null);
          if (hdPath && existsSync(hdPath)) {
            this.hdAttempts.delete(task.id);
            this.update(task, { status: 'completed', statusText: task.sourceAccountId ? '视频已返回共享工作区' : '视频已高清下载（无水印）', videoPath: hdPath, error: null });
            this.busyAccountIds.delete(accountId);
            this.dispatchNextQueuedTask();
            return true;
          }
        }
      }

      const videoSource = await runInPage(view, `(() => {
        const baseline = ${JSON.stringify(this.videoBaselines.get(task.id) ?? [])};
        const isNew = src => src && !baseline.includes(src);
        // A finished doubao video card is not always a <video> carrying a src: the player
        // can be lazy, and the render sometimes only exists as card markup plus a download
        // button. Check the player first, then video-shaped URLs in the page, then links.
        for (const video of Array.from(document.querySelectorAll('video'))) {
          const src = video.currentSrc || video.src || video.querySelector('source')?.src || '';
          if (isNew(src)) return src;
        }
        const html = document.body.innerHTML || '';
        const match = html.match(/https?:\\/\\/[^"'\\\s]+?(?:\\.mp4|\\.m3u8|bytevcloud|vlabvod|video_id=)[^"'\\\s]*/i);
        if (match) { const url = match[0].replace(/\\u0026/g, '&'); if (isNew(url)) return url; }
        const scope = Array.from(document.querySelectorAll('video')).at(-1)?.closest('div,section,article') || document.body;
        const link = Array.from(scope.querySelectorAll('a[href],button[data-url]'))
          .map(node => node.getAttribute('href') || node.getAttribute('data-url') || '')
          .find(url => /\.mp4|bytevcloud|vlabvod/i.test(url));
        return link && isNew(link) ? link : '';
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
      
      if (/你的视频生成好了|视频生成好了|视频已生成|生成好了/.test(message)) {
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
    } catch (error) {
      this.lastPollError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private update(task: CanvasBridgeTask, patch: Partial<CanvasBridgeTask>) {
    if (terminal.has(task.status) && patch.status && patch.status !== task.status) return;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.persistTasks();
    this.runtime.onTaskChanged(task);
  }


  /**
   * Frees accounts whose task stopped making progress.
   *
   * A task left 'generating' by a crash, a lost page or a closed window has no poller
   * behind it any more, yet it keeps its account in busyAccountIds. Everything queued
   * afterwards waits on it forever — which is exactly why the gateway bubble used to sit
   * on "视频生成中" while nothing was actually running.
   */
  private releaseStaleLocks() {
    for (const task of this.tasks.values()) {
      if (!task.accountId) continue;
      if (!['assigned', 'submitting', 'awaiting_reply', 'awaiting_confirmation', 'generating', 'downloading'].includes(task.status)) continue;
      const last = this.lastPolledAt.get(task.id);
      const idleMs = Date.now() - (last ?? Date.parse(task.updatedAt || task.createdAt));
      // A task that waits on the user's own answer ("豆包参数确认中") is not stuck: the
      // account stays reserved, but the task must survive however long the user takes.
      const waitingOnUser = task.status === 'awaiting_reply' || task.status === 'awaiting_confirmation';
      if (idleMs < (waitingOnUser ? 30 : 3) * 60 * 1000) continue;
      this.busyAccountIds.delete(task.accountId);
      if (['awaiting_reply', 'awaiting_confirmation', 'generating', 'downloading'].includes(task.status)) {
        this.update(task, { status: 'needs_attention', statusText: '任务长时间无进展，已释放账号；请重新发送或到豆包确认结果', error: '任务轮询中断' });
      }
    }
  }
  private dispatchNextQueuedTask() {
    this.releaseStaleLocks();
    const next = [...this.tasks.values()].find(task => task.status === 'queued' && !this.dispatchingTasks.has(task.id) && (!task.targetAccountId || !this.busyAccountIds.has(task.targetAccountId)));
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
        if (!task.accountId || !['awaiting_reply', 'awaiting_confirmation', 'generating', 'downloading'].includes(task.status)) continue;
        // A task left 'generating' by a previous crash has no live polling loop behind it
        // anymore. tryDownloadCompletedVideo can still pick it up for a late download,
        // but it must NOT keep the account busy forever — a stuck task made every new
        // request queue behind a ghost.
        const age = Date.now() - Date.parse(task.createdAt);
        const idleMs = Date.now() - Date.parse(task.updatedAt || task.createdAt);
        if (age > 45 * 60 * 1000) {
          task.status = 'needs_attention';
          task.statusText = '上次运行未完成本次启动，已停止追踪；请在豆包确认生成结果';
          task.error = '任务因应用重启而中断';
          this.tasks.set(task.id, task);
          continue;
        }
        this.tasks.set(task.id, task);
        this.videoBaselines.set(task.id, task.videoBaseline || []);
        // A ghost task from an earlier run used to hold its account for up to 45 minutes,
        // so every new request sat in `queued` forever and the gateway bubble never moved.
        if (idleMs < 3 * 60 * 1000) this.busyAccountIds.add(task.accountId);
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
    const task: CanvasBridgeTask = { id, gatewayThreadId: body.gatewayThreadId, gatewayReplyMessageId: body.gatewayReplyMessageId, conversationId: body.conversationId, targetAccountId: body.targetAccountId, duration: body.duration, sourceAccountId: body.sourceAccountId, sourceUrl: body.sourceUrl, sourceDraftText: body.sourceDraftText, prompt, model: body.model, ratio: /^\d+:\d+$/.test(body.ratio || '') ? body.ratio! : '16:9', status: 'queued', statusText: '等待分配豆包账号', accountId: null, pageUrl: null, referencePaths: [], videoPath: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    task.referencePaths = [...(body.referencePaths ?? []), ...writeReferences(this.uploadRoot, id, body.referenceAssets ?? [])];
    this.tasks.set(id, task);
    this.persistTasks();
    void this.dispatch(task);
    return task;
  }

  private async dispatch(task: CanvasBridgeTask) {
    // dispatch() is reachable from create(), the download completion hooks and the queue
    // drain; without this guard the same task could be submitted twice, adding the account
    // to busyAccountIds twice and racing two composers.
    if (this.dispatchingTasks.has(task.id)) return;
    this.dispatchingTasks.add(task.id);
    const doubaoAccounts = this.runtime.accounts().filter((account) => account.platform === 'doubao');
    const account = task.targetAccountId
      ? doubaoAccounts.find(a => a.id === task.targetAccountId)
      : this.pool.pick(doubaoAccounts, this.busyAccountIds);
    if (account && this.busyAccountIds.has(account.id)) {
      this.update(task, { status: 'queued', statusText: `等待 ${account.name} 完成前一个任务` });
      this.dispatchingTasks.delete(task.id);
      return;
    }
    if (!account) {
      if (task.targetAccountId) {
        this.update(task, { status: 'needs_attention', statusText: '执行账号不存在或不是豆包账号', error: '请选择可用的豆包执行账号' });
        this.dispatchingTasks.delete(task.id);
        return;
      }
      const loggedIn = doubaoAccounts.filter(candidate => candidate.isLoggedIn);
      if (loggedIn.length) {
        const states = this.pool.snapshot(loggedIn, this.busyAccountIds).map(entry => `${entry.health}${entry.cooldownRemainingMs ? `(${Math.ceil(entry.cooldownRemainingMs / 1000)}s)` : ''}`);
        this.update(task, { status: 'queued', statusText: `账号池暂无可调度账号（${[...new Set(states)].join('、')}），任务自动排队`, error: null });
        this.dispatchingTasks.delete(task.id);
        return;
      }
      this.update(task, { status: 'needs_attention', statusText: '没有已登录的豆包账号', error: '没有可用账号' });
      this.dispatchingTasks.delete(task.id);
      return;
    }
    this.busyAccountIds.add(account.id);
    this.update(task, { status: 'assigned', statusText: `已分配账号：${account.name}`, accountId: account.id });
    let view: BrowserView | null = null;
    try {
      view = this.runtime.viewForAccount(account.id) ?? this.runtime.openAccount(account.id);
      if (!view) {
        this.busyAccountIds.delete(account.id);
        this.update(task, { status: 'needs_attention', statusText: '无法打开已登录的豆包工作台页面', error: '无法打开豆包页面' });
        return;
      }
      this.update(task, { status: 'submitting', statusText: '正在向豆包工作台提交任务' });
      if (task.conversationId) {
        const targetUrl = `https://www.doubao.com/chat/${task.conversationId}`;
        const currentUrl = view.webContents.getURL() || '';
        if (normalizeTaskUrl(currentUrl) !== normalizeTaskUrl(targetUrl)) {
          await view.webContents.loadURL(targetUrl);
          await waitForComposer(view);
        }
      } else if (task.gatewayThreadId) {
        const currentUrl = view.webContents.getURL() || '';
        const isCleanNewChat = /^https?:\/\/(?:www\.)?doubao\.com\/chat\/?(?:[?#]|$)/i.test(currentUrl);
        if (!isCleanNewChat) {
          await view.webContents.loadURL('https://www.doubao.com/chat/');
          await waitForComposer(view);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (task.targetAccountId && task.targetAccountId !== task.sourceAccountId) {
        const draft = await runInPage(view, `(() => { const input=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0); return input ? (input.value || input.innerText || '').trim() : ''; })()`);
        if (draft) throw new Error('执行账号已有未发送草稿，请先处理该草稿再重试');
      }
      await waitForComposer(view);
      try {
        await ensureComposerMode(view, { mode: 'video' });
      } catch (modeError) {
        throw new Error(`无法进入豆包视频生成模式：${modeError instanceof Error ? modeError.message : String(modeError)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const existingDownloads = await runInPage(view, `(() => [...document.querySelectorAll('button,a')].filter((node) => /下载(视频)?|保存视频/.test((node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, ''))).length)()`);
      this.downloadBaselines.set(task.id, Number(existingDownloads) || 0);
      const baseline = await runInPage(view, `Array.from(document.querySelectorAll('video')).map(v => v.currentSrc || v.src)`);
      this.videoBaselines.set(task.id, baseline);
      this.update(task, { videoBaseline: baseline });

      // Model, duration and ratio are doubao ability parameters.
      // Must be configured BEFORE uploading reference images, because dropdowns, settings popups
      // or Escape keys can reset/clear the composer's draft attachments!
      const applied: string[] = [];
      try {
        await selectDoubaoVideoModel(view, task.model, task.duration);
        applied.push(`模型 ${task.model || '默认'}`);
      } catch (error) {
        applied.push(`模型未切换（${error instanceof Error ? error.message : '页面无模型选项'}）`);
      }
      try {
        await selectDoubaoVideoSettings(view, { ratio: task.ratio, duration: Number(task.duration ?? 0) });
        if (task.ratio) applied.push(`比例 ${task.ratio}`);
        if (task.duration) applied.push(`时长 ${task.duration} 秒`);
      } catch (error) {
        applied.push(`比例/时长未切换（${error instanceof Error ? error.message : '页面无比例/时长控件'}）`);
      }

      const hasReferenceImages = Boolean(task.referencePaths && task.referencePaths.length > 0);
      if (hasReferenceImages) {
        this.update(task, { statusText: '正在上传参考图到豆包页面' });
        await uploadTaskReferences(view, task.referencePaths);
        this.update(task, { referenceUploaded: true });
      }
      this.update(task, { statusText: `正在提交到豆包（${applied.join('，')}）` });

      const promptText = formatVideoPrompt(task.prompt, task.ratio, task.duration, task.model, hasReferenceImages);
      await prepareText(view, promptText);
      const beforeSend = await runInPage(view, pageReplySnapshotScript) as PageReplySnapshot;
      this.update(task, { sentPrompt: promptText, replyBaseline: createPageReplyBaseline(beforeSend, { prompt: promptText }) });

      view.webContents.send('account-send:bypass', true);
      try {
        await clickComposerSend(view, promptText);
      } catch (sendError) {
        const clicked = await runInPage(view, `(() => {
          const input = [...document.querySelectorAll('[contenteditable=true],textarea')].find(n => n.getBoundingClientRect().width > 0);
          const rect = input?.getBoundingClientRect();
          const buttons = [...document.querySelectorAll('button,[role=button]')].filter(n => !n.disabled && n.getBoundingClientRect().width > 0);
          const target = buttons.find(n => /发送|send|submit|生成视频|立即生成/i.test((n.innerText || n.getAttribute('aria-label') || '').trim()))
            || (rect ? buttons.filter(n => { const r = n.getBoundingClientRect(); return r.left >= rect.right - 140 && r.top >= rect.top - 80 && r.bottom <= rect.bottom + 120; }).pop() : null);
          if (target) {
            target.click();
            return true;
          }
          return false;
        })()`);
        if (!clicked) {
          const outcome = await submitToDoubao(view, { ...task, prompt: promptText }) as unknown as { ok?: boolean; reason?: string; labels?: string[] };
          if (!outcome?.ok) {
            const labels = Array.isArray(outcome?.labels) ? `（当前可见按钮：${outcome.labels.slice(0, 8).join('、')}）` : '';
            throw new Error(`${outcome?.reason || (sendError instanceof Error ? sendError.message : '页面提交未完成')}${labels}`);
          }
        }
      } finally {
        if (!view.webContents.isDestroyed()) view.webContents.send('account-send:bypass', false);
      }
      this.update(task, { status: 'awaiting_reply', statusText: '消息已提交，等待豆包回复', pageUrl: view.webContents.getURL() });
      await this.syncTaskReply(task, view);
    } catch (error) {
      const detail = error instanceof Error ? error.message : '页面自动化失败';
      this.busyAccountIds.delete(account.id);
      this.pool.markFailure(account.id, classifyDispatchFailure(detail), detail);
      this.update(task, { status: 'needs_attention', statusText: `需要在豆包窗口处理：${detail}`, error: detail });
    } finally {
      this.dispatchingTasks.delete(task.id);
      if (view && !view.webContents.isDestroyed()) view.webContents.send('account-send:bypass', false);
      this.dispatchNextQueuedTask();
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url || '/', 'http://127.0.0.1:3219');
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { ok: true, service: 'doubao-workspace-canvas-bridge', queued: [...this.tasks.values()].filter((task) => !terminal.has(task.status)).length, pool: this.poolSnapshot().map(({ accountId, health, weight, dailyUsed, cooldownRemainingMs, available }) => ({ accountId, health, weight, dailyUsed, cooldownRemainingMs, available })) }); return;
    }
    if (request.method === 'GET' && url.pathname === '/accounts') {
      const pool = new Map(this.poolSnapshot().map(entry => [entry.accountId, entry]));
      json(response, 200, { accounts: this.runtime.accounts().map((account) => ({ id: account.id, name: account.name, platform: account.platform, isLoggedIn: account.isLoggedIn, busy: this.busyAccountIds.has(account.id), health: pool.get(account.id)?.health ?? 'healthy', available: pool.get(account.id)?.available ?? false, dailyUsed: pool.get(account.id)?.dailyUsed ?? 0, cooldownRemainingMs: pool.get(account.id)?.cooldownRemainingMs ?? 0 })) }); return;
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
      // capturePage throws "Given BrowserView is not attached to the window" on a view
      // that was only warmed up. The runtime owns the window, so ask it whether the view
      // is attached instead of guessing from the webContents.
      if (!this.runtime.isViewAttached?.(view)) { json(response, 409, { error: '执行账号页面未显示，无法截图' }); return; }
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
