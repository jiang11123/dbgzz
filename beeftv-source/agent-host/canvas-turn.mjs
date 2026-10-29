// 一轮对话的画布影响与付费生成提议：从成功的工具结果里当场累计，
// 而不是把工具结果正文留在日志里（画布读取结果很大，也没必要外发）。
//
// 供应商定义同样放在这里：协议决定用哪个 pi-ai 适配器，宿主不再假设一切都是
// OpenAI 兼容接口，地址形状由后端按协议整理好后下发。

export const SUPPORTED_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

// This compatibility route has returned concatenated arguments for distinct
// calls, including when parallel_tool_calls=false. Never guess missing names
// or IDs from that payload. Business tools retain their own batch parameters.
export function toolCallCapabilityContext({ api, modelId }) {
  return api === 'openai-completions' && modelId === 'gemini-3.8-flash'
    ? '[本轮工具通路限制，优先于多工具合并建议：每条模型响应只调用一个工具，等结果再决定下一步；不能同一响应发出多个不同工具调用。优先用单个业务工具的批量或组合参数：model_catalog capabilities、canvas_script_prepare script、混合 canvas_generation_submit。需要成片和可编辑工程时使用 canvas_timeline_deliver，一次完成时间线保存、合成、画布绑定和工程导出；不要拆成逐步调用，只有组合回执明确失败时才恢复对应原步骤。计划更新与其他工具也分开。这是兼容通路限制，不需要用户逐步确认或人工续做。]'
    : '';
}

export function newTurnAccumulator() {
  return { turnId: '', seq: 0, toolSeq: 0, revisionBefore: 0, revisionAfter: 0,
    createdNodeIds: [], updatedNodeIds: [], createdEdgeIds: [], operationIds: [], proposals: [],
    timelineUpdated: false, writeChains: [], writeRequests: [] };
}

export function resetTurnAccumulator(turn, revisionBefore, turnId = '') {
  turn.seq += 1;
  turn.toolSeq = 0;
  turn.turnId = String(turnId || '');
  turn.revisionBefore = Number(revisionBefore || 0);
  turn.revisionAfter = 0;
  turn.createdNodeIds.length = 0;
  turn.updatedNodeIds.length = 0;
  turn.createdEdgeIds.length = 0;
  turn.operationIds.length = 0;
  turn.proposals.length = 0;
  turn.timelineUpdated = false;
  turn.deletedNodeIds=[];
  turn.deletedEdgeIds=[];
  turn.documentUpdated=false;
  turn.canvasChanges = {};
  turn.writeChains = [];
  turn.writeRequests = [];
  return turn;
}

// 每张画布只接续本轮自己的写入回执，不能借用另一张画布的版本。
// 每一步都是本轮带 expectedRevision 的写入，从上一步的结果版本接着写。
// 链内的每个版本都有本轮回执，所以模型拿链内旧版本发来的写入可以安全地接到链头上；
// 链外的版本（中间可能夹着别人的写入）照常交给后端 CAS 拒绝。
export function extendWriteChain(turn, canvasId, expectedRevision, revision) {
  if (!turn || !canvasId || !Number.isSafeInteger(expectedRevision) || !Number.isSafeInteger(revision)) return turn;
  if (revision <= expectedRevision) return turn;
  turn.writeChains ||= [];
  const chain = turn.writeChains.find(item => item.canvasId === canvasId);
  if (chain && expectedRevision === chain.head) {
    chain.head = revision;
  } else if (chain) {
    chain.start = expectedRevision;
    chain.head = revision;
  } else {
    turn.writeChains.push({ canvasId, start: expectedRevision, head: revision });
  }
  return turn;
}

// 返回应发送的 expectedRevision：落在本轮链内且落后于链头时换成链头，否则原样返回。
export function rebaseOntoWriteChain(turn, canvasId, expectedRevision) {
  if (!turn || !Number.isSafeInteger(expectedRevision)) return expectedRevision;
  const chain = turn.writeChains?.find(item => item.canvasId === canvasId);
  if (!chain) return expectedRevision;
  const { start, head } = chain;
  if (start <= expectedRevision && expectedRevision < head) return head;
  return expectedRevision;
}

function asStringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

export function collectTurnEffects(turn, opID, result, operationId) {
  if (!turn || !result || typeof result !== 'object') return turn;
  if (opID==='canvas.timeline.render') return turn;
  if (turn.canvasId && result.canvasId && typeof result.revision==='number') {
    turn.canvasChanges ||= {};
    const target=turn.canvasChanges[result.canvasId] ||= {...newTurnAccumulator(),revisionBefore:result.canvasId===turn.canvasId ? turn.revisionBefore : result.revision-1};
    collectTurnEffects(target,opID,result,operationId);
    if(result.canvasId!==turn.canvasId) return turn;
  }
  if (typeof result.revision === 'number' && result.revision > turn.revisionAfter) {
    turn.revisionAfter = result.revision;
    if (operationId) turn.operationIds.push(String(operationId));
  }
  switch (opID) {
    case 'canvas.timeline.update':
      if (result.timelineUpdated === true) turn.timelineUpdated = true;
      break;
    case 'canvas.nodes.create':
    case 'canvas.script.prepare':
      for (const node of Array.isArray(result.created) ? result.created : []) {
        if (node && node.id) turn.createdNodeIds.push(String(node.id));
      }
      if (opID === 'canvas.script.prepare') {
        if (result.nodeId) turn.updatedNodeIds.push(String(result.nodeId));
        turn.createdEdgeIds.push(...asStringList(result.createdEdgeIds));
      }
      break;
    case 'canvas.node.update':
    case 'canvas.node.bind_asset':
    case 'canvas.node.configure':
    case 'canvas.node.move':
    case 'canvas.task.bind':
      if (result.nodeId) turn.updatedNodeIds.push(String(result.nodeId));
      break;
    case 'canvas.node.delete':
    case 'canvas.edge.delete':
      turn.deletedNodeIds=[...new Set([...(turn.deletedNodeIds || []),...asStringList(result.deletedNodeIds)])];
      turn.deletedEdgeIds=[...new Set([...(turn.deletedEdgeIds || []),...asStringList(result.deletedEdgeIds)])];
      break;
    case 'canvas.script.rows.append':
    case 'canvas.script.row.update':
    case 'canvas.script.row.remove':
      // 行绑定会改写产出连线；回执里的连线增删与 Go 撤销用的变更摘要保持一致。
      if (result.nodeId) turn.updatedNodeIds.push(String(result.nodeId));
      turn.createdEdgeIds.push(...asStringList(result.createdEdgeIds));
      turn.deletedEdgeIds=[...new Set([...(turn.deletedEdgeIds || []),...asStringList(result.deletedEdgeIds)])];
      break;
    case 'canvas.document.commit': turn.documentUpdated=true; break;
    case 'canvas.edge.create':
      // 重复连线会幂等返回（没有新增），这时不能算作本轮新建了连线。
      if (result.created && result.edgeId) turn.createdEdgeIds.push(String(result.edgeId));
      break;
    case 'canvas.generation.propose':
      if (result.proposalId) {
        turn.proposals.push({ proposalId: String(result.proposalId), kind: String(result.kind || ''),
          nodeIds: asStringList(result.nodeIds), model: String(result.model || ''),
          modelKey: String(result.modelKey || ''), note: String(result.note || ''),
          ...(result.production ? { production: result.production } : {}),
          ...(result.source ? { source: { canvasId: result.source.canvasId,
            canvasRevision: result.source.canvasRevision, modelConfigRevision: result.source.modelConfigRevision } } : {}) });
      }
      break;
    default:
      break;
  }
  return turn;
}

// 刚创建、官方会话文件还没落盘的当前会话，历史应是空对话，而不是 404。
// 不是当前会话又找不到文件时返回 null，调用方必须保持 session_not_found。
export function unflushedSessionHistory(sessionId, activeSessionId) {
  if (!sessionId) return { sessionId: null, turns: [] };
  if (activeSessionId && sessionId === activeSessionId) return { sessionId, turns: [] };
  return null;
}

// turnChange 只在这一轮真的推进了画布版本时给出变更摘要；没写过画布时是 null。
export function turnChange(turn) {
  if (!turn) return null;
  const canvasChanges=Object.entries(turn.canvasChanges || {}).map(([canvasId,effect])=>({canvasId,...turnChange(effect)})).filter(c=>c.revisionAfter>c.revisionBefore);
  if (turn.revisionAfter <= turn.revisionBefore && !canvasChanges.length) return null;
  const change = { revisionBefore: turn.revisionBefore, revisionAfter: turn.revisionAfter,
    createdNodeIds: [...new Set(turn.createdNodeIds)], updatedNodeIds: [...new Set(turn.updatedNodeIds)],
    createdEdgeIds: [...new Set(turn.createdEdgeIds)] };
  if (turn.operationIds.length) change.operationIds = [...turn.operationIds];
  if (turn.timelineUpdated) change.timelineUpdated = true;
  if(turn.deletedNodeIds?.length) change.deletedNodeIds=[...turn.deletedNodeIds];
  if(turn.deletedEdgeIds?.length) change.deletedEdgeIds=[...turn.deletedEdgeIds];
  if(turn.documentUpdated) change.documentUpdated=true;
  if(canvasChanges.length) change.canvasChanges=canvasChanges;
  return change;
}

// sessionTitle 用第一条用户原文当标题（截到 40 字），而不是加过画布前缀的那份。
export function sessionTitle(turns) {
  const first = (turns || []).find((turn) => String(turn?.userText || '').trim());
  const text = String(first?.userText || '').trim();
  return text.length > 40 ? text.slice(0, 40) : text;
}

// turnContextPrefix 把后端验证过、随 Chat 信封下发的范围交给模型当固定上下文。
// 这里只是「告诉模型可以引用什么」，真正的授权仍在后端按回合记录裁决：
// 模型即使编造别的 assetId/canvasId，工具调用也会在共享操作层被 scope_denied 拒绝。
export function turnContextPrefix({ canvasId, selectedNodeIds = [], references = [], permissionMode = 'canvas' }) {
  const parts = [`当前画布 ${canvasId}`];
  parts.push(permissionMode==='read-only' ? '只能读取工作区内容，不能修改或生成' : permissionMode==='full-access' ? '可以读取和修改本工作区的画布；付费生成仍需用户确认' : '可修改当前画布，其他画布只读');
  const selected = selectedNodeIds.map((id) => String(id)).filter(Boolean);
  if (selected.length > 0) parts.push(`选中对象: ${selected.join(', ')}`);
  const assets = references.filter((item) => item?.kind === 'asset' && item.id).map((item) => String(item.id));
  const canvases = references.filter((item) => item?.kind === 'canvas' && item.id).map((item) => String(item.id));
  if (assets.length > 0) parts.push(`已引用素材: ${assets.join(', ')}`);
  if (canvases.length > 0) parts.push(`已引用画布${permissionMode==='full-access'?'':'（只读）'}: ${canvases.join(', ')}`);
  return `[${parts.join('｜')}]`;
}

// providerRegistration 构造要登记给 pi 的供应商：
// 密钥以环境变量引用形式传入，宿主进程内解析，不写进 auth.json。
// Anthropic 协议打开 reasoning，由会话的 thinkingLevel 决定思考预算（off 时显式关闭）。
// OpenAI 兼容协议保持关闭：pi-ai 对 reasoning 模型会改发 developer 角色和 reasoning_effort，
// 这些未在实际接入的兼容服务上验证过。
export function providerRegistration({ api, baseUrl, modelId, maxTokens, contextWindow }) {
  return {
    name: 'BeefTV', baseUrl, apiKey: '$BEEFTV_AGENT_API_KEY', api,
    models: [{ id: modelId, name: modelId, reasoning: api === 'anthropic-messages', input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow, maxTokens }],
  };
}

// providerUnavailableReason 给出机器可读原因，交给后端的状态投影使用。
export function providerUnavailableReason({ modelId, baseUrl, apiKey, api }) {
  if (!modelId || !baseUrl || !apiKey) return 'model_not_configured';
  if (!SUPPORTED_APIS.includes(api)) return 'model_protocol_unsupported';
  return '';
}

// SDK 终态消息而不是 Promise 是否 reject 决定模型调用是否成功。
export function modelTurnCompletion(lastAssistantMessage, promptError = null, budgetFailure = null, { cancelled = false, timedOut = false } = {}) {
  const reply = (lastAssistantMessage?.content || [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('');
  if (budgetFailure) return { reply, error: budgetFailure.message, errorReason: budgetFailure.reason };
  if (timedOut) return { reply, error: '这一轮处理超时，已停止继续执行。', errorReason: 'turn_timeout' };
  if (cancelled) return { reply, error: null, errorReason: null };
  if (promptError) return { reply, error: String(promptError), errorReason: 'model_request_failed' };
  if (lastAssistantMessage?.stopReason === 'error') {
    return { reply, error: lastAssistantMessage.errorMessage || '模型调用没有完成', errorReason: 'model_request_failed' };
  }
  return { reply, error: null, errorReason: null };
}

// Starts and completions share the official SessionManager journal; no second chat database.
// A missing completion after restart is an interrupted turn, not an empty history.
export function projectTurnHistory(entries, turnType, activeTurnId = '') {
  const turns = new Map();
  const supplements = new Map();
  for (const entry of entries) {
    if (entry.type !== 'custom' || !entry.data?.turnId) continue;
    const data = entry.data;
    if (entry.customType === `${turnType}.supplement`) {
      const list = supplements.get(data.turnId) || [];
      list.push(data.message);
      supplements.set(data.turnId, list);
      continue;
    }
    if (entry.customType === turnType) {
      turns.set(data.turnId, { finished: true, data });
    } else if (entry.customType === `${turnType}.started` && !turns.has(data.turnId)) {
      turns.set(data.turnId, { finished: false, data: {
        ...data, reply: '', toolCalls: [], change: null, proposals: [], cancelled: false,
        error: '上一轮执行中断，请核对已落地的改动。', errorReason: 'turn_interrupted',
      } });
    }
  }
  return [...turns.values()]
    .filter((entry) => entry.finished || entry.data.turnId !== activeTurnId)
    .map((entry) => {
      const accepted = supplements.get(entry.data.turnId) || entry.data.supplements;
      return accepted ? { ...entry.data, supplements: accepted } : entry.data;
    });
}
