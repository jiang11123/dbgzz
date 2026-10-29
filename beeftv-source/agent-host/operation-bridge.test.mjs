import { describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import descriptors from './operation-descriptors.fixture.json';
import { createTurnBudget } from './request-budget.mjs';
import { ASSISTANT_CANVAS_NODE_UPDATE_PATCH, createOperationBridge, scopedSchema } from './operation-bridge.mjs';
import { newTurnAccumulator, resetTurnAccumulator } from './canvas-turn.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

describe('操作桥', () => {
  test('任务绑定与自动交付共用产物身份，跨会话重试不制造第二次效果', async () => {
    const seen = [];
    const receipts = new Set();
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/ops') {
        res.end(JSON.stringify({ code: 0, data: { ops: [{ id: 'canvas.task.bind', assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false,
          params: { type: 'object', properties: { canvasId: { type: 'string' }, taskId: { type: 'string' }, nodeId: { type: 'string' }, outputIndex: { type: 'integer' } } } }] } }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      seen.push(body);
      const { taskId, nodeId, outputIndex } = body.params;
      const key = `attach-node:${taskId}:${nodeId}:${outputIndex}`;
      if (body.opId !== key) {
        res.writeHead(400); res.end(JSON.stringify({ code: 1, reason: 'effect_identity_mismatch' })); return;
      }
      const replayed = receipts.has(key);
      receipts.add(key);
      res.end(JSON.stringify({ code: 0, data: { replayed, result: { revision: 3, nodeId } } }));
    });
    const port = await listen(server);
    try {
      const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${port}`, hostToken: 'test-only', turnBudgetContext: new AsyncLocalStorage() });
      await bridge.loadDescriptors();
      const turns = new Map();
      const tool = (session) => {
        const turn = resetTurnAccumulator(newTurnAccumulator(), 1, `turn-${session}`);
        turns.set(session, turn);
        return bridge.buildTools('canvas-1', [], { aborted: false }, turn, session)[0];
      };
      const first = await tool('session-A').execute('call-A', { taskId: ' task-1 ', nodeId: ' node-1 ', operationId: 'forged' });
      const replay = await tool('session-B').execute('call-B', { taskId: 'task-1', nodeId: 'node-1', outputIndex: 0 });
      expect(JSON.parse(first.content[0].text).replayed).toBe(false);
      expect(JSON.parse(replay.content[0].text).replayed).toBe(true);
      expect(seen[0]).toEqual({ opId: 'attach-node:task-1:node-1:0', params: { taskId: 'task-1', nodeId: 'node-1', canvasId: 'canvas-1', outputIndex: 0 } });
      expect(seen[1]).toEqual(seen[0]);
      expect(turns.get('session-A').updatedNodeIds).toEqual(['node-1']);
      expect(turns.get('session-B').updatedNodeIds).toEqual([]);
      expect(turns.get('session-B').operationIds).toEqual([]);
      expect(turns.get('session-B').revisionAfter).toBe(0);
      for (const outputIndex of [-1, 0.5, '0']) {
        await expect(tool('session-A').execute('bad', { taskId: 'task-1', nodeId: 'node-1', outputIndex })).rejects.toThrow('invalid_params');
      }
      await expect(tool('session-A').execute('foreign', { canvasId: 'other', taskId: 'task-1', nodeId: 'node-1' })).rejects.toThrow('scope_denied');
      expect(seen).toHaveLength(2);
      expect(receipts.size).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('schema 去掉 canvasId 与 operationId，引用画布读取可保留 canvasId', () => {
    const params = {
      type: 'object',
      properties: { canvasId: { type: 'string' }, operationId: { type: 'string' }, title: { type: 'string' } },
      required: ['canvasId', 'operationId', 'title'],
    };
    expect(scopedSchema(params)).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    });
    expect(scopedSchema(params, true).properties.canvasId).toEqual({ type: 'string' });
    expect(scopedSchema(params, true).properties.operationId).toBeUndefined();
  });

  test('真实 HTTP：凭据与回合头到达 ops，写入 identity 绑定会话', async () => {
    const seen = [];
    const opsServer = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.push({
        url: req.url,
        token: req.headers['x-beeftv-agent-token'],
        turn: req.headers['x-beeftv-agent-turn'],
        body: body ? JSON.parse(body) : {},
      });
      if (req.url === '/ops') {
        res.end(JSON.stringify({
          code: 0,
          data: {
            ops: [{
              id: 'canvas.nodes.create',
              summary: 'Create node',
              assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false,
              params: { type: 'object', properties: { canvasId: { type: 'string' }, nodes: { type: 'array' } }, required: ['canvasId', 'nodes'] },
            }],
          },
        }));
        return;
      }
      res.end(JSON.stringify({ code: 0, data: { op: 'canvas.nodes.create', replayed: false, result: { revision: 2, created: [{ id: 'n1' }] } } }));
    });
    const port = await listen(opsServer);
    const turnBudgetContext = new AsyncLocalStorage();
    try {
      const bridge = createOperationBridge({
        opsUrl: `http://127.0.0.1:${port}`,
        hostToken: 'host-secret',
        desktopToken: '',
        assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false,
        turnBudgetContext,
      });
      await bridge.loadDescriptors();
      const log = [];
      const generation = { aborted: false };
      const turn = resetTurnAccumulator(newTurnAccumulator(), 1, 'turn-9');
      const tools = bridge.buildTools('canvas-1', log, generation, turn, 'sess-A');
      expect(tools[0].parameters.properties.canvasId).toBeUndefined();
      const budget = createTurnBudget({ maxToolSteps: 4 });
      const result = await turnBudgetContext.run(budget, () => tools[0].execute('call-7', { nodes: [{ title: '镜头' }] }, undefined));
      expect(JSON.parse(result.content[0].text).result.created[0].id).toBe('n1');
      const write = seen.find((item) => item.url === '/ops/canvas.nodes.create');
      expect(write.token).toBe('host-secret');
      expect(write.turn).toBe('turn-9');
      expect(write.body.opId).toBe('sess-A:call-7');
      expect(write.body.params.canvasId).toBe('canvas-1');
      expect(write.body.params.operationId).toBeUndefined();
    } finally {
      opsServer.closeAllConnections();
      await new Promise((resolve) => opsServer.close(resolve));
    }
  });
});

const NODE_UPDATE_PARAMS = {
  type: 'object',
  properties: {
    canvasId: { type: 'string' },
    nodeId: { type: 'string' },
    expectedRevision: { type: 'integer' },
    patch: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string' },
        content: { type: 'string' },
      },
    },
  },
  required: ['canvasId', 'nodeId', 'patch', 'expectedRevision'],
};

const NODE_CREATE_PARAMS = {
  type: 'object',
  properties: {
    canvasId: { type: 'string' },
    expectedRevision: { type: 'integer' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, type: { type: 'string' }, prompt: { type: 'string' } },
        required: ['title', 'type'],
      },
    },
  },
  required: ['canvasId', 'nodes', 'expectedRevision'],
};

function nodeUpdateOps() {
  return [
    { id: 'canvas.node.update', summary: '局部修改一个节点', assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false, params: JSON.parse(JSON.stringify(NODE_UPDATE_PARAMS)) },
    { id: 'canvas.nodes.create', summary: '批量创建节点', assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false, params: JSON.parse(JSON.stringify(NODE_CREATE_PARAMS)) },
  ];
}

async function withNodeUpdateBridge(run) {
  const seen = [];
  const opsServer = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    seen.push({ url: req.url, body: parsed });
    if (req.url === '/ops') {
      res.end(JSON.stringify({ code: 0, data: { ops: nodeUpdateOps() } }));
      return;
    }
    res.end(JSON.stringify({
      code: 0,
      data: { op: req.url.slice('/ops/'.length), replayed: false, result: { revision: 4, nodeId: parsed.params?.nodeId } },
    }));
  });
  const port = await listen(opsServer);
  const turnBudgetContext = new AsyncLocalStorage();
  try {
    const bridge = createOperationBridge({
      opsUrl: `http://127.0.0.1:${port}`,
      hostToken: 'host-secret',
      desktopToken: '',
      assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false,
      turnBudgetContext,
    });
    await bridge.loadDescriptors();
    await run({ bridge, seen, turnBudgetContext });
  } finally {
    opsServer.closeAllConnections();
    await new Promise((resolve) => opsServer.close(resolve));
  }
}

describe('内置助手节点更新投影', () => {
  test('boolean 第二参数保持兼容：不声明 descriptor 时不隐藏 prompt', () => {
    const snapshot = JSON.stringify(NODE_UPDATE_PARAMS);
    expect(scopedSchema(NODE_UPDATE_PARAMS, false).properties.patch.properties.prompt).toEqual({ type: 'string' });
    expect(scopedSchema(NODE_UPDATE_PARAMS).properties.canvasId).toBeUndefined();
    expect(JSON.stringify(NODE_UPDATE_PARAMS)).toBe(snapshot);
  });

  test('投影只暴露 title/content，并可用对象第二参数向后兼容', () => {
    const projected = scopedSchema(NODE_UPDATE_PARAMS, false, 'canvas.node.update');
    expect(projected.properties.patch.properties).toEqual(ASSISTANT_CANVAS_NODE_UPDATE_PATCH);
    expect(projected.properties.patch.additionalProperties).toBe(false);
    expect(projected.properties.patch.properties.prompt).toBeUndefined();
    expect(projected.properties.canvasId).toBeUndefined();
    expect(projected.required).toEqual(['nodeId', 'patch', 'expectedRevision']);

    const viaOptions = scopedSchema(NODE_UPDATE_PARAMS, { descriptorId: 'canvas.node.update' });
    expect(viaOptions.properties.patch.properties).toEqual(ASSISTANT_CANVAS_NODE_UPDATE_PATCH);
    expect(viaOptions.properties.canvasId).toBeUndefined();

    const viaReadOptions = scopedSchema(NODE_UPDATE_PARAMS, {
      allowReferencedCanvasRead: true,
      descriptorId: 'canvas.node.update',
    });
    expect(viaReadOptions.properties.canvasId).toEqual({ type: 'string' });
    expect(viaReadOptions.properties.patch.properties.prompt).toBeUndefined();
  });

  test('真实 customTools schema 隐藏 prompt，创建工具仍保留 prompt', async () => {
    await withNodeUpdateBridge(async ({ bridge }) => {
      const stored = bridge.descriptors.get('canvas_node_update');
      const original = JSON.parse(JSON.stringify(stored));
      const tools = bridge.buildTools('canvas-1', [], { aborted: false }, resetTurnAccumulator(newTurnAccumulator(), 3, 'turn-p'), 'sess-P');
      const update = tools.find((tool) => tool.name === 'canvas_node_update');
      const create = tools.find((tool) => tool.name === 'canvas_nodes_create');
      expect(update.parameters.properties.patch.properties).toEqual(ASSISTANT_CANVAS_NODE_UPDATE_PATCH);
      expect(update.parameters.properties.patch.properties.content.description).toContain('下次生成提示词草稿');
      expect(update.parameters.properties.patch.properties.content.description).toContain('文本节点的正文');
      expect(update.parameters.properties.patch.properties.content.description).toContain('省略的字段保持原样');
      expect(update.parameters.properties.patch.properties.prompt).toBeUndefined();
      expect(create.parameters.properties.nodes.items.properties.prompt).toEqual({ type: 'string' });
      expect(bridge.descriptors.get('canvas_node_update')).toEqual(original);
      expect(stored.params.properties.patch.properties.prompt).toEqual({ type: 'string' });
      update.parameters.properties.patch.properties.title.description = 'mutated';
      expect(stored.params.properties.patch.properties.title.description).toBeUndefined();
      expect(stored.params).toEqual(original.params);
    });
  });

  test('执行拒绝编造的 patch.prompt，且不转发到 ops', async () => {
    await withNodeUpdateBridge(async ({ bridge, seen, turnBudgetContext }) => {
      const tools = bridge.buildTools('canvas-1', [], { aborted: false }, resetTurnAccumulator(newTurnAccumulator(), 3, 'turn-p'), 'sess-P');
      const update = tools.find((tool) => tool.name === 'canvas_node_update');
      const budget = createTurnBudget({ maxToolSteps: 4 });
      await expect(turnBudgetContext.run(budget, () => update.execute('call-repro', {
        nodeId: 'img-1',
        expectedRevision: 3,
        patch: { content: '', prompt: '新的提示词', title: '新名字' },
      }))).rejects.toThrow(/unsupported_patch_field: canvas\.node\.update 不能提交 patch\.prompt/);
      expect(seen.filter((item) => item.url === '/ops/canvas.node.update')).toEqual([]);
    });
  });

  test('content 原样转发，不改写字段，省略的字段不会被补上', async () => {
    await withNodeUpdateBridge(async ({ bridge, seen, turnBudgetContext }) => {
      const tools = bridge.buildTools('canvas-1', [], { aborted: false }, resetTurnAccumulator(newTurnAccumulator(), 3, 'turn-p'), 'sess-P');
      const update = tools.find((tool) => tool.name === 'canvas_node_update');
      const budget = createTurnBudget({ maxToolSteps: 4 });
      await turnBudgetContext.run(budget, () => update.execute('call-content', {
        nodeId: 'img-1',
        expectedRevision: 3,
        patch: { title: '新名字', content: '夜景：雨夜巷口对峙' },
      }));
      await turnBudgetContext.run(budget, () => update.execute('call-title-only', {
        nodeId: 'img-1',
        expectedRevision: 4,
        patch: { title: '只改名' },
      }));
      const writes = seen.filter((item) => item.url === '/ops/canvas.node.update');
      expect(writes[0].body.params).toEqual({
        nodeId: 'img-1',
        expectedRevision: 3,
        patch: { title: '新名字', content: '夜景：雨夜巷口对峙' },
        canvasId: 'canvas-1',
      });
      expect(writes[1].body.params.patch).toEqual({ title: '只改名' });
      expect(Object.hasOwn(writes[1].body.params.patch, 'content')).toBe(false);
      expect(Object.hasOwn(writes[1].body.params.patch, 'prompt')).toBe(false);
      expect(writes[0].body.params.patch).not.toHaveProperty('prompt');
    });
  });
});


test('media discovery preserves descriptions, required versions and modes in model-facing bridge tools', async () => {
  // TestHostPolicyContract compares this shared fixture with the Go registry.
  // Exercise those descriptors over HTTP without parsing Go source syntax.
  const ops = descriptors.filter(op => ['media.overview', 'media.inspect', 'media.check'].includes(op.id));
  expect(ops).toHaveLength(3);
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 0, data: { ops } }));
  });
  const port = await listen(server);
  try {
    const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${port}`, hostToken: 'test-only', turnBudgetContext: new AsyncLocalStorage() });
    await bridge.loadDescriptors();
    const tools = bridge.buildTools('canvas', [], { aborted: false }, newTurnAccumulator(), 'session');
    expect(new Set(tools.map(tool => tool.description)).size).toBe(3);
    for (const tool of tools) {
      const original = ops.find(op => op.id === tool.label);
      expect(tool.description).toBe(original.summary);
      expect(tool.parameters.properties.mode).toEqual(original.params.properties.mode);
      expect(tool.parameters.properties.mode.description).toContain('不能判断连续运动或声音');
      expect(tool.parameters.properties.mode.enum).toEqual(['frames', 'video', 'audio']);
      expect(tool.parameters.properties.expectedVersion).toEqual(original.params.properties.expectedVersion);
      expect(tool.parameters.properties.expectedVersion.minLength).toBe(1);
      expect(tool.parameters.required.includes('expectedVersion')).toBe(tool.label !== 'media.overview');
      expect(tool.parameters.properties.canvasId).toBeUndefined();
    }
    expect(tools.find(tool => tool.name === 'media_inspect').description).toContain('15 秒');
    expect(tools.find(tool => tool.name === 'media_overview').description).toContain('不能替代');
    expect(tools.find(tool => tool.name === 'media_check').description).toContain('不能判断');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('media review exposes and forwards the selected resource with its owned target', async () => {
  const descriptor = descriptors.find(op => op.id === 'media.review');
  const requests = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ops') {
      res.end(JSON.stringify({ code: 0, data: { ops: [descriptor] } }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: JSON.parse(raw) });
    res.end(JSON.stringify({ code: 0, data: { result: { review: { observations: 'fixture observation' } } } }));
  });
  const port = await listen(server);
  try {
    const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${port}`, hostToken: 'test-only', turnBudgetContext: new AsyncLocalStorage() });
    await bridge.loadDescriptors();
    const tool = bridge.buildTools('canvas', [], { aborted: false }, newTurnAccumulator(), 'session')[0];
    expect(tool.name).toBe('media_review');
    expect(tool.parameters.properties.resourceId.type).toBe('string');
    expect(tool.parameters.required).not.toContain('resourceId');
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.replay).toBe('unsafe');
    const params = { nodeId: 'node', resourceId: 'selected-resource', expectedVersion: 'version', startMs: 0, endMs: 1000, question: '观察片段' };
    await tool.execute('review-call', params);
    expect(requests).toEqual([{ path: '/ops/media.review', body: { opId: '', params: { ...params, canvasId: 'canvas' } } }]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

const EDGE_CREATE_PARAMS = {
  type: 'object',
  properties: { canvasId: { type: 'string' }, fromNodeId: { type: 'string' }, toNodeId: { type: 'string' }, expectedRevision: { type: 'integer' } },
  required: ['canvasId', 'fromNodeId', 'toNodeId', 'expectedRevision'],
};
const DOCUMENT_COMMIT_PARAMS = {
  type: 'object',
  properties: { canvasId: { type: 'string' }, expectedRevision: { type: 'integer' }, document: { type: 'object' } },
  required: ['canvasId', 'expectedRevision', 'document'],
};

// Fake ops server with a real revision CAS: each accepted write advances the revision by one.
async function withCasBridge(run, { revision = 9 } = {}) {
  const state = { revision, seen: [] };
  const opsServer = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === '/ops') {
      res.end(JSON.stringify({ code: 0, data: { ops: [
        { id: 'canvas.edge.create', summary: '连接两个节点', assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false, params: EDGE_CREATE_PARAMS },
        { id: 'canvas.node.update', summary: '局部修改一个节点', assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false, params: NODE_UPDATE_PARAMS },
        { id: 'canvas.nodes.create', summary: '批量创建节点', assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false, params: NODE_CREATE_PARAMS },
        { id: 'canvas.document.commit', summary: '提交整份画布文档', assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false, params: DOCUMENT_COMMIT_PARAMS },
      ] } }));
      return;
    }
    const op = req.url.slice('/ops/'.length);
    state.seen.push({ op, expectedRevision: parsed.params?.expectedRevision });
    if (parsed.params?.expectedRevision !== state.revision) {
      res.writeHead(409);
      res.end(JSON.stringify({ code: 1, reason: 'stale_revision', msg: '云端画布已有更新' }));
      return;
    }
    state.revision += 1;
    const result = op === 'canvas.edge.create'
      ? { revision: state.revision, created: true, edgeId: `e${state.revision}` }
      : op === 'canvas.nodes.create'
        ? { revision: state.revision, created: [{ id: `n${state.revision}` }] }
        : { revision: state.revision, nodeId: parsed.params?.nodeId };
    res.end(JSON.stringify({ code: 0, data: { op, replayed: false, result } }));
  });
  const port = await listen(opsServer);
  const turnBudgetContext = new AsyncLocalStorage();
  try {
    const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${port}`, hostToken: 'host-secret', turnBudgetContext });
    await bridge.loadDescriptors();
    const turn = resetTurnAccumulator(newTurnAccumulator(), state.revision, 'turn-cas');
    const log = [];
    const tools = bridge.buildTools('canvas-1', log, { aborted: false, permissionMode: 'full-access' }, turn, 'sess-C');
    const budget = createTurnBudget({ maxToolSteps: 20 });
    const call = (name, toolCallId, args) => turnBudgetContext.run(budget, () => tools.find((tool) => tool.name === name).execute(toolCallId, args));
    await run({ state, turn, log, call });
  } finally {
    opsServer.closeAllConnections();
    await new Promise((resolve) => opsServer.close(resolve));
  }
}

describe('同一轮的并行写入', () => {
  test('同一条消息里三次连线都带旧版本 9，按本轮最新版本依次落地', async () => {
    await withCasBridge(async ({ state, turn, log, call }) => {
      for (const [id, to] of [['c1', 'b'], ['c2', 'c'], ['c3', 'd']]) {
        await call('canvas_edge_create', id, { fromNodeId: 'a', toNodeId: to, expectedRevision: 9 });
      }
      expect(state.seen.map((item) => item.expectedRevision)).toEqual([9, 10, 11]);
      expect(state.revision).toBe(12);
      expect(log.map((entry) => entry.isError)).toEqual([false, false, false]);
      expect(log.map((entry) => entry.rebasedFrom)).toEqual([undefined, 9, 9]);
      expect(log[2].args.expectedRevision).toBe(11);
      expect(turn.createdEdgeIds).toEqual(['e10', 'e11', 'e12']);
      expect(turn.revisionAfter).toBe(12);
      expect(JSON.stringify(log)).not.toContain('host-secret');
    });
  });

  test('节点创建与局部修改同样接到本轮链头；按最新版本发来的写入原样转发', async () => {
    await withCasBridge(async ({ state, log, call }) => {
      await call('canvas_nodes_create', 'n1', { nodes: [{ title: '镜头', type: 'image' }], expectedRevision: 9 });
      await call('canvas_node_update', 'u1', { nodeId: 'n10', patch: { title: '改名' }, expectedRevision: 9 });
      await call('canvas_edge_create', 'e1', { fromNodeId: 'a', toNodeId: 'b', expectedRevision: 11 });
      expect(state.seen.map((item) => item.expectedRevision)).toEqual([9, 10, 11]);
      expect(log.map((entry) => entry.rebasedFrom)).toEqual([undefined, 9, undefined]);
    });
  });

  test('别人在中间改过画布时仍然版本冲突', async () => {
    await withCasBridge(async ({ state, log, call }) => {
      await call('canvas_edge_create', 'c1', { fromNodeId: 'a', toNodeId: 'b', expectedRevision: 9 });
      state.revision += 1; // foreign write: 10 -> 11
      await expect(call('canvas_edge_create', 'c2', { fromNodeId: 'a', toNodeId: 'c', expectedRevision: 9 })).rejects.toThrow('stale_revision');
      expect(state.seen.at(-1).expectedRevision).toBe(10);
      // A revision outside this turn's own chain is never rewritten.
      await expect(call('canvas_edge_create', 'c3', { fromNodeId: 'a', toNodeId: 'd', expectedRevision: 8 })).rejects.toThrow('stale_revision');
      expect(state.seen.at(-1).expectedRevision).toBe(8);
      expect(log.at(-1).rebasedFrom).toBeUndefined();
      expect(state.revision).toBe(11);
    });
  });

  test('整份文档提交从不改写版本', async () => {
    await withCasBridge(async ({ state, log, call }) => {
      await call('canvas_edge_create', 'c1', { fromNodeId: 'a', toNodeId: 'b', expectedRevision: 9 });
      await expect(call('canvas_document_commit', 'd1', { document: { nodes: [] }, expectedRevision: 9 })).rejects.toThrow('stale_revision');
      expect(state.seen.at(-1)).toEqual({ op: 'canvas.document.commit', expectedRevision: 9 });
      expect(log.at(-1).rebasedFrom).toBeUndefined();
    });
  });

  test('新的一轮不继承上一轮的写入链', async () => {
    await withCasBridge(async ({ state, turn, log, call }) => {
      await call('canvas_edge_create', 'c1', { fromNodeId: 'a', toNodeId: 'b', expectedRevision: 9 });
      expect(turn.writeChains).toEqual([{ canvasId: 'canvas-1', start: 9, head: 10 }]);
      resetTurnAccumulator(turn, 10, 'turn-next');
      expect(turn.writeChains).toEqual([]);
      expect(turn.writeRequests).toEqual([]);
      await expect(call('canvas_edge_create', 'c2', { fromNodeId: 'a', toNodeId: 'c', expectedRevision: 9 })).rejects.toThrow('stale_revision');
      expect(state.seen.at(-1).expectedRevision).toBe(9);
      expect(log.at(-1).rebasedFrom).toBeUndefined();
    });
  });
});
