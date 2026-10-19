import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// submitVideoTask() is the path every video request takes: submit, read the site's
// answer, auto-confirm when doubao asks, and translate quota/captcha notices into
// actionable errors. These tests drive it against a fake page so the decision table
// is pinned offline — the live site cannot be exercised in CI.
type Frame = { requestId?: string; event?: string; error?: string; done?: boolean };

const listeners = new Set<(event: unknown, payload: Frame) => void>();
const fakeIpcMain = {
  on: (channel: string, listener: (event: unknown, payload: Frame) => void) => {
    assert.equal(channel, 'doubao:stream');
    listeners.add(listener);
  },
  removeListener: (_channel: string, listener: (event: unknown, payload: Frame) => void) => { listeners.delete(listener); },
};

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') return { ipcMain: fakeIpcMain };
  return originalLoad.call(this, request, ...rest);
};

const { submitVideoTask, buildVideoPayload, buildConfirmPayload, isConfirmAsk, mapAbilityModel, clampDuration, VIDEO_ABILITY_TYPE } = require('./doubao-video');
(Module as any)._load = originalLoad;

/**
 * A fake account page. Each executeJavaScript of the drain script pops one scripted
 * snapshot, so a test can script a whole submit (and confirmation) exchange.
 */
function makeView(snapshots: Array<{ events: string[]; done: boolean; error: string | null } | null>) {
  const executed: string[] = [];
  let index = 0;
  const view = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (code: string) => {
        executed.push(code);
        if (code.includes('delete window.__DSBUF')) return true;
        if (!code.includes('buffer.events.splice')) return true;
        return snapshots[Math.min(index++, snapshots.length - 1)] ?? null;
      },
    },
  };
  return { view: view as any, executed };
}

/** Wraps a message body the way the site's SSE envelope does. */
const envelope = (message: unknown) => JSON.stringify({ event_data: JSON.stringify({ message: JSON.stringify(message) }) });

const ackEvent = (conversationId: string, text: string, extra: Record<string, unknown> = {}) => envelope({
  conversation_id: conversationId, content_type: 2001, content: JSON.stringify({ text }), ...extra,
});

test('accepts a job the site started without asking anything', async () => {
  const task = envelope({ conversation_id: '38447066672806146', fin_reason: { async_task: { id: '7500000000000000001' } } });
  const fake = makeView([{ events: [ackEvent('38447066672806146', '好的，开始生成'), task], done: true, error: null }]);
  const result = await submitVideoTask(fake.view, '一只猫在跑', { timeoutMs: 5000 });
  assert.equal(result.conversationId, '38447066672806146');
  assert.equal(result.taskId, '7500000000000000001');
  assert.equal(result.confirmed, undefined);
  // The payload must carry the video chat ability, not a special content type.
  const start = fake.executed.find(code => code.includes('chat_ability'))!;
  assert.ok(start.includes(String(VIDEO_ABILITY_TYPE)));
  assert.ok(start.includes('seedance'));
});

test('auto-confirms when doubao asks before rendering', async () => {
  // Sanity: the question really is recognised as a confirmation ask.
  assert.equal(isConfirmAsk('确认后按这些参数生成吗？'), true);
  assert.equal(isConfirmAsk('你好呀'), false);
  // A submission that never created a conversation fails before any confirmation.
  const noConversation = makeView([{ events: [envelope({ content_type: 2001, content: JSON.stringify({ text: '确认后按这些参数生成吗？' }) })], done: true, error: null }]);
  await assert.rejects(() => submitVideoTask(noConversation.view, 'x', { timeoutMs: 4000 }), /没有创建视频会话/);
  // Second exchange: the ask, then the confirmation turn starts the job.
  const ok = makeView([
    { events: [ackEvent('38447066672806146', '确认后按这些参数生成吗？')], done: true, error: null },
    { events: [ackEvent('38447066672806146', '已开始生成'), envelope({ conversation_id: '38447066672806146', fin_reason: { async_task: { id: '7500000000000000002' } } })], done: true, error: null },
  ]);
  const result = await submitVideoTask(ok.view, 'x', { timeoutMs: 5000 });
  assert.equal(result.confirmed, true);
  assert.equal(result.taskId, '7500000000000000002');
  // The confirmation turn must be a bare affirmative inside the same conversation.
  // The confirmation turn is a bare affirmative inside the same conversation.
  const confirmStart = ok.executed.filter(code => code.includes('"text":"确认"') || code.includes('need_create_conversation')).pop()!;
  assert.ok(confirmStart.includes('38447066672806146'));
  assert.ok(confirmStart.includes('确认'));
});

test('translates a quota notice into a retryable account error', async () => {
  const fake = makeView([{ events: [ackEvent('38447066672806146', '免费次数已用完，请升级后再试')], done: true, error: null }]);
  await assert.rejects(() => submitVideoTask(fake.view, 'x', { timeoutMs: 5000 }), /额度不足/);
});

test('translates a captcha demand into a manual-intervention error', async () => {
  const fake = makeView([{ events: [ackEvent('38447066672806146', '请完成人机验证后继续 710022004')], done: true, error: null }]);
  await assert.rejects(() => submitVideoTask(fake.view, 'x', { timeoutMs: 5000 }), /人机验证/);
});

test('reports a throttle notice instead of a generic failure', async () => {
  const fake = makeView([{ events: [ackEvent('38447066672806146', '当前服务访问频繁，请稍后重试')], done: true, error: null }]);
  await assert.rejects(() => submitVideoTask(fake.view, 'x', { timeoutMs: 5000 }), /访问频繁/);
});

test('reports the page-side stream error verbatim', async () => {
  const fake = makeView([{ events: [], done: false, error: '页面未返回可用签名，请刷新账号页面后重试' }]);
  await assert.rejects(() => submitVideoTask(fake.view, 'x', { timeoutMs: 5000 }), /签名/);
});

test('clamps duration and maps models like the site expects', () => {
  assert.equal(clampDuration(1), 4);
  assert.equal(clampDuration(999), 30);
  assert.equal(clampDuration(undefined), 10);
  assert.equal(mapAbilityModel('Seedance 2.5'), 'seedance_v2.5');
  assert.equal(mapAbilityModel('Seedance 2.0 Fast'), 'seedance_v2.0_fast');
  assert.equal(mapAbilityModel('Seedance 2.0 Mini'), 'seedance_v2.0_fast');
  assert.equal(mapAbilityModel(undefined), 'seedance_v2.0');
});

test('the confirmation payload stays inside the conversation it answers', () => {
  const payload = buildConfirmPayload('38447066672806146');
  assert.equal(payload.client_meta.conversation_id, '38447066672806146');
  assert.equal(payload.client_meta.last_message_index, 0);
  assert.equal(payload.option.need_create_conversation, false);
  const text = payload.messages[0].content_block[0].content.text_block.text;
  assert.equal(text, '确认');
});