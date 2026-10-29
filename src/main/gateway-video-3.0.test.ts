import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { DoubaoGateway, parseVideoReferencePaths, resolveVideoReferencePaths } from './gateway';
import { AccountPool } from './account-pool';

test('parseVideoReferencePaths parses file URLs, raw paths, and base64 images', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-ref-${Date.now()}.png`);
  fs.writeFileSync(tmpFile, 'mock-image');

  try {
    // 1. file:// URL
    const fileUrl = `file:///${tmpFile.replace(/\\/g, '/')}`;
    const parsed1 = await parseVideoReferencePaths({ image_url: fileUrl });
    assert.equal(parsed1.length, 1);
    assert.equal(path.normalize(parsed1[0]), path.normalize(tmpFile));

    // 2. Local absolute path
    const parsed2 = await parseVideoReferencePaths({ image: tmpFile });
    assert.equal(parsed2.length, 1);
    assert.equal(path.normalize(parsed2[0]), path.normalize(tmpFile));

    // 3. Base64 data URL
    const base64Data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const parsed3 = await parseVideoReferencePaths({ reference_images: [base64Data] });
    assert.equal(parsed3.length, 1);
    assert.ok(fs.existsSync(parsed3[0]));
    assert.ok(parsed3[0].endsWith('.png'));
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('parseVideoReferencePaths supports BeefTV newapi image_urls array', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-ref-urls-${Date.now()}.png`);
  fs.writeFileSync(tmpFile, 'mock-image');

  try {
    const parsed = await parseVideoReferencePaths({
      image_urls: [tmpFile, 'https://example.com/not-downloaded-here.png'],
      prompt: 'x',
    });
    // 远程 URL 不在同步解析职责内（由 resolveVideoReferencePaths 下载），本地路径必须保留
    assert.equal(parsed.length, 1);
    assert.equal(path.normalize(parsed[0]), path.normalize(tmpFile));
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('resolveVideoReferencePaths downloads remote http references to temp files', async () => {
  const fakePng = Buffer.from('89504e470d0a1a0a-fake-png-bytes', 'utf8');
  const server = http.createServer((req, res) => {
    if (req.url === '/ref.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fakePng);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const resolved = await resolveVideoReferencePaths({
      image_urls: [`http://127.0.0.1:${port}/ref.png`, `http://127.0.0.1:${port}/missing.png`],
    });
    // 404 的那个被跳过，成功的那个落盘
    assert.equal(resolved.length, 1);
    assert.ok(fs.existsSync(resolved[0]));
    assert.ok(resolved[0].endsWith('.png'));
    assert.equal(fs.readFileSync(resolved[0]).toString('utf8'), fakePng.toString('utf8'));
  } finally {
    server.close();
  }
});

test('DoubaoGateway handles async video task creation, polling, and media streaming', async (t) => {
  const mockTasks = new Map<string, any>();
  const testDir = path.join(os.tmpdir(), `gateway-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const mockVideoFile = path.join(testDir, 'v1.mp4');
  const mockFrameFile = path.join(testDir, 'v1_lastframe.png');
  fs.writeFileSync(mockVideoFile, 'fake-mp4-video-stream');
  fs.writeFileSync(mockFrameFile, 'fake-png-last-frame');

  mockTasks.set('vtask_123', {
    id: 'vtask_123',
    status: 'completed',
    statusText: '视频生成完成',
    videoPath: mockVideoFile,
    lastFramePath: mockFrameFile,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const pool = new AccountPool();
  let capturedVideoOptions: any = null;
  const testPort = await new Promise<number>((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as AddressInfo;
      const p = addr.port;
      s.close(() => resolve(p));
    });
  });

  const gateway = new DoubaoGateway({
    accounts: () => [
      { id: 1, name: '账号1', platform: 'doubao' as const, note: '', sessionName: 'persist:doubao_01', isLoggedIn: true },
    ],
    viewForAccount: () => null,
    openAccount: () => null,
    createVideoTask: async (options) => {
      capturedVideoOptions = options;
      const id = `vtask_${Date.now()}`;
      const task = {
        id,
        status: 'queued',
        prompt: options.prompt,
        ratio: options.ratio,
        createdAt: new Date().toISOString(),
      };
      mockTasks.set(id, task);
      return task;
    },
    getVideoTask: (id) => mockTasks.get(id) ?? null,
    cancelVideoTask: (id) => {
      if (!mockTasks.has(id)) return false;
      mockTasks.get(id).status = 'cancelled';
      return true;
    },
  }, {
    port: testPort,
    pool,
    busyAccountIds: () => new Set(),
  });

  gateway.start();
  await new Promise(resolve => setTimeout(resolve, 200));

  t.after(() => {
    gateway.stop();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const request = (method: string, pathUrl: string, body?: any): Promise<{ status: number; data: any; rawBuffer: Buffer }> => {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: testPort,
        path: pathUrl,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          let data: any = null;
          try {
            data = JSON.parse(rawBuffer.toString('utf8'));
          } catch {
            data = rawBuffer.toString('utf8');
          }
          resolve({ status: res.statusCode || 0, data, rawBuffer });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  };

  // 1. POST /v1/video/generations (BeefTV 异步提交契约)
  const submitRes = await request('POST', '/v1/video/generations', {
    model: 'doubao-video',
    prompt: '海边落日，浪花翻滚',
    ratio: '16:9',
  });
  assert.equal(submitRes.status, 200);
  assert.ok(submitRes.data.task_id.startsWith('vtask_'));
  assert.equal(submitRes.data.status, 'processing');
  assert.ok(typeof submitRes.data.created_at === 'number');

  const createdTaskId = submitRes.data.task_id;

  // 1b. BeefTV newapi 协议字段名兼容（seconds/aspect_ratio/image_urls）
  const newapiRes = await request('POST', '/v1/video/generations', {
    model: 'doubao-video-account-2',
    prompt: '推镜头，阳光穿过森林',
    seconds: 5,
    aspect_ratio: '9:16',
    image_urls: ['https://127.0.0.1.its.invalid/ref.png'],
  });
  assert.equal(newapiRes.status, 200);
  assert.ok(newapiRes.data.task_id);
  assert.equal(capturedVideoOptions.duration, 5);
  assert.equal(capturedVideoOptions.ratio, '9:16');
  assert.equal(capturedVideoOptions.accountId, 2);
  // 不可达的远程参考图被跳过而不是报错
  assert.deepEqual(capturedVideoOptions.referencePaths, []);

  // 1c. 豆包 3.0：video_model 单独透传（Seedance 模型名进页面自动化），账号定向不受影响
  const modelRes = await request('POST', '/v1/video/generations', {
    model: 'doubao-video-account-2',
    video_model: 'Seedance 2.0 Fast',
    prompt: '城市夜景延时',
    ratio: '16:9',
    duration: 12,
  });
  assert.equal(modelRes.status, 200);
  assert.equal(capturedVideoOptions.model, 'Seedance 2.0 Fast');
  assert.equal(capturedVideoOptions.accountId, 2);
  assert.equal(capturedVideoOptions.duration, 12);

  // 1c. GET /v1/doubao/accounts（豆包 3.0 契约别名 + status/quota）
  const accountsRes = await request('GET', '/v1/doubao/accounts');
  assert.equal(accountsRes.status, 200);
  assert.equal(accountsRes.data.accounts.length, 1);
  const accountEntry = accountsRes.data.accounts[0];
  assert.equal(accountEntry.id, 1);
  assert.equal(accountEntry.name, '账号1');
  assert.equal(accountEntry.status, 'healthy');
  assert.equal(accountEntry.quota, 'normal');
  assert.equal(typeof accountEntry.busy, 'boolean');

  // 2. GET /v1/video/tasks/:id (轮询刚提交的任务)
  const pollQueued = await request('GET', `/v1/video/tasks/${createdTaskId}`);
  assert.equal(pollQueued.status, 200);
  assert.equal(pollQueued.data.task_id, createdTaskId);
  assert.equal(pollQueued.data.status, 'queued');
  assert.equal(pollQueued.data.progress, 10);

  // 3. GET /v1/video/tasks/vtask_123 (轮询已完成的任务并检查首尾帧和视频路径)
  const pollCompleted = await request('GET', '/v1/video/tasks/vtask_123');
  assert.equal(pollCompleted.status, 200);
  assert.equal(pollCompleted.data.status, 'completed');
  assert.equal(pollCompleted.data.progress, 100);
  assert.equal(pollCompleted.data.local_path, mockVideoFile);
  assert.equal(pollCompleted.data.last_frame_path, mockFrameFile);
  assert.ok(pollCompleted.data.video_url.includes('/v1/video/tasks/vtask_123/video'));

  // 4. GET /v1/video/tasks/vtask_123/video (流式视频内容)
  const streamVideo = await request('GET', '/v1/video/tasks/vtask_123/video');
  assert.equal(streamVideo.status, 200);
  assert.equal(streamVideo.rawBuffer.toString('utf8'), 'fake-mp4-video-stream');

  // 5. GET /v1/video/tasks/vtask_123/last_frame (尾帧图片流)
  const streamFrame = await request('GET', '/v1/video/tasks/vtask_123/last_frame');
  assert.equal(streamFrame.status, 200);
  assert.equal(streamFrame.rawBuffer.toString('utf8'), 'fake-png-last-frame');

  // 6. POST /v1/video/tasks/:id/cancel
  const cancelRes = await request('POST', `/v1/video/tasks/${createdTaskId}/cancel`);
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.data.status, 'cancelled');

  // 7. GET /v1/video/tasks/not_found
  const notFoundRes = await request('GET', '/v1/video/tasks/non_existent');
  assert.equal(notFoundRes.status, 404);
});
