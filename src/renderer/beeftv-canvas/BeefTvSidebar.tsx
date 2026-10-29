import React from 'react';
import { 
  Layers, Clapperboard, FolderKanban, ListTodo, 
  Users, Settings, Server, ChevronLeft, ChevronRight, Sparkles
} from 'lucide-react';

export type BeefTvActiveTab = 'canvas' | 'storyboard' | 'assets' | 'tasks' | 'accounts';

interface BeefTvSidebarProps {
  activeTab: BeefTvActiveTab;
  onSelectTab: (tab: BeefTvActiveTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  accountCount: number;
  loggedInCount: number;
  runningTaskCount: number;
  onOpenSettings: () => void;
  onOpenGateway: () => void;
}

export function BeefTvSidebar({
  activeTab,
  onSelectTab,
  collapsed,
  onToggleCollapse,
  accountCount,
  loggedInCount,
  runningTaskCount,
  onOpenSettings,
  onOpenGateway,
}: BeefTvSidebarProps) {
  return (
    <aside className={`beeftv-sidebar ${collapsed ? 'is-collapsed' : ''}`}>
      {/* 顶部 Logo 区 */}
      <div className="beeftv-sidebar-header">
        <div className="beeftv-logo-icon">
          <Sparkles size={18} style={{ color: '#fff' }} />
        </div>
        {!collapsed && (
          <div className="beeftv-logo-text">
            <b>BeefTV</b>
            <span>Studio 3.0</span>
          </div>
        )}
      </div>

      {/* 导航菜单区 */}
      <nav className="beeftv-sidebar-nav">
        <button
          className={`sidebar-nav-item ${activeTab === 'canvas' ? 'active' : ''}`}
          onClick={() => onSelectTab('canvas')}
          title="无限节点画布"
        >
          <Layers size={18} />
          {!collapsed && <span>创作画布</span>}
        </button>

        <button
          className={`sidebar-nav-item ${activeTab === 'storyboard' ? 'active' : ''}`}
          onClick={() => onSelectTab('storyboard')}
          title="分镜接力流"
        >
          <Clapperboard size={18} />
          {!collapsed && <span>分镜剧本</span>}
        </button>

        <button
          className={`sidebar-nav-item ${activeTab === 'assets' ? 'active' : ''}`}
          onClick={() => onSelectTab('assets')}
          title="本地资产库"
        >
          <FolderKanban size={18} />
          {!collapsed && <span>媒体资产</span>}
        </button>

        <button
          className={`sidebar-nav-item ${activeTab === 'tasks' ? 'active' : ''}`}
          onClick={() => onSelectTab('tasks')}
          title="生成任务队列"
        >
          <ListTodo size={18} />
          {!collapsed && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <span>任务队列</span>
              {runningTaskCount > 0 && (
                <span className="sidebar-badge">{runningTaskCount}</span>
              )}
            </div>
          )}
        </button>

        <button
          className={`sidebar-nav-item ${activeTab === 'accounts' ? 'active' : ''}`}
          onClick={() => onSelectTab('accounts')}
          title="豆包账号池"
        >
          <Users size={18} />
          {!collapsed && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <span>豆包账号</span>
              <span className="sidebar-badge secondary">{loggedInCount}/{accountCount}</span>
            </div>
          )}
        </button>
      </nav>

      {/* 底部系统配置区 */}
      <div className="beeftv-sidebar-footer">
        <button className="sidebar-footer-btn" onClick={onOpenGateway} title="本地网关服务设置">
          <Server size={16} />
          {!collapsed && <span>API 网关</span>}
        </button>

        <button className="sidebar-footer-btn" onClick={onOpenSettings} title="工作区设置">
          <Settings size={16} />
          {!collapsed && <span>设置</span>}
        </button>

        <button className="sidebar-toggle-btn" onClick={onToggleCollapse} title={collapsed ? '展开侧边栏' : '折叠侧边栏'}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>
    </aside>
  );
}
