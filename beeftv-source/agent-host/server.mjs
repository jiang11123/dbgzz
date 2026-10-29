// BeefTV 内置 pi 会话宿主（正式）：HTTP 适配器。
// 执行运行时只有 durable-session-owner.mjs 一套；旧 JSONL 会话只读历史在 session-owner.mjs。
// 画布操作桥在 operation-bridge.mjs。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore, durableLifecycleState, durableStreamEvents, isDurableSessionId, publicDurableTurn } from './durable-session-owner.mjs';
import { createDurableTextProjection } from './durable-stream-text.mjs';
import { createDurableTurnBudget } from './durable-turn-budget.mjs';
import { providerRegistration, providerUnavailableReason,
  turnContextPrefix, unflushedSessionHistory, toolCallCapabilityContext } from './canvas-turn.mjs';
import { budgetError, spendModelRequest } from './request-budget.mjs';
import { createDurableRequestBudget } from './durable-request-budget.mjs';
import { createOperationBridge } from './operation-bridge.mjs';
import { createLegacyHistory } from './session-owner.mjs';
import { adaptMediaRequest, trustedMediaSources, mediaCapabilityContext } from './media-content.mjs';
import {nativeSourceKey} from './native-history.mjs';
import { createNativePartStore } from './native-part-store.mjs';
import { fetchModelWithProgressIdle } from './model-stream-idle.mjs';
import { createDispatchDiagnostics } from './dispatch-diagnostics.mjs';

// SDK imports install npm undici's direct dispatcher. Restore Node's public env
// proxy support after imports, before any SDK/ops request or fetch wrapper runs.
if (process.env.NODE_USE_ENV_PROXY === '1') http.setGlobalProxyFromEnv();

const OPS_URL = (process.env.BEEFTV_OPS_URL || 'http://127.0.0.1:18090/api').replace(/\/+$/, '');
const HOST_TOKEN = process.env.BEEFTV_AGENT_HOST_TOKEN || '';
const DESKTOP_TOKEN = process.env.BEEFTV_AGENT_DESKTOP_TOKEN || '';
const ALLOWED_ORIGIN = process.env.BEEFTV_AGENT_ALLOWED_ORIGIN || '';
const DATA_DIR = process.env.BEEFTV_AGENT_DATA_DIR || '';
const LISTEN_FD = Number(process.env.BEEFTV_AGENT_LISTEN_FD || 0);
const PORT_RAW = String(process.env.BEEFTV_AGENT_PORT || '').trim();
const INSTANCE_NONCE = process.env.BEEFTV_AGENT_INSTANCE_NONCE || '';
const LIFETIME_STDIN = process.env.BEEFTV_AGENT_LIFETIME_STDIN === '1';
if (!LISTEN_FD && !PORT_RAW) {
  console.error('agent-host: 缺少 BEEFTV_AGENT_PORT 或 BEEFTV_AGENT_LISTEN_FD（由产品启动链注入）');
  process.exit(2);
}
const PORT = Number(PORT_RAW || 0);
const MODEL_ID = (process.env.BEEFTV_AGENT_MODEL || '').trim();
const MODEL_API = (process.env.BEEFTV_AGENT_API || 'openai-completions').trim();
const BASE_URL = (process.env.BEEFTV_AGENT_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.BEEFTV_AGENT_API_KEY || '';
// Thinking shares this ceiling with the answer (pi-ai adds its budget within it).
const MAX_OUTPUT_TOKENS = Number(process.env.BEEFTV_AGENT_MAX_TOKENS || 16384);
const CONTEXT_WINDOW = Number(process.env.BEEFTV_AGENT_CONTEXT_WINDOW || 200000);
const MAX_REQUESTS_PER_TURN = Number(process.env.BEEFTV_AGENT_MAX_REQUESTS_PER_TURN || 40);
const MAX_TOOL_STEPS_PER_TURN = Number(process.env.BEEFTV_AGENT_MAX_TOOL_STEPS_PER_TURN || 40);
const LIFETIME_REQUEST_BUDGET = Number(process.env.BEEFTV_AGENT_TOTAL_REQUEST_BUDGET || 0);
const MAX_BODY_BYTES = 64 * 1024;
const READ_ONLY_MODE = process.env.BEEFTV_AGENT_READ_ONLY === '1';
const PROVIDER_ID = 'beeftv';

for (const [name, value] of Object.entries({ BEEFTV_AGENT_HOST_TOKEN: HOST_TOKEN,
  BEEFTV_AGENT_DATA_DIR: DATA_DIR })) {
  if (!value) { console.error(`agent-host: 缺少 ${name}（由产品启动链注入）`); process.exit(2); }
}
const SESSION_ROOT = path.join(DATA_DIR, 'sessions');
const RUN_ID = crypto.randomUUID();
const AGENT_DIR = path.join(DATA_DIR, 'pi-agent');
const WORKSPACE_ROOT = path.join(DATA_DIR, 'workspace');
fs.mkdirSync(SESSION_ROOT, { recursive: true });
fs.mkdirSync(AGENT_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });

let providerReason = '';
let MODEL = null;
let modelRuntime = null;

async function initializeModel() {
  providerReason = providerUnavailableReason({ modelId: MODEL_ID, baseUrl: BASE_URL, apiKey: API_KEY, api: MODEL_API });
  if (providerReason) return;
  try {
    modelRuntime = await ModelRuntime.create({
      authPath: path.join(AGENT_DIR, 'auth.json'), modelsPath: null, refreshOnCreate: false,
    });
    modelRuntime.registerProvider(PROVIDER_ID, providerRegistration({
      api: MODEL_API, baseUrl: BASE_URL, modelId: MODEL_ID,
      maxTokens: MAX_OUTPUT_TOKENS, contextWindow: CONTEXT_WINDOW,
    }));
    MODEL = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
    if (!MODEL) { providerReason = 'model_not_configured'; return; }
    providerReason = '';
  } catch (error) {
    providerReason = 'model_not_configured';
    console.error(`agent-host: 模型初始化失败 ${error?.message || error}`);
  }
}

const outbound = [];
const ledgerPath = path.join(DATA_DIR, 'agent-requests.jsonl');
const dispatchDiagnostics = createDispatchDiagnostics(ledgerPath, RUN_ID);
let dispatched = 0;

const lifetimeBudgetPath = path.join(DATA_DIR, 'agent-request-budget.json');
const lifetimeBudget = createDurableRequestBudget({ limit: LIFETIME_REQUEST_BUDGET, file: lifetimeBudgetPath });

const turnBudgetContext = new AsyncLocalStorage();
const nativePartStore = createNativePartStore({directory:path.join(DATA_DIR,'native-parts')});

const BASE_ORIGIN = BASE_URL ? new URL(BASE_URL).origin : '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  let parsed = null;
  try { parsed = new URL(raw); } catch { parsed = null; }
  const isModelCall = !!BASE_ORIGIN && parsed && parsed.origin === BASE_ORIGIN;
  if (isModelCall) {
    // Transform at the real dispatch boundary; extension errors are caught by pi.
    const budget = turnBudgetContext.getStore();
    let historicalKind='素材';
    try {
    if (options.body) {
      const payload = JSON.parse(options.body);
      const mediaOptions = {api:MODEL_API,modelId:MODEL_ID,nativePartStore};
      for (const source of trustedMediaSources(payload,mediaOptions)) {
        historicalKind=source.mediaKind;
        if (!budget?.turnId || !budget.canvasId) throw new Error('media_authorization_missing');
        let actual;
        if(budget.sessionId) {
          const pinned=budget.nativeHistory?.origins.get(`${source.toolCallId}:${nativeSourceKey(source)}`);
          if(!pinned || (source.originTurnId && source.originTurnId!==pinned.originTurnId)) throw new Error('native_history_requires_reference');
          const {toolCallId,originTurnId,...nativeSource}=source;
          await ops.opsRequest('POST',`/assistant/runtime/turns/${encodeURIComponent(pinned.originTurnId)}/bind-session`,{sessionId:budget.sessionId,historical:pinned.historical,currentTurnId:budget.turnId,source:nativeSource});
          actual=await ops.opsRequest('POST',`/assistant/runtime/turns/${encodeURIComponent(budget.turnId)}/native-rehydrate`,{sessionId:budget.sessionId,originTurnId:pinned.originTurnId,source:nativeSource});
        } else {
          actual=(await ops.opsRequest('POST','/ops/media.overview',{params:{canvasId:source.canvasId,
            ...(source.nodeId ? {nodeId:source.nodeId}:{assetId:source.assetId}),resourceId:source.resourceId}},undefined,budget.turnId)).result;
        }
        if (actual.source.version !== source.version) throw new Error('media_content_changed');
      }
      options = {...options,body:JSON.stringify(adaptMediaRequest(payload,mediaOptions))};
    }
    } catch(error) {
      const failure={reason:error.reason || 'native_history_unavailable',message:`历史${historicalKind}已不可用，请在新对话重新添加这份素材后再试。`};
      if(budget) budget.failure=failure;
      return new Response(JSON.stringify({error:{message:failure.message,type:'invalid_request_error',code:failure.reason}}),{status:400,headers:{'Content-Type':'application/json'}});
    }
    if (budget?.generation?.aborted || options.signal?.aborted) {
      throw Object.assign(new Error('aborted'),{name:'AbortError'});
    }
    if (budget?.generation && !budget.generation.durable) budget.generation.modelEpoch = budget.generation.intentEpoch;
    const turn = spendModelRequest(budget);
    if (!turn.allowed) {
      if (budget) budget.failure = turn;
      throw budgetError(turn);
    }
    const lifetime = lifetimeBudget.reserve();
    if (!lifetime.allowed) {
      if (budget) { budget.requests -= 1; budget.failure = lifetime; }
      throw budgetError(lifetime);
    }
    dispatched += 1;
    let bodyModel = null;
    try { bodyModel = JSON.parse(options.body || '{}').model || null; } catch { /* 非 JSON body */ }
    const entry = { at: new Date().toISOString(), dispatchIndex: dispatched, origin: parsed.origin, path: parsed.pathname, model: bodyModel,
      turnId: budget?.turnId, canvasId: budget?.canvasId, sessionId: budget?.sessionId, requestId: budget?.requestId };
    outbound.push(entry);
    if (outbound.length > 200) outbound.shift();
    dispatchDiagnostics.record(entry);
  }
  return isModelCall ? fetchModelWithProgressIdle(input, options, {fetch: realFetch}) : realFetch(input, options);
};

const ops = createOperationBridge({
  opsUrl: OPS_URL,
  hostToken: HOST_TOKEN,
  desktopToken: DESKTOP_TOKEN,
  readOnly: READ_ONLY_MODE,
  turnBudgetContext,
  mediaModel: { api: MODEL_API, modelId: MODEL_ID },
  nativePartStore,
});

const legacy = createLegacyHistory({ sessionRoot: SESSION_ROOT, workspaceRoot: WORKSPACE_ROOT });

const durable = createDurableSessionStore({
  sessionRoot: SESSION_ROOT, workspaceRoot: WORKSPACE_ROOT, buildTools: ops.buildTools,
  getModels: entry => {
    const models = createModels(); const provider = modelRuntime.getProvider(PROVIDER_ID);
    const budgeted = fn => (...args) => {
      if (!entry.budget) entry.budget = createDurableTurnBudget(entry,{maxRequests:MAX_REQUESTS_PER_TURN,maxToolSteps:MAX_TOOL_STEPS_PER_TURN});
      entry.budget.sessionId=entry.sessionId; entry.budget.nativeHistory=entry.nativeHistory;
    entry.budget.generation = entry.generation;
      entry.budget.turnId = entry.turn.turnId; entry.budget.canvasId = entry.canvasId;
      entry.budget.requestId = entry.input?.requestId;
      return turnBudgetContext.run(entry.budget,()=>fn.call(provider,...args));
    };
    models.setProvider({...provider,stream:budgeted(provider.stream),streamSimple:budgeted(provider.streamSimple)});
    return models;
  },
  getModelRef: () => ({ provider: PROVIDER_ID, modelId: MODEL_ID }),
  authorizeContinuation: ({id,turnId,sessionId}) => ops.opsRequest('POST',`/assistant/runtime/continuations/${encodeURIComponent(id)}/verify`,{turnId,sessionId}),
  skills: {
    readContext:async (entry,turnId) => ops.opsRequest('GET',`/assistant/runtime/canvases/${encodeURIComponent(entry.canvasId)}/skill-context?sessionId=${encodeURIComponent(entry.sessionId)}${turnId?`&turnId=${encodeURIComponent(turnId)}`:''}`),
    changeContext:async (entry,change,turnId) => ops.opsRequest('POST',`/assistant/runtime/canvases/${encodeURIComponent(entry.canvasId)}/skill-context`,{...change,sessionId:entry.sessionId,...(turnId?{turnId}:{})}),
    readVersion:async (entry,pin,signal,turnId) => (await ops.opsRequest('POST','/ops/skill.get',{params:pin},signal,turnId || entry.turn.turnId)).result,
    readCatalog:async (entry,signal,turnId,query={}) => (await ops.opsRequest('POST','/ops/skill.catalog',{params:query},signal,turnId || entry.turn.turnId)).result,
  },
  readCanvas: async (entry, signal, turnId) => {
    if (!ops.descriptors.has('canvas_get')) return null;
    const { result } = await ops.opsRequest('POST', '/ops/canvas.get', { params: { canvasId: entry.canvasId } }, signal, turnId || entry.turn.turnId);
    const canvas = result?.canvas;
    // Read the full Go document, not the operation wrapper or the paged model view.
    // Stored empty documents may omit/null collections; other shapes are unknown.
    if (result?.canvasId !== entry.canvasId || !canvas || typeof canvas !== 'object' || Array.isArray(canvas) ||
        !Number.isSafeInteger(canvas.revision) || canvas.revision < 0 ||
        (canvas.nodes != null && !Array.isArray(canvas.nodes)) ||
        (canvas.connections != null && !Array.isArray(canvas.connections))) throw new Error('invalid_canvas_read_result');
    return { ...canvas, nodes: canvas.nodes ?? [], connections: canvas.connections ?? [] };
  },
  authorizeTurn: async ({canvasId, turnId,sessionId}) => {
    const state = await ops.opsRequest('GET', `/assistant/runtime/turns/${encodeURIComponent(turnId)}`);
    if(sessionId && state.open) await ops.opsRequest('POST',`/assistant/runtime/turns/${encodeURIComponent(turnId)}/bind-session`,{sessionId});
    if (state.canvasId !== canvasId) throw Object.assign(new Error('turn_not_open'), {reason:'turn_not_open', details:state});
    return state;
  },
  completeTurn: ({turnId}) => ops.opsRequest('POST', `/assistant/runtime/turns/${encodeURIComponent(turnId)}/complete`, {}),
  runWithBudget: (entry, fn) => {
    if (!entry.budget) entry.budget = createDurableTurnBudget(entry,{maxRequests:MAX_REQUESTS_PER_TURN,maxToolSteps:MAX_TOOL_STEPS_PER_TURN});
    entry.budget.sessionId=entry.sessionId; entry.budget.nativeHistory=entry.nativeHistory;
    entry.budget.generation = entry.generation;
    entry.budget.turnId = entry.turn.turnId; entry.budget.canvasId = entry.canvasId;
    entry.budget.requestId = entry.input?.requestId;
    return turnBudgetContext.run(entry.budget, fn);
  },
});

function currentId(canvasId) {
  try { return legacy.readCurrentSessionId(canvasId) || ''; }
  catch (error) {
    // Failed pointer publication must not erase a previously owned live chat.
    const entry = durable.sessions.get(canvasId);
    if (entry) return entry.sessionId;
    throw error;
  }
}
function liveEntry(canvasId) {
  return durable.sessions.get(canvasId) || null;
}
// A conversation of this canvas: a durable session created for it, or one of its legacy sessions.
function ownsSession(canvasId, sessionId) {
  if (isDurableSessionId(sessionId)) return durable.hasSession(canvasId, sessionId);
  try { return sessionId === currentId(canvasId) || Boolean(SessionManager.findById(legacy.canvasWorkspace(canvasId), sessionId, legacy.canvasSessionDir(canvasId))); }
  catch { return false; }
}
function emitDurable(entry, event) {
  // History reads restore this progress. It lives in memory only; the official task persists itself.
  const events = durableStreamEvents(event, entry.lifecycle);
  entry.lifecycle = durableLifecycleState(entry.lifecycle, event);
  if (event.type === 'plan') entry.livePlan = event.plan;
  const text = entry.textProjection.accept(event);
  for (const payload of [...(text ? [text] : []), ...events]) for (const listener of entry.listeners || []) listener(payload);
}
function followDurable(entry, submission) {
  if (!entry.running) {
    entry.listeners = new Set();
    entry.lifecycle = null;
    entry.textProjection = createDurableTextProjection();
    entry.livePlan = entry.turn.plan ?? null;
    const ready = Promise.withResolvers();
    entry.textProjectionReady = ready.promise;
    entry.running = durable.wait(entry, submission, {onEvent:event=>{
      emitDurable(entry,event);
      if (event.type === 'snapshot') ready.resolve();
    }})
      .finally(()=>{ready.resolve();entry.running=null;entry.lifecycle=null;});
    // Observers may disconnect; the official task and its completion persist.
    entry.running.catch(error=>console.error(`agent-host: durable wait ${error.reason || error.message}`));
  }
  return entry.running;
}

async function waitForDurableProjection(entry) {
  if (entry.textProjection?.initialized || !entry.textProjectionReady) return;
  // Only wait for the initial official snapshot, never the model's completion.
  // On storage delay/failure omit streamed instead of publishing a false empty value.
  let timer;
  try {
    await Promise.race([entry.textProjectionReady, new Promise(resolve => {
      timer = setTimeout(resolve, 1000);
    })]);
  } finally { clearTimeout(timer); }
}

async function attachmentContent(body, turnId) {
  const content = [{type:'text',text:body.message || '请分析所提供的素材，并说明适合如何使用。'}];
  for (const attachment of body.attachments || []) {
    content.push({type:'text',text:`用户提供素材：${JSON.stringify(attachment)}。使用 media.inspect 读取实际画面或音频后再判断；片段秒数转换为 startMs/endMs。`});
    if (attachment.kind === 'image') {
      const reference = {canvasId:body.canvasId,
        ...(attachment.nodeId ? {nodeId:attachment.nodeId}:{assetId:attachment.assetId}),resourceId:attachment.resourceId};
      const overview = await ops.opsRequest('POST','/ops/media.overview',{params:reference},undefined,turnId);
      const data = await ops.opsRequest('POST','/ops/media.inspect',{params:{...reference,
        expectedVersion:overview.result.source.version,mode:'frames'}},undefined,turnId);
      content.push(...data.result.content.filter(part=>part.type==='image').map(part=>({type:'image',data:part.data,mimeType:part.mimeType})));
    }
  }
  return content;
}

function sendLine(res, payload) { res.write(JSON.stringify(payload) + '\n'); }

function instanceProof() {
  if (!INSTANCE_NONCE) return '';
  return crypto.createHash('sha256').update(INSTANCE_NONCE).digest('hex').slice(0, 16);
}

function timingSafeMatch(got, expected) {
  const a = Buffer.from(String(got ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function instanceOK(req) {
  if (!INSTANCE_NONCE) return true;
  return timingSafeMatch(req.headers['x-beeftv-instance-nonce'] || '', INSTANCE_NONCE);
}

function authorized(req) {
  if (!instanceOK(req)) return { ok: false, reason: 'instance_mismatch' };
  if (!timingSafeMatch(req.headers['x-beeftv-agent-token'] || '', HOST_TOKEN)) return { ok: false, reason: 'unauthorized' };
  const origin = String(req.headers.origin || '');
  if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) return { ok: false, reason: 'origin_rejected' };
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return { ok: false, reason: 'host_rejected' };
  return { ok: true };
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { const error = new Error('body too large'); error.tooLarge = true; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function respond(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function respondStoreError(res, error) {
  if (['skill_context_revision_conflict','skill_context_request_conflict','skill_scope_reset_pending','skill_context_changed'].includes(error?.reason)) {
    respond(res,409,{code:409,reason:error.reason});return true;
  }
  if (['invalid_skill_context_action','invalid_skill_context_request','invalid_skill_selection','skill_selection_limit','skill_context_budget_exceeded'].includes(error?.reason)) {
    respond(res,400,{code:400,reason:error.reason});return true;
  }
  if (error?.reason === 'session_busy') { respond(res, 409, { code: 409, reason: 'session_busy' }); return true; }
  if (error?.reason === 'session_not_current') { respond(res, 409, { code: 409, reason: 'session_not_current' }); return true; }
  if (error?.reason === 'session_not_found') { respond(res, 404, { code: 404, reason: 'session_not_found' }); return true; }
  if (error?.reason === 'session_pointer_failed') {
    respond(res, 500, { code: 500, reason: 'session_pointer_failed', message: String(error.message || error) });
    return true;
  }
  if (error?.reason === 'session_store_closed') {
    respond(res, 503, { code: 503, reason: 'session_store_closed' });
    return true;
  }
  return false;
}

function anySessionBusy() {
  for (const entry of durable.sessions.values()) if (entry.busy) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const auth = authorized(req);
  if (url.pathname !== '/health' && !auth.ok) {
    respond(res, 403, { code: 403, reason: auth.reason });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    if (!instanceOK(req)) { respond(res, 403, { code: 403, reason: 'instance_mismatch' }); return; }
    const persistenceSummary = durable.sessions.size === 0 ? 'ok' : [...new Set([...durable.sessions.values()].map((entry) => entry.persistence))].join(',');
    const proof = instanceProof();
    respond(res, 200, { ok: !providerReason, reason: providerReason || undefined,
      sessions: durable.sessions.size, busy: anySessionBusy(), model: MODEL?.id || MODEL_ID, api: MODEL_API,
      baseUrl: MODEL?.baseUrl || BASE_URL, persistence: persistenceSummary, runId: RUN_ID,
      instance: proof || undefined,
      requests: { dispatched, perTurnRequests: MAX_REQUESTS_PER_TURN, perTurnToolSteps: MAX_TOOL_STEPS_PER_TURN,
        lifetimeBudget: lifetimeBudget.limit, lifetimeUsed: lifetimeBudget.used },
      operations: ops.descriptors.size, readOnly: READ_ONLY_MODE, lastOutbound: outbound.at(-1) || null });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/tools') {
    const canvasId = url.searchParams.get('canvasId') || '';
    const entry = canvasId ? durable.sessions.get(canvasId) : null;
    respond(res, 200, { canvasId, activeTools: entry?.toolNames || [], known: [...ops.descriptors.keys()] });
    return;
  }
  try {
    if (url.pathname === '/skill-context' && ['GET','POST'].includes(req.method)) {
      const body=req.method==='POST'?JSON.parse((await readBody(req)) || '{}'):Object.fromEntries(url.searchParams);
      const canvasId=String(body.canvasId || '').trim();
      if (!canvasId) {respond(res,400,{reason:'invalid_request'});return;}
      const entry=await durable.ensureSession(canvasId,String(body.sessionId || ''));
      const result=req.method==='GET'?await durable.skillContext(entry):await durable.changeSkillContext(entry,{
        action:body.action,expectedRevision:body.expectedRevision,requestId:body.requestId,...(body.pins?{pins:body.pins}:{})});
      respond(res,200,result);return;
    }
    if (req.method === 'GET' && url.pathname === '/active') {
      const canvasId = String(url.searchParams.get('canvasId') || '');
      const sessionId = String(url.searchParams.get('sessionId') || currentId(canvasId));
      let entry = liveEntry(canvasId);
      if (isDurableSessionId(sessionId)) entry = await durable.ensureSession(canvasId,sessionId);
      respond(res,200,{sessionId:entry?.sessionId || sessionId || null,turnId:entry?.turn.turnId || null,busy:Boolean(entry?.busy)}); return;
    }
    if (req.method === 'GET' && url.pathname === '/sessions') {
      const canvasId = String(url.searchParams.get('canvasId') || '').trim();
      if (!canvasId) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
      const list = [...await legacy.listCanvasSessions(canvasId), ...await durable.listCanvasSessions(canvasId)];
      const active = currentId(canvasId) || null;
      if (active && !list.some((item) => item.sessionId === active)) {
        list.unshift({ sessionId: active, title: '', updatedAt: new Date().toISOString(), turnCount: 0 });
      }
      respond(res, 200, { currentSessionId: active, sessions: list });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sessions') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canvasId = String(body.canvasId || '').trim();
      if (!canvasId) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
      if (liveEntry(canvasId)?.busy) { respond(res,409,{reason:'session_busy'}); return; }
      const entry = await durable.createSession(canvasId);
      respond(res, 200, { sessionId: entry.sessionId });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sessions/activate') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canvasId = String(body.canvasId || '').trim();
      const sessionId = String(body.sessionId || '').trim();
      if (!canvasId || !sessionId) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
      if (liveEntry(canvasId)?.busy) { respond(res,409,{reason:'session_busy'}); return; }
      if (isDurableSessionId(sessionId)) {
        const entry = await durable.activateSession(canvasId,sessionId);
        const submission = await durable.recover(entry);
        if (submission) followDurable(entry,submission);
        respond(res,200,{sessionId:entry.sessionId}); return;
      }
      // 旧 JSONL 会话只切换当前指针用于读取展示；执行在下一次发消息时交接给新的 Durable 会话。
      legacy.writeCurrentSessionId(canvasId, sessionId);
      respond(res, 200, { sessionId });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/history') {
      const canvasId = String(url.searchParams.get('canvasId') || '').trim();
      const requested = String(url.searchParams.get('sessionId') || '').trim();
      if (!canvasId) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
      const cwd = legacy.canvasWorkspace(canvasId);
      const sessionDir = legacy.canvasSessionDir(canvasId);
      let sessionId = requested;
      if (!sessionId) {
        sessionId = currentId(canvasId);
      }
      if (!sessionId) { respond(res, 200, { sessionId: null, turns: [] }); return; }
      if (isDurableSessionId(sessionId)) {
        if (requested && sessionId !== currentId(canvasId)) {
          respond(res,200,await durable.history(canvasId,sessionId)); return;
        }
        // A live owner of the current session is read as is: polling must not republish the pointer.
        const live = liveEntry(canvasId);
        const entry = live?.sessionId === sessionId ? live : await durable.ensureSession(canvasId,sessionId);
        const submission = await durable.recover(entry);
        if (submission) followDurable(entry,submission);
        await waitForDurableProjection(entry);
        const value = await durable.history(canvasId,sessionId);
        if (value.active && entry.lifecycle) value.active.lifecycle = entry.lifecycle;
        if (value.active && entry.textProjection?.initialized) value.active.streamed = entry.textProjection.text;
        respond(res,200,value); return;
      }
      const file = SessionManager.findById(cwd, sessionId, sessionDir);
      if (!file) {
        const active = durable.sessions.get(canvasId)?.sessionId || legacy.readCurrentSessionId(canvasId) || '';
        const empty = unflushedSessionHistory(sessionId, active);
        if (empty) { respond(res, 200, empty); return; }
        respond(res, 404, { code: 404, reason: 'session_not_found' }); return;
      }
      respond(res, 200, { sessionId, turns: legacy.turnEntries(SessionManager.open(file, sessionDir, cwd)) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/cancel') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canvasId = String(body.canvasId || '').trim();
      if ('requestId' in body || 'sessionId' in body) {
        // A Stop that names one send: only that request stops, even if its /chat has not arrived yet.
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        const requestId = typeof body.requestId === 'string' ? body.requestId : '';
        if (!canvasId || !sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) { respond(res, 400, { code: 400, reason: 'invalid_request' }); return; }
        if (!ownsSession(canvasId, sessionId)) { respond(res, 404, { code: 404, reason: 'session_not_found' }); return; }
        const result = await durable.cancelRequest(canvasId, sessionId, requestId);
        if (result.state === 'running') {
          // Persist stop intent before the Go fence so a crash can still journal it.
          const turnId = await durable.fenceStop(result.entry, requestId);
          if (turnId) {
            await ops.opsRequest('POST',`/assistant/runtime/turns/${encodeURIComponent(turnId)}/complete`,{});
            await durable.stop(result.entry, requestId);
          }
        }
        respond(res,202,{accepted:true,state:result.state === 'running' ? 'stopped' : result.state}); return;
      }
      const entry = liveEntry(canvasId);
      if (!entry) { respond(res, 404, { code: 404, reason: 'session_not_found' }); return; }
      // An idle entry has no turn to stop; its turn ID would be the previous, settled one.
      if (entry.busy) {
        // Persist stop intent before the Go fence so a crash can still journal it.
        const requestId = entry.input?.requestId;
        const turnId = await durable.fenceStop(entry, requestId);
        if (turnId) {
          await ops.opsRequest('POST',`/assistant/runtime/turns/${encodeURIComponent(turnId)}/complete`,{});
          await durable.stop(entry, requestId);
        }
      }
      respond(res,202,{accepted:true,busy:entry.busy}); return;
    }
    if (req.method === 'POST' && url.pathname === '/steer') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canvasId = String(body.canvasId || '').trim();
      const message = String(body.message || '').trim();
      const sessionId = String(body.sessionId || '').trim();
      const entry = liveEntry(canvasId);
      if (!canvasId || !sessionId || (!message && !body.attachments?.length) || message.length > 16000) {
        respond(res, 400, { code: 400, reason: 'invalid_request' }); return;
      }
      if (!entry || entry.sessionId !== sessionId) {
        respond(res, 409, { code: 409, reason: 'session_not_current' }); return;
      }
      if (!entry.busy || entry.completing || entry.generation.aborted) {
        respond(res,409,{code:409,reason:'session_not_running'}); return;
      }
      const pending = durable.beginPendingInput(entry);
      try {
        const content = await attachmentContent(body,entry.turn.turnId);
        await durable.supplement(entry,{requestId:body.requestId || crypto.randomUUID(),content,input:body});
        pending.resolve();
        respond(res,202,{accepted:true}); return;
      } catch (error) { pending.reject(error); throw error; }
    }
    if (req.method === 'POST' && url.pathname === '/events') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canvasId = String(body.canvasId || '').trim();
      const message = String(body.message || '').trim();
      if (!canvasId || !message || message.length > 8000) {
        respond(res, 400, { code: 400, reason: 'invalid_request' }); return;
      }
      const result = await durable.recordEvent(canvasId, {
        sessionId: body.sessionId || currentId(canvasId),
        requestId: body.requestId,
        kind: body.kind || 'event',
        message,
        data: body.data && typeof body.data === 'object' ? body.data : {},
      });
      respond(res, 202, result); return;
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canvasId = String(body.canvasId || '').trim();
      const userText = String(body.message || '').trim();
      const turnId = String(body.turnId || '').trim();
      const revisionBefore = Number(body.revisionBefore || 0);
      const requestedSessionId = String(body.sessionId || '').trim();
      const chosen = requestedSessionId || currentId(canvasId);
	  if (body.continuationId && (!requestedSessionId || chosen !== currentId(canvasId))) { respond(res,409,{reason:'session_not_current'}); return; }
      if (!canvasId || (!userText && !body.attachments?.length) || !turnId) { respond(res,400,{reason:'invalid_request'}); return; }
      if (providerReason) { respond(res,503,{reason:providerReason}); return; }
      // A Stop naming this request, from before its arrival until the official submit, cancels it (durable submit).
      const requestId = body.requestId || turnId;
      // 权限只由 Go 回合记录决定：宿主和模型都不能自报。
      const authority=await ops.opsRequest('GET',`/assistant/runtime/turns/${encodeURIComponent(turnId)}`);
      if(authority.canvasId!==canvasId || authority.open===false) throw Object.assign(new Error('turn_not_open'),{reason:'turn_not_open'});
      body.permissionMode=authority.permissionMode || 'canvas';
      // 只有 Durable 一套执行运行时：选中的是 Durable 会话就直接接上；否则（旧 JSONL 会话或尚无会话）
      // 新建一条 Durable 会话，并用旧会话文本作为交接说明开头。
      const entry = body.continuationId
        ? await durable.ensureCurrentSession(canvasId, chosen)
        : isDurableSessionId(chosen)
        ? await durable.ensureSession(canvasId,chosen)
        : chosen ? await durable.handoffSession(canvasId, legacy.readHandoffNote(canvasId,chosen), chosen)
          : await durable.ensureSession(canvasId);
      const content = await attachmentContent(body,turnId);
      content[0].text = `${turnContextPrefix(body)}\n${mediaCapabilityContext({ api: MODEL_API, modelId: MODEL_ID })}\n${toolCallCapabilityContext({ api: MODEL_API, modelId: MODEL_ID })}\n${content[0].text}`;
      const submission = await durable.submit(entry,{...body,content,userText,revisionBefore,requestId});
      res.durableTurn = true;
      res.writeHead(200,{'Content-Type':'application/x-ndjson'});
      sendLine(res, { type: 'session', sessionId: entry.sessionId, turnId });
      if (!submission) {
        // Stopped before the official submit (now or on an earlier send): answer with its stopped record.
        const record = (await durable.history(canvasId,entry.sessionId)).turns.find((turn) => turn.requestId === requestId);
        sendLine(res,{...record,type:'turn_end',persistence:entry.persistence,sessionId:entry.sessionId}); res.end(); return;
      }
      const result = followDurable(entry,submission);
      const listener = payload=>{ if (!res.destroyed) sendLine(res,payload); };
      entry.listeners.add(listener);
      // A repeated request re-attaches to a running turn: show its current progress first.
      if (entry.textProjection.initialized) listener({ type: 'text_snapshot', text: entry.textProjection.text });
      listener({ type: 'plan', plan: entry.livePlan });
      if (entry.lifecycle) listener(entry.lifecycle);
      try {
        const record = await result;
        if (!res.destroyed) { sendLine(res,{...publicDurableTurn(record),type:'turn_end',persistence:entry.persistence,sessionId:entry.sessionId}); res.end(); }
      } finally { entry.listeners.delete(listener); }
      return;
    }
    respond(res, 404, { code: 404, reason: 'not_found' });
  } catch (error) {
    if (error?.tooLarge) { respond(res, 413, { code: 413, reason: 'body_too_large' }); return; }
    if (!res.headersSent && respondStoreError(res, error)) return;
    console.error(`agent-host: 请求失败 ${error?.message || error}`);
    if (!res.headersSent) { respond(res, 500, { code: 500, reason: 'internal_error', message: String(error?.message || error) }); }
    else {
      if (!res.destroyed) {
        sendLine(res, res.durableTurn ? {type:'observer_error',reason:error.reason || 'interrupted'} :
          { type: 'turn_end', reply: '', toolCalls: [], change: null, proposals: [], error: String(error?.message || error), cancelled: false });
        res.end();
      }
    }
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const released = await durable.disposeAll();
    console.error(`agent-host: 关闭，释放 ${released} 个会话`);
  } catch (error) {
    console.error(`agent-host: 关闭时释放会话失败 ${error?.message || error}`);
  }
  await new Promise((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
if (LIFETIME_STDIN) {
  process.stdin.resume();
  process.stdin.on('end', () => { void shutdown(); });
  process.stdin.on('error', () => { void shutdown(); });
}

await initializeModel();
try {
  const count = await ops.loadDescriptors();
  console.error(`agent-host: 载入 ${count} 个操作（readOnly=${READ_ONLY_MODE}）`);
}
catch (error) { console.error(`agent-host: 能力发现失败（稍后可重试）：${error?.message || error}`); }
function onListen() {
  const bound = server.address();
  const port = bound && typeof bound === 'object' ? bound.port : PORT;
  console.log(`agent-host 已启动 http://127.0.0.1:${port} model=${MODEL?.id || MODEL_ID} api=${MODEL_API} baseUrl=${MODEL?.baseUrl || BASE_URL} ops=${OPS_URL} readOnly=${READ_ONLY_MODE} reason=${providerReason || 'ok'}`);
}
if (LISTEN_FD > 0) server.listen({ fd: LISTEN_FD }, onListen);
else server.listen(PORT, '127.0.0.1', onListen);
