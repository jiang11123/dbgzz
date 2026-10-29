import React from 'react';
import { 
  X, Clapperboard, Film, Image, CheckCircle, Clock, 
  ExternalLink, User, FolderOpen, Play, AlertTriangle
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
}

export function BeefTvDrawer({
  activeTab,
  onClose,
  nodes,
  accounts,
  onOpenAccount,
  onLocateNode,
}: BeefTvDrawerProps) {
  if (activeTab === 'canvas') return null;

  const videoNodes = nodes.filter(n => n.type === 'video');
  const runningTasks = videoNodes.filter(n => {
    const d = n.data as VideoNodeData;
    return d.status === 'queued' || d.status === 'processing';
  });

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
            <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>
              点击下方任一账号，可在当前窗口直接呼出豆包网页端完成登录、查看额度或进行滑块验证：
            </div>
            {accounts.map(acc => (
              <div key={acc.id} className="account-manage-item">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className={`status-dot ${acc.isLoggedIn ? '' : 'warning'}`} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{acc.name}</div>
                    <div style={{ fontSize: '11px', color: '#9ca3af' }}>{acc.isLoggedIn ? '已登录 · 会话可用' : '未登录 / 需验证'}</div>
                  </div>
                </div>
                <button
                  className="beeftv-btn beeftv-btn-primary"
                  style={{ padding: '3px 10px', fontSize: '11px' }}
                  onClick={() => onOpenAccount(acc)}
                >
                  打开网页验证
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
