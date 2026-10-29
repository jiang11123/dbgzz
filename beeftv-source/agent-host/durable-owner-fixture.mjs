// Subprocess fixture for hard-kill recovery tests. No paid provider or real data.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createOperationBridge } from './operation-bridge.mjs';
import { createDurableSessionStore } from './durable-session-owner.mjs';

const [directory, phase] = process.argv.slice(2);
const selectedSkillPin = { skillId: 'selected', versionId: 'v1', contentHash: createHash('sha256').update('selected-fixture-skill-v1').digest('hex') };
fs.mkdirSync(directory, { recursive: true });
const businessPath = path.join(directory, 'business.json');
const read = () => fs.existsSync(businessPath) ? JSON.parse(fs.readFileSync(businessPath, 'utf8')) : { nodes: 0, edges: 0, executions: 0, receipts: {}, completed: 0 };
const save = (state) => { const fd = fs.openSync(businessPath, 'w'); fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); fs.closeSync(fd); };
const crashAtCheckpoint = () => {
  const fd = fs.openSync(path.join(directory, 'crash-checkpoint.json'), 'w');
  fs.writeFileSync(fd, JSON.stringify({ phase, state: read() }));
  fs.fsyncSync(fd); fs.closeSync(fd);
  process.kill(process.pid, 'SIGKILL');
};
let modelRequests = 0;
let release;
const gate = new Promise((resolve) => { release = resolve; });
let arrived;
const requestArrived = new Promise((resolve) => { arrived = resolve; });
let releaseSecond, secondArrived;
const secondRequest = new Promise(resolve => { secondArrived = resolve; });
const send = (res, tool, text = 'fixture complete') => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  frame(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${tool}`, type: 'function', function: { name: tool, arguments: phase==='permission-full' ? '{"canvasId":"other"}' : '{}' } }] } : { role: 'assistant', content: text });
  frame({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
};
const unsafe = phase.startsWith('unsafe');
const policies = JSON.parse(fs.readFileSync(new URL('./operation-descriptors.fixture.json', import.meta.url), 'utf8'));
const descriptors = [unsafe ? 'future.paid.submit' : 'canvas.nodes.create', 'canvas.edge.create'].map((id) => ({
  ...policies.find(descriptor => descriptor.id === id),
  ...(id === 'future.paid.submit' ? { assistantModes: ['full-access'], replay: 'unsafe' } : {}),
  id, summary: id, params: { type: 'object', properties: { canvasId: { type: 'string' } } }, readOnly: false,
}));
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/ops') { res.end(JSON.stringify({ code: 0, data: { ops: descriptors } })); return; }
  if (req.url.startsWith('/ops/')) {
    const request = JSON.parse(raw), state = read();
    assert.equal(req.headers['x-beeftv-agent-turn'], 'fixture-turn');
    assert.equal(request.params.canvasId, phase==='permission-full'?'other':'canvas');
    state.executions++;
    const replayed = Boolean(state.receipts[request.opId]);
    let result = state.receipts[request.opId];
    if (!result) {
      if (req.url.endsWith('canvas.nodes.create') || req.url.endsWith('future.paid.submit')) {
        state.nodes += 2; result = { revision: 2, created: [{ id: 'one' }, { id: 'two' }] };
      } else { state.edges += 2; result = { revision: 3, edgeId: 'edge', created: true }; }
      state.receipts[request.opId] = result;
    }
    save(state);
    if ((phase === 'crash' && req.url.endsWith('canvas.nodes.create')) || (phase === 'unsafe-crash' && req.url.endsWith('future.paid.submit'))) crashAtCheckpoint();
    res.end(JSON.stringify({ code: 0, data: { result, replayed } })); return;
  }
  const request = JSON.parse(raw); modelRequests++;
  if(phase.startsWith('permission-')) {
    if(phase==='permission-crash') crashAtCheckpoint();
    const create=request.tools?.find(t=>t.function?.name==='canvas_nodes_create');
    if(phase==='permission-read-only') {assert(!create,'readonly provider saw a write tool');send(res);}
    else if(phase==='permission-canvas') {assert(create);assert(!create.function.parameters.properties.canvasId,'canvas schema exposed arbitrary target');send(res);}
    else if(phase==='permission-full') {assert(create?.function.parameters.properties.canvasId,'full schema hid cross-canvas target');send(res,modelRequests===1?'canvas_nodes_create':null);}
    else throw new Error('recovery dispatched after mode upgrade');
    return;
  }
  if (phase === 'multi-steer') {
    if (modelRequests === 1) { arrived(); await gate; send(res, null, 'original answer'); }
    else if (modelRequests === 2) { secondArrived(); await new Promise(resolve => { releaseSecond = resolve; }); send(res, null, 'first supplemental answer'); }
    else { assert(JSON.stringify(request.messages).includes('Use quiet audio')); send(res, null, 'latest supplemental reply'); }
    return;
  }
  if (phase.startsWith('pending-')) {
    if (modelRequests === 1) { arrived(); await gate; send(res, 'canvas_nodes_create'); }
    else { assert(JSON.stringify(request.messages).includes('image_url')); assert(JSON.stringify(request.messages).includes('BEEFTV_INPUT:picture')); send(res); }
    return;
  }
  if (['partial-stop', 'persisted-supplement-stop', 'persisted-supplement-stop-crash', 'prep-error-partial'].includes(phase)) {
    if (phase === 'partial-stop' && modelRequests === 1) { send(res); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'partial', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'current partial answer' }, finish_reason: null }] }) + '\n\n');
    arrived(); return;
  }
  if (phase === 'wait' || phase === 'stop' || phase === 'pending-stop' || phase === 'supplement-crash' || phase === 'fence-crash') { arrived(); await gate; send(res); return; }
  if (phase === 'supplement-resume') { assert(JSON.stringify(request.messages).includes('Use landscape')); send(res); return; }
  const results = request.messages.filter((message) => message.role === 'tool');
  if (JSON.stringify(results).toLowerCase().includes('interrupt')) send(res);
  else send(res, !results.length ? unsafe ? 'future_paid_submit' : 'canvas_nodes_create' : !results.some((message) => message.tool_call_id === 'call-canvas_edge_create') ? 'canvas_edge_create' : null);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
runtime.registerProvider('fixture', { api: 'openai-completions', apiKey: 'fixture-only', baseUrl: `${baseUrl}/v1`, models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text', 'image'], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
const models = createModels(); models.setProvider(runtime.getProvider('fixture'));
const bridge = createOperationBridge({ opsUrl: baseUrl, hostToken: 'fixture', turnBudgetContext: new AsyncLocalStorage() });
await bridge.loadDescriptors();
const store = createDurableSessionStore({ sessionRoot: path.join(directory, 'sessions'), workspaceRoot: path.join(directory, 'workspace'),
  getModels: () => models, getModelRef: () => ({ provider: 'fixture', modelId: 'fixture' }), buildTools: bridge.buildTools,
  authorizeTurn: async () => {
    if (phase === 'denied') throw Object.assign(new Error('turn_closed'), { reason: 'turn_closed' });
    return { turnId: 'fixture-turn', canvasId: 'canvas', permissionMode:unsafe || phase==='permission-full' || phase==='permission-upgrade'?'full-access':phase==='permission-read-only' || phase==='permission-crash'?'read-only':'canvas', open: !['closed-resume', 'fence-resume', 'persisted-supplement-stop-resume'].includes(phase) };
  },
  completeTurn: async () => {
    const state = read(); if (!['fence-resume', 'persisted-supplement-stop-resume'].includes(phase)) state.completed++; save(state);
    if (phase === 'complete-crash') crashAtCheckpoint();
  }, settings: { retry: { maxRetries: 0 } },
});
try {
  const entry = await store.ensureSession('canvas');
  if (phase === 'persisted-supplement-stop-resume') {
    await store.recover(entry);
    const history = await store.history('canvas', entry.sessionId);
    assert.equal(modelRequests, 0); assert.equal(read().executions, 0); assert.equal(history.active, null); assert.equal(history.turns.length, 1); assert.equal(history.turns[0].cancelled, true); assert.equal(history.turns[0].reply, 'current partial answer');
    const missing = await entry.harness.commit(tx => tx.submissionByRequest(entry.root.id, 'supplement:racy'), { abortSignal: new AbortController().signal }); assert.equal(missing, undefined);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ history, state: read(), modelRequests }));
  } else if (['persisted-supplement-stop', 'persisted-supplement-stop-crash', 'prep-error-partial'].includes(phase)) {
    const submission = await store.submit(entry, { turnId: 'fixture-turn', content: 'current request', revisionBefore: 1 });
    await requestArrived;
    let partial;
    const seen = new Promise(resolve => { partial = resolve; });
    const waiting = store.wait(entry, submission, { onEvent: event => { if (JSON.stringify(event).includes('current partial answer')) partial(); } });
    await seen;
    if (phase === 'prep-error-partial') {
      const pending = store.beginPendingInput(entry);
      pending.reject(Object.assign(new Error('image preparation failed'), { reason: 'fixture_media_preparation_failed' }));
      const record = await waiting;
      assert.equal(record.reply, 'current partial answer'); assert.equal(record.errorReason, 'fixture_media_preparation_failed'); assert.equal(record.cancelled, false);
      fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ record, state: read(), modelRequests }));
    } else {
      let releaseSnapshot, snapshotArrived, paused = false;
      const pausedSnapshot = new Promise(resolve => { snapshotArrived = resolve; });
      const originalSnapshot = entry.harness.snapshot.bind(entry.harness);
      entry.harness.snapshot = async (...args) => {
        const value = await originalSnapshot(...args);
        if (!paused && value.active?.supplementIds?.includes('racy')) {
          paused = true; snapshotArrived(); await new Promise(resolve => { releaseSnapshot = resolve; });
        }
        return value;
      };
      const supplemental = store.supplement(entry, { requestId: 'racy', content: 'prepared but not submitted' }).then(value => ({ value }), error => ({ error }));
      await pausedSnapshot;
      const admitted = await entry.harness.commit(tx => tx.submissionByRequest(entry.root.id, 'supplement:racy'), { abortSignal: new AbortController().signal });
      assert.equal(admitted, undefined, 'fault point must precede official input admission');
      if (phase === 'persisted-supplement-stop-crash') {
        await store.fenceStop(entry);
        const state = read(); state.completed = 1; state.unadmitted = true; save(state);
        crashAtCheckpoint();
      }
      const stopping = store.stop(entry);
      // Stop itself may settle while the supplement still owns the lock; free
      // only after the stop fence was persisted, preserving the exact gap.
      await new Promise(resolve => setTimeout(resolve, 50)); releaseSnapshot();
      const rejected = await supplemental; assert(rejected.error); assert.equal(rejected.error.reason, 'session_not_running');
      const record = await stopping; await waiting;
      assert.equal(record.cancelled, true); assert.equal(record.reply, 'current partial answer'); assert.equal(record.error, null);
      const history = await store.history('canvas', entry.sessionId); assert.equal(history.active, null); assert.equal(history.turns.length, 1); assert.equal(history.turns[0].reply, 'current partial answer');
      assert.equal(read().completed, 1); assert.equal(modelRequests, 1); assert.equal(read().executions, 0);
      fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ record, history, state: read(), modelRequests }));
    }
  } else if (phase === 'pending-stop') {
    const submission = await store.submit(entry, { turnId: 'fixture-turn', content: 'original request', revisionBefore: 1 });
    await requestArrived;
    const pending = store.beginPendingInput(entry);
    const started = Date.now();
    const stopped = store.stop(entry);
    let timeout;
    const record = await Promise.race([stopped, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('stop waited for unfinished media preparation')), 1200); })]).finally(() => clearTimeout(timeout));
    assert.equal(record.cancelled, true); assert.equal(record.error, null); assert(Date.now() - started < 1200);
    pending.resolve(); pending.reject(new Error('late media failure'));
    await assert.rejects(store.supplement(entry, { requestId: 'late-image', content: 'late reference' }), /session_not_running/);
    const history = await store.history('canvas', entry.sessionId);
    assert.equal(history.active, null); assert.equal(history.turns.length, 1); assert.equal(history.turns[0].cancelled, true); assert.equal(history.turns[0].error, null); assert.deepEqual(history.turns[0].supplements, []);
    assert.equal(read().executions, 0); assert.equal(modelRequests, 1);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ record, history, state: read(), modelRequests }));
  } else if (phase === 'fence-resume') {
    await store.recover(entry);
    const history = await store.history('canvas', entry.sessionId);
    assert.equal(modelRequests, 0); assert.equal(read().executions, 0); assert.equal(history.active, null); assert.equal(history.turns.length, 1); assert.equal(history.turns[0].cancelled, true);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ history, state: read(), modelRequests }));
  } else if (phase === 'multi-steer') {
    const submission = await store.submit(entry, { turnId: 'fixture-turn', content: 'original request', revisionBefore: 1 });
    await requestArrived;
    await store.supplement(entry, { requestId: 'wide', content: 'Use landscape' });
    let completed = false;
    const waiting = store.wait(entry, submission).then(record => { completed = true; return record; });
    release(); await secondRequest;
    assert.equal(completed, false); assert.equal(read().completed, 0);
    await store.supplement(entry, { requestId: 'quiet', content: 'Use quiet audio' });
    releaseSecond(); const record = await waiting;
    assert.equal(record.reply, 'latest supplemental reply'); assert.deepEqual(record.supplements, ['Use landscape', 'Use quiet audio']); assert.equal(read().completed, 1);
    const history = await store.history('canvas', entry.sessionId); assert.equal(history.turns.length, 1); assert.equal(history.active, null);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ record, history, state: read(), modelRequests }));
  } else if (phase.startsWith('pending-')) {
    const submission = await store.submit(entry, { turnId: 'fixture-turn', content: 'original instruction', userText: 'original instruction', revisionBefore: 1 });
    await requestArrived;
    const pending = store.beginPendingInput(entry);
    assert.equal(entry.generation.modelEpoch, -1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(read().executions, 0, 'old model wrote while preparing latest input');
    assert.equal(modelRequests, 1, 'new model dispatched while latest input was not prepared');
    if (phase === 'pending-failure') pending.reject(Object.assign(new Error('image preparation failed'), { reason: 'fixture_media_preparation_failed' }));
    else {
      await store.supplement(entry, { requestId: 'picture', content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=' }], input: { message: '', attachments: [{ nodeId: 'reference', resourceId: 'owned-reference' }], skills: [] } });
      pending.resolve();
    }
    const record = await store.wait(entry, submission);
    if (phase === 'pending-failure') { assert.equal(record.errorReason, 'fixture_media_preparation_failed'); assert.equal(record.cancelled, false); }
    else { assert.equal(record.reply, 'fixture complete'); assert.deepEqual(record.supplements, ['']); assert.equal(record.supplementInputs[0].message, ''); assert.equal(record.supplementInputs[0].attachments.length, 1); }
    assert.equal(read().executions, 0);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ record, state: read(), modelRequests }));
  } else if (phase === 'partial-stop') {
    const previous = await store.submit(entry, { turnId: 'fixture-prior', content: 'prior turn', revisionBefore: 1 });
    assert.equal((await store.wait(entry, previous)).reply, 'fixture complete');
    const submission = await store.submit(entry, { turnId: 'fixture-turn', content: 'current turn', userText: 'current turn', revisionBefore: 1 });
    await requestArrived;
    let partial;
    const seenPartial = new Promise((resolve) => { partial = resolve; });
    const waiting = store.wait(entry, submission, { onEvent: (event) => { if (JSON.stringify(event).includes('current partial answer')) partial(); } });
    await seenPartial;
    const stopped = await store.stop(entry); const record = await waiting;
    assert.equal(stopped.reply, 'current partial answer'); assert.equal(record.reply, 'current partial answer'); assert.equal(record.cancelled, true);
    const history = await store.history('canvas', entry.sessionId);
    assert.equal(history.turns.length, 2); assert.equal(history.turns[1].reply, 'current partial answer'); assert.equal(history.turns[0].reply, 'fixture complete');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ record, history, state: read(), modelRequests }));
  } else if(phase==='permission-upgrade') {
    await assert.rejects(store.recover(entry),/permission_mode_frozen/);
    assert.equal(modelRequests,0);assert.equal(read().executions,0);
  } else if (phase === 'denied') {
    await assert.rejects(store.recover(entry), /turn_closed/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(modelRequests, 0); assert.equal(read().executions, 1);
    fs.writeFileSync(path.join(directory, 'denied.json'), JSON.stringify({ modelRequests, state: read() }));
  } else {
    const input = { turnId: 'fixture-turn', permissionMode:'full-access', content: 'Create two nodes and connect references', userText: 'Create two nodes and connect references', revisionBefore: 1,
      skills: [selectedSkillPin] };
    const submission = ['resume', 'closed-resume', 'unsafe-resume', 'supplement-resume'].includes(phase) ? await store.recover(entry) : await store.submit(entry, input);
    const originalPath = path.join(directory, 'submission-id');
    if (fs.existsSync(originalPath)) assert.equal(String(submission.id), fs.readFileSync(originalPath, 'utf8'));
    else fs.writeFileSync(originalPath, String(submission.id));
    if (phase === 'fence-crash') {
      await requestArrived;
      await store.fenceStop(entry);
      const state = read(); state.completed = 1; save(state);
      crashAtCheckpoint();
    } else if (phase === 'supplement-crash') {
      await requestArrived;
      await store.supplement(entry, { requestId: 'wide', content: 'Use landscape', input: { message: 'Use landscape', attachments: [], skills: [] } });
      crashAtCheckpoint();
    } else if (phase === 'stop') {
      await requestArrived;
      const record = await store.stop(entry);
      assert(record.cancelled);
      assert.equal(read().nodes, 0);
      release();
      fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ record, state: read(), modelRequests }));
    } else {
    if (phase === 'wait') {
      await requestArrived;
      const abort = new AbortController();
      const waiting = store.wait(entry, submission, { signal: abort.signal });
      abort.abort(); await assert.rejects(waiting);
      assert((await store.status(entry)).active);
      await store.supplement(entry, { requestId: 'wide', content: 'Use landscape' });
      await assert.rejects(store.submit(entry, { ...input, content: 'different' }), /submission_request_conflict/);
      release();
    }
    const record = await store.wait(entry, submission);
    assert.equal(record.reply, 'fixture complete');
    assert.deepEqual(record.skills, [selectedSkillPin]);
    if (phase === 'resume') { assert.equal(read().nodes, 2); assert.equal(read().edges, 2); assert.equal(read().executions, 3); }
    if (phase === 'unsafe-resume') { assert.equal(read().nodes, 2); assert.equal(read().edges, 0); assert.equal(read().executions, 1); }
    if (phase === 'closed-resume') { assert.equal(modelRequests, 0); assert.equal(read().completed, 1); }
    const history = await store.history('canvas', entry.sessionId);
    assert.equal(history.turns.length, 1); assert.equal(history.active, null);
    const replay = await store.submit(entry, input); assert.equal(String(replay.id), String(submission.id));
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ record, state: read(), modelRequests }));
    }
  }
} finally { await store.disposeAll(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
