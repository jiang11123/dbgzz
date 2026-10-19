import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayChat, titleFromPrompt, extractMediaUrls, type ThreadStore } from './gateway-chat';

/** Minimal in-memory store mirroring the SQLite-backed one. */
function memoryStore(): ThreadStore & { messages: Array<Record<string, unknown>> } {
  const threads = new Map<string, any>();
  const messages: Array<Record<string, unknown>> = [];
  let nextId = 1;
  return {
    messages,
    gatewayThreads: () => [...threads.values()],
    gatewayThread: (id: string) => threads.get(id) ?? null,
    gatewayMessages: (threadId: string) => messages.filter(m => m.threadId === threadId) as never[],
    createGatewayThread: (thread: { id: string; title?: string; model?: string; accountId?: number | null }) => { const row = { messageCount: 0, doubaoConversationId: '', accountId: null, ...thread }; threads.set(thread.id, row); return row; },
    updateGatewayThread: (id: string, patch: Record<string, unknown>) => Object.assign(threads.get(id), patch),
    deleteGatewayThread: (id: string) => { threads.delete(id); return [...threads.values()]; },
    appendGatewayMessage: (message: { threadId: string; role: string; content: string }) => { const id = nextId++; messages.push({ id, attachments: [], status: 'done', error: '', createdAt: new Date().toISOString(), ...message }); return id; },
    updateGatewayMessage: (id: number, patch: Record<string, unknown>) => { const row = messages.find(m => m.id === id); if (row) Object.assign(row, patch); },
  } as never;
}

test('titles a thread from its first prompt', () => {
  assert.equal(titleFromPrompt('法国的首都是哪里？'), '法国的首都是哪里？');
  assert.equal(titleFromPrompt('  多   余   空   白  '), '多 余 空 白');
  assert.equal(titleFromPrompt(''), '新对话');
});

test('truncates long prompts to keep the sidebar readable', () => {
  const long = '一'.repeat(40);
  const title = titleFromPrompt(long, 24);
  assert.equal(title.length, 25);
  assert.ok(title.endsWith('…'));
});

test('finds generated media URLs so they can be saved as assets', () => {
  const answer = '这是图片 https://p3-flow-imagex-sign.byteimg.com/tos-cn-i/rc_gen_image/abc.jpeg~tplv-x.png?lk3s=1 以及视频 https://example.com/clip.mp4';
  const urls = extractMediaUrls(answer);
  assert.equal(urls.length, 2);
  assert.ok(urls.some(u => u.includes('byteimg')));
  assert.ok(urls.some(u => u.endsWith('.mp4')));
});

test('ignores ordinary links and trailing punctuation', () => {
  assert.deepEqual(extractMediaUrls('详见 https://www.doubao.com/chat/。'), []);
  assert.deepEqual(extractMediaUrls('没有链接'), []);
  const trailing = extractMediaUrls('图为 https://x.byteimg.com/a.png。');
  assert.equal(trailing[0], 'https://x.byteimg.com/a.png');
});

test('a video turn stores the attachment and completes the assistant message', async () => {
  const store = memoryStore();
  const attachment = { id: 'v1', kind: 'video' as const, url: 'file:///media/a.mp4', name: 'a.mp4' };
  const chat = createGatewayChat(store, {
    viewForAccount: () => null,
    pickAccount: () => null,
    markAccountOk: () => undefined,
    markAccountFailure: () => undefined,
    generateVideos: async () => [attachment],
  });
  const result = await chat.generateVideos({ prompt: '一只柯基在草地上奔跑' });
  assert.equal(result.assistantMessage.status, 'done');
  assert.equal(result.assistantMessage.content, '已生成视频');
  assert.deepEqual(result.assistantMessage.attachments, [attachment]);
  assert.equal(result.userMessage.content, '一只柯基在草地上奔跑');
  assert.equal(result.thread.title, '一只柯基在草地上奔跑');
});

test('image and video turns forward staged files instead of dropping them', async () => {
  const imageStore = memoryStore();
  let imageOptions: any;
  const imageChat = createGatewayChat(imageStore, {
    viewForAccount: () => null,
    pickAccount: () => null,
    markAccountOk: () => undefined,
    markAccountFailure: () => undefined,
    generateImages: async (_prompt, options) => { imageOptions = options; return []; },
  });
  await imageChat.generateImages({ prompt: '参考这张图', attachments: [{ id: 'a', assetId: 'a', name: 'a.png', mimeType: 'image/png', path: 'C:/assets/a.png' }] as any });
  assert.deepEqual(imageOptions.attachments, [{ path: 'C:/assets/a.png', name: 'a.png', mimeType: 'image/png' }]);
  assert.equal((imageStore.messages.find(m => m.role === 'user')?.attachments as any[]).length, 1);

  const videoStore = memoryStore();
  let videoOptions: any;
  const videoChat = createGatewayChat(videoStore, {
    viewForAccount: () => null,
    pickAccount: () => null,
    markAccountOk: () => undefined,
    markAccountFailure: () => undefined,
    generateVideos: async (_prompt, options) => { videoOptions = options; return []; },
  });
  await videoChat.generateVideos({ prompt: '用参考图生成视频', attachments: [{ id: 'a', assetId: 'a', name: 'a.png', mimeType: 'image/png', path: 'C:/assets/a.png' }] as any });
  assert.deepEqual(videoOptions.referencePaths, ['C:/assets/a.png']);
});

test('a failed video run marks the assistant message failed with the reason', async () => {
  const store = memoryStore();
  const chat = createGatewayChat(store, {
    viewForAccount: () => null,
    pickAccount: () => null,
    markAccountOk: () => undefined,
    markAccountFailure: () => undefined,
    generateVideos: async () => { throw new Error('豆包账号当前无可用视频额度'); },
  });
  await assert.rejects(chat.generateVideos({ prompt: '一只猫' }), /视频额度/);
  const failed = store.messages.find(m => m.role === 'assistant');
  assert.equal(failed?.status, 'failed');
  assert.match(String(failed?.error), /视频额度/);
});

test('video generation is refused when the runtime has no video hook', async () => {
  const store = memoryStore();
  const chat = createGatewayChat(store, {
    viewForAccount: () => null,
    pickAccount: () => null,
    markAccountOk: () => undefined,
    markAccountFailure: () => undefined,
  });
  await assert.rejects(chat.generateVideos({ prompt: '一只猫' }), /未启用视频生成/);
});

test('a thread cannot run two video turns at once', async () => {
  const store = memoryStore();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const chat = createGatewayChat(store, {
    viewForAccount: () => null,
    pickAccount: () => null,
    markAccountOk: () => undefined,
    markAccountFailure: () => undefined,
    generateVideos: async () => { await gate; return [{ id: 'v', kind: 'video', url: 'file:///v.mp4', name: 'v.mp4' }]; },
  });
  const first = chat.generateVideos({ prompt: '视频一' });
  await assert.rejects(chat.generateVideos({ threadId: (await Promise.resolve(store.gatewayThreads()[0])).id, prompt: '视频二' }), /正在生成中/);
  release();
  await first;
});
