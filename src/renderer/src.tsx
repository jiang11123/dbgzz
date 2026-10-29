import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, FolderOpen, Plus, Settings, Play, RefreshCw, LayoutGrid, Globe, ShieldCheck } from 'lucide-react';
import type { Account, DownloadStatus } from '../shared/types';
import './style.css';
import './theme.css';
import { ThemeToggle } from './theme';
import { BeefTvCanvas } from './beeftv-canvas/BeefTvCanvas';
import { BeefTvTopBar } from './beeftv-canvas/BeefTvTopBar';
import { BeefTvSidebar, type BeefTvActiveTab } from './beeftv-canvas/BeefTvSidebar';
import { BeefTvDrawer } from './beeftv-canvas/BeefTvDrawer';
import { useCanvasState } from './beeftv-canvas/useCanvasState';
import { useCanvasKeyboard } from './beeftv-canvas/useCanvasKeyboard';
import { GatewayPanel } from './gateway-panel';
import { DonationPanel } from './donation-panel';

type Workspace = { accounts: Account[]; downloadDirectory: string; accountShortcuts: Record<string, string> };

function App() {
  const panel = new URLSearchParams(window.location.search).get('panel');
  if (panel === 'settings') return <div className="settings-page"><SettingsPage /></div>;
  if (panel === 'gateway') return <GatewayPanel />;
  if (panel === 'donation') return <DonationPanel />;

  const [data, setData] = useState<Workspace | null>(null);
  const [currentAccountId, setCurrentAccountId] = useState<number | null>(null);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState<DownloadStatus | null>(null);
  const [toast, setToast] = useState('');
  const [mode, setMode] = useState<'account' | 'beeftv'>('account');

  // BeefTV 画布状态
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<BeefTvActiveTab>('canvas');
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  const message = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 2600);
  };

  const canvas = useCanvasState(8788, data?.accounts || []);

  useCanvasKeyboard({
    selectedNodeId: canvas.selectedNodeId,
    onRemoveNode: canvas.removeNode,
    onResetView: canvas.resetViewport,
    onZoomIn: () => canvas.setScale(Math.min(2.5, canvas.scale + 0.15)),
    onZoomOut: () => canvas.setScale(Math.max(0.25, canvas.scale - 0.15)),
    setIsSpacePressed,
  });

  const refresh = async () => {
    const next = await window.workspace.load();
    setData(next);
    if (!currentAccountId && next.accounts?.length) {
      setCurrentAccountId(next.accounts[0].id);
    }
  };

  const openAccount = async (account?: Account) => {
    if (!account) return;
    try {
      await window.workspace.openAccount(account.id);
      setCurrentAccountId(account.id);
      if (mode !== 'account') {
        setMode('account');
      }
    } catch (error) {
      message(`打开账号失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const switchToCanvas = async () => {
    await window.workspace.hideBrowser();
    setMode('beeftv');
  };

  const switchToAccount = async (account?: Account) => {
    const target = account || data?.accounts?.find(a => a.id === currentAccountId) || data?.accounts?.[0];
    if (target) {
      await openAccount(target);
    } else {
      setShowNewAccount(true);
    }
  };

  const launchBeefTv = async () => {
    const ok = await window.workspace.beeftvLaunch();
    if (ok) {
      message('🚀 正在启动原生态 BeefTV 客户端...');
    } else {
      message('未找到 BeefTV 安装程序，请确认 E:\\beeftv\\BeefTV.exe 路径');
    }
  };

  const syncToBeefTv = async () => {
    const res = await window.workspace.beeftvSync();
    if (res.ok) {
      message(`⚡ 已成功将 ${res.count} 个账号与模型配置同步至 BeefTV！`);
    } else {
      message(`同步失败：${res.error || '未知错误'}`);
    }
  };

  useEffect(() => {
    void refresh().then(async () => {
      // 启动时默认打开第一个账号网页，供用户快速扫码或确认登录
      const initial = await window.workspace.load();
      if (initial?.accounts?.length) {
        const first = initial.accounts[0];
        setCurrentAccountId(first.id);
        void window.workspace.openAccount(first.id);
      }
    });

    const offChanged = window.workspace.onChanged(() => void refresh());
    const offDownload = window.workspace.onDownloadStatus((notice) => {
      setDownloadNotice(notice);
      if (notice.state === 'completed') {
        message(`视频下载成功：${notice.name}`);
      }
    });

    return () => {
      offChanged();
      offDownload();
    };
  }, []);

  if (!data) {
    return <div className="loading" style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>正在加载豆奶画布...</div>;
  }

  const currentAccount = data.accounts.find(a => a.id === currentAccountId);

  return (
    <main className="app-shell browser-fullscreen" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* 统一顶部控制台导航条 */}
      <header className="topbar" style={{ height: '54px', borderBottom: '1px solid #2d333b', padding: '0 16px', display: 'flex', alignItems: 'center', gap: '12px', background: '#181b20', flexShrink: 0, zIndex: 10 }}>
        {/* Logo 与网关运行标识 */}
        <div className="brand" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }} onClick={() => void switchToAccount()}>
          <span style={{ fontWeight: 700, fontSize: '15px', color: '#fff', letterSpacing: '-0.2px' }}>豆奶画布</span>
          <span style={{ background: '#2563eb', color: '#fff', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>3.0</span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', background: 'rgba(34, 197, 94, 0.15)', border: '1px solid rgba(34, 197, 94, 0.3)', padding: '2px 7px', borderRadius: '12px', fontSize: '11px', color: '#4ade80' }} title="本地网关正常监听在 127.0.0.1:8788">
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e' }} />
            网关 8788
          </div>
        </div>

        {/* 账号快速切换标签 */}
        <div className="account-tabs" style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, overflowX: 'auto', padding: '0 4px' }}>
          {data.accounts.map(acc => (
            <button
              key={acc.id}
              className={`account ${acc.id === currentAccountId && mode === 'account' ? 'active' : ''}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                height: '32px',
                padding: '0 10px',
                borderRadius: '6px',
                border: acc.id === currentAccountId && mode === 'account' ? '1px solid #3b82f6' : '1px solid #30363d',
                background: acc.id === currentAccountId && mode === 'account' ? '#1e293b' : '#21262d',
                color: acc.id === currentAccountId && mode === 'account' ? '#60a5fa' : '#c9d1d9',
                fontSize: '12px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              onClick={() => void openAccount(acc)}
              title={`点击切换到【${acc.name}】进行网页扫码登录或对话`}
            >
              <span className={`login-dot ${acc.isLoggedIn ? 'on' : ''}`} style={{ width: '7px', height: '7px', borderRadius: '50%', background: acc.isLoggedIn ? '#22c55e' : '#f59e0b' }} />
              <span>{acc.name}</span>
            </button>
          ))}

          {/* + 添加账号按钮 */}
          <button
            className="add-account"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              height: '32px',
              padding: '0 10px',
              borderRadius: '6px',
              border: '1px dashed #3b82f6',
              background: 'rgba(59, 130, 246, 0.08)',
              color: '#60a5fa',
              fontSize: '12px',
              cursor: 'pointer',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
            onClick={() => setShowNewAccount(true)}
            title="添加新的豆包账号并扫码登录"
          >
            <Plus size={14} />
            添加豆包账号
          </button>
        </div>

        {/* BeefTV 协同操作按钮区 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          {/* 启动原生态 BeefTV 按钮 */}
          <button
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '32px',
              padding: '0 12px',
              borderRadius: '6px',
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(37, 99, 235, 0.35)',
            }}
            onClick={launchBeefTv}
            title="启动本地安装的原生态 BeefTV 客户端"
          >
            <Play size={13} fill="#fff" />
            启动原生态 BeefTV
          </button>

          {/* 一键同步至 BeefTV */}
          <button
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              height: '32px',
              padding: '0 10px',
              borderRadius: '6px',
              background: '#21262d',
              color: '#c9d1d9',
              border: '1px solid #30363d',
              fontSize: '12px',
              cursor: 'pointer',
            }}
            onClick={syncToBeefTv}
            title="将所有豆包账号与网关配置一键同步写入 BeefTV 数据库"
          >
            <RefreshCw size={13} />
            同步至 BeefTV
          </button>

          {/* 视图模式切换：网页登录 VS 内置画布 */}
          <div style={{ display: 'inline-flex', background: '#16191d', padding: '2px', borderRadius: '6px', border: '1px solid #30363d' }}>
            <button
              style={{
                height: '28px',
                padding: '0 10px',
                borderRadius: '4px',
                border: 'none',
                background: mode === 'account' ? '#30363d' : 'transparent',
                color: mode === 'account' ? '#fff' : '#8b949e',
                fontSize: '12px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                cursor: 'pointer',
              }}
              onClick={() => void switchToAccount()}
              title="查看与扫码登录豆包网页"
            >
              <Globe size={13} />
              账号网页
            </button>
            <button
              style={{
                height: '28px',
                padding: '0 10px',
                borderRadius: '4px',
                border: 'none',
                background: mode === 'beeftv' ? '#30363d' : 'transparent',
                color: mode === 'beeftv' ? '#fff' : '#8b949e',
                fontSize: '12px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                cursor: 'pointer',
              }}
              onClick={() => void switchToCanvas()}
              title="切换到内置 BeefTV 节点画布"
            >
              <LayoutGrid size={13} />
              内置画布
            </button>
          </div>

          <ThemeToggle />

          <button
            className="browser-size-toggle"
            style={{ height: '32px', width: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#21262d', border: '1px solid #30363d', borderRadius: '6px', color: '#c9d1d9', cursor: 'pointer' }}
            title="系统与网关设置"
            onClick={() => void window.workspace.openSettings()}
          >
            <Settings size={15} />
          </button>
        </div>
      </header>

      {/* 主工作区 */}
      {mode === 'account' ? (
        // 模式 1: 豆包账号官方网页（支持微信扫码登录、人机验证与会话同步）
        <div style={{ flex: 1, position: 'relative', width: '100%', height: 'calc(100vh - 54px)', background: '#17191d' }}>
          {/* 页面底部提示条 */}
          <div
            style={{
              position: 'absolute',
              bottom: 12,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(23, 25, 29, 0.92)',
              backdropFilter: 'blur(8px)',
              border: '1px solid #30363d',
              borderRadius: '24px',
              padding: '6px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              zIndex: 5,
              fontSize: '12px',
              color: '#94a3b8',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              pointerEvents: 'none',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#38bdf8' }}>
              <ShieldCheck size={14} />
              当前活跃账号：<strong style={{ color: '#fff' }}>{currentAccount?.name || '未选择'}</strong>
            </span>
            <span style={{ color: '#475569' }}>|</span>
            <span>💡 扫码登录后该账号即自动同步进入 BeefTV 节点模型库，可直接在原生态 BeefTV 任意画布中被选用！</span>
          </div>
        </div>
      ) : (
        // 模式 2: 内置 BeefTV 节点画布
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex' }}>
          <BeefTvSidebar
            activeTab={activeTab}
            onSelectTab={setActiveTab}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            accountCount={data.accounts.length}
            loggedInCount={data.accounts.filter(a => a.isLoggedIn).length}
            runningTaskCount={0}
            onOpenSettings={() => void window.workspace.openSettings()}
            onOpenGateway={() => void window.workspace.openGateway()}
          />

          <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <BeefTvTopBar
              accounts={data.accounts}
              currentAccountId={currentAccountId}
              gatewayPort={8788}
              onAddNode={canvas.addNode}
              onOpenAccount={openAccount}
              onAddAccount={() => setShowNewAccount(true)}
              onSwitchMode={(m) => (m === 'account' ? void switchToAccount() : void switchToCanvas())}
              activeMode={mode}
            />

            <BeefTvCanvas
              nodes={canvas.nodes}
              connections={canvas.connections}
              selectedNodeId={canvas.selectedNodeId}
              accounts={data.accounts}
              pan={canvas.pan}
              scale={canvas.scale}
              onPanChange={canvas.setPan}
              onScaleChange={canvas.setScale}
              onSelectNode={canvas.setSelectedNodeId}
              onNodeMove={canvas.updateNodePosition}
              onNodeDataChange={canvas.updateNodeData}
              onRemoveNode={canvas.removeNode}
              onConnect={canvas.connectNodes}
              onRelayNext={canvas.relayNextShot}
              onGenerateVideo={canvas.generateVideoForNode}
              onSendToDoubaoAccount={canvas.sendPromptToDoubaoAccount}
              onResetView={canvas.resetViewport}
            />

            <BeefTvDrawer
              activeTab={activeTab}
              onClose={() => setActiveTab('canvas')}
              nodes={canvas.nodes}
              accounts={data.accounts}
              onOpenAccount={openAccount}
              onLocateNode={(nodeId) => {
                canvas.setSelectedNodeId(nodeId);
                setActiveTab('canvas');
              }}
            />
          </div>
        </div>
      )}

      {/* 新增账号弹窗 */}
      {showNewAccount && (
        <NewAccount
          onClose={() => setShowNewAccount(false)}
          onCreated={async account => {
            setShowNewAccount(false);
            await refresh();
            await openAccount(account);
            await syncToBeefTv();
            message(`已添加账号【${account.name}】！请在下方扫码登录豆包，该账号已同步至 BeefTV。`);
          }}
        />
      )}

      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </main>
  );
}

function SettingsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [dir, setDir] = useState('');
  const [toast, setToast] = useState('');

  const message = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 2400); };
  const refresh = async () => {
    const data = await window.workspace.load();
    setAccounts(data.accounts);
    setDir(data.downloadDirectory);
  };

  useEffect(() => { void refresh(); }, []);

  const chooseDir = async () => {
    const selected = await window.workspace.selectDirectory();
    if (!selected) return;
    await window.workspace.watchDownloads(selected);
    setDir(selected);
    message('下载保存目录已更新');
  };

  const deleteAccount = async (id: number) => {
    const confirmed = await window.workspace.confirmDeleteAccount(id);
    if (!confirmed) return;
    await refresh();
    await window.workspace.beeftvSync();
    message('账号已移除并同步至 BeefTV');
  };

  return (
    <div className="settings-page">
      <h2>设置中心</h2>
      <section className="settings-section">
        <h3>下载与存储</h3>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input type="text" readOnly value={dir} style={{ flex: 1 }} />
          <button className="outline" onClick={chooseDir}><FolderOpen size={14} />选择文件夹</button>
        </div>
      </section>

      <section className="settings-section">
        <h3>豆包账号池管理</h3>
        <div className="accounts-list">
          {accounts.map(acc => (
            <div key={acc.id} className="account-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #30363d' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className={`status-dot ${acc.isLoggedIn ? '' : 'warning'}`} style={{ width: '8px', height: '8px', borderRadius: '50%', background: acc.isLoggedIn ? '#22c55e' : '#f59e0b' }} />
                <span style={{ fontWeight: 600 }}>{acc.name}</span>
              </div>
              <button className="outline danger" onClick={() => void deleteAccount(acc.id)}>删除</button>
            </div>
          ))}
        </div>
      </section>
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  );
}

function NewAccount({ onClose, onCreated }: { onClose: () => void; onCreated: (account: Account) => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('请输入账号名称');
    setBusy(true);
    try {
      const created = await window.workspace.createAccount({ name: name.trim(), platform: 'doubao', note: '' });
      await onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h3>添加新豆包账号</h3>
        <form onSubmit={submit}>
          <div className="form-item">
            <label>账号名称</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例如：主号、生图号A、视频号B"
              autoFocus
            />
          </div>
          {error && <div className="error-text">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="outline" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className="primary" disabled={busy}>创建并开始扫码登录</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
