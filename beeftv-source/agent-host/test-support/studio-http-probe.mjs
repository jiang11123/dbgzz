// Real server.mjs + official Durable/Node; only the HTTP ops/model peers are scripted.
// The ops envelope matches Go opCanvasGet, before model-facing pagination.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serveEmptySkillContext } from './skill-context-fixture.mjs';

const root = path.resolve(process.argv[2] || '.');
const destination = process.argv[3];
const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv-studio-http-'));
const credential = 'synthetic-studio-test-only';
const payloads = [], calls = [], results = [], turns = new Map();
let child, base, hostLog = '', readOnly = true, readFailure = '', providerMode = '', providerStep = 0, serial = 0;
let canvas = { revision: 7, nodes: [], connections: [] };
const readJSON = async req => { let raw = ''; for await (const part of req) raw += part; return JSON.parse(raw || '{}'); };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const text = message => typeof message.content === 'string' ? message.content : (message.content || []).map(part => part.text || '').join('');
const system = body => body.messages.filter(m => ['system', 'developer'].includes(m.role)).map(text).join('\n');
const users = body => body.messages.filter(m => m.role === 'user').map(text).join('\n');
const descriptors = [
  { id: 'canvas.get', readOnly: true, replay: 'safe', assistantModes: ['canvas', 'read-only', 'full-access'], scope: 'canvas', summary: 'Read canvas', params: { type: 'object', properties: { canvasId: { type: 'string' } }, required: ['canvasId'] } },
  { id: 'canvas.nodes.create', readOnly: false, assistantModes: ['canvas', 'full-access'], scope: 'canvas', summary: 'Create nodes', params: { type: 'object', properties: { canvasId: { type: 'string' }, expectedRevision: { type: 'integer' }, nodes: { type: 'array', items: { type: 'object' } } }, required: ['canvasId', 'expectedRevision', 'nodes'] } },
];
const provider = createServer(async (req, res) => {
  const body = await readJSON(req); payloads.push(body);
  const tool = providerMode === 'unbound' && providerStep++ === 0
    ? { name: 'canvas_nodes_create', arguments: JSON.stringify({ expectedRevision: canvas.revision, nodes: [{ id: 'image-new', type: 'image', title: '新首帧' }, { id: 'video-new', type: 'video', title: '新视频' }] }) } : null;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  frame({ role: 'assistant', ...(tool ? { tool_calls: [{ index: 0, id: 'create-unbound', type: 'function', function: tool }] } : { content: 'Synthetic acknowledgement.' }) });
  frame({}, tool ? 'tool_calls' : 'stop');
  res.end('data: [DONE]\n\n');
});
const ops = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers['x-beeftv-agent-token'] !== credential) return res.writeHead(403).end(JSON.stringify({ code: 403 }));
  if (serveEmptySkillContext(req, res)) return;
  if (req.url === '/api/ops') return res.end(JSON.stringify({ code: 0, data: { ops: descriptors } }));
  if (req.url.startsWith('/api/assistant/runtime/turns/')) {
    const turnId = decodeURIComponent(req.url.split('/')[5]);
    return res.end(JSON.stringify({ code: 0, data: { turnId, canvasId: turns.get(turnId), permissionMode: readOnly ? 'read-only' : 'canvas', open: true } }));
  }
  const body = await readJSON(req), turnId = req.headers['x-beeftv-agent-turn'];
  calls.push({ path: req.url, body, turnId });
  if (req.url === '/api/ops/skill.catalog' && turns.has(turnId)) return res.end(JSON.stringify({ code: 0, data: { op: 'skill.catalog', replayed: false, result: { skills: [] } } }));
  if (!turnId || body.params.canvasId !== turns.get(turnId)) return res.writeHead(403).end(JSON.stringify({ code: 403, reason: 'scope_denied' }));
  if (req.url === '/api/ops/canvas.get') {
    if (readFailure === 'denied') return res.writeHead(403).end(JSON.stringify({ code: 403, reason: 'scope_denied' }));
    if (readFailure === 'business-error') return res.end(JSON.stringify({ code: 409, reason: 'canvas_unavailable' }));
    if (readFailure === 'non-json') return res.end('unavailable');
    let result = { canvasId: body.params.canvasId, canvas: { id: body.params.canvasId, ...canvas } };
    if (readFailure === 'missing') result = { canvasId: body.params.canvasId };
    if (readFailure === 'wrong-canvas') result.canvasId = 'foreign';
    if (readFailure === 'bad-revision') result.canvas.revision = '7';
    if (readFailure === 'bad-nodes') result.canvas.nodes = {};
    if (readFailure === 'bad-connections') result.canvas.connections = {};
    return res.end(JSON.stringify({ code: 0, data: { op: 'canvas.get', replayed: false, result } }));
  }
  if (req.url === '/api/ops/canvas.nodes.create' && !readOnly) {
    assert.equal(body.params.expectedRevision, canvas.revision);
    canvas = { ...canvas, revision: canvas.revision + 1, nodes: [...canvas.nodes, ...body.params.nodes] };
    return res.end(JSON.stringify({ code: 0, data: { op: 'canvas.nodes.create', replayed: false, result: { canvasId: body.params.canvasId, revision: canvas.revision, created: body.params.nodes } } }));
  }
  res.writeHead(403).end(JSON.stringify({ code: 403, reason: 'scope_denied' }));
});
async function stopHost() {
  if (child && child.exitCode === null) {
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGTERM'); await Promise.race([closed, delay(3000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await closed; }
  }
}
async function startHost(opsPort, modelPort, readonly) {
  await stopHost(); readOnly = readonly;
  const reservation = createServer(), port = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, BEEFTV_AGENT_DATA_DIR: path.join(scratch, readonly ? 'read' : 'write'), BEEFTV_AGENT_PORT: String(port), BEEFTV_AGENT_READ_ONLY: readonly ? '1' : '0',
    BEEFTV_OPS_URL: `http://127.0.0.1:${opsPort}/api`, BEEFTV_AGENT_HOST_TOKEN: credential, BEEFTV_AGENT_API_KEY: 'synthetic-model-key', BEEFTV_AGENT_API: 'openai-completions',
    BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, BEEFTV_AGENT_MODEL: 'synthetic-studio', BEEFTV_AGENT_MAX_REQUESTS_PER_TURN: '4', BEEFTV_AGENT_MAX_TOOL_STEPS_PER_TURN: '4' };
  delete env.BEEFTV_AGENT_LISTEN_FD;
  child = spawn(process.execPath, [path.join(root, 'agent-host/server.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { hostLog += b; }); child.stderr.on('data', b => { hostLog += b; });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw Error(`host exited ${child.exitCode}: ${hostLog.slice(-1500)}`);
    try { if ((await fetch(base + '/health')).ok) return; } catch { /* Starting. */ }
    await delay(100);
  }
  throw Error('host startup timeout');
}
async function chat(canvasId = 'studio-canvas') {
  const turnId = `studio-${++serial}`, before = payloads.length; turns.set(turnId, canvasId);
  const response = await fetch(base + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beeftv-Agent-Token': credential },
    body: JSON.stringify({ canvasId, turnId, requestId: turnId, revisionBefore: canvas.revision, message: 'Check the current canvas.' }), signal: AbortSignal.timeout(25000) });
  const raw = await response.text(), events = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(response.status, 200, raw);
  const end = events.find(e => e.type === 'turn_end'); assert(end && !end.error && !end.cancelled, raw);
  assert(payloads.length > before, 'scripted model must see the real host request');
  return payloads.slice(before);
}
async function scenario(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message); }
}
try {
  const opsPort = await listen(ops), modelPort = await listen(provider);
  await startHost(opsPort, modelPort, true);
  canvas.nodes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, type: 'text', title: `原节点${i}`, metadata: { content: 'original' } }));
  await scenario('read-only-http-envelope-reaches-current-studio', async () => {
    const [body] = await chat();
    assert.match(system(body), /画布版本 7/); assert.match(system(body), /文本 6/); assert.doesNotMatch(system(body), /画布是空的/);
    assert(!body.tools.some(t => t.function.name === 'canvas_nodes_create'), 'read-only must not gain a write tool');
    assert(calls.some(c => c.path === '/api/ops/canvas.get' && c.turnId === 'studio-1'));
  });
  for (const failure of ['missing', 'wrong-canvas', 'bad-revision', 'bad-nodes', 'bad-connections', 'denied', 'business-error', 'non-json']) {
    await scenario(`unknown-${failure}-does-not-reuse-studio-or-reset-snapshot`, async () => {
      readFailure = failure;
      const [failed] = await chat(); assert.doesNotMatch(system(failed), /<beeftv_studio>|画布是空的/);
      readFailure = ''; canvas.revision++;
      canvas.nodes[0].metadata.content += '-changed';
      const [recovered] = await chat();
      assert.match(system(recovered), /文本 6/);
      const lastUser = recovered.messages.filter(m => m.role === 'user').at(-1);
      assert.match(text(lastUser), /用户修改了「原节点0」/); assert.doesNotMatch(text(lastUser), /新增 6 个|删除了/);
    });
    readFailure = '';
  }
  await scenario('complete-snapshot-is-not-limited-to-model-first-page', async () => {
    canvas = { revision: 20, nodes: Array.from({ length: 61 }, (_, i) => ({ id: `many-${i}`, type: 'text', title: `节点${i}` })), connections: [] };
    const [body] = await chat('many-canvas'); assert.match(system(body), /文本 61/);
  });
  await scenario('explicit-empty-and-omitted-empty-collections-stay-valid', async () => {
    for (const empty of [{ revision: 0, nodes: [], connections: [] }, { revision: 1 }, { revision: 2, nodes: null, connections: null }]) {
      canvas = empty; const [body] = await chat(`empty-${empty.revision}`); assert.match(system(body), /画布是空的/);
    }
  });
  assert(calls.every(c => ['/api/ops/canvas.get', '/api/ops/skill.catalog'].includes(c.path)), 'read-only phase must not write');
  await startHost(opsPort, modelPort, false);
  await scenario('canvas-mode-unpacks-six-nodes-instead-of-reporting-empty', async () => {
    canvas = { revision: 29, nodes: Array.from({ length: 6 }, (_, i) => ({ id: `six-${i}`, type: 'text', title: `六节点${i}` })), connections: [] };
    const [body] = await chat('six-canvas');
    assert.match(system(body), /画布版本 29/); assert.match(system(body), /文本 6/); assert.doesNotMatch(system(body), /画布是空的/);
  });
  await scenario('http-snapshot-drives-unbound-media-reminder-after-write', async () => {
    canvas = { revision: 30, nodes: [{ id: 'board', type: 'script', title: '真实分镜', metadata: { storyboard: { rows: [{ id: 'row-1', shotNumber: 1 }] } } }], connections: [] };
    providerMode = 'unbound'; providerStep = 0;
    const bodies = await chat('unbound-canvas');
    assert.equal(bodies.length, 3, 'one tool response, one attempted reply, one reminder continuation');
    assert.match(system(bodies[1]), /画布版本 31/); assert.match(system(bodies[1]), /新首帧/);
    assert.match(users(bodies[2]), /制作现场检查/); assert.match(users(bodies[2]), /image-new/); assert.match(users(bodies[2]), /video-new/);
    assert.match(users(bodies[2]), /expectedRevision=31/);
    assert.equal(calls.filter(c => c.path === '/api/ops/canvas.nodes.create').length, 1);
  });
} catch (error) { results.push({ name: 'probe-runtime', passed: false, error: error.message }); }
finally {
  await stopHost();
  for (const server of [ops, provider]) if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (destination) writeFileSync(destination, JSON.stringify({ kind: 'real-host-scripted-http-no-paid-calls', results, modelRequests: payloads.length, opsCalls: calls, hostLog: hostLog.slice(-5000) }, null, 2));
  rmSync(scratch, { recursive: true, force: true });
}
if (results.some(r => !r.passed)) process.exitCode = 1;
