// Skills follow the conversation transcript, and the root agent's reasoning
// level reaches the provider request. Local fake model only; no paid calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as CTX } from '@earendil-works/chord/context';
import { CompactionTask, defineExtension, hook } from '@earendil-works/pi-durable';
import { agentThinkingLevel, createDurableSessionStore } from './durable-session-owner.mjs';
import { fixtureSkillContext } from './test-support/skill-context-fixture.mjs';
import { createOperationBridge } from './operation-bridge.mjs';

const hash = (c) => c.repeat(64);
const batches = { skillId: 'batches', versionId: 'v1', contentHash: hash('a') };
const landscape = { skillId: 'landscape', versionId: 'v1', contentHash: hash('b') };
const catalogOnly = { skillId: 'catalog-only', versionId: 'v3', contentHash: hash('c') };
const bodies = {
  batches: { name: '短剧资产分批', description: '先出角色，再出场景', instruction: '第一步：只做 4 张竖版角色图，做完停下等确认。第二步：场景图。' },
  landscape: { name: '横版改写', description: '改为横版', instruction: '所有画面改为 16:9 横版。' },
  'catalog-only': { name: '采访切片', description: '保留采访原话', instruction: '按原话切出三个镜头。' },
};
const resourceFor = (pin) => ({ pin, ...bodies[pin.skillId], version: pin.versionId.slice(1), files: [], unsupportedCapabilities: [] });

async function skillFixture(directory, { thinkingLevel, script = () => null, gate = async () => {}, authorizationGate=async()=>{}, versionGate=()=>{}, contextGate=async()=>{}, contextValidation=()=>{}, closedTurns=new Set(), lossy=false, catalogItems=[batches,catalogOnly] } = {}) {
  const payloads = [], reads = [], catalogs = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); payloads.push(body);
    await gate(body, payloads.length);
    const tool = script(body, payloads.length);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (tool) frame({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${payloads.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
    else frame({ role: 'assistant', content: `reply ${payloads.length}` });
    frame({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('beeftv', { api: 'openai-completions', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: 'thinker', name: 'thinker', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 16384,
      compat: { supportsReasoningEffort: true }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const models = createModels(); models.setProvider(runtime.getProvider('beeftv'));
  const contexts = fixtureSkillContext(directory);
  const store = createDurableSessionStore({ sessionRoot: path.join(directory, 'sessions'), workspaceRoot: path.join(directory, 'workspace'),
    getModels: () => models, getModelRef: () => ({ provider: 'beeftv', modelId: 'thinker' }), buildTools: () => [],
    authorizeTurn: async input => { await authorizationGate(input); return { open: true, canvasId: 'canvas', permissionMode: 'canvas' }; }, settings: { retry: { maxRetries: 0 },compaction:{enabled:false,keepRecentTokens:100,reserveTokens:2048,backgroundTokens:0} },
    extensions:()=>lossy?[defineExtension({name:'fixture.lossy-summary',hooks:[hook(CompactionTask,{beforeCompact:async()=>({summary:'Earlier planning is complete.'})})]})]:[],
    ...(thinkingLevel ? { thinkingLevel } : {}),
    skills: {
      ...contexts,
      readContext: async (entry, turnId) => { if (closedTurns.has(turnId)) throw Object.assign(Error('turn_not_found'), {reason:'turn_not_found'}); return contexts.readContext(entry); },
      changeContext: async (entry, change, turnId) => {
        if (closedTurns.has(turnId)) throw Object.assign(Error('turn_not_found'), {reason:'turn_not_found'});
        await contextValidation(change);
        const result = await contexts.changeContext(entry, change); await contextGate(change, result); return result;
      },
      readVersion: async (_entry, pin, _signal, turnId) => { reads.push({ pin, turnId }); return versionGate(pin) || resourceFor(pin); },
      readCatalog: async (_entry,_signal,_turnId,query={}) => { catalogs.push(query);const filtered=catalogItems.filter(pin=>!query.id || pin.skillId===query.id);return { skills: filtered.slice(0,50).map((pin) => ({ pin, name: bodies[pin.skillId]?.name || pin.skillId, description: bodies[pin.skillId]?.description || 'method' })),total:filtered.length }; },
    } });
  return { store, payloads, reads, catalogs, contexts,
    async close() { await store.disposeAll(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

const text = (message) => typeof message.content === 'string' ? message.content : (message.content || []).map((part) => part.text || '').join('');
const userText = (payload) => payload.messages.filter((m) => m.role === 'user').map(text).join('\n');
const systemText = (payload) => payload.messages.filter((m) => m.role === 'system' || m.role === 'developer').map(text).join('\n');
const count = (haystack, needle) => haystack.split(needle).length - 1;
const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `beeftv-skills-${name}-`));

test('active rules survive restart; fresh reselect re-reads while the same request retry stays idempotent', { timeout: 60000 }, async () => {
  const directory = temp('transcript');
  let fixture;
  try {
    fixture = await skillFixture(directory);
    const entry = await fixture.store.createSession('canvas');
    const first = await fixture.store.submit(entry, { turnId: 'turn-1', content: '按技能做角色图', userText: '按技能做角色图', skills: [{ ...batches, skillName: '短剧资产分批' }] });
    assert.equal((await fixture.store.wait(entry, first)).error, null);
    const one = fixture.payloads.at(-1);
    assert.match(userText(one), /<skill name="短剧资产分批" version="1" skillId="batches"/);
    assert.match(userText(one), /第一步：只做 4 张竖版角色图[\s\S]*<\/skill>\n\n按技能做角色图/);
    assert.match(systemText(one), /beeftv_active_skills[\s\S]*第一步/, 'official section carries active rules');
    assert.match(systemText(one), /<available_skills>[\s\S]*<id>catalog-only<\/id>/);
    assert(fixture.reads.length>=3,'selection, section and dispatch each validate the pin');
    const beforeRetry=fixture.reads.length;
    const retry=await fixture.store.submit(entry,{turnId:'turn-1',content:'按技能做角色图',userText:'按技能做角色图',skills:[batches]});
    assert.equal(retry.id,first.id);assert.equal(fixture.reads.length,beforeRetry);
    await assert.rejects(fixture.store.submit(entry,{turnId:'turn-1',content:'按技能做角色图',userText:'按技能做角色图',skills:[landscape]}),/submission_request_conflict/);

    const second = await fixture.store.submit(entry, { turnId: 'turn-2', content: 'A', userText: 'A' });
    assert.equal((await fixture.store.wait(entry, second)).error, null);
    const two = fixture.payloads.at(-1);
    const all = JSON.stringify(two.messages);
    assert(!all.includes('Removed system prompt section'), all);
    assert.equal(count(userText(two), '第一步：只做 4 张竖版角色图'), 1);
    assert.equal(systemText(two), systemText(one), 'system prompt must stay byte-stable between turns');
    assert(fixture.reads.length>beforeRetry,'continue revalidates active resources');

    const history = await fixture.store.history('canvas', entry.sessionId);
    assert.deepEqual(history.turns.map((turn) => turn.userText), ['按技能做角色图', 'A']);
    assert(!JSON.stringify(history).includes('<skill'), 'history must show only the user text');
    assert.equal(history.turns[0].skills[0].skillId, 'batches');
    const listed = await fixture.store.listCanvasSessions('canvas');
    assert.equal(listed[0].title, '按技能做角色图');

    await fixture.close();
    fixture = await skillFixture(directory);
    const restored = await fixture.store.ensureSession('canvas', entry.sessionId);
    const third = await fixture.store.submit(restored, { turnId: 'turn-3', content: '重新选了同一个技能', userText: '重新选了同一个技能', skills: [batches] });
    assert.equal((await fixture.store.wait(restored, third)).error, null);
    const three = fixture.payloads.at(-1);
    assert(fixture.reads.length>=3, 'reselect re-reads after restart');
    assert.equal(count(userText(three), '第一步：只做 4 张竖版角色图'), 2, 'fresh explicit request expands the pin again');
    assert(!JSON.stringify(three.messages).includes('Removed system prompt section'));
  } finally { await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a skill selected with a supplement joins the transcript once', { timeout: 60000 }, async () => {
  const directory = temp('supplement');
  let fixture, release, arrived;
  const held = new Promise((resolve) => { release = resolve; });
  const first = new Promise((resolve) => { arrived = resolve; });
  try {
    fixture = await skillFixture(directory, { gate: async (_body, index) => { if (index === 1) { arrived(); await held; } } });
    const entry = await fixture.store.createSession('canvas');
    const submission = await fixture.store.submit(entry, { turnId: 'turn-1', content: '做角色图', userText: '做角色图' });
    await first;
    await fixture.store.supplement(entry, { requestId: 'wide', content: '改成横版', input: { message: '改成横版', attachments: [], skills: [landscape] } });
    await assert.rejects(fixture.store.supplement(entry,{requestId:'wide',content:'改成横版',input:{message:'改成横版',skills:[batches]}}),/submission_request_conflict/);
    // A retried identical supplement is accepted without loading again.
    await fixture.store.supplement(entry, { requestId: 'wide', content: '改成横版', input: { message: '改成横版', attachments: [], skills: [landscape] } });
    release();
    const record = await fixture.store.wait(entry, submission);
    assert.equal(record.error, null);
    assert.deepEqual(record.supplements, ['改成横版']);
    const last = fixture.payloads.at(-1);
    assert.equal(count(userText(last), '所有画面改为 16:9 横版。'), 1);
    assert.match(userText(last), /<\/skill>\n\n改成横版/);
    assert(fixture.reads.length>=3);
    assert(!JSON.stringify(record).includes('<skill'));
  } finally { await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('recovering revalidates active resources but reuses the single stored expanded input', { timeout: 60000 }, async () => {
  const directory = temp('recover');
  let fixture, arrived;
  const first = new Promise((resolve) => { arrived = resolve; });
  try {
    fixture = await skillFixture(directory, { gate: async () => { arrived(); await new Promise(() => {}); } });
    const entry = await fixture.store.createSession('canvas');
    await fixture.store.submit(entry, { turnId: 'turn-1', content: '做角色图', userText: '做角色图', skills: [batches] });
    await first;
    assert(fixture.reads.length>=3);
    await fixture.close();
    fixture = await skillFixture(directory);
    const restored = await fixture.store.ensureSession('canvas', entry.sessionId);
    const submission = await fixture.store.recover(restored);
    const record = await fixture.store.wait(restored, submission);
    assert.equal(record.error, null, JSON.stringify(record));
    assert(fixture.reads.length>=1, 'recovery validates active package before dispatch');
    assert.equal(count(userText(fixture.payloads.at(-1)), '第一步：只做 4 张竖版角色图'), 1);
    assert.equal(record.userText, '做角色图');
  } finally { await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('skill_load loads an advertised skill into the transcript and records it', { timeout: 60000 }, async () => {
  const directory = temp('load');
  let fixture;
  const changes=[];
  try {
    fixture = await skillFixture(directory, { contextValidation:change=>changes.push(change), script: (body) => body.messages.some((m) => m.role === 'tool') ? null : { name: 'skill_load', args: { id: 'catalog-only' } } });
    const entry = await fixture.store.createSession('canvas');
    const first = await fixture.store.submit(entry, { turnId: 'turn-1', content: '帮我切采访', userText: '帮我切采访' });
    assert.equal((await fixture.store.wait(entry, first)).error, null);
    assert.equal(changes[0].origin,'skill_load','only the actual runtime tool marks a skill load');
    assert(fixture.payloads[0].tools.some((tool) => tool.function?.name === 'skill_load'));
    const result = fixture.payloads[1].messages.find((m) => m.role === 'tool');
    assert.match(text(result), /<skill name="采访切片" version="3" skillId="catalog-only"[\s\S]*按原话切出三个镜头。/);
    assert(fixture.reads.every(read=>read.pin.skillId==='catalog-only'));
    const readCount=fixture.reads.length;
    // A fresh explicit selection re-reads the same fixed version.
    const second = await fixture.store.submit(entry, { turnId: 'turn-2', content: '继续', userText: '继续', skills: [catalogOnly] });
    assert.equal((await fixture.store.wait(entry, second)).error, null);
    assert.equal(changes.at(-1).origin,undefined,'explicit user selection is not a runtime load');
    assert(fixture.reads.length>readCount);
    assert.equal(count(userText(fixture.payloads.at(-1)), '按原话切出三个镜头。'), 1);
  } finally { await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('lossy official compaction keeps active rules; clear retains history and new_scope resets only model-visible history', {timeout:60000},async()=>{
  const directory=temp('compaction');let fixture;
  try {
    fixture=await skillFixture(directory,{lossy:true,script:(_body,index)=>index===1?{name:'plan_update',args:{goal:'OLD_SCOPE_CASTLE',items:[{id:'old',title:'搭建城堡',status:'needs_user'}]}}:null});const entry=await fixture.store.createSession('canvas');
    const turn=async(id,content,selected=[])=>{
      const submission=await fixture.store.submit(entry,{turnId:id,content,userText:content,skills:selected});
      const record=await fixture.store.wait(entry,submission);assert.equal(record.error,null,JSON.stringify(record));
      return fixture.payloads.at(-1);
    };
    await turn('one','先做角色',[batches]);
    assert.equal((await fixture.store.history('canvas',entry.sessionId)).plan.goal,'OLD_SCOPE_CASTLE');
    await turn('two','padding '.repeat(800));await turn('three','more '.repeat(800));
    const task=await entry.root.compact(undefined,CTX);
    assert.equal((await entry.harness.waitForTask(task,CTX)).state.outcome.status,'completed');
    const after=await turn('four','继续');assert.match(systemText(after),/第一步：只做 4 张竖版角色图/);
    let current=await fixture.store.skillContext(entry);
    const cleared=await fixture.store.changeSkillContext(entry,{action:'clear',expectedRevision:current.revision,requestId:'clear'});
    assert.equal(cleared.activePins.length,0);assert.equal(cleared.scopeId,current.scopeId);
    // Explicitly reselect leaves an old instruction in transcript before clear.
    await turn('five','再次选择',[batches]);current=await fixture.store.skillContext(entry);
    await fixture.store.changeSkillContext(entry,{action:'clear',expectedRevision:current.revision,requestId:'clear-again'});
    const clearPayload=await turn('six','继续说');assert.match(JSON.stringify(clearPayload.messages),/第一步：只做 4 张竖版角色图/);
    current=await fixture.store.skillContext(entry);
    const request={action:'new_scope',expectedRevision:current.revision,requestId:'independent'};
    const fresh=await fixture.store.changeSkillContext(entry,request);
    assert.notEqual(fresh.scopeId,current.scopeId);assert.equal(fresh.lifecycle,'active');
    const clean=await turn('seven','独立任务只说你好');assert.doesNotMatch(JSON.stringify(clean.messages),/第一步：只做 4 张竖版角色图/);
    assert.doesNotMatch(systemText(clean),/OLD_SCOPE_CASTLE/);
    assert.equal((await fixture.store.history('canvas',entry.sessionId)).plan,undefined,'independent task has no previous plan');
    assert.equal((await fixture.store.history('canvas',entry.sessionId)).turns.length,7,'reset must preserve display history');
    // Replaying an old reset request must not cut the new task's later messages.
    await fixture.store.changeSkillContext(entry,request);
    const repeated=await turn('eight','延续刚才任务');assert.match(userText(repeated),/独立任务只说你好/);
  }finally{await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('Stop during skill loading leaves the previous active choice intact', {timeout:60000}, async()=>{
  const directory=temp('stop-loading');let fixture,release,arrived;
  const held=new Promise(resolve=>{release=resolve;});const reading=new Promise(resolve=>{arrived=resolve;});
  try {
    fixture=await skillFixture(directory,{versionGate:pin=>pin.skillId==='batches'?(arrived(),held.then(()=>resourceFor(pin))):undefined});
    const entry=await fixture.store.createSession('canvas');
    await fixture.store.changeSkillContext(entry,{action:'activate',pins:[landscape],expectedRevision:0,requestId:'previous'});
    const pending=fixture.store.submit(entry,{turnId:'stopped',requestId:'stopped',content:'用分批技能',skills:[batches]});
    await reading;await fixture.store.cancelRequest('canvas',entry.sessionId,'stopped');release();
    assert.equal(await pending,null);assert.equal(fixture.payloads.length,0);
    assert.deepEqual((await fixture.store.skillContext(entry)).activePins,[landscape]);
    const next=await fixture.store.submit(entry,{turnId:'next',content:'继续'});await fixture.store.wait(entry,next);
    assert.match(systemText(fixture.payloads.at(-1)),/16:9 横版/);
    assert.doesNotMatch(systemText(fixture.payloads.at(-1)),/第一步：只做 4 张竖版角色图/);
  } finally {release?.();await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

for (const mode of ['stop','restart','newer-choice']) test(`unsubmitted skill activation is compensated without losing history or newer choices: ${mode}`, {timeout:60000}, async()=>{
  const directory=temp(`stop-activation-${mode}`);let fixture,release,arrived;
  const held=new Promise(resolve=>{release=resolve;});const activated=new Promise(resolve=>{arrived=resolve;});
  try {
    fixture=await skillFixture(directory,{contextGate:async(change)=>{
      if(change.requestId!=='select:stopped')return;
      arrived();await held;
      if(mode==='restart')throw Error('simulated lost activation response');
    }});
    const entry=await fixture.store.createSession('canvas');
    await fixture.store.changeSkillContext(entry,{action:'activate',pins:[landscape],expectedRevision:0,requestId:'previous'});
    const pending=fixture.store.submit(entry,{turnId:'stopped',requestId:'stopped',content:'用分批技能',skills:[batches]});
    // Handle an expected simulated transport failure before releasing the gate.
    const outcome=pending.then(value=>({value}),error=>({error}));
    await activated;
    if(mode==='newer-choice'){
      const current=await fixture.contexts.readContext(entry);
      await fixture.contexts.changeContext(entry,{action:'activate',pins:[catalogOnly],expectedRevision:current.revision,requestId:'newer'});
    }
    await fixture.store.cancelRequest('canvas',entry.sessionId,'stopped');release();
    const result=await outcome;
    if(mode==='stop')assert.equal(result.value,null);
    else assert(result.error);
    // Recovery must also handle a crash between Go accepting the selection and
    // the host receiving its reply, with the Stop already persisted.
    await fixture.close();fixture=await skillFixture(directory);
    const restored=await fixture.store.ensureSession('canvas',entry.sessionId);
    await fixture.store.recover(restored);
    assert.equal(fixture.payloads.length,0);
    assert.deepEqual((await fixture.store.skillContext(restored)).activePins,mode==='newer-choice'?[catalogOnly]:[landscape]);
    const history=await fixture.store.history('canvas',entry.sessionId);
    assert.equal(history.turns.length,1);assert.equal(history.turns[0].cancelled,true);
    assert.equal(await fixture.store.submit(restored,{turnId:'stopped',requestId:'stopped',content:'用分批技能',skills:[batches]}),null);
  } finally {release?.();await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('Stop settles a rejected selection without activating it or losing the previous choice', {timeout:60000}, async()=>{
  const directory=temp('stop-rejected-selection');let fixture,release,arrived;
  const held=new Promise(resolve=>{release=resolve;});const validating=new Promise(resolve=>{arrived=resolve;});
  try {
    fixture=await skillFixture(directory,{contextValidation:async change=>{
      if(change.requestId!=='select:stopped')return;
      arrived();await held;
      throw Object.assign(Error('removed package'),{reason:'skill_context_pin_unavailable',details:{skillId:batches.skillId}});
    }});
    const entry=await fixture.store.createSession('canvas');
    await fixture.store.changeSkillContext(entry,{action:'activate',pins:[landscape],expectedRevision:0,requestId:'previous'});
    const outcome=fixture.store.submit(entry,{turnId:'stopped',requestId:'stopped',content:'用分批技能',skills:[batches]}).catch(error=>error);
    await validating;await fixture.store.cancelRequest('canvas',entry.sessionId,'stopped');release();
    assert.equal((await outcome).reason,'skill_context_pin_unavailable');
    await fixture.store.recover(entry);
    assert.deepEqual((await fixture.store.skillContext(entry)).activePins,[landscape]);
    const history=await fixture.store.history('canvas',entry.sessionId);
    assert.equal(history.active,null);assert.equal(history.turns.length,1);assert.equal(history.turns[0].cancelled,true);
    assert.equal(fixture.payloads.length,0);
  } finally {release?.();await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('failed official admit can stop after Go closed the turn and restore its previous selection', {timeout:60000}, async()=>{
  const directory=temp('stop-closed-turn');const closedTurns=new Set();let fixture,release,arrived;
  const held=new Promise(resolve=>{release=resolve;});const admitting=new Promise(resolve=>{arrived=resolve;});
  try {
    fixture=await skillFixture(directory,{closedTurns});
    const entry=await fixture.store.createSession('canvas');
    await fixture.store.changeSkillContext(entry,{action:'activate',pins:[landscape],expectedRevision:0,requestId:'previous'});
    entry.root.submit=async()=>{arrived();await held;throw Error('official admit rejected');};
    const outcome=fixture.store.submit(entry,{turnId:'stopped',requestId:'stopped',content:'用分批技能',skills:[batches]}).then(value=>({value}),error=>({error}));
    await admitting;
    assert.equal((await fixture.store.cancelRequest('canvas',entry.sessionId,'stopped')).state,'running');
    assert.equal(await fixture.store.fenceStop(entry,'stopped'),'stopped');
    closedTurns.add('stopped'); // The server's complete-before-stop order.
    release();assert.match((await outcome).error.message,/official admit rejected/);
    await fixture.store.stop(entry,'stopped');
    assert.deepEqual((await fixture.store.skillContext(entry)).activePins,[landscape]);
    const history=await fixture.store.history('canvas',entry.sessionId);
    assert.equal(history.active,null);assert.equal(history.turns.length,1);assert.equal(history.turns[0].cancelled,true);
    assert.equal(fixture.payloads.length,0);
    await fixture.store.recover(entry);
  } finally {release?.();await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

for (const mode of ['revoked','unavailable']) test(`Stop restores valid prior pins and retains unknown failures for recovery: ${mode}`, {timeout:60000}, async()=>{
  const directory=temp(`stop-prior-${mode}`);let fixture,release,arrived,invalid=false;
  const held=new Promise(resolve=>{release=resolve;});const activated=new Promise(resolve=>{arrived=resolve;});
  try {
    fixture=await skillFixture(directory,{
      contextGate:async change=>{if(change.requestId==='select:stopped'){arrived();await held;}},
      contextValidation:change=>{
        if(!invalid || change.requestId!=='undo-select:stopped' || !change.pins.some(pin=>pin.skillId===landscape.skillId))return;
        const reason=mode==='revoked'?'skill_context_pin_unavailable':'service_unavailable';
        throw Object.assign(Error(reason),{reason,details:{skillId:landscape.skillId}});
      },
    });
    const entry=await fixture.store.createSession('canvas');
    await fixture.store.changeSkillContext(entry,{action:'activate',pins:[landscape,catalogOnly],expectedRevision:0,requestId:'previous'});
    const outcome=fixture.store.submit(entry,{turnId:'stopped',requestId:'stopped',content:'用分批技能',skills:[batches]}).then(value=>({value}),error=>({error}));
    await activated;invalid=true;await fixture.store.cancelRequest('canvas',entry.sessionId,'stopped');release();
    const result=await outcome;
    if(mode==='unavailable'){
      assert.equal(result.error.reason,'service_unavailable');
      assert.deepEqual((await fixture.store.skillContext(entry)).activePins,[batches]);
      assert.equal((await fixture.store.history('canvas',entry.sessionId)).turns.length,0);
      invalid=false;await fixture.store.recover(entry);
    }else assert.equal(result.value,null);
    assert.deepEqual((await fixture.store.skillContext(entry)).activePins,mode==='revoked'?[catalogOnly]:[landscape,catalogOnly]);
    const history=await fixture.store.history('canvas',entry.sessionId);
    assert.equal(history.active,null);assert.equal(history.turns.length,1);assert.equal(history.turns[0].cancelled,true);
    assert.equal(fixture.payloads.length,0);
  } finally {release?.();await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('skill_load can resolve the exact installed id beyond the fifty-item prompt catalog', {timeout:60000},async()=>{
  const directory=temp('catalog-pages');let fixture;
  const late={skillId:'late-skill',versionId:'v1',contentHash:hash('d')};
  bodies['late-skill']={name:'第六十一个技能',description:'late method',instruction:'LATE_PIN_RULE'};
  try {
    const catalogItems=[...Array.from({length:60},(_,i)=>({skillId:`padding-${i}`,versionId:'v1',contentHash:hash('e')})),late];
    fixture=await skillFixture(directory,{catalogItems,script:body=>body.messages.some(m=>m.role==='tool')?null:{name:'skill_load',args:{id:late.skillId}}});
    const entry=await fixture.store.createSession('canvas');const submission=await fixture.store.submit(entry,{turnId:'one',content:'加载 late-skill'});
    assert.equal((await fixture.store.wait(entry,submission)).error,null);
    assert(fixture.catalogs.some(query=>query.id===late.skillId),'missing id must query Go before truncation');
    assert.match(systemText(fixture.payloads[0]),/共安装 61 个技能/);
    assert.match(JSON.stringify(fixture.payloads.at(-1).messages),/LATE_PIN_RULE/);
  }finally{await fixture?.close();delete bodies['late-skill'];fs.rmSync(directory,{recursive:true,force:true});}
});

test('missing or disabled active package fails before dispatch and clear still works', {timeout:60000},async()=>{
  for(const reason of ['skill_disabled','skill_missing','hash_mismatch']){
    const directory=temp('revoked');let fixture;let revoked=false;
    try{
      fixture=await skillFixture(directory,{versionGate:pin=>{if(!revoked)return;if(reason==='hash_mismatch')return {...resourceFor(pin),pin:{...pin,contentHash:hash('f')}};throw Object.assign(Error(reason),{reason});}});
      const entry=await fixture.store.createSession('canvas');
      let submission=await fixture.store.submit(entry,{turnId:'one',content:'先选技能',skills:[batches]});
      assert.equal((await fixture.store.wait(entry,submission)).error,null);const calls=fixture.payloads.length;
      revoked=true;submission=await fixture.store.submit(entry,{turnId:'two',content:'继续'});
      const failed=await fixture.store.wait(entry,submission);assert(failed.error);assert.equal(failed.errorReason,reason==='hash_mismatch'?'skill_version_unavailable':reason);assert.equal(fixture.payloads.length,calls,`${reason}: stale section must not reach provider`);
      const current=await fixture.store.skillContext(entry);
      const cleared=await fixture.store.changeSkillContext(entry,{action:'clear',expectedRevision:current.revision,requestId:'clear'});assert.equal(cleared.activePins.length,0);
    }finally{await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
  }
});

for (const mode of ['transport_closed', 'scope_denied']) test(`authorization ${mode} is not reported as a missing skill`, {timeout:30000}, async()=>{
  const directory=temp(`authorization-${mode}`);let fixture,denied=false;
  const authority=createServer((_req,res)=>{
    res.setHeader('content-type','application/json');
    if(denied)res.writeHead(403).end(JSON.stringify({code:403,reason:'scope_denied'}));
    else res.end(JSON.stringify({code:0,data:{}}));
  });
  await new Promise(resolve=>authority.listen(0,'127.0.0.1',resolve));
  const bridge=createOperationBridge({opsUrl:`http://127.0.0.1:${authority.address().port}`,hostToken:'synthetic'});
  try{
    fixture=await skillFixture(directory,{
      authorizationGate:()=>bridge.opsRequest('GET','/assistant/runtime/turns/turn'),
      gate:async(_body,call)=>{
        if(call!==1)return;
        if(mode==='transport_closed'){
          authority.closeAllConnections();await new Promise(resolve=>authority.close(resolve));
        }else denied=true;
      },
      script:(_body,call)=>call===1?{name:'plan_update',args:{items:[{id:'one',title:'Synthetic completed operation',status:'doing'}]}}:null,
    });
    const entry=await fixture.store.createSession('canvas');
    const submission=await fixture.store.submit(entry,{turnId:'turn',requestId:'request',content:'Synthetic task'});
    const record=await fixture.store.wait(entry,submission);
    const reason=mode==='transport_closed'?'turn_authorization_unavailable':'scope_denied';
    assert.equal(record.errorReason,reason);
    assert.equal(record.cancelled,false,'an outage or denied scope is not proof of a user interruption');
    assert.equal(fixture.payloads.length,1,'failed authorization must not dispatch another model request');
    assert.equal(record.toolCalls.filter(tool=>tool.tool==='plan.update'&&!tool.isError).length,0,'a denied authorization must not execute the planned write');
    assert.equal((await fixture.store.history('canvas',entry.sessionId)).turns[0].errorReason,reason);
  }finally{
    await fixture?.close();authority.closeAllConnections();
    if(authority.listening)await new Promise(resolve=>authority.close(resolve));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('official close interrupts live work without committing a false skill failure and explicit recovery keeps completed tools', {timeout:30000},async()=>{
  const directory=temp('close-live');let fixture,release,started;
  const pending=new Promise(resolve=>{release=resolve;});
  const dispatched=new Promise(resolve=>{started=resolve;});
  try{
    fixture=await skillFixture(directory,{
      gate:async(_body,call)=>{if(call===2){started();await pending;}},
      script:(_body,call)=>call===1?{name:'plan_update',args:{items:[{id:'one',title:'Synthetic committed step',status:'doing'}]}}:null,
    });
    const entry=await fixture.store.createSession('canvas');
    await fixture.store.submit(entry,{turnId:'interrupted-turn',requestId:'interrupted-request',content:'Synthetic task'});
    await dispatched;
    const start=Date.now();
    await fixture.store.disposeAll();
    assert(Date.now()-start<3000,'official close must interrupt the pending request promptly');
    assert.equal(fixture.payloads.length,2);
    const sessionId=entry.sessionId;
    release();await fixture.close();
    fixture=await skillFixture(directory);
    const history=await fixture.store.history('canvas',sessionId);
    assert.equal(history.active?.requestId,'interrupted-request');
    assert.equal(history.active?.errorReason,undefined,'close must not manufacture a terminal skill error');
    assert.equal(history.turns.length,0);
    assert.equal(history.plan.items[0].status,'doing','the committed tool effect remains visible');
    assert.equal(fixture.payloads.length,0,'opening history must not dispatch model work');
    const restored=await fixture.store.ensureSession('canvas',sessionId);
    const recovered=await fixture.store.recover(restored);
    const record=await fixture.store.wait(restored,recovered);
    assert.equal(record.error,null);
    assert.equal(record.toolCalls.filter(tool=>tool.tool==='plan.update'&&!tool.isError).length,1,'completed tool must not be duplicated');
    assert.equal(fixture.payloads.length,1,'only explicit recovery may dispatch the interrupted request');
  }finally{release?.();await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('thinking level defaults to low, honours the env, and reaches existing conversations on their next turn', { timeout: 60000 }, async () => {
  assert.equal(agentThinkingLevel({}), 'low');
  assert.equal(agentThinkingLevel({ BEEFTV_AGENT_THINKING: 'HIGH' }), 'high');
  assert.equal(agentThinkingLevel({ BEEFTV_AGENT_THINKING: 'off' }), 'off');
  assert.equal(agentThinkingLevel({ BEEFTV_AGENT_THINKING: 'xhigh' }), 'low');
  const directory = temp('thinking');
  let fixture;
  const previous = process.env.BEEFTV_AGENT_THINKING;
  try {
    delete process.env.BEEFTV_AGENT_THINKING;
    fixture = await skillFixture(directory);
    const entry = await fixture.store.createSession('canvas');
    const first = await fixture.store.submit(entry, { turnId: 'turn-1', content: '你好', userText: '你好' });
    assert.equal((await fixture.store.wait(entry, first)).error, null);
    assert.equal(fixture.payloads.at(-1).reasoning_effort, 'low');
    await fixture.close();
    fixture = await skillFixture(directory, { thinkingLevel: 'off' });
    const off = await fixture.store.ensureSession('canvas', entry.sessionId);
    const second = await fixture.store.submit(off, { turnId: 'turn-2', content: '再来', userText: '再来' });
    assert.equal((await fixture.store.wait(off, second)).error, null);
    assert.equal(fixture.payloads.at(-1).reasoning_effort, undefined);
    await fixture.close();
    process.env.BEEFTV_AGENT_THINKING = 'medium';
    fixture = await skillFixture(directory);
    const medium = await fixture.store.ensureSession('canvas', entry.sessionId);
    const third = await fixture.store.submit(medium, { turnId: 'turn-3', content: '继续', userText: '继续' });
    assert.equal((await fixture.store.wait(medium, third)).error, null);
    assert.equal(fixture.payloads.at(-1).reasoning_effort, 'medium');
  } finally {
    if (previous === undefined) delete process.env.BEEFTV_AGENT_THINKING; else process.env.BEEFTV_AGENT_THINKING = previous;
    await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
