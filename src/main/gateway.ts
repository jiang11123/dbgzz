import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Account } from '../shared/types';
import type { AccountPool } from './account-pool';
import { streamChat } from './doubao-api';
import { generateImages, DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_RATIO, IMAGE_MODELS, IMAGE_RATIOS } from './doubao-image';
import { VIDEO_MODELS } from './doubao-video';

export type GatewayRuntime = {
  accounts: () => Account[];
  /** Opens (or reuses) the account page and returns it, or null when unavailable. */
  viewForAccount: (accountId: number) => unknown | null;
  openAccount: (accountId: number) => unknown | null;
  generateVideo?: (prompt: string, options: { model?: string; ratio?: string; duration?: number; accountId?: number | null; referencePaths?: string[] }) => Promise<{ url?: string; path?: string; name?: string }[]>;
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
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function openAiError(response: ServerResponse, code: number, message: string, type = 'invalid_request_error') {
  json(response, code, { error: { message, type, code: null, param: null } });
}

async function readBody(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if (raw.length > 4 * 1024 * 1024) throw new Error('请求体过大');
  return JSON.parse(raw);
}

function completionChunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] };
}

/**
 * OpenAI-compatible gateway backed by the signed-in Doubao account pages.
 * Binds to 127.0.0.1 only and requires a local bearer token.
 */
export class DoubaoGateway {
  private server = createServer((request, response) => void this.handle(request, response));
  private startupError: string | null = null;
  private readonly port: number;
  private readonly apiKey: string;
  private readonly pool: AccountPool;
  private readonly busyAccountIds: () => ReadonlySet<number>;
  private readonly onLog: (message: string) => void;
  private requests = 0;
  private readonly accountQueues = new Map<number, Promise<void>>();
  /** Queue gates still open, so stop() can release work that never started. */
  private readonly pendingReleases = new Set<() => void>();

  constructor(private readonly runtime: GatewayRuntime, options: GatewayOptions) {
    this.port = options.port ?? 8788;
    this.apiKey = options.apiKey ?? '';
    this.pool = options.pool;
    this.busyAccountIds = options.busyAccountIds;
    this.onLog = options.onLog ?? (() => {});
  }

  start() {
    this.server.on('error', (error: NodeJS.ErrnoException) => {
      this.startupError = error.code === 'EADDRINUSE'
        ? `网关端口 ${this.port} 已被占用，API 网关未启动。`
        : `API 网关启动失败：${error.message}`;
      this.onLog(this.startupError);
    });
    this.server.listen(this.port, '127.0.0.1', () => this.onLog(`API 网关已监听 http://127.0.0.1:${this.port}/v1`));
  }

  stop() { this.server.close(); }
  get error() { return this.startupError; }
  get url() { return `http://127.0.0.1:${this.port}/v1`; }
  get requestCount() { return this.requests; }
  get defaultModel() { return DEFAULT_MODEL; }

  private authorized(request: IncomingMessage): boolean {
    if (!this.apiKey) return true;
    const header = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    return token === this.apiKey;
  }

  private pickAccount(): Account | null {
    return this.pool.pick(this.runtime.accounts().filter(a => a.platform === 'doubao'), this.busyAccountIds());
  }

  /**
   * Serializes work per account page.
   *
   * One BrowserView can only compose and submit one message at a time; overlapping
   * requests would fight over the same composer and stall each other.
   */
  private async withAccount<T>(accountId: number, work: () => Promise<T>): Promise<T> {
    const previous = this.accountQueues.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.pendingReleases.add(release);
    const queued = previous.then(() => gate);
    this.accountQueues.set(accountId, queued);
    await previous;
    // Start the work once, so a client-side timeout cannot abandon it.
    const running = work();
    // A page stuck mid-navigation must not hold the queue open forever, so the caller
    // is failed early. The queue itself is released only when the work actually
    // settles: an abandoned run would keep typing into the same composer and fight
    // with the next request for that account.
    running.catch(() => {}).finally(() => {
      release();
      this.pendingReleases.delete(release);
      if (this.accountQueues.get(accountId) === queued) this.accountQueues.delete(accountId);
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('账号生成超时，请稍后重试')), REQUEST_TIMEOUT_MS);
        running.then(
          value => { clearTimeout(timer); resolve(value); },
          error => { clearTimeout(timer); reject(error); },
        );
      });
    } catch (error) {
      // Report the timeout, but keep the account reserved until the run finishes.
      throw error;
    }
  }

  /**
   * OpenAI-compatible image generation.
   *
   * Returns Doubao's CDN URLs. Those links are time-limited and reject direct requests
   * without the account cookies, so callers that need to persist an image should fetch
   * it through the workspace (which is what the built-in UI does).
   */
    private async images(request: IncomingMessage, response: ServerResponse) {
    const body = await readBody(request);
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return openAiError(response, 400, '缺少 prompt');
    const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_IMAGE_MODEL;
    const ratio = typeof body.size === 'string' && /^\d+:\d+$/.test(body.size) ? body.size : (typeof body.ratio === 'string' ? body.ratio : DEFAULT_IMAGE_RATIO);

    this.requests += 1;
    let lastError: Error | null = null;
    const maxAttempts = Math.min(3, Math.max(1, this.runtime.accounts().filter(a => a.platform === "doubao").length));

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const account = this.pickAccount();
      if (!account) {
        if (!lastError) return openAiError(response, 503, '没有可调度的豆包账号，请检查账号池状态', 'service_unavailable');
        break;
      }
      const view = (this.runtime.viewForAccount(account.id) ?? this.runtime.openAccount(account.id)) as any;
      if (!view?.webContents || view.webContents.isDestroyed()) {
        this.pool.markFailure(account.id, 'logged_out', '无法打开账号页面');
        lastError = new Error(`账号 ${account.name} 页面不可用`);
        continue;
      }

      try {
        const images = await this.withAccount(account.id, () => generateImages(view, prompt, { model, ratio }));
        this.pool.markOk(account.id);
        const created = Math.floor(Date.now() / 1000);
        json(response, 200, {
          created,
          model,
          data: images.map(image => ({ url: image.url, revised_prompt: prompt, width: image.width, height: image.height })),
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
   * Supports prompt, model, ratio, duration, and reference images.
   */
  private async videos(request: IncomingMessage, response: ServerResponse) {
    const body = await readBody(request);
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return openAiError(response, 400, '缺少 prompt');
    if (!this.runtime.generateVideo) return openAiError(response, 501, '当前服务未启用视频生成能力', 'not_implemented');

    const model = typeof body.model === 'string' && body.model ? body.model : 'Seedance 2.0';
    const ratio = typeof body.ratio === 'string' && /^\d+:\d+$/.test(body.ratio) ? body.ratio : (typeof body.size === 'string' && /^\d+:\d+$/.test(body.size) ? body.size : '16:9');
    const duration = typeof body.duration === 'number' ? body.duration : undefined;
    const accountId = typeof body.account_id === 'number' ? body.account_id : (typeof body.accountId === 'number' ? body.accountId : null);

    const referencePaths: string[] = [];
    const rawRefs: string[] = [];
    if (typeof body.image === 'string' && body.image) rawRefs.push(body.image);
    if (typeof body.reference_image === 'string' && body.reference_image) rawRefs.push(body.reference_image);
    if (Array.isArray(body.images)) for (const img of body.images) if (typeof img === 'string' && img) rawRefs.push(img);
    if (Array.isArray(body.reference_images)) for (const img of body.reference_images) if (typeof img === 'string' && img) rawRefs.push(img);

    for (const ref of rawRefs) {
      if (typeof ref === 'string' && ref.trim()) {
        const trimmed = ref.trim();
        if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) {
          const mime = /^data:([^;,]+)/i.exec(trimmed)?.[1]?.toLowerCase() ?? 'image/png';
          const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
          const tempDir = path.join(require('node:os').tmpdir(), 'doubao-gateway-videos');
          require('node:fs').mkdirSync(tempDir, { recursive: true });
          const tempFile = path.join(tempDir, `ref-${randomUUID()}.${ext}`);
          const base64 = trimmed.slice(trimmed.indexOf(',') + 1);
          require('node:fs').writeFileSync(tempFile, Buffer.from(base64, 'base64'));
          referencePaths.push(tempFile);
        } else if (require('node:fs').existsSync(trimmed)) {
          referencePaths.push(trimmed);
        }
      }
    }

    this.requests += 1;
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
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        if (!this.authorized(request)) return openAiError(response, 401, '无效的 API Key', 'authentication_error');
        json(response, 200, {
          object: 'list',
          data: [
            ...Object.entries(MODEL_ALIASES).map(([id, meta]) => ({ id, object: 'model', created: 0, owned_by: 'doubao-workspace', description: meta.label })),
            // Image models are advertised too, so a client can discover them; they are
            // served by /v1/images/generations rather than the chat endpoint.
            ...IMAGE_MODELS.map(id => ({ id, object: 'model', created: 0, owned_by: 'doubao-workspace', description: '图像生成' })),
            ...VIDEO_MODELS.map(id => ({ id, object: 'model', created: 0, owned_by: 'doubao-workspace', description: '视频生成' })),
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
    const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return openAiError(response, 400, '缺少 messages');
    const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
    const prompt = messagesToPrompt(messages);
    if (!prompt) return openAiError(response, 400, '消息内容为空');

    const account = this.pickAccount();
    if (!account) return openAiError(response, 503, '没有可调度的豆包账号，请检查账号池状态', 'service_unavailable');

    const view = (this.runtime.viewForAccount(account.id) ?? this.runtime.openAccount(account.id)) as any;
    if (!view?.webContents || view.webContents.isDestroyed()) {
      this.pool.markFailure(account.id, 'logged_out', '无法打开账号页面');
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
          this.pool.markFailure(currentAccount.id, 'logged_out', '无法打开账号页面');
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
  // Only an explicit session failure is permanent. A missing composer usually means
  // the page is still loading, so it must stay retryable instead of benching the account.
  if (/未登录|登录已过期|会话失效|登录状态已失效|请重新登录/.test(message)) return 'logged_out';
  return 'transient';
}
