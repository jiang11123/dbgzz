import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore } from './durable-session-owner.mjs';

// A synthetic model whose first answer waits for the test, so a turn stays live.
async function gatedFixture(t, { completeTurn, beforeReply = async () => {}, isTurnOpen = () => true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-recovery-'));
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let requested; const started = new Promise((resolve) => { requested = resolve; });
  let modelCalls = 0;
  const authorizations = [];
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    modelCalls += 1; requested(); await gate; await beforeReply(modelCalls);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    frame({ role: 'assistant', content: 'Live reply' }); frame({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('beeftv', { api: 'openai-completions', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const models = createModels(); models.setProvider(runtime.getProvider('beeftv'));
  const completions = [];
  const open = () => createDurableSessionStore({ sessionRoot: path.join(directory, 'sessions'), workspaceRoot: path.join(directory, 'workspace'),
    getModels: () => models, getModelRef: () => ({ provider: 'beeftv', modelId: 'fixture' }), buildTools: () => [],
    authorizeTurn: async ({ turnId }) => { authorizations.push(turnId); return { open: isTurnOpen(turnId), canvasId: 'canvas', turnId, permissionMode: 'canvas' }; },
    completeTurn: async (input) => { if (completeTurn) await completeTurn(input); completions.push(input.turnId); },
    settings: { retry: { maxRetries: 0 } } });
  const fixture = { store: open(), started, release, authorizations, completions, modelCalls: () => modelCalls,
    // A host restart: the old owner is gone and only committed state remains.
    async reopen() { await fixture.store.disposeAll(); fixture.store = open(); return fixture.store; } };
  t.after(async () => {
    release();
    await fixture.store.disposeAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return fixture;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const crash = () => Object.assign(new Error('crash'), { reason: 'crash' });
async function stoppedHistory(store, entry) {
  const history = await store.history('canvas', entry.sessionId);
  return { active: history.active, turns: history.turns.map((turn) => [turn.requestId, turn.cancelled, turn.status]),
    submissions: (await store.status(entry)).inspection.submissions.length };
}

// Count the writes and official admissions a recovery attempt makes on this entry.
function countWrites(entry) {
  const counts = { commits: 0, submits: 0 };
  const commit = entry.harness.commit.bind(entry.harness);
  entry.harness.commit = (...args) => { counts.commits += 1; return commit(...args); };
  const submit = entry.root.submit.bind(entry.root);
  entry.root.submit = (...args) => { counts.submits += 1; return submit(...args); };
  return counts;
}

test('a delayed stop for the completed request never aborts the next request', { timeout: 30000 }, async (t) => {
  const completing = deferred(), acknowledge = deferred(), nextStarted = deferred(), nextReply = deferred();
  const fixture = await gatedFixture(t, {
    completeTurn: async ({ turnId }) => { if (turnId === 'old-turn') { completing.resolve(); await acknowledge.promise; } },
    beforeReply: async (call) => { if (call === 2) { nextStarted.resolve(); await nextReply.promise; } },
  });
  t.after(() => { acknowledge.resolve(); nextReply.resolve(); });
  const entry = await fixture.store.createSession('canvas');
  const first = await fixture.store.submit(entry, { turnId: 'old-turn', requestId: 'old-request', content: 'First', revisionBefore: 1 });
  const firstWait = fixture.store.wait(entry, first);
  fixture.release();
  await completing.promise;
  const cancel = await fixture.store.cancelRequest('canvas', entry.sessionId, 'old-request');
  assert.equal(cancel.state, 'running');
  await fixture.store.fenceStop(entry, 'old-request');
  // Go acknowledgement can outlive A: another observer clears it and B is admitted.
  acknowledge.resolve();
  await firstWait;
  const second = await fixture.store.submit(entry, { turnId: 'new-turn', requestId: 'new-request', content: 'Second', revisionBefore: 1 });
  await nextStarted.promise;
  let aborts = 0;
  const abort = entry.root.abort.bind(entry.root);
  entry.root.abort = (...args) => { aborts += 1; return abort(...args); };
  await fixture.store.stop(entry, 'old-request');
  assert.equal(aborts, 0, 'the old cancel must not abort the new official generation');
  assert.equal((await fixture.store.history('canvas', entry.sessionId)).active.requestId, 'new-request');
  assert.equal(entry.generation.aborted, false);
  nextReply.resolve();
  const record = await fixture.store.wait(entry, second);
  assert.equal(record.cancelled, false);
  assert.equal(record.reply, 'Live reply');
});

test('an observer reattaching to an old submission cannot settle a newer active request', { timeout: 30000 }, async (t) => {
  const nextStarted = deferred(), nextReply = deferred();
  const fixture = await gatedFixture(t, { beforeReply: async (call) => { if (call === 2) { nextStarted.resolve(); await nextReply.promise; } } });
  t.after(() => nextReply.resolve());
  const entry = await fixture.store.createSession('canvas');
  const first = await fixture.store.submit(entry, { turnId: 'old-turn', requestId: 'old-request', content: 'First', revisionBefore: 1 });
  fixture.release();
  await fixture.store.wait(entry, first);
  const second = await fixture.store.submit(entry, { turnId: 'new-turn', requestId: 'new-request', content: 'Second', revisionBefore: 1 });
  await nextStarted.promise;
  assert.equal((await fixture.store.wait(entry, first)).requestId, 'old-request');
  assert.deepEqual(fixture.completions, ['old-turn']);
  assert.equal((await fixture.store.history('canvas', entry.sessionId)).active.requestId, 'new-request');
  nextReply.resolve();
  assert.equal((await fixture.store.wait(entry, second)).requestId, 'new-request');
});

test('a pending stop in one conversation does not cancel the same request ID in another', { timeout: 30000 }, async (t) => {
  const fixture = await gatedFixture(t);
  const first = await fixture.store.createSession('canvas');
  await fixture.store.cancelRequest('canvas', first.sessionId, 'shared-request');
  const second = await fixture.store.createSession('canvas');
  const submission = await fixture.store.submit(second, { turnId: 'second-turn', requestId: 'shared-request', content: 'Run in this conversation', revisionBefore: 1 });
  assert.ok(submission, 'request identity is scoped to its conversation');
  fixture.release();
  assert.equal((await fixture.store.wait(second, submission)).cancelled, false);
  assert.equal(fixture.modelCalls(), 1);
  const original = await fixture.store.activateSession('canvas', first.sessionId);
  assert.equal(await fixture.store.submit(original, { turnId: 'first-turn', requestId: 'shared-request', content: 'Keep stopped', revisionBefore: 1 }), null);
  assert.equal(fixture.modelCalls(), 1);
});

for (const closedAfterFailure of [false, true]) {
  test(`a pre-submit stop retains completion until acknowledged across restart (backend closed=${closedAfterFailure})`, { timeout: 30000 }, async (t) => {
    let attempts = 0;
    const fixture = await gatedFixture(t, {
      completeTurn: async () => { if (++attempts === 1) throw new Error('completion unavailable'); },
      isTurnOpen: () => !closedAfterFailure || attempts === 0,
    });
    const entry = await fixture.store.createSession('canvas');
    await fixture.store.cancelRequest('canvas', entry.sessionId, 'early-request');
    const input = { turnId: 'early-turn', requestId: 'early-request', content: 'Do not run', revisionBefore: 1 };
    await assert.rejects(fixture.store.submit(entry, input), /completion unavailable/);
    const pending = await fixture.store.history('canvas', entry.sessionId);
    assert.equal(pending.active?.requestId, 'early-request');
    assert.equal(pending.turns.length, 0, 'history must not claim final settlement before acknowledgement');
    const store = await fixture.reopen();
    const reopened = await store.ensureSession('canvas');
    assert.equal(await store.recover(reopened), null);
    assert.deepEqual(await stoppedHistory(store, reopened), { active: null, turns: [['early-request', true, 'unanswered']], submissions: 0 });
    assert.deepEqual(fixture.completions, closedAfterFailure ? [] : ['early-turn']);
    assert.equal(await store.submit(reopened, input), null);
    assert.equal(fixture.modelCalls(), 0);
  });
}

test('recover while the official wait is live keeps in-memory turn state and writes nothing', { timeout: 30000 }, async (t) => {
  const fixture = await gatedFixture(t);
  const entry = await fixture.store.createSession('canvas');
  const submission = await fixture.store.submit(entry, { turnId: 'live-turn', content: 'Keep running', revisionBefore: 1 });
  const waiting = fixture.store.wait(entry, submission);
  waiting.catch(() => {});
  await fixture.started;
  // A live tool may have changed the canvas after the last persisted effects.
  entry.turn.createdNodeIds.push('live-node');
  entry.turn.revisionAfter = 2;
  const authorized = fixture.authorizations.length;
  const counts = countWrites(entry);
  for (let read = 0; read < 3; read += 1) assert.equal(await fixture.store.recover(entry), null);
  assert.deepEqual(counts, { commits: 0, submits: 0 });
  assert.equal(fixture.authorizations.length, authorized);
  assert.deepEqual(entry.turn.createdNodeIds, ['live-node']);
  fixture.release();
  const record = await waiting;
  assert.equal(record.reply, 'Live reply');
  assert.deepEqual(record.change?.createdNodeIds, ['live-node']);
  assert.equal(fixture.modelCalls(), 1);
});

test('concurrent recovery reads share one validated admission', { timeout: 30000 }, async (t) => {
  const fixture = await gatedFixture(t);
  const entry = await fixture.store.createSession('canvas');
  const submission = await fixture.store.submit(entry, { turnId: 'pending-turn', content: 'Resume once', revisionBefore: 1 });
  await fixture.started;
  const authorized = fixture.authorizations.length;
  const counts = countWrites(entry);
  // Nothing observes the turn yet (as after a host restart), so recovery may schedule it once.
  const recovered = await Promise.all([fixture.store.recover(entry), fixture.store.recover(entry), fixture.store.recover(entry)]);
  assert.equal(counts.submits, 1);
  assert.equal(fixture.authorizations.length - authorized, 2);
  for (const value of recovered) assert.equal(value?.id, submission.id);
  fixture.release();
  const record = await fixture.store.wait(entry, recovered[0]);
  assert.equal(record.reply, 'Live reply');
  assert.equal(fixture.modelCalls(), 1);
});

test('a stop committed after admission but before the official submit survives a crash: recovery records it stopped and never submits', { timeout: 30000 }, async (t) => {
  const fixture = await gatedFixture(t);
  const entry = await fixture.store.createSession('canvas');
  // The process dies right after the stop is committed, before the official submit.
  entry.root.submit = async () => { await fixture.store.fenceStop(entry); throw crash(); };
  const input = { turnId: 'crash-turn', requestId: 'crash-req', content: 'Never run', revisionBefore: 1 };
  await assert.rejects(fixture.store.submit(entry, input), /crash/);
  const store = await fixture.reopen();
  const reopened = await store.ensureSession('canvas');
  const counts = countWrites(reopened);
  assert.equal(await store.recover(reopened), null);
  assert.deepEqual(await stoppedHistory(store, reopened), { active: null, turns: [['crash-req', true, 'unanswered']], submissions: 0 });
  assert.deepEqual(fixture.completions, ['crash-turn']);
  // The same request sent again after the restart does not run either.
  assert.equal(await store.submit(reopened, input), null);
  assert.equal(counts.submits, 0);
  assert.equal(fixture.modelCalls(), 0);
});

test('a stop named by request ID after a restart is honored by recovery instead of resubmitting; the next request runs', { timeout: 30000 }, async (t) => {
  const fixture = await gatedFixture(t);
  const entry = await fixture.store.createSession('canvas');
  // Admitted, then the process dies before the official submit; no stop yet.
  entry.root.submit = async () => { throw crash(); };
  await assert.rejects(fixture.store.submit(entry, { turnId: 'restart-turn', requestId: 'restart-req', content: 'Never run', revisionBefore: 1 }), /crash/);
  const store = await fixture.reopen();
  const reopened = await store.ensureSession('canvas');
  const counts = countWrites(reopened);
  assert.deepEqual(await store.cancelRequest('canvas', reopened.sessionId, 'restart-req'), { state: 'pending' });
  assert.equal(await store.recover(reopened), null);
  assert.equal(counts.submits, 0);
  assert.deepEqual(await stoppedHistory(store, reopened), { active: null, turns: [['restart-req', true, 'unanswered']], submissions: 0 });
  assert.deepEqual(fixture.completions, ['restart-turn']);
  const next = await store.submit(reopened, { turnId: 'next-turn', requestId: 'next-req', content: 'Run', revisionBefore: 1 });
  fixture.release();
  assert.equal((await store.wait(reopened, next)).reply, 'Live reply');
  assert.equal(fixture.modelCalls(), 1);
});

test('a stopped request officially admitted just before a crash is aborted by recovery, not run', { timeout: 30000 }, async (t) => {
  const fixture = await gatedFixture(t);
  const entry = await fixture.store.createSession('canvas');
  // Fenced and officially admitted, then the process dies before the submission ID is recorded.
  const submit = entry.root.submit.bind(entry.root);
  entry.root.submit = async (...args) => {
    entry.generation.aborted = true;
    await submit(...args);
    await fixture.store.fenceStop(entry);
    throw crash();
  };
  await assert.rejects(fixture.store.submit(entry, { turnId: 'admitted-turn', requestId: 'admitted-req', content: 'Never run', revisionBefore: 1 }), /crash/);
  const store = await fixture.reopen();
  const reopened = await store.ensureSession('canvas');
  const counts = countWrites(reopened);
  assert.equal(await store.recover(reopened), null);
  assert.equal(counts.submits, 0);
  const history = await stoppedHistory(store, reopened);
  assert.equal(history.active, null);
  assert.deepEqual(history.turns.map(([requestId, cancelled]) => [requestId, cancelled]), [['admitted-req', true]]);
  assert.deepEqual(fixture.completions, ['admitted-turn']);
  assert.equal(fixture.modelCalls(), 0);
});
