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

// Sanitized shape observed in the real green-background rabbit reply.
const outputUrl = 'https://cdn.example/rc_gen_image/green.png';
const creationBlock = {
  block_type: 2074,
  content: { creation_block: { creations: [{
    type: 1, id: 'generated-task',
    gen_detail: { ref_images: [{ url: 'https://cdn.example/original.png' }] },
    image: { key: 'generated-key', image_ori: { url: outputUrl }, image_thumb: { url: 'https://cdn.example/thumb.png' } },
  }] } },
};

test('extracts only the generated original from creation blocks, not references or icons', () => {
  const parsed = parseEvent({
    ack_client_meta: { conversation_info: { image: { image_ori: { url: 'https://cdn.example/bubble.png' } } } },
    content: { content_block: [creationBlock, { block_type: 10052, content: { attachment_block: { attachments: [{ image: { image_ori: { url: 'https://cdn.example/input.png' } } }] } } }] },
  });
  assert.deepEqual(parsed.mediaUrls, [outputUrl]);
});

test('reads deep JSON creation_full_content inside patch 50 without a depth cutoff', () => {
  const patch = { patch_object: 50, patch_value: { ext: { creation_full_content: JSON.stringify([
    { BlockInfo: { BlockType: 2074, BlockContent: creationBlock } },
  ]) } } };
  assert.deepEqual(parseEvent({ patch_op: [patch] }).mediaUrls, [outputUrl]);
});

test('ignores metadata-only URLs, user messages and malformed creation packets', () => {
  assert.equal(parseEvent({ ack_client_meta: { conversation_info: { image: { image_ori: { url: outputUrl } } } } }).mediaUrls, undefined);
  assert.equal(parseEvent({ message: { user_type: 1, content_block: [creationBlock] } }).mediaUrls, undefined);
  assert.equal(parseEvent({ patch_op: [{ patch_object: 50, patch_value: { ext: { creation_full_content: '{bad' } } }] }).mediaUrls, undefined);
});

test('falls back to image_ori_raw when the original is invalid', () => {
  const block = { block_type: 2074, content: { creation_block: { creations: [
    { type: 1, image: { image_ori: { url: 'javascript:bad' }, image_ori_raw: { url: outputUrl }, image_thumb: { url: 'https://cdn.example/thumb.png' } } },
  ] } } };
  assert.deepEqual(parseEvent({ content: { content_block: [block] } }).mediaUrls, [outputUrl]);
});

test('deduplicates full content and block patches for the same generated image', () => {
  assert.deepEqual(parseEvent({ content: { content_block: [creationBlock] }, patch_op: [{ patch_object: 1, patch_value: { content_block: [creationBlock] } }] }).mediaUrls, [outputUrl]);
});

test('extracts media URLs from content_obj and message list shapes', () => {
  const { extractMediaUrlsFromNode } = require('./doubao-api');
  const node = {
    msgList: [{
      messageData: {
        content_blocks_v2: [{
          block_type: 2074,
          content_obj: {
            creations: [{
              type: 1,
              image: { key: 'img-1', image_ori: { url: 'https://cdn.example/rabbit.png' } },
            }],
          },
        }],
      },
    }],
  };
  assert.deepEqual(extractMediaUrlsFromNode(node), ['https://cdn.example/rabbit.png']);
});
