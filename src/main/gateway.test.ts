import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesToPrompt, normalizeChatMessages, chatContentToText, classify, MODEL_ALIASES, DEFAULT_MODEL, extractTargetAccountId, extractVideoModelVariant, resolveImagePageModel } from './gateway';
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

test('parseVideoReferencePaths extracts reference images from image_urls and data urls', async () => {
  const { parseVideoReferencePaths } = await import('./gateway');
  const sampleDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const paths = await parseVideoReferencePaths({
    image_urls: [sampleDataUrl],
  });
  assert.equal(paths.length, 1);
  assert.ok(paths[0].includes('ref-'));
  const fs = await import('node:fs');
  assert.ok(fs.existsSync(paths[0]));
});

test('array content parts are flattened to text instead of becoming [object Object]', () => {
  const messages = normalizeChatMessages([
    { role: 'system', content: [{ type: 'text', text: '系统提示' }] },
    { role: 'user', content: [{ type: 'text', text: '[当前画布 c1]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }, { type: 'text', text: '1+1等于几？' }] },
  ]);
  const prompt = messagesToPrompt(messages);
  assert.ok(!prompt.includes('[object Object]'), prompt);
  assert.match(prompt, /系统提示/);
  assert.ok(prompt.trimEnd().endsWith('1+1等于几？'), prompt);
  assert.ok(!prompt.includes('base64'), 'image parts are not pasted into the web chat');
});

test('developer messages act as system and tool results are skipped', () => {
  const messages = normalizeChatMessages([
    { role: 'developer', content: '规则' },
    { role: 'user', content: '问' },
    { role: 'tool', content: '工具结果' },
    null,
    'noise',
  ]);
  assert.deepEqual(messages, [{ role: 'system', content: '规则' }, { role: 'user', content: '问' }]);
});

test('chatContentToText handles strings, text objects and unknown shapes', () => {
  assert.equal(chatContentToText('直接文本'), '直接文本');
  assert.equal(chatContentToText({ text: '对象文本' }), '对象文本');
  assert.equal(chatContentToText(['甲', { text: '乙' }, { type: 'image_url' }]), '甲\n乙');
  assert.equal(chatContentToText(undefined), '');
  assert.equal(chatContentToText(42), '');
});

test('video model id carries both the Doubao account and the page video model', () => {
  for (const [id, account, variant] of [
    ['doubao-video-account-2--seedance-2-0-mini', 2, 'Seedance 2.0 Mini'],
    ['doubao-video-account-1--seedance-2-5', 1, 'Seedance 2.5'],
    ['doubao-video-account-3--seedance-2-0-fast', 3, 'Seedance 2.0 Fast'],
    ['doubao-video-account-12--seedance-2-0', 12, 'Seedance 2.0'],
  ] as const) {
    assert.equal(extractTargetAccountId(id), account, id);
    assert.equal(extractVideoModelVariant(id), variant, id);
  }
});

test('model ids without a known video model suffix leave the page default untouched', () => {
  assert.equal(extractVideoModelVariant('doubao-video-account-2'), undefined);
  assert.equal(extractVideoModelVariant('doubao-video-account-2--unknown-model'), undefined);
  assert.equal(extractVideoModelVariant(undefined), undefined);
  assert.equal(extractTargetAccountId('doubao-video'), null);
});

test('image requests resolve the Doubao page image model from image_model, the model name, or the default', () => {
  assert.equal(resolveImagePageModel('doubao-image-account-2', 'Seedream 4.0'), 'Seedream 4.0');
  assert.equal(resolveImagePageModel('Seedream 3.0'), 'Seedream 3.0');
  // 账号模型 id 不是页面模型，不能原样发给豆包
  assert.equal(resolveImagePageModel('doubao-image-account-1'), 'Seedream 4.5');
  assert.equal(resolveImagePageModel('doubao-image-account-1', 'unknown-model'), 'Seedream 4.5');
  assert.equal(resolveImagePageModel(undefined, undefined), 'Seedream 4.5');
  assert.equal(extractTargetAccountId('doubao-image-account-3'), 3);
});
