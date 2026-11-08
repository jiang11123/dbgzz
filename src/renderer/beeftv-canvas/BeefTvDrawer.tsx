import React, { useState } from 'react';
import { 
  X, Clapperboard, Film, Image, CheckCircle, Clock, 
  ExternalLink, User, FolderOpen, Play, AlertTriangle, Plus, Edit2, Check
} from 'lucide-react';
import type { CanvasNode, VideoNodeData, ImageNodeData, ScriptNodeData } from './types';
import type { Account } from '../../shared/types';
import type { BeefTvActiveTab } from './BeefTvSidebar';

interface BeefTvDrawerProps {
  activeTab: BeefTvActiveTab;
  onClose: () => void;
  nodes: CanvasNode[];
  accounts: Account[];
  onOpenAccount: (account: Account) => void;
  onLocateNode: (nodeId: string) => void;
  onAddAccount?: () => void;
  onUpdateNote?: (accountId: number, note: string) => Promise<void>;
  onEditAccount?: (account: Account) => void;
}

export function BeefTvDrawer({
  activeTab,
  onClose,
  nodes,
  accounts,
  onOpenAccount,
  onLocateNode,
  onAddAccount,
  onUpdateNote,
  onEditAccount,
}: BeefTvDrawerProps) {
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  if (activeTab === 'canvas') return null;

  const videoNodes = nodes.filter(n => n.type === 'video');
  const runningTasks = videoNodes.filter(n => {
    const d = n.data as VideoNodeData;
    return d.status === 'queued' || d.status === 'processing';
  });

  const handleSaveNote = async (id: number) => {
    if (onUpdateNote) {
      await onUpdateNote(id, noteDraft.trim());
    }
    setEditingAccountId(null);
  };

  return (
    <aside className="beeftv-drawer">
      <div className="drawer-header">
        <div className="drawer-title">
          {activeTab === 'storyboard' && <><Clapperboard size={16} /><span>分镜剧本时序流</span></>}
          {activeTab === 'tasks' && <><Clock size={16} /><span>任务队列监控 ({runningTasks.length} 运行中)</span></>}
          {activeTab === 'assets' && <><Film size={16} /><span>本地已生成素材</span></>}
          {activeTab === 'accounts' && <><User size={16} /><span>豆包账号管理</span></>}
        </div>
        <button className="drawer-close-btn" onClick={onClose} title="关闭抽屉">
          <X size={15} />
        </button>
      </div>

      <div className="drawer-content">
        {/* 1. 分镜剧本时序流 */}
        {activeTab === 'storyboard' && (
          <div className="storyboard-list">
            {videoNodes.length === 0 ? (
              <div className="drawer-empty">画布中暂无视频分镜节点，请从顶部添加</div>
            ) : (
              videoNodes.map((n, idx) => {
                const d = n.data as VideoNodeData;
                return (
                  <div key={n.id} className="storyboard-card" onClick={() => onLocateNode(n.id)}>
                    <div className="storyboard-card-head">
                      <span className="storyboard-badge">镜头 {d.sceneNumber || idx + 1}</span>
                      <span className={`status-tag ${d.status}`}>{d.status}</span>
                    </div>
                    <p className="storyboard-prompt">{d.prompt || '暂未填写运镜提示词'}</p>
                    {d.videoUrl && (
                      <div className="storyboard-preview">
                        <video src={d.videoUrl} muted autoPlay loop />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* 2. 任务队列监控 */}
        {activeTab === 'tasks' && (
          <div className="task-queue-list">
            {runningTasks.length === 0 ? (
              <div className="drawer-empty">当前没有正在渲染的视频任务</div>
            ) : (
              runningTasks.map(n => {
                const d = n.data as VideoNodeData;
                return (
                  <div key={n.id} className="task-queue-card" onClick={() => onLocateNode(n.id)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <b>{d.title}</b>
                      <span>{d.progress}%</span>
                    </div>
                    <div className="node-progress-bar">
                      <div className="node-progress-fill" style={{ width: `${d.progress}%` }} />
                    </div>
                    <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '6px' }}>
                      {d.statusText || '正在处理中...'}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* 3. 本地素材库 */}
        {activeTab === 'assets' && (
          <div className="assets-grid">
            {videoNodes.filter(n => (n.data as VideoNodeData).status === 'completed').map(n => {
              const d = n.data as VideoNodeData;
              return (
                <div key={n.id} className="asset-grid-card">
                  <div className="asset-preview-wrapper">
                    {d.videoUrl ? <video src={d.videoUrl} muted controls /> : <Film size={20} />}
                  </div>
                  <div style={{ padding: '8px', fontSize: '11px' }}>
                    <div style={{ fontWeight: 600, color: '#f3f4f6', marginBottom: '2px' }}>{d.title}</div>
                    <div style={{ color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.localPath || '已导出到下载目录'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 4. 豆包账号管理 */}
        {activeTab === 'accounts' && (
          <div className="accounts-management-list">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ fontSize: '12px', color: '#9ca3af' }}>
                共 {accounts.length} 个账号，点击可切换至网页验证
              </div>
              {onAddAccount && (
                <button
                  className="beeftv-btn beeftv-btn-primary"
                  style={{ padding: '3px 8px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  onClick={onAddAccount}
                  title="添加新豆包账号（支持备注）"
                >
                  <Plus size={12} />
                  <span>添加账号</span>
                </button>
              )}
            </div>

            {accounts.map(acc => (
              <div key={acc.id} className="account-manage-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className={`status-dot ${acc.isLoggedIn ? '' : 'warning'}`} />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span>{acc.name}</span>
                        {acc.note && (
                          <span style={{
                            fontSize: '11px',
                            fontWeight: 'normal',
                            color: '#34d399',
                            background: 'rgba(52, 211, 153, 0.12)',
                            padding: '1px 6px',
                            borderRadius: '4px'
                          }}>
                            {acc.note}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: '#9ca3af' }}>
                        {acc.isLoggedIn ? '已登录 · 会话可用' : '未登录 / 需验证'}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <button
                      className="beeftv-btn"
                      style={{ padding: '3px 8px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                      onClick={() => {
                        if (onEditAccount) {
                          onEditAccount(acc);
                        } else {
                          setEditingAccountId(acc.id);
                          setNoteDraft(acc.note || '');
                        }
                      }}
                      title="修改备注与账号名称"
                    >
                      <Edit2 size={11} />
                      <span>{acc.note ? '改备注' : '加备注'}</span>
                    </button>
                    <button
                      className="beeftv-btn beeftv-btn-primary"
                      style={{ padding: '3px 10px', fontSize: '11px' }}
                      onClick={() => onOpenAccount(acc)}
                    >
                      打开网页
                    </button>
                  </div>
                </div>

                {/* 编辑备注内联输入框 */}
                {editingAccountId === acc.id && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 8px',
                    background: 'rgba(0,0,0,0.3)',
                    borderRadius: '6px',
                    marginTop: '2px'
                  }}>
                    <input
                      type="text"
                      value={noteDraft}
                      onChange={e => setNoteDraft(e.target.value)}
                      placeholder="输入账号备注（如：主号、主力生图、138...）"
                      style={{
                        flex: 1,
                        background: '#12141a',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: '4px',
                        padding: '3px 8px',
                        color: '#fff',
                        fontSize: '11px',
                        outline: 'none',
                      }}
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === 'Enter') void handleSaveNote(acc.id);
                        if (e.key === 'Escape') setEditingAccountId(null);
                      }}
                    />
                    <button
                      className="beeftv-btn beeftv-btn-primary"
                      style={{ padding: '3px 8px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                      onClick={() => void handleSaveNote(acc.id)}
                    >
                      <Check size={11} />
                      <span>保存</span>
                    </button>
                    <button
                      className="beeftv-btn"
                      style={{ padding: '3px 8px', fontSize: '11px' }}
                      onClick={() => setEditingAccountId(null)}
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
