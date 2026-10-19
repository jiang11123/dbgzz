import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, buildStartScript, buildDrainScript, parseEvent, collectAnswer, RISK_ERROR_CODES } from './doubao-api';

test('starts a new conversation when no id is supplied', () => {
  const payload = buildPayload('你好', {});
  assert.equal(payload.option.need_create_conversation, true);
  assert.equal(payload.client_meta.conversation_id, '');
  assert.ok(payload.client_meta.local_conversation_id.startsWith('local_'));
  assert.equal(payload.messages[0].content_block[0].content.text_block.text, '你好');
  assert.equal(payload.messages[0].content_block[0].block_type, 10000);
});

test('continues an existing conversation when an id is supplied', () => {
  const payload = buildPayload('继续', { conversationId: '38447084494964994' });
  assert.equal(payload.option.need_create_conversation, false);
  assert.equal(payload.client_meta.conversation_id, '38447084494964994');
  assert.equal(payload.client_meta.local_conversation_id, '');
});

test('deep think toggles the matching protocol fields', () => {
  const on = buildPayload('x', { deepThink: true });
  assert.equal(on.option.need_deep_think, 1);
  assert.equal(on.ext.use_deep_think, '1');
  assert.equal(on.option.aggregate_params.reasoning_effort, '1');
  const off = buildPayload('x', {});
  assert.equal(off.option.need_deep_think, 0);
  assert.equal(off.ext.use_deep_think, '0');
});

test('extracts answer text from the first content event', () => {
  const event = { content: { content_block: [{ block_type: 10000, content: { text_block: { text: '你好' } } }] } };
  assert.equal(parseEvent(event).delta, '你好');
});

test('extracts answer text from patch_op events', () => {
  const event = { message_id: 'm1', patch_op: [{ patch_object: 1, patch_type: 1, patch_value: { content_block: [{ block_type: 10000, content: { text_block: { text: '世界' } } }] } }] };
  const parsed = parseEvent(event);
  assert.equal(parsed.delta, '世界');
  assert.equal(parsed.messageId, 'm1');
});

test('ignores suggestion chips and tts patches', () => {
  // patch_object 50 carries suggestion chips; folding them into the answer would
  // append UI text such as "测试失败" to the model's reply.
  const suggestions = { patch_op: [{ patch_object: 50, patch_type: 1, patch_value: { ext: { sp_v2: '[{"content":"测试失败"}]' } } }] };
  assert.equal(parseEvent(suggestions).delta, '');
  const tts = { patch_op: [{ patch_object: 111, patch_type: 1, patch_value: { tts_content: '成功' } }] };
  assert.equal(parseEvent(tts).delta, '');
});

test('reads the conversation id from the acknowledgement event', () => {
  const event = { ack_client_meta: { conversation_id: '38447084494964994' } };
  assert.equal(parseEvent(event).conversationId, '38447084494964994');
});

test('marks the stream finished on end_type and never treats suggestions as finish', () => {
  assert.equal(parseEvent({ end_type: 1 }).finished, true);
  assert.equal(parseEvent({ end_type: 2 }).finished, true);
  assert.equal(parseEvent({ end_type: 3 }).finished, true);
  assert.equal(parseEvent({ patch_op: [{ patch_object: 50 }] }).finished, false);
});

test('surfaces risk-control errors for human verification', () => {
  for (const code of RISK_ERROR_CODES) {
    const parsed = parseEvent({ error_code: code, error_msg: 'verify' });
    assert.ok(parsed.error);
    assert.equal(parsed.error.riskControl, true);
  }
  const benign = parseEvent({ error_code: 500, error_msg: 'oops' });
  assert.equal(benign.error?.riskControl, false);
});

test('accumulates a full answer across mixed events', () => {
  const events = [
    { content: { content_block: [{ block_type: 10000, content: { text_block: { text: '只回复' } } }] } },
    { patch_op: [{ patch_object: 1, patch_value: { content_block: [{ block_type: 10000, content: { text_block: { text: '四个字' } } }] } }] },
    { patch_op: [{ patch_object: 50, patch_value: { ext: { sp_v2: '[]' } } }] },
  ];
  assert.equal(collectAnswer(events), '只回复四个字');
});

test('generated page scripts are syntactically valid and escape newlines correctly', () => {
  const start = buildStartScript('r1', buildPayload('测试', {}));
  const drain = buildDrainScript('r1');
  assert.doesNotThrow(() => new Function('return ' + start));
  assert.doesNotThrow(() => new Function('return ' + drain));
  // A lost backslash here silently breaks SSE framing, which was a real defect before.
  assert.ok(start.includes("split('\\n')"), 'SSE framing must split on a real newline');
  assert.ok(start.includes('frontierSign'));
  assert.ok(drain.includes('__DSBUF'));
});

test('reads the bare text delta that carries most of the answer', () => {
  // Verified against a live stream: the bulk of a reply arrives as {text: "..."}
  // events, not as content_block patches. Ignoring them truncated replies.
  assert.equal(parseEvent({ text: '2、3、4、' }).delta, '2、3、4、');
  const events = [
    { content: { content_block: [{ block_type: 10000, content: { text_block: { text: '1' } } }] } },
    { message_id: 'm', patch_op: [{ patch_object: 1, patch_value: { content_block: [{ block_type: 10000, content: { text_block: { text: '、' } } }] } }] },
    { text: '2、3、4、' },
    { text: '5、6、7、' },
    { text: '8、9、10' },
  ];
  assert.equal(collectAnswer(events), '1、2、3、4、5、6、7、8、9、10');
});

test('extracts media URLs from content_block attachments in parseEvent', () => {
  const event = {
    content: {
      content_block: [
        { block_type: 10000, content: { text_block: { text: '好的' } } },
        {
          block_type: 10052,
          content: {
            attachment_block: {
              attachments: [
                {
                  type: 1,
                  image: {
                    name: 'test.png',
                    image_ori: {
                      url: 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rabbit.png?rk3s=1',
                      width: 1024,
                      height: 1024,
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  };
  const parsed = parseEvent(event);
  assert.equal(parsed.delta, '好的');
  assert.ok(parsed.mediaUrls?.length === 1);
  assert.equal(parsed.mediaUrls[0], 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rabbit.png?rk3s=1');
});
