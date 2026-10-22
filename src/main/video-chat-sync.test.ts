import test from 'node:test';
import assert from 'node:assert/strict';
import { syncVideoTaskToChat } from './video-chat-sync';
import type { CanvasBridgeTask } from './canvas-bridge';
import type { GatewayMessage, GatewayThread } from '../shared/types';

test('syncVideoTaskToChat synchronizes doubaoConversationId and accountId to gateway thread', () => {
  let thread: GatewayThread = {
    id: 'thread-1',
    title: 'Test Thread',
    doubaoConversationId: '',
    accountId: null,
    model: '',
    createdAt: '',
    updatedAt: '',
  };
  const messages: GatewayMessage[] = [
    {
      id: 101,
      threadId: 'thread-1',
      role: 'assistant',
      content: 'thinking...',
      status: 'streaming',
      attachments: [],
      error: '',
      createdAt: '',
      accountId: null,
    }
  ];

  let threadUpdated: any = null;
  const store = {
    gatewayThread: (id: string) => (id === 'thread-1' ? thread : null),
    gatewayMessages: (id: string) => (id === 'thread-1' ? messages : []),
    updateGatewayMessage: (id: number, patch: Partial<GatewayMessage>) => {
      Object.assign(messages[0], patch);
    },
    appendGatewayMessage: () => 1,
    updateGatewayThread: (id: string, patch: any) => {
      threadUpdated = patch;
      Object.assign(thread, patch);
    }
  };

  const task: CanvasBridgeTask = {
    id: 'task-1',
    gatewayThreadId: 'thread-1',
    gatewayReplyMessageId: 101,
    prompt: 'video prompt',
    ratio: '16:9',
    status: 'generating',
    statusText: '生成中...',
    accountId: 2,
    pageUrl: 'https://www.doubao.com/chat/7890123456',
    referencePaths: [],
    videoPath: null,
    error: null,
    createdAt: '',
    updatedAt: '',
  };

  const emitted: any[] = [];
  const ok = syncVideoTaskToChat(task, store, p => emitted.push(p));

  assert.equal(ok, true);
  assert.equal(thread.doubaoConversationId, '7890123456');
  assert.equal(thread.accountId, 2);
  assert.equal(threadUpdated?.doubaoConversationId, '7890123456');
  assert.equal(threadUpdated?.accountId, 2);
  assert.equal(messages[0].accountId, 2);
});

test('syncVideoTaskToChat attaches video attachment when task is completed and video file exists', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tempVideo = path.join(os.tmpdir(), `test-video-${Date.now()}.mp4`);
  fs.writeFileSync(tempVideo, 'fake video content');

  try {
    const thread: GatewayThread = {
      id: 'thread-2',
      title: 'Video Thread',
      doubaoConversationId: '',
      accountId: null,
      model: '',
      createdAt: '',
      updatedAt: '',
    };
    const messages: GatewayMessage[] = [
      {
        id: 202,
        threadId: 'thread-2',
        role: 'assistant',
        content: 'generating...',
        status: 'streaming',
        attachments: [],
        error: '',
        createdAt: '',
        accountId: null,
      }
    ];

    const store = {
      gatewayThread: (id: string) => (id === 'thread-2' ? thread : null),
      gatewayMessages: (id: string) => (id === 'thread-2' ? messages : []),
      updateGatewayMessage: (id: number, patch: Partial<GatewayMessage>) => {
        Object.assign(messages[0], patch);
      },
      appendGatewayMessage: () => 1,
    };

    const task: CanvasBridgeTask = {
      id: 'task-completed-1',
      gatewayThreadId: 'thread-2',
      gatewayReplyMessageId: 202,
      prompt: 'dog running',
      ratio: '16:9',
      status: 'completed',
      statusText: '视频已生成',
      accountId: 3,
      pageUrl: 'https://www.doubao.com/chat/111',
      referencePaths: [],
      videoPath: tempVideo,
      error: null,
      createdAt: '',
      updatedAt: '',
    };

    const emitted: any[] = [];
    const ok = syncVideoTaskToChat(task, store, p => emitted.push(p));

    assert.equal(ok, true);
    assert.equal(messages[0].status, 'done');
    assert.equal(messages[0].attachments.length, 1);
    assert.equal(messages[0].attachments[0].kind, 'video');
    assert.equal(messages[0].attachments[0].path, tempVideo);
    assert.equal(emitted[0].videoStatus, 'completed');
  } finally {
    try { fs.unlinkSync(tempVideo); } catch {}
  }
});
