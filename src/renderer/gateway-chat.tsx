import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Camera, Download, FolderOpen, Image as ImageIcon, Loader2, Plus, Send, Settings, Sparkles, Trash2, Video } from 'lucide-react';
import type { GatewayAttachment, GatewayMessage, GatewayThread, StagedAttachment } from '../shared/types';
import { renderMarkdown } from './markdown';
import { VideoModelPicker } from './video-model-picker';

type Mode = 'gateway' | 'account';

/** The only renderer -> IPC attachment conversion used by every composer mode. */
export function toIpcAttachments(items: { id: string; assetId?: string; name: string; mimeType?: string; url?: string }[]): StagedAttachment[] {
  return items.map(item => ({
    id: item.id,
    assetId: item.assetId ?? item.id,
    name: item.name,
    mimeType: item.mimeType ?? mimeTypeForName(item.name),
    url: item.url,
  }));
}

function mimeTypeForName(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const known: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  return known[ext] ?? 'application/octet-stream';
}

/** Converts a persisted generated image back into the renderer attachment contract. */
export function toStagedGeneratedImage(item: GatewayAttachment, asset: { id: string; name: string; url: string }): StagedAttachment {
  return { id: item.id, assetId: asset.id, name: asset.name, mimeType: mimeTypeForName(asset.name), url: asset.url };
}

/** Computes the target seek time for extracting the last frame without landing on black/EOF. */
export function calculateLastFrameTime(duration: number, offset = 0.05): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, duration - offset);
}

/** Extracts the final video frame as a high quality PNG data URL via off-screen HTML5 video and canvas. */
export async function extractVideoLastFrame(videoUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('截取视频最后一帧超时，请重试'));
    }, 20000);

    const cleanup = () => {
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      video.src = '';
      video.load();
    };

    video.onloadedmetadata = () => {
      const targetTime = calculateLastFrameTime(video.duration);
      video.currentTime = targetTime;
    };

    video.onseeked = () => {
      if (settled) return;
      settled = true;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cleanup();
          return reject(new Error('无法创建画布进行截帧'));
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png', 1.0);
        cleanup();
        resolve(dataUrl);
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    video.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('视频加载失败，无法提取尾帧'));
    };

    video.src = videoUrl;
  });
}

/** Unscoped deltas must never leak into whichever thread happens to be open. */
export function threadDelta(activeId: string | null, payload: { threadId?: string; full: string }): string | null {
  return activeId && payload.threadId === activeId ? payload.full : null;
}

/** A turn only blocks its own thread; other threads stay sendable and the bridge queues them. */
export function composerAction(prompt: string, threadBusy: boolean, forwarding = false): 'send' | 'continue' | 'none' {
  if (!prompt.trim() || forwarding) return 'none';
  return threadBusy ? 'continue' : 'send';
}

/** Preserve visible local feedback until its newly persisted user row arrives. */
export function reconcileMessages(current: GatewayMessage[], saved: GatewayMessage[]): GatewayMessage[] {
  const known = new Set(current.filter(message => message.id >= 0).map(message => message.id));
  const echoed = saved.filter(message => message.role === 'user' && !known.has(message.id));
  const local = current.filter(message => message.id < 0).filter(message => {
    const index = echoed.findIndex(row => row.threadId === message.threadId && row.content === message.content);
    if (index < 0) return true;
    echoed.splice(index, 1);
    return false;
  });
  return [...saved, ...local];
}

/** Activation happens before invoking any long-running turn IPC. */
export async function ensureChatThread(activeId: string | null, create: () => Promise<GatewayThread>, activate: (thread: GatewayThread) => void): Promise<string> {
  if (activeId) return activeId;
  const thread = await create();
  activate(thread);
  return thread.id;
}

/**
 * Gateway mode: a chat window backed by the Doubao account pool.
 *
 * Unlike account mode (which shows the real site), this drives the accounts off-screen
 * and renders the conversation locally, so generated images and videos can be shown
 * inline and the thread keeps its context across turns.
 */
export function GatewayChat({ mode, onModeChange, stagedImages = [], onStagedChange }: {
  mode: Mode;
  onModeChange: (next: Mode) => void;
  /** Images staged by the quick-preview bar, sent with the next message. */
  stagedImages?: StagedAttachment[];
  onStagedChange?: (next: StagedAttachment[]) => void;
}) {
  const [threads, setThreads] = useState<GatewayThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<GatewayMessage[]>([]);
  const [draft, setDraft] = useState('');
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    const resize = () => {
      const styles = getComputedStyle(input);
      const minimum = parseFloat(styles.minHeight) || 36;
      const maximum = Math.max(minimum, parseFloat(styles.maxHeight) || 240);
      input.style.height = '0px';
      const contentHeight = input.value ? input.scrollHeight + 2 : minimum;
      input.style.height = `${Math.max(minimum, Math.min(maximum, contentHeight))}px`;
      input.style.overflowY = contentHeight > maximum ? 'auto' : 'hidden';
    };
    resize();
    let width = input.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; resize(); }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [draft]);
  const [streaming, setStreaming] = useState('');
  // Busy is tracked per thread so one long video turn cannot lock the whole window.
  const [busyThreads, setBusyThreads] = useState<string[]>([]);
  const [forwarding, setForwarding] = useState(false);
  const [notice, setNoticeState] = useState<{ text: string; path?: string; kind?: 'info' | 'error' | 'success' } | null>(null);
  const setNotice = useCallback((val: string | { text: string; path?: string; kind?: 'info' | 'error' | 'success' } | null) => {
    if (!val) setNoticeState(null);
    else if (typeof val === 'string') setNoticeState({ text: val, kind: val.startsWith('正在') ? 'info' : 'error' });
    else setNoticeState(val);
  }, []);

  useEffect(() => {
    if (!notice || notice.kind !== 'success') return;
    const timer = setTimeout(() => {
      setNoticeState(null);
    }, 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  const activeIdRef = useRef<string | null>(null);
  const busyRef = useRef(new Set<string>());
  const markBusy = useCallback((threadId: string, on: boolean) => {
    const next = new Set(busyRef.current);
    if (on) next.add(threadId); else next.delete(threadId);
    busyRef.current = next;
    setBusyThreads([...next]);
  }, []);
  const forwardingRef = useRef(false);
  const localId = useRef(0);
  const streams = useRef<Record<string, string>>({});
  const messageLoad = useRef(0);
  const selectThread = useCallback((id: string | null) => {
    activeIdRef.current = id;
    messageLoad.current++;
    setActiveId(id);
    setMessages([]);
    setStreaming(id ? streams.current[id] ?? '' : '');
    setNotice('');
  }, []);
  const [deepThink, setDeepThink] = useState(false);
  const [composerMode, setComposerMode] = useState<'text' | 'image' | 'video'>('text');
  const [imageRatio, setImageRatio] = useState('1:1');
  const [videoRatio, setVideoRatio] = useState('16:9');
  const [videoDuration, setVideoDuration] = useState(5);
  const [videoModel, setVideoModel] = useState('Seedance 2.0 Fast');
  // 指定账号发送：消息固定发到所选账号。
  const [pinnedAccountId, setPinnedAccountId] = useState<number | null>(null);
  const [accounts, setAccounts] = useState<{ id: number; name: string }[]>([]);
  const [dragActive, setDragActive] = useState(false);
  // Staged images live in App so the quick-preview bar can feed this composer too.
  const setStagedImages = (update: StagedAttachment[] | ((current: StagedAttachment[]) => StagedAttachment[])) => {
    const next = typeof update === 'function' ? update(stagedImages) : update;
    onStagedChange?.(next);
  };
  const scroller = useRef<HTMLDivElement | null>(null);

  const active = useMemo(() => threads.find(thread => thread.id === activeId) ?? null, [threads, activeId]);
  // Only this thread's own in-flight turn changes the composer; other threads keep sending.
  const busy = useMemo(() => (activeId ? busyThreads.includes(activeId) : false), [busyThreads, activeId]);
  const accountNames = useMemo(() => {
    const map: Record<number, string> = {};
    for (const account of accounts) map[account.id] = account.name;
    return map;
  }, [accounts]);

  const refreshThreads = useCallback(async (selectFirst = false) => {
    const next = await window.workspace.chatThreads();
    setThreads(next);
    if (selectFirst && !activeIdRef.current && busyRef.current.size === 0) selectThread(next[0]?.id ?? null);
  }, [selectThread]);

  const loadMessages = useCallback(async (threadId: string) => {
    const request = ++messageLoad.current;
    const saved = await window.workspace.chatMessages(threadId);
    if (activeIdRef.current !== threadId || request !== messageLoad.current) return;
    setMessages(current => reconcileMessages(current.filter(message => message.threadId === threadId), saved));
  }, []);

  useEffect(() => {
    // The account list powers both the 账号N 回复 labels and the pinned-account picker.
    void window.workspace.load().then(data => {
      const list = (data.accounts ?? []).filter((a: { platform?: string }) => (a.platform ?? 'doubao') === 'doubao');
      setAccounts(list.map((a: { id: number; name: string }) => ({ id: a.id, name: a.name })));
      setPinnedAccountId(current => current ?? null);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    void refreshThreads(true).catch(error => setNotice(String(error)));
  }, [refreshThreads]);

  useEffect(() => window.workspace.onChatDelta(payload => {
    if (payload.threadId && payload.videoTaskId) {
      const running = !['completed','failed','cancelled','needs_attention'].includes(payload.videoStatus || '');
      markBusy(payload.threadId, running);
      if (!running) {
        delete streams.current[payload.threadId];
        if (activeIdRef.current === payload.threadId) {
          setStreaming('');
          setNotice('');
          void loadMessages(payload.threadId);
        }
        return;
      }
    }
    if (payload.threadId) {
      streams.current[payload.threadId] = payload.full;
    }
    const full = threadDelta(activeIdRef.current, payload);
    if (full !== null) setStreaming(full);
  }), []);

  useEffect(() => {
    if (activeId) void loadMessages(activeId).catch(error => setNotice(String(error)));
    else setMessages([]);
  }, [activeId, loadMessages]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages, streaming]);

  const startNew = async () => {
    const thread = await window.workspace.chatCreate();
    selectThread(thread.id);
    await refreshThreads();
    setNotice('');
  };

  const removeThread = async (id: string) => {
    await window.workspace.chatDelete(id);
    if (activeIdRef.current === id) selectThread(null);
    delete streams.current[id];
    await refreshThreads(true);
  };

  /** Accepts drops from the quick-preview bar (asset ids) and from the OS (file paths). */
  const handleDrop = async (transfer: DataTransfer) => {
    try {
      const assetIds = transfer.getData('application/x-ds-asset');
      let items: StagedAttachment[] = [];
      if (assetIds) {
        // Same-account drops carry ids the store can resolve directly.
        const ids = assetIds.split(',').filter(Boolean);
        const listing = await window.workspace.listImageAssets();
        const assets = listing && Array.isArray(listing.items) ? listing.items : [];
        items = assets.filter(a => ids.includes(a.id))
          .map(a => ({ id: a.id, assetId: a.id, name: a.name, mimeType: mimeTypeForName(a.name), url: a.url }));
      }
      if (items.length) {
        setStagedImages(current => {
          const known = new Set(current.map(x => x.id));
          return [...current, ...items.filter(item => !known.has(item.id))];
        });
        return;
      }
      // OS-level drops (screenshots, files from Explorer).
      const files = ([...transfer.files] as (File & { path?: string })[]).map(file => file.path ?? '').filter((p): p is string => Boolean(p));
      if (files.length) {
        const imported = await window.workspace.importImagePaths(files);
        setStagedImages(current => {
          const known = new Set(current.map(x => x.id));
          const added = imported.filter((item: { id: string; name: string; url: string }) => !known.has(item.id))
            .map((item: { id: string; name: string; url: string }) => ({ id: item.id, assetId: item.id, name: item.name, mimeType: mimeTypeForName(item.name), url: item.url }));
          return [...current, ...added];
        });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  /** Imports any supported file from disk into the asset store and stages it for the next message. */
  const pickImages = async () => {
    try {
      const paths = await window.workspace.selectFiles();
      if (!paths || !paths.length) return;
      // The asset store hashes content, so the same file never duplicates.
      const imported = await window.workspace.importImagePaths(paths);
      setStagedImages(current => {
        const known = new Set(current.map(item => item.id));
        const added = imported.filter((item: { id: string; name: string; url: string }) => !known.has(item.id))
          .map((item: { id: string; name: string; url: string }) => ({ id: item.id, assetId: item.id, name: item.name, mimeType: mimeTypeForName(item.name), url: item.url }));
        return [...current, ...added];
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const appendUser = (threadId: string, text: string) => {
    const id = --localId.current;
    setMessages(current => [...current, {
      id, threadId, role: 'user', content: text, attachments: [], status: 'pending',
      error: '', createdAt: new Date().toISOString(), accountId: null,
    }]);
    return id;
  };

  const handleConfirm = async (text: string) => {
    const threadId = activeIdRef.current;
    if (!threadId || composerAction(text, busyRef.current.has(threadId), forwardingRef.current) !== 'continue') return;
    forwardingRef.current = true;
    setForwarding(true);
    const id = appendUser(threadId, text);
    setDraft('');
    try {
      setNotice('正在发送你的补充消息...');
      const ok = await window.workspace.chatConfirm({ threadId, text });
      if (!ok) throw new Error('未找到本会话可接收补充消息的任务，消息未发送，请稍后重试');
      if (activeIdRef.current === threadId) {
        setMessages(current => current.map(message => message.id === id ? { ...message, status: 'done' } : message));
        setNotice('补充消息已转交，请等待豆包实际回复；这不代表视频已开始或已完成生成。');
        await loadMessages(threadId);
      }
    } catch (error) {
      if (activeIdRef.current === threadId) {
        const detail = error instanceof Error ? error.message : String(error);
        setMessages(current => current.map(message => message.id === id ? { ...message, status: 'failed', error: detail } : message));
        setNotice(detail);
      }
    } finally {
      forwardingRef.current = false;
      setForwarding(false);
    }
  };

  const send = async () => {
    const prompt = draft.trim();
    const current = activeIdRef.current;
    const action = composerAction(prompt, current ? busyRef.current.has(current) : false, forwardingRef.current);
    if (action === 'none') return;
    if (action === 'continue') { await handleConfirm(prompt); return; }
    setNotice('');
    let threadId = activeIdRef.current;
    let userId: number | undefined;
    try {
      threadId = await ensureChatThread(threadId, () => window.workspace.chatCreate(), thread => {
        setThreads(current => [thread, ...current.filter(item => item.id !== thread.id)]);
        selectThread(thread.id);
      });
      markBusy(threadId, true);
      if (activeIdRef.current === threadId) setStreaming('');
      streams.current[threadId] = '';
      userId = appendUser(threadId, prompt);
      setDraft('');
      const attachments = toIpcAttachments(stagedImages);
      // Consume only this turn's attachments, not anything staged during generation.
      setStagedImages([]);
      if (composerMode === 'image') {
        await window.workspace.chatImages({ threadId, prompt, ratio: imageRatio, accountId: pinnedAccountId, attachments });
      } else if (composerMode === 'video') {
        await window.workspace.chatVideos({ threadId, prompt, ratio: videoRatio, duration: videoDuration, model: videoModel, accountId: pinnedAccountId, attachments });
      } else {
        await window.workspace.chatSend({ threadId, prompt, deepThink, accountId: pinnedAccountId, attachments });
      }
      await refreshThreads();
      if (activeIdRef.current === threadId) await loadMessages(threadId);
    } catch (error) {
      if (activeIdRef.current === threadId) {
        const detail = error instanceof Error ? error.message : String(error);
        setNotice(detail);
        setMessages(current => current.map(message => message.id === userId ? { ...message, status: 'failed', error: detail } : message));
        if (threadId) await loadMessages(threadId).catch(() => undefined);
      }
    } finally {
      if (threadId) { markBusy(threadId, false); delete streams.current[threadId]; }
      if (activeIdRef.current === threadId) setStreaming('');
    }
  };

  /** Downloads a generated image/video to the configured download folder. */
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [extractingLastFrameId, setExtractingLastFrameId] = useState<string | null>(null);

  const downloadMedia = async (item: GatewayAttachment, accountId?: number | null, threadId?: string) => {
    if (downloadingId) return;
    setDownloadingId(item.id);
    try {
      setNotice(item.kind === 'video' ? '正在按高清下载保存无水印视频...' : '正在保存图片到下载目录...');
      const result = await window.workspace.downloadMedia(item, { accountId, threadId: threadId || activeId || undefined });
      if (result?.error) throw new Error(result.error);
      setNotice({ text: result?.path ? `已保存到：${result.path}` : '已保存到下载目录', path: result?.path, kind: 'success' });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloadingId(null);
    }
  };

  const downloadLastFrame = async (item: GatewayAttachment) => {
    if (extractingLastFrameId || !item.url) return;
    setExtractingLastFrameId(item.id);
    try {
      setNotice('正在截取视频最后一帧...');
      const dataUrl = await extractVideoLastFrame(item.url);
      setNotice('正在保存尾帧图片到下载目录...');
      const result = await window.workspace.saveLastFrame({ dataUrl, name: item.name });
      if (result?.error) throw new Error(result.error);
      setNotice({ text: result?.path ? `尾帧已保存到：${result.path}` : '尾帧已保存到下载目录', path: result?.path, kind: 'success' });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setExtractingLastFrameId(null);
    }
  };

  return <main className="gateway-chat">
    <aside className="chat-threads">
      <div className="chat-threads-head">
        <b>会话</b>
        <button className="outline" onClick={() => void startNew()} title="新建会话"><Plus size={14} /></button>
      </div>
      <div className="chat-threads-list">
        {threads.length ? threads.map(thread => <div key={thread.id} className={`chat-thread ${thread.id === activeId ? 'active' : ''}`}>
          <button className="chat-thread-open" onClick={() => selectThread(thread.id)} title={thread.title}>
            <b>{thread.title}</b>
            <small>{thread.messageCount ?? 0} 条{thread.doubaoConversationId ? ' · 有上下文' : ''}</small>
          </button>
          <button className="chat-thread-remove" onClick={() => void removeThread(thread.id)} title="删除会话"><Trash2 size={13} /></button>
        </div>) : <p className="muted">还没有会话，点右上角 + 开始。</p>}
      </div>
    </aside>

    <section
      className={`chat-main${dragActive ? " drag-target" : ""}`}
      onDragOver={event => { if (event.dataTransfer.types.includes('application/x-ds-asset') || event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragActive(true); } }}
      onDragLeave={event => { if (event.target === event.currentTarget) setDragActive(false); }}
      onDrop={event => { event.preventDefault(); setDragActive(false); void handleDrop(event.dataTransfer); }}
    >
      <header className="chat-head">
        <div className="chat-head-title">
          <b>{active?.title ?? '新对话'}</b>
          <span className="muted">{active?.doubaoConversationId ? '多轮上下文已开启' : '发送第一条消息后建立上下文'}</span>
        </div>
      </header>

      {notice && <div className={`chat-alert ${notice.kind || 'error'}`}>
        <span className="chat-alert-text">{notice.text}</span>
        {notice.path && <button type="button" className="chat-alert-action" onClick={() => void window.workspace.openFolder(notice.path!)} title="在资源管理器中打开所在文件夹"><FolderOpen size={13} />打开文件夹</button>}
        <button type="button" className="chat-alert-close" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>
      </div>}

      <div className="chat-scroll" ref={scroller}>
        {!messages.length && !streaming && <div className="chat-empty">
          <Sparkles size={22} />
          <h2>通过网关和豆包对话</h2>
          <p>消息由已登录的账号池发出，支持文字、图片与视频结果。</p>
        </div>}
        {messages.filter(message => !(streaming && message.role === 'assistant' && (message.status === 'pending' || message.status === 'streaming'))).map(message => <MessageBubble key={message.id} message={message} accountName={accountNames[message.accountId ?? -1]} streamed="" onDownload={item => void downloadMedia(item, message.accountId, message.threadId)} downloadingId={downloadingId} onDownloadLastFrame={item => void downloadLastFrame(item)} extractingLastFrameId={extractingLastFrameId} onConfirm={!streaming && busy && !forwarding && message.id === messages[messages.length - 1]?.id ? handleConfirm : undefined} />)}
        {streaming && <MessageBubble message={{ id: 0, threadId: activeId ?? '', role: 'assistant', content: streaming, attachments: [], status: 'streaming', error: '', createdAt: '', accountId: active?.accountId ?? null }} streamed="" onDownload={item => void downloadMedia(item, active?.accountId, activeId ?? undefined)} downloadingId={downloadingId} onDownloadLastFrame={item => void downloadLastFrame(item)} extractingLastFrameId={extractingLastFrameId} onConfirm={busy && !forwarding ? handleConfirm : undefined} />}
      </div>

      <footer className="chat-composer">
        <div className="chat-composer-stack">
      <div className="chat-options chat-mode-floating" role="group" aria-label="模式选择">
        <label className="chat-toggle" title="开启后生成图片而不是文字">
          <input type="checkbox" checked={composerMode === 'image'} onChange={event => setComposerMode(event.target.checked ? 'image' : 'text')} /><ImageIcon size={13} />图片模式
        </label>
        <label className="chat-toggle" title="开启后生成视频，通常需要 1-5 分钟">
          <input type="checkbox" checked={composerMode === 'video'} onChange={event => setComposerMode(event.target.checked ? 'video' : 'text')} /><Video size={13} />视频模式
        </label>
        {composerMode === 'video' && <VideoModelPicker value={videoModel}
          onChange={nextModel => {
            setVideoModel(nextModel);
            if (nextModel === 'Seedance 2.5' && videoDuration < 10) {
              setVideoDuration(10);
            }
          }} />}
        {composerMode === 'video' && <label className="chat-duration-control" title="视频时长（4-30 秒）">
          <span>时长</span>
          <input type="range"
            min={videoModel === 'Seedance 2.5' ? 10 : 4}
            max={30}
            step={1}
            value={videoDuration}
            onChange={event => {
              const dur = Number(event.target.value);
              setVideoDuration(dur);
              if (dur < 10 && videoModel === 'Seedance 2.5') {
                setVideoModel('Seedance 2.0 Fast');
              }
            }}
            aria-label="视频时长（秒）" />
          <output>{videoDuration} 秒</output>
        </label>}
        <label className="chat-account-pick" title="消息固定发送到此账号，或选择自动调度以多账号并发">
          <span>发送账号</span>
          <select value={pinnedAccountId ?? ''} onChange={event => setPinnedAccountId(event.target.value ? Number(event.target.value) : null)}>
            <option value="">自动调度（并发账号池）</option>
            {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>
        {composerMode === 'text'
          ? <label className="chat-toggle" title="开启后启用豆包深度思考">
              <input type="checkbox" checked={deepThink} onChange={event => setDeepThink(event.target.checked)} />深度思考
            </label>
          : <select className="chat-ratio" value={composerMode === 'image' ? imageRatio : videoRatio}
              onChange={event => (composerMode === 'image' ? setImageRatio : setVideoRatio)(event.target.value)}
              title={composerMode === 'image' ? '图片比例' : '视频比例'}>
              {(composerMode === 'image' ? ['1:1', '4:3', '3:4', '16:9', '9:16'] : ['16:9', '9:16', '1:1', '4:3', '3:4']).map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
            </select>}
      </div>
          {stagedImages.length > 0 && <div className="chat-staged">
            {stagedImages.map(item => <figure key={item.id} title={item.name} className={/\.(png|jpg|jpeg|webp|gif)$/i.test(item.name) ? 'is-image' : 'is-file'}>
              {/\.(png|jpg|jpeg|webp|gif)$/i.test(item.name)
                ? <img src={item.url} alt={item.name} />
                : <span className="chat-staged-file">{item.name.replace(/^.*\./, '').toUpperCase() || 'FILE'}</span>}
              <button type="button" onClick={() => setStagedImages(list => list.filter(x => x.id !== item.id))} title="移除">×</button>
            </figure>)}
          </div>}
          <div className="chat-composer-row">
            <button type="button" className="chat-attach" aria-label="添加文件" title="添加文件（图片 / 文档 / 代码 / 音频）发给模型" onClick={() => void pickImages()}>
              <Plus size={18} />
            </button>
            <textarea ref={composerInput} rows={1} aria-label="消息输入框" value={draft} placeholder={busy ? '可输入确认、修改要求或追问，Enter 发送补充（仅文字）' : composerMode === 'image' ? '描述要生成的图片，Enter 生成' : composerMode === 'video' ? '描述要生成的视频，Enter 生成（约 1-5 分钟）' : stagedImages.length ? '描述你想让模型怎么处理这些附件，Enter 发送' : '输入消息，Enter 发送，Shift+Enter 换行'}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
          }} />
        <button className="primary" disabled={composerAction(draft, busy, forwarding) === 'none'} onClick={() => void send()}>
          {busy ? <Loader2 size={15} className="spin" /> : composerMode === 'image' ? <ImageIcon size={15} /> : composerMode === 'video' ? <Video size={15} /> : <Send size={15} />}{busy ? (forwarding ? '发送中' : '发送补充') : composerMode === 'image' ? '生成图片' : composerMode === 'video' ? '生成视频' : '发送'}
            </button>
          </div>
        </div>
      </footer>
    </section>
  </main>;
}

function MessageBubble({ message, streamed, accountName, onDownload, downloadingId, onDownloadLastFrame, extractingLastFrameId, onConfirm }: {
  message: GatewayMessage;
  streamed: string;
  accountName?: string;
  onDownload?: (item: GatewayAttachment) => void;
  downloadingId?: string | null;
  onDownloadLastFrame?: (item: GatewayAttachment) => void;
  extractingLastFrameId?: string | null;
  onConfirm?: (text: string) => void;
}) {
  const pending = message.status === 'streaming' || message.status === 'pending';
  const text = streamed || message.content;
  // Assistant replies are labelled with the account that produced them.
  const label = message.role === 'user' ? '我' : (accountName ? `${accountName} (豆包)` : '豆包');
  return <article className={`chat-msg ${message.role}`}>
    <div className="chat-msg-role">{label}</div>
    <div className="chat-msg-body">
      {text ? <div className="chat-msg-md">{renderMarkdown(text)}</div> : pending ? <p className="muted"><Loader2 size={13} className="spin" /> 正在生成...</p> : null}
      {message.role === 'assistant' && /视频生成参数确认|请先确认.*参数|确认后我再开始|确认后.*(?:开始|生成)|请确认/i.test(text) && onConfirm && <div className="chat-confirm-action" style={{ marginTop: '10px' }}><button type="button" className="primary" style={{ padding: '6px 14px', fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }} onClick={() => onConfirm('确认生成，直接开始')}>发送确认</button></div>}
      {message.status === 'failed' && message.error && <div className="chat-alert bad">{message.error}</div>}
      {message.attachments.length > 0 && <div className="chat-msg-media">
        {message.attachments.map(item => <figure key={item.id}>
          {item.kind === 'video'
            ? <video src={item.url} controls preload="metadata" />
            : <img src={item.url} alt={item.name} />}
          <figcaption>
            {onDownload && <button type="button" className="chat-media-download" disabled={downloadingId === item.id}
              onClick={() => onDownload(item)}
              title={item.kind === 'video' ? '按高清下载保存到本地（无水印原视频）' : '保存图片到本地下载目录'}>
              {downloadingId === item.id ? <Loader2 size={12} className="spin" /> : <Download size={12} />}{item.kind === 'video' ? '高清下载' : '下载'}
            </button>}
            {item.kind === 'video' && onDownloadLastFrame && <button type="button" className="chat-media-download" disabled={extractingLastFrameId === item.id}
              onClick={() => onDownloadLastFrame(item)}
              title="提取并下载本视频最后一帧（高画质PNG）">
              {extractingLastFrameId === item.id ? <Loader2 size={12} className="spin" /> : <Camera size={12} />}下载尾帧
            </button>}
            {item.kind === 'video' ? <Video size={12} /> : <ImageIcon size={12} />}
            <span className="chat-media-name" title={item.name}>{item.name}</span>
          </figcaption>
        </figure>)}
      </div>}
    </div>
  </article>;
}

/** Small switch shown in the main window to move between the two modes. */
export function ModeSwitch({ mode, onModeChange }: { mode: Mode; onModeChange: (next: Mode) => void }) {
  return <div className="mode-switch" role="tablist">
    <button role="tab" aria-selected={mode === 'gateway'} className={mode === 'gateway' ? 'active' : ''} onClick={() => onModeChange('gateway')} title="统一聊天">统一聊天</button>
  </div>;
}

export { ArrowLeft };
