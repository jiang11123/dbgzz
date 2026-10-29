// Actual server.mjs/default official Durable. Loopback model and business API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { serveEmptySkillContext } from './skill-context-fixture.mjs';
const root = path.resolve(process.argv[2] || '.');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-http-steer-'));
const hostToken = 'fixture-http-steer';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=';
let child, log = '', writes = 0, modelCalls = 0, base, releaseOld, releaseImage, imageArrived, releaseLatest;
const imageStarted = new Promise(resolve => { imageArrived = resolve; });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const read = async req => { let raw = ''; for await (const chunk of req) raw += chunk; return JSON.parse(raw || '{}'); };
const closed = new Set();
const ops = createServer(async (req, res) => {
  assert.equal(req.headers['x-beeftv-agent-token'], hostToken);
  res.setHeader('content-type', 'application/json');
  if(serveEmptySkillContext(req,res))return;
  const turn = req.url.match(/\/assistant\/runtime\/turns\/([^/]+)(\/complete)?$/);
  if (turn) { if (turn[2]) closed.add(turn[1]); res.end(JSON.stringify({ code: 0, data: { turnId: turn[1], canvasId: 'canvas', open: !closed.has(turn[1]), revision: 1 } })); return; }
  if (req.url === '/api/ops') { res.end(JSON.stringify({ code: 0, data: { ops: [{ id: 'canvas.node.update', summary: 'update', assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false, params: { type: 'object', properties: { nodeId: { type: 'string' }, expectedRevision: { type: 'integer' }, patch: { type: 'object' } } } }] } })); return; }
  const body = await read(req);
  if(req.url.endsWith('/bind-session')) {assert.match(body.sessionId,/^durable:/);res.end(JSON.stringify({code:0,data:{bound:true}}));return;}
  if (req.url === '/api/ops/skill.catalog') { res.end(JSON.stringify({ code: 0, data: { result: { skills: [], total: 0 } } })); return; }
  if (req.url === '/api/ops/media.overview') { res.end(JSON.stringify({ code: 0, data: { result: { source: { version: 'owned-fixture-version' } } } })); return; }
  if (req.url === '/api/ops/media.inspect') {
    assert.equal(body.params.expectedVersion, 'owned-fixture-version');
    imageArrived(); await new Promise(resolve => { releaseImage = resolve; });
    res.end(JSON.stringify({ code: 0, data: { result: { content: [{ type: 'image', mimeType: 'image/png', data: png }] } } })); return;
  }
  assert.equal(req.url,'/api/ops/canvas.node.update','unhandled fixture route must not count as a canvas write');
  assert(!closed.has('http-steer-turn'), 'Go turn closed before final supplemental write');
  writes++; res.end(JSON.stringify({ code: 0, data: { result: { nodeId: 'n1', revision: 2 } } }));
});
const provider = createServer(async (req, res) => {
  const body = await read(req); modelCalls++;
  if (modelCalls === 1) await new Promise(resolve => { releaseOld = resolve; });
  else { assert(JSON.stringify(body.messages).includes('image_url')); assert(JSON.stringify(body.messages).includes('BEEFTV_INPUT:attachment-only')); }
  if (modelCalls === 3) await new Promise(resolve => { releaseLatest = resolve; });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const isTool = modelCalls === 1 || modelCalls === 3;
  const delta = isTool ? { role: 'assistant', tool_calls: [{ index: 0, id: modelCalls === 1 ? 'old-write' : 'latest-write', type: 'function', function: { name: 'canvas_node_update', arguments: JSON.stringify({ nodeId: 'n1', expectedRevision: 1, patch: { title: modelCalls === 1 ? 'old unwanted title' : 'new attached image draft' } }) } }] } : { role: 'assistant', content: modelCalls === 2 ? 'Intermediate prepared answer.' : 'Updated draft using the attached image.' };
  const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  frame(delta); frame({}, isTool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
});
const until = async check => { const end = Date.now() + 15000; while (!(await check())) { if (Date.now() > end) throw Error('HTTP fixture timeout: ' + log); await delay(20); } };
const request = (route, body) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'X-Beeftv-Agent-Token': hostToken }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
try {
  const opsPort = await listen(ops), providerPort = await listen(provider);
  const reservation = createServer(), hostPort = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
  base = `http://127.0.0.1:${hostPort}`;
  const env = { ...process.env, BEEFTV_AGENT_DATA_DIR: directory, BEEFTV_AGENT_PORT: String(hostPort), BEEFTV_OPS_URL: `http://127.0.0.1:${opsPort}/api`, BEEFTV_AGENT_HOST_TOKEN: hostToken,
    BEEFTV_AGENT_API_KEY: 'fixture-only', BEEFTV_AGENT_API: 'openai-completions', BEEFTV_AGENT_MODEL: 'fixture', BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, BEEFTV_AGENT_TOTAL_REQUEST_BUDGET: '0' };
  child = spawn(process.execPath, [path.join(root, 'agent-host/server.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  await until(async () => { try { return (await request('/health')).ok; } catch { return false; } });
  const session = await (await request('/sessions', { canvasId: 'canvas' })).json(); assert(session.sessionId.startsWith('durable:'));
  const chat = request('/chat', { canvasId: 'canvas', sessionId: session.sessionId, turnId: 'http-steer-turn', message: 'Update this draft', revisionBefore: 1 }).then(response => response.text());
  await until(() => releaseOld);
  const steer = request('/steer', { canvasId: 'canvas', sessionId: session.sessionId, requestId: 'attachment-only', message: '', attachments: [{ kind: 'image', nodeId: 'n1', resourceId: 'owned-image' }] });
  let preparationTimer;
  try {
    await Promise.race([imageStarted, steer.then(async response => { throw Error(`steer returned before image preparation ${response.status}: ${await response.clone().text()} ${log}`); }), new Promise((_, reject) => { preparationTimer = setTimeout(() => reject(Error('image preparation did not start: ' + log)), 10000); })]);
  } finally { clearTimeout(preparationTimer); }
  releaseOld(); await delay(250);
  assert.equal(writes, 0, 'stale write escaped during attachment preparation'); assert.equal(modelCalls, 1, 'new model requested without prepared image');
  releaseImage(); const accepted = await steer; assert.equal(accepted.status, 202, await accepted.text());
  await until(() => releaseLatest);
  assert(!closed.has('http-steer-turn'), 'original answer prematurely completed the Go business turn');
  const running = await (await request('/history?canvasId=canvas')).json(); assert(running.active); assert.equal(running.turns.length, 0);
  releaseLatest();
  await chat;
  let history; await until(async () => { history = await (await request('/history?canvasId=canvas')).json(); return history.turns?.length === 1; });
  assert.deepEqual(history.turns[0].supplements, ['']); assert.equal(history.turns[0].supplementInputs[0].message, ''); assert.equal(history.turns[0].supplementInputs[0].attachments[0].resourceId, 'owned-image');
  assert.equal(history.turns[0].error, null); assert.equal(writes, 1); assert.equal(history.turns[0].reply, 'Updated draft using the attached image.');
  assert.equal(modelCalls, 4); assert(closed.has('http-steer-turn'));
  await request('/history?canvasId=canvas'); assert.equal(modelCalls, 4); assert.equal(writes, 1);
  console.log(JSON.stringify({ passed: true, modelCalls, writes, attachmentOnly: true, durable: true }));
} finally {
  if (child && child.exitCode === null) { const done = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await Promise.race([done, delay(3000)]); if (child.exitCode === null) child.kill('SIGKILL'); await done; }
  ops.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => ops.close(resolve)), new Promise(resolve => provider.close(resolve))]); fs.rmSync(directory, { recursive: true, force: true });
}
