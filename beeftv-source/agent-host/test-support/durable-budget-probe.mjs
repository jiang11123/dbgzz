// Real child host and SDK; exclusively temporary data and loopback fake endpoints.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serveEmptySkillContext } from './skill-context-fixture.mjs';
const root = path.resolve(process.argv[2] || '.');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-budget-'));
const token = 'synthetic-budget-token';
let calls = 0, hold = false, base, child, log = '';
let turnSeq = 0;
const turnCanvas = new Map();
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const provider = createServer(async (req, res) => {
  for await (const chunk of req) { /* drain request */ }
  calls++;
  if (hold) return;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const choice of [
    { index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'stop' },
  ]) res.write('data: ' + JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [choice] }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
const ops = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if(serveEmptySkillContext(req,res))return;
  if (req.url.startsWith('/api/assistant/runtime/turns/')) {
    const turnId = decodeURIComponent(req.url.split('/')[5] || '');
    res.end(JSON.stringify({ code: 0, data: { turnId, canvasId: turnCanvas.get(turnId) || 'test', permissionMode: 'canvas', open: true } }));
    return;
  }
  res.end(JSON.stringify({ code: 0, data: { ops: [] } }));
});
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'close'); child.kill('SIGKILL'); await exited;
}
async function start(dir, limit) {
  const socket = createServer(); const port = await listen(socket); await new Promise(resolve => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  log = '';
  child = spawn(process.execPath, [path.join(root, 'agent-host/server.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, BEEFTV_AGENT_PORT: String(port), BEEFTV_AGENT_LISTEN_FD: '0', BEEFTV_AGENT_LIFETIME_STDIN: '0',
    BEEFTV_AGENT_INSTANCE_NONCE: '', BEEFTV_AGENT_DATA_DIR: dir, BEEFTV_AGENT_HOST_TOKEN: token,
    BEEFTV_AGENT_API_KEY: 'fake', BEEFTV_AGENT_MODEL: 'fake', BEEFTV_AGENT_API: 'openai-completions',
    BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, BEEFTV_OPS_URL: `http://127.0.0.1:${ops.address().port}/api`,
    BEEFTV_AGENT_TOTAL_REQUEST_BUDGET: String(limit), BEEFTV_AGENT_MAX_REQUESTS_PER_TURN: '1',
  }});
  child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  // Match assistantruntime's production ready deadline, including SDK import time.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(log);
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(200) })).ok) return; } catch {}
    await delay(100);
  }
  throw Error('Host did not start within 20s: ' + log);
}
async function chat(canvasId = 'test') {
  const turnId = `budget-${++turnSeq}`;
  turnCanvas.set(turnId, canvasId);
  const res = await fetch(base + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Beeftv-Agent-Token': token }, body: JSON.stringify({ canvasId, message: 'Reply ok', turnId }), signal: AbortSignal.timeout(20000) });
  const text = await res.text(); assert.equal(res.status, 200, text);
  const end = text.trim().split('\n').map(JSON.parse).find(event => event.type === 'turn_end');
  assert(end, text); return end;
}
const directory = name => { const dir = path.join(scratch, name); fs.mkdirSync(dir); return dir; };
const budgetFile = dir => path.join(dir, 'agent-request-budget.json');
try {
  await listen(provider); await listen(ops);
  const crash = directory('crash'); await start(crash, 1); hold = true;
  const before = calls; const pending = chat().catch(() => {});
  for (let i = 0; calls === before && i < 150; i++) await delay(100);
  assert.equal(calls, before + 1); assert.equal(JSON.parse(fs.readFileSync(budgetFile(crash))).used, 1);
  await stop(); await pending; hold = false; await start(crash, 1);
  assert.equal((await chat('after-crash')).errorReason, 'request_budget_exhausted'); assert.equal(calls, before + 1); await stop();
  console.log('PASS SIGKILL after dispatch preserves reservation on restart');

  for (const contents of ['{broken', '{}', '{"used":-1}', '{"used":"0"}', '{"used":0.5}']) {
    const dir = directory('corrupt-' + Math.random()); fs.writeFileSync(budgetFile(dir), contents); const before = calls;
    await start(dir, 2); const end = await chat(); assert.equal(end.errorReason, 'request_budget_storage_unavailable'); assert.match(end.error, /恢复有效备份/); assert.equal(calls, before); assert.equal(fs.readFileSync(budgetFile(dir), 'utf8'), contents); await stop();
  }
  console.log('PASS malformed persisted counts deny without resetting');

  const write = directory('write-failure'); await start(write, 3);
  fs.mkdirSync(budgetFile(write)); const writeBefore = calls;
  assert.equal((await chat()).errorReason, 'request_budget_storage_unavailable'); assert.equal(calls, writeBefore);
  assert.equal(fs.readdirSync(write).filter(name => name.endsWith('.tmp')).length, 0);
  fs.rmdirSync(budgetFile(write));
  assert.equal((await chat('retry')).errorReason, 'request_budget_storage_unavailable'); assert.equal(calls, writeBefore); await stop();
  console.log('PASS atomic replacement failure denies, remains closed for process');

  const disabled = directory('disabled'); fs.mkdirSync(budgetFile(disabled)); await start(disabled, 0);
  const disabledBefore = calls; assert.equal((await chat()).error, null); assert.equal(calls, disabledBefore + 1); assert(fs.statSync(budgetFile(disabled)).isDirectory()); await stop();
  console.log('PASS disabled budget ignores unreadable/unwritable budget path');

  const concurrent = directory('concurrent'); await start(concurrent, 2); const concurrentBefore = calls;
  const ends = await Promise.all(['a', 'b', 'c'].map(id => chat(id)));
  assert.equal(ends.filter(e => !e.error).length, 2); assert.equal(ends.filter(e => e.errorReason === 'request_budget_exhausted').length, 1);
  assert.equal(calls, concurrentBefore + 2); assert.equal(JSON.parse(fs.readFileSync(budgetFile(concurrent))).used, 2);
  assert.equal((await chat('a')).errorReason, 'request_budget_exhausted'); await stop(); await start(concurrent, 2);
  assert.equal((await chat('d')).errorReason, 'request_budget_exhausted'); assert.equal(calls, concurrentBefore + 2); await stop();
  console.log('PASS concurrent canvases and later turns preserve total cap across restart');
} finally {
  await stop();
  for (const server of [ops, provider]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(scratch, { recursive: true, force: true });
}
