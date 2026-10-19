import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesToPrompt, classify, MODEL_ALIASES, DEFAULT_MODEL } from './gateway';
import { IMAGE_MODELS, IMAGE_RATIOS, DEFAULT_IMAGE_MODEL } from './doubao-image';
import type { ChatMessage } from './gateway';

test('keeps the last user turn as the live prompt and folds earlier turns into context', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
  ];
  const prompt = messagesToPrompt(messages);
  assert.match(prompt, /你是助手/);
  assert.match(prompt, /用户：第一问/);
  assert.match(prompt, /助手：第一答/);
  assert.ok(prompt.trimEnd().endsWith('第二问'), prompt);
  // The live prompt must appear once, as the final line.
  assert.equal(prompt.split('第二问').length - 1, 1);
});

test('a single user message needs no conversation framing', () => {
  assert.equal(messagesToPrompt([{ role: 'user', content: '你好' }]), '你好');
});

test('ignores empty and whitespace-only messages', () => {
  assert.equal(messagesToPrompt([{ role: 'user', content: '   ' }]), '');
  assert.equal(messagesToPrompt([]), '');
});

test('classifies page failures into pool failure kinds', () => {
  assert.equal(classify('触发 710022004 人机验证'), 'captcha');
  assert.equal(classify('请完成安全验证'), 'captcha');
  assert.equal(classify('当前账号视频生成额度不足'), 'quota');
  assert.equal(classify('今日免费次数用完'), 'quota');
  assert.equal(classify('登录已过期，请重新登录'), 'logged_out');
  assert.equal(classify('网络连接超时'), 'transient');
});

test('keeps a not-yet-rendered page retryable instead of benching the account', () => {
  // The composer wait message mentions login; treating it as a session failure would
  // permanently disable a healthy account whose page was simply still loading.
  assert.equal(classify('目标账号未出现输入框，请先登录或完成页面验证'), 'transient');
  assert.equal(classify('账号页面已关闭'), 'transient');
  assert.equal(classify('豆包没有返回内容'), 'transient');
});

test('exposes stable model aliases with a default', () => {
  assert.ok(MODEL_ALIASES[DEFAULT_MODEL]);
  assert.equal(MODEL_ALIASES['doubao-think'].deepThink, true);
  assert.ok(Object.keys(MODEL_ALIASES).length >= 3);
});

test('advertises image models alongside chat models', () => {
  // Clients discover them via /v1/models and then call /v1/images/generations.
  assert.ok(IMAGE_MODELS.includes('Seedream 4.5'));
  assert.ok(IMAGE_RATIOS.includes('1:1'));
  assert.equal(DEFAULT_IMAGE_MODEL, 'Seedream 4.5');
});

test('gateway failover classifies transient vs logged_out errors correctly', () => {
  assert.equal(classify('网络连接中断'), 'transient');
  assert.equal(classify('请求超时'), 'transient');
  assert.equal(classify('未登录，请先登录'), 'logged_out');
  assert.equal(classify('用户登录状态已失效'), 'logged_out');
  assert.equal(classify('触发 710022004 人机验证'), 'captcha');
  assert.equal(classify('今日额度已达上限'), 'quota');
});
