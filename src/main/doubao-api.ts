/**
 * Doubao chat completion over the site's own HTTP API.
 *
 * Previous approach drove the DOM (type into the composer, click send, scrape the
 * rendered message). That was fragile: Doubao renders its editor as a contenteditable
 * DIV plus an overlapping TEXTAREA shim, the send button has no stable label and only
 * appears once text is present, and a reset that navigated the page fought with the
 * click geometry. Every one of those failure modes disappears when the request is
 * issued as the page itself would issue it:
 *
 *   1. ask the page for an X-Bogus signature via window.bdms.frontierSign()
 *   2. fetch /chat/completion from inside the page (so cookies, CSRF and device
 *      fingerprint are the real ones, and ByteDance's fetch hook stays satisfied)
 *   3. read the SSE stream directly instead of scraping rendered text
 *
 * Conversation isolation is likewise structural: each request carries its own
 * client_meta.conversation_id (empty = start a new conversation), so no two callers
 * can see each other's history.
 */
import { ipcMain } from 'electron';
import type { BrowserView } from 'electron';
import { buildAttachmentMessage } from './doubao-upload';

const DOUBAO_CHAT_URL = 'https://www.doubao.com/chat/';
const COMPLETION_PATH = '/chat/completion';
const PC_VERSION = '3.36.0';
const VERSION_CODE = '20800';
const DEFAULT_BOT_ID = '7338286299411103781';

/** Risk-control codes that require human verification. */
export const RISK_ERROR_CODES = [710022002, 710022004];

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

/**
 * Builds the /chat/completion request body.
 *
 * Kept pure so the shape can be unit-tested without a browser.
 */
export function buildPayload(text: string, options: { conversationId?: string; botId?: string; deepThink?: boolean; localConversationId?: string; messageId?: string; blockId?: string; uniqueKey?: string; attachments?: unknown[] } = {}) {
  const conversationId = options.conversationId ?? '';
  const needCreate = !conversationId;
  const localConversationId = options.localConversationId ?? `local_${randomHex(16)}`;
  const messageId = options.messageId ?? randomUuid();
  const blockId = options.blockId ?? randomUuid();
  const deepThink = options.deepThink ? 1 : 0;
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  return {
    client_meta: {
      local_conversation_id: needCreate ? localConversationId : '',
      conversation_id: conversationId,
      bot_id: options.botId ?? DEFAULT_BOT_ID,
      last_section_id: '',
      last_message_index: needCreate ? null : 0,
    },
    // Uploaded images ride in their own block_type 10052 message, before the text one —
    // the same shape the site itself sends (verified against a live upload).
    messages: [...(options.attachments?.length ? [buildAttachmentMessage(options.attachments as any)] : []) as any[], {
      local_message_id: messageId,
      content_block: [{
        block_type: 10000,
        content: { text_block: { text, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
        block_id: blockId,
        parent_id: '',
        meta_info: [],
        append_fields: [],
      }],
      message_status: 0,
    }],
    option: {
      send_message_scene: '', create_time_ms: nowMs, collect_id: '', is_audio: false,
      answer_with_suggest: false, agent_mode: 2, tts_switch: false, need_deep_think: deepThink,
      click_clear_context: false, from_suggest: false, is_regen: false, is_replace: false,
      is_from_click_option: false, is_from_click_softlink: false, disable_sse_cache: false,
      select_text_action: '', is_select_text: false, resend_for_regen: false, scene_type: 0,
      unique_key: options.uniqueKey ?? randomUuid(), start_seq: 0, need_create_conversation: needCreate,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: '0', reasoning_effort: String(deepThink), mode_id: '1' },
      regen_query_id: [], edit_query_id: [], regen_instruction: '', no_replace_for_regen: false,
      message_from: 0, shared_app_name: '', shared_app_id: '',
      sse_recv_event_options: { support_chunk_delta: true },
      is_ai_playground: false, is_old_user: true,
      recovery_option: { is_recovery: false, req_create_time_sec: nowSec, append_sse_event_scene: 0 },
      message_storage_type: 0, related_deleted_message_ids: {}, connector_info_list: [],
      model_config: { model_item_key: '0', model_extra_params: {}, reasoning_effort: deepThink },
      aggregate_params: { conversation_mode: '1', mode_id: '1', model_item_key: '0', agent_mode: '2', reasoning_effort: String(deepThink), provider_id: '' },
      conversation_mode: 1,
    },
    user_context: [],
    ext: {
      agent_mode: '2', use_deep_think: String(deepThink), sub_conv_firstmet_type: needCreate ? '1' : '0',
      collection_id: '', is_finish: '1',
      conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
      commerce_credit_config_enable: '0',
    },
  };
}

/** Random UUID, falling back to a manual implementation when crypto is unavailable. */
function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
function randomHex(length: number): string {
  let out = '';
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, length);
}

export type ParsedEvent = {
  /** Incremental answer text carried by this event. */
  delta: string;
  /** Set when the stream reports an error. */
  error?: { code: number; message: string; riskControl: boolean };
  /** Set once the answer is complete. */
  finished: boolean;
  conversationId?: string;
  messageId?: string;
  /** Image or media URLs found in this event's blocks or attachments. */
  mediaUrls?: string[];
};

/**
 * Read only generated outputs from the assistant's creation blocks (2074).
 * Never crawl arbitrary URLs: ACK icons, input attachment blocks (10052), and
 * creations[].gen_detail.ref_images are not results. Paths observed on the site
 * include message blocks and patch 50's JSON-encoded creation_full_content.
 */
export function extractMediaUrlsFromNode(node: any): string[] {
  const urls = new Map<string, string>();
  const decode = (value: any): any => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
  };
  const readBlocks = (blocks: any) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (block?.block_type !== 2074) continue;
      const creations = block.content?.creation_block?.creations;
      if (!Array.isArray(creations)) continue;
      for (const creation of creations) {
        if (creation?.type !== 1) continue;
        const image = creation.image;
        const url = [image?.image_ori?.url, image?.image_ori_raw?.url, image?.image_raw?.url, image?.image_thumb?.url]
          .find(value => typeof value === 'string' && /^https?:\/\//i.test(value));
        if (typeof url !== 'string') continue;
        const clean = url.replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
        // One output per creation even when later patches refresh its signature.
        const identity = image.key || creation.id || clean;
        urls.set(String(identity), clean);
      }
    }
  };
  const readContainer = (value: any) => {
    const container = decode(value);
    if (!container || typeof container !== 'object' || container.user_type === 1 || container.role === 'user') return;
    readBlocks(container.content_block);
    readBlocks(decode(container.content)?.content_block);
    const packets = decode(container.ext?.creation_full_content);
    if (Array.isArray(packets)) {
      readBlocks(packets.map(packet => packet?.BlockInfo?.BlockContent));
    }
  };
  readContainer(node);
  readContainer(node?.message);
  if (Array.isArray(node?.patch_op)) {
    for (const op of node.patch_op) {
      if (op?.patch_object === 1 || op?.patch_object === 50) readContainer(op.patch_value);
    }
  }
  return [...urls.values()];
}

/**
 * Extracts answer text from one SSE event.
 *
 * The stream carries text in two shapes, both verified against a live session:
 *   - top-level content.content_block[]   (first chunk)
 *   - patch_op[].patch_value.content_block[]  (subsequent chunks)
 * Only block_type 10000 is answer text; patch_object 50 carries suggestion chips and
 * 111 carries TTS audio, and folding either into the answer would corrupt it.
 */
export function parseEvent(event: any): ParsedEvent {
  const result: ParsedEvent = { delta: '', finished: false };
  if (!event || typeof event !== 'object') return result;

  const foundUrls = extractMediaUrlsFromNode(event);
  if (foundUrls.length) result.mediaUrls = foundUrls;

  if (!event || typeof event !== 'object') return result;

  if (event.ack_client_meta?.conversation_id) result.conversationId = event.ack_client_meta.conversation_id;
  if (event.message?.conversation_id) result.conversationId = event.message.conversation_id;
  if (event.message?.message_id) result.messageId = event.message.message_id;
  if (event.message_id) result.messageId = event.message_id;

  const readBlocks = (blocks: any): string => {
    if (!Array.isArray(blocks)) return '';
    let text = '';
    for (const block of blocks) {
      if (!block || block.block_type !== 10000) continue;
      const value = block.content?.text_block?.text;
      if (typeof value === 'string' && value) text += value;
    }
    return text;
  };

  // Most of the answer arrives as a bare {text: "..."} delta event. Missing this
  // silently truncated every reply to its first chunk (e.g. "1、" instead of the
  // full list), which is why the captured stream is asserted in the tests.
  if (typeof event.text === 'string' && event.text) result.delta += event.text;

  result.delta += readBlocks(event.content?.content_block);
  if (Array.isArray(event.patch_op)) {
    for (const op of event.patch_op) {
      // patch_object 1 = message content; 50 = suggestions; 111 = tts.
      if (op?.patch_object !== 1) continue;
      result.delta += readBlocks(op.patch_value?.content_block);
    }
  }

  // end_type: 1 = message finished, 2 = answer finished, 3 = stream finished.
  if (typeof event.end_type === 'number') result.finished = event.end_type >= 1;

  const code = Number(event.error_code ?? event.code ?? event.err_code ?? 0);
  if (code) {
    result.error = {
      code,
      message: String(event.error_msg ?? event.message ?? event.msg ?? '未知错误'),
      riskControl: RISK_ERROR_CODES.includes(code),
    };
  }
  if (event.STREAM_ERROR || event.stream_error) {
    const payload = event.STREAM_ERROR || event.stream_error;
    const errCode = Number(payload?.error_code ?? payload?.code ?? 0);
    result.error = {
      code: errCode,
      message: String(payload?.error_msg ?? payload?.message ?? '流式错误'),
      riskControl: RISK_ERROR_CODES.includes(errCode),
    };
  }
  return result;
}

/** Collects only the answer text from a list of raw events. */
export function collectAnswer(events: any[]): string {
  let text = '';
  for (const event of events) text += parseEvent(event).delta;
  return text;
}

/**
 * Waits until the account page has finished loading and can sign requests.
 *
 * A freshly warmed view starts on about:blank; calling frontierSign() or fetch()
 * before the doubao page is ready fails, which is what made the first message after a
 * cold start fail. Returns false when the page never became ready in time.
 */
export async function waitForPageReady(view: BrowserView, timeoutMs = 45_000): Promise<boolean> {
  if (view.webContents.isDestroyed()) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (view.webContents.isDestroyed()) return false;
    try {
      const ready = await view.webContents.executeJavaScript(`(() => {
        if (location.href === 'about:blank') return false;
        if (document.readyState !== 'complete') return false;
        // bdms.frontierSign is what every request needs; its absence means the app
        // bundle has not booted yet.
        return typeof window.bdms?.frontierSign === 'function';
      })()`, true) as boolean;
      if (ready) return true;
    } catch { /* page is mid-navigation; try again */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}
export type StreamChatOptions = {
  /** Called for each incremental answer chunk. */
  onDelta?: (chunk: string, full: string) => void;
  /** Overall deadline in milliseconds. */
  timeoutMs?: number;
  /** Continue an existing conversation instead of starting a new one. */
  conversationId?: string;
  botId?: string;
  deepThink?: boolean;
  /** Poll interval while draining the page-side buffer. */
  pollMs?: number;
  /** Uploaded images to send with this turn. */
  attachments?: unknown[];
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts the request inside the page and drains its SSE buffer.
 *
 * Streaming across the process boundary works by having the page push events into
 * window.__DSBUF while this side polls it. That avoids needing a preload bridge on a
 * remote origin (the page cannot reach our IPC) and still yields live deltas.
 */
export async function streamChat(view: BrowserView, text: string, options: StreamChatOptions = {}): Promise<{ answer: string; conversationId: string; messageId: string; mediaUrls: string[] }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 120;
  const prompt = text.trim();
  if (!prompt) throw new Error('提示词为空');
  if (view.webContents.isDestroyed()) throw new Error('账号页面已关闭');
  // A background view may still be booting; signing before the page is ready fails.
  if (!(await waitForPageReady(view))) throw new Error('账号页面尚未就绪，请稍后重试');

  const requestId = `ds${Date.now().toString(36)}${randomHex(6)}`;
  const payload = buildPayload(prompt, { conversationId: options.conversationId, botId: options.botId, deepThink: options.deepThink, attachments: options.attachments });

  // Collect frames pushed by the preload bridge. Delivery is immediate, so the
  // 120ms poll below is only a fallback for when that bridge is unavailable.
  const inbox: string[] = [];
  let streamDone = false;
  let streamError: string | null = null;

  const onPush = (_event: unknown, payloadFromPage: { requestId?: string; event?: string; error?: string; done?: boolean }) => {
    if (!payloadFromPage || payloadFromPage.requestId !== requestId) return;
    if (typeof payloadFromPage.event === 'string') inbox.push(payloadFromPage.event);
    if (typeof payloadFromPage.error === 'string') { streamError = payloadFromPage.error; streamDone = true; }
    if (payloadFromPage.done) streamDone = true;
  };
  ipcMain?.on?.('doubao:stream', onPush);

  let answer = '';
  let conversationId = '';
  let messageId = '';
  let finished = false;
  let failure: Error | null = null;
  const collectedMediaUrls = new Set<string>();

  const consume = (raw: string) => {
    let event: any;
    try { event = JSON.parse(raw); } catch { return; }
    const parsed = parseEvent(event);
    if (parsed.conversationId) conversationId = parsed.conversationId;
    if (parsed.messageId) messageId = parsed.messageId;
    if (parsed.error) {
      failure = parsed.error.riskControl
        ? new Error(`豆包触发人机验证（${parsed.error.code}），请在豆包窗口完成验证后重试`)
        : new Error(`豆包返回错误 ${parsed.error.code}：${parsed.error.message}`);
    }
    if (parsed.mediaUrls?.length) {
      for (const u of parsed.mediaUrls) collectedMediaUrls.add(u);
    }
    if (parsed.delta) {
      answer += parsed.delta;
      options.onDelta?.(parsed.delta, answer);
    }
    if (parsed.finished) finished = true;
  };

  const drain = async () => {
    try {
      return await view.webContents.executeJavaScript(buildDrainScript(requestId)) as { events: string[]; done: boolean; error: string | null } | null;
    } catch { return null; }
  };

  const deadline = Date.now() + timeoutMs;
  try {
    // Kick the request off inside the page; it must not be awaited here, because the
    // page-side promise only settles when the whole stream ends.
    await view.webContents.executeJavaScript(buildStartScript(requestId, payload), true);

    // Drive the loop by remaining time, not by a fixed sleep: drain() is a
    // cross-process round trip that can take hundreds of milliseconds, so sleeping a
    // fixed pollMs on top of it makes every cycle longer than pollMs and turns the
    // timeout into a wall-clock guess instead of a real deadline.
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      if (view.webContents.isDestroyed()) throw new Error('账号页面已关闭');

      if (streamDone) {
        // Take anything the fallback buffer buffered before the stream finished.
        const tail = await drain();
        if (tail?.events?.length) { for (const raw of tail.events) consume(raw); }
        while (inbox.length) consume(inbox.shift()!);
        if (failure) throw failure;
        if (tail?.error) throw new Error(tail.error);
        break;
      }

      while (inbox.length) consume(inbox.shift()!);
      if (failure) throw failure;
      if (streamError) throw new Error(streamError);

      await pause(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      const pulled = await drain();
      if (!pulled) continue;
      for (const raw of pulled.events) consume(raw);
      if (failure) throw failure;
      if (pulled.error) throw new Error(pulled.error);
      // A missing push bridge shows up as a buffer that completes on its own.
      if (pulled.done && streamDone === false) { streamDone = true; }
    }
  } finally {
    ipcMain?.removeListener?.('doubao:stream', onPush);
    await view.webContents.executeJavaScript(`(() => { try { delete window.__DSBUF?.[${JSON.stringify(requestId)}]; } catch {} return true; })()`).catch(() => undefined);
  }

  // Only a stream that actually finished may return a partial answer. Breaking out
  // on the deadline with a half-received reply would hand the caller a silently
  // truncated answer instead of a retry on another account.
  if (!finished) throw new Error('豆包响应超时');
  if (!answer && !collectedMediaUrls.size) throw new Error('豆包没有返回内容，请检查账号状态');
  return { answer, conversationId, messageId, mediaUrls: Array.from(collectedMediaUrls) };
}

/** Script that starts the fetch and streams SSE frames into window.__DSBUF[requestId]. */
export function buildStartScript(requestId: string, payload: unknown, path: string = COMPLETION_PATH): string {
  return `(() => {
    const requestId = ${JSON.stringify(requestId)};
    const requestPath = ${JSON.stringify(path)};
    const payload = ${JSON.stringify(JSON.stringify(payload))};
    // Prefer the preload push bridge (immediate delivery). Fall back to a buffer that
    // the main process polls, so the request still works if the bridge is unavailable.
    const bridge = window.__DSPUSH;
    window.__DSBUF = window.__DSBUF || {};
    const buffer = { events: [], done: false, error: null };
    window.__DSBUF[requestId] = buffer;
    const emit = (raw) => { if (bridge) { try { bridge.event(requestId, raw); return; } catch (e) { /* fall through */ } } buffer.events.push(raw); };
    const finish = () => { if (bridge) { try { bridge.done(requestId); return; } catch (e) { /* fall through */ } } buffer.done = true; };
    const fail = (message) => { if (bridge) { try { bridge.error(requestId, message); return; } catch (e) { /* fall through */ } } buffer.error = message; buffer.done = true; };
    (async () => {
      try {
        const read = (key) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
        const tea = (() => { try { return JSON.parse(read('__tea_cache_tokens_497858') || '{}').web_id || ''; } catch { return ''; } })();
        const samantha = (() => { try { return JSON.parse(read('samantha_web_web_id') || '{}').web_id || ''; } catch { return ''; } })();
        const cookie = (name) => { const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
        const params = {
          aid: '497858', real_aid: '497858',
          device_id: samantha || tea, device_platform: 'web', doubao_device_platform: 'web',
          web_platform: 'browser', fp: cookie('s_v_web_id'), language: 'zh',
          pc_version: ${JSON.stringify(PC_VERSION)}, doubao_pc_version: ${JSON.stringify(PC_VERSION)},
          pkg_type: 'release_version', region: cookie('flow_user_country') || 'CN', sys_region: cookie('flow_user_country') || 'CN',
          samantha_web: '1', tea_uuid: tea, tz_name: 'Asia/Shanghai',
          'use-olympus-account': '1', version_code: ${JSON.stringify(VERSION_CODE)}, web_id: tea,
          msToken: cookie('msToken'), web_tab_id: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
        };
        const query = Object.keys(params).sort()
          .filter((k) => params[k] !== '' && params[k] != null)
          .map((k) => k + '=' + encodeURIComponent(params[k])).join('&');
        let bogus = '';
        try {
          const signed = await window.bdms.frontierSign(query);
          bogus = (signed && (signed['X-Bogus'] || signed.a_bogus)) || (typeof signed === 'string' ? signed : '');
        } catch (e) { fail('生成签名失败：' + (e && e.message || e)); return; }
        if (!bogus) { fail('页面未返回可用签名，请刷新账号页面后重试'); return; }

        const headers = { 'Content-Type': 'application/json', 'agw-js-conv': 'str' };
        const csrf = cookie('passport_csrf_token');
        if (csrf) headers['x-tt-passport-csrf-token'] = csrf;

        const res = await fetch(requestPath + '?' + query + '&X-Bogus=' + encodeURIComponent(bogus), {
          method: 'POST', headers, body: payload, credentials: 'include',
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          fail('HTTP ' + res.status + '：' + String(detail).slice(0, 300));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split('\\n');
          pending = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const body = trimmed.slice(5).trim();
            if (!body || body === '{}') continue;
            emit(body);
          }
        }
        if (pending.trim().startsWith('data:')) {
          const tail = pending.trim().slice(5).trim();
          if (tail && tail !== '{}') emit(tail);
        }
        finish();
      } catch (e) {
        fail(String(e && e.message || e));
      }
    })();
    return true;
  })()`;
}

/** Script that drains buffered SSE frames for one request. */
export function buildDrainScript(requestId: string): string {
  return `(() => {
    const buffer = window.__DSBUF && window.__DSBUF[${JSON.stringify(requestId)}];
    if (!buffer) return null;
    const events = buffer.events.splice(0, buffer.events.length);
    return { events, done: Boolean(buffer.done), error: buffer.error || null };
  })()`;
}

export const DOUBAO_URLS = { chat: DOUBAO_CHAT_URL, completion: COMPLETION_PATH };
