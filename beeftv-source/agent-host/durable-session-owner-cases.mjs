import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Harness } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { modelFixture } from './test-support/durable-model-switch-probe.mjs';
import { durableCompletion, durableToolReplay, publicDurableTurn } from './durable-session-owner.mjs';
import { createLegacyHistory } from './session-owner.mjs';
const worker = fileURLToPath(new URL('./durable-owner-fixture.mjs', import.meta.url));
const processTest = (name, fn) => test(name, { timeout: 60000 }, fn);
for (const action of ['create', 'activate']) processTest(`failed Durable ${action} closes candidate and preserves the current owner`, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-pointer-'));
  const fixture = await modelFixture(directory, 'fixture', ['fixture']);
  try {
    let current = await fixture.store.createSession('canvas');
    let target;
    if (action === 'activate') {
      target = current.sessionId;
      current = await fixture.store.createSession('canvas');
    }
    const files = fs.readdirSync(path.join(directory, 'sessions'));
    const canvasDir = path.join(directory, 'sessions', files[0]);
    const pointer = path.join(canvasDir, 'current.json');
    const originalPointer = fs.readFileSync(pointer, 'utf8');
    let closed = 0;
    const open = Harness.open.bind(Harness);
    t.mock.method(Harness, 'open', async (...args) => {
      const harness = await open(...args);
      const close = harness.close.bind(harness);
      harness.close = async (...args) => { closed++; return close(...args); };
      return harness;
    });
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source, destination) => {
      if (destination === pointer) throw Object.assign(new Error('fixture pointer denied'), { code: 'EACCES' });
      return rename(source, destination);
    });
    await assert.rejects(action === 'create' ? fixture.store.createSession('canvas') : fixture.store.activateSession('canvas', target),
      { reason: 'session_pointer_failed' });
    assert.equal(closed, 1);
    assert.equal(fixture.store.sessions.get('canvas'), current);
    assert.equal(fs.readFileSync(pointer, 'utf8'), originalPointer);
    assert(!fs.readdirSync(canvasDir).some(name => name.endsWith('.tmp')));
    assert.deepEqual(fixture.requests, []);
  } finally {
    t.mock.restoreAll();
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('failed or unanswered submission cannot reuse a prior assistant as a successful reply', () => {
  const prior = { stopReason: 'stop', content: [{ type: 'text', text: 'old reply' }] };
  const failed = durableCompletion({ status: 'unanswered', reason: 'model_error', detail: 'fixture failure' }, prior);
  assert.equal(failed.reply, ''); assert.equal(failed.errorReason, 'model_error'); assert(failed.error);
  const absent = durableCompletion({ status: 'done' }, null); assert(absent.error); assert.equal(absent.reply, '');
  const stopped = durableCompletion({ status: 'unanswered', reason: 'aborted' }, null);
  assert(stopped.cancelled); assert.equal(stopped.reply, '');
  const budget = durableCompletion({ status: 'unanswered', reason: 'model_error' }, null, { reason: 'turn_request_budget_exhausted', message: 'limit' });
  assert.equal(budget.errorReason, 'turn_request_budget_exhausted');
});
processTest('legacy handoff survives failed pointer publication and restart without duplicate sessions or resetting context', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-handoff-publication-'));
  let fixture = await modelFixture(directory, 'fixture', ['fixture']);
  try {
    const previous = await fixture.store.createSession('canvas');
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source, destination) => {
      if (destination.endsWith('current.json')) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
      return rename(source, destination);
    });
    await assert.rejects(fixture.store.handoffSession('canvas', '原始交接说明', 'legacy-a'), { reason: 'session_pointer_failed' });
    assert.equal(fixture.store.sessions.get('canvas'), previous);
    t.mock.restoreAll();
    await fixture.close();
    fixture = await modelFixture(directory, 'fixture', ['fixture']);
    const entry = await fixture.store.handoffSession('canvas', '不应覆盖先前交接', 'legacy-a');
    const submission = await fixture.store.submit(entry, { turnId: 'handoff-turn', content: '首轮消息' });
    await fixture.store.wait(entry, submission);
    const again = await fixture.store.handoffSession('canvas', '不应重置已有轮次', 'legacy-a');
    assert.equal(again, entry);
    assert.equal((await fixture.store.history('canvas', entry.sessionId)).turns.length, 1);
    assert(JSON.stringify(fixture.payloads).includes('原始交接说明'));
    assert(!JSON.stringify(fixture.payloads).includes('不应覆盖先前交接'));
    const other = await fixture.store.handoffSession('canvas', '另一个旧会话', 'legacy-b');
    assert.notEqual(other.sessionId, entry.sessionId);
    const sessions = await fixture.store.listCanvasSessions('canvas');
    assert.equal(sessions.length, 3); // Explicit new session plus two distinct legacy sources.
  } finally {
    t.mock.restoreAll();
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
for (const phase of ['pending-success', 'pending-failure', 'pending-stop', 'partial-stop', 'multi-steer', 'persisted-supplement-stop', 'prep-error-partial']) processTest(`official owner ${phase} preserves latest input and current partial`, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `beeftv-durable-${phase}-`)); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await run(directory, phase); assert.equal(result.code, 0, result.output);
});
for(const mode of ['read-only','canvas','full']) processTest(`official provider sees Go-authorized ${mode} schema and frozen history`,async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'beeftv-durable-permission-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const result=await run(directory,`permission-${mode}`);assert.equal(result.code,0,result.output);
 const saved=JSON.parse(fs.readFileSync(path.join(directory,'result.json'),'utf8'));
 assert.equal(saved.record.permissionMode,mode==='full'?'full-access':mode);
 assert.equal(saved.state.executions,mode==='full'?1:0);
});
processTest('crash recovery rejects authority changing frozen read-only to full-access without dispatch',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'beeftv-durable-mode-upgrade-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const crash=await run(directory,'permission-crash');assertCheckpointKill(crash,directory,'permission-crash');
 const recovered=await run(directory,'permission-upgrade');assert.equal(recovered.code,0,recovered.output);
});
test('history projection excludes native media bytes and replay defaults unknown writes to unsafe', () => {
  const projected = publicDurableTurn({ turnId: 't', userText: 'read', content: [{ type: 'image', data: 'large-native-image' }],
    log: [{ data: 'secret' }], result: {}, effects: {}, supplementContents: [{ content: 'raw' }],
    supplementInputs: [{ message: '', attachments: [{ resourceId: 'r' }], skills: [] }] }, true);
  assert(!JSON.stringify(projected).includes('large-native-image'));
  assert.equal(projected.status, 'running'); assert.equal(projected.supplementInputs[0].message, '');
  assert.equal(durableToolReplay({ label: 'canvas.nodes.create', replay: 'safe' }), 'safe');
  assert.equal(durableToolReplay({ label: 'future.paid.submit' }), 'unsafe');
});
test('public provider failures hide upstream detail while retaining internal diagnostics and budget reasons', () => {
  const detail = '503 upstream https://example.invalid/private?signature=synthetic-secret';
  for (const errorReason of ['model_error', 'provider_error']) {
    const internal = { error: detail, errorReason, cancelled: false, reply: '', turnId: 'failed-turn' };
    const visible = publicDurableTurn(internal);
    assert.equal(visible.error, '模型没有完成回复。已经完成的操作会保留，请检查结果后再继续。');
    assert.equal(visible.errorReason, errorReason);
    assert.equal(visible.cancelled, false);
    assert.equal(internal.error, detail, 'projection must not overwrite diagnostic records');
    assert(!JSON.stringify(visible).includes('synthetic-secret'));
  }
  const budget = { error: 'local budget is exhausted', errorReason: 'turn_request_budget_exhausted' };
  assert.deepEqual(publicDurableTurn(budget), budget);
  assert.equal(publicDurableTurn({ cancelled: true, error: null }).error, null);
});
const run = (directory, phase) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [worker, directory, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`fixture timeout ${phase}: ${output}`)); }, 20000);
  child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  child.on('error', reject);
});
function assertCheckpointKill(result, directory, phase) {
  const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, 'crash-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.phase, phase);
  if (phase === 'crash' || phase === 'unsafe-crash') {
    assert.equal(checkpoint.state.nodes, 2); assert.equal(checkpoint.state.executions, 1);
    assert.equal(Object.keys(checkpoint.state.receipts).length, 1);
  }
  if (phase === 'complete-crash' || phase === 'fence-crash') assert.equal(checkpoint.state.completed, 1);
  if (phase === 'persisted-supplement-stop-crash') { assert.equal(checkpoint.state.completed, 1); assert.equal(checkpoint.state.unadmitted, true); assert.equal(checkpoint.state.executions, 0); }
  const files = fs.readdirSync(path.join(directory, 'sessions'), { recursive: true }).filter(file => String(file).endsWith('.sqlite'));
  assert.equal(files.length, 1, 'official Durable SQLite checkpoint missing');
  assert.equal(fs.readFileSync(path.join(directory, 'sessions', files[0])).subarray(0, 16).toString(), 'SQLite format 3\0');
  if (process.platform === 'win32') { assert.equal(result.signal, null, result.output); assert.equal(result.code, 1, result.output); }
  else assert.equal(result.signal, 'SIGKILL', result.output);
}
processTest('hard kill after receipt commit replays one stable tool task and never duplicates business effects', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-crash-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'crash'); assertCheckpointKill(crash, directory, 'crash');
  const denied = await run(directory, 'denied'); assert.equal(denied.code, 0, denied.output);
  const resume = await run(directory, 'resume'); assert.equal(resume.code, 0, resume.output);
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
  assert.equal(result.state.nodes, 2); assert.equal(result.state.edges, 2);
  assert.equal(Object.keys(result.state.receipts).length, 2);
  assert(Object.keys(result.state.receipts).every((id) => /^durable:[a-f0-9-]{36}:\d+$/.test(id)));
});
processTest('disconnect only cancels a wait; same-session supplement and pinned skill survive', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-wait-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await run(directory, 'wait'); assert.equal(result.code, 0, result.output);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
  assert.deepEqual(saved.record.supplements, ['Use landscape']);
});
processTest('completion crash only reconstructs history after Go is closed; no model dispatch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-complete-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'complete-crash'); assertCheckpointKill(crash, directory, 'complete-crash');
  const resume = await run(directory, 'closed-resume'); assert.equal(resume.code, 0, resume.output);
});
processTest('unknown future paid write is unsafe and never rerun after effect-before-result crash', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-unsafe-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'unsafe-crash'); assertCheckpointKill(crash, directory, 'unsafe-crash');
  const resume = await run(directory, 'unsafe-resume'); assert.equal(resume.code, 0, resume.output);
});
processTest('explicit stop aborts official work and records cancellation without canvas writes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-stop-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stopped = await run(directory, 'stop'); assert.equal(stopped.code, 0, stopped.output);
});
processTest('supplement persists across hard kill and is placed before the recovered model request', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-supplement-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'supplement-crash'); assertCheckpointKill(crash, directory, 'supplement-crash');
  const resumed = await run(directory, 'supplement-resume'); assert.equal(resumed.code, 0, resumed.output);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
  assert.deepEqual(saved.record.supplements, ['Use landscape']);
  assert.equal(saved.record.supplementInputs[0].message, 'Use landscape');
});
processTest('persisted stop before Go close survives crash without dispatching a closed placed submission', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-fence-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'fence-crash'); assertCheckpointKill(crash, directory, 'fence-crash');
  const resumed = await run(directory, 'fence-resume'); assert.equal(resumed.code, 0, resumed.output);
});
processTest('stopped recovery skips persisted but unadmitted supplemental input and preserves its own partial', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-admission-gap-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'persisted-supplement-stop-crash'); assertCheckpointKill(crash, directory, 'persisted-supplement-stop-crash');
  const resumed = await run(directory, 'persisted-supplement-stop-resume'); assert.equal(resumed.code, 0, resumed.output);
});
processTest('actual default Durable host accepts attachment-only steer and blocks writes during image preparation', async () => {
  const probe = fileURLToPath(new URL('./test-support/durable-attachment-steer-probe.mjs', import.meta.url));
  const child = spawn(process.execPath, [probe, path.resolve(path.dirname(worker), '..')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); }); clearTimeout(timer);
  assert.equal(code, 0, output); assert(output.includes('"attachmentOnly":true'));
});
processTest('legacy JSONL handoff seeds a new Durable session with the old transcript as a plain-text reset note', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-handoff-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = await modelFixture(directory, 'fixture', ['fixture']);
  try {
    const legacy = createLegacyHistory({ sessionRoot: path.join(directory, 'sessions'), workspaceRoot: path.join(directory, 'workspace') });
    const cwd = legacy.canvasWorkspace('canvas');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionDir = legacy.canvasSessionDir('canvas');
    const sessionId = 'legacy-handoff-source';
    const timestamp = '2026-10-07T12:00:00.000Z';
    const rows = [
      { type: 'session', version: 3, id: sessionId, timestamp, cwd },
      { type: 'message', id: 'u', parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text: '旧会话原始需求' }], timestamp: 1 } },
      { type: 'message', id: 'a', parentId: 'u', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: '旧会话历史回执' }], timestamp: 2 } },
    ];
    fs.writeFileSync(path.join(sessionDir, `2026-10-07T12-00-00-000Z_${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const entry = await fixture.store.handoffSession('canvas', legacy.readHandoffNote('canvas', sessionId));
    const view = await entry.root.context(BACKGROUND_CONTEXT);
    assert(view.head && (view.head.model || []).some((message) => message.role === 'user' && JSON.stringify(message.content).includes('旧会话原始需求')));

    const submission = await fixture.store.submit(entry, { turnId: 'handoff-turn', content: '继续改一下' });
    await fixture.store.wait(entry, submission);
    const payload = JSON.stringify(fixture.payloads.at(-1));
    assert(payload.includes('旧会话原始需求'));
    assert(payload.includes('旧会话历史回执'));
    assert(payload.includes('继续改一下'));
  } finally { await fixture.close(); }
});
