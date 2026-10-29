// 制作现场：把整张画布压成助手每轮都能一眼看懂的几百字，
// 以及“上一次对话结束后别人（用户、生成任务）又改了什么”的差异说明。
// 纯函数、无 IO、结果确定（同一画布状态永远得到同一段文字），便于提示词缓存与测试。

const TYPE_LABEL = {
  image: '图片', video: '视频', audio: '音频', text: '文本', markdown: '文档', script: '分镜板',
  frame: '分组', svg: 'SVG', html: '网页', panorama: '全景', compare: '对比', chart: '图表',
};
const MEDIA = new Set(['image', 'video', 'audio']);

const clip = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

// 节点当前状态：done 已有结果 / running 生成中 / failed 失败 / empty 还没有结果
export function nodeState(node) {
  const meta = node?.metadata || {};
  if (meta.status === 'loading' || meta.taskStatus === 'queued' || meta.taskStatus === 'running') return 'running';
  if (meta.status === 'error' || meta.taskStatus === 'failed') return 'failed';
  if (meta.status === 'success' || meta.assetId || meta.storageKey) return 'done';
  return 'empty';
}
const STATE_LABEL = { done: '完成', running: '生成中', failed: '失败', empty: '空' };

function fnv(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(36);
}

// 内容指纹：只含用户会在意的字段；位置、尺寸、预览缓存不算改动。
function contentFingerprint(node) {
  const meta = node?.metadata || {};
  return fnv(JSON.stringify([node?.title, meta.content, meta.composerContent, meta.prompt, meta.model, meta.seconds, meta.size, meta.quality,
    meta.count, meta.assetId, meta.storyboard?.rows]));
}

function storyboardRows(node) {
  const rows = node?.metadata?.storyboard?.rows;
  return Array.isArray(rows) ? rows : [];
}

export function buildStudioDigest(canvas, { maxBytes = 3600, selectedNodeIds = [] } = {}) {
  const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
  const connections = Array.isArray(canvas?.connections) ? canvas.connections : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const counts = {};
  for (const node of nodes) {
    const kind = TYPE_LABEL[node.type] ? node.type : 'other';
    const bucket = counts[kind] ||= { total: 0, done: 0, running: 0, failed: 0, empty: 0 };
    bucket.total++;
    if (MEDIA.has(node.type)) bucket[nodeState(node)]++;
  }
  const lines = [];
  const summary = Object.entries(counts).map(([kind, c]) => {
    const label = TYPE_LABEL[kind] || '其他';
    if (!MEDIA.has(kind)) return `${label} ${c.total}`;
    const parts = [c.done && `完成 ${c.done}`, c.running && `生成中 ${c.running}`, c.failed && `失败 ${c.failed}`, c.empty && `待生成 ${c.empty}`].filter(Boolean);
    return `${label} ${c.total}${parts.length ? `（${parts.join('、')}）` : ''}`;
  });
  lines.push(`[制作现场｜画布版本 ${canvas?.revision ?? '?'}｜本轮请求前的实际状态]`);
  lines.push(nodes.length ? `概况：${summary.join('｜')}｜连线 ${connections.length}` : '概况：画布是空的（若用户提问、闲聊或要求写剧本文案，请直接正常回答/创作，无需机械引导新建分镜）。');

  const rowBound = new Set();
  for (const board of nodes.filter((node) => node.type === 'script')) {
    const rows = storyboardRows(board);
    lines.push(`分镜板「${clip(board.title, 24)}」id=${board.id}，共 ${rows.length} 镜：`);
    rows.forEach((row, index) => {
      if (row.imageNodeId) rowBound.add(row.imageNodeId);
      if (row.videoNodeId) rowBound.add(row.videoNodeId);
      const image = row.imageNodeId ? STATE_LABEL[nodeState(byId.get(row.imageNodeId))] || '不存在' : '未建';
      const video = row.videoNodeId ? STATE_LABEL[nodeState(byId.get(row.videoNodeId))] || '不存在' : '未建';
      const prompts = `${row.imageGenerationPrompt ? '图词✓' : '图词✗'} ${row.videoMotionPrompt ? '视词✓' : '视词✗'}`;
      lines.push(`  镜${row.shotNumber ?? index + 1} ${row.durationSeconds ?? '?'}s｜行id=${row.id}｜首帧 ${row.imageNodeId || '—'} ${image}｜视频 ${row.videoNodeId || '—'} ${video}｜${prompts}｜${clip(row.plotDescription, 18)}`);
    });
  }

  const running = nodes.filter((node) => MEDIA.has(node.type) && nodeState(node) === 'running');
  if (running.length) lines.push(`生成中：${running.slice(0, 8).map((node) => `${node.id}「${clip(node.title, 16)}」`).join('、')}${running.length > 8 ? `…共 ${running.length}` : ''}`);
  const failed = nodes.filter((node) => MEDIA.has(node.type) && nodeState(node) === 'failed');
  if (failed.length) lines.push(`失败：${failed.slice(0, 6).map((node) => `${node.id}「${clip(node.title, 14)}」${clip(node.metadata?.generationErrorSummary || node.metadata?.errorDetails || node.metadata?.taskErrorCode, 40)}`).join('；')}${failed.length > 6 ? `…共 ${failed.length}` : ''}`);
  const loose = nodes.filter((node) => MEDIA.has(node.type) && !rowBound.has(node.id));
  if (loose.length && !nodes.some((node) => node.type === 'script')) {
    lines.push(`媒体节点：${loose.slice(0, 16).map((node) => `${node.id}「${clip(node.title, 14)}」${TYPE_LABEL[node.type]}${STATE_LABEL[nodeState(node)]}`).join('、')}${loose.length > 16 ? `…共 ${loose.length}` : ''}`);
  } else if (loose.length) {
    lines.push(`不在分镜行里的媒体节点 ${loose.length} 个：${loose.slice(0, 8).map((node) => `${node.id}「${clip(node.title, 14)}」${TYPE_LABEL[node.type]}`).join('、')}${loose.length > 8 ? `…共 ${loose.length}` : ''}（如需关联分镜行请用 canvas_script_row_update 绑定 imageNodeId/videoNodeId）`);
  }
  const selected = selectedNodeIds.map((id) => byId.get(id)).filter(Boolean);
  if (selected.length) lines.push(`用户选中：${selected.slice(0, 8).map((node) => `${node.id}「${clip(node.title, 14)}」`).join('、')}`);

  let text = lines.join('\n');
  // 超预算时从分镜明细开始收缩，保证概况、进行中、失败这些关键信息留下。
  while (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const index = lines.findLastIndex((line) => line.startsWith('  镜'));
    if (index < 0) { text = clip(text, Math.floor(maxBytes / 3)); break; }
    lines.splice(index, 1);
    const hidden = lines.filter((line) => line.startsWith('…')).length;
    if (!hidden) lines.push('…分镜明细已收缩，需要时用 canvas_get 读取分镜板');
    text = lines.join('\n');
  }
  return { text, snapshot: snapshotOf(nodes), stats: { revision: canvas?.revision ?? null, nodes: nodes.length, connections: connections.length } };
}

// 快照：节点 id → 内容指纹/状态/标题。只存很小的几个字段，进会话文档。
export function snapshotOf(nodes) {
  const out = {};
  for (const node of nodes || []) {
    if (!node?.id) continue;
    out[node.id] = { t: clip(node.title, 30), h: contentFingerprint(node), s: nodeState(node), y: node.type };
  }
  return out;
}

// 对比“上次对话结束时”和“现在”：返回给助手看的一行说明；没有变化返回空串。
export function describeChangesSince(previous, current, { limit = 420 } = {}) {
  if (!previous || typeof previous !== 'object') return '';
  const parts = [];
  const name = (entry) => `「${clip(entry?.t, 14) || '未命名'}」`;
  const list = (items) => items.slice(0, 5).join('') + (items.length > 5 ? `等 ${items.length} 个` : '');
  const edited = [], added = [], removed = [], done = [], failed = [];
  for (const [id, now] of Object.entries(current)) {
    const before = previous[id];
    if (!before) { added.push(name(now)); continue; }
    if (before.s !== now.s) {
      if (now.s === 'done' && before.s !== 'done') { done.push(name(now)); continue; }
      if (now.s === 'failed') { failed.push(name(now)); continue; }
    }
    if (before.h !== now.h && before.s === now.s) edited.push(name(now));
  }
  for (const [id, before] of Object.entries(previous)) if (!current[id]) removed.push(name(before));
  if (edited.length) parts.push(`用户修改了${list(edited)}`);
  if (added.length) parts.push(`新增 ${added.length} 个节点（${list(added)}）`);
  if (removed.length) parts.push(`删除了${list(removed)}`);
  if (done.length) parts.push(`${list(done)}生成完成`);
  if (failed.length) parts.push(`${list(failed)}生成失败`);
  if (!parts.length) return '';
  return clip(`自上次对话结束后：${parts.join('；')}。以此为准，不要覆盖这些变化。`, limit);
}
