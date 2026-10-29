import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BACKGROUND_CONTEXT as CTX } from '@earendil-works/chord/context';
import { createOperationBridge } from './operation-bridge.mjs';
import { modelFixture } from './test-support/durable-model-switch-probe.mjs';

const propose = { id: 'propose', name: 'canvas_generation_propose', args: { nodeIds: ['shot'], kind: 'image' } };
const configure = { id: 'configure', name: 'canvas_node_configure', args: { nodeId: 'shot', kind: 'image', patch: { size: '9:16' }, expectedRevision: 1 } };
const input = { turnId: 'proposal-turn', requestId: 'proposal-request', revisionBefore: 1, content: 'Prepare the next batch for confirmation.' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Real official provider adapter, Durable SQLite/scheduler and operation bridge.
// Only the model and Go HTTP business boundary are local, synthetic stand-ins.
async function fixture(t, { calls = [propose], reject = false, isError = false, beforeProposal, completeTurn, onRequest } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-proposal-yield-'));
  const state = { posts: [], issued: 0, revision: 1, completions: [], models: [] };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ops') {
      res.end(JSON.stringify({ code: 0, data: { ops: ['canvas.generation.propose', 'canvas.node.configure'].map(id => ({
        id, summary: id, assistantModes: ['canvas', 'full-access'], readOnly: id.endsWith('propose'), replay: 'safe',
        params: { type: 'object', properties: { canvasId: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } },
          nodeId: { type: 'string' }, kind: { type: 'string' }, expectedRevision: { type: 'integer' }, patch: { type: 'object' } } },
      })) } })); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); state.posts.push({ url: req.url, ...body });
    if (req.url.endsWith('propose')) {
      await beforeProposal?.();
      if (reject) { res.writeHead(412); res.end(JSON.stringify({ code: 412, reason: 'generation_dependencies_not_ready', msg: 'Reference is not ready' })); return; }
      res.end(JSON.stringify({ code: 0, data: { result: { proposalId: `gp-${++state.issued}`, kind: 'image', nodeIds: body.params.nodeIds,
        model: 'fixture', modelKey: 'beeftv::fixture', note: 'Confirm the next batch',
        source: { canvasId: 'canvas', canvasRevision: state.revision, modelConfigRevision: 1 } } } })); return;
    }
    assert.equal(req.url, '/ops/canvas.node.configure');
    res.end(JSON.stringify({ code: 0, data: { result: { canvasId: 'canvas', revision: ++state.revision, nodeId: 'shot',
      node: { id: 'shot', type: 'image', metadata: body.params.patch } } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bridge = createOperationBridge({ opsUrl: `http://127.0.0.1:${server.address().port}`, hostToken: 'synthetic', turnBudgetContext: new AsyncLocalStorage() });
  await bridge.loadDescriptors();
  let active;
  const open = async (recovering = false) => {
    active = await modelFixture(directory, 'fixture', ['fixture'], async body => {
      state.models.push(body);
      return await onRequest?.(body, state.models.length) || (state.models.length === 1 ? { toolCalls: calls } : { reply: 'Processed every result.' });
    }, {
      buildTools: (...args) => bridge.buildTools(...args).map(tool => !isError || tool.label !== 'canvas.generation.propose' ? tool : {
        ...tool, execute: async (...args) => ({ ...await tool.execute(...args), isError: true }),
      }),
      completeTurn: async data => { await completeTurn?.(data, recovering); state.completions.push(data); },
    });
    return active;
  };
  const result = { state, current: await open(), async reopen() { await active.close(); result.current = await open(true); return result.current; } };
  t.after(async () => { await active.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  return result;
}

test('successful proposal ends through official control without a summary request, after Go acknowledgement', { timeout: 30000 }, async t => {
  const completing = deferred(), acknowledge = deferred();
  t.after(() => acknowledge.resolve());
  const f = await fixture(t, { completeTurn: async () => { completing.resolve(); await acknowledge.promise; } });
  const { store } = f.current;
  const entry = await store.createSession('canvas');
  const submission = await store.submit(entry, input);
  let returned = false;
  const waiting = store.wait(entry, submission).then(record => { returned = true; return record; });
  await completing.promise;
  assert.equal((await submission.status(CTX)).status, 'done');
  assert.equal(returned, false, 'Go acknowledgement still gates the public result');
  const pending = await store.history('canvas', entry.sessionId);
  assert.equal(pending.turns.length, 0);
  assert.equal(pending.active.requestId, input.requestId);
  acknowledge.resolve();
  const record = await waiting;
  assert.equal(f.state.models.length, 1, 'no final model summary request');
  assert.equal(record.reply, '', 'a successful tool-only answer needs no invented assistant summary');
  assert.equal(record.error, null); assert.equal(record.cancelled, false); assert.equal(record.status, 'done');
  assert.equal(record.proposals[0].proposalId, 'gp-1'); assert.equal(record.proposals[0].source.canvasRevision, 1);
  assert.deepEqual(record.toolCalls.map(call => [call.tool, call.isError]), [['canvas.generation.propose', false]]);
  assert.deepEqual(f.state.completions.map(item => item.record.proposals), [record.proposals]);
  const replay = await store.submit(entry, input);
  assert.equal(replay.id, submission.id);
  assert.deepEqual((await store.wait(entry, replay)).proposals, record.proposals);
  assert.equal(f.state.issued, 1); assert.equal(f.state.models.length, 1); assert.equal(f.state.completions.length, 1);
  const history = await store.history('canvas', entry.sessionId);
  assert.equal(history.active, null); assert.deepEqual(history.turns[0].proposals, record.proposals);
});

test('writes and plan_update before proposing persist without a post-proposal model request', { timeout: 30000 }, async t => {
  const plan = { goal: 'Create the next shot', items: [{ id: 'shot', title: 'Generate the first frame', status: 'needs_user' }] };
  const f = await fixture(t, { onRequest: async (_, count) => count === 1
    ? { toolCalls: [configure, { id: 'plan', name: 'plan_update', args: plan }] }
    : count === 2 ? { toolCalls: [propose] } : { reply: 'Unexpected post-proposal summary.' } });
  const { store } = f.current, entry = await store.createSession('canvas');
  const record = await store.wait(entry, await store.submit(entry, input));
  assert.equal(f.state.models.length, 2); assert.equal(record.reply, ''); assert.equal(record.error, null);
  assert.equal(record.proposals.length, 1); assert.deepEqual(record.plan.items, plan.items);
  assert.equal(record.proposals[0].source.canvasRevision, 2);
  assert.equal(record.change.revisionAfter, 2); assert.deepEqual(record.change.updatedNodeIds, ['shot']);
  assert.deepEqual(f.state.completions[0].record.change, record.change);
  const history = await store.history('canvas', entry.sessionId);
  assert.deepEqual(history.plan.items, plan.items); assert.deepEqual(history.turns[0].plan.items, plan.items);
  assert.match(f.state.models[1].tools.find(tool => tool.function.name === 'canvas_generation_propose').function.description, /先完成本阶段的计划更新/);
});

for (const failure of ['rejected', 'error-result']) {
  test(`a ${failure} proposal still returns to the model`, { timeout: 30000 }, async t => {
    const f = await fixture(t, { reject: failure === 'rejected', isError: failure === 'error-result' });
    const { store } = f.current, entry = await store.createSession('canvas');
    const record = await store.wait(entry, await store.submit(entry, input));
    assert.equal(f.state.models.length, 2); assert.equal(record.reply, 'Processed every result.');
    if (failure === 'rejected') { assert.equal(record.proposals.length, 0); assert.equal(record.toolCalls[0].isError, true); }
    assert.equal(f.state.completions.length, 1);
  });
}

test('a mixed proposal and write round executes the remaining tool and keeps the next model request', { timeout: 30000 }, async t => {
  const f = await fixture(t, { calls: [propose, configure] });
  const { store } = f.current, entry = await store.createSession('canvas');
  const record = await store.wait(entry, await store.submit(entry, input));
  assert.equal(f.state.models.length, 2); assert.equal(f.state.posts.length, 2);
  assert.equal(record.proposals.length, 1); assert.equal(record.change.revisionAfter, 2);
  assert.deepEqual(record.change.updatedNodeIds, ['shot']); assert.equal(record.error, null);
});

test('an accepted supplement at the proposal boundary completes before the host settles', { timeout: 30000 }, async t => {
  const proposing = deferred(), release = deferred(), supplementRequested = deferred(), supplementReply = deferred();
  t.after(() => { release.resolve(); supplementReply.resolve(); });
  const f = await fixture(t, { beforeProposal: async () => { proposing.resolve(); await release.promise; },
    onRequest: async (body, count) => { if (count === 2) { supplementRequested.resolve(); await supplementReply.promise; return { reply: 'Applied the new requirement.' }; } } });
  const { store } = f.current, entry = await store.createSession('canvas');
  const submission = await store.submit(entry, input);
  const waiting = store.wait(entry, submission);
  waiting.catch(() => {});
  await proposing.promise;
  await store.supplement(entry, { requestId: 'new-requirement', content: 'Use a landscape frame.', input: { message: 'Use a landscape frame.' } });
  release.resolve(); await supplementRequested.promise;
  assert.equal(f.state.completions.length, 0, 'original done is not enough while accepted input is running');
  assert.equal((await submission.status(CTX)).status, 'done', 'the official final boundary splits the accepted input into its next run');
  assert.match(JSON.stringify(f.state.models[1].messages), /Use a landscape frame/);
  supplementReply.resolve();
  const record = await waiting;
  assert.equal(record.reply, 'Applied the new requirement.'); assert.deepEqual(record.supplements, ['Use a landscape frame.']);
  assert.equal(record.proposals.length, 1); assert.equal(record.error, null); assert.equal(f.state.completions.length, 1);
});

test('Stop during a proposal remains cancelled and cannot become a successful terminal proposal', { timeout: 30000 }, async t => {
  const proposing = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, { beforeProposal: async () => { proposing.resolve(); await release.promise; } });
  const { store } = f.current, entry = await store.createSession('canvas');
  const submission = await store.submit(entry, input);
  const waiting = store.wait(entry, submission);
  await proposing.promise;
  await store.fenceStop(entry, input.requestId);
  const stopped = store.stop(entry, input.requestId);
  release.resolve(); await stopped;
  const record = await waiting;
  assert.equal(record.cancelled, true); assert.equal(record.status, 'unanswered');
  assert.equal(f.state.models.length, 1); assert.equal(record.error, null);
});

test('reopen after a failed Go completion only acknowledges the durable result and preserves the proposal', { timeout: 30000 }, async t => {
  const f = await fixture(t, { completeTurn: async (_, recovering) => { if (!recovering) throw new Error('Go acknowledgement unavailable'); } });
  let { store } = f.current;
  let entry = await store.createSession('canvas');
  const sessionId = entry.sessionId;
  const submission = await store.submit(entry, input);
  await assert.rejects(store.wait(entry, submission), /Go acknowledgement unavailable/);
  assert.equal((await submission.status(CTX)).status, 'done'); assert.equal(f.state.models.length, 1);
  const expected = structuredClone(entry.turn.proposals);
  ({ store } = await f.reopen());
  entry = await store.ensureSession('canvas', sessionId);
  const recovered = await store.recover(entry);
  const record = await store.wait(entry, recovered);
  assert.equal(f.state.models.length, 1); assert.equal(f.state.issued, 1);
  assert.deepEqual(record.proposals, expected); assert.equal(record.error, null); assert.equal(record.cancelled, false);
  assert.equal(f.state.completions.length, 1); assert.deepEqual(f.state.completions[0].record.proposals, expected);
  const replay = await store.submit(entry, input);
  assert.equal(replay.id, recovered.id); assert.deepEqual((await store.wait(entry, replay)).proposals, expected);
});
