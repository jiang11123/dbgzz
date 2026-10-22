import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImagePayload, parseImageEvent, extractEventText, IMAGE_CONTENT_TYPE, IMAGE_RESPONSE_TYPE, IMAGE_SKILL_ID, DEFAULT_IMAGE_MODEL } from './doubao-image';

test('builds the samantha image payload with the generation skill', () => {
  const payload = buildImagePayload('一只橘猫');
  assert.equal(payload.messages[0].content_type, IMAGE_CONTENT_TYPE);
  assert.equal(payload.messages[0].skill.skill_id, String(IMAGE_SKILL_ID));
  assert.equal(payload.completion_option.action_bar_skill_id, IMAGE_SKILL_ID);
  const content = JSON.parse(payload.messages[0].content);
  assert.equal(content.text, '一只橘猫');
  assert.equal(content.model, DEFAULT_IMAGE_MODEL);
  assert.equal(content.ratio, '1:1');
});

test('formats reference image attachments for samantha image generation', () => {
  const payload = buildImagePayload('换成绿色', {
    attachments: [{ uri: 'tos-cn-i-test/123.png', name: 'rabbit.png', isImage: true }]
  });
  assert.deepEqual(payload.messages[0].attachments, [
    { type: 'image', key: 'tos-cn-i-test/123.png', extra: { refer_types: 'overall' } }
  ]);
});

test('honours a requested model and ratio', () => {
  const content = JSON.parse(buildImagePayload('x', { model: 'Seedream 4.0', ratio: '16:9' }).messages[0].content);
  assert.equal(content.model, 'Seedream 4.0');
  assert.equal(content.ratio, '16:9');
});

test('reads image urls from a content_type 2010 event', () => {
  const event = {
    event_data: JSON.stringify({
      message: JSON.stringify({
        content_type: IMAGE_RESPONSE_TYPE,
        content: JSON.stringify({ data: [{ image_ori: { url: 'https://p3-flow-imagex-sign.byteimg.com/a.jpeg', width: 2048, height: 2048, format: 'jpeg' } }] }),
      }),
    }),
  };
  const { images } = parseImageEvent(event);
  assert.equal(images.length, 1);
  assert.equal(images[0].width, 2048);
  assert.ok(images[0].url.includes('byteimg'));
});

test('prefers image_ori and falls back to raw then thumb', () => {
  const make = (item: object) => parseImageEvent({ event_data: { message: { content_type: 2010, content: { data: [item] } } } }).images[0]?.url;
  assert.equal(make({ image_ori: { url: 'https://x.byteimg.com/ori.png' }, image_raw: { url: 'https://x.byteimg.com/raw.png' } }), 'https://x.byteimg.com/ori.png');
  assert.equal(make({ image_raw: { url: 'https://x.byteimg.com/raw.png' } }), 'https://x.byteimg.com/raw.png');
  assert.equal(make({ image_thumb: { url: 'https://x.byteimg.com/thumb.png' } }), 'https://x.byteimg.com/thumb.png');
});

test('ignores events that are not image results', () => {
  assert.equal(parseImageEvent({ content: { content_block: [] } }).images.length, 0);
  assert.equal(parseImageEvent({ event_data: { message: { content_type: 2001, content: { text: 'hi' } } } }).images.length, 0);
  assert.equal(parseImageEvent({ event_data: { message: { content_type: 2010, content: { data: [{ image_ori: { url: 'not-a-url' } }] } } } }).images.length, 0);
});

test('reports risk-control errors instead of silently returning no images', () => {
  const parsed = parseImageEvent({ error_code: 710022004, error_msg: 'verify' });
  assert.ok(parsed.error);
  assert.equal(parsed.error.riskControl, true);
  assert.equal(parseImageEvent({ error_code: 500, error_msg: 'x' }).error?.riskControl, false);
});

test('decodes escaped ampersands in returned urls', () => {
  const raw = 'https://x.byteimg.com/a.png?k=1\\u0026v=2';
  const { images } = parseImageEvent({ event_data: { message: { content_type: 2010, content: { data: [{ image_ori: { url: raw } }] } } } });
  assert.equal(images[0].url, 'https://x.byteimg.com/a.png?k=1&v=2');
});

test('reads nested reply text, including the JSON-string envelope', () => {
  // Doubao sends the throttle notice this way; missing it turned a clear "slow down"
  // into a confusing "no images" error.
  const event = { event_data: JSON.stringify({ message: { content_type: 2001, content: JSON.stringify({ text: '当前服务访问频繁，请稍后重试' }) } }) };
  assert.equal(extractEventText(event), '当前服务访问频繁，请稍后重试');
  assert.equal(extractEventText({ text: '直接文本' }), '直接文本');
  assert.equal(extractEventText({ event_data: { message: { content: { text: '对象文本' } } } }), '对象文本');
  assert.equal(extractEventText({}), '');
  assert.equal(extractEventText(null), '');
});

test('extracts conversationId from event ack or message', () => {
  const event1 = { ack_client_meta: { conversation_id: '38447121957971202' } };
  assert.equal(parseImageEvent(event1).conversationId, '38447121957971202');
  const event2 = { event_data: JSON.stringify({ message: { conversation_id: '38447121957971203' } }) };
  assert.equal(parseImageEvent(event2).conversationId, '38447121957971203');
});
