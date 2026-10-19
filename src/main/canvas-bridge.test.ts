import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecoverTaskPage, normalizeTaskUrl, formatVideoPrompt } from './canvas-bridge';

test('recovers a drifted task page repeatedly, but not forever', () => {
  // A doubao video render takes minutes and the page drifts off its task URL while it
  // works, so recovery must retry. A hard cap still stops a genuinely lost page from
  // looping indefinitely.
  const task = 'https://www.doubao.com/chat/38447157636539650';
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/', task, 0), true);
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/', task, 7), true);
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/', task, 8), false);
});

test('treats trailing slash and hash drift as the same page', () => {
  // The site appends a hash or a trailing slash while it works; that is not page loss.
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/123#x', 'https://www.doubao.com/chat/123', 0), false);
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/123/', 'https://www.doubao.com/chat/123', 0), false);
});

test('does not recover when already on the expected task page', () => {
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/chat/local_1', 'https://www.doubao.com/chat/local_1', 0), false);
});

test('never recovers when there is no task page to return to', () => {
  assert.equal(shouldRecoverTaskPage('https://www.doubao.com/', null, 0), false);
});

test('normalizeTaskUrl strips hash and trailing slashes', () => {
  assert.equal(normalizeTaskUrl('https://x.com/a/#frag'), 'https://x.com/a');
  assert.equal(normalizeTaskUrl('https://x.com/a///'), 'https://x.com/a');
  assert.equal(normalizeTaskUrl(null), '');
});

test('formatVideoPrompt wraps pure text prompt with video command and specs', () => {
  const result = formatVideoPrompt('一只金毛幼犬在草地上奔跑', '16:9', 5, false);
  assert.match(result, /^生成视频：一只金毛幼犬在草地上奔跑/);
  assert.match(result, /按比例 16:9/);
  assert.match(result, /时长 5 秒/);
  assert.match(result, /直接开始/);
});

test('formatVideoPrompt wraps reference-image video requests with reference instructions', () => {
  const result = formatVideoPrompt('让图中的女孩微笑挥手', '9:16', 5, true);
  assert.match(result, /^请根据参考图生成视频：让图中的女孩微笑挥手/);
  assert.match(result, /按比例 9:16/);
  assert.match(result, /直接开始/);
});

test('formatVideoPrompt preserves existing reference keywords in prompt', () => {
  const result = formatVideoPrompt('根据参考图生成视频，镜头向前推', '16:9', undefined, true);
  assert.match(result, /^根据参考图生成视频，镜头向前推/);
  assert.match(result, /按比例 16:9/);
});

test('formatVideoPrompt adapts model to Seedance 2.0 Fast when duration is 5s', () => {
  const result = formatVideoPrompt('兔子跳起来', '16:9', 5, 'Seedance 2.5', true);
  assert.match(result, /使用 Seedance 2\.0 Fast 模型/);
  assert.match(result, /时长 5 秒/);
  assert.match(result, /按比例 16:9/);
});

test('formatVideoPrompt preserves Seedance 2.5 when duration is >= 10s', () => {
  const result = formatVideoPrompt('兔子跳起来', '16:9', 10, 'Seedance 2.5', true);
  assert.match(result, /使用 Seedance 2\.5 模型/);
  assert.match(result, /时长 10 秒/);
});