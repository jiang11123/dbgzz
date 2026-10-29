import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, promises as fsp, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserView } from 'electron';
import type { Account } from '../shared/types';
import { ensureComposerMode, readComposerSettings, selectPageSetting, selectVideoDuration, selectDoubaoVideoSettings, prepareText, clickComposerSend, waitForComposer, assertEmptyDraft, assertVideoDuration } from './page-composer';
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
  lastFramePath?: string | null;
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
  extractLastFrame?: (videoPath: string) => Promise<string | null>;
  popupAccountForCaptcha?: (accountId: number, reason?: string) => void;
};

export function videoConversationForAccount(thread: { accountId: number | null; doubaoConversationId: string } | null, accountId?: number | null): string | undefined {
  return thread && accountId != null && thread.accountId === accountId ? thread.doubaoConversationId || undefined : undefined;
}

export function videoReplyState(text: string): Pick<CanvasBridgeTask, 'status' | 'statusText'> {
  if (/请[^。！？]*确认|[^。！？]*确认[^。！？]*(?:后|再)[^。！？]*(?:生成|开始)|是否[^。！？]*(?:生成|上传|开始)|请[^。！？]*(?:上传|提供|补充)[^。！？]*(?:图片|参考图)/.test(text))
    return { status: 'awaiting_confirmation', statusText: '豆包等待你的回复，请直接在此发送补充消息' };
  if (/正在生成|已开始生成|生成中|正在排队|排队中|预计等待|生成进度/.test(text))
    return { status: 'generating', statusText: '豆包已返回生成进度' };
  return { status: 'awaiting_reply', statusText: '已收到豆包回复，可继续发送消息' };
}

const terminal = new Set<CanvasBridgeStatus>(['completed', 'needs_attention', 'failed', 'cancelled']);

/**
 * loadURL 在网络挂起（代理失效、DNS 卡住）时可能 pending 数分钟到永久，
 * 会把整条任务执行链冻住、账号锁假释放。超时后 stop() 加载并抛错。
 */
async function loadURLWithTimeout(view: BrowserView, url: string, timeoutMs = 30_000) {
  const contents = view.webContents;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { if (!contents.isDestroyed() && contents.isLoading()) contents.stop(); } catch { /* ignore */ }
      reject(new Error(`页面加载超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    contents.loadURL(url).then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
  });
}
const contentType = (filePath: string) => /\.webm$/i.test(filePath) ? 'video/webm' : /\.mov$/i.test(filePath) ? 'video/quicktime' : 'video/mp4';

const QUOTA_PATTERN = /免费次数用完|额度不足|创作额度.*不足|暂时无法使用|额度已用尽|今日.*上限/;
const CAPTCHA_PATTERN = /710022004|人机验证|安全验证|滑块/;
const SESSION_PATTERN = /未登录|登录已过期|请先登录|会话失效/;
export const VIDEO_COMPLETION_PATTERN = /视频[^。！？]*(?:已生成|生成好了|生成完成|已完成|制作完成)|(?:已生成|已完成|已制作|生成好了|制作好了)[^。！？]*视频|你的视频生成好了|【视频生成完成】|视频生成完成|视频已生成|生成好了|生成完成|已为你生成视频/;

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

export function isRootDoubaoChatUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const normalized = normalizeTaskUrl(url);
  return /^https?:\/\/(?:www\.)?doubao\.com(?:\/chat)?$/i.test(normalized);
}

export function isSpecificDoubaoChatUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const normalized = normalizeTaskUrl(url);
  return /^https?:\/\/(?:www\.)?doubao\.com\/chat\/[a-zA-Z0-9_-]+$/i.test(normalized);
}

export function isPendingDoubaoChatUrl(url: string | null | undefined): boolean {
  return isRootDoubaoChatUrl(url) || /^https?:\/\/(?:www\.)?doubao\.com\/chat\/local_[a-zA-Z0-9_-]+$/i.test(normalizeTaskUrl(url));
}

export function shouldRecoverTaskPage(currentUrl: string, taskUrl: string | null, attempts: number) {
  // A doubao video render takes minutes and the page drifts off its task URL while it
  // works (progress views, hash changes, a redirect home). Recover generously, but keep a
  // cap so a genuinely lost page still surfaces to the user instead of looping forever.
  if (!taskUrl || isPendingDoubaoChatUrl(taskUrl)) return false;
  const normCurrent = normalizeTaskUrl(currentUrl);
  const normTask = normalizeTaskUrl(taskUrl);
  if (normCurrent === normTask) return false;
  // If the task was submitted on root /chat and natural SPA navigation progressed it
  // to a specific /chat/<id>, this is normal conversation creation, not page loss.
  if (isRootDoubaoChatUrl(normTask) && isSpecificDoubaoChatUrl(normCurrent)) {
    return false;
  }
  return isRootDoubaoChatUrl(normCurrent) && attempts < 8;
}

function json(response: ServerResponse, code: number, value: unknown) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    // 边读边限：读完全部再检查对超大 body 毫无防护。
    if (total > 12 * 1024 * 1024) throw new Error('请求过大');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as CanvasTaskRequest;
}

function imageExtension(dataUrl: string) {
  const mime = /^data:([^;,]+)/i.exec(dataUrl)?.[1]?.toLowerCase() ?? 'image/png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'png';
}

async function writeReferences(root: string, taskId: string, references: CanvasReference[]) {
  const directory = path.join(root, taskId);
  mkdirSync(directory, { recursive: true });
  const targets = references
    .filter((reference) => reference.mediaType !== 'video' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(reference.src))
    .slice(0, 12)
    .map((reference, index) => {
      const encoded = reference.src.slice(reference.src.indexOf(',') + 1);
      return { destination: path.join(directory, `reference-${index + 1}.${imageExtension(reference.src)}`), encoded };
    });
  // 每张参考图可达数 MB，异步写避免阻塞主进程事件循环。
  await Promise.all(targets.map(({ destination, encoded }) => fsp.writeFile(destination, Buffer.from(encoded, 'base64'))));
  return targets.map(({ destination }) => destination);
}

const CAPTCHA_VISIBLE_SCRIPT = `(() => {
  const el = document.getElementById('captcha_container')
    || document.querySelector('.captcha_verify_container')
    || document.querySelector('[id*="captcha_"]')
    || document.querySelector('iframe[src*="captcha"]');
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0;
})()`;

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


export class CanvasBridge {
  private server = createServer((request, response) => {
    // handle() 内任何路由抛错都不允许变成 unhandledRejection 打崩主进程。
    void this.handle(request, response).catch((error) => {
      console.error('[canvas-bridge] 请求处理失败：', error);
      try {
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      } catch { /* 连接已断开 */ }
    });
  });
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
  /** 终态任务的按任务 Map 条目延迟清理定时器：慢性内存泄漏的回收点。 */
  private taskCleanupTimers = new Map<string, NodeJS.Timeout>();
  /** persistTasks 防抖定时器。 */
  private persistTimer: NodeJS.Timeout | null = null;
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
      await loadURLWithTimeout(view, 'https://www.doubao.com/chat/');
      await new Promise(resolve => setTimeout(resolve, 2500));
      const state = await runInPage(view, `(() => ({ url: location.pathname, text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) }))()`) as { url: string; text: string };
      const blocked = /人机验证|安全验证|滑块|verify|captcha/i.test(state.url + ' ' + state.text);
      if (blocked) return { ok: false, reason: '账号仍需人机验证' };
      this.pool.markOk(accountId);
      // 冷却恢复后主动补位派发：否则队列里只剩 queued 任务时没有任何事件
      // 会触发 drain，任务会饿到某个无关操作才被派发。
      this.dispatchNextQueuedTask();
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
  stop() {
    this.server.close();
    this.flushTasksSync();
    for (const timer of this.taskCleanupTimers.values()) clearTimeout(timer);
    this.taskCleanupTimers.clear();
  }
  list() { return [...this.tasks.values()].map(task => ({ ...task })); }
  isBusy(id: number) { return this.busyAccountIds.has(id); }
  /** Live view of accounts currently executing a task, shared with the gateway. */
  busyIds(): ReadonlySet<number> { return this.busyAccountIds; }
  /** The shared account pool, so the gateway and the canvas bridge agree on health. */
  get poolRef(): AccountPool { return this.pool; }
  task(id: string) { return this.tasks.get(id) ?? null; }
  cancelTask(taskId: string): boolean {
    const task = this.task(taskId);
    if (!task) return false;
    this.update(task, { status: 'cancelled', statusText: '已取消', error: null });
    // dispatch 在途时不直接删账号锁：在途 dispatch 的 finally 会释放，
    // 这里抢先删锁会让下一个任务立刻派上同一账号，两套自动化同页互踩。
    if (task.accountId && !this.dispatchingTasks.has(task.id)) this.busyAccountIds.delete(task.accountId);
    return true;
  }

  completeFromDownload(accountId: number, videoPath: string) {
    const task = [...this.tasks.values()].find(candidate => candidate.accountId === accountId && candidate.status === 'downloading' && this.downloadPaths.get(candidate.id) === videoPath);
    if (!task || !existsSync(videoPath)) return false;
    this.update(task, { status: 'completed', statusText: task.sourceAccountId ? '视频已返回共享工作区' : '视频已下载并可回写画布', videoPath, error: null });
    this.triggerExtractLastFrame(task, task.videoPath || '');
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
    this.scheduleTaskEntryCleanup(task.id);
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
      if (!isPendingDoubaoChatUrl(task.pageUrl) && normalizeTaskUrl(view.webContents.getURL()) !== normalizeTaskUrl(task.pageUrl)) {
        await loadURLWithTimeout(view, task.pageUrl);
        await waitForComposer(view);
      }
      await assertEmptyDraft(view);
      if (task.referencePaths.length && !task.referenceUploaded) {
        await uploadTaskReferences(view, task.referencePaths);
        this.update(task, { referenceUploaded: true });
      }
      if (task.duration && (await readComposerSettings(view)).mode === 'video') {
        await selectDoubaoVideoSettings(view, { ratio: task.ratio, duration: task.duration });
      }
      if (task.duration) text = text.trim() + '。请严格保持视频时长 ' + task.duration + ' 秒、比例 ' + task.ratio + '，不要改成其他时长。';
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
    // Only a matching task turn proves that a client-only route became a server conversation.
    if (isPendingDoubaoChatUrl(task.pageUrl) && isSpecificDoubaoChatUrl(snapshot.url)
      && !isPendingDoubaoChatUrl(snapshot.url) && result.baseline.anchorId
      && snapshot.messages.some(message => message.role === 'user' && message.id === result.baseline.anchorId)) {
      this.taskPageRecoveryAttempts.delete(task.id);
      this.update(task, { pageUrl: snapshot.url });
    }
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
        await loadURLWithTimeout(view, task.pageUrl as string);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      } else if (task.pageUrl && !isPendingDoubaoChatUrl(task.pageUrl) && normalizeTaskUrl(currentUrl) !== normalizeTaskUrl(task.pageUrl)) {
        this.busyAccountIds.delete(accountId);
        this.update(task, {
          status: 'needs_attention',
          statusText: '豆包任务页已丢失，已停止重复刷新；请在豆包确认是否已生成后重新从画布提交',
          error: '任务页未能恢复，桥接没有确认到已提交的豆包消息',
        });
        this.dispatchNextQueuedTask();
        return false;
      }
      await this.syncTaskReply(task, view);
      // 人机验证弹层不在聊天文本里：不处理的话消息停在发送失败、任务却一直显示等待回复。
      // 自动唤起对应账号窗口供用户手动拖动滑块验证；验证完成前保持任务进行中。
      const captchaVisible = await runInPage(view, CAPTCHA_VISIBLE_SCRIPT).catch(() => false);
      const isCaptchaMessage = /710022004|人机验证|安全验证|滑块/.test(task.latestReply || '');
      if (captchaVisible || isCaptchaMessage) {
        this.runtime.popupAccountForCaptcha?.(accountId, '检测到豆包人机安全验证');
        this.update(task, {
          statusText: `⚠️ 豆包账号触发人机验证，已自动弹出窗口，请在弹出的豆包窗口中手动完成验证（账号 ${accountId}）`,
        });
        return false;
      }
      if (task.statusText?.includes('触发人机验证')) {
        this.update(task, {
          statusText: `人机验证已通过，继续等待视频生成（账号 ${accountId}）`,
        });
      }
      const message = task.latestReply || '';
      if (/免费次数用完|额度不足|额度用完|创作额度|额度已用|暂时无法使用.*视频|视频生成失败|生成失败/.test(message)) {
        this.busyAccountIds.delete(accountId);
        this.pool.markFailure(accountId, 'quota', '豆包页面提示：当前账号视频生成额度不足或不可用');
        this.update(task, { status: 'needs_attention', statusText: '豆包账号当前无可用视频额度，已标记该账号并自动切换其他账号', error: '豆包页面提示：当前账号视频生成额度不足或不可用' });
        this.dispatchNextQueuedTask();
        return false;
      }
      if (['awaiting_reply', 'awaiting_confirmation'].includes(task.status) && !VIDEO_COMPLETION_PATTERN.test(message)) return false;

      // Prefer the user's HD unwatermarked method (shareService) over the site's own
      // watermarked download button. The player data can lag the completion message, so
      // retry a bounded number of polls before falling back to the regular download.
      if (VIDEO_COMPLETION_PATTERN.test(message) && this.runtime.downloadHDVideo) {
        const attempts = this.hdAttempts.get(task.id) ?? 0;
        if (attempts < 8) {
          this.hdAttempts.set(task.id, attempts + 1);
          const hdPath = await this.runtime.downloadHDVideo(view, task).catch(() => null);
          if (hdPath && existsSync(hdPath)) {
            this.hdAttempts.delete(task.id);
            this.update(task, { status: 'completed', statusText: task.sourceAccountId ? '视频已返回共享工作区' : '视频已高清下载（无水印）', videoPath: hdPath, error: null });
    this.triggerExtractLastFrame(task, task.videoPath || '');
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
        // Before falling back to web player download, try HD download once more since the video is confirmed present
        if (this.runtime.downloadHDVideo) {
          const hdPath = await this.runtime.downloadHDVideo(view, task).catch(() => null);
          if (hdPath && existsSync(hdPath)) {
            this.hdAttempts.delete(task.id);
            this.update(task, { status: 'completed', statusText: task.sourceAccountId ? '视频已返回共享工作区' : '视频已高清下载（无水印）', videoPath: hdPath, error: null });
    this.triggerExtractLastFrame(task, task.videoPath || '');
            this.busyAccountIds.delete(accountId);
            this.dispatchNextQueuedTask();
            return true;
          }
        }
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
      
      if (VIDEO_COMPLETION_PATTERN.test(message)) {
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
    if (patch.status && terminal.has(patch.status)) this.scheduleTaskEntryCleanup(task.id);
  }

  /**
   * 终态任务的 per-task Map 条目（下载匹配、基线、重试计数）只服务于活跃状态的
   * 轮询/下载钩子，任务终态后若不清理会随使用次数慢性累积。延迟 5 分钟回收，
   * 给在途轮询/迟到的下载匹配留安全余量。
   */
  private scheduleTaskEntryCleanup(taskId: string) {
    if (this.taskCleanupTimers.has(taskId)) return;
    const timer = setTimeout(() => {
      this.taskCleanupTimers.delete(taskId);
      this.downloadSources.delete(taskId);
      this.downloadPaths.delete(taskId);
      this.videoBaselines.delete(taskId);
      this.downloadBaselines.delete(taskId);
      this.hdAttempts.delete(taskId);
      this.taskPageRecoveryAttempts.delete(taskId);
      this.lastPolledAt.delete(taskId);
    }, 5 * 60 * 1000);
    timer.unref();
    this.taskCleanupTimers.set(taskId, timer);
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
      // dispatch 仍在执行（页面导航/上传可能长时间无进度更新）时不能假释放：
      // 锁被提前删掉后，队列会把下一个任务派上同一账号，两套自动化驱动同一个
      // 作曲器互相污染。loadURL 已带超时，卡死的 dispatch 最终会自行失败退出。
      if (this.dispatchingTasks.has(task.id)) continue;
      const last = this.lastPolledAt.get(task.id);
      const idleMs = Date.now() - (last ?? Date.parse(task.updatedAt || task.createdAt));
      // A task that waits on the user's own answer ("豆包参数确认中") is not stuck: the
      // account stays reserved, but the task must survive however long the user takes.
      const waitingOnUser = task.status === 'awaiting_reply' || task.status === 'awaiting_confirmation';
      if (idleMs < (waitingOnUser ? 30 : 3) * 60 * 1000) continue;
      this.busyAccountIds.delete(task.accountId);
      // assigned/submitting 同样要落 needs_attention：只释放不落状态的话任务
      // 永远停在"正在提交"，没有任何 poller 会再认领它。
      if (['assigned', 'submitting', 'awaiting_reply', 'awaiting_confirmation', 'generating', 'downloading'].includes(task.status)) {
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
        if (['assigned', 'submitting'].includes(task.status) || !task.accountId) {
          // 重启前的提交没有存活的 dispatch/轮询可恢复：静默丢弃会让任务在
          // 界面上永远停在"正在提交"。落成 needs_attention 并保留在列表里，
          // 前端轮询会拿到明确的中断状态。
          task.status = 'needs_attention';
          task.statusText = '任务因应用重启而中断，请重新从画布提交';
          task.error = '任务在上次运行中断';
          this.tasks.set(task.id, task);
          continue;
        }
        if (!['awaiting_reply', 'awaiting_confirmation', 'generating', 'downloading'].includes(task.status)) continue;
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

    private triggerExtractLastFrame(task: CanvasBridgeTask, videoPath: string) {
    if (!videoPath || !existsSync(videoPath) || !this.runtime.extractLastFrame) return;
    this.runtime.extractLastFrame(videoPath).then(framePath => {
      if (framePath) {
        task.lastFramePath = framePath;
        this.persistTasks();
        this.runtime.onTaskChanged(task);
      }
    }).catch(() => undefined);
  }

  private persistTasks() {
    // update() 在视频生成期间每 750ms 轮询都会触发，同步 writeFileSync 会在主进程
    // 事件循环里造成频繁小写入（窗口/动画卡顿感）。合并为 500ms 内的一次异步写。
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushTasks().catch(() => { /* 丢一次状态落盘不能阻断任务执行 */ });
    }, 500);
    this.persistTimer.unref();
  }

  private async flushTasks() {
    await fsp.mkdir(path.dirname(this.taskStorePath), { recursive: true });
    await fsp.writeFile(this.taskStorePath, JSON.stringify([...this.tasks.values()], null, 2), 'utf8');
  }

  /** 退出前同步落盘，防抖窗口里的最后状态不丢。 */
  private flushTasksSync() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    try {
      mkdirSync(path.dirname(this.taskStorePath), { recursive: true });
      writeFileSync(this.taskStorePath, JSON.stringify([...this.tasks.values()], null, 2), 'utf8');
    } catch { /* 丢状态不能阻断退出 */ }
  }

  async create(body: CanvasTaskRequest) {
    const prompt = body.prompt?.trim() ?? '';
    if (!prompt) throw new Error('缺少视频提示词');
    const id = `canvas-video-${randomUUID()}`;
    const task: CanvasBridgeTask = { id, gatewayThreadId: body.gatewayThreadId, gatewayReplyMessageId: body.gatewayReplyMessageId, conversationId: body.conversationId, targetAccountId: body.targetAccountId, duration: body.duration, sourceAccountId: body.sourceAccountId, sourceUrl: body.sourceUrl, sourceDraftText: body.sourceDraftText, prompt, model: body.model, ratio: /^\d+:\d+$/.test(body.ratio || '') ? body.ratio! : '16:9', status: 'queued', statusText: '等待分配豆包账号', accountId: null, pageUrl: null, referencePaths: [], videoPath: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    task.referencePaths = [...(body.referencePaths ?? []), ...await writeReferences(this.uploadRoot, id, body.referenceAssets ?? [])];
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
    const targetAccount = task.targetAccountId
      ? doubaoAccounts.find(a => a.id === task.targetAccountId)
      : null;
    // 定向账号必须已登录：登录页/未登录页没有作曲器，跑到参考图上传才报
    // "未找到作曲器输入框"，用户看到的错误完全指向不到根因。
    if (targetAccount && !targetAccount.isLoggedIn) {
      this.dispatchingTasks.delete(task.id);
      this.update(task, { status: 'needs_attention', statusText: `执行账号 ${targetAccount.name} 未登录，请先在账号列表重新登录后重试`, error: '执行账号未登录' });
      return;
    }
    const account = targetAccount ?? this.pool.pick(doubaoAccounts, this.busyAccountIds);
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
    // 用户在提交过程中取消后，后续步骤（尤其是发送！）必须中止。
    const ensureActive = () => {
      if (terminal.has(task.status)) throw new Error('任务已取消');
    };
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
          await loadURLWithTimeout(view, targetUrl);
          await waitForComposer(view);
        }
      } else if (task.gatewayThreadId) {
        const currentUrl = view.webContents.getURL() || '';
        const isCleanNewChat = /^https?:\/\/(?:www\.)?doubao\.com\/chat\/?(?:[?#]|$)/i.test(currentUrl);
        if (!isCleanNewChat) {
          await loadURLWithTimeout(view, 'https://www.doubao.com/chat/');
          await waitForComposer(view);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      } else {
        // 豆包 3.0 画布任务（无 conversationId/gatewayThreadId）：账号页可能停在
        // 上次任务的会话页、登录页或尚未渲染完的中间态——不导航的话参考图上传
        // 会在任意页面上找作曲器直接失败。非干净新对话页先回新对话。
        const currentUrl = view.webContents.getURL() || '';
        const isCleanNewChat = /^https?:\/\/(?:www\.)?doubao\.com\/chat\/?(?:[?#]|$)/i.test(currentUrl);
        if (!isCleanNewChat) {
          await loadURLWithTimeout(view, 'https://www.doubao.com/chat/');
          await waitForComposer(view);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
      ensureActive();
      if (task.targetAccountId && task.targetAccountId !== task.sourceAccountId) {
        const draft = await runInPage(view, `(() => {
          try {
            const input=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n => {
              try { return n.getBoundingClientRect().width > 0; } catch { return false; }
            });
            return input ? (input.value || input.innerText || '').trim() : '';
          } catch { return ''; }
        })()`).catch(() => '');
        if (draft) throw new Error('执行账号已有未发送草稿，请先处理该草稿再重试');
      }
      await waitForComposer(view);
      try {
        await ensureComposerMode(view, { mode: 'video' });
      } catch (modeError) {
        // 当前页面（如历史对话页面）可能没有视频模式切换入口，自动回退到干净新对话页面重试进入视频模式
        try {
          await loadURLWithTimeout(view, 'https://www.doubao.com/chat/');
          await waitForComposer(view);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await ensureComposerMode(view, { mode: 'video' });
        } catch (retryError) {
          throw new Error(`无法进入豆包视频生成模式：${retryError instanceof Error ? retryError.message : String(retryError)}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      ensureActive();

      // Model, duration and ratio are doubao ability parameters.
      // Must be configured BEFORE uploading reference images, because dropdowns, settings popups
      // or Escape keys can reset/clear the composer's draft attachments!
      const hasReferenceImages = Boolean(task.referencePaths && task.referencePaths.length > 0);
      const composerView = view;
      const prepareComposer = async (): Promise<string[]> => {
        const existingDownloads = await runInPage(composerView, `(() => {
          try {
            return [...document.querySelectorAll('button,a')].filter((node) => {
              try { return /下载(视频)?|保存视频/.test((node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, '')); }
              catch { return false; }
            }).length;
          } catch { return 0; }
        })()`).catch(() => 0);
        this.downloadBaselines.set(task.id, Number(existingDownloads) || 0);
        const baseline = await runInPage(composerView, `(() => {
          try {
            return Array.from(document.querySelectorAll('video')).map(v => v.currentSrc || v.src);
          } catch { return []; }
        })()`).catch(() => [] as string[]);
        this.videoBaselines.set(task.id, baseline);
        this.update(task, { videoBaseline: baseline });
        const applied: string[] = [];
        try {
          await selectDoubaoVideoModel(composerView, task.model, task.duration);
          applied.push(`模型 ${task.model || '默认'}`);
        } catch (error) {
          applied.push(`模型未切换（${error instanceof Error ? error.message : '页面无模型选项'}）`);
        }
        try {
          await selectDoubaoVideoSettings(composerView, { ratio: task.ratio, duration: Number(task.duration ?? 0) });
          if (task.ratio) applied.push(`比例 ${task.ratio}`);
          if (task.duration) applied.push(`时长 ${task.duration} 秒`);
        } catch (error) {
          throw new Error(`视频比例/时长设置失败：${error instanceof Error ? error.message : '页面无比例/时长控件'}`);
        }
        if (hasReferenceImages) {
          this.update(task, { statusText: '正在上传参考图到豆包页面' });
          await uploadTaskReferences(composerView, task.referencePaths);
        }
        return applied;
      };
      let applied: string[];
      try {
        applied = await prepareComposer();
      } catch (prepareError) {
        // 页面瞬时状态（尚未渲染完、中途跳转、引导浮层、残留附件卡住）会让作曲器
        // 定位/上传失败。回到干净新对话页整体重备一次：新页面没有残留附件，
        // 模型/比例/时长也一并重新应用，仍失败才交给上层报 needs_attention。
        const detail = prepareError instanceof Error ? prepareError.message : String(prepareError);
        this.update(task, { statusText: `作曲器页面异常，正在回到新对话页重试（${detail.slice(0, 60)}）` });
        await loadURLWithTimeout(view, 'https://www.doubao.com/chat/');
        await waitForComposer(view);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await ensureComposerMode(view, { mode: 'video' }).catch(() => undefined);
        applied = await prepareComposer();
      }
      if (hasReferenceImages) this.update(task, { referenceUploaded: true });
      ensureActive();
      this.update(task, { statusText: `正在提交到豆包（${applied.join('，')}）` });

      const promptText = formatVideoPrompt(task.prompt, task.ratio, task.duration, task.model, hasReferenceImages);
      await prepareText(view, promptText);
      if (task.duration) await assertVideoDuration(view, task.duration);
      ensureActive();
      const beforeSend = await runInPage(view, pageReplySnapshotScript) as PageReplySnapshot;
      this.update(task, { sentPrompt: promptText, replyBaseline: createPageReplyBaseline(beforeSend, { prompt: promptText }) });

      view.webContents.send('account-send:bypass', true);
      try {
        await clickComposerSend(view, promptText);
      } finally {
        if (!view.webContents.isDestroyed()) view.webContents.send('account-send:bypass', false);
      }
      // Only a fresh user turn proves submission; clicking alone is insufficient.
      let posted = false;
      for (let attempt = 0; attempt < 16; attempt++) {
        const snapshot = await runInPage(view, pageReplySnapshotScript) as PageReplySnapshot;
        const next = collectPageReplies(task.replyBaseline!, snapshot);
        if (next.baseline.anchorId) {
          // Keep emitted replies untouched so syncTaskReply can deliver them.
          this.update(task, { replyBaseline: { ...task.replyBaseline!, anchorId: next.baseline.anchorId } });
          posted = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!posted) throw new Error('豆包未确认提交：聊天记录中没有本次消息，请检查账号窗口；不会自动重复发送');
      let initialUrl = view.webContents.getURL();
      if (isPendingDoubaoChatUrl(initialUrl)) {
        for (let waitUrl = 0; waitUrl < 6; waitUrl++) {
          await new Promise(resolve => setTimeout(resolve, 350));
          const probe = view.webContents.getURL();
          if (isSpecificDoubaoChatUrl(probe) && !isPendingDoubaoChatUrl(probe)) {
            initialUrl = probe;
            break;
          }
        }
      }
      this.update(task, { status: 'awaiting_reply', statusText: '消息已提交，等待豆包回复', pageUrl: initialUrl });
      try {
        await this.syncTaskReply(task, view);
        if (await runInPage(view, CAPTCHA_VISIBLE_SCRIPT).catch(() => false)) {
          this.runtime.popupAccountForCaptcha?.(account.id, '提交任务后触发人机验证');
          this.update(task, { statusText: `⚠️ 豆包账号触发人机验证，已自动弹出窗口，请在弹出的豆包窗口中手动完成验证（账号 ${account.id}）` });
        }
      } catch (confirmError) {
        // 提交已确认成功（豆包收到了消息、生成已在进行）。此刻页面瞬间重渲染/导航
        // 导致的确认快照失败只降级提示，绝不能把成功任务改判失败、更不能冷却健康账号。
        const detail = confirmError instanceof Error ? confirmError.message : String(confirmError);
        this.update(task, { statusText: `消息已提交，但回复确认暂时失败：${detail}` });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : '页面自动化失败';
      if (terminal.has(task.status)) {
        // 用户已取消（任务已终态）：只释放账号锁，不改写状态、不冷却账号。
        this.busyAccountIds.delete(account.id);
      } else {
        this.busyAccountIds.delete(account.id);
        this.pool.markFailure(account.id, classifyDispatchFailure(detail), detail);
        this.update(task, { status: 'needs_attention', statusText: `需要在豆包窗口处理：${detail}`, error: detail });
      }
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
      const stream = createReadStream(task.videoPath);
      // 视频文件可能在 existsSync 与读取之间被移动/清理，无监听的 error 会变成未捕获异常。
      stream.once('error', () => { if (!response.writableEnded) response.destroy(); });
      stream.pipe(response); return;
    }
    if (request.method === 'GET' && taskMatch[2] === 'screenshot') {
      const view = task.accountId ? this.runtime.viewForAccount(task.accountId) : null;
      if (!view?.webContents || view.webContents.isDestroyed()) { json(response, 409, { error: '豆包页面不可用' }); return; }
      // capturePage throws "Given BrowserView is not attached to the window" on a view
      // that was only warmed up. The runtime owns the window, so ask it whether the view
      // is attached instead of guessing from the webContents.
      if (!this.runtime.isViewAttached?.(view)) { json(response, 409, { error: '执行账号页面未显示，无法截图' }); return; }
      try {
        // 附加检查与截图之间视图仍可能被关闭/移出窗口，这里兜底成 409 而不是主进程崩溃。
        const snapshot = await view.webContents.capturePage();
        const image = snapshot.toPNG();
        response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(image.length) });
        response.end(image);
      } catch (error) {
        json(response, 409, { error: `截图失败：${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    if (request.method === 'POST' && taskMatch[2] === 'cancel') {
      this.update(task, { status: 'cancelled', statusText: '已取消', error: null });
      // dispatch 在途时账号锁由 dispatch 的 finally 统一释放，这里抢先删锁会让
      // 下一个任务立刻派上同一账号，两套自动化同页互踩。
      if (task.accountId && !this.dispatchingTasks.has(task.id)) this.busyAccountIds.delete(task.accountId);
      json(response, 200, { task }); return;
    }
    if (request.method === 'GET' && !taskMatch[2]) { json(response, 200, { task, videoUrl: task.status === 'completed' ? `http://127.0.0.1:3219/tasks/${encodeURIComponent(task.id)}/video` : null }); return; }
    json(response, 405, { error: '不支持的方法' });
  }
}
