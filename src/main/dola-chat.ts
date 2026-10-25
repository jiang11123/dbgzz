import type { BrowserView } from 'electron';
import { randomUUID } from 'node:crypto';
import type { StreamChatOptions } from './doubao-api';
import { prepareText, clickComposerSend } from './page-composer';
import { collectPageReplies, createPageReplyBaseline, pageReplySnapshotScript, type PageReplySnapshot } from './page-replies';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Observe only this composer submission. The site owns signing, payloads and authentication. */
export function observeDolaSubmission(id: string, prompt: string): string {
  return `(() => {
    if (window.__dolaSubmission) throw new Error('Dola 上一个请求尚未结束，请打开账号页确认');
    const original = window.fetch;
    const state = { id: ${JSON.stringify(id)}, prompt: ${JSON.stringify(prompt)}, started: false, done: false, error: '', restore: null };
    const wrapper = async function(input, init) {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      const completion = /\\/chat\\/(completion|async\\/chunk_stream)(?:[?]|$)/.test(url);
      const body = typeof init?.body === 'string' ? init.body : completion && input?.clone ? await input.clone().text() : '';
      const matches = completion
        && body.includes(JSON.stringify(state.prompt).slice(1, -1)) && !state.started;
      if (!matches) return original.apply(this, arguments);
      state.started = true;
      try {
        const response = await original.apply(this, arguments);
        if (!response.ok) { state.error = 'Dola 请求失败（HTTP ' + response.status + '）'; state.done = true; state.restore(); return response; }
        const copy = response.clone();
        (async () => {
          try {
            if (!/text\\/event-stream/i.test(copy.headers.get('content-type') || '')) {
              state.error = 'Dola 未返回聊天流，请在账号页检查登录或验证状态';
            } else {
              const reader = copy.body.getReader();
              const decoder = new TextDecoder();
              let pending = '', terminal = false;
              const consume = line => {
                if (!line.startsWith('data:')) return;
                const data = line.slice(5).trim();
                if (data === '[DONE]') { terminal = true; return; }
                try {
                  const event = JSON.parse(data);
                  if (Number(event.end_type) >= 2) terminal = true;
                  const code = Number(event.error_code || event.code || event.err_code || 0);
                  if (code) state.error = 'Dola 返回错误 ' + code + '，请在账号页查看详情';
                } catch {}
              };
              while (true) {
                const chunk = await reader.read();
                pending += decoder.decode(chunk.value, {stream:!chunk.done});
                const lines = pending.split('\\n'); pending = lines.pop() || '';
                for (const line of lines) consume(line.trim());
                if (chunk.done) { if (pending) consume(pending.trim()); break; }
              }
              if (!terminal && !state.error) state.error = 'Dola 回复未完整结束，请先查看账号页，避免重复发送';
            }
          } catch { state.error = 'Dola 回复连接中断，请先查看账号页，避免重复发送'; }
          finally { state.done = true; state.restore(); }
        })();
        return response;
      } catch (error) { state.error = 'Dola 发送失败：' + String(error); state.done = true; state.restore(); throw error; }
    };
    state.restore = () => { if (window.fetch === wrapper) window.fetch = original; if (window.__dolaSubmission === state) delete window.__dolaSubmission; };
    window.__dolaSubmission = state;
    window.fetch = wrapper;
    window.__dolaResults = window.__dolaResults || {};
    window.__dolaResults[state.id] = state;
    return true;
  })()`;
}

export const dolaPageStateScript = `(() => {
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; };
  const input=[...document.querySelectorAll('textarea,[contenteditable=true],[role=textbox]')].find(e=>visible(e)&&!e.disabled);
  const url=location.href;
  const text=document.body?.innerText || '';
  const region=/region-restricted/.test(url);
  const wrongSite=!['https://www.dola.com','https://dola.com'].includes(location.origin);
  const login=[...document.querySelectorAll('[role=dialog]')].some(e=>visible(e)&&/log in|sign in|登录/i.test(e.innerText));
  const sending=[...document.querySelectorAll('[data-testid=chat_input_local_break_button],[data-testid=chat_input_break_button]')].some(visible);
  return {url,region,login,sending,hasInput:!!input,draft:input?(input.value??input.innerText??'').trim():'',
    blocked:region?'Dola 当前网络所在地区不可用，请在账号页确认网络':wrongSite && url!=='about:blank'?'Dola 页面已离开本站，请先完成登录或重新打开账号':login?'请先在 Dola 账号页面完成登录':/captcha|security verification|人机验证/i.test(text)&&!input?'Dola 需要人工验证，请打开账号页完成验证':''};
})()`;

export async function waitForDolaPage(view: BrowserView, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (view.webContents.isDestroyed()) throw new Error('Dola 账号页面已关闭');
    const state = await view.webContents.executeJavaScript(dolaPageStateScript).catch(() => null);
    if (state?.blocked) throw new Error(state.blocked);
    if (state?.hasInput && !view.webContents.isLoading()) return;
    await pause(250);
  }
  throw new Error('Dola 输入框未就绪，请打开账号页检查地区限制、登录和验证状态');
}

/** Never navigate away from an unfinished generation or an unsent user draft. */
export async function prepareDolaConversation(view: BrowserView, conversationId?: string): Promise<void> {
  await waitForDolaPage(view);
  const state = await view.webContents.executeJavaScript(dolaPageStateScript);
  if (state.sending) throw new Error('Dola 正在生成回复，请等待账号页完成后再发送');
  if (state.draft) throw new Error('Dola 账号页有未发送草稿，请先处理草稿再发送');
  const target = `https://www.dola.com/chat/${conversationId ? encodeURIComponent(conversationId) : ''}`;
  if (!conversationId || view.webContents.getURL().replace(/\/$/, '') !== target) {
    await view.webContents.loadURL(target).catch(() => undefined);
    await waitForDolaPage(view);
  }
}

export async function streamDolaChat(view: BrowserView, prompt: string, options: StreamChatOptions = {}) {
  if (options.deepThink) throw new Error('Dola 深度思考设置尚未接入，请在账号页面选择');
  if (options.attachments?.length) throw new Error('Dola 附件尚未接入，请在账号页发送附件');
  await waitForDolaPage(view);
  const state = await view.webContents.executeJavaScript(dolaPageStateScript);
  if (state.sending) throw new Error('Dola 正在生成回复，请等待账号页完成后再发送');
  if (state.draft) throw new Error('Dola 账号页有未发送草稿，请先处理草稿再发送');
  const initial = await view.webContents.executeJavaScript(pageReplySnapshotScript) as PageReplySnapshot;
  let baseline = createPageReplyBaseline(initial, { prompt });
  const id = randomUUID();
  await view.webContents.executeJavaScript(observeDolaSubmission(id, prompt));
  let answer = '';
  let finishedAt = 0;
  try {
    await prepareText(view, prompt);
    view.webContents.send('account-send:bypass', true);
    try { await clickComposerSend(view, prompt); }
    finally { if (!view.webContents.isDestroyed()) view.webContents.send('account-send:bypass', false); }
    const deadline = Date.now() + (options.timeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      if (view.webContents.isDestroyed()) throw new Error('Dola 账号页面已关闭');
      const progress = await view.webContents.executeJavaScript(`(() => { const s=window.__dolaResults?.[${JSON.stringify(id)}]; return s?{started:s.started,done:s.done,error:s.error}:null; })()`);
      const page = await view.webContents.executeJavaScript(dolaPageStateScript);
      if (page.blocked) throw new Error(page.blocked);
      if (progress?.error) throw new Error(progress.error);
      if (progress?.done && !finishedAt) finishedAt = Date.now();
      const snapshot = await view.webContents.executeJavaScript(pageReplySnapshotScript) as PageReplySnapshot;
      const collected = collectPageReplies(baseline, snapshot);
      baseline = collected.baseline;
      if (collected.latestText && collected.latestText !== answer) {
        const next = collected.latestText;
        options.onDelta?.(next.startsWith(answer) ? next.slice(answer.length) : next, next);
        answer = next;
      }
      if (progress?.done && answer && !page.sending) {
        const match = new URL(snapshot.url).pathname.match(/^\/chat\/([^/]+)\/?$/);
        return { answer, conversationId: match ? decodeURIComponent(match[1]) : options.conversationId || '', messageId: '', mediaUrls: [] as string[] };
      }
      if (finishedAt && Date.now() - finishedAt > 5000 && !answer) throw new Error('Dola 请求已结束但未取得新回复，请打开账号页检查登录、验证或站点错误');
      if (!progress?.started && Date.now() > deadline - (options.timeoutMs ?? 180_000) + 15_000) {
        throw new Error('未确认 Dola 请求已发送，请查看账号页；为避免重复发送，本次不会自动重试');
      }
      await pause(options.pollMs ?? 250);
    }
    throw new Error('Dola 回复超时，请先查看账号页确认结果，避免重复发送');
  } finally {
    if (!view.webContents.isDestroyed()) await view.webContents.executeJavaScript(`(() => {
      const s=window.__dolaResults?.[${JSON.stringify(id)}];
      if (s && (!s.started || s.done)) { s.restore(); delete window.__dolaResults[${JSON.stringify(id)}]; }
      return true;
    })()`).catch(() => undefined);
  }
}
