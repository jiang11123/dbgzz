import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Image as ImageIcon, Loader2, Plus, Send, Settings, Sparkles, Trash2, Video } from 'lucide-react';
import type { GatewayAttachment, GatewayMessage, GatewayThread, StagedAttachment } from '../shared/types';
import { renderMarkdown } from './markdown';

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
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
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
  const accountNames = useMemo(() => {
    const map: Record<number, string> = {};
    for (const account of accounts) map[account.id] = account.name;
    return map;
  }, [accounts]);

  const refreshThreads = useCallback(async (selectFirst = false) => {
    const next = await window.workspace.chatThreads();
    setThreads(next);
    setActiveId(current => {
      if (current && next.some((t: GatewayThread) => t.id === current)) return current;
      return selectFirst ? next[0]?.id ?? null : current;
    });
  }, []);

  const loadMessages = useCallback(async (threadId: string) => {
    setMessages(await window.workspace.chatMessages(threadId));
    setStreaming('');
  }, []);

  useEffect(() => {
    // The account list powers both the 账号N 回复 labels and the pinned-account picker.
    void window.workspace.load().then(data => {
      const list = (data.accounts ?? []).filter((a: { platform?: string }) => (a.platform ?? 'doubao') === 'doubao');
      setAccounts(list.map((a: { id: number; name: string }) => ({ id: a.id, name: a.name })));
      setPinnedAccountId(current => current ?? list[0]?.id ?? null);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    void refreshThreads(true).catch(error => setNotice(String(error)));
    return window.workspace.onChatDelta(payload => {
      setStreaming(current => (payload.threadId && payload.threadId !== activeId ? current : payload.full));
    });
  }, [activeId, refreshThreads]);

  useEffect(() => {
    if (activeId) void loadMessages(activeId).catch(error => setNotice(String(error)));
    else setMessages([]);
  }, [activeId, loadMessages]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages, streaming]);

  const startNew = async () => {
    const thread = await window.workspace.chatCreate();
    await refreshThreads();
    setActiveId(thread.id);
    setMessages([]);
    setNotice('');
  };

  const removeThread = async (id: string) => {
    await window.workspace.chatDelete(id);
    await refreshThreads(true);
    if (activeId === id) setActiveId(null);
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

  const handleConfirm = async (text: string) => {
    try {
      setNotice('正在向豆包发送确认...');
      const ok = await window.workspace.chatConfirm({ threadId: activeId ?? undefined, text });
      if (ok) {
        setNotice('已确认视频参数，豆包开始生成视频...');
      } else {
        setNotice('未找到等待确认的任务，豆包可能已开始生成');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    if (busy) {
      if (/^(确认|直接开始|开始生成|确认生成|同意|确定|好|好的|ok)$/i.test(prompt)) {
        setDraft('');
        void handleConfirm(prompt);
        return;
      }
      return;
    }
    setBusy(true); setNotice(''); setStreaming('');
    try {
      // Show the user's line immediately; the server echoes the persisted rows back.
      setMessages(current => [...current, {
        id: -Date.now(), threadId: activeId ?? '', role: 'user', content: prompt,
        attachments: [], status: 'done', error: '', createdAt: new Date().toISOString(), accountId: null,
      }]);
      setDraft('');
      const targetAccount = pinnedAccountId;
      const attachments = toIpcAttachments(stagedImages);
      const result = composerMode === 'image'
        ? await window.workspace.chatImages({ threadId: activeId ?? undefined, prompt, ratio: imageRatio, accountId: targetAccount, attachments })
        : composerMode === 'video'
          ? await window.workspace.chatVideos({ threadId: activeId ?? undefined, prompt, ratio: videoRatio, duration: videoDuration, model: videoModel, accountId: targetAccount, attachments })
          : await window.workspace.chatSend({ threadId: activeId ?? undefined, prompt, deepThink, accountId: targetAccount, attachments });
      setActiveId(result.thread.id);
      setStagedImages([]);
      await refreshThreads();
      await loadMessages(result.thread.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      if (activeId) await loadMessages(activeId).catch(() => undefined);
    } finally {
      setBusy(false); setStreaming('');
    }
  };

  const stageGeneratedImage = async (item: GatewayAttachment) => {
    if (!item.path) {
      setNotice('该图片没有可引用的本地文件');
      return;
    }
    try {
      const imported = await window.workspace.importImagePaths([item.path]);
      const asset = imported[0];
      if (!asset) throw new Error('图片导入失败');
      setStagedImages(current => current.some(existing => existing.assetId === asset.id)
        ? current
        : [...current, toStagedGeneratedImage(item, asset)]);
      setNotice('图片已加入下一条消息，可切换视频模式引用');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
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
          <button className="chat-thread-open" onClick={() => setActiveId(thread.id)} title={thread.title}>
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

      {notice && <div className="chat-alert">{notice}</div>}

      <div className="chat-scroll" ref={scroller}>
        {!messages.length && !streaming && <div className="chat-empty">
          <Sparkles size={22} />
          <h2>通过网关和豆包对话</h2>
          <p>消息由已登录的账号池发出，支持文字、图片与视频结果。</p>
        </div>}
        {messages.map(message => <MessageBubble key={message.id} message={message} accountName={accountNames[message.accountId ?? -1]} streamed={message.role === 'assistant' && message.id === messages[messages.length - 1]?.id ? streaming : ''} onStageGeneratedImage={stageGeneratedImage} onConfirm={handleConfirm} />)}
      </div>

      <div className="chat-options">
        <label className="chat-toggle" title="开启后生成图片而不是文字">
          <input type="checkbox" checked={composerMode === 'image'} onChange={event => setComposerMode(event.target.checked ? 'image' : 'text')} /><ImageIcon size={13} />图片模式
        </label>
        <label className="chat-toggle" title="开启后生成视频，通常需要 1-5 分钟">
          <input type="checkbox" checked={composerMode === 'video'} onChange={event => setComposerMode(event.target.checked ? 'video' : 'text')} /><Video size={13} />视频模式
        </label>
        {composerMode === 'video' && <select className="chat-ratio" value={videoModel}
          onChange={event => {
            const nextModel = event.target.value;
            setVideoModel(nextModel);
            if (nextModel === 'Seedance 2.5' && videoDuration < 10) {
              setVideoDuration(10);
            }
          }} title="视频模型">
          {['Seedance 2.0 Fast', 'Seedance 2.5', 'Seedance 2.0', 'Seedance 2.0 Mini'].map(m => <option key={m} value={m}>{m}</option>)}
        </select>}
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
        <label className="chat-account-pick" title="消息固定发送到此账号">
          <span>发送账号</span>
          <select value={pinnedAccountId ?? ''} onChange={event => setPinnedAccountId(Number(event.target.value) || null)}>
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
      <footer className="chat-composer">
        <div className="chat-composer-stack">
          {stagedImages.length > 0 && <div className="chat-staged">
            {stagedImages.map(item => <figure key={item.id} title={item.name} className={/\.(png|jpg|jpeg|webp|gif)$/i.test(item.name) ? 'is-image' : 'is-file'}>
              {/\.(png|jpg|jpeg|webp|gif)$/i.test(item.name)
                ? <img src={item.url} alt={item.name} />
                : <span className="chat-staged-file">{item.name.replace(/^.*\./, '').toUpperCase() || 'FILE'}</span>}
              <button type="button" onClick={() => setStagedImages(list => list.filter(x => x.id !== item.id))} title="移除">×</button>
            </figure>)}
          </div>}
          <div className="chat-composer-row">
            <button type="button" className="chat-attach" title="添加文件（图片 / 文档 / 代码 / 音频）发给模型" onClick={() => void pickImages()}>
              <ImageIcon size={15} />
            </button>
            <textarea value={draft} placeholder={composerMode === 'image' ? '描述要生成的图片，Enter 生成' : composerMode === 'video' ? '描述要生成的视频，Enter 生成（约 1-5 分钟）' : stagedImages.length ? '描述你想让模型怎么处理这些附件，Enter 发送' : '输入消息，Enter 发送，Shift+Enter 换行'}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
          }} />
        <button className="primary" disabled={busy || !draft.trim()} onClick={() => void send()}>
          {busy ? <Loader2 size={15} className="spin" /> : composerMode === 'image' ? <ImageIcon size={15} /> : composerMode === 'video' ? <Video size={15} /> : <Send size={15} />}{busy ? '生成中' : composerMode === 'image' ? '生成图片' : composerMode === 'video' ? '生成视频' : '发送'}
            </button>
          </div>
        </div>
      </footer>
    </section>
  </main>;
}

function MessageBubble({ message, streamed, accountName, onStageGeneratedImage, onConfirm }: { message: GatewayMessage; streamed: string; accountName?: string; onStageGeneratedImage: (item: GatewayAttachment) => void; onConfirm?: (text: string) => void }) {
  const pending = message.status === 'streaming' || message.status === 'pending';
  const text = streamed || message.content;
  // Assistant replies are labelled with the account that produced them.
  const label = message.role === 'user' ? '我' : (accountName ? `${accountName} (豆包)` : '豆包');
  return <article className={`chat-msg ${message.role}`}>
    <div className="chat-msg-role">{label}</div>
    <div className="chat-msg-body">
      {text ? <div className="chat-msg-md">{renderMarkdown(text)}</div> : pending ? <p className="muted"><Loader2 size={13} className="spin" /> 正在生成...</p> : null}
      {message.role === 'assistant' && /视频生成参数确认|请先确认.*参数|确认后我再开始|确认后.*(?:开始|生成)|请确认/i.test(text) && onConfirm && <div className="chat-confirm-action" style={{ marginTop: '10px' }}><button type="button" className="primary" style={{ padding: '6px 14px', fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }} onClick={() => onConfirm('确认生成，直接开始')}>✓ 立即确认生成</button></div>}
      {message.status === 'failed' && message.error && <div className="chat-alert bad">{message.error}</div>}
      {message.attachments.length > 0 && <div className="chat-msg-media">
        {message.attachments.map(item => item.kind === 'video'
          ? <figure key={item.id}><video src={item.url} controls preload="metadata" /><figcaption><Video size={12} />{item.name}</figcaption></figure>
          : <figure key={item.id}><img src={item.url} alt={item.name} /><figcaption><ImageIcon size={12} />{item.name}{item.path && <button type="button" className="outline" onClick={() => onStageGeneratedImage(item)} title="加入下一条消息作为参考图">加入下一条消息</button>}</figcaption></figure>)}
      </div>}
    </div>
  </article>;
}

/** Small switch shown in the main window to move between the two modes. */
export function ModeSwitch({ mode, onModeChange }: { mode: Mode; onModeChange: (next: Mode) => void }) {
  return <div className="mode-switch" role="tablist">
    <button role="tab" aria-selected={mode === 'gateway'} className={mode === 'gateway' ? 'active' : ''} onClick={() => onModeChange('gateway')}>网关模式</button>
    <button role="tab" aria-selected={mode === 'account'} className={mode === 'account' ? 'active' : ''} onClick={() => onModeChange('account')}>账号模式</button>
  </div>;
}

export { ArrowLeft };
