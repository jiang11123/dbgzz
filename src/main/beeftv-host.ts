import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * 豆包 3.0：BeefTV 宿主服务。
 * 主窗口不再加载工作站自带 UI，而是加载原生 BeefTV web 构建产物：
 * - 静态伺服 web dist（SPA 回退到 index.html）；
 * - 同源反向代理 /api 到本地 BeefTV Go 后端（127.0.0.1:8790），避免跨域与桌面令牌问题；
 * - 按 NEED 拉起/回收后端子进程（beeftv-backend.exe，server profile）。
 */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
};

export type BeefTvHostOptions = {
  /** BeefTV web 构建产物目录（含 index.html）。 */
  webRoot: string;
  /** 独立后端 exe 路径；为空则只做静态服务与代理（后端由外部管理）。 */
  backendExe?: string | null;
  /** 后端监听地址（默认 127.0.0.1:8790）。 */
  backendAddr?: string;
  /** 静态服务端口（默认 8791，被占用时依次后探）。 */
  port?: number;
  /** 后端数据目录。 */
  backendDataDir?: string;
  /** 追加传给后端子进程的环境变量（如 CANVAS_OFFICIAL_PLUGIN_DIR）。 */
  backendEnv?: Record<string, string>;
  /**
   * 本机 owner 凭据提供者（读托管数据目录的 agent_owner_token）。
   * server profile 没有 Wails 桌面信任，/api/ops 写操作（画布保存等）需要
   * owner 身份；静态服务器是唯一入口且仅绑 127.0.0.1，在代理层注入等价于
   * 原生桌面壳的受信 UI，token 不会进页面。
   */
  ownerToken?: () => string;
  onLog?: (message: string) => void;
};

export class BeefTvHost {
  private server: Server | null = null;
  private backend: ChildProcess | null = null;
  private readonly backendAddr: string;
  private portUsed = 0;
  private readonly onLog: (message: string) => void;
  /** stop() 置位：区分主动退出与意外崩溃，只有后者才自动重生。 */
  private stopping = false;
  private backendRestartAttempts = 0;
  private backendRestartTimer: NodeJS.Timeout | null = null;

  constructor(private options: BeefTvHostOptions) {
    this.backendAddr = options.backendAddr || '127.0.0.1:8790';
    this.onLog = options.onLog || (() => {});
  }

  get port() { return this.portUsed; }
  get url() { return `http://127.0.0.1:${this.portUsed}`; }
  get backendSpawned() { return Boolean(this.backend); }

  async start(): Promise<{ url: string; backendSpawned: boolean }> {
    try {
      if (this.options.backendExe && existsSync(this.options.backendExe)) {
        await this.spawnBackend();
      } else if (this.options.backendExe) {
        this.onLog(`未找到 BeefTV 后端 ${this.options.backendExe}，仅启动静态服务`);
      }
      await this.startStaticServer();
    } catch (error) {
      // 启动失败必须回收已 spawn 的子进程，否则重试循环会留下孤儿后端
      // 继续占住 8790，新宿主还会把孤儿误判为"后端就绪"。
      this.stop();
      throw error;
    }
    this.onLog(`BeefTV 宿主已启动：${this.url}（API 代理至 ${this.backendAddr}）`);
    return { url: this.url, backendSpawned: this.backendSpawned };
  }

  private async spawnBackend() {
    const [host, portText] = this.backendAddr.split(':');
    this.backend = spawn(this.options.backendExe!, [], {
      env: {
        ...process.env,
        CANVAS_BACKEND_ADDR: this.backendAddr,
        ...(this.options.backendDataDir ? { CANVAS_BACKEND_DATA_DIR: this.options.backendDataDir } : {}),
        ...(this.options.backendEnv || {}),
        GIN_MODE: 'release',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: path.dirname(this.options.backendExe!),
    });
    this.backend.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.onLog(`[beeftv-backend] ${text}`);
    });
    this.backend.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.onLog(`[beeftv-backend] ${text}`);
    });
    this.backend.once('exit', (code) => {
      this.onLog(`BeefTV 后端进程退出（code ${code}）`);
      this.backend = null;
      if (this.stopping) return;
      // 后端 exe 意外退出（崩溃/被杀）时自动重生：静态页仍在但 /api 全部 502，
      // 没有这条路径的话只能重启整个应用才能恢复。
      this.scheduleBackendRestart();
    });
    await waitForPort(host, Number(portText), 30_000, 400);
    this.backendRestartAttempts = 0;
    this.onLog(`BeefTV 后端已就绪：${this.backendAddr}`);
  }

  private scheduleBackendRestart() {
    if (this.backendRestartTimer || this.stopping) return;
    const attempts = this.backendRestartAttempts;
    if (attempts >= 5) {
      this.onLog('BeefTV 后端连续重启失败，已停止自动重生（可重启应用恢复）');
      return;
    }
    this.backendRestartAttempts += 1;
    const delay = Math.min(30_000, 2_000 * 2 ** attempts);
    this.onLog(`BeefTV 后端将在 ${delay}ms 后自动重启（第 ${attempts + 1} 次尝试）`);
    this.backendRestartTimer = setTimeout(() => {
      this.backendRestartTimer = null;
      void this.spawnBackend().catch((error) => {
        this.onLog(`BeefTV 后端自动重启失败：${error instanceof Error ? error.message : error}`);
        this.scheduleBackendRestart();
      });
    }, delay);
    this.backendRestartTimer.unref();
  }

  private startStaticServer(): Promise<void> {
    const preferred = this.options.port || Number(process.env.BEEFTV_HOST_PORT) || 8791;
    return new Promise((resolve, reject) => {
      const tryListen = (port: number, attemptsLeft: number) => {
        const server = createServer((req, res) => this.handle(req, res));
        server.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE' && attemptsLeft > 0) tryListen(port + 1, attemptsLeft - 1);
          else reject(error);
        });
        server.listen(port, '127.0.0.1', () => {
          this.server = server;
          this.portUsed = port;
          resolve();
        });
      };
      tryListen(preferred, 8);
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${this.portUsed}`);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        this.proxyApi(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }
      this.serveStatic(url.pathname, res, req.method === 'HEAD');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
    }
  }

  private proxyApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const headers: Record<string, string | string[]> = { ...req.headers, host: this.backendAddr };
    const ownerToken = this.options.ownerToken?.() || '';
    // 配置恢复走本机 UI 读取路径；owner 会被后端识别为外部业务调用，
    // 隐去自定义渠道密钥，导致重启后已配置的模型被误判为不可用。
    const restoringModelConfig = req.method === 'GET' && url.pathname === '/api/workspace/model-config';
    if (ownerToken && !headers['x-beeftv-owner'] && !restoringModelConfig) headers['x-beeftv-owner'] = ownerToken;
    // 后端的同源豁免按 X-Forwarded-Host（缺省回落 Host）比对 Origin；
    // Host 已被改写为后端地址，必须把页面看到的原始 Host 透传过去，
    // 否则浏览器 POST（带 Origin）会被 CORS 中间件 403（Agent 对话读取全部失效）。
    if (!headers['x-forwarded-host']) headers['x-forwarded-host'] = String(req.headers.host || `127.0.0.1:${this.portUsed}`);
    // agent 路由的同源判定是 Origin 严格等于请求 Host（含端口）——静态端口与后端
    // 端口不同必被拒。代理是可信边界（仅 loopback + owner 注入），剥掉
    // Origin/Referer 让后端按"无 Origin 的本机请求"放行，与端口分配无关。
    delete headers.origin;
    delete headers.referer;
    const target = { host: '127.0.0.1', port: Number(this.backendAddr.split(':')[1]), path: url.pathname + url.search, method: req.method, headers };
    const upstream = httpRequest(target, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.once('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ code: 502, data: null, msg: `BeefTV 后端不可用：${error.message}` }));
    });
    // 客户端提前断开（刷新页面/SSE 取消）时回收上游连接，避免悬挂 socket 泄漏。
    req.on('aborted', () => {
      upstream.destroy();
    });
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  }

  private serveStatic(pathname: string, res: ServerResponse, headOnly: boolean) {
    const decoded = decodeURIComponent(pathname).replace(/^\/+/, '');
    const candidates = [
      path.join(this.options.webRoot, decoded),
      // SPA 路由回退：/canvas/xxx 等路径没有对应文件时回 index.html
      path.join(this.options.webRoot, 'index.html'),
    ];
    for (const filePath of candidates) {
      if (!isSafePath(this.options.webRoot, filePath) || !existsSync(filePath)) continue;
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(stat.size), 'Cache-Control': path.extname(filePath) === '.html' ? 'no-store' : 'public, max-age=3600' });
      if (headOnly) { res.end(); return; }
      const stream = createReadStream(filePath);
      // existsSync 与读取之间文件可能被清理，无监听的 error 事件会变成未捕获异常。
      stream.once('error', () => { if (!res.writableEnded) res.destroy(); });
      stream.pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }

  stop() {
    this.stopping = true;
    if (this.backendRestartTimer) { clearTimeout(this.backendRestartTimer); this.backendRestartTimer = null; }
    this.server?.close();
    this.server = null;
    if (this.backend && !this.backend.killed) {
      this.backend.kill();
    }
    this.backend = null;
  }
}

function isSafePath(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function waitForPort(host: string, port: number, timeoutMs: number, intervalMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probePort(host, port)) return;
    if (Date.now() >= deadline) throw new Error(`等待 BeefTV 后端端口 ${host}:${port} 超时`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
