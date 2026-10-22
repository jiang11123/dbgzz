import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, FolderOpen, GripVertical, Heart, MonitorPlay, Music2, Plus, Server, Settings, Upload } from 'lucide-react';
import type { Account, DownloadStatus } from '../shared/types';
import './style.css';
import './theme.css';
import productLogo from './assets/logo.png';
import { ThemeToggle } from './theme';
import { ImageAssetsPanel } from './image-assets-panel';
import { BarResizer, useResizableBar } from './resizable-bar';
import { ImageAssetsBar } from './image-assets-bar';
import { MessageSyncPanel } from './message-sync-panel';
import { AccountShortcutInput, ResetAccountShortcuts } from './account-shortcut-settings';
import { accountShortcut } from '../shared/account-shortcuts';
import { DonationPanel } from './donation-panel';
import { GatewayPanel } from './gateway-panel';
import { GatewayChat, ModeSwitch } from './gateway-chat';

type Workspace = { accounts: Account[]; downloadDirectory: string; accountShortcuts: Record<string,string> };
function getDownloadNoticeTitle(status: DownloadStatus): string {
  const isImage = Boolean(status.name && /\.(png|jpe?g|webp|gif)$/i.test(status.name));
  const media = isImage ? '图片' : '视频';
  if (status.state === 'started') return `正在下载${media}`;
  if (status.state === 'completed') return `${media}已保存`;
  if (status.state === 'duplicate') return '已阻止重复下载';
  return `${media}下载失败`;
}

function App() {
  // Secondary windows (设置 / API 网关 / 消息同步) render a single panel by query
  // param. This MUST run before any hook: a settings window must not start the
  // account-opening effects of the main workspace.
  const panel = new URLSearchParams(window.location.search).get('panel');
  if (panel === 'settings') return <div className="settings-page"><SettingsPage /></div>;
  if (panel === 'gateway') return <GatewayPanel />;
  if (panel === 'messages') return <MessageSyncPanel />;
  if (panel === 'image-assets') return <ImageAssetsPanel />;
  if (panel === 'donation') return <DonationPanel />;
  const [data, setData] = useState<Workspace | null>(null);
  const [currentAccountId, setCurrentAccountId] = useState<number | null>(null);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState<DownloadStatus | null>(null);
  const [toast, setToast] = useState('');
  const [mode, setMode] = useState<'gateway' | 'account'>('gateway');
  const [stagedImages, setStagedImages] = useState<import('../shared/types').StagedAttachment[]>([]);
  const accountShortcuts = data?.accountShortcuts ?? {};
  const startupAccountOpened = useRef(false);
  const message = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 2400); };
  const accountBar = useResizableBar('account', message);
  const refresh = async () => {
    const next = await window.workspace.load(); setData(next);
  };
  const openAccount = async (account?: Account) => {
    if (!account) return;
    try {
      await window.workspace.openAccount(account.id);
      setCurrentAccountId(account.id);
      if (mode !== 'account') changeMode('account');
    }
    catch (error) { message(`打开账号失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  useEffect(() => {
    void refresh();
    void window.workspace.getAppMode().then(setMode).catch(() => undefined);
    const disposers = [window.workspace.onChanged(refresh), window.workspace.onAppModeChanged(setMode), window.workspace.onAccountOpened(setCurrentAccountId),
      window.workspace.onBrowserError(message), window.workspace.onAccountSendStatus(message), window.workspace.onDownloadStatus(setDownloadNotice)];
    return () => disposers.forEach(dispose => dispose());
  }, []);
  useEffect(() => {
    if (!data) return;
    // Clean the selection only when the chosen account really disappeared; never
    // clobber a freshly opened account during a concurrent refresh.
    setCurrentAccountId(old => (old != null && !data.accounts.some((a: Account) => a.id === old)) ? null : old);
  }, [data]);
  useEffect(() => {
    if (!data || mode !== 'account' || startupAccountOpened.current || !data.accounts.length) return;
    // An explicit openAccount (a check script, a shortcut, a click) wins over the startup
    // default: without this, a fast caller that opens its own account gets overridden
    // when this effect re-fires on the next data refresh.
    if (currentAccountId != null) { startupAccountOpened.current = true; return; }
    startupAccountOpened.current = true; void openAccount(data.accounts[0]);
  }, [data, mode]);
  useEffect(() => {
    if (!downloadNotice || downloadNotice.state === 'started') return;
    const timer = window.setTimeout(() => setDownloadNotice(null), 3000); return () => window.clearTimeout(timer);
  }, [downloadNotice]);
  if (!data) return <div className="loading">正在打开豆包工作站...</div>;
  const changeMode = (next: 'gateway' | 'account') => { setMode(next); void window.workspace.setAppMode(next).catch(error => message(String(error))); };

  const renderTopBar = () => (
    <header className="topbar" style={{ height: accountBar.height, '--account-scale': Math.max(0.75, Math.min(2.5, accountBar.height / 58)) } as React.CSSProperties}>
      <div className="brand"><img className="product-logo" src={productLogo} alt="奶蛙老师头像" /><span>豆包工作站</span></div>
      <ModeSwitch mode={mode} onModeChange={changeMode} />
      <div className="account-tabs">
        {data.accounts.map((account, index) => (
          <button key={account.id} className={mode === 'account' && account.id === currentAccountId ? 'account active' : 'account'} onClick={() => void openAccount(account)} title={accountShortcut(index, data.accountShortcuts || {}) || undefined}>
            <span className={account.isLoggedIn ? 'login-dot on' : 'login-dot'} />{account.name}
          </button>
        ))}
        <button className="add-account" onClick={() => setShowNewAccount(true)} title="添加账号"><Plus size={15} />添加账号</button>
      </div>
      <div className="topbar-actions">
        <ThemeToggle />
        <button className="browser-size-toggle" onClick={() => void window.workspace.openAuthorDouyin().catch(error => message(`打开抖音主页失败：${String(error)}`))} title="前往奶蛙老师的抖音主页"><Music2 size={15} />抖音奶蛙老师开源</button>
        <button className="watermark-shortcut donation-button" onClick={() => void window.workspace.openDonation()} title="赞赏奶蛙老师"><Heart size={15} />赞赏奶蛙老师</button>
        <button className="browser-size-toggle" title="图片资产" onClick={() => void window.workspace.openImageAssets()}><Upload size={15} />图片资产</button>
        <button className="browser-size-toggle" title="网关设置" onClick={() => void window.workspace.openGateway()}><Server size={15} />网关设置</button>
        <button className="browser-size-toggle" title="设置" onClick={() => void window.workspace.openSettings()}><Settings size={15} />设置</button>
      </div>
      <BarResizer bar={accountBar} />
    </header>
  );

  if (mode === 'gateway') return <main className="app-shell gateway-shell">
    {renderTopBar()}
    <ImageAssetsBar accountId={currentAccountId ?? data?.accounts[0]?.id ?? null} message={message}
      onStage={items => setStagedImages(current => [...current, ...items.filter(item => !current.some(x => x.id === item.id)).map(item => ({ id: item.id, assetId: item.id, name: item.name, mimeType: item.name.match(/\.(png|jpe?g|webp|gif)$/i)?.[0] ? 'image/' + item.name.split('.').pop()!.toLowerCase().replace('jpg', 'jpeg') : 'application/octet-stream', url: item.url }))])} />
    <GatewayChat mode={mode} onModeChange={changeMode} stagedImages={stagedImages} onStagedChange={setStagedImages} />
    {showNewAccount && <NewAccount onClose={() => setShowNewAccount(false)} onCreated={async account => { setShowNewAccount(false); await refresh(); await openAccount(account); }} />}
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </main>;

  return <main className="app-shell browser-fullscreen">
    {renderTopBar()}
    <ImageAssetsBar accountId={currentAccountId} message={message} />
    {showNewAccount && <NewAccount onClose={() => setShowNewAccount(false)} onCreated={async account => { setShowNewAccount(false); await refresh(); await openAccount(account); }} />}
    {downloadNotice && <div className={`download-notice ${downloadNotice.state}`} role="status"><div><b>{getDownloadNoticeTitle(downloadNotice)}</b><span>{downloadNotice.name}</span></div>
      {downloadNotice.state === 'completed' && downloadNotice.path && <button className="download-location" onClick={() => void window.workspace.openFolder(downloadNotice.path as string)}><FolderOpen size={13} />打开下载位置</button>}
      <button className="download-dismiss" aria-label="关闭下载提示" onClick={() => setDownloadNotice(null)}>×</button></div>}
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </main>;
}

/** Settings window: account management, quotas, deletion and drag reordering. */
/**
 * IME-safe rename field: commits on blur/Enter, never commits mid-composition,
 * and keeps focus + caret through unrelated data refreshes.
 */
function NameInput({ ariaLabel, initial, onCommit }: { ariaLabel: string; initial: string; onCommit: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  const [composing, setComposing] = useState(false);
  const field = useRef<HTMLInputElement | null>(null);
  const committed = useRef(initial);
  // A reorder changes this row's account: follow the new name unless the user is
  // mid-edit, otherwise the field keeps showing the previous account's name.
  const lastInitial = useRef(initial);
  if (lastInitial.current !== initial) {
    lastInitial.current = initial;
    if (!composing) { committed.current = initial; setValue(initial); }
  }
  const commit = () => {
    if (composing) return;
    if (field.current !== document.activeElement && value === committed.current) return;
    if (value.trim() && value !== committed.current) { committed.current = value; onCommit(value); }
  };
  return <input ref={field} aria-label={ariaLabel} value={value}
    onFocus={() => { committed.current = value; }}
    onChange={event => setValue(event.target.value)}
    onBlur={() => { const final = field.current ? field.current.value : value; setComposing(false); const trimmed = final.trim(); if (trimmed && trimmed !== committed.current) { committed.current = trimmed; onCommit(trimmed); setValue(trimmed); } else { setValue(committed.current); } }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || composing) return;
      if (event.key === 'Enter') { event.preventDefault(); (event.target as HTMLInputElement).blur(); }
      if (event.key === 'Escape') { setValue(initial); (event.target as HTMLInputElement).blur(); }
    }}
    onCompositionStart={() => setComposing(true)}
    onCompositionEnd={event => { setComposing(false); setValue(event.data); }} />;
}

function SettingsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountShortcuts, setAccountShortcuts] = useState<Record<string, string>>({});
  const [downloadDirectory, setDownloadDirectory] = useState('');
  const [message, setMessage] = useState('');
  const [showNewAccount, setShowNewAccount] = useState(false);
  const refresh = async () => {
    const next = await window.workspace.load();
    setAccounts(next.accounts);
    setAccountShortcuts(next.accountShortcuts ?? {});
    setDownloadDirectory(next.downloadDirectory ?? '');
  };
  useEffect(() => { void refresh().catch(error => setMessage(String(error))); }, []);
  const setDownloads = async () => {
    try {
      const folder = await window.workspace.selectDirectory();
      if (folder) {
        await window.workspace.watchDownloads(folder);
        await refresh();
        setMessage('下载目录已更新并开始监听');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const rename = async (id: number, name: string) => {
    try { await window.workspace.renameAccount(id, name); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const remove = async (account: Account) => {
    try { await window.workspace.confirmDeleteAccount(account.id); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const move = async (sourceId: number, targetId: number, before: boolean) => {
    try { await window.workspace.moveAccount(sourceId, targetId, before); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  // AccountShortcutInput is index-based; the stored map is keyed by account id.
  const indexKeyedShortcuts: Record<string, string> = {};
  accounts.forEach((account, i) => { const s = accountShortcuts[String(account.id)]; if (s) indexKeyedShortcuts[String(i)] = s; });
  return <div className="settings-window">
    <h2>下载设置</h2>
    {message && <div className="chat-alert">{message}</div>}
    <div className="download-settings-card">
      <div className="download-settings-info">
        <span className="download-settings-label">视频保存与监听目录</span>
        <span className="download-settings-path" title={downloadDirectory || '未设置'}>
          {downloadDirectory || '未设置。选择豆包视频下载保存的本地目录。'}
        </span>
      </div>
      <div className="download-settings-actions">
        {downloadDirectory && <button type="button" className="outline" onClick={() => void window.workspace.openFolder(downloadDirectory)} title="在资源管理器中打开"><FolderOpen size={15} />打开目录</button>}
        <button type="button" className="outline" onClick={() => void setDownloads()}><FolderOpen size={15} />选择目录</button>
      </div>
    </div>

    <h2 style={{ marginTop: 32 }}>账号管理</h2>
    <button className="primary add-account-settings" onClick={() => setShowNewAccount(true)}><Plus size={15} />添加账号</button>
    <div className="account-settings">
      {accounts.map((account, index) => <div key={account.id} className="account-setting" data-account-id={account.id}
          onDragOver={event => event.preventDefault()}
          onDrop={event => { event.preventDefault(); const from = Number(event.dataTransfer.getData('text/plain')); if (from && from !== account.id) { const rect = event.currentTarget.getBoundingClientRect(); const before = event.clientY < rect.top + rect.height / 2; void move(from, account.id, before); } }}>
        <span className="account-drag-handle" draggable
          onDragStart={event => { event.dataTransfer.setData('text/plain', String(account.id)); }}
          title="拖动调整顺序">⋮⋮</span>
        <NameInput ariaLabel={`${account.name}名称`} initial={account.name} onCommit={value => { const v = value.trim(); if (v && v !== account.name) void rename(account.id, v); }} />
        <AccountShortcutInput index={index} custom={indexKeyedShortcuts} refresh={refresh} message={setMessage} />
        <button className="delete-account" onClick={() => void remove(account)} title="删除账号">删除</button>
      </div>)}
    </div>
    <ResetAccountShortcuts refresh={refresh} message={setMessage} />
    {showNewAccount && <NewAccount onClose={() => setShowNewAccount(false)} onCreated={async () => { setShowNewAccount(false); await refresh(); }} />}
  </div>;
}
function NewAccount({ onClose, onCreated }: { onClose: () => void; onCreated: (account: Account) => Promise<void> }) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">
          <h2>添加豆包账号</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <form
          className="modal-card"
          onSubmit={async event => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            try {
              const account = await window.workspace.createAccount({
                name: name.trim(),
                note: note.trim(),
                sessionName: `persist:doubao_${Date.now().toString(36)}`,
              });
              await onCreated(account);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            账号名称
            <input
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="例如：主号"
              required
              autoFocus
            />
          </label>
          <label>
            备注
            <input
              value={note}
              onChange={event => setNote(event.target.value)}
              placeholder="可选"
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="outline" onClick={onClose}>取消</button>
            <button type="submit" className="primary" disabled={busy || !name.trim()}>
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
