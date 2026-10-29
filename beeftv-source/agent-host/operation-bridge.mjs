// 操作桥：把已鉴权的共享 ops 能力变成官方 customTools。
// 画布 scope、operationId 与回合身份只在这里注入；业务规则仍在 Go 操作层。
// 内置助手对 canvas.node.update 做字段投影：模型只看到 title/content。
// 遗留 patch.prompt 仍留给 CLI/MCP；模型若编造该字段，在本桥拒绝，避免清空可见草稿。

import { collectTurnEffects, extendWriteChain, rebaseOntoWriteChain } from './canvas-turn.mjs';
import { toolOperationId } from './session-identity.mjs';
import { budgetError, spendToolStep } from './request-budget.mjs';
import { mediaToolResult, mediaFacts, mediaEvidence } from './media-content.mjs';
import { canvasReadView, CANVAS_READ_VIEW_SCHEMA } from './canvas-read-view.mjs';
import { canvasWriteView, canvasWriteViewDescription } from './canvas-write-view.mjs';
import { awaitBusinessTasks } from './await-business-tasks.mjs';
import { timelineDeliveryTool } from './timeline-delivery.mjs';

const CANVAS_NODE_UPDATE = 'canvas.node.update';

// 局部写入：模型从同一份旧版本并行发出的几次写入，可以接到本轮自己的最新版本上。
// canvas.document.commit 提交的是整份文档，旧版本的整份文档会覆盖本轮刚写的内容，所以不改写。
const REBASABLE_WRITES = new Set([
  'canvas.nodes.create',
  'canvas.edge.create',
  CANVAS_NODE_UPDATE,
  'canvas.node.configure',
  'canvas.node.move',
  'canvas.script.rows.append',
  'canvas.script.row.update',
  'canvas.script.row.remove',
]);

function assertToolGeneration(generation, descriptor, signal) {
  if (generation.aborted || signal?.aborted) throw new Error('aborted');
  if (generation.permissionMode === 'read-only' && (!descriptor.readOnly || descriptor.id === 'canvas.generation.propose')) throw new Error('scope_denied: 本轮助手只能读取');
  if ((!descriptor.readOnly || descriptor.id === 'canvas.generation.propose') &&
      (generation.pendingInput?.state === 'pending' || generation.pendingInputError || generation.modelEpoch !== generation.intentEpoch)) {
    throw new Error('turn_intent_changed: 已收到新的要求，先读取新要求再修改');
  }
}

export const ASSISTANT_CANVAS_NODE_UPDATE_PATCH = {
  title: {
    type: 'string',
    description: '节点名称。只在要改名时提交。',
  },
  content: {
    type: 'string',
    description: '媒体节点的下次生成提示词草稿，或文本节点的正文。只提交要改的字段；省略的字段保持原样。',
  },
};

export function createOperationBridge({
  opsUrl,
  hostToken,
  desktopToken = '',
  readOnly = false,
  turnBudgetContext,
  mediaModel = { api: '', modelId: '' },
  nativePartStore,
}) {
  const descriptors = new Map();

  async function opsRequest(method, apiPath, body, signal, turnId) {
    const timeoutMs = apiPath.startsWith('/ops/media.') ? 95000 : 30000;
    const response = await fetch(`${opsUrl}${apiPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Beeftv-Agent-Token': hostToken,
        ...(turnId ? { 'X-Beeftv-Agent-Turn': turnId } : {}),
        ...(desktopToken ? { 'X-Desktop-Token': desktopToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let envelope = null;
    try { envelope = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!response.ok || !envelope || envelope.code !== 0) {
      const error = new Error(`${envelope?.reason || `http_${response.status}`}: ${envelope?.msg || text.slice(0, 200)}`);
      error.reason = envelope?.reason || `http_${response.status}`;
      error.details = envelope?.details || null;
      throw error;
    }
    return envelope.data;
  }

  async function loadDescriptors() {
    const data = await opsRequest('GET', '/ops');
    const ops = (data.ops || []).filter((descriptor) => !readOnly || descriptor.readOnly);
    descriptors.clear();
    for (const descriptor of ops) descriptors.set(descriptor.id.replace(/\./g, '_'), descriptor);
    return descriptors.size;
  }

  function buildTools(canvasId, log, generation, turn, identityPrefix) {
    const mode = generation.permissionMode || 'canvas';
    const tools = [...descriptors.entries()].filter(([,d]) => Array.isArray(d.assistantModes) && d.assistantModes.includes(mode)).map(([toolName, descriptor]) => ({
      name: toolName,
      label: descriptor.id,
      readOnly: descriptor.readOnly === true,
      replay: descriptor.replay === 'safe' ? 'safe' : 'unsafe',
      description: descriptor.summary + (descriptor.id === 'canvas.get'
        ? '。返回有界只读视图：revision 与真实节点/连线；readView 标明完整或部分。沿 nextOffset 分页，长字段按 nodeId/fieldPath/textOffset 读取，不把 preview 当完整原文；后续读取带 expectedRevision。'
        : canvasWriteViewDescription(descriptor.id)),
      parameters: scopedSchema(descriptor.params, mode !== 'canvas' || descriptor.id === 'canvas.get', descriptor.id),
      ...(descriptor.readOnly ? {} : { executionMode: 'sequential' }),
      execute: async (toolCallId, args, signal, api = {}) => {
        assertToolGeneration(generation, descriptor, signal);
        const budget = turnBudgetContext.getStore();
        const step = spendToolStep(budget);
        if (!step.allowed) {
          if (budget) budget.failure = step;
          log.push({ toolCallId: toolCallId || null, tool: descriptor.id, args: args || {}, isError: true, error: step.message });
          throw budgetError(step);
        }
        const params = { ...(args || {}) };
        const readView = descriptor.id === 'canvas.get' ? params.readView : undefined;
        if (descriptor.id === 'canvas.get') delete params.readView;
        delete params.operationId;
        delete params.opId;
        if (descriptor.id === 'canvas.search') {
          // The public operation's legacy canvasId is a PROJECT filter, not a
          // canvas scope. Keep explicit old callers compatible; never inject it.
          if (params.projectId !== undefined) {
            if (typeof params.projectId !== 'string' || (params.canvasId !== undefined && params.canvasId !== params.projectId)) throw new Error('invalid_project_filter');
            params.canvasId = params.projectId;
            delete params.projectId;
          }
        } else if (Object.hasOwn(descriptor.params?.properties || {}, 'canvasId')) {
          if ((generation.permissionMode || 'canvas') === 'canvas' && descriptor.id !== 'canvas.get' && params.canvasId !== undefined && params.canvasId !== canvasId) {
            throw new Error(`scope_denied: 画布参数与当前会话不一致（${params.canvasId} ≠ ${canvasId}）`);
          }
          if (params.canvasId === undefined) params.canvasId = canvasId;
        }
        let opId = '';
        if (!descriptor.readOnly) {
          if (!toolCallId) {
            throw new Error(`missing_tool_call_id: ${descriptor.id} 写入缺少工具调用标识，已拒绝以免重复写入`);
          }
          opId = toolOperationId(identityPrefix, toolCallId);
          if (descriptor.id === 'canvas.task.bind') {
            // Binding has one durable identity shared with automatic task delivery.
            // Normalize the default too, so a replay uses the same payload hash.
            params.taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
            params.nodeId = typeof params.nodeId === 'string' ? params.nodeId.trim() : '';
            params.outputIndex = params.outputIndex ?? 0;
            if (!params.taskId || !params.nodeId || !Number.isSafeInteger(params.outputIndex) || params.outputIndex < 0) {
              throw new Error('invalid_params: 绑定产物需要有效任务、节点和输出序号');
            }
            opId = `attach-node:${params.taskId}:${params.nodeId}:${params.outputIndex}`;
          }
        }
        let rebasedFrom;
        const chainWrite = REBASABLE_WRITES.has(descriptor.id) && typeof params.canvasId === 'string' && Number.isSafeInteger(params.expectedRevision);
        if (chainWrite) {
          turn.writeRequests ||= [];
          const prior = turn.writeRequests.find(item => item.opId === opId);
          if (prior && (prior.opID !== descriptor.id || prior.canvasId !== params.canvasId || prior.expectedRevision !== params.expectedRevision)) {
            throw new Error('operation_id_reused_with_different_payload: 工具调用标识对应的操作已经改变');
          }
          const rebased = prior ? prior.sentRevision : rebaseOntoWriteChain(turn, params.canvasId, params.expectedRevision);
          if (!prior) turn.writeRequests.push({ opId, opID: descriptor.id, canvasId: params.canvasId, expectedRevision: params.expectedRevision, sentRevision: rebased });
          if (rebased !== params.expectedRevision) {
            rebasedFrom = params.expectedRevision;
            params.expectedRevision = rebased;
          }
        }
        const rebaseNote = rebasedFrom === undefined ? {} : { rebasedFrom };
        const started = Date.now();
        try {
          assertAssistantNodeUpdateArgs(descriptor, params);
          // Persist the first wire revision before Go can commit. A resumed
          // tool must reuse that revision, even after this turn's chain advances.
          if (chainWrite && generation.persistEffects) await generation.persistEffects();
          assertToolGeneration(generation, descriptor, signal);
          let data = await opsRequest('POST', `/ops/${descriptor.id}`, { opId, params }, signal, turn.turnId);
          if (descriptor.id === 'canvas.generation.submit' || descriptor.id === 'canvas.timeline.render') {
            data = await awaitBusinessTasks(data, { opsRequest, turnId: turn.turnId, signal, canvasId: params.canvasId,
              rendering: descriptor.id === 'canvas.timeline.render', onProgress: api.reportProgress });
          }
          // A replay can recover the receipt lost between business commit and
          // the durable checkpoint. Only our persisted request may advance
          // its own canvas chain by exactly one; older replays never reset it.
          if (!descriptor.readOnly && !data?.replayed) {
            extendWriteChain(turn, params.canvasId, params.expectedRevision, data?.result?.revision);
          } else if (chainWrite && data?.replayed) {
            const request = turn.writeRequests?.find(item => item.opId === opId);
            const chain = turn.writeChains?.find(item => item.canvasId === params.canvasId);
            if (request?.opID === descriptor.id && request.canvasId === params.canvasId &&
                request.sentRevision === params.expectedRevision &&
                data?.result?.canvasId === params.canvasId &&
                data?.result?.revision === request.sentRevision + 1 &&
                (!chain || chain.head === request.sentRevision)) {
              extendWriteChain(turn, params.canvasId, request.sentRevision, data.result.revision);
            }
          }
          // A binding replay projects the current canvas, not a write by this turn.
          if (descriptor.id !== 'canvas.task.bind' || !data?.replayed) {
            collectTurnEffects(turn, descriptor.id, data?.result, opId);
          }
          const converted = mediaToolResult(descriptor.id === 'canvas.get' ? canvasReadView(data, readView) : canvasWriteView(data, descriptor.id, params), descriptor.id, { ...mediaModel, originTurnId:turn.turnId,
            ...(generation.durable ? {nativePartStore} : {}) });
          const evidence = mediaEvidence(data?.result, descriptor.id);
          const facts = evidence ? undefined : mediaFacts(data?.result, descriptor.id);
          log.push({ toolCallId: toolCallId || null, tool: descriptor.id, args: params, isError: false, ms: Date.now() - started, replayed: !!data?.replayed, ...rebaseNote,
            ...(facts ? { mediaFacts: facts } : {}), ...(evidence ? { mediaEvidence: evidence } : {}) });
          return converted;
        } catch (error) {
          log.push({ toolCallId: toolCallId || null, tool: descriptor.id, args: params, isError: true, error: error.message, ms: Date.now() - started, ...rebaseNote });
          throw error;
        }
      },
    }));
    const delivery = timelineDeliveryTool(tools);
    return delivery ? [...tools, delivery] : tools;
  }

  return { descriptors, opsRequest, loadDescriptors, buildTools };
}

export function scopedSchema(params, allowReferencedCanvasRead = false, descriptorId = '') {
  if (allowReferencedCanvasRead && typeof allowReferencedCanvasRead === 'object' && !Array.isArray(allowReferencedCanvasRead)) {
    const options = allowReferencedCanvasRead;
    descriptorId = options.descriptorId || descriptorId;
    allowReferencedCanvasRead = options.allowReferencedCanvasRead === true;
  }
  if (!params || typeof params !== 'object') return params;
  const clone = JSON.parse(JSON.stringify(params));
  if (clone.properties) {
    if (!allowReferencedCanvasRead) delete clone.properties.canvasId;
    delete clone.properties.operationId;
  }
  if (Array.isArray(clone.required)) clone.required = clone.required.filter((name) => name !== 'canvasId' && name !== 'operationId');
  if (descriptorId === CANVAS_NODE_UPDATE) projectCanvasNodeUpdateSchema(clone);
  if (descriptorId === 'canvas.search') {
    clone.properties ||= {};
    clone.properties.projectId = { type: 'string', description: '可选项目 ID；省略搜索本账号全部画布。不是画布 ID。' };
    delete clone.properties.canvasId;
  }
  if (descriptorId === 'canvas.get') {
    clone.properties ||= {};
    clone.properties.readView = JSON.parse(JSON.stringify(CANVAS_READ_VIEW_SCHEMA));
  }
  return clone;
}

function projectCanvasNodeUpdateSchema(schema) {
  if (!schema?.properties || typeof schema.properties !== 'object') return;
  const patch = schema.properties.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  patch.properties = {
    title: { ...ASSISTANT_CANVAS_NODE_UPDATE_PATCH.title },
    content: { ...ASSISTANT_CANVAS_NODE_UPDATE_PATCH.content },
  };
  patch.additionalProperties = false;
  if (Array.isArray(patch.required)) {
    patch.required = patch.required.filter((name) => name === 'title' || name === 'content');
  }
}

function assertAssistantNodeUpdateArgs(descriptor, params) {
  if (descriptor.id !== CANVAS_NODE_UPDATE) return;
  const patch = params?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  if (!Object.hasOwn(patch, 'prompt')) return;
  throw new Error('unsupported_patch_field: canvas.node.update 不能提交 patch.prompt。改可编辑提示词请用 content，未改的字段不要提交');
}
