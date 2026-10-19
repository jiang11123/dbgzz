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
