/**
 * Doubao video generation (text-to-video / image-to-video).
 *
 * Video is NOT triggered by a special content_type. Verified against
 * linyf-B/doubao-relay's implementation: the site exposes video as a *chat ability*, so
 * the request is an ordinary /chat/completion turn whose payload carries:
 *
 *   ext.chat_ability = { ability_type: 17, ability_param: '{"model":...,"duration":...}' }
 *
 * and whose prompt asks for a video explicitly. This is why an earlier attempt using
 * content_type 2020 was answered as normal chat: that shape is not how the site submits
 * video.
 *
 * The reply is asynchronous: the stream yields a task id (fin_reason.async_task.id), and
 * the result is polled from /samantha/chat/async/stream until a video URL appears.
 */
import { ipcMain } from 'electron';
import type { BrowserView } from 'electron';
import { buildStartScript, buildDrainScript } from './doubao-api';

export const ASYNC_STREAM_PATH = '/samantha/chat/async/stream';
export const VIDEO_ABILITY_TYPE = 17;
export const VIDEO_CONTENT_TYPE = 2021;

/** Model aliases accepted from callers, mapped to Doubao's ability model names. */
export const VIDEO_MODELS = ['Seedance 2.5', 'Seedance 2.0', 'Seedance 2.0 Fast', 'Seedance 2.0 Mini'] as const;
export const DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0];
export const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;
export const DEFAULT_VIDEO_RATIO = '16:9';
export const MIN_DURATION = 4;
// Doubao's own composer offers 4s-30s (verified in the site's duration slider).
export const MAX_DURATION = 30;

/** Maps a friendly model name onto the ability model id the site expects. */
export function mapAbilityModel(model?: string): string {
  const value = String(model || '').trim();
  if (!value) return 'seedance_v2.0';
  if (/seedance_v/i.test(value)) return value;
  if (/2\.5/i.test(value)) return 'seedance_v2.5';
  if (/fast|mini/i.test(value)) return 'seedance_v2.0_fast';
  if (/2\.0/i.test(value)) return 'seedance_v2.0';
  return value;
}

/** Clamps duration into the range the site accepts. */
export function clampDuration(value?: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 10;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(numeric)));
}

export type VideoGenerationOptions = { model?: string; ratio?: string; duration?: number; conversationId?: string; timeoutMs?: number };

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 18);
}

/**
 * Builds the /chat/completion body that asks doubao to produce a video.
 *
 * The prompt is wrapped in an explicit instruction: without it the model tends to ask
 * for confirmation instead of starting, which is what upstream callers observed too.
 */
export function buildVideoPayload(prompt: string, options: VideoGenerationOptions = {}) {
  const duration = clampDuration(options.duration);
  const ratio = options.ratio || DEFAULT_VIDEO_RATIO;
  const abilityParam: Record<string, unknown> = { model: mapAbilityModel(options.model), duration };
  if (ratio) abilityParam.ratio = ratio;

  const trimmed = prompt.trim();
  const text = trimmed.startsWith('生成视频')
    ? trimmed
    : '生成视频：' + trimmed + '。请直接按比例 ' + ratio + '、时长 ' + duration + ' 秒生成，不要询问确认，立即开始。';

  const nowMs = Date.now();
  return {
    client_meta: {
      local_conversation_id: options.conversationId ? '' : 'local_' + randomSuffix(),
      conversation_id: options.conversationId || '',
      bot_id: '7338286299411103781',
      last_section_id: '',
      last_message_index: options.conversationId ? 0 : null,
    },
    messages: [{
      local_message_id: randomSuffix() + '-' + randomSuffix(),
      content_block: [{
        block_type: 10000,
        content: { text_block: { text, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
        block_id: randomSuffix() + '-' + randomSuffix(),
        parent_id: '', meta_info: [], append_fields: [], is_finish: true, patch_type: 2,
      }],
      message_status: 0,
    }],
    option: {
      send_message_scene: '', create_time_ms: nowMs, collect_id: '', is_audio: false,
      answer_with_suggest: false, tts_switch: false, need_deep_think: 0, click_clear_context: false,
      from_suggest: false, is_regen: false, is_replace: false, is_from_click_option: false,
      disable_sse_cache: false, select_text_action: '', is_select_text: false, resend_for_regen: false,
      scene_type: 0, unique_key: randomSuffix() + '-' + randomSuffix(), start_seq: 0,
      need_create_conversation: !options.conversationId,
      conversation_init_option: { need_ack_conversation: true },
      regen_query_id: [], edit_query_id: [], regen_instruction: '', no_replace_for_regen: false,
      message_from: 0, shared_app_name: '', shared_app_id: '',
      sse_recv_event_options: { support_chunk_delta: true },
      is_ai_playground: false, is_old_user: true,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(nowMs / 1000), append_sse_event_scene: 0 },
      message_storage_type: 0,
    },
    user_context: [],
    ext: {
      use_deep_think: '0', fp: '', sub_conv_firstmet_type: options.conversationId ? '0' : '1',
      collection_id: '', conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
      commerce_credit_config_enable: '0', answer_with_suggest: '0',
    },
    // chat_ability is a TOP-LEVEL field, a sibling of ext. Nesting it under ext made the
    // server reject the request with 710020202 'common invalid param'.
    chat_ability: { ability_type: VIDEO_ABILITY_TYPE, ability_param: JSON.stringify(abilityParam) },
  };
}

/** Builds the polling body for an in-flight video task. */
export function buildAsyncPollPayload(taskId: string, eventId = 0, conversationId = '') {
  // The async endpoint resolves a task inside its conversation; a bare task_id is
  // answered with an empty stream, which the caller used to read as "still rendering".
  const payload: Record<string, unknown> = { task_id: String(taskId), event_id: eventId };
  if (conversationId) {
    payload.client_meta = {
      local_conversation_id: '', conversation_id: conversationId,
      bot_id: '7338286299411103781', last_section_id: '', last_message_index: 0,
    };
  }
  return payload;
}

export type GeneratedVideo = { url: string; coverUrl: string; width: number; height: number };

/** Unwraps the nested event_data/message/content envelope Doubao uses. */
function unwrapEvent(event: any): any {
  const unwrap = (value: any): any => {
    let current = value;
    for (let i = 0; i < 3 && typeof current === 'string'; i += 1) {
      try { current = JSON.parse(current); } catch { return current; }
    }
    return current;
  };
  const data = unwrap(event?.event_data ?? event);
  return unwrap(data?.message ?? data);
}

/** Finds the async task id the site assigns when it accepts a video job. */
export function extractTaskId(event: any): string {
  const message = unwrapEvent(event);
  if (!message || typeof message !== 'object') return '';
  const fin = message.fin_reason || message.finReason;
  if (fin && typeof fin === 'object') {
    const asyncTask = fin.async_task || fin.asyncTask || {};
    const id = asyncTask.id || fin.asyncTaskId || fin.async_task_id || fin.task_id;
    if (id && String(id) !== '0') return String(id);
  }
  for (const key of ['task_id', 'taskId', 'async_task_id', 'asyncTaskId', 'video_task_id']) {
    const value = message[key];
    if (value != null && String(value) !== '0' && String(value).length >= 6) return String(value);
  }
  return '';
}

/** Extracts video URLs from a content_type 2021 payload, or any URL in the blob. */
export function extractVideos(event: any): GeneratedVideo[] {
  const found: GeneratedVideo[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, cover = '', width = 0, height = 0) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
    if (!/(\.mp4|\.m3u8|\/video\/|bytevcloud|vlabvod|video_id=)/i.test(url)) return;
    if (/[.](png|jpe?g|webp|gif)(~|\?|$)/i.test(url)) return;
    const clean = url.replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
    if (seen.has(clean)) return;
    seen.add(clean);
    found.push({ url: clean, coverUrl: cover, width, height });
  };

  const message = unwrapEvent(event);
  if (message && typeof message === 'object' && message.content_type === VIDEO_CONTENT_TYPE) {
    let content = message.content;
    if (typeof content === 'string') { try { content = JSON.parse(content); } catch { content = null; } }
    const items = Array.isArray(content?.data) ? content.data : (content ? [content] : []);
    for (const item of items) {
      add(item?.video_url || item?.url || item?.video?.url, item?.cover_url || item?.cover, Number(item?.width) || 0, Number(item?.height) || 0);
    }
  }

  // Fall back to scanning the raw event for any video-looking URL.
  for (const match of JSON.stringify(event ?? {}).match(/https?:\\?\/\\?\/[^\s"'\\]+/g) || []) {
    add(match.replace(/\\\//g, '/'));
  }
  return found;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type VideoRunResult = { videos: GeneratedVideo[]; taskId: string; conversationId: string; message: string };

/** Plain facts shared by every submit path: where to watch the job and what the model said. */
export type VideoSubmitResult = { conversationId: string; taskId: string; message: string; confirmed?: boolean };

/**
 * Reduces a submit stream into a conversation id, a task id and the model's text.
 *
 * The site starts the video job server-side but usually closes the SSE after a short
 * text note, so the conversation page — not this stream — is where the video appears.
 */
export function parseVideoSubmitEvents(events: string[]): VideoSubmitResult {
  let taskId = '';
  let conversationId = '';
  const texts: string[] = [];
  for (const raw of events) {
    let event: any;
    try { event = JSON.parse(raw); } catch { continue; }
    if (!taskId) taskId = extractTaskId(event);
    if (!conversationId) {
      const message = unwrapEvent(event);
      const id = message?.conversation_id || event?.ack_client_meta?.conversation_id || event?.msg_finish_attr?.conversation_id;
      if (typeof id === 'string' && /^\d{6,}$/.test(id)) conversationId = id;
    }
    const reply = extractEventText(event);
    if (reply) texts.push(reply);
  }
  return { conversationId, taskId, message: texts.join('') };
}

/**
 * Submits one video job and returns the conversation to watch, without waiting for
 * the render to finish. Throws with an actionable message when the account cannot
 * run the job (quota, verification, or the model declining), so callers can fail
 * over to another account.
 */
export async function submitVideoTask(view: BrowserView, prompt: string, options: VideoGenerationOptions = {}): Promise<VideoSubmitResult> {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('提示词为空');
  if (view.webContents.isDestroyed()) throw new Error('账号页面已关闭');

  const submit = await runStream(view, buildVideoPayload(text, options), options.timeoutMs ?? 180_000);
  const result = parseVideoSubmitEvents(submit.events);
  const message = result.message;

  if (/710022004|人机验证|安全验证|滑块/.test(message)) throw new Error('豆包要求人机验证，需要人工处理该账号');
  if (/访问频繁|稍后重试/.test(message)) throw new Error('豆包提示访问频繁，请稍后再试');
  if (/免费次数已?用完|额度不足|额度用完|创作额度|额度已用/.test(message)) throw new Error('豆包账号视频生成额度不足');
  if (!result.conversationId) throw new Error('豆包没有创建视频会话' + (message ? '：' + message.slice(0, 80) : ''));
  if (/无法直接生成|无法生成视频|帮不了|无能为力/.test(message)) throw new Error('该账号未接受视频任务，请更换账号重试');

  // The site answers a video request with a rewritten prompt and a confirmation question;
  // it renders nothing until that question is answered. Auto-confirm so the user only
  // types the prompt once.
  if (isConfirmAsk(message)) {
    const confirm = await runStream(view, buildConfirmPayload(result.conversationId), options.timeoutMs ?? 180_000);
    const confirmed = parseVideoSubmitEvents(confirm.events);
    const confirmMessage = confirmed.message || message;
    // The quota notice usually arrives as the reply to the confirmation turn.
    if (/免费次数已?用完|额度不足|额度用完|创作额度|额度已用/.test(confirmMessage)) throw new Error('豆包账号视频生成额度不足');
    return { conversationId: result.conversationId, taskId: confirmed.taskId || result.taskId, message: confirmMessage, confirmed: true };
  }
  return result;
}

/** Replies that mean doubao is asking whether to proceed with the video. */
const CONFIRM_ASK_PATTERN = /确认后|是否确认|请确认|确认按|生成吗|建议先按|建议用|我就直接生成|按这个生成|需要我|是否开始/;

/**
 * Detects the confirmation question doubao asks before it will render a video.
 *
 * The site treats a video request as a proposal: it rewrites the prompt, then asks
 * "确认后按这些参数生成吗？" and waits. Nothing renders until the user answers, so a
 * submit that only got a question looks like a failure even though the job was
 * accepted.
 */
export function isConfirmAsk(message: string): boolean {
  return CONFIRM_ASK_PATTERN.test(String(message ?? ''));
}

/**
 * Sends the plain confirmation that starts the render, inside the same conversation.
 *
 * The prompt deliberately carries no extra instructions: the site parses a short
 * affirmative as "yes, go", whereas another full prompt makes it re-plan and ask
 * again.
 */
export function buildConfirmPayload(conversationId: string) {
  const nowMs = Date.now();
  return {
    client_meta: {
      local_conversation_id: '',
      conversation_id: conversationId,
      bot_id: '7338286299411103781',
      last_section_id: '',
      last_message_index: 0,
    },
    messages: [{
      local_message_id: randomSuffix() + '-' + randomSuffix(),
      content_block: [{
        block_type: 10000,
        content: { text_block: { text: '确认', icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
        block_id: randomSuffix() + '-' + randomSuffix(),
        parent_id: '', meta_info: [], append_fields: [], is_finish: true, patch_type: 2,
      }],
      message_status: 0,
    }],
    option: {
      send_message_scene: '', create_time_ms: nowMs, collect_id: '', is_audio: false,
      answer_with_suggest: false, tts_switch: false, need_deep_think: 0, click_clear_context: false,
      from_suggest: false, is_regen: false, is_replace: false, is_from_click_option: false,
      disable_sse_cache: false, select_text_action: '', is_select_text: false, resend_for_regen: false,
      scene_type: 0, unique_key: randomSuffix() + '-' + randomSuffix(), start_seq: 0,
      need_create_conversation: false,
      conversation_init_option: { need_ack_conversation: true },
      regen_query_id: [], edit_query_id: [], regen_instruction: '', no_replace_for_regen: false,
      message_from: 0, shared_app_name: '', shared_app_id: '',
      sse_recv_event_options: { support_chunk_delta: true },
      is_ai_playground: false, is_old_user: true,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(nowMs / 1000), append_sse_event_scene: 0 },
      message_storage_type: 0,
    },
    user_context: [],
    ext: {
      use_deep_think: '0', fp: '', sub_conv_firstmet_type: '0',
      collection_id: '', conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
      commerce_credit_config_enable: '0', answer_with_suggest: '0',
    },
  };
}

type StreamOutcome = { events: string[]; text: string };

/** Runs one page-side request and collects its SSE frames. */
async function runStream(view: BrowserView, payload: unknown, timeoutMs: number, path?: string): Promise<StreamOutcome> {
  const requestId = 'vid' + Date.now().toString(36) + randomSuffix().slice(0, 6);
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
  const events: string[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    await view.webContents.executeJavaScript(buildStartScript(requestId, payload, path), true);
    while (Date.now() < deadline) {
      if (view.webContents.isDestroyed()) throw new Error('账号页面已关闭');
      while (inbox.length) events.push(inbox.shift()!);
      if (streamError) throw new Error(streamError);
      if (done) {
        const tail = await view.webContents.executeJavaScript(buildDrainScript(requestId)).catch(() => null) as { events: string[]; error: string | null } | null;
        if (tail?.events?.length) events.push(...tail.events);
        if (tail?.error) throw new Error(tail.error);
        break;
      }
      await pause(200);
      const pulled = await view.webContents.executeJavaScript(buildDrainScript(requestId)).catch(() => null) as { events: string[]; done: boolean; error: string | null } | null;
      if (!pulled) continue;
      if (pulled.events.length) events.push(...pulled.events);
      if (pulled.error) throw new Error(pulled.error);
      if (pulled.done) done = true;
    }
  } finally {
    ipcMain.removeListener('doubao:stream', onPush);
    await view.webContents.executeJavaScript('(() => { try { delete window.__DSBUF?.["' + requestId + '"]; } catch {} return true; })()').catch(() => undefined);
  }
  return { events, text: events.map(extractEventText).join('') };
}

/** Pulls plain reply text out of an event, including nested JSON-string envelopes. */
export function extractEventText(event: any): string {
  const message = unwrapEvent(event);
  if (typeof message === 'string') return message;
  let content = message?.content;
  if (typeof content === 'string') { try { content = JSON.parse(content); } catch { return content; } }
  if (typeof content?.text === 'string') return content.text;
  if (typeof event?.text === 'string') return event.text;
  // Doubao delivers the final summary of a video turn in msg_finish_attr.brief
  // (and answer_finish_attr.brief for the confirmation answer). That field holds the
  // "请确认以下参数…确认后我再开始生成视频" question this whole flow waits for.
  const fin = event?.msg_finish_attr ?? event?.msgFinishAttr ?? event?.answer_finish_attr ?? event?.answerFinishAttr;
  if (fin && typeof fin.brief === 'string' && fin.brief) return fin.brief;
  return '';
}

/**
 * Generates a video and waits for a downloadable URL.
 *
 * Submits once, then polls the async task endpoint until a video appears. Generation
 * takes 1-5 minutes in practice, so the poll deadline is generous by design.
 */
export async function generateVideo(view: BrowserView, prompt: string, options: VideoGenerationOptions = {}): Promise<VideoRunResult> {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('提示词为空');
  if (view.webContents.isDestroyed()) throw new Error('账号页面已关闭');

  const submitTimeout = options.timeoutMs ?? 420_000;
  const submit = await runStream(view, buildVideoPayload(text, options), submitTimeout);
  if (/710022004|访问频繁|shark_admin|rate\s*limit/i.test(submit.text)) {
    throw new Error('豆包提示访问频繁或需要验证，请稍后重试');
  }

  let videos: GeneratedVideo[] = [];
  let taskId = '';
  let conversationId = '';
  for (const raw of submit.events) {
    let event: any;
    try { event = JSON.parse(raw); } catch { continue; }
    if (!taskId) taskId = extractTaskId(event);
    if (!conversationId) {
      const message = unwrapEvent(event);
      const id = message?.conversation_id || event?.ack_client_meta?.conversation_id;
      if (typeof id === 'string' && id) conversationId = id;
    }
    videos = videos.concat(extractVideos(event));
  }

  if (videos.length) return { videos, taskId, conversationId, message: submit.text };
  if (!taskId) {
    // The model sometimes replies with a question instead of starting the job.
    throw new Error('豆包没有开始生成视频' + (submit.text ? '：' + submit.text.slice(0, 120) : '（未返回任务号）'));
  }

  const deadline = Date.now() + 12 * 60 * 1000;
  let lastText = submit.text;
  // Each poll round re-reads the same task, so the same URL arrives again and again.
  // Without a cross-round set the result carried hundreds of duplicates and the
  // caller downloaded the same video repeatedly.
  const seenVideoUrls = new Set(videos.map(video => video.url));
  while (Date.now() < deadline) {
    await pause(5_000);
    const poll = await runStream(view, buildAsyncPollPayload(taskId, 0, conversationId), 180_000, ASYNC_STREAM_PATH);
    if (poll.text) lastText = poll.text;
    for (const raw of poll.events) {
      let event: any;
      try { event = JSON.parse(raw); } catch { continue; }
      for (const video of extractVideos(event)) {
        if (seenVideoUrls.has(video.url)) continue;
        seenVideoUrls.add(video.url); videos.push(video);
      }
    }
    if (videos.length) return { videos, taskId, conversationId, message: lastText };
  }
  throw new Error('视频仍在生成中，请稍后查看：' + lastText.slice(0, 120));
}
