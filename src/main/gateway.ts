import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs, { createReadStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Account, GatewayVideoTaskResponse, GatewayVideoTaskStatus } from '../shared/types';
import type { AccountPool } from './account-pool';
import { streamChat } from './doubao-api';
import { generateImages, DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_RATIO, IMAGE_MODELS, IMAGE_RATIOS } from './doubao-image';
import { extractMediaUrls } from './gateway-chat';
import { uploadImageToDoubao } from './doubao-upload';
import { VIDEO_MODELS } from './doubao-video';

export type GatewayRuntime = {
  accounts: () => Account[];
  /** Opens (or reuses) the account page and returns it, or null when unavailable. */
  viewForAccount: (accountId: number) => unknown | null;
  openAccount: (accountId: number) => unknown | null;
  /** Optional handler to trigger adding a new Doubao account from the UI/API. */
  addAccount?: () => Promise<Account | null>;
  prepareNewConversation?: (accountId: number) => Promise<void>;
  generateVideo?: (prompt: string, options: { model?: string; ratio?: string; duration?: number; accountId?: number | null; referencePaths?: string[] }) => Promise<{ url?: string; path?: string; name?: string }[]>;

  // 豆包 3.0 异步视频任务扩展
  createVideoTask?: (options: {
    prompt: string;
    model?: string;
    ratio?: string;
    duration?: number;
    accountId?: number | null;
    referencePaths?: string[];
  }) => Promise<{ id: string; status: string; createdAt?: string }>;

  getVideoTask?: (id: string) => {
    id: string;
    status: string;
    statusText?: string;
    progress?: number;
    videoPath?: string | null;
    lastFramePath?: string | null;
    /** 豆包最新回复原文；awaiting_confirmation 时是待确认的问题内容。 */
    latestReply?: string | null;
    error?: string | null;
    createdAt?: string;
    updatedAt?: string;
  } | null;

  cancelVideoTask?: (id: string) => boolean | Promise<boolean>;

  /** 豆包要求确认/补充材料时，把用户输入作为补充消息发回执行账号页面。 */
  confirmVideoTask?: (id: string, text: string) => boolean | Promise<boolean>;
};

export type GatewayOptions = {
  port?: number;
  apiKey?: string;
  pool: AccountPool;
  busyAccountIds: () => ReadonlySet<number>;
  onLog?: (message: string) => void;
};

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Hard ceiling for one generation, so a stuck page cannot block an account forever. */
export const REQUEST_TIMEOUT_MS = 150_000;

export const DEFAULT_MODEL = 'doubao';
/** Model aliases exposed over /v1/models, mapped onto Doubao modes. */
export const MODEL_ALIASES: Record<string, { label: string; deepThink?: boolean }> = {
  'doubao': { label: '豆包' },
  'doubao-pro': { label: '豆包 Pro' },
  'doubao-think': { label: '豆包 · 深度思考', deepThink: true },
  'doubao-lite': { label: '豆包 Lite' },
};

/**
 * OpenAI 的 content 可以是字符串，也可以是 [{type:'text',text}, {type:'image_url',...}] 数组
 * （BeefTV Agent 宿主就这样发）。网页聊天只接收文本：取出文本段，其余段（图片等）忽略。
 */
export function chatContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'string' ? part : (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') return (content as { text: string }).text;
  return '';
}

/** 把请求里的 messages 归一成纯文本消息：developer 视作 system，tool 结果跳过（网页聊天没有工具调用）。 */
export function normalizeChatMessages(raw: unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    const mapped = role === 'developer' ? 'system' : role;
    if (mapped !== 'system' && mapped !== 'user' && mapped !== 'assistant') continue;
    messages.push({ role: mapped, content: chatContentToText(content) });
  }
  return messages;
}

export function messagesToPrompt(messages: ChatMessage[]): string {
  const system = messages.filter(m => m.role === 'system').map(m => m.content.trim()).filter(Boolean);
  const turns = messages.filter(m => m.role !== 'system');
  const parts: string[] = [];
  if (system.length) parts.push(system.join('\n'));
  // Keep the final user turn as the live prompt; earlier turns become context.
  const lastUser = [...turns].reverse().find(m => m.role === 'user');
  const history = turns.filter(m => m !== lastUser);
  if (history.length) {
    parts.push('以下是此前的对话，请结合上下文回答最后的问题：');
    for (const message of history) parts.push(`${message.role === 'user' ? '用户' : '助手'}：${message.content}`);
  }
  if (lastUser) parts.push(lastUser.content);
  return parts.join('\n\n').trim();
}

function json(response: ServerResponse, code: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  response.end(body);
}

function openAiError(response: ServerResponse, code: number, message: string, type = 'invalid_request_error') {
  json(response, code, { error: { message, type, param: null, code: null } });
}

function completionChunk(id: string, model: string, delta: { role?: string; content?: string }, finish_reason: string | null = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason }],
  };
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    // 边读边限：读完全部再检查对超大 body 毫无防护（loopback 免鉴权下任何本机进程都能打）。
    if (total > MAX_BODY_BYTES) throw new Error(`请求体超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB 限制`);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * Extracts and normalizes reference image paths from various payload conventions.
 * Supports BeefTV's image_url, file:// URLs, base64 data URLs, and existing local paths.
 */
/** 豆包页面里的视频模型；模型 id 形如 doubao-video-account-2--seedance-2-0-mini 时取后缀。 */
const VIDEO_MODEL_VARIANTS: Record<string, string> = {
  'seedance-2-5': 'Seedance 2.5',
  'seedance-2-0': 'Seedance 2.0',
  'seedance-2-0-fast': 'Seedance 2.0 Fast',
  'seedance-2-0-mini': 'Seedance 2.0 Mini',
};
export function extractVideoModelVariant(model?: string): string | undefined {
  if (typeof model !== 'string') return undefined;
  const match = /--([a-z0-9-]+)$/i.exec(model.trim());
  return match ? VIDEO_MODEL_VARIANTS[match[1].toLowerCase()] : undefined;
}

/**
 * 图片请求里的豆包页面图片模型：优先用 image_model 字段（节点上选的 Seedream 版本），
 * 其次模型名本身就是页面模型；doubao-image-account-N 这类账号模型 id 不是页面模型，使用默认。
 */
export function resolveImagePageModel(model?: string, imageModel?: unknown): string {
  const known = IMAGE_MODELS as readonly string[];
  if (typeof imageModel === 'string' && known.includes(imageModel.trim())) return imageModel.trim();
  if (typeof model === 'string' && known.includes(model.trim())) return model.trim();
  return DEFAULT_IMAGE_MODEL;
}

export function extractTargetAccountId(model?: string, explicitAccountId?: number | null): number | null {
  if (typeof explicitAccountId === 'number' && Number.isFinite(explicitAccountId)) return explicitAccountId;
  if (typeof model === 'string') {
    const match = /(?:account|acc)[-_:]?(\d+)/i.exec(model);
    if (match) return Number(match[1]);
  }
  return null;
}

export async function parseVideoReferencePaths(body: Record<string, unknown>): Promise<string[]> {
  const referencePaths: string[] = [];
  const rawRefs: string[] = [];

  if (typeof body.image_url === 'string' && body.image_url) rawRefs.push(body.image_url);
  if (typeof body.image === 'string' && body.image) rawRefs.push(body.image);
  if (typeof body.reference_image === 'string' && body.reference_image) rawRefs.push(body.reference_image);
  if (Array.isArray(body.images)) for (const img of body.images) if (typeof img === 'string' && img) rawRefs.push(img);
  // BeefTV newapi 协议的参考图字段
  if (Array.isArray(body.image_urls)) for (const img of body.image_urls) if (typeof img === 'string' && img) rawRefs.push(img);
  if (Array.isArray(body.reference_images)) for (const img of body.reference_images) if (typeof img === 'string' && img) rawRefs.push(img);
  if (Array.isArray(body.reference_paths)) for (const img of body.reference_paths) if (typeof img === 'string' && img) rawRefs.push(img);
  if (Array.isArray(body.referencePaths)) for (const img of body.referencePaths) if (typeof img === 'string' && img) rawRefs.push(img);
  if (Array.isArray(body.extra_references)) for (const img of body.extra_references) if (typeof img === 'string' && img) rawRefs.push(img);

  for (const ref of rawRefs) {
    if (typeof ref === 'string' && ref.trim()) {
      let trimmed = ref.trim();
      if (trimmed.startsWith('file://')) {
        try {
          trimmed = fileURLToPath(trimmed);
        } catch {
          trimmed = trimmed.replace(/^file:\/\/\/?/, '');
        }
      }

      if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) {
        const mime = /^data:([^;,]+)/i.exec(trimmed)?.[1]?.toLowerCase() ?? 'image/png';
        const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
        const tempDir = path.join(require('node:os').tmpdir(), 'doubao-gateway-videos');
        mkdirSync(tempDir, { recursive: true });
        const tempFile = path.join(tempDir, `ref-${randomUUID()}.${ext}`);
        const base64 = trimmed.slice(trimmed.indexOf(',') + 1);
        // 参考图可能有数 MB，异步写避免阻塞主进程事件循环。
        await fs.promises.writeFile(tempFile, Buffer.from(base64, 'base64'));
        referencePaths.push(tempFile);
      } else if (existsSync(trimmed)) {
        referencePaths.push(trimmed);
      }
    }
  }

  return referencePaths;
}

/** 远程参考图 URL（BeefTV 资源引用是 loopback http 地址），需要下载为本地文件后才能进豆包页面。 */
function extractRemoteReferenceUrls(body: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const fields: unknown[] = [
    body.image_url, body.image, body.reference_image,
    ...(Array.isArray(body.images) ? body.images : []),
    ...(Array.isArray(body.image_urls) ? body.image_urls : []),
    ...(Array.isArray(body.reference_images) ? body.reference_images : []),
  ];
  for (const value of fields) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) urls.push(value.trim());
  }
  return urls;
}

const REMOTE_REFERENCE_LIMIT_BYTES = 20 * 1024 * 1024;

async function downloadReferenceToTemp(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`下载参考图失败：HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > REMOTE_REFERENCE_LIMIT_BYTES) throw new Error('参考图超过 20MB 限制');
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg'
      : contentType.includes('webp') ? 'webp' : 'png';
    const tempDir = path.join(require('node:os').tmpdir(), 'doubao-gateway-videos');
    mkdirSync(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `ref-${randomUUID()}.${ext}`);
    await fs.promises.writeFile(tempFile, buffer);
    return tempFile;
  } finally {
    clearTimeout(timer);
  }
}

/** 解析请求体中的全部参考图：本地路径/data URL 直接用，远程 URL 下载到临时目录。 */
export async function resolveVideoReferencePaths(body: Record<string, unknown>): Promise<string[]> {
  const localPaths = await parseVideoReferencePaths(body);
  const remoteUrls = extractRemoteReferenceUrls(body);
  if (!remoteUrls.length) return localPaths;
  const downloads = await Promise.allSettled(remoteUrls.map((url) => downloadReferenceToTemp(url)));
  const downloaded: string[] = [];
  for (const result of downloads) if (result.status === 'fulfilled') downloaded.push(result.value);
  return [...localPaths, ...downloaded];
}

export class DoubaoGateway {
  private server = createServer((req, res) => { void this.handle(req, res); });
  private requests = 0;
  private startupError: string | null = null;
  /** 实际绑定成功的端口（EADDRINUSE 后探时会偏离配置值）。 */
  private portUsed = 0;
  private onLog: (message: string) => void;

  constructor(
    private runtime: GatewayRuntime,
    private options: GatewayOptions,
  ) {
    this.onLog = options.onLog ?? (() => {});
  }

  get port() { return this.portUsed || (this.options.port ?? 8788); }
  get url() { return 'http://127.0.0.1:' + this.port; }
  get requestCount() { return this.requests; }
  get defaultModel() { return DEFAULT_MODEL; }
  get error() { return this.startupError; }
  get pool() { return this.options.pool; }
  private busyAccountIds() { return this.options.busyAccountIds(); }

  start() {
    // 端口被占用时依次后探而不是直接罢工：渠道同步会把 baseUrl 写进 BeefTV
    // 配置，网关静默死亡意味着整条 BeefTV → 网关链路一起失效。
    const tryListen = (port: number, attemptsLeft: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
          tryListen(port + 1, attemptsLeft - 1);
          return;
        }
        this.startupError = error.code === 'EADDRINUSE'
          ? `本地网关端口 ${this.options.port ?? 8788}~${port} 均被占用，网关未启动；请关闭其他豆包工作站实例后重启。`
          : `网关启动失败：${error.message}`;
        this.onLog(this.startupError);
      };
      this.server.once('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        this.portUsed = port;
        this.onLog(`本地 OpenAI 兼容网关已在 http://127.0.0.1:${port} 启动`);
      });
    };
    this.cleanupTempReferences();
    tryListen(this.options.port ?? 8788, 8);
  }

  stop() {
    this.server.close();
    // 立即断开存量 keep-alive 连接，restartGateway 后新实例才能马上绑回同端口。
    this.server.closeAllConnections?.();
  }

  /** 清理上次会话遗留的参考图临时文件（仅启动时执行一次，删 1 小时前的）。 */
  private cleanupTempReferences() {
    const tempDir = path.join(require('node:os').tmpdir(), 'doubao-gateway-videos');
    fs.promises.readdir(tempDir).then(async (entries) => {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const entry of entries) {
        if (!entry.startsWith('ref-')) continue;
        const filePath = path.join(tempDir, entry);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.mtimeMs < cutoff) await fs.promises.unlink(filePath);
        } catch { /* 文件可能已被其他进程清理 */ }
      }
    }).catch(() => undefined);
  }

  private authorized(request: IncomingMessage): boolean {
    if (!this.options.apiKey) return true;
    const remote = request.socket.remoteAddress;
    // Allow seamless loopback from local applications (e.g. native BeefTV)
    if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
      return true;
    }
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    return token === this.options.apiKey;
  }

  private pickAccount(): Account | null {
    const doubao = this.runtime.accounts().filter(a => a.platform === 'doubao');
    const merged = new Set(this.busyAccountIds());
    for (const id of this.inflightAccountIds) merged.add(id);
    return this.pool.pick(doubao, merged);
  }

  /**
   * 网关自身的在途账号集合：chat/图片请求取号后必须登记，否则两个并发请求会
   * 加权随机命中同一账号并同时驱动同一个 BrowserView（第二个请求的页面导航
   * 会打断第一个在途的 SSE）。
   */
  private readonly inflightAccountIds = new Set<number>();

  private withAccount<T>(accountId: number, work: () => Promise<T>): Promise<T> {
    this.inflightAccountIds.add(accountId);
    return Promise.resolve()
      .then(work)
      .finally(() => { this.inflightAccountIds.delete(accountId); });
  }

  private async images(request: IncomingMessage, response: ServerResponse) {
    const body = await readBody(request);
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return openAiError(response, 400, '缺少 prompt');

    const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_IMAGE_MODEL;
    const size = typeof body.size === 'string' && body.size ? body.size : DEFAULT_IMAGE_RATIO;
    const ratio = IMAGE_RATIOS.includes(size as any) ? (size as any) : DEFAULT_IMAGE_RATIO;
    const count = typeof body.n === 'number' && body.n > 0 ? Math.min(body.n, 4) : 1;

    const doubaoAccounts = this.runtime.accounts().filter(a => a.platform === 'doubao');
    // 豆包 3.0：定向账号（豆包图片节点绑定的具体账号）优先，失败不漂移到其他账号
    const targetAccountId = extractTargetAccountId(model, typeof body.account_id === 'number' ? body.account_id : (typeof body.accountId === 'number' ? body.accountId : null));
    const fixedAccounts: Account[] = targetAccountId ? doubaoAccounts.filter(a => a.id === targetAccountId) : [];
    const maxAttempts = targetAccountId ? fixedAccounts.length : Math.min(3, Math.max(1, doubaoAccounts.length));
    const wantB64 = body.response_format === 'b64_json';
    let lastError: Error | null = null;
    const referencePaths = await resolveVideoReferencePaths(body);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const account = targetAccountId ? fixedAccounts[attempt] : this.pickAccount();
      if (!account) break;

      const view = (this.runtime.viewForAccount(account.id) ?? this.runtime.openAccount(account.id)) as any;
      if (!view?.webContents || view.webContents.isDestroyed()) {
        this.pool.markFailure(account.id, 'transient', '无法打开账号页面（临时不可用，稍后重试）');
        continue;
      }

      this.requests += 1;
      try {
        if (referencePaths.length && this.runtime.prepareNewConversation) {
          await this.runtime.prepareNewConversation(account.id);
        }
        const uploaded: unknown[] = [];
        for (const p of referencePaths) {
          uploaded.push(await uploadImageToDoubao(view, p, path.basename(p)));
        }
        let images: Array<{ url: string; width?: number; height?: number; format?: string }> = [];
        if (uploaded.length > 0) {
          const chatPrompt = ratio ? `${prompt}（请生成 ${ratio} 比例的图片）` : prompt;
          const result = await this.withAccount(account.id, () => streamChat(view, chatPrompt, {
            attachments: uploaded,
          }));
          const urls = new Set<string>(result.mediaUrls?.length ? result.mediaUrls : extractMediaUrls(result.answer));
          if (!urls.size) {
            throw new Error(`豆包未返回生成的图片：${result.answer.slice(0, 80) || '无响应内容'}`);
          }
          images = Array.from(urls).map(url => ({
            url,
            width: 0,
            height: 0,
            format: 'png',
          }));
        } else {
          images = await this.withAccount(account.id, () => generateImages(view, prompt, { model: resolveImagePageModel(model, body.image_model), ratio }));
        }
        this.pool.markOk(account.id);
        const created = Math.floor(Date.now() / 1000);
        // OpenAI 兼容的 b64_json 返回：服务端下载原图，避免浏览器跨域抓取豆包 CDN 被拦
        if (wantB64) {
          const encoded = await Promise.all(images.map(async (img) => {
            const response = await fetch(img.url);
            if (!response.ok) throw new Error(`下载生成图失败：HTTP ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            return { b64_json: buffer.toString('base64'), revised_prompt: prompt, mime: response.headers.get('content-type') || img.format || 'image/png' };
          }));
          json(response, 200, { created, data: encoded });
          return;
        }
        json(response, 200, {
          created,
          data: images.map(img => ({ url: img.url, revised_prompt: prompt })),
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : '生图失败';
        this.pool.markFailure(account.id, classify(message), message);
        lastError = new Error(`账号 ${account.name} 生图失败：${message}`);
        this.onLog(`账号 ${account.name} 失败，尝试故障转移下一个账号 (尝试 ${attempt + 1}/${maxAttempts})`);
      }
    }

    const finalMessage = lastError?.message ?? '生图失败，无可用账号';
    openAiError(response, 502, finalMessage, 'server_error');
  }

  /**
   * Video generation over API.
   * If createVideoTask is provided, creates an asynchronous task and immediately returns task_id (BeefTV contract).
   * Otherwise falls back to legacy synchronous video generation.
   */
  private async videos(request: IncomingMessage, response: ServerResponse) {
    const body = await readBody(request);
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return openAiError(response, 400, '缺少 prompt');

    const model = typeof body.model === 'string' && body.model ? body.model : 'doubao-video';
    // BeefTV newapi 协议用 aspect_ratio/seconds 字段名
    const ratioSource = [body.ratio, body.aspect_ratio, body.size].find((v) => typeof v === 'string' && /^\d+:\d+$/.test(v));
    const ratio = typeof ratioSource === 'string' ? ratioSource : '16:9';
    const durationSource = typeof body.duration === 'number' ? body.duration : (typeof body.seconds === 'number' ? body.seconds : undefined);
    const duration = durationSource;
    const rawAccountId = typeof body.account_id === 'number' ? body.account_id : (typeof body.accountId === 'number' ? body.accountId : null);
    const accountId = extractTargetAccountId(model, rawAccountId);
    // 豆包 3.0：视频模型名（Seedance 2.5/2.0/Fast/Mini）单独透传给页面自动化；
    // model 字段仍承担 doubao-video-account-N 的账号定向职责。
    const videoModel = typeof body.video_model === 'string' && body.video_model.trim() ? body.video_model.trim() : extractVideoModelVariant(model);
    const referencePaths = await resolveVideoReferencePaths(body);

    this.requests += 1;

    // 豆包 3.0: 异步任务模式优先 (BeefTV 契约)
    if (this.runtime.createVideoTask) {
      try {
        const task = await this.runtime.createVideoTask({
          prompt,
          model: videoModel ?? model,
          ratio,
          duration,
          accountId,
          referencePaths,
        });

        const created_at = Math.floor(Date.now() / 1000);
        json(response, 200, {
          task_id: task.id,
          status: 'processing',
          created_at,
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : '创建视频任务失败';
        openAiError(response, 500, `创建视频任务失败：${message}`, 'server_error');
        return;
      }
    }

    // 兼容回退: 同步等待模式
    if (!this.runtime.generateVideo) {
      return openAiError(response, 501, '当前服务未启用视频生成能力', 'not_implemented');
    }

    try {
      const items = await this.runtime.generateVideo(prompt, { model, ratio, duration, accountId, referencePaths });
      const created = Math.floor(Date.now() / 1000);
      json(response, 200, {
        created,
        model,
        data: items.map(item => ({ url: item.url, revised_prompt: prompt, path: item.path, name: item.name })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成视频失败';
      openAiError(response, 502, `视频生成失败：${message}`, 'server_error');
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url || '/', `http://127.0.0.1:${this.port}`);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      response.end();
      return;
    }

    try {
      if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
        json(response, 200, {
          ok: true,
          service: 'doubao-gateway',
          requests: this.requests,
          error: this.startupError,
          accounts: this.pool.snapshot(this.runtime.accounts().filter(a => a.platform === 'doubao'), this.busyAccountIds())
            .map(({ accountId, health, available, dailyUsed }) => ({ accountId, health, available, dailyUsed })),
        });
        return;
      }

      if (request.method === 'GET' && (url.pathname === '/v1/accounts' || url.pathname === '/v1/doubao/accounts')) {
        const doubaoAccounts = this.runtime.accounts().filter(a => a.platform === 'doubao');
        const busy = this.busyAccountIds();
        const healthById = new Map(
          this.pool.snapshot(doubaoAccounts, busy)
            .map((snap) => [snap.accountId, snap] as const),
        );
        json(response, 200, {
          ok: true,
          accounts: doubaoAccounts.map((a) => {
            const snap = healthById.get(a.id);
            const health = snap?.health ?? 'healthy';
            return {
              id: a.id,
              name: a.name,
              avatar: '',
              platform: a.platform,
              isLoggedIn: Boolean(a.isLoggedIn),
              // 豆包 3.0 契约（DOUBAO_3.0_SPEC §4.1）：status 健康态 + quota 配额态
              status: health,
              quota: health === 'quota_exhausted' ? 'exhausted' : 'normal',
              available: snap?.available ?? true,
              dailyUsed: snap?.dailyUsed ?? 0,
              busy: busy.has(a.id),
            };
          }),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/accounts/add') {
        const next = await Promise.resolve(this.runtime.addAccount?.() ?? null);
        json(response, 200, { ok: true, account: next });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/models') {
        if (!this.authorized(request)) return openAiError(response, 401, '无效的 API Key', 'authentication_error');
        const doubaoAccounts = this.runtime.accounts().filter(a => a.platform === 'doubao');
        const accountChatModels = doubaoAccounts.map(a => ({
          id: `doubao-account-${a.id}`,
          object: 'model',
          created: 0,
          owned_by: 'doubao-workspace',
          description: `豆包账号: ${a.name || `账号${a.id}`}${a.isLoggedIn ? ' (在线)' : ' (离线)'}`,
        }));
        const accountVideoModels = doubaoAccounts.map(a => ({
          id: `doubao-video-account-${a.id}`,
          object: 'model',
          created: 0,
          owned_by: 'doubao-workspace',
          description: `视频专属: ${a.name || `账号${a.id}`}`,
        }));

        json(response, 200, {
          object: 'list',
          data: [
            ...Object.entries(MODEL_ALIASES).map(([id, meta]) => ({ id, object: 'model', created: 0, owned_by: 'doubao-workspace', description: meta.label })),
            ...accountChatModels,
            ...IMAGE_MODELS.map(id => ({ id, object: 'model', created: 0, owned_by: 'doubao-workspace', description: '图像生成' })),
            ...VIDEO_MODELS.map(id => ({ id, object: 'model', created: 0, owned_by: 'doubao-workspace', description: '视频生成' })),
            { id: 'doubao-video', object: 'model', created: 0, owned_by: 'doubao-workspace', description: '豆包网页多账号自动化视频' },
            ...accountVideoModels,
          ],
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        if (!this.authorized(request)) return openAiError(response, 401, '无效的 API Key', 'authentication_error');
        await this.chat(request, response);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/images/generations') {
        if (!this.authorized(request)) return openAiError(response, 401, '无效的 API Key', 'authentication_error');
        await this.images(request, response);
        return;
      }

      if (request.method === 'POST' && (url.pathname === '/v1/videos/generations' || url.pathname === '/v1/video/generations')) {
        if (!this.authorized(request)) return openAiError(response, 401, '无效的 API Key', 'authentication_error');
        await this.videos(request, response);
        return;
      }

      // 豆包 3.0: 视频任务状态轮询与素材导出端点 (/v1/video/tasks/:id 或 /v1/video/generations/:id)
      const taskMatch = /^\/v1\/video\/(?:tasks|generations)\/([^/]+)(?:\/(video|last_frame|cancel|confirm))?$/.exec(url.pathname);
      if (taskMatch) {
        if (!this.authorized(request)) return openAiError(response, 401, '无效的 API Key', 'authentication_error');
        const taskId = decodeURIComponent(taskMatch[1]);
        const action = taskMatch[2];

        if (action === 'cancel' && request.method === 'POST') {
          const ok = await Promise.resolve(this.runtime.cancelVideoTask?.(taskId) ?? false);
          json(response, 200, { task_id: taskId, status: 'cancelled', ok });
          return;
        }

        // 豆包在生成前要求确认参数/补充材料时，节点把用户输入作为补充消息发回页面。
        if (action === 'confirm' && request.method === 'POST') {
          if (!this.runtime.confirmVideoTask) return openAiError(response, 501, '当前版本不支持发送补充消息', 'not_implemented_error');
          const body = await readBody(request).catch(() => ({}) as Record<string, unknown>);
          const text = typeof body.text === 'string' ? body.text.trim() : typeof body.input === 'string' ? body.input.trim() : '';
          if (!text) return openAiError(response, 400, '缺少补充消息内容（text）', 'invalid_request_error');
          try {
            const ok = await Promise.resolve(this.runtime.confirmVideoTask(taskId, text));
            if (!ok) return openAiError(response, 409, '任务当前不能发送补充消息（可能已完成、已取消或页面不可用）', 'conflict_error');
            json(response, 200, { task_id: taskId, ok: true });
          } catch (error) {
            openAiError(response, 502, error instanceof Error ? error.message : '补充消息发送失败', 'server_error');
          }
          return;
        }

        const task = this.runtime.getVideoTask?.(taskId);
        if (!task) {
          openAiError(response, 404, `未找到视频任务 ${taskId}`, 'not_found_error');
          return;
        }

        if (action === 'video' && request.method === 'GET') {
          if (!task.videoPath || !existsSync(task.videoPath)) {
            openAiError(response, 409, '视频文件尚未生成或不存在', 'conflict_error');
            return;
          }
          const stat = statSync(task.videoPath);
          response.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': String(stat.size),
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          createReadStream(task.videoPath).pipe(response);
          return;
        }

        if (action === 'last_frame' && request.method === 'GET') {
          if (!task.lastFramePath || !existsSync(task.lastFramePath)) {
            openAiError(response, 409, '视频尾帧尚未生成或不存在', 'conflict_error');
            return;
          }
          const stat = statSync(task.lastFramePath);
          response.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': String(stat.size),
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          createReadStream(task.lastFramePath).pipe(response);
          return;
        }

        if (!action && request.method === 'GET') {
          let status: GatewayVideoTaskStatus = 'processing';
          let progress = 50;
          if (task.status === 'completed') {
            status = 'completed';
            progress = 100;
          } else if (task.status === 'queued' || task.status === 'assigned') {
            status = 'queued';
            progress = 10;
          } else if (task.status === 'needs_attention') {
            status = 'needs_attention';
            progress = 50;
          } else if (task.status === 'awaiting_confirmation' || task.status === 'awaiting_reply') {
            // 豆包在生成前要求确认/补充材料或等待用户回复：把原文带给节点展示，并支持补充消息。
            status = 'awaiting_confirmation';
            progress = 30;
          } else if (task.status === 'failed') {
            status = 'failed';
            progress = 0;
          } else if (task.status === 'cancelled') {
            status = 'cancelled';
            progress = 0;
          } else if (task.status === 'downloading') {
            status = 'processing';
            progress = 85;
          } else {
            status = 'processing';
            progress = 40;
          }

          const videoUrl = task.videoPath && existsSync(task.videoPath)
            ? `http://127.0.0.1:${this.port}/v1/video/tasks/${encodeURIComponent(task.id)}/video`
            : null;

          // 后端任务系统（NewAPI 视频协议）走 /v1/video/generations/{id}，只认 processing/completed/failed 等标准状态：
          // 「等待确认」「需要人机验证」对它来说仍是进行中，由节点界面用 awaiting_reply / message 展示并处理。
          // 旧的 /v1/video/tasks/{id} 保持原状态，豆包账号节点依赖它。
          const standardPolling = url.pathname.startsWith('/v1/video/generations/');
          const waitingOnUser = status === 'awaiting_confirmation' || status === 'needs_attention';
          const result: GatewayVideoTaskResponse & Record<string, unknown> = {
            task_id: task.id,
            id: task.id,
            status: standardPolling && waitingOnUser ? 'processing' : status,
            awaiting_reply: waitingOnUser,
            message: waitingOnUser ? (task.statusText || '') : undefined,
            progress,
            video_url: videoUrl,
            video_urls: videoUrl ? [videoUrl] : [],
            videos: videoUrl ? [videoUrl] : [],
            data: videoUrl ? [{ url: videoUrl }] : [],
            local_path: task.videoPath || null,
            last_frame_path: task.lastFramePath || null,
            status_text: task.statusText || '',
            latest_reply: task.latestReply || null,
            error: task.error || null,
            created_at: task.createdAt ? Math.floor(new Date(task.createdAt).getTime() / 1000) : undefined,
            updated_at: task.updatedAt ? Math.floor(new Date(task.updatedAt).getTime() / 1000) : undefined,
          };
          json(response, 200, result);
          return;
        }
      }

      openAiError(response, 404, `未找到接口 ${url.pathname}`, 'not_found_error');
    } catch (error) {
      const message = error instanceof Error ? error.message : '网关内部错误';
      this.onLog(`网关请求失败：${message}`);
      if (!response.headersSent) openAiError(response, 500, message, 'server_error');
      else response.end();
    }
  }

  private async chat(request: IncomingMessage, response: ServerResponse) {
    const body = await readBody(request);
    const messages: ChatMessage[] = normalizeChatMessages(Array.isArray(body.messages) ? body.messages : []);
    if (!messages.length) return openAiError(response, 400, '缺少 messages');
    const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
    const prompt = messagesToPrompt(messages);
    if (!prompt) return openAiError(response, 400, '消息内容为空');

    const targetAccountId = extractTargetAccountId(model, typeof body.account_id === 'number' ? body.account_id : (typeof body.accountId === 'number' ? body.accountId : null));
    const targetAccount = targetAccountId != null
      ? this.runtime.accounts().find(a => a.id === targetAccountId && a.platform === 'doubao')
      : null;
    const account = targetAccount || this.pickAccount();
    if (!account) return openAiError(response, 503, '没有可调度的豆包账号，请检查账号池状态', 'service_unavailable');

    const view = (this.runtime.viewForAccount(account.id) ?? this.runtime.openAccount(account.id)) as any;
    if (!view?.webContents || view.webContents.isDestroyed()) {
      this.pool.markFailure(account.id, 'transient', '无法打开账号页面（临时不可用，稍后重试）');
      return openAiError(response, 503, `账号 ${account.name} 页面不可用`, 'service_unavailable');
    }

    this.requests += 1;
    const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = Boolean(body.stream);

    if (stream) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      // Keep intermediaries from closing an idle stream while Doubao thinks.
      const heartbeat = setInterval(() => { if (!response.writableEnded) response.write(': keep-alive\n\n'); }, 15_000);
      response.write(`data: ${JSON.stringify(completionChunk(id, model, { role: 'assistant', content: '' }))}\n\n`);
      try {
        const result = await this.withAccount(account.id, () => streamChat(view, prompt, {
          deepThink: MODEL_ALIASES[model]?.deepThink,
          onDelta: chunk => { if (!response.writableEnded) response.write(`data: ${JSON.stringify(completionChunk(id, model, { content: chunk }))}\n\n`); },
        }));
        this.pool.markOk(account.id);
        if (!response.writableEnded) {
          response.write(`data: ${JSON.stringify(completionChunk(id, model, {}, 'stop'))}\n\n`);
          response.write('data: [DONE]\n\n');
        }
        void result;
      } catch (error) {
        const message = error instanceof Error ? error.message : '生成失败';
        this.pool.markFailure(account.id, classify(message), message);
        if (!response.writableEnded) {
          response.write(`data: ${JSON.stringify({ error: { message, type: 'server_error' } })}\n\n`);
          response.write('data: [DONE]\n\n');
        }
      } finally {
        clearInterval(heartbeat);
        if (!response.writableEnded) response.end();
      }
      return;
    }

    let lastChatError: Error | null = null;
    const maxAttempts = Math.min(3, Math.max(1, this.runtime.accounts().filter(a => a.platform === "doubao").length));
    let currentAccount = account;
    let currentView = view;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        const next = this.pickAccount();
        if (!next) break;
        currentAccount = next;
        currentView = (this.runtime.viewForAccount(currentAccount.id) ?? this.runtime.openAccount(currentAccount.id)) as any;
        if (!currentView?.webContents || currentView.webContents.isDestroyed()) {
          this.pool.markFailure(currentAccount.id, 'transient', '无法打开账号页面（临时不可用，稍后重试）');
          continue;
        }
      }

      try {
        const { answer } = await this.withAccount(currentAccount.id, () => streamChat(currentView, prompt, { deepThink: MODEL_ALIASES[model]?.deepThink }));
        this.pool.markOk(currentAccount.id);
        json(response, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
          usage: { prompt_tokens: prompt.length, completion_tokens: answer.length, total_tokens: prompt.length + answer.length },
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : '生成失败';
        this.pool.markFailure(currentAccount.id, classify(message), message);
        lastChatError = new Error(`账号 ${currentAccount.name} 生成失败：${message}`);
        this.onLog(`账号 ${currentAccount.name} 失败，故障转移至下一个账号 (尝试 ${attempt + 1}/${maxAttempts})`);
      }
    }

    const finalMessage = lastChatError?.message ?? '生成失败，无可用账号';
    openAiError(response, 502, finalMessage, 'server_error');
  }
}

/** Maps a page-level failure onto the account pool's taxonomy. */
export function classify(message: string): 'quota' | 'captcha' | 'logged_out' | 'transient' {
  if (/710022004|人机验证|安全验证|滑块/.test(message)) return 'captcha';
  if (/额度|次数用完|上限|配额/.test(message)) return 'quota';
  // Cookie 过期的真实表现是页面内 fetch 返回 401/403（错误串形如 "HTTP 401：..."），
  // 不识别的话失效账号只会进入 transient 冷却-再调度-再失败的死循环。
  if (/未登录|登录已过期|会话失效|登录状态已失效|请重新登录|\bHTTP 40[13]\b/.test(message)) return 'logged_out';
  return 'transient';
}
