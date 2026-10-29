import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import type { Account } from '../shared/types';

/**
 * 托管工作区：保证助手可选豆包账号（只含文本模型的渠道），清理旧版自动注入到
 * 默认模型的豆包引用，保留用户 API 配置。
 * 原生 BeefTV 的 SQLite 同步仅供旧版显式同步入口使用。
 */

export function getBeefTvDbPath(appDataDir?: string): string {
  const root = appDataDir || process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Roaming');
  return path.join(root, 'BeefTV', 'open_ai_canvas.db');
}

/** 豆包 3.0：Electron 壳内托管后端（cmd/server）使用的数据库路径。 */
export function getHostedBeefTvDbPath(dataDir: string): string {
  return path.join(dataDir, 'open_ai_canvas.db');
}

export function getHostedModelConfigPath(dataDir: string): string {
  return path.join(dataDir, 'local-model-config.json');
}

/**
 * 检测托管模型配置是否需要同步：旧版注入的默认模型引用、豆包助手渠道缺失或过期。
 * 只读加密文档，写入走后端 CAS。不传 desire 时只检查旧版注入的残留。
 */
export function hostedModelConfigNeedsCleanup(dataDir: string, desire?: DoubaoChannelDesire): boolean {
  try {
    const doc = readStoredProviderDocument(dataDir);
    if (!doc) return false;
    const config = doc.config;
    const channels = (config?.channels) as Array<Record<string, unknown>> | undefined;
    const existing = Array.isArray(channels) ? channels.find(item => item?.id === DOUBAO_CHANNEL_ID) : undefined;
    if (DEFAULT_MODEL_KEYS.some(key => isInjectedDoubaoModel(config?.[key]))
      || (Array.isArray(config?.models) && config.models.some(isInjectedDoubaoModel))) return true;
    const danglingAssistant = !existing && isInjectedDoubaoModel(config?.[ASSISTANT_MODEL_KEY]);
    if (!desire) return Boolean(existing) || danglingAssistant;
    const desired = buildDoubaoAssistantChannel(desire);
    if (!desired) return Boolean(existing) || danglingAssistant;
    if (!existing || !channelMatches(existing, desired, true)) return true;
    const assistant = config?.[ASSISTANT_MODEL_KEY];
    if (isInjectedDoubaoModel(assistant)) return !(desired.models as string[]).includes(String(assistant).slice(`${DOUBAO_CHANNEL_ID}::`.length));
    return !assistant && !config?.textModel;
  } catch (error) {
    const configPath = getHostedModelConfigPath(dataDir);
    if (!fs.existsSync(configPath)) return false;
    console.error('[beeftv-sync] 读取托管模型配置失败，旧配置清理被跳过：', error instanceof Error ? error.message : error);
    return false;
  }
}

/** 解密 <dataDir>/local-model-config.json（enc:v1 AES-256-GCM，密钥 .settings-key）。 */
function readStoredProviderDocument(dataDir: string): { config?: Record<string, unknown> } | null {
  const configPath = getHostedModelConfigPath(dataDir);
  const envelope = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { encryptedConfig?: string };
  const encrypted = envelope.encryptedConfig;
  if (!encrypted || !encrypted.startsWith('enc:v1:')) return null;
  const key = fs.readFileSync(path.join(dataDir, '.settings-key'));
  const payload = Buffer.from(encrypted.slice('enc:v1:'.length), 'base64');
  const nonce = payload.subarray(0, 12);
  const body = payload.subarray(12);
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-gcm`, key, nonce) as import('node:crypto').DecipherGCM;
  decipher.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

const DOUBAO_CHANNEL_ID = 'doubao-gateway';

/** 默认模型只用 API 渠道；助手模型（assistantModel）允许用户单独选择豆包账号。 */
const DEFAULT_MODEL_KEYS = ['model', 'imageModel', 'videoModel', 'textModel', 'audioModel', 'mediaReviewModel'];
const ASSISTANT_MODEL_KEY = 'assistantModel';

function isInjectedDoubaoModel(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${DOUBAO_CHANNEL_ID}::`);
}

type DoubaoChannelDesire = { accounts: Account[]; apiKey: string; gatewayBaseUrl?: string };

/**
 * 每个豆包账号登记一个视频模型 doubao-video-account-N；豆包页面里的视频模型（Seedance 2.5 / 2.0 …）
 * 是节点上的独立选项，经 providerOptions.doubao-gateway-video.video_model 传给网关，不拆成多个模型。
 */
const DOUBAO_DEFAULT_VIDEO_MODEL = 'Seedance 2.5';
const DOUBAO_DEFAULT_IMAGE_MODEL = 'Seedream 4.5';
const DOUBAO_IMAGE_PROTOCOL = 'doubao-gateway-image';

/**
 * 豆包网页生图输出约 2K。比例选择器只会列出档案里显式声明的预设尺寸（presets），
 * 按比例传参且没有质量档位的模型不写 presets 就只剩当前值，所以 7 种比例各声明一个 2K 预设；
 * 像素只是换算参考，实际尺寸由豆包决定。
 */
const DOUBAO_IMAGE_PRESETS = [
  { ratio: '1:1', width: 2048, height: 2048 },
  { ratio: '4:3', width: 2304, height: 1728 },
  { ratio: '3:4', width: 1728, height: 2304 },
  { ratio: '16:9', width: 2560, height: 1440 },
  { ratio: '9:16', width: 1440, height: 2560 },
  { ratio: '3:2', width: 2496, height: 1664 },
  { ratio: '2:3', width: 1664, height: 2496 },
].map(item => ({ ...item, tier: '2k', size: `${item.width}x${item.height}` }));

/** 豆包网页生图：7 种比例（比例直接作为 size 发送）、最多 4 张参考图，一次一张，不支持蒙版/质量/透明背景。 */
function doubaoImageCapabilityConfig() {
  return {
    version: 1,
    image: {
      references: { promptMaxChars: 4000, maxImages: 4, maxImageBytes: 20 * 1024 * 1024, maskSupported: false },
      size: { parameter: 'aspect_ratio', values: DOUBAO_IMAGE_PRESETS.map(item => item.ratio), default: '1:1', allowCustom: false, presets: DOUBAO_IMAGE_PRESETS },
      quality: { supported: false, values: [], default: 'auto' },
      transparentBackground: { supported: false, default: false },
      responseFormat: { supported: false },
      outputFormat: { supported: false },
      maxOutputs: 1,
    },
  };
}
const DOUBAO_VIDEO_PROTOCOL = 'doubao-gateway-video';

/** 豆包网页视频的可选参数：时长 4–30 秒滑杆、5 种比例、最多 4 张参考图；不提供分辨率/音频/水印开关。 */
function doubaoVideoCapabilityConfig() {
  return {
    version: 1,
    video: {
      references: {
        promptMaxChars: 0, minImages: 0, maxImages: 4, maxImageBytes: 20 * 1024 * 1024,
        maxVideos: 0, maxVideoBytes: 0, maxVideoDurationSeconds: 0,
        maxAudios: 0, maxAudioBytes: 0, maxAudioDurationSeconds: 0,
      },
      duration: { selection: 'range', min: 4, max: 30, step: 1, default: 5 },
      ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
      defaultRatio: '16:9',
      resolutions: ['720p'],
      defaultResolution: '720p',
      generateAudio: { supported: false, default: false },
      watermark: { supported: false, default: false },
      operations: ['text_to_video', 'image_to_video'],
      defaultOperation: 'text_to_video',
    },
  };
}

/**
 * 助手面板可选的豆包账号渠道：只含文本模型 doubao-account-N，走本地网关。
 * 不写入默认模型列表，所以不会出现在设置的默认模型里，也不影响豆包节点的账号选择。
 */
export function buildDoubaoAssistantChannel(desire: DoubaoChannelDesire): Record<string, unknown> | null {
  const doubaoAccounts = desire.accounts.filter(account => account.platform === 'doubao');
  if (!doubaoAccounts.length) return null;
  return {
    id: DOUBAO_CHANNEL_ID,
    name: '豆包账号',
    publicAlias: '豆包账号',
    sortOrder: 0,
    baseUrl: gatewayV1Url(desire.gatewayBaseUrl),
    apiKey: desire.apiKey,
    secretKey: '',
    apiFormat: 'openai',
    concurrencyLimit: 5,
    models: doubaoAccounts.flatMap(account => [`doubao-account-${account.id}`, `doubao-video-account-${account.id}`, `doubao-image-account-${account.id}`]),
    modelProfiles: doubaoAccounts.flatMap(account => [
      {
        model: `doubao-account-${account.id}`,
        displayName: `豆包账号: ${account.name || `账号${account.id}`}`,
        capability: 'text',
        protocol: 'chat-completion',
      },
      {
        model: `doubao-video-account-${account.id}`,
        displayName: `豆包账号: ${account.name || `账号${account.id}`}`,
        capability: 'video',
        protocol: DOUBAO_VIDEO_PROTOCOL,
        capabilityConfig: doubaoVideoCapabilityConfig(),
        defaultOptions: { video_model: DOUBAO_DEFAULT_VIDEO_MODEL },
      },
      {
        model: `doubao-image-account-${account.id}`,
        displayName: `豆包账号: ${account.name || `账号${account.id}`}`,
        capability: 'image',
        protocol: DOUBAO_IMAGE_PROTOCOL,
        capabilityConfig: doubaoImageCapabilityConfig(),
        defaultOptions: { image_model: DOUBAO_DEFAULT_IMAGE_MODEL },
      },
    ]),
    enabled: true,
    scope: 'user',
    headers: [],
  };
}

/** apiKey 读回为空或带星号时视为已脱敏、无法比较，不据此反复改写。 */
function channelMatches(existing: Record<string, unknown>, desired: Record<string, unknown>, compareKey: boolean): boolean {
  const key = typeof existing.apiKey === 'string' ? existing.apiKey : '';
  const keyComparable = compareKey || (key !== '' && !key.includes('*'));
  return existing.baseUrl === desired.baseUrl
    && existing.enabled !== false
    && JSON.stringify(existing.models) === JSON.stringify(desired.models)
    && JSON.stringify(existing.modelProfiles) === JSON.stringify(desired.modelProfiles)
    && (!keyComparable || key === desired.apiKey);
}

/**
 * 默认模型仅使用 API 渠道；保证助手可选豆包账号渠道（只含文本），
 * 清理旧版自动注入到默认模型的引用。豆包节点独立走网关，不依赖这里。
 */
async function syncHostedModelConfig(hostBaseUrl: string, desire: DoubaoChannelDesire): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    const getResponse = await fetch(`${hostBaseUrl}/api/workspace/model-config`, { signal: AbortSignal.timeout(8000) });
    const payload = await getResponse.json() as { code?: number; data?: { config?: Record<string, unknown>, revision?: number } };
    const config = payload?.data?.config;
    const revision = payload?.data?.revision;
    if (!getResponse.ok || payload.code !== 0 || !config || typeof revision !== 'number') return { ok: false, count: 0, error: '后端模型配置不可读' };
    const channels = (Array.isArray(config.channels) ? config.channels : []) as Array<Record<string, unknown>>;
    const existing = channels.find(channel => channel?.id === DOUBAO_CHANNEL_ID);
    const desired = buildDoubaoAssistantChannel(desire);
    let changed = false;
    let nextChannels = channels;
    if (desired) {
      if (!existing || !channelMatches(existing, desired, false)) {
        changed = true;
        nextChannels = existing
          ? channels.map(channel => channel?.id === DOUBAO_CHANNEL_ID ? { ...channel, ...desired } : channel)
          : [...channels, desired];
      }
    } else if (existing) {
      changed = true;
      nextChannels = channels.filter(channel => channel?.id !== DOUBAO_CHANNEL_ID);
    }
    for (const key of DEFAULT_MODEL_KEYS) {
      if (!isInjectedDoubaoModel(config[key])) continue;
      config[key] = '';
      changed = true;
    }
    // 助手模型：保留用户选的豆包账号；账号已删除或渠道不存在时清空。
    const assistant = config[ASSISTANT_MODEL_KEY];
    if (isInjectedDoubaoModel(assistant)) {
      const model = String(assistant).slice(`${DOUBAO_CHANNEL_ID}::`.length);
      if (!(desired && (desired.models as string[]).includes(model))) { config[ASSISTANT_MODEL_KEY] = ''; changed = true; }
    } else if (desired && !assistant && !config.textModel) {
      // 还没配置任何文本模型：默认让助手使用第一个豆包账号，开箱即可对话；用户可随时改选。
      config[ASSISTANT_MODEL_KEY] = `${DOUBAO_CHANNEL_ID}::${(desired.models as string[])[0]}`;
      changed = true;
    }
    if (Array.isArray(config.models)) {
      const models = config.models.filter(model => !isInjectedDoubaoModel(model));
      changed ||= models.length !== config.models.length;
      config.models = models;
    }
    if (!changed) return { ok: true, count: 0 };
    config.channels = nextChannels;
    const putResponse = await fetch(`${hostBaseUrl}/api/workspace/model-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, expectedRevision: revision }),
      signal: AbortSignal.timeout(8000),
    });
    if (!putResponse.ok) {
      const text = await putResponse.text().catch(() => '');
      return { ok: false, count: 0, error: `后端保存失败（HTTP ${putResponse.status}）：${text.slice(0, 120)}` };
    }
    const saved = await putResponse.json() as { code?: number };
    if (saved.code !== 0) return { ok: false, count: 0, error: '后端未保存模型配置' };
    return { ok: true, count: 0 };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, count: 0, error: msg };
  }
}

export type BeefTvSyncOptions = {
  appDataDir?: string;
  /** 仅旧版“同步至 BeefTV”按钮显式启用；账号变化和启动不会写原生应用配置。 */
  syncNative?: boolean;
  /** 工作站托管的 BeefTV 宿主地址（静态服务器，自动注入 owner 身份）。 */
  hostBaseUrl?: string;
  /** 豆包网关实际地址（含端口）。缺省回落 8788——网关被占换端口后必须传真实值。 */
  gatewayBaseUrl?: string;
};

/** 渠道 baseUrl 指向的网关 OpenAI 入口。 */
function gatewayV1Url(gatewayBaseUrl?: string): string {
  return `${(gatewayBaseUrl || 'http://127.0.0.1:8788').replace(/\/+$/, '')}/v1`;
}

/**
 * 所有同步调用（守护轮询/用户建删号/网关加号）都串行执行：读-合并-写回没有
 * 互斥时，两个并发同步会拿到同一 revision 互踢 CAS，后写的失败且被调用方
 * `void` 静默吞掉，账号变更只能等 30s 守护自愈。
 */
let syncChain: Promise<unknown> = Promise.resolve();
function enqueueSync<T>(work: () => Promise<T>): Promise<T> {
  const run = syncChain.then(work, work);
  syncChain = run.catch(() => undefined);
  return run;
}

export function syncAccountsToBeefTv(accounts: Account[], apiKey = 'sk-doubao', options: BeefTvSyncOptions = {}): Promise<{ ok: boolean; count: number; error?: string }> {
  return enqueueSync(async () => {
    let last: { ok: boolean; count: number; error?: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await syncAccountsToBeefTvOnce(accounts, apiKey, options);
      if (last.ok) return last;
      // 与用户/守护并发写时 CAS 失败（HTTP 409）：重读最新 revision 再试。
      if (!/HTTP 409|已被其他写入/.test(last.error || '')) return last;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return last!;
  });
}

async function syncAccountsToBeefTvOnce(accounts: Account[], apiKey: string, options: BeefTvSyncOptions): Promise<{ ok: boolean; count: number; error?: string }> {
  const results: Array<{ ok: boolean; count: number; error?: string }> = [];
  if (options.hostBaseUrl) {
    results.push(await syncHostedModelConfig(options.hostBaseUrl, { accounts, apiKey, gatewayBaseUrl: options.gatewayBaseUrl }));
  }
  const nativePath = getBeefTvDbPath(options.appDataDir);
  if (options.syncNative && fs.existsSync(nativePath)) {
    results.push(syncIntoNativeDb(nativePath, accounts, apiKey, options.gatewayBaseUrl));
  }
  const success = results.find(result => result.ok);
  if (success) return success;
  return results[0] || { ok: true, count: 0 };
}

function syncIntoNativeDb(dbPath: string, accounts: Account[], apiKey: string, gatewayBaseUrl?: string): { ok: boolean; count: number; error?: string } {
  try {
    const bDb = new Database(dbPath);
    const doubaoAccounts = accounts.filter(a => a.platform === 'doubao');

    const models = ['doubao', 'doubao-pro', 'doubao-image', 'doubao-video'];
    for (const acc of doubaoAccounts) {
      models.push(`doubao-account-${acc.id}`);
      models.push(`doubao-video-account-${acc.id}`);
    }

    const now = new Date().toISOString();
    const channelId = DOUBAO_CHANNEL_ID;

    const channelStmt = bDb.prepare(`
      INSERT INTO model_channels (
        id, user_id, scope, enabled, name, public_alias, sort_order, base_url, api_key, secret_key, api_format, concurrency_limit, models_json, retired_models_json, headers_json, created_at, updated_at
      ) VALUES (
        @id, @user_id, @scope, @enabled, @name, @public_alias, @sort_order, @base_url, @api_key, @secret_key, @api_format, @concurrency_limit, @models_json, @retired_models_json, @headers_json, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        public_alias = excluded.public_alias,
        base_url = excluded.base_url,
        api_key = excluded.api_key,
        models_json = excluded.models_json,
        enabled = 1,
        updated_at = excluded.updated_at
    `);

    channelStmt.run({
      id: channelId,
      user_id: 'system',
      scope: 'system',
      enabled: 1,
      name: '豆包工作站',
      public_alias: '豆包工作站',
      sort_order: 0,
      base_url: gatewayV1Url(gatewayBaseUrl),
      api_key: apiKey,
      secret_key: '',
      api_format: 'openai',
      concurrency_limit: 5,
      models_json: JSON.stringify(models),
      retired_models_json: '[]',
      headers_json: '[]',
      created_at: now,
      updated_at: now,
    });

    const modelEntries = [
      { id: `${channelId}-doubao`, model_key: 'doubao', display_name: '豆包对话 (自动调度)', capability: 'text', protocol: 'chat-completion', sort_order: 1 },
      { id: `${channelId}-doubao-pro`, model_key: 'doubao-pro', display_name: '豆包 Pro (深度思考)', capability: 'text', protocol: 'chat-completion', sort_order: 2 },
      { id: `${channelId}-doubao-image`, model_key: 'doubao-image', display_name: '即梦生图 (自动调度)', capability: 'image', protocol: 'openai-image', sort_order: 3 },
      { id: `${channelId}-doubao-video`, model_key: 'doubao-video', display_name: 'Seedance 视频生成 (自动调度)', capability: 'video', protocol: 'newapi-channel-2', sort_order: 4 },
    ];

    let sortIdx = 10;
    for (const acc of doubaoAccounts) {
      const accLabel = acc.name || `账号${acc.id}`;
      modelEntries.push({
        id: `${channelId}-doubao-account-${acc.id}`,
        model_key: `doubao-account-${acc.id}`,
        display_name: `豆包账号: ${accLabel}`,
        capability: 'text',
        protocol: 'chat-completion',
        sort_order: sortIdx++,
      });
      modelEntries.push({
        id: `${channelId}-doubao-video-account-${acc.id}`,
        model_key: `doubao-video-account-${acc.id}`,
        display_name: `视频专属: ${accLabel}`,
        capability: 'video',
        protocol: 'newapi-channel-2',
        sort_order: sortIdx++,
      });
    }

    const modelStmt = bDb.prepare(`
      INSERT INTO channel_models (
        id, channel_id, model_key, provider_model_key, display_name, sort_order, icon, capability, protocol, enabled, capability_config_json, capability_version, created_at, updated_at
      ) VALUES (
        @id, @channel_id, @model_key, @model_key, @display_name, @sort_order, '', @capability, @protocol, 1, '{}', 1, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        capability = excluded.capability,
        protocol = excluded.protocol,
        enabled = 1,
        updated_at = excluded.updated_at
    `);

    for (const m of modelEntries) {
      modelStmt.run({
        channel_id: channelId,
        ...m,
        created_at: now,
        updated_at: now,
      });
    }

    bDb.close();
    return { ok: true, count: modelEntries.length };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, count: 0, error: msg };
  }
}

export function launchNativeBeefTv(): boolean {
  const possiblePaths = [
    'E:\\beeftv\\BeefTV.exe',
    'D:\\beeftv\\BeefTV.exe',
    'C:\\Program Files\\BeefTV\\BeefTV.exe',
  ];

  for (const exe of possiblePaths) {
    if (fs.existsSync(exe)) {
      try {
        const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
        child.unref();
        return true;
      } catch (e) {
        console.error('Failed to spawn BeefTV.exe:', e);
      }
    }
  }
  return false;
}
