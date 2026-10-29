import { test, expect } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { createOperationBridge } from './operation-bridge.mjs';
import { newTurnAccumulator, resetTurnAccumulator } from './canvas-turn.mjs';

// The endpoint enforces revision CAS and stable operation-ID payload equality,
// rather than returning replayed=true independently of the transmitted request.
async function fixture(run) {
  const state = { revisions: { A: 9, B: 9 }, receipts: new Map(), posts: [], writes: 0 };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ops') {
      const properties = { canvasId: { type: 'string' }, expectedRevision: { type: 'integer' },
        nodeId: { type: 'string' }, patch: { type: 'object' }, document: { type: 'object' } };
      res.end(JSON.stringify({ code: 0, data: { ops: [
        { id: 'canvas.node.update', summary: 'patch', assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false, params: { type: 'object', properties } },
        { id: 'canvas.document.commit', summary: 'document', assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false, params: { type: 'object', properties } },
      ] } }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const { opId, params } = JSON.parse(body);
    const op = req.url.slice('/ops/'.length);
    state.posts.push({ opId, op, params });
    const fail = (reason) => {
      res.writeHead(409);
      res.end(JSON.stringify({ code: 1, reason, msg: reason }));
    };
    const prior = state.receipts.get(opId);
    if (prior) {
      if (prior.body !== body) return fail('operation_id_reused_with_different_payload');
      res.end(JSON.stringify({ code: 0, data: { replayed: true, result: prior.result } }));
      return;
    }
    if (state.revisions[params.canvasId] !== params.expectedRevision) return fail('stale_revision');
    state.writes++;
    const result = { canvasId: params.canvasId, nodeId: params.nodeId,
      revision: ++state.revisions[params.canvasId] };
    state.receipts.set(opId, { body, result });
    res.end(JSON.stringify({ code: 0, data: { replayed: false, result } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${server.address().port}`,
    hostToken: 'synthetic-only', turnBudgetContext: new AsyncLocalStorage() });
  await bridge.loadDescriptors();
  const build = (turn, generation = {}) => {
    const tools = bridge.buildTools('A', [], { aborted: false, permissionMode: 'full-access', ...generation }, turn, 'stable-session');
    return (id, canvasId = 'A', expectedRevision = 9, patch = { title: id }, name = 'canvas_node_update') =>
      tools.find(tool => tool.name === name).execute(id, { canvasId, expectedRevision,
        ...(name === 'canvas_document_commit' ? { document: { nodes: [] } } : { nodeId: 'node', patch }) });
  };
  try {
    await run({ state, build, turn: resetTurnAccumulator(newTurnAccumulator(), 9, 'turn-one') });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('full-access writes cannot borrow another canvas chain to swallow its user conflict', async () => {
  await fixture(async ({ state, build, turn }) => {
    const call = build(turn);
    await call('a1');
    state.revisions.B = 10; // The user, not this turn, edited B.
    await expect(call('b1', 'B')).rejects.toThrow('stale_revision');
    expect(state.posts.at(-1).params.expectedRevision).toBe(9);
    expect(state.writes).toBe(1);
    expect(state.revisions).toEqual({ A: 10, B: 10 });
    await call('a2');
    expect(state.posts.at(-1).params.expectedRevision).toBe(10);
    expect(turn.writeChains).toEqual([{ canvasId: 'A', start: 9, head: 11 }]);
  });
});

test('stable tool replay uses its first wire revision after later own writes', async () => {
  await fixture(async ({ state, build, turn }) => {
    const call = build(turn);
    await call('first');
    await call('second');
    await call('first');
    await call('second');
    expect(state.posts.map(p => p.params.expectedRevision)).toEqual([9, 10, 9, 10]);
    expect(state.writes).toBe(2);
    expect(state.receipts.size).toBe(2);
    expect(state.revisions.A).toBe(11);
  });
});

test('JSON persisted pre-send effects retain all wire revisions across bridge reconstruction', async () => {
  await fixture(async ({ state, build, turn }) => {
    let persisted;
    const call = build(turn, { persistEffects: async () => { persisted = JSON.stringify(turn); } });
    await call('first');
    await call('second');
    await call('third');
    // Simulate a kill after Go committed the third effect, before its result
    // was stored: only the last pre-send JSON state survives.
    const restored = JSON.parse(persisted);
    expect(restored.writeChains[0].head).toBe(11);
    expect(restored.writeRequests.map(r => r.sentRevision)).toEqual([9, 10, 11]);
    const replay = build(restored);
    for (const id of ['first', 'second', 'third']) await replay(id);
    expect(state.posts.map(p => p.params.expectedRevision)).toEqual([9, 10, 11, 9, 10, 11]);
    expect(state.writes).toBe(3);
    expect(state.revisions.A).toBe(12);
    await replay('fourth');
    expect(state.posts.at(-1).params.expectedRevision).toBe(12);
    expect(state.writes).toBe(4);
    expect(restored.writeChains[0].head).toBe(13);
  });
});

test('first write replay restores an absent chain without swallowing later foreign edits', async () => {
  await fixture(async ({ state, build, turn }) => {
    let persisted;
    await build(turn, { persistEffects: async () => { persisted = JSON.stringify(turn); } })('first');
    const restored = JSON.parse(persisted);
    expect(restored.writeChains).toEqual([]);
    const replay = build(restored);
    await replay('first');
    expect(restored.writeChains).toEqual([{ canvasId: 'A', start: 9, head: 10 }]);
    state.revisions.A = 11; // A user edit after the committed first operation.
    await expect(replay('second')).rejects.toThrow('stale_revision');
    expect(state.posts.at(-1).params.expectedRevision).toBe(10);
    expect(state.writes).toBe(1);
  });
});

test('failed persistence never sends the chosen write to the business endpoint', async () => {
  await fixture(async ({ state, build, turn }) => {
    const call = build(turn, { persistEffects: async () => { throw new Error('sqlite_unavailable'); } });
    await expect(call('first')).rejects.toThrow('sqlite_unavailable');
    expect(state.posts).toEqual([]);
    expect(state.writes).toBe(0);
    expect(state.revisions.A).toBe(9);
  });
});

test('new input or Stop during pre-send persistence blocks the stale write', async () => {
  for (const stopped of [false, true]) {
    await fixture(async ({ state, build, turn }) => {
      const call = build(turn, { persistEffects: async function () {
        await Promise.resolve();
        if (stopped) this.aborted = true;
        else this.pendingInput = { state: 'pending' };
      } });
      await expect(call('first')).rejects.toThrow(stopped ? 'aborted' : 'turn_intent_changed');
      expect(state.posts).toEqual([]);
      expect(state.writes).toBe(0);
    });
  }
});

test('changed original revision or payload never reuses a receipt as success', async () => {
  await fixture(async ({ state, build, turn }) => {
    const call = build(turn);
    await call('first');
    await expect(call('first', 'A', 10)).rejects.toThrow('operation_id_reused_with_different_payload');
    expect(state.posts).toHaveLength(1);
    await expect(call('first', 'A', 9, { title: 'different' })).rejects.toThrow('operation_id_reused_with_different_payload');
    expect(state.writes).toBe(1);
    expect(state.revisions.A).toBe(10);
  });
});

test('whole-document writes stay stale and a fresh business turn inherits no write chain', async () => {
  await fixture(async ({ state, build, turn }) => {
    const call = build(turn);
    await call('first');
    await expect(call('document', 'A', 9, {}, 'canvas_document_commit')).rejects.toThrow('stale_revision');
    expect(state.posts.at(-1).params.expectedRevision).toBe(9);
    resetTurnAccumulator(turn, 10, 'turn-two');
    expect(turn.writeRequests).toEqual([]);
    expect(turn.writeChains).toEqual([]);
    await expect(call('fresh')).rejects.toThrow('stale_revision');
    expect(state.posts.at(-1).params.expectedRevision).toBe(9);
    expect(state.writes).toBe(1);
  });
});
