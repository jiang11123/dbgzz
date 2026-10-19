import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVideoPayload, buildAsyncPollPayload, mapAbilityModel, clampDuration,
  extractTaskId, extractVideos, extractEventText, parseVideoSubmitEvents,
  VIDEO_ABILITY_TYPE, MIN_DURATION, MAX_DURATION,
} from './doubao-video';

test('reduces a submit stream to the conversation to watch', () => {
  // The ack names the conversation; the video itself only ever shows up on that
  // conversation page, so this id is what the caller navigates to.
  const ack = JSON.stringify({ ack_client_meta: { conversation_id: '38447066672806146' } });
  const modelNote = JSON.stringify({ event_data: JSON.stringify({ message: JSON.stringify({ content_type: 2001, content: JSON.stringify({ text: '视频生成中，稍等即可产出画面。' }) }) }) });
  const result = parseVideoSubmitEvents([ack, modelNote]);
  assert.equal(result.conversationId, '38447066672806146');
  assert.match(result.message, /视频生成中/);
});

test('falls back to the message conversation id and keeps the task id', () => {
  const events = [
    JSON.stringify({ event_data: { message: { conversation_id: '123456789012' } } }),
    JSON.stringify({ event_data: JSON.stringify({ message: JSON.stringify({ fin_reason: { reason: 1, async_task: { id: '998877665544' } } }) }) }),
  ];
  const result = parseVideoSubmitEvents(events);
  assert.equal(result.conversationId, '123456789012');
  assert.equal(result.taskId, '998877665544');
});

test('ignores short or numeric-like ids that cannot be conversations', () => {
  const result = parseVideoSubmitEvents([JSON.stringify({ event_data: { message: { conversation_id: '0' } } })]);
  assert.equal(result.conversationId, '');
});

test('places chat_ability at the top level, not inside ext', () => {
  // Nesting it under ext made the server answer 710020202 'common invalid param'.
  const payload = buildVideoPayload('一只猫') as any;
  assert.ok(payload.chat_ability, 'chat_ability must exist at the top level');
  assert.equal(payload.chat_ability.ability_type, VIDEO_ABILITY_TYPE);
  assert.equal(payload.ext.chat_ability, undefined);
});

test('encodes model, duration and ratio into ability_param', () => {
  const payload = buildVideoPayload('一只猫', { model: 'Seedance 2.0 Fast', duration: 8, ratio: '9:16' }) as any;
  const param = JSON.parse(payload.chat_ability.ability_param);
  assert.equal(param.model, 'seedance_v2.0_fast');
  assert.equal(param.duration, 8);
  assert.equal(param.ratio, '9:16');
});

test('maps friendly model names to ability model ids', () => {
  assert.equal(mapAbilityModel('Seedance 2.5'), 'seedance_v2.5');
  assert.equal(mapAbilityModel('Seedance 2.0 Fast'), 'seedance_v2.0_fast');
  assert.equal(mapAbilityModel('Seedance 2.0'), 'seedance_v2.0');
  assert.equal(mapAbilityModel('seedance_v2.0'), 'seedance_v2.0');
  assert.equal(mapAbilityModel(''), 'seedance_v2.0');
});

test('clamps duration to the range the site accepts', () => {
  assert.equal(clampDuration(1), MIN_DURATION);
  assert.equal(clampDuration(99), MAX_DURATION);
  assert.equal(clampDuration(7), 7);
  assert.equal(clampDuration(undefined), 10);
  assert.equal(clampDuration(NaN), 10);
});

test('wraps the prompt so the model starts instead of asking to confirm', () => {
  const payload = buildVideoPayload('一只柯基奔跑', { duration: 5 }) as any;
  const text = payload.messages[0].content_block[0].content.text_block.text;
  assert.match(text, /^生成视频：/);
  assert.match(text, /立即开始/);
  assert.match(text, /5 秒/);
});

test('keeps a prompt that already asks for a video untouched', () => {
  const payload = buildVideoPayload('生成视频：一只猫', {}) as any;
  const text = payload.messages[0].content_block[0].content.text_block.text;
  assert.equal(text, '生成视频：一只猫');
});

test('builds the async poll body', () => {
  assert.deepEqual(buildAsyncPollPayload('123456789', 0), { task_id: '123456789', event_id: 0 });
});

test('finds the async task id nested in fin_reason', () => {
  const event = { event_data: JSON.stringify({ message: JSON.stringify({ fin_reason: { reason: 1, async_task: { id: '998877665544' } } }) }) };
  assert.equal(extractTaskId(event), '998877665544');
  assert.equal(extractTaskId({ event_data: { message: { task_id: '112233445566' } } }), '112233445566');
  assert.equal(extractTaskId({ event_data: { message: {} } }), '');
});

test('extracts video urls from a content_type 2021 event', () => {
  const event = { event_data: JSON.stringify({ message: JSON.stringify({ content_type: 2021, content: JSON.stringify({ data: [{ video_url: 'https://vlabvod.example/clip.mp4', cover_url: 'https://x.byteimg.com/c.png', width: 1280, height: 720 }] }) }) }) };
  const videos = extractVideos(event);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].width, 1280);
  assert.ok(videos[0].url.endsWith('.mp4'));
});

test('ignores image urls when looking for videos', () => {
  const event = { event_data: { message: { content_type: 2021, content: { data: [{ url: 'https://x.byteimg.com/a.png' }] } } } };
  assert.equal(extractVideos(event).length, 0);
});

test('reads reply text through nested envelopes', () => {
  const event = { event_data: JSON.stringify({ message: JSON.stringify({ content_type: 2001, content: JSON.stringify({ text: '视频生成中' }) }) }) };
  assert.equal(extractEventText(event), '视频生成中');
});
