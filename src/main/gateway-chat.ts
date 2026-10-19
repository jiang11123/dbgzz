/**
 * Gateway-mode chat service.
 *
 * Bridges the renderer's chat UI to the Doubao HTTP API, and — critically — keeps
 * multi-turn context working. Each thread stores the Doubao conversation id returned
 * by the first request; later turns send it back, so the model sees the earlier
 * exchange without the renderer having to replay history.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { GatewayAttachment, GatewayMessage, GatewayThread, StagedAttachment } from '../shared/types';
import { streamChat } from './doubao-api';

export type GatewayChatRuntime = {
  /** Generates images for a prompt and returns them as locally stored attachments. */
  generateImages?: (prompt: string, options: { model?: string; ratio?: string; accountId?: number | null; attachments?: { path: string; name: string; mimeType: string }[] }) => Promise<GatewayAttachment[]>;
  /** Generates a video and resolves with a locally stored attachment once the file is on disk. */
  generateVideos?: (prompt: string, options: { model?: string; ratio?: string; duration?: number; accountId?: number | null; replyMessageId?: number; referencePaths?: string[] }) => Promise<GatewayAttachment[]>;
  /** Opens or reuses the account page used to issue the request. */
  viewForAccount: (accountId: number) => unknown | null;
  /** Picks a logged-in account when the thread has none bound yet. */
  pickAccount: () => { id: number } | null;
  markAccountOk: (accountId: number) => void;
  markAccountFailure: (accountId: number, message: string) => void;
  /** Uploads local image files to Doubao and returns attachment descriptors. */
  uploadImages?: (accountId: number, paths: string[], names: string[]) => Promise<unknown[]>;
  /** Account that produced the most recent image, for labelling the reply. */
  lastImageAccountId?: () => number | null;
  /** Account that produced the most recent video, for labelling the reply. */
  lastVideoAccountId?: () => number | null;
  /** Resolves a generated media URL into a stored asset, returning its file URL. */
  saveRemoteMedia?: (url: string, kind: 'image' | 'video') => Promise<GatewayAttachment | null>;
};

export type ThreadStore = {
  gatewayThreads(): GatewayThread[];
  gatewayThread(id: string): GatewayThread | null;
  gatewayMessages(threadId: string): GatewayMessage[];
  createGatewayThread(thread: { id: string; title?: string; model?: string; accountId?: number | null }): GatewayThread;
  updateGatewayThread(id: string, patch: Partial<Pick<GatewayThread, 'title' | 'doubaoConversationId' | 'accountId' | 'model'>>): GatewayThread;
  deleteGatewayThread(id: string): GatewayThread[];
  appendGatewayMessage(message: { threadId: string; role: GatewayMessage['role']; content: string; attachments?: GatewayAttachment[]; status?: GatewayMessage['status']; error?: string }): number;
  updateGatewayMessage(id: number, patch: { content?: string; status?: GatewayMessage['status']; error?: string; attachments?: GatewayAttachment[]; accountId?: number | null }): void;
};

/** Turns the first user line into a short thread title. */
export function titleFromPrompt(prompt: string, limit = 24): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (!flat) return '新对话';
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function createGatewayChat(store: ThreadStore, runtime: GatewayChatRuntime) {
  const inFlight = new Map<string, true>();
  // Throttle state for the streaming snapshot written back to the database.
  let lastPersistedLength = 0;
  let lastPersistAt = 0;

  const ensureThread = (threadId?: string, model?: string) => {
    if (threadId) {
      const existing = store.gatewayThread(threadId);
      if (existing) return existing;
    }
    return store.createGatewayThread({ id: `t${randomUUID().replace(/-/g, '').slice(0, 16)}`, model });
  };

  /**
   * Image generation as a chat turn.
   *
   * Reuses the thread machinery so generated images live in the same transcript as
   * text turns, with their own messages.
   */
  const generateImages = async (request: { threadId?: string; prompt: string; model?: string; ratio?: string; accountId?: number | null; attachments?: StagedAttachment[] & { path?: string }[] }) => {
    const prompt = String(request.prompt ?? '').trim();
    if (!prompt) throw new Error('提示词为空');
    if (!runtime.generateImages) throw new Error('当前版本未启用图片生成');

    let thread = ensureThread(request.threadId);
    if (!thread.title || thread.title === '新对话') thread = store.updateGatewayThread(thread.id, { title: titleFromPrompt(prompt) });

    if (inFlight.has(thread.id)) throw new Error('该会话正在生成中，请等待完成');
    inFlight.set(thread.id, true);
    const userAttachments = (request.attachments ?? []).map(item => ({ id: 'staged-' + randomUUID(), kind: 'image' as const, url: item.url ?? ((item as any).path ? pathToFileURL((item as any).path).toString() : ''), name: item.name, path: (item as any).path }));
    const image = store.appendGatewayMessage({ threadId: thread.id, role: 'user', content: prompt, attachments: userAttachments });
    const replyId = store.appendGatewayMessage({ threadId: thread.id, role: 'assistant', content: '', status: 'streaming' });
    try {
      const attachments = await runtime.generateImages(prompt, { model: request.model, ratio: request.ratio, accountId: request.accountId, attachments: (request.attachments ?? []).flatMap(item => (item as any).path ? [{ path: (item as any).path, name: item.name, mimeType: item.mimeType }] : []) });
      const imageAccount = runtime.lastImageAccountId?.() ?? null;
      if (imageAccount != null) store.updateGatewayMessage(replyId, { accountId: imageAccount });
      store.updateGatewayMessage(replyId, { content: '已生成图片', status: 'done', attachments });
      return {
        thread: store.gatewayThread(thread.id)!,
        userMessage: store.gatewayMessages(thread.id).find(m => m.id === image)!,
        assistantMessage: store.gatewayMessages(thread.id).find(m => m.id === replyId)!,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.updateGatewayMessage(replyId, { status: 'failed', error: message });
      throw error;
    } finally {
      inFlight.delete(thread.id);
    }
  };

  /**
   * Video generation as a chat turn.
   *
   * Video cannot be requested through the chat API (the model answers "无法直接生成视频"),
   * so the runtime drives the Doubao workspace DOM via the canvas bridge. That takes
   * minutes, so the reply message stays in `streaming` while the bridge works and the
   * caller awaits the final result like any other turn.
   */
  const generateVideos = async (request: { threadId?: string; prompt: string; model?: string; ratio?: string; duration?: number; accountId?: number | null; referencePaths?: string[]; attachments?: StagedAttachment[] & { path?: string }[] }) => {
    const prompt = String(request.prompt ?? '').trim();
    if (!prompt) throw new Error('提示词为空');
    if (!runtime.generateVideos) throw new Error('当前版本未启用视频生成');

    let thread = ensureThread(request.threadId);
    if (!thread.title || thread.title === '新对话') thread = store.updateGatewayThread(thread.id, { title: titleFromPrompt(prompt) });

    if (inFlight.has(thread.id)) throw new Error('该会话正在生成中，请等待完成');
    inFlight.set(thread.id, true);
    const userAttachments = (request.attachments ?? []).map(item => ({ id: 'staged-' + randomUUID(), kind: 'image' as const, url: item.url ?? ((item as any).path ? pathToFileURL((item as any).path).toString() : ''), name: item.name, path: (item as any).path }));
    const userMessage = store.appendGatewayMessage({ threadId: thread.id, role: 'user', content: prompt, attachments: userAttachments });
    const replyId = store.appendGatewayMessage({ threadId: thread.id, role: 'assistant', content: '视频生成中，通常需要 1-5 分钟…', status: 'streaming' });
    try {
      const attachments = await runtime.generateVideos(prompt, { model: request.model, ratio: request.ratio, duration: request.duration, accountId: request.accountId, replyMessageId: replyId, referencePaths: (request.attachments ?? []).flatMap(item => (item as any).path ? [(item as any).path] : []) });
      const videoAccount = runtime.lastVideoAccountId?.() ?? null;
      if (videoAccount != null) store.updateGatewayMessage(replyId, { accountId: videoAccount });
      const currentMsg = store.gatewayMessages(thread.id).find(m => m.id === replyId);
      const content = currentMsg?.content && currentMsg.content !== '视频生成中，通常需要 1-5 分钟…'
        ? `${currentMsg.content}\n\n【视频生成完成】`
        : '已生成视频';
      store.updateGatewayMessage(replyId, { content, status: 'done', attachments });
      return {
        thread: store.gatewayThread(thread.id)!,
        userMessage: store.gatewayMessages(thread.id).find(m => m.id === userMessage)!,
        assistantMessage: store.gatewayMessages(thread.id).find(m => m.id === replyId)!,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.updateGatewayMessage(replyId, { status: 'failed', error: message });
      throw error;
    } finally {
      inFlight.delete(thread.id);
    }
  };

  const send = async (
    request: { threadId?: string; prompt: string; model?: string; deepThink?: boolean; accountId?: number | null; imageAssets?: { path: string; name: string }[]; onDelta?: (chunk: string, full: string) => void },
  ): Promise<{ thread: GatewayThread; userMessage: GatewayMessage; assistantMessage: GatewayMessage }> => {
    const prompt = String(request.prompt ?? '').trim();
    if (!prompt) throw new Error('提示词为空');

    let thread = ensureThread(request.threadId, request.model);
    if (!thread.title || thread.title === '新对话') thread = store.updateGatewayThread(thread.id, { title: titleFromPrompt(prompt) });
    if (request.model && request.model !== thread.model) thread = store.updateGatewayThread(thread.id, { model: request.model });

    if (inFlight.has(thread.id)) throw new Error('该会话正在生成中，请等待完成');
    inFlight.set(thread.id, true);

    // Echo the staged images back on the user's own bubble, so the sent attachments
    // are visible in the transcript (the model already receives them separately).
    const userAttachments: GatewayAttachment[] = (request.imageAssets ?? []).flatMap(item => {
      try { return [{ id: 'staged-' + randomUUID(), kind: 'image' as const, url: pathToFileURL(item.path).toString(), name: item.name, path: item.path }]; }
      catch { return []; }
    });
    const userId = store.appendGatewayMessage({ threadId: thread.id, role: 'user', content: prompt, attachments: userAttachments });
    const assistantId = store.appendGatewayMessage({ threadId: thread.id, role: 'assistant', content: '', status: 'streaming' });

    // Declared outside the try so the catch can tell a real account failure from a
    // local one (empty prompt, unavailable page) and only cool down the former.
    let lastChatError: Error | null = null;
    let result: Awaited<ReturnType<typeof streamChat>> | null = null;
    let answeredBy: number | null = null;
    try {
      for (let attempt = 0; attempt < 3 && !result; attempt += 1) {
        // An explicit account wins (指定账号); otherwise keep the thread's account so a
        // conversation stays with one identity, and fall back to the pool (随机账号).
        const pinned = request.accountId ?? thread.accountId ?? null;
        const accountId = pinned ?? runtime.pickAccount()?.id ?? null;
        if (!accountId) throw new Error('没有可用的豆包账号，请先在设置里添加并登录账号');
        const view = runtime.viewForAccount(accountId) as any;
        if (!view?.webContents || view.webContents.isDestroyed()) throw new Error('账号页面不可用，请在设置里打开该账号确认已登录');
        try {
          // Images must be uploaded on THIS account's page before the turn is sent.
          const attachments = request.imageAssets?.length && runtime.uploadImages
            ? await runtime.uploadImages(accountId, request.imageAssets.map(a => a.path), request.imageAssets.map(a => a.name))
            : [];
          result = await streamChat(view, prompt, {
            // A doubao conversation id is owned by the account that created it. Reusing it
            // from another account makes doubao reject the turn with 710018001 (跨分会话),
            // so only continue the thread when the account still matches.
            conversationId: thread.accountId === accountId ? (thread.doubaoConversationId || undefined) : undefined,
            deepThink: request.deepThink,
            attachments,
            onDelta: (chunk, full) => {
              // The renderer gets every chunk live; SQLite only needs a recent snapshot so a
              // crash mid-answer does not lose the whole reply. Writing once per delta
              // meant hundreds of synchronous writes per answer and stalled the UI.
              if (full.length - lastPersistedLength >= 400 || Date.now() - lastPersistAt >= 200) {
                lastPersistedLength = full.length; lastPersistAt = Date.now();
                store.updateGatewayMessage(assistantId, { content: full, status: 'streaming' });
              }
              request.onDelta?.(chunk, full);
            },
          });
          runtime.markAccountOk?.(accountId);
          answeredBy = accountId;
        } catch (error) {
          const detail = error instanceof Error ? error : new Error(String(error));
          lastChatError = detail;
          if (!/710022004|710022002|人机验证|安全验证|访问频繁|稍后重试/.test(detail.message)) throw detail;
          runtime.markAccountFailure?.(accountId, detail.message);
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      }
      if (!result) throw lastChatError ?? new Error('豆包没有返回内容，请稍后重试');
      // Stamp the account on the reply right away, so the chat can label it 账号N 回复
      // while the text is still streaming.
      if (answeredBy != null) store.updateGatewayMessage(assistantId, { accountId: answeredBy });
      const attachments: GatewayAttachment[] = [];
      if (runtime.saveRemoteMedia) {
        const candidateUrls = new Set<string>([
          ...extractMediaUrls(result.answer),
          ...(result.mediaUrls ?? []),
        ]);
        for (const url of candidateUrls) {
          try {
            const saved = await runtime.saveRemoteMedia(url, /[.](mp4|mov|webm)/i.test(url) ? 'video' : 'image');
            if (saved) attachments.push(saved);
          } catch { /* keep the text answer even when saving fails */ }
        }
      }

      store.updateGatewayMessage(assistantId, { content: result.answer, status: 'done', attachments });
      if (answeredBy != null) runtime.markAccountOk(answeredBy);
      const updated = thread.doubaoConversationId || !result.conversationId
        ? thread
        : store.updateGatewayThread(thread.id, { doubaoConversationId: result.conversationId, accountId: answeredBy ?? undefined });
      // Remember which account owns this conversation so later turns stay with it.
      if (answeredBy != null) thread = store.updateGatewayThread(thread.id, { accountId: answeredBy });

      return {
        thread: store.gatewayThread(thread.id)!,
        userMessage: store.gatewayMessages(thread.id).find(m => m.id === userId)!,
        assistantMessage: store.gatewayMessages(thread.id).find(m => m.id === assistantId)!,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.updateGatewayMessage(assistantId, { status: 'failed', error: message });
      // Only a real account failure belongs on the pool; a local error (empty prompt,
      // missing account) must not cool down a healthy account. answeredBy is null
      // unless an account actually attempted this turn.
      if (answeredBy != null) runtime.markAccountFailure(answeredBy, message);
      throw error;
    } finally {
      inFlight.delete(thread.id);
    }
  };

  return {
    threads: () => store.gatewayThreads(),
    messages: (threadId: string) => store.gatewayMessages(threadId),
    createThread: (model?: string) => store.createGatewayThread({ id: `t${randomUUID().replace(/-/g, '').slice(0, 16)}`, model }),
    renameThread: (id: string, title: string) => store.updateGatewayThread(id, { title: title.slice(0, 60) || '新对话' }),
    deleteThread: (id: string) => store.deleteGatewayThread(id),
    send,
    generateImages,
    generateVideos,
    isBusy: (threadId: string) => inFlight.has(threadId),
    updateMessage: (id: number, patch: Partial<GatewayMessage>) => store.updateGatewayMessage(id, patch),
    /** Attaches a finished video to a chat message that timed out waiting for it. */
    deliverLateVideo: (messageId: number, attachment: GatewayAttachment) => {
      store.updateGatewayMessage(messageId, {
        status: 'done',
        error: undefined,
        content: '视频已生成（后台完成）',
        attachments: [attachment],
      });
    },
  };
}

/** Pulls generated media URLs out of an answer so they can be saved as assets. */
export function extractMediaUrls(text: string): string[] {
  const found = new Set<string>();
  for (const match of String(text).matchAll(/https?:\/\/[^\s)"']+/g)) {
    const url = match[0].replace(/[.,;。]+$/, '');
    if (/(byteimg|imagex|tos-cn|\.png|\.jpe?g|\.webp|\.mp4|\.mov|\.webm)/i.test(url)) found.add(url);
  }
  return [...found];
}
