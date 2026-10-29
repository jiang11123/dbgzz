// Real server.mjs + real Go HTTP/SQLite supplied by a Go integration test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let child, log = '', modelCalls = 0, phase = 'crash';
const readBody = async (req) => { let raw = ''; for await (const chunk of req) raw += chunk; return JSON.parse(raw || '{}'); };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
function send(res, model, tool, args = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  frame(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + tool + '-' + modelCalls, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Two video drafts and two references are ready.' });
  frame({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
}
const provider = createServer(async (req, res) => {
  const request = await readBody(req); modelCalls++;
  if (phase === 'crash' && modelCalls === 2) return; // Actual nodes committed; host killed during next model request.
  const results = request.messages.filter((message) => message.role === 'tool');
  if (!results.length) return send(res, request.model, 'canvas_nodes_create', { expectedRevision: 1, nodes: [{ type: 'video', title: 'one' }, { type: 'video', title: 'two' }] });
  const created = JSON.parse(results[0].content).result;
  const edges = results.length - 1;
  if (edges < 2) return send(res, request.model, 'canvas_edge_create', { expectedRevision: 2 + edges, fromNodeId: 'n1', toNodeId: created.created[edges].id });
  send(res, request.model);
});
let base;
const headers = { 'content-type': 'application/json', 'X-Beeftv-Agent-Token': config.hostToken };
const api = async (route, body) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers,
  body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
async function backend(route, body) {
  const response = await fetch(config.backend + route, { method: body === undefined ? 'GET' : 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: response.status, value: await response.json() };
}
async function until(check) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) { if (await check()) return; if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('host exited: ' + log); await delay(50); }
  throw new Error('probe timeout: ' + log);
}
async function kill(signal) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((resolve) => child.once('close', resolve)); child.kill(signal);
  await Promise.race([done, delay(3000)]); if (child.exitCode === null) child.kill('SIGKILL'); await done;
}
try {
  const modelPort = await listen(provider);
  const reservation = createServer(); const port = await listen(reservation); await new Promise((resolve) => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, BEEFTV_AGENT_DATA_DIR: config.directory,
    BEEFTV_AGENT_PORT: String(port), BEEFTV_AGENT_HOST_TOKEN: config.hostToken, BEEFTV_OPS_URL: config.backend,
    BEEFTV_AGENT_API_KEY: 'fixture-only', BEEFTV_AGENT_API: 'openai-completions', BEEFTV_AGENT_MODEL: 'synthetic',
    BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, BEEFTV_AGENT_TOTAL_REQUEST_BUDGET: '0' };
  async function start() {
    child = spawn(process.execPath, [path.join(config.root, 'agent-host/server.mjs')], { cwd: config.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { log += chunk; }); child.stderr.on('data', (chunk) => { log += chunk; });
    await until(async () => { try { return (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } });
  }
  await start();
  const pending = api('/chat', { canvasId: config.canvasId, turnId: config.turnId, message: 'Create two video drafts and reference the existing node.', revisionBefore: 1 }).then((response) => response.text()).catch(() => null);
  await until(() => modelCalls === 2);
  const active = await (await api('/history?canvasId=' + config.canvasId)).json();
  assert(active.active); assert.equal(active.active.turnId, config.turnId);
  assert.equal((await backend('/assistant/runtime/turns/' + config.turnId)).value.data.open, true);
  await kill('SIGKILL'); await pending;
  // The same genuine Go turn remains open across the host process boundary.
  assert.equal((await backend('/assistant/runtime/turns/' + config.turnId)).value.data.open, true);
  phase = 'resume'; await start();
  await api('/history?canvasId=' + config.canvasId);
  let history;
  await until(async () => { history = await (await api('/history?canvasId=' + config.canvasId)).json(); return history.turns?.length === 1; });
  assert.equal(history.turns[0].turnId, config.turnId); assert.equal(history.turns[0].error, null);
  assert.equal((await backend('/assistant/runtime/turns/' + config.turnId)).value.data.open, false);
  const before = modelCalls;
  await api('/history?canvasId=' + config.canvasId); assert.equal(modelCalls, before);
  const durableId = history.sessionId;
  await kill('SIGTERM');
  await start();
  const retained = await (await api('/history?canvasId=' + config.canvasId)).json();
  assert.equal(retained.sessionId, durableId); assert.equal(retained.turns.length, 1);
  // 新建对话同样是 Durable；旧 JSONL 执行运行时已退役，不再有 sdk 回退。
  const fresh = await (await api('/sessions', { canvasId: config.canvasId })).json();
  assert(fresh.sessionId.startsWith('durable:'));
  assert.notEqual(fresh.sessionId, durableId);
  const empty = await (await api('/history?canvasId=' + config.canvasId)).json();
  assert.equal(empty.sessionId, fresh.sessionId); assert.deepEqual(empty.turns, []);
  const activated = await (await api('/sessions/activate', { canvasId: config.canvasId, sessionId: durableId })).json();
  assert.equal(activated.sessionId, durableId);
  const restored = await (await api('/history?canvasId=' + config.canvasId)).json();
  assert.equal(restored.sessionId, durableId); assert.equal(restored.turns.length, 1);
  assert.equal(modelCalls, before, 'activation must never run completed work again');
  fs.writeFileSync(path.join(config.directory, 'host-result.json'), JSON.stringify({ modelCalls, history, passed: true }));
} finally { await kill('SIGTERM'); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); }
