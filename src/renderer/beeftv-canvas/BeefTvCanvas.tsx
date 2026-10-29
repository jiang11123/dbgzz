import React, { useRef, useState, useCallback, useMemo } from 'react';
import { 
  Film, Image, Sparkles, Play, Plus, Trash2, ArrowRight, 
  Maximize2, ZoomIn, ZoomOut, RotateCcw, Send, Bot, 
  Volume2, FileText, Layout, CheckCircle2, User, RefreshCw, FastForward
} from 'lucide-react';
import type { 
  CanvasNode, CanvasConnection, VideoNodeData, 
  ImageNodeData, ScriptNodeData, DoubaoAccountNodeData,
  DirectorNodeData, AudioNodeData, MarkdownNodeData, FrameNodeData
} from './types';
import type { Account } from '../../shared/types';
import './beeftv-canvas.css';

interface BeefTvCanvasProps {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  selectedNodeId: string | null;
  accounts: Account[];
  pan: { x: number; y: number };
  scale: number;
  onPanChange: (pan: { x: number; y: number }) => void;
  onScaleChange: (scale: number) => void;
  onSelectNode: (id: string | null) => void;
  onNodeMove: (id: string, dx: number, dy: number) => void;
  onNodeDataChange: (id: string, patch: Record<string, any>) => void;
  onRemoveNode: (id: string) => void;
  onConnect: (fromNodeId: string, fromPort: any, toNodeId: string, toPort: any) => void;
  onRelayNext: (sourceNodeId: string) => void;
  onGenerateVideo: (nodeId: string) => void;
  onSendToDoubaoAccount: (nodeId: string) => void;
  onResetView: () => void;
}

export function BeefTvCanvas({
  nodes,
  connections,
  selectedNodeId,
  accounts,
  pan,
  scale,
  onPanChange,
  onScaleChange,
  onSelectNode,
  onNodeMove,
  onNodeDataChange,
  onRemoveNode,
  onConnect,
  onRelayNext,
  onGenerateVideo,
  onSendToDoubaoAccount,
  onResetView,
}: BeefTvCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const [connectingFrom, setConnectingFrom] = useState<{ nodeId: string; port: any } | null>(null);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
    const newScale = Math.min(2.5, Math.max(0.25, scale * zoomFactor));
    onScaleChange(newScale);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.target === containerRef.current || (e.target as HTMLElement).classList.contains('beeftv-viewport')) {
      setIsPanning(true);
      dragStartPos.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      onSelectNode(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      onPanChange({
        x: e.clientX - dragStartPos.current.x,
        y: e.clientY - dragStartPos.current.y,
      });
    } else if (draggedNodeId) {
      const dx = (e.clientX - dragStartPos.current.x) / scale;
      const dy = (e.clientY - dragStartPos.current.y) / scale;
      onNodeMove(draggedNodeId, dx, dy);
      dragStartPos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
    setDraggedNodeId(null);
    setConnectingFrom(null);
  };

  const startNodeDrag = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    onSelectNode(nodeId);
    setDraggedNodeId(nodeId);
    dragStartPos.current = { x: e.clientX, y: e.clientY };
  };

  // 连线计算
  const connectionPaths = useMemo(() => {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const NODE_WIDTH = 320;

    return connections.map(conn => {
      const fromNode = nodeMap.get(conn.fromNodeId);
      const toNode = nodeMap.get(conn.toNodeId);
      if (!fromNode || !toNode) return null;

      const startX = fromNode.position.x + NODE_WIDTH;
      const startY = fromNode.position.y + 120;
      const endX = toNode.position.x;
      const endY = toNode.position.y + 120;

      const deltaX = Math.abs(endX - startX) * 0.5;
      const pathData = `M ${startX} ${startY} C ${startX + deltaX} ${startY}, ${endX - deltaX} ${endY}, ${endX} ${endY}`;

      return {
        id: conn.id,
        pathData,
        isRelay: conn.fromPort === 'last_frame',
      };
    }).filter(Boolean);
  }, [nodes, connections]);

  return (
    <div
      ref={containerRef}
      className="beeftv-canvas-container"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <div
        className="beeftv-viewport"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
        }}
      >
        {/* SVG 连线层 */}
        <svg className="beeftv-connections-layer">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#e86c36" />
            </marker>
          </defs>
          {connectionPaths.map(conn => conn && (
            <path
              key={conn.id}
              d={conn.pathData}
              className={`beeftv-connection-path ${conn.isRelay ? 'relay' : ''}`}
              markerEnd="url(#arrow)"
            />
          ))}
        </svg>

        {/* 节点渲染 */}
        {nodes.map(node => (
          <div
            key={node.id}
            className={`beeftv-node ${selectedNodeId === node.id ? 'is-selected' : ''}`}
            style={{
              transform: `translate3d(${node.position.x}px, ${node.position.y}px, 0)`,
              width: node.type === 'frame' ? (node.data as FrameNodeData).width || 600 : 320,
              background: node.type === 'frame' ? (node.data as FrameNodeData).color || 'rgba(255,255,255,0.03)' : undefined,
              borderStyle: node.type === 'frame' ? 'dashed' : 'solid',
            }}
            onClick={(e) => { e.stopPropagation(); onSelectNode(node.id); }}
          >
            {/* 左侧输入端口 */}
            {node.type !== 'script' && node.type !== 'frame' && (
              <div
                className="node-port port-in"
                title="输入端口 (接收上游内容)"
                onMouseUp={() => {
                  if (connectingFrom && connectingFrom.nodeId !== node.id) {
                    onConnect(connectingFrom.nodeId, connectingFrom.port, node.id, 'input');
                    setConnectingFrom(null);
                  }
                }}
              />
            )}

            {/* 头部标题与拖拽抓手 */}
            <div className="beeftv-node-header" onMouseDown={(e) => startNodeDrag(e, node.id)}>
              <div className="node-title-group">
                {node.type === 'script' && <Sparkles size={15} style={{ color: '#f59e0b' }} />}
                {node.type === 'image' && <Image size={15} style={{ color: '#3b82f6' }} />}
                {node.type === 'video' && <Film size={15} style={{ color: '#e86c36' }} />}
                {node.type === 'doubao_account' && <User size={15} style={{ color: '#10b981' }} />}
                {node.type === 'director' && <Bot size={15} style={{ color: '#8b5cf6' }} />}
                {node.type === 'audio' && <Volume2 size={15} style={{ color: '#06b6d4' }} />}
                {node.type === 'markdown' && <FileText size={15} style={{ color: '#a855f7' }} />}
                {node.type === 'frame' && <Layout size={15} style={{ color: '#9ca3af' }} />}
                <span>{(node.data as any).title || node.id}</span>
              </div>
              <div className="node-actions">
                <button
                  className="node-action-btn"
                  title="删除节点"
                  onClick={(e) => { e.stopPropagation(); onRemoveNode(node.id); }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* 节点主体 */}
            <div className="beeftv-node-body">
              {/* 1. 核心定制：单独的豆包账号专属节点 */}
              {node.type === 'doubao_account' && (() => {
                const accData = node.data as DoubaoAccountNodeData;
                return (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{ fontSize: '11px', color: '#9ca3af' }}>选择执行的豆包账号：</label>
                      <select
                        style={{
                          background: '#12141a',
                          color: '#e5e7eb',
                          border: '1px solid rgba(255,255,255,0.15)',
                          borderRadius: '6px',
                          padding: '6px 8px',
                          fontSize: '12px',
                          outline: 'none',
                        }}
                        value={accData.selectedAccountId ?? ''}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          const targetAcc = accounts.find(a => a.id === val);
                          onNodeDataChange(node.id, {
                            selectedAccountId: val || null,
                            accountName: targetAcc?.name || '',
                          });
                        }}
                      >
                        <option value="">-- 请选择豆包账号 --</option>
                        {accounts.map(acc => (
                          <option key={acc.id} value={acc.id}>
                            {acc.name} {acc.isLoggedIn ? '(已登录)' : '(未登录)'}
                          </option>
                        ))}
                      </select>
                    </div>

                    <textarea
                      className="beeftv-textarea"
                      value={accData.promptText}
                      onChange={(e) => onNodeDataChange(node.id, { promptText: e.target.value })}
                      placeholder="输入要发送给该豆包账号的文本消息（也可通过连线从上游传入）..."
                      rows={3}
                    />

                    {accData.replyText && (
                      <div style={{
                        background: 'rgba(0,0,0,0.35)',
                        border: '1px solid rgba(16, 185, 129, 0.25)',
                        borderRadius: '6px',
                        padding: '8px',
                        fontSize: '11px',
                        lineHeight: 1.5,
                        color: '#d1fae5',
                        maxHeight: '120px',
                        overflowY: 'auto',
                      }}>
                        <b>账号回复：</b>
                        <p style={{ margin: '4px 0 0' }}>{accData.replyText}</p>
                      </div>
                    )}

                    {accData.error && (
                      <div style={{ fontSize: '11px', color: '#ef4444' }}>
                        {accData.error}
                      </div>
                    )}

                    <div className="node-footer">
                      <span style={{ fontSize: '11px', color: '#9ca3af' }}>
                        {accData.status === 'sending' ? '发送等待中...' : '定向对话'}
                      </span>
                      <button
                        className="beeftv-btn beeftv-btn-primary"
                        disabled={accData.status === 'sending'}
                        onClick={() => onSendToDoubaoAccount(node.id)}
                      >
                        <Send size={12} />
                        {accData.status === 'sending' ? '发送中...' : '发送给该账号'}
                      </button>
                    </div>
                  </>
                );
              })()}

              {/* 2. 剧本大纲节点 */}
              {node.type === 'script' && (
                <>
                  <textarea
                    className="beeftv-textarea"
                    value={(node.data as ScriptNodeData).content}
                    onChange={(e) => onNodeDataChange(node.id, { content: e.target.value })}
                    placeholder="剧本故事大纲与分镜设定..."
                    rows={4}
                  />
                  <div className="node-footer">
                    <span style={{ fontSize: '11px', color: '#9ca3af' }}>剧本大纲</span>
                    <span style={{ fontSize: '11px', color: '#f59e0b' }}>可连线至豆包账号扩写</span>
                  </div>
                </>
              )}

              {/* 3. 导演 AI 顾问节点 */}
              {node.type === 'director' && (
                <>
                  <div style={{ fontSize: '11px', color: '#a78bfa' }}>
                    视觉导演角色：指导运镜与景别构图
                  </div>
                  <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '6px', padding: '8px', fontSize: '11px', lineHeight: 1.5 }}>
                    {(node.data as DirectorNodeData).suggestions.map((s, idx) => (
                      <div key={idx} style={{ marginBottom: '4px' }}>• {s}</div>
                    ))}
                  </div>
                </>
              )}

              {/* 4. 分镜生图节点 */}
              {node.type === 'image' && (
                <>
                  <textarea
                    className="beeftv-textarea"
                    value={(node.data as ImageNodeData).prompt}
                    onChange={(e) => onNodeDataChange(node.id, { prompt: e.target.value })}
                    placeholder="分镜画面提示词..."
                  />
                  <div className="node-params-row">
                    <span className="node-param-pill">{(node.data as ImageNodeData).model}</span>
                    <span className="node-param-pill">{(node.data as ImageNodeData).ratio}</span>
                  </div>
                  <div className="node-preview-box">
                    {(node.data as ImageNodeData).imageUrl ? (
                      <img src={(node.data as ImageNodeData).imageUrl} alt="preview" className="node-preview-media" />
                    ) : (
                      <div className="node-placeholder">
                        <Image size={24} />
                        <span>待生成首帧分镜图</span>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* 5. 图生视频与尾帧接力节点 */}
              {node.type === 'video' && (() => {
                const vdata = node.data as VideoNodeData;
                return (
                  <>
                    <textarea
                      className="beeftv-textarea"
                      value={vdata.prompt}
                      onChange={(e) => onNodeDataChange(node.id, { prompt: e.target.value })}
                      placeholder="视频动作描述与运镜推进..."
                    />

                    {vdata.inputImageUrl && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#f97316' }}>
                        <ArrowRight size={13} />
                        <span>已连接上一镜尾帧作为首帧</span>
                      </div>
                    )}

                    <div className="node-params-row">
                      <span className="node-param-pill">模型: {vdata.model}</span>
                      <span className="node-param-pill">{vdata.ratio} · {vdata.duration}s</span>
                    </div>

                    <div className="node-preview-box">
                      {vdata.videoUrl ? (
                        <video src={vdata.videoUrl} controls autoPlay loop muted className="node-preview-media" />
                      ) : (
                        <div className="node-placeholder">
                          <Film size={24} />
                          <span>{vdata.statusText || '等待提交生成'}</span>
                        </div>
                      )}
                    </div>

                    {vdata.status !== 'idle' && (
                      <div className="node-progress-wrapper">
                        <div className="node-status-text">
                          <span>{vdata.statusText || vdata.status}</span>
                          <span>{vdata.progress}%</span>
                        </div>
                        <div className="node-progress-bar">
                          <div className="node-progress-fill" style={{ width: `${vdata.progress}%` }} />
                        </div>
                      </div>
                    )}

                    <div className="node-footer">
                      {vdata.status === 'completed' ? (
                        <button
                          className="beeftv-btn beeftv-btn-primary"
                          style={{ width: '100%', justifyContent: 'center' }}
                          onClick={() => onRelayNext(node.id)}
                          title="提取当前视频尾帧，并自动创建下一镜接力节点"
                        >
                          <FastForward size={13} /> 提取尾帧 · 接力下一镜
                        </button>
                      ) : (
                        <button
                          className="beeftv-btn beeftv-btn-primary"
                          style={{ width: '100%', justifyContent: 'center' }}
                          disabled={vdata.status === 'queued' || vdata.status === 'processing'}
                          onClick={() => onGenerateVideo(node.id)}
                        >
                          <Play size={13} /> {vdata.status === 'processing' ? '正在渲染中...' : '提交生视频'}
                        </button>
                      )}
                    </div>
                  </>
                );
              })()}

              {/* 6. 音频/配音节点 */}
              {node.type === 'audio' && (
                <>
                  <textarea
                    className="beeftv-textarea"
                    value={(node.data as AudioNodeData).prompt}
                    onChange={(e) => onNodeDataChange(node.id, { prompt: e.target.value })}
                    placeholder="旁白台词或背景音效描述..."
                  />
                  <div className="node-params-row">
                    <span className="node-param-pill">音色: {(node.data as AudioNodeData).voice}</span>
                  </div>
                </>
              )}

              {/* 7. Markdown 世界观笔记节点 */}
              {node.type === 'markdown' && (
                <textarea
                  className="beeftv-textarea"
                  value={(node.data as MarkdownNodeData).content}
                  onChange={(e) => onNodeDataChange(node.id, { content: e.target.value })}
                  rows={4}
                />
              )}
            </div>

            {/* 右侧输出端口 */}
            {node.type !== 'frame' && (
              <div
                className="node-port port-out"
                title="输出端口 (点击拖出连线)"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setConnectingFrom({ 
                    nodeId: node.id, 
                    port: node.type === 'video' ? 'last_frame' : (node.type === 'doubao_account' ? 'reply_text' : 'output') 
                  });
                }}
              />
            )}
          </div>
        ))}
      </div>

      {/* 底部浮动控制台 */}
      <div className="beeftv-controls-float">
        <button className="beeftv-btn" onClick={() => onScaleChange(Math.max(0.25, scale - 0.15))} title="缩小">
          <ZoomOut size={14} />
        </button>
        <span style={{ fontSize: '12px', fontWeight: 600, minWidth: '40px', textAlign: 'center' }}>
          {Math.round(scale * 100)}%
        </span>
        <button className="beeftv-btn" onClick={() => onScaleChange(Math.min(2.5, scale + 0.15))} title="放大">
          <ZoomIn size={14} />
        </button>
        <div className="controls-divider" />
        <button className="beeftv-btn" onClick={onResetView} title="视口居中">
          <RotateCcw size={14} /> 居中
        </button>
      </div>
    </div>
  );
}
