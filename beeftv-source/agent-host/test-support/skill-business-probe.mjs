// Real server.mjs + real Go HTTP/SQLite supplied by a Go integration test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let child, log = '', modelCalls = 0;
const readBody = async (req) => { let raw = ''; for await (const chunk of req) raw += chunk; return JSON.parse(raw || '{}'); };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
function send(res, model, tool, args = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  frame(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + tool + '-' + modelCalls, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: config.script ? '缺少脚本执行能力，声音审片尚未执行。' : '已根据所选技能辅助文件创建草稿。' });
  frame({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
}
const provider = createServer(async (req, res) => {
  try {
    const request = await readBody(req); modelCalls++;
    const content = m => typeof m.content === 'string' ? m.content : (m.content || []).map(part => part.text || '').join('');
    const system = request.messages.filter(m => m.role === 'system' || m.role === 'developer').map(content).join('\n');
    const user = request.messages.filter(m => m.role === 'user').map(content).join('\n');
    const latest=request.messages.filter(m=>m.role==='user').at(-1);
    if(content(latest).includes('FRESH_TASK')) {
      assert(!JSON.stringify(request.messages).includes(config.instruction),'official reset leaked old instructions');
      return send(res,request.model);
    }
    // The transcript records explicit selection; active rules are reconstructed
    // from the real Go database in the official section on every request.
    const block = new RegExp(`<skill name="[^"]+" version="[^"]*" skillId="${config.pin.skillId}" versionId="${config.pin.versionId}" contentHash="${config.pin.contentHash}">[\\s\\S]*${config.instruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n</skill>`);
    assert(block.test(user), 'selected fixed Skill block absent from the real user message');
    assert(system.includes(config.instruction) && system.includes('<beeftv_active_skills>'), 'active rules absent from official section');
    assert(system.includes('<available_skills>') && system.includes(`<id>${config.pin.skillId}</id>`), 'installed catalog absent from system prompt');
    assert(!JSON.stringify(request.messages).includes('Removed system prompt section'));
    if(content(latest).includes('CONTINUE_ACTIVE') || content(latest).includes('RESELECT_SAME')) return send(res,request.model);
    const results = request.messages.filter(m => m.role === 'tool');
    if (!results.length) return send(res, request.model, 'skill_file', { ...config.pin, path: config.path });
    assert(results[0].content.includes(config.reference), 'auxiliary file missing from tool result');
    if (config.script) {
      assert(user.includes('script_execution'));
      return send(res, request.model);
    }
    if (results.length === 1) return send(res, request.model, 'canvas_nodes_create', {
      expectedRevision: 1, nodes: config.titles.map(title => ({ type: 'video', title, prompt: config.reference }))
    });
    assert(JSON.parse(results[1].content).result?.created?.length === config.titles.length, 'draft tool failed: ' + results[1].content);
    send(res, request.model);
  } catch (error) { log += String(error.stack); res.writeHead(500); res.end(String(error)); }
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
  await api('/chat', { canvasId: config.canvasId, turnId: config.turnId, message: config.instruction, revisionBefore: 1, skills: [config.pin] });
  let history;
  await until(async () => { history = await (await api('/history?canvasId=' + config.canvasId)).json(); return history.turns?.length === 1; });
  assert.equal(history.turns[0].error, null, JSON.stringify(history));
  assert.equal((await backend('/assistant/runtime/turns/' + config.turnId)).value.data.open, false);
  const initialCalls=config.script?2:3;assert.equal(modelCalls,initialCalls);
  if (config.script) assert(JSON.stringify(history).includes('尚未执行'), 'unsupported script must not claim completion');
  const firstPid=child.pid;await kill('SIGKILL');await start();assert.notEqual(child.pid,firstPid);
  async function extra(turnId,message,skills=[]) {
    const response=await api('/chat',{canvasId:config.canvasId,turnId,message,revisionBefore:1,skills});
    assert.equal(response.status,200,await response.text());
    await until(async()=>{history=await(await api('/history?canvasId='+config.canvasId)).json();return history.turns?.some(turn=>turn.turnId===turnId);});
    assert.equal(history.turns.find(turn=>turn.turnId===turnId).error,null,JSON.stringify(history));
  }
  await extra(config.continueTurnId,'CONTINUE_ACTIVE');
  await extra(config.reselectTurnId,'RESELECT_SAME',[config.pin]);
  const state=await(await api('/skill-context?canvasId='+config.canvasId)).json();
  assert.equal(state.activePins[0].versionId,config.pin.versionId);
  const reset=await api('/skill-context',{canvasId:config.canvasId,action:'new_scope',expectedRevision:state.revision,requestId:'independent'});
  assert.equal(reset.status,200,await reset.text());
  await extra(config.freshTurnId,'FRESH_TASK');assert.equal(modelCalls,initialCalls+3);
  assert.equal(history.turns.length,4,'official reset must preserve UI turn history');
  fs.writeFileSync(path.join(config.directory, 'host-result.json'), JSON.stringify({ modelCalls, history, passed: true,hardkill:{firstPid,resumedPid:child.pid} }));
} finally { await kill('SIGTERM'); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); }
