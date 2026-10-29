// Real server.mjs + real Go HTTP/SQLite supplied by a Go integration test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let child, log = '', modelCalls = 0, mainCalls = 0, continuationCalls = 0, continuing = false, releaseContinuation; const summarizations = [];
const readBody = async (req) => { let raw = ''; for await (const chunk of req) raw += chunk; return JSON.parse(raw || '{}'); };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
function send(res, model, tool, args = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  frame(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + tool + '-' + modelCalls, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: args.finalText || '已读取实际参考图片、15秒音频和15秒视频。' });
  frame({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
}
const captured = []; let expected;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function nativeParts(request) {
  return request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .flatMap(part => {
      if (part.type === 'input_audio') {
        assert.equal(part.input_audio?.format, 'wav');
        assert.deepEqual(Object.keys(part.input_audio).sort(), ['data', 'format']);
        return [{ mime: 'audio/wav', wireType: part.type, bytes: Buffer.from(part.input_audio.data, 'base64') }];
      }
      if (part.type !== 'image_url' || !part.image_url?.url?.startsWith('data:')) return [];
      const match = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url); assert(match);
      assert(!match[1].startsWith('audio/'), 'audio must use input_audio, never image_url');
      return [{ mime: match[1], wireType: part.type, bytes: Buffer.from(match[2], 'base64') }];
    });
}
function assertPart(parts, mime, expectedPart) {
  const part = parts.find(part => part.mime === mime && sha(part.bytes) === expectedPart.sha256);
  assert(part, 'missing or changed actual dispatch '+mime+' expected='+expectedPart.sha256+' actual='+JSON.stringify(parts.map(p=>({mime:p.mime,bytes:p.bytes.length,sha256:sha(p.bytes)}))));
  assert.equal(part.bytes.toString('base64'), expectedPart.data, 'dispatch differs from real Go media bytes');
  captured.push({ mime, wireType: part.wireType, sha256: sha(part.bytes), bytes: part.bytes.length });
}
const provider = createServer(async (req, res) => {
  try {
    const request = await readBody(req); modelCalls++;
    const summaryPrompt = request.messages.filter(m=>m.role==='system').map(m=>String(m.content)).join('\n');
    if (summaryPrompt.includes('context summarization assistant')) {
      const event={modelCall:modelCalls,systemPromptPrefix:summaryPrompt.slice(0,100),nativeParts:nativeParts(request).length,
        toolMessages:request.messages.filter(m=>m.role==='tool').length};summarizations.push(event);
      process.stderr.write('OFFICIAL_COMPACTION '+JSON.stringify(event)+'\n');
      return send(res,request.model,null,{finalText:'## Goal\nRead the user reference media using the media tools.\n## Progress\n### In Progress\n- Continue from the most recent media tool result; inspect actual media before claiming understanding.\n## Next Steps\n1. Inspect audio/video content and finish the analysis.'});
    }
    mainCalls++;
    const parts = nativeParts(request);
    if (continuing) {
      continuationCalls++;
      assertPart(parts, 'audio/wav', expected.audio);
      assertPart(parts, 'video/mp4', expected.video);
      if (continuationCalls === 1) await new Promise(resolve => { releaseContinuation = resolve; });
      else {
        assert.equal(continuationCalls, 2);
        assert(request.messages.some(message => message.role === 'user' &&
          JSON.stringify(message.content).includes('BEEFTV_INPUT:audio-supplement')));
      }
      return send(res, request.model, null, { finalText: '同一会话历史音频保留，补充要求已收到。' });
    }
    if (mainCalls === 1) assertPart(parts, 'image/jpeg', expected.image);
    const toolResults = request.messages.filter(message => message.role === 'tool');
    const stage = mainCalls;
    const latest = toolResults.at(-1);
    const source = latest ? JSON.parse(latest.content.split('\n')[0]).result?.source : null;
    const version = source?.version;
    if (stage === 1) return send(res, request.model, 'media_overview', { assetId: config.audio.assetId });
    if (stage === 2) {
      assert.equal(source.resourceId,config.audio.resourceId);
      assert.equal(version, expected.audio.source.version);
      return send(res, request.model, 'media_inspect', { assetId: config.audio.assetId, expectedVersion: version, mode: 'audio', startMs: 0, endMs: 15000 });
    }
    if (stage === 3) assertPart(parts, 'audio/wav', expected.audio);
    if (stage === 3) return send(res, request.model, 'media_overview', { assetId: config.video.assetId });
    if (stage === 4) {
      assert.equal(source.resourceId,config.video.resourceId);
      assert.equal(version, expected.video.source.version);
      return send(res, request.model, 'media_inspect', { assetId: config.video.assetId, expectedVersion: version, mode: 'video', startMs: 0, endMs: 15000 });
    }
    assert.equal(stage, 5); assertPart(parts, 'video/mp4', expected.video);
    if(config.failAfterMedia) assertPart(parts,'audio/wav',expected.audio);
    send(res, request.model);
  } catch (error) { log += String(error.stack); process.stderr.write('Provider assertion at request '+modelCalls+': '+String(error.stack)+'\n'); res.writeHead(400); res.end(String(error)); }
});
let base;
const headers = { 'content-type': 'application/json', 'X-Beeftv-Agent-Token': config.hostToken };
const api = async (route, body) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers,
  body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
async function backend(route, body) {
  const response = await fetch(config.backend + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'X-Beeftv-Agent-Turn': config.turnId },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  return { status: response.status, value: await response.json() };
}
async function until(check) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) { if (await check()) return; if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('host exited: ' + log); await delay(50); }
  throw new Error('probe timeout: ' + log);
}
async function kill(signal) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((resolve) => child.once('close', resolve)); child.kill(signal);
  await Promise.race([done, delay(3000)]); if (child.exitCode === null) child.kill('SIGKILL'); await done;
}
try {
  async function inspect(reference, mode) {
    const params = {canvasId:config.canvasId,assetId:reference.assetId,resourceId:reference.resourceId};
    const overview = await backend('/ops/media.overview',{params}); assert.equal(overview.status,200,JSON.stringify(overview.value));
    const source = overview.value.data.result.source;
    const checked = await backend('/ops/media.inspect',{params:{...params,expectedVersion:source.version,mode,
      ...(mode === 'frames' ? {} : {startMs:0,endMs:15000})}});
    assert.equal(checked.status,200,JSON.stringify(checked.value));
    return checked.value.data.result.content.find(part=>part.type===(mode==='frames'?'image':'media'));
  }
  expected={image:await inspect(config.image,'frames'),audio:await inspect(config.audio,'audio'),video:await inspect(config.video,'video')};
  for (const part of [expected.audio,expected.video]) {
    assert(Buffer.from(part.data,'base64').length>50*1024,'fixture must exceed official default output limit');
    assert.equal(sha(Buffer.from(part.data,'base64')),part.sha256);
  }
  const modelPort = await listen(provider);
  const reservation = createServer(); const port = await listen(reservation); await new Promise((resolve) => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, BEEFTV_AGENT_DATA_DIR: config.directory,
    BEEFTV_AGENT_PORT: String(port), BEEFTV_AGENT_HOST_TOKEN: config.hostToken, BEEFTV_OPS_URL: config.backend,
    BEEFTV_AGENT_API_KEY: 'fixture-only', BEEFTV_AGENT_API: 'openai-completions', BEEFTV_AGENT_MODEL: 'gemini-native-fixture',
    BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, BEEFTV_AGENT_TOTAL_REQUEST_BUDGET: config.failAfterMedia ? '4' : '0' };
  delete env.BEEFTV_AGENT_CONTEXT_WINDOW; // Base64 must not force compaction at the shipped 200k limit.
  async function start() {
    child = spawn(process.execPath, [path.join(config.root, 'agent-host/server.mjs')], { cwd: config.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { log += chunk; }); child.stderr.on('data', (chunk) => { log += chunk; });
    await until(async () => { try { return (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } });
  }
  await start();
  await api('/chat', { canvasId: config.canvasId, turnId: config.turnId, message: '检查参考音视频的实际内容', revisionBefore: 1, attachments: [config.image,config.audio,config.video] });
  let history;
  await until(async () => { history = await (await api('/history?canvasId=' + config.canvasId)).json(); return history.turns?.length === 1; });
  if(config.failAfterMedia) {
    assert.equal(history.turns[0].errorReason,'request_budget_exhausted');
    assert.equal(history.turns[0].status,'unanswered');
    assert.equal(history.turns[0].cancelled,false);
  } else assert.equal(history.turns[0].error, null, JSON.stringify(history));
  assert.equal((await backend('/assistant/runtime/turns/' + config.turnId)).value.data.open, false);
  assert.equal(mainCalls,config.failAfterMedia ? 4 : 5); assert.match(history.sessionId,/^durable:/);
  const successfulReads = history.turns[0].toolCalls.filter(call => call.tool === 'media.inspect');
  assert.equal(successfulReads.length,2);
  const recordedFacts = successfulReads.map(call => call.mediaFacts);
  assert.deepEqual(recordedFacts.map(fact => [fact.mode,fact.source.startMs,fact.source.endMs]),[['audio',0,15000],['video',0,15000]]);
  assert.equal(recordedFacts[0].source.resourceId,config.audio.resourceId);
  assert.equal(recordedFacts[1].source.resourceId,config.video.resourceId);
  assert(!JSON.stringify(recordedFacts).includes('data:'));
  assert.equal(summarizations.length,0,'bounded native media must not become text-token overflow: '+JSON.stringify(summarizations));
  assert(captured.some(part=>part.mime==='audio/wav'));
  if(config.failAfterMedia) {
    // Actual host process restart, same official SQLite and native-parts files.
    // Increasing the model budget must not discard successful prior tool reads.
    await kill('SIGTERM'); env.BEEFTV_AGENT_TOTAL_REQUEST_BUDGET='0'; await start();
    const restored = await (await api('/history?canvasId='+config.canvasId)).json();
    assert.deepEqual(restored.turns[0].toolCalls.filter(call=>call.tool==='media.inspect').map(call=>call.mediaFacts),recordedFacts);
  }
  continuing = true;
  await api('/chat',{canvasId:config.canvasId,sessionId:history.sessionId,turnId:config.nextTurnId,message:'在当前画布权限继续讨论已有素材',revisionBefore:1});
  await until(() => releaseContinuation);
  const steer = await api('/steer', {canvasId:config.canvasId,sessionId:history.sessionId,
    requestId:'audio-supplement',message:'请保留声音中的提示音顺序。',attachments:[config.audio]});
  assert.equal(steer.status,202,await steer.text());
  releaseContinuation();
  await until(async()=>{history=await(await api('/history?canvasId='+config.canvasId)).json();return history.turns?.length===2});
  assert.equal(history.turns[1].permissionMode,'canvas');assert.equal(history.turns[1].error,null,JSON.stringify(history));assert.equal(mainCalls,config.failAfterMedia ? 6 : 7);
  assert.equal(continuationCalls,2);
  assert.equal(history.turns[1].supplementInputs[0].attachments[0].resourceId,config.audio.resourceId);
  assert(captured.some(part=>part.mime==='video/mp4'));
  assert.equal((await backend('/__fixture/invalidate-audio',{})).status,200);
  await api('/chat',{canvasId:config.canvasId,sessionId:history.sessionId,turnId:config.invalidTurnId,message:'继续',revisionBefore:1});
  await until(async()=>{history=await(await api('/history?canvasId='+config.canvasId)).json();return history.turns?.length===3});
  assert.match(history.turns[2].error,/历史音频.*重新添加/);assert.doesNotMatch(history.turns[2].error,/Connection error/);assert.equal(mainCalls,config.failAfterMedia ? 6 : 7,'SDK deterministic history failure must not dispatch or retry provider');
  const ledger=fs.readFileSync(path.join(config.directory,'agent-requests.jsonl'),'utf8').trim().split('\n');assert.equal(ledger.length,config.failAfterMedia ? 6 : 7);
  fs.writeFileSync(path.join(config.directory, 'host-result.json'), JSON.stringify({ modelCalls, mainCalls, continuationCalls, audioSteer:true, summarizations, sessionId:history.sessionId, captured,historyError:history.turns[2].error,noFailureDispatch:true, passed:true }));
} finally { releaseContinuation?.(); await kill('SIGTERM'); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); }
