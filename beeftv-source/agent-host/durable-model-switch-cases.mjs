import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { modelFixture } from './test-support/durable-model-switch-probe.mjs';

test('official persisted idle sessions follow trusted new model; history retained; client ref ignored', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-model-switch-'));
  let fixture;
  try {
    fixture = await modelFixture(directory, 'astra', ['astra']);
    const entry = await fixture.store.createSession('canvas');
    const sessionId = entry.sessionId;
    const first = await fixture.store.submit(entry, { turnId: 'first', content: 'First request' });
    assert.equal((await fixture.store.wait(entry, first)).reply, 'Actual astra reply');
    await fixture.close();
    fixture = await modelFixture(directory, 'gemini', ['gemini']);
    const restored = await fixture.store.ensureSession('canvas', sessionId);
    const second = await fixture.store.submit(restored, { turnId: 'second', content: 'Next request', modelRef: { provider: 'foreign', modelId: 'injected' } });
    assert.equal((await fixture.store.wait(restored, second)).reply, 'Actual gemini reply');
    assert.deepEqual(fixture.requests, ['gemini']);
    assert(fixture.payloads[0].messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('Actual astra reply')));
    const history = await fixture.store.history('canvas', sessionId);
    assert.deepEqual(history.turns.map(turn => turn.reply), ['Actual astra reply', 'Actual gemini reply']);
    // A newly created but unused Astra session is the exact native incident.
    await fixture.close(); fixture = await modelFixture(directory, 'astra', ['astra']);
    const unused = await fixture.store.createSession('canvas');
    await fixture.close(); fixture = await modelFixture(directory, 'gemini', ['gemini']);
    const newSession = await fixture.store.ensureSession('canvas', unused.sessionId);
    const submitted = await fixture.store.submit(newSession, { turnId: 'unused', content: 'Only proposal' });
    assert.equal((await fixture.store.wait(newSession, submitted)).error, null);
    assert.deepEqual(fixture.requests, ['gemini']);
  } finally { await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('SIGKILL recovery never switches active turn; unavailable frozen model rejects before dispatch', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-model-resume-'));
  let fixture;
  try {
    const child = spawn(process.execPath, [new URL('./test-support/durable-model-switch-probe.mjs', import.meta.url).pathname, 'crash', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
    const exit = await new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'checkpoint.json'))).actualModel, 'astra', stderr);
    assert(process.platform === 'win32' ? exit.code === 1 : exit.signal === 'SIGKILL', stderr);
    const { sessionId } = JSON.parse(fs.readFileSync(path.join(directory, 'session.json')));
    fixture = await modelFixture(directory, 'gemini', ['gemini']);
    let entry = await fixture.store.ensureSession('canvas', sessionId);
    await assert.rejects(fixture.store.recover(entry), /model_unavailable_for_resume/);
    assert.deepEqual(fixture.requests, []); assert.deepEqual(fixture.completed, []);
    assert.equal((await fixture.store.status(entry)).active.turnId, 'interrupted');
    await fixture.close(); fixture = await modelFixture(directory, 'gemini', ['astra', 'gemini']);
    entry = await fixture.store.ensureSession('canvas', sessionId);
    const submission = await fixture.store.recover(entry);
    const result = await fixture.store.wait(entry, submission);
    assert.equal(result.reply, 'Actual astra reply'); assert.equal(result.error, null);
    assert.deepEqual(fixture.requests, ['astra']); assert.deepEqual(fixture.completed, ['interrupted']);
    assert(fixture.payloads[0].messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Original frozen request')));
  } finally { await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
