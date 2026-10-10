import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, FolderOpen, GripVertical, MonitorPlay, Plus, Settings, Sparkles, Upload } from 'lucide-react';
import type { Account, DownloadStatus } from '../shared/types';
import './style.css';
import { UpscaleNotice } from './upscale-notice';
import { ImageAssetsPanel } from './image-assets-panel';
import { BarResizer, useResizableBar } from './resizable-bar';
import { ImageAssetsBar } from './image-assets-bar';
import { MessageSyncPanel } from './message-sync-panel';
import { AccountShortcutInput, ResetAccountShortcuts } from './account-shortcut-settings';
import { accountShortcut } from '../shared/account-shortcuts';

type Workspace = { accounts: Account[]; downloadDirectory: string; accountShortcuts: Record<string,string> };
const downloadNoticeTitle: Record<DownloadStatus['state'], string> = { started: '正在下载视频', completed: '视频已保存', duplicate: '已阻止重复下载', failed: '视频下载失败' };

function App() {
  const [data, setData] = useState<Workspace | null>(null);
  const [currentAccountId, setCurrentAccountId] = useState<number | null>(null);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState<DownloadStatus | null>(null);
  const [toast, setToast] = useState('');
  const startupAccountOpened = useRef(false);
  const message = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 2400); };
  const accountBar = useResizableBar('account', message);
  const refresh = async () => {
    const next = await window.workspace.load(); setData(next);
    setCurrentAccountId(old => next.accounts.some((a: Account) => a.id === old) ? old : null);
  };
  const openAccount = async (account?: Account) => {
    if (!account) return;
    try { await window.workspace.openAccount(account.id); setCurrentAccountId(account.id); }
    catch (error) { message(`打开账号失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  useEffect(() => {
    void refresh();
    const disposers = [window.workspace.onChanged(refresh), window.workspace.onAccountOpened(setCurrentAccountId),
      window.workspace.onBrowserError(message), window.workspace.onAccountSendStatus(message), window.workspace.onDownloadStatus(setDownloadNotice)];
    return () => disposers.forEach(dispose => dispose());
  }, []);
  useEffect(() => {
    if (!data || startupAccountOpened.current || !data.accounts.length) return;
    startupAccountOpened.current = true; void openAccount(data.accounts[0]);
  }, [data]);
  useEffect(() => {
    if (!downloadNotice || downloadNotice.state === 'started' || downloadNotice.state === 'completed') return;
    const timer = window.setTimeout(() => setDownloadNotice(null), 4200); return () => window.clearTimeout(timer);
  }, [downloadNotice]);
  if (!data) return <div className="loading">正在打开 Doubao Video Workspace...</div>;
  return <main className="app-shell browser-fullscreen">
    <header className="topbar" style={{ height: accountBar.height, '--account-scale': Math.max(0.75, Math.min(2.5, accountBar.height / 58)) } as React.CSSProperties}><div className="brand"><Sparkles size={19} /><span>Doubao Video Workspace</span></div>
      <div className="account-tabs">{data.accounts.map((account, index) => <button key={account.id} className={account.id === currentAccountId ? 'account active' : 'account'} onClick={() => void openAccount(account)} title={accountShortcut(index, data.accountShortcuts || {}) || undefined}><span className={account.isLoggedIn ? 'login-dot on' : 'login-dot'} />{account.name}</button>)}
        <button className="add-account" onClick={() => setShowNewAccount(true)} title="添加账号"><Plus size={15} />添加账号</button></div>
      <div className="topbar-actions"><button className="watermark-shortcut" onClick={() => void window.workspace.openImageAssets()}><Upload size={15} />图片资产</button>
      <button className="browser-size-toggle" title="设置" onClick={() => void window.workspace.openSettings()}><Settings size={15} />设置</button></div>
      <BarResizer bar={accountBar} />
    </header>
    <ImageAssetsBar accountId={currentAccountId} message={message} />
    {showNewAccount && <NewAccount onClose={() => setShowNewAccount(false)} onCreated={async account => { const next = await window.workspace.createAccount(account); setShowNewAccount(false); await refresh(); await openAccount(next); }} />}
    {downloadNotice && <div className={`download-notice ${downloadNotice.state}`} role="status"><div><b>{downloadNoticeTitle[downloadNotice.state]}</b><span>{downloadNotice.name}{downloadNotice.reason ? ` · ${downloadNotice.reason}` : ''}</span></div>
      {downloadNotice.state === 'completed' && downloadNotice.path && <button className="download-location" onClick={() => void window.workspace.openFolder(downloadNotice.path!)}>打开下载位置</button>}
      <button className="download-dismiss" aria-label="关闭下载提示" onClick={() => setDownloadNotice(null)}>×</button></div>}
    <UpscaleNotice />
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </main>;
}

function AccountNameInput({ account, onSaved, message }: { account: Account; onSaved: () => Promise<void>; message: (text: string) => void }) {
  const [draft, setDraft] = useState(account.name);
  const [saving, setSaving] = useState(false);
  const editing = useRef(false);
  const composing = useRef(false);
  const pending = useRef(false);
  const value = useRef(account.name);
  useEffect(() => {
    if (!editing.current && !pending.current) { value.current = account.name; setDraft(account.name); }
  }, [account.name]);
  const save = async () => {
    if (composing.current || pending.current) return;
    const name = value.current.trim();
    if (!name) { value.current = account.name; setDraft(account.name); message('账号名称不能为空'); return; }
    if (name === account.name) { setDraft(name); return; }
    pending.current = true; setSaving(true);
    try { await window.workspace.updateAccount(account.id, { name }); value.current = name; setDraft(name); await onSaved(); }
    catch (error) { message(`名称保存失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { pending.current = false; setSaving(false); }
  };
  return <input aria-label={`${account.name}名称`} value={draft} disabled={saving}
    onFocus={() => { editing.current = true; }}
    onChange={event => { value.current = event.target.value; setDraft(event.target.value); }}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={event => { composing.current = false; value.current = event.currentTarget.value; setDraft(event.currentTarget.value); if (!editing.current) void save(); }}
    onBlur={() => { editing.current = false; void save(); }}
    onKeyDown={event => { if (event.key === 'Enter' && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.currentTarget.blur(); } }} />;
}

function SettingsView({ data, refresh, message, onAddAccount, onOpenAccount }: { data: Workspace; refresh: () => Promise<void>; message: (s: string) => void; onAddAccount: () => void; onOpenAccount?: (account: Account) => void }) {
  const dragged = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: number; before: boolean } | null>(null);
  const [sorting, setSorting] = useState(false);
  const dropAccount = async (targetId: number, before: boolean) => {
    const id = dragged.current; dragged.current = null; setDropTarget(null);
    if (id === null || id === targetId || sorting) return;
    setSorting(true);
    try { await window.workspace.moveAccount(id, targetId, before); await refresh(); }
    catch (error) { message(`排序失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setSorting(false); }
  };
  const setDownloads = async () => { const folder = await window.workspace.selectDirectory(); if (folder) { await window.workspace.watchDownloads(folder); await refresh(); message('下载目录开始监听'); } }; const remove = async (account: Account) => { if (data.accounts.length <= 1) return message('至少保留一个账号'); try { const removed = await window.workspace.confirmDeleteAccount(account.id); if (!removed) return; await refresh(); message(`${account.name} 已删除`); } catch (error) { message(`删除失败：${error instanceof Error ? error.message : String(error)}`); } }; return <div className="settings-page"><div className="page-heading"><div><p className="eyebrow">本地设置</p><h1>账号与下载</h1></div><button className="primary" onClick={onAddAccount}><Plus size={16} />添加账号</button></div><section className="flat-panel settings-block"><div className="panel-head"><h2>下载监听目录</h2><button className="outline" onClick={() => void setDownloads()}><FolderOpen size={15} />选择目录</button></div><p>{data.downloadDirectory || '未设置。选择豆包视频下载保存的本地目录。'}</p></section><section className="flat-panel settings-block"><div className="panel-head"><h2>账号管理</h2><div className="account-management-actions"><span>拖动左侧手柄调整顺序</span><ResetAccountShortcuts refresh={refresh} message={message} /></div></div>{data.accounts.map((a, index) => <div className={`account-setting${dropTarget?.id === a.id ? dropTarget.before ? ' drop-before' : ' drop-after' : ''}`} key={a.id}
      onDragOver={event => { if (dragged.current === null || dragged.current === a.id || sorting) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const rect = event.currentTarget.getBoundingClientRect(); setDropTarget({ id: a.id, before: event.clientY < rect.top + rect.height / 2 }); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}
      onDrop={event => { if (dragged.current === null) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); void dropAccount(a.id, event.clientY < rect.top + rect.height / 2); }}>
      <button className="account-drag-handle" aria-label={`拖动排序 ${a.name}`} title="拖动调整账号顺序" draggable={!sorting}
        onDragStart={event => { if (sorting) { event.preventDefault(); return; } dragged.current = a.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(a.id)); }}
        onDragEnd={() => { dragged.current = null; setDropTarget(null); }}><GripVertical size={17} /></button><span><i className={a.isLoggedIn ? 'login-dot on' : 'login-dot'} />{a.name}</span><AccountNameInput account={a} onSaved={refresh} message={message} /><AccountShortcutInput index={index} custom={data.accountShortcuts || {}} refresh={refresh} message={message} /><button className="icon-button" title="打开账号" onClick={() => { if (onOpenAccount) onOpenAccount(a); else void window.workspace.openAccount(a.id); }}><MonitorPlay size={16} /></button><button className="delete-account" title="删除账号" onClick={() => void remove(a)}>删除</button></div>)}</section></div> }
function NewAccount({ onClose, onCreated }: { onClose: () => void; onCreated: (account: { name: string; note: string; platform: 'doubao' | 'dola' }) => void }) { const [name, setName] = useState(''); const [note, setNote] = useState(''); const [platform, setPlatform] = useState<'doubao' | 'dola'>('doubao'); return <Modal title="添加账号" onClose={onClose}><p className="modal-hint">每个账号都会创建独立浏览器 Session。选择 Dola 后会打开国际版 dola.com，请手动完成该账号登录。</p><label>平台<select value={platform} onChange={(e) => setPlatform(e.target.value as 'doubao' | 'dola')}><option value="doubao">豆包（国内版）</option><option value="dola">Dola（国际版）</option></select></label><label>账号名称<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={platform === 'dola' ? '例如：Dola 视频号' : '例如：豆包视频号B'} /></label><label>备注<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：备用号" /></label><div className="modal-actions"><button className="outline" onClick={onClose}>取消</button><button className="primary" disabled={!name.trim()} onClick={() => onCreated({ name: name.trim(), note: note.trim(), platform })}>创建</button></div></Modal> }
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) { return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal" onMouseDown={(e) => e.stopPropagation()}><div className="modal-title"><h2>{title}</h2><button onClick={onClose}>×</button></div>{children}</section></div> }
function SettingsApp() {
  const [data, setData] = useState<Workspace | null>(null);
  const [toast, setToast] = useState('');
  const [showNewAccount, setShowNewAccount] = useState(false);
  const message = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 2400); };
  const refresh = async () => setData(await window.workspace.load());
  useEffect(() => { void refresh(); return window.workspace.onChanged(() => { void refresh(); }); }, []);
  const openAndClose = async (id: number) => { await window.workspace.openAccount(id); window.close(); };
  if (!data) return <div className="loading">正在打开设置...</div>;
  return <main className="settings-window">
    <SettingsView data={data} refresh={refresh} message={message} onAddAccount={() => setShowNewAccount(true)} onOpenAccount={(account) => void openAndClose(account.id)} />
    {showNewAccount && <NewAccount onClose={() => setShowNewAccount(false)} onCreated={async (account) => { const next = await window.workspace.createAccount(account); setShowNewAccount(false); await window.workspace.openAccount(next.id); window.close(); }} />}
    {toast && <div className="toast"><Check size={16} />{toast}</div>}
  </main>;
}

const settingsPanel = new URLSearchParams(window.location.search).get('panel') === 'settings';
createRoot(document.getElementById('root')!).render(new URLSearchParams(window.location.search).get('panel') === 'message-sync' ? <MessageSyncPanel /> : new URLSearchParams(window.location.search).get('panel') === 'image-assets' ? <ImageAssetsPanel /> : settingsPanel ? <SettingsApp /> : <App />);



