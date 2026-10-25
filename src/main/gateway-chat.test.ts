import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayChat, titleFromPrompt, extractMediaUrls, type ThreadStore } from './gateway-chat';

test('Dola uses the unified chat store, streams deltas, and continues its own conversation', async () => {
  const store = memoryStore();
  const calls: any[] = [];
  const prepared: number[] = [];
  const chat = createGatewayChat(store, {
    accountPlatform: id => id === 7 ? 'dola' : 'doubao',
    pickAccount: () => ({id:7}),
    viewForAccount: () => ({webContents:{isDestroyed:()=>false}}),
    prepareNewConversation: async id => { prepared.push(id); },
    streamForAccount: async (id, _view, prompt, options) => {
      calls.push({id,prompt,conversationId:options?.conversationId});
      options?.onDelta?.('Dola 回复', 'Dola 回复');
      return {answer:'Dola 回复',conversationId:`conv-${id}`,messageId:'1',mediaUrls:[]};
    },
    markAccountOk:()=>undefined, markAccountFailure:()=>undefined,
  });
  const chunks: string[]=[];
  const first=await chat.send({prompt:'你好', onDelta:(_chunk,full)=>chunks.push(full)});
  const second=await chat.send({threadId:first.thread.id,prompt:'继续'});
  assert.equal(second.thread.accountId,7);
  assert.equal(second.assistantMessage.accountId,7);
  assert.equal(second.assistantMessage.status,'done');
  assert.deepEqual(chunks,['Dola 回复']);
  assert.deepEqual(prepared,[7]);
  assert.equal(calls[1].conversationId,'conv-7');
  await chat.send({threadId:first.thread.id,prompt:'换成豆包',accountId:1});
  assert.equal(calls[2].conversationId,undefined);
  assert.equal(store.gatewayThread(first.thread.id)?.doubaoConversationId,'conv-1');
  await chat.send({threadId:first.thread.id,prompt:'换回 Dola',accountId:7});
  assert.equal(calls[3].conversationId,undefined);
  assert.equal(store.gatewayThread(first.thread.id)?.doubaoConversationId,'conv-7');
});

test('two unified-chat threads cannot concurrently drive the same Dola composer', async () => {
  const store=memoryStore();
  let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  const chat=createGatewayChat(store,{
    pickAccount:()=>({id:7}),accountPlatform:()=> 'dola',
    viewForAccount:()=>({webContents:{isDestroyed:()=>false}}),
    streamForAccount:async()=>{await gate;return {answer:'ok',conversationId:'c',messageId:'1',mediaUrls:[]};},
    markAccountOk:()=>undefined,markAccountFailure:()=>undefined,
  });
  const first=chat.send({prompt:'first',accountId:7});
  await assert.rejects(chat.send({prompt:'second',accountId:7}),/另一条聊天/);
  release();
  await first;
  assert.equal((await chat.send({prompt:'third',accountId:7})).assistantMessage.content,'ok');
});

test('Dola errors do not retry a potentially submitted native message',async()=>{
  let attempts=0;
  const chat=createGatewayChat(memoryStore(),{
    pickAccount:()=>({id:7}),accountPlatform:()=> 'dola',
    viewForAccount:()=>({webContents:{isDestroyed:()=>false}}),
    streamForAccount:async()=>{attempts++;throw new Error('Dola 需要人机验证');},
    markAccountOk:()=>undefined,markAccountFailure:()=>undefined,
  });
  await assert.rejects(chat.send({prompt:'hello'}),/人机验证/);
  assert.equal(attempts,1);
});

test('Dola media modes never silently fall back to a domestic account',async()=>{
  let called=false;
  const chat=createGatewayChat(memoryStore(),{
    pickAccount:()=>null,viewForAccount:()=>null,accountPlatform:()=> 'dola',
    generateImages:async()=>{called=true;return[];},generateVideos:async()=>{called=true;return[];},
    markAccountOk:()=>undefined,markAccountFailure:()=>undefined,
  });
  await assert.rejects(chat.generateImages({prompt:'cat',accountId:7}),/Dola/);
  await assert.rejects(chat.generateVideos({prompt:'cat',accountId:7}),/Dola/);
  assert.equal(called,false);
});

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

test('chat send captures mediaUrls returned by streamChat and attaches saved remote images to assistant message', async () => {
  const store = memoryStore();
  const mockImageUrl = 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i/rabbit-blue.png';
  const savedAttachment = { id: 'img-1', kind: 'image' as const, url: 'file:///userData/gateway-media/rabbit.png', name: 'rabbit.png', path: 'C:/userData/gateway-media/rabbit.png' };
  
  let savedKind = '';
  let savedUrl = '';
  
  const chat = createGatewayChat(store, {
    pickAccount: () => ({ id: 1 }),
    viewForAccount: () => ({
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: async (script: string) => {
          if (script.includes('frontierSign')) return true;
          if (script.includes('__DSBUF')) return {
            events: [
              JSON.stringify({
                text: '已换成蓝色背景，主体和紫色帽子保持不变。参考图 https://cdn.example/original.png',
                ack_client_meta: { conversation_info: { image: { image_ori: { url: 'https://cdn.example/bubble.png' } } } },
                content: {
                  content_block: [
                    {
                      block_type: 2074,
                      content: {
                        creation_block: {
                          creations: [
                            {
                              type: 1,
                              image: {
                                name: 'rabbit-blue.png',
                                image_ori: { url: mockImageUrl, width: 1024, height: 1024 }
                              }
                            }
                          ]
                        }
                      }
                    }
                  ]
                },
                end_type: 3
              })
            ],
            done: true,
            error: null
          };
          return true;
        }
      }
    }),
    markAccountOk: () => undefined,
    markAccountFailure: () => undefined,
    saveRemoteMedia: async (url, kind) => {
      savedUrl = url;
      savedKind = kind;
      return savedAttachment;
    }
  });

  const res = await chat.send({ prompt: '保留兔子和紫色帽子，把背景换成蓝色' });
  
  assert.equal(res.assistantMessage.status, 'done');
  assert.match(res.assistantMessage.content, /已换成蓝色背景/);
  assert.equal(savedUrl, mockImageUrl);
  assert.equal(savedKind, 'image');
  assert.equal(res.assistantMessage.attachments.length, 1);
  assert.deepEqual(res.assistantMessage.attachments[0], savedAttachment);
});

test('image generation mode returns generated image attachment with done status', async () => {
  const store = memoryStore();
  const imageAttachment = { id: 'img-gen', kind: 'image' as const, url: 'file:///media/img.png', name: 'img.png' };
  const chat = createGatewayChat(store, {
    viewForAccount: () => null,
    pickAccount: () => null,
    markAccountOk: () => undefined,
    markAccountFailure: () => undefined,
    generateImages: async () => [imageAttachment],
  });
  const result = await chat.generateImages({ prompt: '一只可爱的白色小兔子' });
  assert.equal(result.assistantMessage.status, 'done');
  assert.equal(result.assistantMessage.content, '已生成图片');
  assert.deepEqual(result.assistantMessage.attachments, [imageAttachment]);
});

test('starts new conversation prepares account and syncs page upon sending message', async () => {
  const store = memoryStore();
  let preparedAccountId: number | null = null;
  let syncedAccountId: number | null = null;
  let syncedConversationId: string | null = null;

  const chat = createGatewayChat(store, {
    pickAccount: () => ({ id: 2 }),
    viewForAccount: () => ({
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: async (script: string) => {
          if (script.includes('frontierSign')) return true;
          if (script.includes('__DSBUF')) return {
            events: [
              JSON.stringify({
                text: '你好！我是豆包',
                ack_client_meta: { conversation_id: 'conv-new-123' },
                end_type: 3
              })
            ],
            done: true,
            error: null
          };
          return true;
        }
      }
    }),
    prepareNewConversation: async (accId) => {
      preparedAccountId = accId;
    },
    syncConversationPage: async (accId, convId) => {
      syncedAccountId = accId;
      syncedConversationId = convId;
    },
    markAccountOk: () => undefined,
    markAccountFailure: () => undefined,
  });

  const res = await chat.send({ prompt: '你好' });
  assert.equal(preparedAccountId, 2);
  assert.equal(res.thread.doubaoConversationId, 'conv-new-123');
  assert.equal(syncedAccountId, 2);
  assert.equal(syncedConversationId, 'conv-new-123');
});

test('image generation synchronizes account to new thread without polluting conversationId', async () => {
  const store = memoryStore();

  const chat = createGatewayChat(store, {
    viewForAccount: () => null,
    pickAccount: () => null,
    markAccountOk: () => undefined,
    markAccountFailure: () => undefined,
    lastImageAccountId: () => 5,
    generateImages: async () => [{ id: 'img-1', kind: 'image', url: 'file:///1.png', name: '1.png' }],
  });

  const res = await chat.generateImages({ prompt: '小狗' });
  assert.equal(res.thread.accountId, 5);
  assert.equal(res.thread.doubaoConversationId, '');
});
