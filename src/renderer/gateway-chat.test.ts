import test from 'node:test';
import assert from 'node:assert/strict';
import { composerAction, ensureChatThread, reconcileMessages, threadDelta, toIpcAttachments, toStagedGeneratedImage } from './gateway-chat';
import type { GatewayMessage, GatewayThread } from '../shared/types';

test('normalizes empty, single and multiple staged attachments for IPC', () => {
  assert.deepEqual(toIpcAttachments([]), []);
  assert.deepEqual(toIpcAttachments([{ id: 'a', name: 'a.png' }]), [{
    id: 'a', assetId: 'a', name: 'a.png', mimeType: 'image/png', url: undefined,
  }]);
  assert.deepEqual(toIpcAttachments([
    { id: 'a', assetId: 'asset-a', name: 'a.png', mimeType: 'image/png', url: 'file:///a.png' },
    { id: 'b', name: 'notes.txt' },
  ]), [
    { id: 'a', assetId: 'asset-a', name: 'a.png', mimeType: 'image/png', url: 'file:///a.png' },
    { id: 'b', assetId: 'b', name: 'notes.txt', mimeType: 'application/octet-stream', url: undefined },
  ]);
});

test('maps a generated local image back into the staged attachment shape', () => {
  assert.deepEqual(toStagedGeneratedImage(
    { id: 'generated-1', kind: 'image', url: 'file:///gateway-media/generated.png', name: 'generated.png', path: 'C:/gateway-media/generated.png' },
    { id: 'asset-1', name: 'generated.png', url: 'file:///image-assets/asset-1' },
  ), {
    id: 'generated-1', assetId: 'asset-1', name: 'generated.png', mimeType: 'image/png', url: 'file:///image-assets/asset-1',
  });
});

test('accepts only the exact selected thread delta, including before a turn resolves', () => {
  assert.equal(threadDelta('new-video', { threadId: 'new-video', full: '请确认视频参数' }), '请确认视频参数');
  assert.equal(threadDelta('other', { threadId: 'new-video', full: '私有内容' }), null);
  assert.equal(threadDelta('new-video', { full: '无归属内容' }), null);
  assert.equal(threadDelta(null, { threadId: 'new-video', full: '内容' }), null);
  assert.equal(threadDelta('new-video', { threadId: 'new-video', full: '' }), '');
});

test('busy composer accepts arbitrary current-thread follow-ups, not only confirmation words', () => {
  for (const prompt of ['确认', '把时长改成10秒', '为什么需要这个参数？', '先不要生成']) {
    assert.equal(composerAction(prompt, true), 'continue');
  }
  assert.equal(composerAction('追问', true, true), 'none');
  assert.equal(composerAction('  ', true), 'none');
  assert.equal(composerAction('首条消息', false), 'send');
});

const row = (id: number, content: string, threadId = 'video'): GatewayMessage => ({
  id, content, threadId, role: 'user', attachments: [], status: 'done', error: '', createdAt: '', accountId: null,
});

test('keeps a visible confirmation until persistence, then replaces its local echo without duplication', () => {
  const initial = row(1, '生成视频');
  const followup = row(-1, '把时长改成10秒');
  assert.deepEqual(reconcileMessages([initial, followup], [initial]), [initial, followup]);
  const persisted = row(2, followup.content);
  assert.deepEqual(reconcileMessages([initial, followup], [initial, persisted]), [initial, persisted]);
});

test('does not consume a local follow-up using an old same-text row or another thread', () => {
  const old = row(1, '确认');
  const local = row(-1, '确认');
  assert.deepEqual(reconcileMessages([old, local], [old]), [old, local]);
  assert.deepEqual(reconcileMessages([local], [row(2, '确认', 'other')]), [row(2, '确认', 'other'), local]);
  assert.deepEqual(reconcileMessages([row(-1, '确认'), row(-2, '确认')], [row(2, '确认')]), [row(2, '确认'), row(-2, '确认')]);
});

test('creates and activates a new thread before starting the long-running turn', async () => {
  const events: string[] = [];
  const thread: GatewayThread = { id: 'new-video', title: '', doubaoConversationId: '', accountId: null, model: '', createdAt: '', updatedAt: '' };
  let activeId: string | null = null;
  const id = await ensureChatThread(null, async () => { events.push('create'); return thread; }, value => {
    activeId = value.id;
    events.push('activate');
  });
  // A synchronous delta from the subsequent IPC already has a selected destination.
  events.push('send');
  assert.equal(threadDelta(activeId, { threadId: id, full: '参数确认' }), '参数确认');
  assert.deepEqual(events, ['create', 'activate', 'send']);
  assert.equal(await ensureChatThread(id, async () => { throw new Error('must reuse thread'); }, () => assert.fail('must not reactivate')), id);
});

test('failed thread creation cannot activate or dispatch a turn', async () => {
  await assert.rejects(ensureChatThread(null, async () => { throw new Error('create failed'); }, () => assert.fail('must not activate')), /create failed/);
});
