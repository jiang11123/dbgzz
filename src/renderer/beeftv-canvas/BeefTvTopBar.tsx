import React, { useState } from 'react';
import { 
  Plus, Sparkles, Film, Image, Server, Users, 
  Bot, Volume2, FileText, Layout, User, ChevronDown, Check
} from 'lucide-react';
import type { CanvasNodeType } from './types';
import type { Account } from '../../shared/types';

interface BeefTvTopBarProps {
  accounts: Account[];
  currentAccountId: number | null;
  gatewayPort: number;
  onAddNode: (type: CanvasNodeType) => void;
  onOpenAccount: (account: Account) => void;
  onAddAccount: () => void;
  onSwitchMode: (mode: 'beeftv' | 'account') => void;
  activeMode: 'beeftv' | 'account';
}

export function BeefTvTopBar({
  accounts,
  currentAccountId,
  gatewayPort,
  onAddNode,
  onOpenAccount,
  onAddAccount,
  onSwitchMode,
  activeMode,
}: BeefTvTopBarProps) {
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const loggedInAccounts = accounts.filter(a => a.isLoggedIn);

  return (
    <header className="beeftv-topbar">
      {/* 品牌标识 */}
      <div className="beeftv-brand">
        <span className="beeftv-badge">BeefTV 原生画布</span>
        <span style={{ color: '#9ca3af' }}>|</span>
        <span style={{ fontSize: '13px' }}>AI 节点工作台</span>
      </div>

      {/* 中部：BeefTV 原生节点全套添加工具箱 */}
      <div className="beeftv-topbar-tools">
        {/* 1. 专属豆包账号节点 (用户定制亮点) */}
        <button
          className="beeftv-btn beeftv-btn-primary"
          onClick={() => onAddNode('doubao_account')}
          title="添加单独的豆包账号节点：选择指定账号，直接把文字发送给该账号"
        >
          <User size={13} />
          <span>+ 豆包账号节点</span>
        </button>

        {/* 2. 剧本大纲节点 */}
        <button
          className="beeftv-btn"
          onClick={() => onAddNode('script')}
          title="添加剧本 / 灵感大纲节点"
        >
          <Sparkles size={13} style={{ color: '#f59e0b' }} />
          <span>+ 剧本大纲</span>
        </button>

        {/* 3. 分镜生图节点 */}
        <button
          className="beeftv-btn"
          onClick={() => onAddNode('image')}
          title="添加分镜生图节点"
        >
          <Image size={13} style={{ color: '#3b82f6' }} />
          <span>+ 分镜生图</span>
        </button>

        {/* 4. 图生视频接力节点 */}
        <button
          className="beeftv-btn"
          onClick={() => onAddNode('video')}
          title="添加图生视频与首尾帧接力节点"
        >
          <Film size={13} style={{ color: '#e86c36' }} />
          <span>+ 图生视频</span>
        </button>

        {/* 5. 更多 BeefTV 原生节点下拉菜单 */}
        <div style={{ position: 'relative' }}>
          <button
            className="beeftv-btn"
            onClick={() => setShowMoreMenu(prev => !prev)}
            title="更多原生节点"
          >
            <span>更多节点</span>
            <ChevronDown size={12} />
          </button>

          {showMoreMenu && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: '6px',
                background: '#181a20',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: '8px',
                boxShadow: '0 10px 25px rgba(0,0,0,0.6)',
                display: 'flex',
                flexDirection: 'column',
                minWidth: '150px',
                zIndex: 100,
                padding: '4px',
              }}
              onMouseLeave={() => setShowMoreMenu(false)}
            >
              <button
                className="beeftv-btn"
                style={{ width: '100%', justifyContent: 'flex-start', border: 'none', background: 'transparent' }}
                onClick={() => { onAddNode('director'); setShowMoreMenu(false); }}
              >
                <Bot size={13} style={{ color: '#8b5cf6' }} />
                <span>+ 导演 AI 顾问</span>
              </button>

              <button
                className="beeftv-btn"
                style={{ width: '100%', justifyContent: 'flex-start', border: 'none', background: 'transparent' }}
                onClick={() => { onAddNode('audio'); setShowMoreMenu(false); }}
              >
                <Volume2 size={13} style={{ color: '#06b6d4' }} />
                <span>+ 旁白/音频节点</span>
              </button>

              <button
                className="beeftv-btn"
                style={{ width: '100%', justifyContent: 'flex-start', border: 'none', background: 'transparent' }}
                onClick={() => { onAddNode('markdown'); setShowMoreMenu(false); }}
              >
                <FileText size={13} style={{ color: '#a855f7' }} />
                <span>+ 世界观设定笔记</span>
              </button>

              <button
                className="beeftv-btn"
                style={{ width: '100%', justifyContent: 'flex-start', border: 'none', background: 'transparent' }}
                onClick={() => { onAddNode('frame'); setShowMoreMenu(false); }}
              >
                <Layout size={13} style={{ color: '#9ca3af' }} />
                <span>+ 幕/场次分组框</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 右侧：双引擎状态与账号快捷切换 */}
      <div className="beeftv-topbar-status">
        {/* 本地网关状态 */}
        <div className="status-pill" title={`本地 OpenAI 兼容网关运行中 (127.0.0.1:${gatewayPort})`}>
          <div className="status-dot" />
          <Server size={12} style={{ color: '#9ca3af' }} />
          <span>网关 127.0.0.1:{gatewayPort}</span>
        </div>

        {/* 账号池健康状态 */}
        <div className="status-pill" title="已配置的豆包账号总览">
          <div className={`status-dot ${loggedInAccounts.length === 0 ? 'warning' : ''}`} />
          <Users size={12} style={{ color: '#9ca3af' }} />
          <span>账号池 ({loggedInAccounts.length}/{accounts.length} 在线)</span>
        </div>

        {/* 快捷账号标签：点击可切换到网页版完成登录或滑块验证 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {accounts.map(acc => (
            <button
              key={acc.id}
              className="beeftv-btn"
              style={{
                padding: '2px 8px',
                fontSize: '11px',
                borderColor: activeMode === 'account' && currentAccountId === acc.id ? '#e86c36' : undefined,
                background: activeMode === 'account' && currentAccountId === acc.id ? 'rgba(232, 108, 54, 0.2)' : undefined,
              }}
              onClick={() => onOpenAccount(acc)}
              title={`点击切换到 ${acc.name} 网页窗口 (可进行手动登录或滑块验证)`}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: acc.isLoggedIn ? '#22c55e' : '#ef4444',
                  marginRight: '4px',
                }}
              />
              {acc.name}
            </button>
          ))}
          <button
            className="beeftv-btn"
            style={{ padding: '2px 6px', fontSize: '11px' }}
            onClick={onAddAccount}
            title="添加新豆包账号"
          >
            <Plus size={12} />
          </button>
        </div>

        {activeMode === 'account' && (
          <button
            className="beeftv-btn beeftv-btn-primary"
            onClick={() => onSwitchMode('beeftv')}
          >
            返回 BeefTV 画布
          </button>
        )}
      </div>
    </header>
  );
}
