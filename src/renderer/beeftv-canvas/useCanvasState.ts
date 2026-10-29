import { useState, useEffect, useRef, useCallback } from 'react';
import type { 
  CanvasNode, CanvasConnection, CanvasNodeType, 
  VideoNodeData, ImageNodeData, ScriptNodeData, 
  DoubaoAccountNodeData, DirectorNodeData 
} from './types';
import type { Account } from '../../shared/types';

const STORAGE_KEY = 'beeftv_canvas_project_v3_native';

const DEFAULT_NODES: CanvasNode[] = [
  {
    id: 'script-1',
    type: 'script',
    position: { x: 60, y: 100 },
    data: {
      title: '剧本 · 创意大纲',
      content: '雨夜霓虹，赛博朋克风街头。主角穿着风衣穿过积水小巷，街角的全息广告牌忽明忽暗。',
    },
  },
  {
    id: 'doubao-acc-1',
    type: 'doubao_account',
    position: { x: 420, y: 100 },
    data: {
      title: '豆包账号专属节点',
      selectedAccountId: null,
      promptText: '请帮我把上述故事大纲扩写为具体的电影级视频提示词与镜头运镜参数：',
      status: 'idle',
    },
  },
  {
    id: 'image-1',
    type: 'image',
    position: { x: 780, y: 100 },
    data: {
      title: '分镜生图节点',
      prompt: '电影质感，赛博朋克街道，雨夜积水倒映霓虹灯光，风衣背影，虚幻5渲染，8k分辨率',
      model: 'Seedream 4.5',
      ratio: '16:9',
      status: 'idle',
    },
  },
  {
    id: 'video-1',
    type: 'video',
    position: { x: 1140, y: 100 },
    data: {
      title: '图生视频 · 接力镜头 1',
      sceneNumber: 1,
      prompt: '镜头缓缓前推，雨滴从屋檐滴落，霓虹光芒微弱闪烁，慢动作特写',
      model: 'doubao-video',
      ratio: '16:9',
      duration: 5,
      status: 'idle',
      progress: 0,
    },
  },
];

const DEFAULT_CONNECTIONS: CanvasConnection[] = [
  { id: 'c-1', fromNodeId: 'script-1', fromPort: 'output', toNodeId: 'doubao-acc-1', toPort: 'input' },
  { id: 'c-2', fromNodeId: 'doubao-acc-1', fromPort: 'reply_text', toNodeId: 'image-1', toPort: 'input' },
  { id: 'c-3', fromNodeId: 'image-1', fromPort: 'image_out', toNodeId: 'video-1', toPort: 'reference_image' },
];

export function useCanvasState(gatewayPort = 8788, accounts: Account[] = []) {
  const [nodes, setNodes] = useState<CanvasNode[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.nodes) && parsed.nodes.length) return parsed.nodes;
      }
    } catch { /* ignore */ }
    return DEFAULT_NODES;
  });

  const [connections, setConnections] = useState<CanvasConnection[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.connections)) return parsed.connections;
      }
    } catch { /* ignore */ }
    return DEFAULT_CONNECTIONS;
  });

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);

  // 默认将未绑定的豆包节点绑定到第一个可用账号
  useEffect(() => {
    if (!accounts.length) return;
    setNodes(prev => prev.map(n => {
      if (n.type === 'doubao_account') {
        const d = n.data as DoubaoAccountNodeData;
        if (!d.selectedAccountId) {
          return {
            ...n,
            data: { ...d, selectedAccountId: accounts[0].id, accountName: accounts[0].name },
          };
        }
      }
      return n;
    }));
  }, [accounts]);

  // 本地存储
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, connections }));
    } catch { /* ignore */ }
  }, [nodes, connections]);

  const updateNodePosition = useCallback((id: string, dx: number, dy: number) => {
    setNodes(prev => prev.map(node => node.id === id ? {
      ...node,
      position: { x: Math.round(node.position.x + dx), y: Math.round(node.position.y + dy) },
    } : node));
  }, []);

  const updateNodeData = useCallback((id: string, patch: Record<string, any>) => {
    setNodes(prev => prev.map(node => node.id === id ? {
      ...node,
      data: { ...node.data, ...patch },
    } : node));
  }, []);

  // 添加原生 BeefTV 节点
  const addNode = useCallback((type: CanvasNodeType, initialData?: Record<string, any>) => {
    const id = `${type}-${Date.now().toString(36)}`;
    const x = Math.round(-pan.x + 320 + Math.random() * 60);
    const y = Math.round(-pan.y + 180 + Math.random() * 60);

    let defaultData: any = {};
    if (type === 'script') {
      defaultData = { title: '剧本 · 创意大纲', content: '输入分镜灵感大纲...' };
    } else if (type === 'image') {
      defaultData = { title: '分镜生图节点', prompt: '', model: 'Seedream 4.5', ratio: '16:9', status: 'idle' };
    } else if (type === 'video') {
      defaultData = { title: '图生视频接力', prompt: '', model: 'doubao-video', ratio: '16:9', duration: 5, status: 'idle', progress: 0 };
    } else if (type === 'doubao_account') {
      const defaultAcc = accounts[0];
      defaultData = {
        title: '豆包账号专属节点',
        selectedAccountId: defaultAcc ? defaultAcc.id : null,
        accountName: defaultAcc ? defaultAcc.name : '未绑定账号',
        promptText: '',
        status: 'idle',
      };
    } else if (type === 'director') {
      defaultData = {
        title: '导演 AI 顾问',
        role: '电影视觉导演',
        inputIdea: '',
        suggestions: [
          '建议使用 16:9 宽画幅，采用特写到中景的推进运镜。',
          '可以在提示词中加入冷暖光对冲，提升赛博朋克电影质感。',
        ],
      };
    } else if (type === 'audio') {
      defaultData = { title: '旁白 / 音效节点', prompt: '深夜雨声淅淅沥沥，远处传来微弱的警笛声', voice: '磁性男中音', status: 'idle' };
    } else if (type === 'markdown') {
      defaultData = { title: '世界观设定笔记', content: '### 故事背景\n2077 新港市，阴雨连绵的边缘街道...\n- 角色 A：侦探，沉默寡言\n- 道具：全息怀表' };
    } else if (type === 'frame') {
      defaultData = { title: '第一幕：序幕相遇', width: 700, height: 460, color: 'rgba(232, 108, 54, 0.15)' };
    }

    const newNode: CanvasNode = {
      id,
      type,
      position: { x, y },
      data: { ...defaultData, ...initialData },
    };

    setNodes(prev => [...prev, newNode]);
    setSelectedNodeId(id);
    return id;
  }, [pan, accounts]);

  const removeNode = useCallback((id: string) => {
    setNodes(prev => prev.filter(n => n.id !== id));
    setConnections(prev => prev.filter(c => c.fromNodeId !== id && c.toNodeId !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
  }, [selectedNodeId]);

  const connectNodes = useCallback((fromNodeId: string, fromPort: any, toNodeId: string, toPort: any) => {
    if (fromNodeId === toNodeId) return;
    const exists = connections.some(c => c.fromNodeId === fromNodeId && c.toNodeId === toNodeId);
    if (exists) return;

    const newConn: CanvasConnection = {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      fromNodeId,
      fromPort,
      toNodeId,
      toPort,
    };
    setConnections(prev => [...prev, newConn]);

    // 连线后自动传递内容
    const source = nodes.find(n => n.id === fromNodeId);
    const target = nodes.find(n => n.id === toNodeId);
    if (!source || !target) return;

    if (source.type === 'script' && target.type === 'doubao_account') {
      const scriptText = (source.data as ScriptNodeData).content || '';
      updateNodeData(toNodeId, { promptText: scriptText });
    } else if (source.type === 'doubao_account' && target.type === 'image') {
      const reply = (source.data as DoubaoAccountNodeData).replyText || (source.data as DoubaoAccountNodeData).promptText;
      if (reply) updateNodeData(toNodeId, { prompt: reply });
    } else if (source.type === 'image' && target.type === 'video') {
      const img = (source.data as ImageNodeData).imageUrl || '';
      const path = (source.data as ImageNodeData).localPath || '';
      updateNodeData(toNodeId, { inputImageUrl: img, inputImagePath: path });
    } else if (source.type === 'video' && target.type === 'video') {
      const lastImg = (source.data as VideoNodeData).lastFrameUrl || '';
      const lastPath = (source.data as VideoNodeData).lastFramePath || '';
      updateNodeData(toNodeId, { inputImageUrl: lastImg, inputImagePath: lastPath });
    }
  }, [connections, nodes, updateNodeData]);

  // 向指定的豆包账号节点发送文字消息
  const sendPromptToDoubaoAccount = useCallback(async (nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node || node.type !== 'doubao_account') return;
    const data = node.data as DoubaoAccountNodeData;

    const accountId = data.selectedAccountId;
    if (!accountId) {
      updateNodeData(nodeId, { error: '请先在下拉菜单中选择一个具体的豆包账号' });
      return;
    }

    const textToSend = data.promptText?.trim();
    if (!textToSend) {
      updateNodeData(nodeId, { error: '发送内容不能为空' });
      return;
    }

    updateNodeData(nodeId, { status: 'sending', error: null, replyText: '正在向豆包账号网页发送并等待回复...' });

    try {
      // 优先使用 window.workspace.chatSend 向指定账号发送
      if (window.workspace?.chatSend) {
        const result = await window.workspace.chatSend({
          accountId,
          prompt: textToSend,
        });
        const reply = result?.assistantMessage?.content || '已收到账号回复';
        updateNodeData(nodeId, {
          status: 'replied',
          replyText: reply,
          error: null,
        });

        // 连带同步给所有下游连接节点
        setConnections(curConns => {
          const downstreams = curConns.filter(c => c.fromNodeId === nodeId);
          for (const ds of downstreams) {
            updateNodeData(ds.toNodeId, { prompt: reply });
          }
          return curConns;
        });
      } else {
        // 通过本地 8788 网关进行 OpenAI 兼容请求
        const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'doubao',
            messages: [{ role: 'user', content: textToSend }],
          }),
        });
        const json = await res.json();
        const reply = json.choices?.[0]?.message?.content || '生成完成';
        updateNodeData(nodeId, {
          status: 'replied',
          replyText: reply,
          error: null,
        });
      }
    } catch (err) {
      updateNodeData(nodeId, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [nodes, gatewayPort, updateNodeData]);

  // 从某个视频节点一键提取尾帧并创建下一镜接力节点
  const relayNextShot = useCallback((sourceNodeId: string) => {
    const source = nodes.find(n => n.id === sourceNodeId);
    if (!source || source.type !== 'video') return;
    const sourceData = source.data as VideoNodeData;

    const nextSceneNum = (sourceData.sceneNumber || 1) + 1;
    const nextNodeId = addNode('video', {
      title: `图生视频 · 接力镜头 ${nextSceneNum}`,
      sceneNumber: nextSceneNum,
      prompt: `镜头 ${nextSceneNum} 承接上一镜，动作与光影连贯向前...`,
      model: 'doubao-video',
      ratio: sourceData.ratio || '16:9',
      duration: sourceData.duration || 5,
      inputImageUrl: sourceData.lastFrameUrl || '',
      inputImagePath: sourceData.lastFramePath || '',
      status: 'idle',
      progress: 0,
    });

    setNodes(prev => prev.map(n => n.id === nextNodeId ? {
      ...n,
      position: { x: source.position.x + 360, y: source.position.y },
    } : n));

    connectNodes(sourceNodeId, 'last_frame', nextNodeId, 'reference_image');
  }, [nodes, addNode, connectNodes]);

  // 执行视频节点生成
  const generateVideoForNode = useCallback(async (nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node || node.type !== 'video') return;
    const data = node.data as VideoNodeData;

    updateNodeData(nodeId, { status: 'queued', progress: 5, statusText: '正在调度空闲豆包账号...', error: null });

    try {
      const payload: Record<string, any> = {
        model: data.model || 'doubao-video',
        prompt: data.prompt,
        ratio: data.ratio || '16:9',
        duration: data.duration || 5,
      };

      if (data.inputImagePath) payload.image_url = data.inputImagePath;
      else if (data.inputImageUrl) payload.image_url = data.inputImageUrl;

      const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/video/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `提交失败 (${res.status})`);
      }

      const { task_id } = await res.json();
      updateNodeData(nodeId, { taskId: task_id, status: 'processing', progress: 20, statusText: '已分发账号，正在渲染视频...' });

      const pollTimer = setInterval(async () => {
        try {
          const pollRes = await fetch(`http://127.0.0.1:${gatewayPort}/v1/video/tasks/${encodeURIComponent(task_id)}`);
          if (!pollRes.ok) return;

          const task = await pollRes.json();
          if (task.status === 'completed') {
            clearInterval(pollTimer);
            updateNodeData(nodeId, {
              status: 'completed',
              progress: 100,
              videoUrl: task.video_url || `http://127.0.0.1:${gatewayPort}/v1/video/tasks/${task_id}/video`,
              localPath: task.local_path,
              lastFramePath: task.last_frame_path,
              lastFrameUrl: task.last_frame_path ? `http://127.0.0.1:${gatewayPort}/v1/video/tasks/${task_id}/last_frame` : null,
              statusText: '视频生成完成！已就绪',
            });
          } else if (task.status === 'failed') {
            clearInterval(pollTimer);
            updateNodeData(nodeId, { status: 'failed', progress: 0, error: task.error || '生成失败' });
          } else if (task.status === 'needs_attention') {
            updateNodeData(nodeId, { status: 'needs_attention', statusText: '触发安全验证，请在顶部切换到账号完成滑动' });
          } else {
            updateNodeData(nodeId, {
              status: 'processing',
              progress: task.progress || 50,
              statusText: task.status_text || '视频渲染中...',
            });
          }
        } catch { /* ignore */ }
      }, 3000);
    } catch (error) {
      updateNodeData(nodeId, { status: 'failed', progress: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }, [nodes, gatewayPort, updateNodeData]);

  const resetViewport = useCallback(() => {
    setPan({ x: 0, y: 0 });
    setScale(1);
  }, []);

  return {
    nodes,
    connections,
    selectedNodeId,
    pan,
    scale,
    setPan,
    setScale,
    setSelectedNodeId,
    updateNodePosition,
    updateNodeData,
    addNode,
    removeNode,
    connectNodes,
    relayNextShot,
    generateVideoForNode,
    sendPromptToDoubaoAccount,
    resetViewport,
  };
}
