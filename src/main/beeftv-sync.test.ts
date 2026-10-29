import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { buildDoubaoAssistantChannel, hostedModelConfigNeedsCleanup, syncAccountsToBeefTv } from './beeftv-sync';

const options = { hostBaseUrl: 'http://workspace.invalid' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('removes injected defaults while preserving API channels, credentials and node-independent settings', async t => {
  const api = { id: 'custom', apiKey: 'synthetic-api-key', headers: [{ name: 'X-Test', value: 'synthetic-header' }], models: ['doubao', 'image-api'] };
  let saved: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      saved = JSON.parse(String(init.body));
      return json({ code: 0 });
    }
    return json({ code: 0, data: { revision: 7, config: {
      channels: [{ id: 'doubao-gateway', models: ['doubao-image'] }, api],
      model: 'doubao-gateway::doubao', textModel: 'custom::doubao',
      imageModel: 'doubao-gateway::doubao-image', videoModel: 'doubao-gateway::doubao-video-account-1',
      assistantModel: 'doubao-gateway::doubao-account-2', mediaReviewModel: '',
      models: ['doubao-gateway::doubao', 'custom::doubao'], theme: 'dark',
    } } });
  });
  assert.deepEqual(await syncAccountsToBeefTv([], 'unused', options), { ok: true, count: 0 });
  assert.equal(saved.expectedRevision, 7);
  assert.deepEqual(saved.config.channels, [api]);
  assert.equal(saved.config.textModel, 'custom::doubao');
  for (const key of ['model', 'imageModel', 'videoModel', 'assistantModel']) assert.equal(saved.config[key], '');
  assert.deepEqual(saved.config.models, ['custom::doubao']);
  assert.equal(saved.config.theme, 'dark');
});

const doubaoAccounts = [1, 2].map(id => ({ id, name: `账号${id}`, platform: 'doubao' as const, note: '', sessionName: `s${id}`, isLoggedIn: true }));
const gateway = { hostBaseUrl: 'http://workspace.invalid', gatewayBaseUrl: 'http://127.0.0.1:8788' };

test('API-only workspaces without Doubao accounts do not write configuration', async t => {
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') writes++;
    return json({ code: 0, data: { revision: 0, config: { channels: [{ id: 'custom', models: ['chat-api'] }], textModel: 'custom::chat-api' } } });
  });
  assert.equal((await syncAccountsToBeefTv([], 'unused', options)).ok, true);
  assert.equal(writes, 0);
});

test('Doubao accounts become a text + video channel without touching default models', async t => {
  let saved: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') { saved = JSON.parse(String(init.body)); return json({ code: 0 }); }
    return json({ code: 0, data: { revision: 3, config: { channels: [{ id: 'custom' }], textModel: '', imageModel: '', models: [] } } });
  });
  assert.equal((await syncAccountsToBeefTv(doubaoAccounts, 'sk-local', gateway)).ok, true);
  const channel = saved.config.channels.find((item: any) => item.id === 'doubao-gateway');
  // 每个账号一个文本、一个视频、一个图片模型；豆包页面的视频/图片模型是节点选项，不拆成多个模型
  assert.deepEqual(channel.models, [1, 2].flatMap(id => [`doubao-account-${id}`, `doubao-video-account-${id}`, `doubao-image-account-${id}`]));
  assert.equal(channel.baseUrl, 'http://127.0.0.1:8788/v1');
  assert.equal(channel.apiKey, 'sk-local');
  const texts = channel.modelProfiles.filter((profile: any) => profile.capability === 'text');
  assert.deepEqual(texts.map((profile: any) => profile.model), ['doubao-account-1', 'doubao-account-2']);
  assert.ok(texts.every((profile: any) => profile.protocol === 'chat-completion'));
  const videos = channel.modelProfiles.filter((profile: any) => profile.capability === 'video');
  assert.deepEqual(videos.map((profile: any) => profile.model), ['doubao-video-account-1', 'doubao-video-account-2']);
  assert.ok(videos.every((profile: any) => profile.protocol === 'doubao-gateway-video' && profile.capabilityConfig?.video));
  assert.ok(videos.every((profile: any) => profile.defaultOptions?.video_model === 'Seedance 2.5'));
  const images = channel.modelProfiles.filter((profile: any) => profile.capability === 'image');
  assert.deepEqual(images.map((profile: any) => profile.model), ['doubao-image-account-1', 'doubao-image-account-2']);
  assert.ok(images.every((profile: any) => profile.protocol === 'doubao-gateway-image' && profile.defaultOptions?.image_model === 'Seedream 4.5'));
  assert.deepEqual(images[0].capabilityConfig.image.size.values, ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']);
  assert.equal(images[0].capabilityConfig.image.size.parameter, 'aspect_ratio');
  // 比例选择器只列出显式声明的预设：7 种比例各一个 2K 预设，否则只剩当前值 1:1
  const presets = images[0].capabilityConfig.image.size.presets;
  assert.deepEqual(presets.map((preset: any) => preset.ratio), ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']);
  assert.ok(presets.every((preset: any) => preset.tier === '2k' && preset.size === `${preset.width}x${preset.height}`));
  assert.equal(videos[1].displayName, '豆包账号: 账号2');
  assert.deepEqual(videos[1].capabilityConfig.video.duration, { selection: 'range', min: 4, max: 30, step: 1, default: 5 });
  assert.deepEqual(videos[1].capabilityConfig.video.ratios, ['16:9', '9:16', '1:1', '4:3', '3:4']);
  assert.equal(saved.config.assistantModel, 'doubao-gateway::doubao-account-1');
  for (const key of ['textModel', 'imageModel', 'videoModel', 'model']) assert.ok(!saved.config[key]);
  assert.deepEqual(saved.config.models, []);
  assert.ok(saved.config.channels.some((item: any) => item.id === 'custom'));
});

test('a configured API text model is never displaced by the Doubao assistant default', async t => {
  let saved: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') { saved = JSON.parse(String(init.body)); return json({ code: 0 }); }
    return json({ code: 0, data: { revision: 1, config: { channels: [{ id: 'custom' }], textModel: 'custom::chat-api', assistantModel: '' } } });
  });
  assert.equal((await syncAccountsToBeefTv(doubaoAccounts, 'sk-local', gateway)).ok, true);
  assert.equal(saved.config.assistantModel, '');
  assert.equal(saved.config.textModel, 'custom::chat-api');
});

test('a user-chosen Doubao assistant account is kept and an up-to-date channel is not rewritten', async t => {
  let channel: any;
  let writes = 0;
  let configNow: any = { channels: [], assistantModel: 'doubao-gateway::doubao-account-2', textModel: 'custom::x' };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') { writes++; configNow = JSON.parse(String(init.body)).config; return json({ code: 0 }); }
    return json({ code: 0, data: { revision: writes, config: configNow } });
  });
  assert.equal((await syncAccountsToBeefTv(doubaoAccounts, 'sk-local', gateway)).ok, true);
  assert.equal(writes, 1);
  assert.equal(configNow.assistantModel, 'doubao-gateway::doubao-account-2');
  channel = configNow.channels.find((item: any) => item.id === 'doubao-gateway');
  assert.ok(channel);
  assert.equal((await syncAccountsToBeefTv(doubaoAccounts, 'sk-local', gateway)).ok, true);
  assert.equal(writes, 1);
});

test('deleting the chosen Doubao account clears the assistant selection', async t => {
  let saved: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') { saved = JSON.parse(String(init.body)); return json({ code: 0 }); }
    return json({ code: 0, data: { revision: 1, config: { channels: [], assistantModel: 'doubao-gateway::doubao-account-9', textModel: 'custom::x' } } });
  });
  assert.equal((await syncAccountsToBeefTv(doubaoAccounts, 'sk-local', gateway)).ok, true);
  assert.equal(saved.config.assistantModel, '');
});

test('CAS conflict rereads the latest user API selection before retrying', async t => {
  let reads = 0;
  let writes = 0;
  let saved: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      saved = JSON.parse(String(init.body));
      return ++writes === 1 ? json({}, 409) : json({ code: 0 });
    }
    reads++;
    return json({ code: 0, data: { revision: reads, config: {
      channels: [{ id: 'doubao-gateway' }, { id: 'custom' }],
      textModel: reads === 1 ? 'doubao-gateway::doubao' : 'custom::new-choice',
    } } });
  });
  assert.equal((await syncAccountsToBeefTv([], 'unused', options)).ok, true);
  assert.equal(reads, 2);
  assert.equal(saved.expectedRevision, 2);
  assert.equal(saved.config.textModel, 'custom::new-choice');
});

test('business-level read and save failures are reported', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => json({ code: 1, data: { revision: 0, config: {} } }));
  assert.equal((await syncAccountsToBeefTv([], 'unused', options)).ok, false);
  mock.mock.mockImplementation(async (_url: unknown, init?: RequestInit) => init?.method === 'PUT'
    ? json({ code: 1 })
    : json({ code: 0, data: { revision: 0, config: { channels: [{ id: 'doubao-gateway' }] } } }));
  assert.equal((await syncAccountsToBeefTv([], 'unused', options)).ok, false);
});

test('encrypted guard detects old configuration and stays idle once it is removed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'doubao-config-test-'));
  try {
    const key = randomBytes(32);
    writeFileSync(path.join(dir, '.settings-key'), key);
    const writeConfig = (config: unknown) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(JSON.stringify({ config })), cipher.final()]);
      writeFileSync(path.join(dir, 'local-model-config.json'), JSON.stringify({
        encryptedConfig: `enc:v1:${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')}`,
      }));
    };
    assert.equal(hostedModelConfigNeedsCleanup(dir), false);
    writeConfig({ channels: [{ id: 'doubao-gateway' }] });
    assert.equal(hostedModelConfigNeedsCleanup(dir), true);
    writeConfig({ channels: [], assistantModel: 'doubao-gateway::doubao-account-2' });
    assert.equal(hostedModelConfigNeedsCleanup(dir), true);
    writeConfig({ channels: [{ id: 'custom' }], textModel: 'custom::doubao' });
    assert.equal(hostedModelConfigNeedsCleanup(dir), false);
    const desire = { accounts: doubaoAccounts, apiKey: 'sk-local', gatewayBaseUrl: 'http://127.0.0.1:8788' };
    assert.equal(hostedModelConfigNeedsCleanup(dir, desire), true);
    writeConfig({ channels: [buildDoubaoAssistantChannel(desire)], textModel: 'custom::x' });
    assert.equal(hostedModelConfigNeedsCleanup(dir, desire), false);
    assert.equal(hostedModelConfigNeedsCleanup(dir, { ...desire, apiKey: 'sk-rotated' }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
