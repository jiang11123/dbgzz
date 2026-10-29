// Real Node host + official pi SDK; all providers/operations are scripted loopback.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serveEmptySkillContext } from './skill-context-fixture.mjs';

const root = path.resolve(process.argv[2] || '.');
const destination = process.argv[3];
const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv media steer '));
const hostAuth = 'synthetic-host-credential-not-real';
const model = 'gemini-synthetic-flash';
const requests = [], seen = [], results = [], httpObservations = [];
const turnCanvas = new Map();
let mode = 'steer', count = 0, releaseOld, child, hostLog = '', base;
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
async function readJSON(req) { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body || '{}'); }
async function until(check) { const deadline = Date.now() + 12000; while (!check()) { if (Date.now() > deadline) throw Error('condition timed out'); await delay(20); } }
function sse(res, message, tool) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = data => res.write('data: ' + JSON.stringify({ id: 'synthetic-' + count, object: 'chat.completion.chunk', created: 1, model, ...data }) + '\n\n');
  send({ choices: [{ index: 0, delta: { role: 'assistant', content: tool ? '' : message,
    ...(tool ? { tool_calls: [{ index: 0, id: 'call-' + count, type: 'function', function: tool }] } : {}) }, finish_reason: null }] });
  send({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.end('data: [DONE]\n\n');
}
const tool = (name, args) => ({ name, arguments: JSON.stringify(args) });
const provider = createServer(async (req, res) => {
  try {
    const body = await readJSON(req); count++; requests.push(body);
    const number = requests.length;
    if (mode === 'steer' && number === 1) {
      await new Promise(resolve => { releaseOld = resolve; });
      return sse(res, '', tool('canvas_node_update', { nodeId: 'n1', title: 'Old unwanted title' }));
    }
    if ((mode === 'media' || mode === 'bad-hash') && number === 1) return sse(res, '', tool('media_overview', { nodeId: 'n1' }));
    if (mode === 'media' && number === 2) return sse(res, '', tool('media_inspect', { nodeId: 'n1', mode: 'audio', start: 0, end: 0.25 }));
    if (mode === 'video' && number === 1) return sse(res, '', tool('media_inspect', { nodeId: 'n1', mode: 'video', start: 0, end: 0.25 }));
    return sse(res, 'Synthetic final reply follows the new instruction.');
  } catch (error) { res.writeHead(500).end(String(error)); }
});
const params = { type: 'object', properties: { nodeId: { type: 'string' }, title: { type: 'string' }, mode: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, required: ['nodeId'] };
const descriptors = [
  { id: 'canvas.node.update', assistantModes: ['canvas', 'full-access'], replay: 'safe', readOnly: false, scope: 'canvas', summary: 'Update node', params },
  ...['media.overview', 'media.inspect'].map(id => ({ id, assistantModes: ['canvas', 'full-access', 'read-only'], replay: 'safe', readOnly: true, scope: 'canvas', summary: id, params })),
];
let jpeg, wav, video;
function part(bytes, mimeType, type, bad = false) {
  return { type, mimeType, data: bytes.toString('base64'), sha256: bad ? '0'.repeat(64) : crypto.createHash('sha256').update(bytes).digest('hex'), source: { resourceId: 'n1', version: 'synthetic-v1', start: 0, end: 0.25 } };
}
const ops = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers['x-beeftv-agent-token'] !== hostAuth) return res.writeHead(403).end('{}');
  if(serveEmptySkillContext(req,res))return;
  if (req.method === 'GET' && req.url === '/api/ops') return res.end(JSON.stringify({ code: 0, data: { ops: descriptors } }));
  if (req.url.startsWith('/api/assistant/runtime/turns/')) {
    const turnId = decodeURIComponent(req.url.split('/')[5] || '');
    return res.end(JSON.stringify({ code: 0, data: { turnId, canvasId: turnCanvas.get(turnId) || 'canvas', permissionMode: 'canvas', open: true } }));
  }
  const body = await readJSON(req); seen.push({ path: req.url, body, turn: req.headers['x-beeftv-agent-turn'] });
  const result = req.url.endsWith('media.overview') ? { content: [part(jpeg, 'image/jpeg', 'image', mode === 'bad-hash')] }
    : req.url.endsWith('media.inspect') ? { content: [mode === 'video' ? part(video, 'video/mp4', 'media') : part(wav, 'audio/wav', 'media')] } : { nodeId: 'n1', revision: 2 };
  res.end(JSON.stringify({ code: 0, data: { op: req.url.split('/').at(-1), replayed: false, result } }));
});
async function request(route, body) {
  if (body && body.turnId && body.canvasId) turnCanvas.set(body.turnId, body.canvasId);
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'X-Beeftv-Agent-Token': hostAuth },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  const text = await response.text();
  let events = []; try { events = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch {}
  return { status: response.status, events, text };
}
async function scenario(name, fn) {
  try {
    await fn(); results.push({ name, passed: true }); console.log('PASS', name);
    httpObservations.push({ scenario: name, requests: requests.map(body => ({ model: body.model, messages: (body.messages || []).map(message => ({
      role: message.role, toolCallId: message.tool_call_id, toolNames: message.tool_calls?.map(call => call.function.name),
      media: nativeURLs({ messages: [message] }).map(url => ({ mimeType: url.slice(5, url.indexOf(';')),
        sha256: crypto.createHash('sha256').update(Buffer.from(url.split(',')[1], 'base64')).digest('hex') })),
    })) })) });
  }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message); }
}
const nativeURLs = body => (body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content.flatMap(p =>
  p.type === 'image_url' ? [p.image_url.url] :
  p.type === 'input_audio' ? [`data:audio/${p.input_audio.format};base64,${p.input_audio.data}`] : []) : []);
try {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x48', '-frames:v', '1', path.join(scratch, 'frame.jpg')]);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=0.25', '-ac', '1', '-c:a', 'pcm_s16le', path.join(scratch, 'clip.wav')]);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x48:r=24:d=0.25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(scratch, 'clip.mp4')]);
  jpeg = readFileSync(path.join(scratch, 'frame.jpg')); wav = readFileSync(path.join(scratch, 'clip.wav'));
  video = readFileSync(path.join(scratch, 'clip.mp4')); assert.equal(video.subarray(4, 8).toString(), 'ftyp');
  assert.equal(jpeg.subarray(0, 2).toString('hex'), 'ffd8'); assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  const modelPort = await listen(provider), opsPort = await listen(ops);
  const reservation = createServer(), hostPort = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
  base = `http://127.0.0.1:${hostPort}`;
  child = spawn(process.execPath, [path.join(root, 'agent-host/server.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, BEEFTV_AGENT_DATA_DIR: scratch, BEEFTV_AGENT_PORT: String(hostPort), BEEFTV_OPS_URL: `http://127.0.0.1:${opsPort}/api`,
    BEEFTV_AGENT_HOST_TOKEN: hostAuth, BEEFTV_AGENT_API_KEY: 'synthetic-only', BEEFTV_AGENT_MODEL: model, BEEFTV_AGENT_API: 'openai-completions',
    BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, BEEFTV_AGENT_MAX_REQUESTS_PER_TURN: '12', BEEFTV_AGENT_MAX_TOOL_STEPS_PER_TURN: '12',
  } });
  child.stdout.on('data', data => { hostLog += data; }); child.stderr.on('data', data => { hostLog += data; });
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} if (child.exitCode !== null) throw Error(hostLog); await delay(100); }
  await scenario('official-steer-blocks-stale-write-and-persists-supplement', async () => {
    const session = JSON.parse((await request('/sessions', { canvasId: 'steer-canvas' })).text).sessionId;
    assert(session);
    const pending = request('/chat', { canvasId: 'steer-canvas', sessionId: session, message: 'Update this node.', turnId: 'steer01', revisionBefore: 1 });
    await until(() => Boolean(releaseOld));
    const wrong = await request('/steer', { canvasId: 'steer-canvas', sessionId: 'wrong-session', message: 'Wrong' });
    assert.equal(wrong.status, 409); assert.match(wrong.text, /session_not_current/);
    const accepted = await request('/steer', { canvasId: 'steer-canvas', sessionId: session, message: 'Do not change the node. Only explain the result.' });
    assert.equal(accepted.status, 202, accepted.text); assert.equal(JSON.parse(accepted.text).accepted, true);
    releaseOld(); const reply = await pending; const end = reply.events.find(e => e.type === 'turn_end');
    assert(end && !end.error, reply.text); assert.match(end.reply, /new instruction/);
    assert.equal(seen.filter(item => item.path.endsWith('canvas.node.update')).length, 0, 'stale write must never dispatch');
    assert.equal(requests.length, 2);
    assert(requests[1].messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Only explain the result.')));
    assert.deepEqual(end.supplements, ['Do not change the node. Only explain the result.']);
    const history = JSON.parse((await request('/history?canvasId=steer-canvas&sessionId=' + session)).text);
    assert.deepEqual(history.turns[0].supplements, end.supplements); assert.equal(history.turns[0].reply, end.reply);
    const persistedMessages = readdirSync(scratch, { recursive: true }).filter(file => file.endsWith('.jsonl'))
      .flatMap(file => readFileSync(path.join(scratch, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    assert(persistedMessages.some(entry => entry.type === 'message' && entry.message?.role === 'user' &&
      JSON.stringify(entry.message.content).includes('Only explain the result.')), 'official pi session must persist the supplementary user message');
    const ended = await request('/steer', { canvasId: 'steer-canvas', sessionId: session, message: 'Late' }); assert.equal(ended.status, 409);
  });
  mode = 'media'; requests.length = 0;
  await scenario('official-sdk-dispatches-real-jpeg-and-wav-in-history-order', async () => {
    const reply = await request('/chat', { canvasId: 'media-canvas', message: 'Inspect this video.', turnId: 'media01', revisionBefore: 1 });
    const end = reply.events.find(e => e.type === 'turn_end'); assert(end && !end.error, reply.text); assert.equal(requests.length, 3);
    const jpegURL = 'data:image/jpeg;base64,' + jpeg.toString('base64'), wavURL = 'data:audio/wav;base64,' + wav.toString('base64');
    assert(nativeURLs(requests[1]).includes(jpegURL), 'real JPEG must enter actual SDK HTTP');
    assert(nativeURLs(requests[2]).includes(wavURL), 'real WAV must enter actual SDK HTTP');
    assert.deepEqual(requests[2].messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
      .filter(p => p.type === 'input_audio'), [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }]);
    assert(!requests[2].messages.some(m => Array.isArray(m.content) &&
      m.content.some(p => p.type === 'image_url' && p.image_url.url.startsWith('data:audio/'))));
    const messages = requests[2].messages;
    const overviewResult = messages.findIndex(m => m.role === 'tool' && /media_overview/.test(messages.find(a => a.tool_calls?.some(c => c.id === m.tool_call_id))?.tool_calls?.[0]?.function?.name || ''));
    const jpegIndex = messages.findIndex(m => nativeURLs({ messages: [m] }).includes(jpegURL));
    const inspectCall = messages.findIndex(m => m.tool_calls?.some(c => c.function.name === 'media_inspect'));
    const inspectResult = messages.findIndex(m => m.role === 'tool' && m.tool_call_id === messages[inspectCall]?.tool_calls?.[0]?.id);
    const wavIndex = messages.findIndex(m => nativeURLs({ messages: [m] }).includes(wavURL));
    assert(overviewResult < jpegIndex && jpegIndex < inspectCall && inspectCall < inspectResult && inspectResult < wavIndex, JSON.stringify(messages.map(m => ({ role: m.role, call: m.tool_call_id }))));
  });
  mode = 'video'; requests.length = 0;
  await scenario('official-sdk-dispatches-real-mp4-after-its-tool-result', async () => {
    const reply = await request('/chat', { canvasId: 'video-canvas', message: 'Inspect this video.', turnId: 'video01', revisionBefore: 1 });
    const end = reply.events.find(event => event.type === 'turn_end'); assert(end && !end.error, reply.text);
    assert.equal(requests.length, 2);
    const url = 'data:video/mp4;base64,' + video.toString('base64');
    assert.deepEqual(nativeURLs(requests[1]), [url]);
    const messages = requests[1].messages;
    const resultIndex = messages.findIndex(message => message.role === 'tool');
    const mediaIndex = messages.findIndex(message => nativeURLs({ messages: [message] }).includes(url));
    assert(resultIndex >= 0 && mediaIndex > resultIndex);
    assert(nativeURLs(requests[1]).every(value => value.startsWith('data:video/mp4;base64,') && !value.includes(scratch)), 'local paths must never be delivered as video URLs');
    assert(!JSON.stringify(messages).includes('geminiInlinePart') && !JSON.stringify(messages).includes('fileData'));
  });
  mode = 'bad-hash'; requests.length = 0;
  await scenario('corrupt-media-never-enters-provider-http', async () => {
    const reply = await request('/chat', { canvasId: 'bad-media-canvas', message: 'Inspect this video.', turnId: 'media02', revisionBefore: 1 });
    const end = reply.events.find(e => e.type === 'turn_end'); assert(end && !end.error, reply.text);
    assert.equal(requests.length, 2); assert(requests.every(body => nativeURLs(body).length === 0));
    assert.match(JSON.stringify(requests[1].messages), /media_content_changed/);
    assert(end.toolCalls.some(call => call.isError), 'tool failure must remain visible in journal');
  });
} catch (error) { results.push({ name: 'probe-runtime', passed: false, error: error.message }); console.error(error); }
finally {
  releaseOld?.();
  if (child && child.exitCode === null) { const ended = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await Promise.race([ended, delay(3000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  for (const server of [ops, provider]) if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (destination) writeFileSync(destination, JSON.stringify({ kind: 'real-node-official-pi-scripted-loopback-no-paid-calls', results, modelRequests: count, httpObservations, opsCalls: seen.map(item => ({ path: item.path, turn: item.turn })), hostLog: hostLog.slice(-5000) }, null, 2));
  rmSync(scratch, { recursive: true, force: true });
}
if (results.some(result => !result.passed)) process.exitCode = 1;
