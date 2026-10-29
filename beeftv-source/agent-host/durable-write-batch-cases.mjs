import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createOperationBridge } from './operation-bridge.mjs';
import { modelFixture } from './test-support/durable-model-switch-probe.mjs';

const calls = [
  { id: 'edge-one', name: 'canvas_edge_create', args: { fromNodeId: 'reference', toNodeId: 'shot-one', expectedRevision: 9 } },
  { id: 'configure', name: 'canvas_node_configure', args: { nodeId: 'shot-two', kind: 'image', patch: { size: '9:16' }, expectedRevision: 9 } },
  { id: 'edge-two', name: 'canvas_edge_create', args: { fromNodeId: 'reference', toNodeId: 'shot-three', expectedRevision: 9 } },
];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const text = message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text || '').join('');

async function batchFixture(foreignWrite, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-write-batch-'));
  const entered = deferred(), release = deferred(), overlapped = deferred();
  const state = { revision: 9, posts: [], receipts: new Map(), edges: [], size: '16:9', active: 0, maxActive: 0, failures: [] };
  const properties = { canvasId: { type: 'string' }, expectedRevision: { type: 'integer' },
    fromNodeId: { type: 'string' }, toNodeId: { type: 'string' }, nodeId: { type: 'string' },
    kind: { type: 'string' }, patch: { type: 'object', properties: { size: { type: 'string' } } } };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ops') {
      res.end(JSON.stringify({ code: 0, data: { ops: ['canvas.edge.create', 'canvas.node.configure'].map(id => ({
        id, summary: id, assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false,
        params: { type: 'object', properties },
      })) } }));
      return;
    }
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    if (state.active > 1) overlapped.resolve();
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw), { opId, params } = input;
      state.posts.push({ ...input, op: req.url.slice('/ops/'.length) });
      if (state.posts.length === 1) { entered.resolve(); await release.promise; }
      const prior = state.receipts.get(opId);
      if (prior) {
        assert.equal(raw, prior.raw, 'replay changed its first wire payload');
        res.end(JSON.stringify({ code: 0, data: { replayed: true, result: prior.result } }));
        return;
      }
      if (params.expectedRevision !== state.revision) {
        state.failures.push('revision_conflict');
        res.writeHead(409);
        res.end(JSON.stringify({ code: 409, reason: 'revision_conflict', msg: 'canvas changed', details: { currentRevision: state.revision } }));
        return;
      }
      assert.equal(params.canvasId, 'canvas');
      const revision = ++state.revision;
      let result;
      if (req.url === '/ops/canvas.edge.create') {
        const edgeId = `edge-${revision}`;
        state.edges.push({ id: edgeId, from: params.fromNodeId, to: params.toNodeId });
        result = { canvasId: 'canvas', revision, edgeId, created: true };
      } else {
        assert.equal(req.url, '/ops/canvas.node.configure');
        state.size = params.patch.size;
        result = { canvasId: 'canvas', revision, nodeId: params.nodeId, draftConfigured: true,
          node: { id: params.nodeId, type: 'image', title: 'Known shot', metadata: { size: state.size } } };
      }
      state.receipts.set(opId, { raw, result });
      if (foreignWrite && state.receipts.size === 1) { state.revision++; state.size = '4:3'; }
      res.end(JSON.stringify({ code: 0, data: { replayed: false, result } }));
    } catch (error) {
      state.failure = error;
      res.writeHead(500); res.end(JSON.stringify({ code: 500, reason: 'fixture_failed' }));
    } finally { state.active--; }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let fixture;
  try {
    const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${server.address().port}`, hostToken: 'synthetic', turnBudgetContext: new AsyncLocalStorage() });
    await bridge.loadDescriptors();
    let response = 0;
    fixture = await modelFixture(directory, 'fixture', ['fixture'], () => ++response === 1 ? { toolCalls: calls } : { reply: 'Reviewed all three operation results.' }, { buildTools: bridge.buildTools });
    const entry = await fixture.store.createSession('canvas');
    const input = { turnId: 'batch-turn', requestId: 'batch-request', revisionBefore: 9, content: 'Apply independent writes to the known nodes.' };
    const submission = await fixture.store.submit(entry, input);
    const waiting = fixture.store.wait(entry, submission);
    let serialError;
    try {
      await Promise.race([entered.promise, waiting.then(() => { throw new Error('official round ended before the first business call'); })]);
      // Hold the first HTTP write so a parallel official tool round would
      // overlap requests instead of accidentally passing on a fast endpoint.
      await Promise.race([overlapped.promise, delay(50)]);
      assert.equal(state.posts.length, 1);
      assert.equal(state.maxActive, 1);
    } catch (error) { serialError = error; }
    finally { release.resolve(); }
    const result = await waiting;
    if (serialError) throw serialError;
    if (state.failure) throw state.failure;
    assert.equal(result.error, null);
    assert.equal(state.maxActive, 1);
    assert.equal(fixture.requests.length, 2, 'the first response must issue all three calls');
    const replies = fixture.payloads[1].messages.filter(message => message.role === 'tool');
    assert.deepEqual(replies.map(reply => reply.tool_call_id), calls.map(call => call.id));
    assert.deepEqual(state.posts.map(post => post.op), ['canvas.edge.create', 'canvas.node.configure', 'canvas.edge.create']);
    assert.equal(new Set(state.posts.map(post => post.opId)).size, 3);
    await run({ state, result, replies });
    const duplicate = await fixture.store.submit(entry, input);
    assert.equal(duplicate.id, submission.id);
    await fixture.store.wait(entry, duplicate);
    assert.equal(state.posts.length, 3, 'observing the completed request must not repeat any write');
    assert.equal(fixture.requests.length, 2);
  } finally {
    release.resolve();
    await fixture?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('one official response serializes mixed independent writes and chains their shared old revision', { timeout: 30000 }, async () => {
  await batchFixture(false, async ({ state, result, replies }) => {
    assert.deepEqual(state.posts.map(post => post.params.expectedRevision), [9, 10, 11]);
    assert.equal(state.revision, 12); assert.equal(state.receipts.size, 3);
    assert.equal(state.size, '9:16'); assert.equal(state.edges.length, 2);
    assert.deepEqual(replies.map(reply => JSON.parse(text(reply)).result.revision), [10, 11, 12]);
    assert.deepEqual(result.toolCalls.map(call => call.isError), [false, false, false]);
    assert.deepEqual(result.toolCalls.map(call => call.rebasedFrom), [undefined, 9, 9]);
    assert.equal(result.change.revisionAfter, 12);
    assert.equal(result.change.operationIds.length, 3);
  });
});

test('a foreign edit between same-response writes stays intact and later calls fail CAS without retrying', { timeout: 30000 }, async () => {
  await batchFixture(true, async ({ state, result, replies }) => {
    assert.deepEqual(state.posts.map(post => post.params.expectedRevision), [9, 10, 10]);
    assert.equal(state.revision, 11); assert.equal(state.receipts.size, 1);
    assert.equal(state.size, '4:3'); assert.equal(state.edges.length, 1);
    assert.deepEqual(state.failures, ['revision_conflict', 'revision_conflict']);
    assert.equal(JSON.parse(text(replies[0])).result.revision, 10);
    for (const reply of replies.slice(1)) assert.match(text(reply), /revision_conflict/);
    // Sequential is neither atomic nor fail-fast: the first write remains,
    // and the third queued call also runs but cannot swallow the foreign edit.
    assert.deepEqual(result.toolCalls.map(call => call.isError), [false, true, true]);
    assert.equal(result.change.revisionAfter, 10);
    assert.equal(result.change.operationIds.length, 1);
  });
});
