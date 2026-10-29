// Bound SSE inactivity on real text/tool progress, without aborting the official
// agent's signal or adding a retry loop.
//
// 为什么不改用 pi 自己的空闲超时（钉选 1.2.0）：
// - pi-ai 把 timeoutMs 交给 OpenAI SDK 的 `timeout`（pi-ai/dist/api/openai-completions.js:194），
//   而 SDK 在 fetch 解析出响应头后立刻 clearTimeout（openai/client.js:996 setTimeout、
//   :1023 finally clearTimeout）——只覆盖到响应头，不约束流正文的空闲。
// - pi-coding-agent 另有 undici bodyTimeout/headersTimeout 级别的 httpIdleTimeoutMs
//   （dist/core/http-dispatcher.js:77-81，docs/settings.md:125），但它只在 CLI/RPC 入口安装
//   （cli/setup.js、rpc-entry.js、modes/interactive/interactive-mode.js:1562），本宿主的
//   Durable 路径不会安装它；即便安装，undici bodyTimeout 按「每收到一段 body 就重置」，
//   SSE 心跳（`: ping`）同样算一段，识别不出「只有心跳、没有内容」。
// 因此保留本实现：只有实际文本/工具进展才重置计时（Durable 路径经 globalThis.fetch 包装生效）。
export const DEFAULT_MODEL_STREAM_IDLE_MS = 95000;

function protocolFor(input, options) {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if ((options.method || input.method || 'GET').toUpperCase() !== 'POST') return null;
    if (typeof options.body !== 'string') return null;
    const body = JSON.parse(options.body);
    if (body.stream !== true) return null;
    if (/\/chat\/completions\/?$/.test(url.pathname) && Array.isArray(body.messages)) return 'completions';
    if (/\/responses\/?$/.test(url.pathname) && body.input !== undefined) return 'responses';
    if (/\/messages\/?$/.test(url.pathname) && Array.isArray(body.messages)) return 'anthropic';
  } catch { /* Unknown request formats retain their provider's behavior. */ }
  return null;
}
const text = value => typeof value === 'string' && value.length > 0;
function meaningful(protocol, data) {
  if (data === '[DONE]') return true;
  let event; try { event = JSON.parse(data); } catch { return false; }
  if (!event || typeof event !== 'object') return false;
  if (protocol === 'completions') return (Array.isArray(event.choices) ? event.choices : []).some(choice => {
    if (!choice || typeof choice !== 'object') return false;
    const delta = choice.delta || {};
    return !!choice.finish_reason || text(delta.content) || text(delta.reasoning_content) || text(delta.reasoning) || text(delta.reasoning_text) ||
      (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).some(tool => tool && (text(tool.id) || text(tool.function?.name) || text(tool.function?.arguments)));
  });
  if (protocol === 'responses') {
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) return true;
    if (['response.output_text.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta', 'response.custom_tool_call_input.delta'].includes(event.type)) return text(event.delta);
    if (event.type === 'response.function_call_arguments.done') return text(event.arguments);
    if (event.type === 'response.custom_tool_call_input.done') return text(event.input);
    if (event.type === 'response.output_item.done' && event.item?.type === 'message') return (Array.isArray(event.item.content) ? event.item.content : []).some(part => part && (text(part.text) || text(part.refusal)));
    return event.type === 'response.output_item.added' && ['function_call', 'custom_tool_call'].includes(event.item?.type) && (text(event.item.name) || text(event.item.call_id));
  }
  if (event.type === 'message_stop') return true;
  if (event.type === 'message_delta') return !!event.delta?.stop_reason;
  if (event.type === 'content_block_start') return text(event.content_block?.text) || text(event.content_block?.thinking) || text(event.content_block?.data) ||
    (event.content_block?.type === 'tool_use' && (text(event.content_block.name) || text(event.content_block.id)));
  if (event.type !== 'content_block_delta') return false;
  // Thinking text and its closing signature are model progress, as text is.
  return text(event.delta?.text) || text(event.delta?.thinking) || text(event.delta?.signature) || text(event.delta?.partial_json);
}

// Observe complete SSE records, forwarding the original bytes unchanged. A
// malformed or oversized record cannot keep the stream alive indefinitely.
function observer(protocol, progress) {
  const decoder = new TextDecoder(); let line = '', data = [], bytes = 0, oversized = false, previousCR = false;
  const finishLine = () => {
    if (line === '') {
      if (!oversized && meaningful(protocol, data.join('\n'))) progress();
      data = []; bytes = 0; oversized = false;
    } else if (!oversized && line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    line = '';
  };
  return chunk => {
    for (const char of decoder.decode(chunk, {stream: true})) {
      if (char === '\n' && previousCR) { previousCR = false; continue; }
      previousCR = char === '\r';
      if (char === '\r' || char === '\n') { finishLine(); continue; }
      if (++bytes > 1024 * 1024) { oversized = true; data = []; line = ''; }
      else if (!oversized) line += char;
    }
  };
}

export async function fetchModelWithProgressIdle(input, options = {}, {fetch: transport = globalThis.fetch, timeoutMs = DEFAULT_MODEL_STREAM_IDLE_MS} = {}) {
  const protocol = protocolFor(input, options);
  if (!protocol) return transport(input, options);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid model stream idle timeout');
  const local = new AbortController();
  const signals = [options.signal, input instanceof Request ? input.signal : null].filter(Boolean);
  const caller = signals.length ? AbortSignal.any(signals) : null;
  const response = await transport(input, {...options, signal: caller ? AbortSignal.any([caller, local.signal]) : local.signal});
  if (!response.ok || !response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) return response;
  const reader = response.body.getReader(); let timer, finished = false, controller;
  const cleanup = () => { clearTimeout(timer); caller?.removeEventListener('abort', onAbort); };
  const terminate = error => {
    if (finished) return;
    finished = true; cleanup(); controller.error(error);
    local.abort(error); void reader.cancel(error).catch(() => {});
  };
  const onAbort = () => terminate(caller.reason || new DOMException('Aborted', 'AbortError'));
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => terminate(new Error(`Model stream idle timeout: no text or tool progress for ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
  };
  const observe = observer(protocol, arm);
  const body = new ReadableStream({
    start(value) { controller = value; caller?.addEventListener('abort', onAbort, {once: true}); if (caller?.aborted) onAbort(); else arm(); },
    async pull() {
      try {
        const next = await reader.read(); if (finished) return;
        if (next.done) { finished = true; cleanup(); controller.close(); return; }
        observe(next.value); controller.enqueue(next.value);
      } catch (error) { terminate(error); }
    },
    cancel(reason) { if (finished) return; finished = true; cleanup(); const cancelled = reader.cancel(reason).catch(() => {}); local.abort(reason); return cancelled; },
  });
  return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
}
