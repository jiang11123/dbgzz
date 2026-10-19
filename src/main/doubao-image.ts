/**
 * Doubao image generation over the site's own HTTP API.
 *
 * Same transport as chat (in-page fetch + X-Bogus signature), different endpoint,
 * payload and response shape:
 *
 *   POST /samantha/chat/completion
 *   messages[0].content_type = 2009, skill_id = 3
 *   content = JSON.stringify({ text, model, ratio, template_type, use_creation })
 *
 * The answer arrives as content_type 2010 with a data[] array of images; each entry
 * exposes image_ori / image_raw / image_thumb URLs. Only image_ori is used: it is the
 * largest and matches what the website itself downloads.
 *
 * Verified against a live account: HTTP 200, 3 URLs, and the resulting 2048x2048 PNG
 * downloaded successfully (5,062,659 bytes).
 */
import { ipcMain } from 'electron';
import type { BrowserView } from 'electron';
import { buildStartScript, buildDrainScript, RISK_ERROR_CODES, waitForPageReady } from './doubao-api';
import type { DoubaoAttachment } from './doubao-upload';

export const SAMANTHA_PATH = '/samantha/chat/completion';
export const IMAGE_CONTENT_TYPE = 2009;
export const IMAGE_RESPONSE_TYPE = 2010;
export const IMAGE_SKILL_ID = 3;

/** Doubao image models exposed to callers. */
export const IMAGE_MODELS = ['Seedream 4.5', 'Seedream 4.0', 'Seedream 3.0'] as const;
export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0];
export const IMAGE_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'] as const;
export const DEFAULT_IMAGE_RATIO = '1:1';

export type ImageGenerationOptions = {
  model?: string;
  ratio?: string;
  timeoutMs?: number;
  /** Reference images already uploaded to Doubao, as attachment objects. */
  attachments?: unknown[];
};

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 18);
}

/**
 * Converts raw DoubaoAttachment objects (as returned by uploadImageToDoubao) into
 * the wire format the /samantha/chat/completion endpoint expects for image references.
 *
/**
 * Converts raw DoubaoAttachment objects (as returned by uploadImageToDoubao) into
 * the wire format the /samantha/chat/completion endpoint expects for image references.
 *
 * Doubao's image generation skill expects attachments formatted as:
 *   { type: 'image', key: '<tos_uri>', extra: { refer_types: 'overall' } }
 */
export function formatSamanthaAttachments(attachments: unknown[]): unknown[] {
  return attachments.map(raw => {
    const item = raw as DoubaoAttachment;
    if (!item || typeof item !== 'object') return raw;
    const key = (item as any).key || item.uri;
    if (!key) return raw;
    return {
      type: 'image',
      key,
      extra: { refer_types: 'overall' },
    };
  });
}

/**
 * Builds the /samantha/chat/completion body.
 *
 * skill_id 3 is the image-generation skill; the site sends it alongside a content
 * string that itself carries the model and ratio.
 */
export function buildImagePayload(prompt: string, options: ImageGenerationOptions = {}) {
  const model = options.model || DEFAULT_IMAGE_MODEL;
  const ratio = options.ratio || DEFAULT_IMAGE_RATIO;
  const contentData: Record<string, unknown> = {
    text: prompt,
    model,
  };
  if (ratio) contentData.ratio = ratio;
  return {
    messages: [{
      content: JSON.stringify(contentData),
      content_type: IMAGE_CONTENT_TYPE,
      attachments: options.attachments?.length ? formatSamanthaAttachments(options.attachments) : [],
      references: [],
      skill: {
        skill_type: IMAGE_SKILL_ID, skill_type_no_default: IMAGE_SKILL_ID,
        skill_id: String(IMAGE_SKILL_ID), skill_id_no_default: String(IMAGE_SKILL_ID),
      },
    }],
    completion_option: {
      is_regen: false, with_suggest: true, need_create_conversation: true, launch_stage: 1,
      is_replace: false, is_delete: false, is_ai_playground: false, memory_type: 2,
      message_from: 0, use_deep_think: false, use_auto_cot: false, resend_for_regen: false,
      enable_commerce_credit: false, action_bar_skill_id: IMAGE_SKILL_ID,
    },
    evaluate_option: { web_ab_params: '' },
    local_conversation_id: 'local_' + randomSuffix(),
    local_message_id: 'msg_' + randomSuffix(),
  };
}

export type GeneratedImage = { url: string; width: number; height: number; format: string };

/** Reads image URLs out of one SSE event (empty array when the event carries none). */
export function parseImageEvent(event: any): { images: GeneratedImage[]; error?: { code: number; message: string; riskControl: boolean } } {
  const images: GeneratedImage[] = [];
  if (!event || typeof event !== 'object') return { images };

  const code = Number(event.error_code ?? event.code ?? 0);
  if (code) {
    return { images, error: { code, message: String(event.error_msg ?? event.message ?? '未知错误'), riskControl: RISK_ERROR_CODES.includes(code) } };
  }

  // The site wraps payloads in event_data, sometimes itself a JSON string.
  let data = event.event_data ?? event;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return { images }; } }
  let message = data?.message ?? data;
  if (typeof message === 'string') { try { message = JSON.parse(message); } catch { return { images }; } }
  if (!message || message.content_type !== IMAGE_RESPONSE_TYPE) return { images };

  let content = message.content;
  if (typeof content === 'string') { try { content = JSON.parse(content); } catch { return { images }; } }
  const items = Array.isArray(content?.data) ? content.data : [];
  for (const item of items) {
    const url = item?.image_ori?.url || item?.image_raw?.url || item?.image_thumb?.url || item?.url;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
    images.push({
      url: url.replace(/\\u0026/g, '&').replace(/&amp;/g, '&'),
      width: Number(item?.image_ori?.width ?? item?.width ?? 0) || 0,
      height: Number(item?.image_ori?.height ?? item?.height ?? 0) || 0,
      format: String(item?.image_ori?.format ?? item?.format ?? 'png'),
    });
  }
  return { images };
}

/** Pulls plain reply text out of an event, including the nested JSON-string shape. */
export function extractEventText(event: any): string {
  if (!event || typeof event !== 'object') return '';
  const unwrap = (value: any): any => {
    let current = value;
    for (let i = 0; i < 3 && typeof current === 'string'; i += 1) {
      try { current = JSON.parse(current); } catch { return current; }
    }
    return current;
  };
  const data = unwrap(event.event_data ?? event);
  const message = unwrap(data?.message ?? data);
  const content = unwrap(message?.content);
  if (typeof content === 'string') return content;
  if (content && typeof content.text === 'string') return content.text;
  if (typeof event.text === 'string') return event.text;
  return '';
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generates images and returns their URLs.
 *
 * Mirrors streamChat's transport: the request runs inside the page, frames arrive over
 * the push bridge (or the fallback buffer), and generation is complete once the stream
 * ends.
 */
export async function generateImages(view: BrowserView, prompt: string, options: ImageGenerationOptions = {}): Promise<GeneratedImage[]> {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('提示词为空');
  if (view.webContents.isDestroyed()) throw new Error('账号页面已关闭');
  // A background view may still be booting; signing before the page is ready fails.
  if (!(await waitForPageReady(view))) throw new Error('账号页面尚未就绪，请稍后重试');

  const timeoutMs = options.timeoutMs ?? 180_000;
  const requestId = 'img' + Date.now().toString(36) + randomSuffix().slice(0, 6);
  const payload = buildImagePayload(text, options);

  const inbox: string[] = [];
  let done = false;
  let streamError: string | null = null;

  const onPush = (_event: unknown, message: { requestId?: string; event?: string; error?: string; done?: boolean }) => {
    if (!message || message.requestId !== requestId) return;
    if (typeof message.event === 'string') inbox.push(message.event);
    if (typeof message.error === 'string') { streamError = message.error; done = true; }
    if (message.done) done = true;
  };
  ipcMain.on('doubao:stream', onPush);

  const images: GeneratedImage[] = [];
  const seen = new Set<string>();
  let riskFailure: Error | null = null;
  let eventCount = 0;
  let textSeen = '';

  const rawSamples: string[] = [];
  const consume = (raw: string) => {
    let event: any;
    try { event = JSON.parse(raw); } catch { return; }
    eventCount += 1;
    // Keep the first few raw frames: when neither images nor text arrive, this is the
    // only evidence of what the server actually said.
    if (rawSamples.length < 10) rawSamples.push(raw.slice(0, 200));
    // Doubao replies with a plain text message when the account is throttled
    // ("当前服务访问频繁，请稍后重试"). Detect it so the caller gets an actionable
    // error — and so the pool can cool the account down — instead of a generic
    // "no images" failure.
    const text = extractEventText(event);
    if (text) {
      textSeen += text;
      if (/访问频繁|稍后重试|请求过于频繁|rate\s*limit|too many requests|try again later/i.test(text)) {
        riskFailure = new Error('豆包提示访问频繁，请稍后再试（账号已进入冷却）');
        return;
      }
    }
    if (typeof event?.text === 'string' && event.text) textSeen += event.text;
    const parsed = parseImageEvent(event);
    if (parsed.error) {
      riskFailure = parsed.error.riskControl
        ? new Error('豆包触发人机验证（' + parsed.error.code + '），请在豆包窗口完成验证后重试')
        : new Error('豆包返回错误 ' + parsed.error.code + '：' + parsed.error.message);
      return;
    }
    for (const image of parsed.images) {
      if (seen.has(image.url)) continue;
      seen.add(image.url);
      images.push(image);
    }
  };

  const cleanup = '(() => { try { delete window.__DSBUF?.["' + requestId + '"]; } catch {} return true; })()';
  const deadline = Date.now() + timeoutMs;
  try {
    await view.webContents.executeJavaScript(buildStartScript(requestId, payload, SAMANTHA_PATH), true);

    while (Date.now() < deadline) {
      if (view.webContents.isDestroyed()) throw new Error('账号页面已关闭');

      if (done) {
        const tail = await view.webContents.executeJavaScript(buildDrainScript(requestId)).catch(() => null) as { events: string[]; error: string | null } | null;
        if (tail?.events?.length) for (const raw of tail.events) consume(raw);
        while (inbox.length) consume(inbox.shift()!);
        if (riskFailure) throw riskFailure;
        if (tail?.error) throw new Error(tail.error);
        break;
      }

      while (inbox.length) consume(inbox.shift()!);
      if (riskFailure) throw riskFailure;
      if (streamError) throw new Error(streamError);

      await pause(150);
      const pulled = await view.webContents.executeJavaScript(buildDrainScript(requestId)).catch(() => null) as { events: string[]; done: boolean; error: string | null } | null;
      if (!pulled) continue;
      for (const raw of pulled.events) consume(raw);
      if (riskFailure) throw riskFailure;
      if (pulled.error) throw new Error(pulled.error);
      if (pulled.done) done = true;
    }
  } finally {
    ipcMain.removeListener('doubao:stream', onPush);
    await view.webContents.executeJavaScript(cleanup).catch(() => undefined);
  }

  // A stream that never finished must not be reported as a partial result: images
  // trickling in before the deadline would otherwise be downloaded as a complete set.
  if (!done) throw new Error('生图超时（收到 ' + eventCount + ' 个事件' + (textSeen ? '，文字：' + textSeen.slice(0, 60) : '，样本：' + rawSamples.join(' || ').slice(0, 420)) + '）');
  if (!images.length) {
    // Surface what actually came back: a text-only reply means the payload was treated
    // as a chat turn, which is a different problem from an empty response.
    const detail = textSeen ? '，文字：' + textSeen.slice(0, 60) : '，样本：' + rawSamples.join(' || ').slice(0, 420);
    throw new Error('豆包没有返回图片（收到 ' + eventCount + ' 个事件' + detail + '）');
  }
  return images;
}
