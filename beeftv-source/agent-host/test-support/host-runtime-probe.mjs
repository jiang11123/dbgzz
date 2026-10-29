// Task-owned probe: real Node + real pi SDK, scripted loopback model/ops only.
// No user data, real credentials, or paid model request is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serveEmptySkillContext } from './skill-context-fixture.mjs';

const root = path.resolve(process.argv[2] || '.');
const destination = process.argv[3];
const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv synthetic host '));
const hostAuth = 'synthetic-host-credential-not-real';
const seen = [];
let mode = 'plain';
let providerCount = 0;
let child;
let hostLog = '';
const descriptors = [
  { id:'canvas.get',assistantModes: ['canvas', 'full-access', 'read-only'], replay: 'safe', readOnly:true,scope:'canvas',summary:'Read canvas',params:{type:'object',properties:{canvasId:{type:'string'}},required:['canvasId']} },
  { id:'asset.get',assistantModes: ['canvas', 'full-access', 'read-only'], replay: 'safe', readOnly:true,scope:'workspace_read',summary:'Read allowed asset',params:{type:'object',properties:{assetId:{type:'string'}},required:['assetId']} },
];
const listen = server => new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const readJSON = async req => { let body='';for await(const chunk of req)body+=chunk;return JSON.parse(body||'{}'); };
function sse(response,model,message,tool) {
  response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const chunk = data=>response.write('data: '+JSON.stringify({id:'synthetic-'+providerCount,object:'chat.completion.chunk',created:1,model,...data})+'\n\n');
  chunk({choices:[{index:0,delta:{role:'assistant',content:tool?'':message,...(tool?{tool_calls:[{index:0,id:'synthetic-call-'+providerCount,type:'function',function:tool}]}:{})},finish_reason:null}]});
  chunk({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
  response.end('data: [DONE]\n\n');
}
const provider=createServer(async(req,res)=>{
  try {
    const body=await readJSON(req);providerCount++;
    const toolAlready=body.messages?.some(m=>m.role==='tool');
    if(mode==='budget-loop') return sse(res,body.model,'',{name:'canvas_get',arguments:'{}'});
    if(mode==='asset'&&!toolAlready) return sse(res,body.model,'',{name:'asset_get',arguments:JSON.stringify({assetId:'explicit-asset'})});
    if(mode==='reference'&&!toolAlready) return sse(res,body.model,'',{name:'canvas_get',arguments:JSON.stringify({canvasId:'referenced-canvas'})});
    return sse(res,body.model,'Synthetic probe acknowledged.');
  } catch(error){res.writeHead(500).end(String(error));}
});
const ops=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.headers['x-beeftv-agent-token']!==hostAuth){res.writeHead(403).end(JSON.stringify({code:403,reason:'synthetic_unauthorized'}));return;}
  if(serveEmptySkillContext(req,res))return;
  if(req.method==='GET'&&req.url==='/api/ops'){res.end(JSON.stringify({code:0,data:{ops:descriptors}}));return;}
  if(req.url.startsWith('/api/assistant/runtime/turns/')){
    const turnId=decodeURIComponent(req.url.split('/')[5]||'');
    res.end(JSON.stringify({code:0,data:{turnId,canvasId:turnCanvas.get(turnId)||'canvas',permissionMode:'canvas',open:true}}));return;
  }
  const body=await readJSON(req);seen.push({path:req.url,body,turn:req.headers['x-beeftv-agent-turn']});
  if(req.url==='/api/ops/asset.get'&&Object.keys(body.params||{}).some(k=>k!=='assetId')){
    res.writeHead(400).end(JSON.stringify({code:400,reason:'invalid_params',msg:'unknown field in asset.get'}));return;
  }
  const result=req.url==='/api/ops/asset.get'?{assetId:body.params.assetId,asset:{id:body.params.assetId,name:'Synthetic asset'}}:{canvasId:body.params.canvasId,canvas:{id:body.params.canvasId,revision:1,nodes:[],connections:[]}};
  res.end(JSON.stringify({code:0,data:{op:req.url.split('/').at(-1),replayed:false,result}}));
});
const results=[];
const turnCanvas=new Map();
async function request(route,body) {
  if(body&&body.turnId&&body.canvasId)turnCanvas.set(body.turnId,body.canvasId);
  const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostAuth},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  const text=await response.text();let events=[];try{events=text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{}
  return {status:response.status,events,text};
}
async function scenario(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS',name);}catch(error){results.push({name,passed:false,error:error.message});console.log('FAIL',name,error.message);}}
let base;
try{
  const modelPort=await listen(provider),opsPort=await listen(ops);
  const reservation=createServer();const hostPort=await listen(reservation);await new Promise(resolve=>reservation.close(resolve));
  base=`http://127.0.0.1:${hostPort}`;
  const env={...process.env,BEEFTV_AGENT_DATA_DIR:scratch,BEEFTV_AGENT_PORT:String(hostPort),BEEFTV_OPS_URL:`http://127.0.0.1:${opsPort}/api`,BEEFTV_AGENT_HOST_TOKEN:hostAuth,BEEFTV_AGENT_API_KEY:'synthetic-model-key',BEEFTV_AGENT_MODEL:'synthetic-model',BEEFTV_AGENT_API:'openai-completions',BEEFTV_AGENT_BASE_URL:`http://127.0.0.1:${modelPort}/v1`,BEEFTV_AGENT_MAX_REQUESTS_PER_TURN:'1',BEEFTV_AGENT_MAX_TOOL_STEPS_PER_TURN:'4'};
  delete env.BEEFTV_AGENT_NEW_SESSION_RUNTIME; // 只有 Durable 一套执行运行时。
  child=spawn(process.execPath,[path.join(root,'agent-host/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>{hostLog+=c});child.stderr.on('data',c=>{hostLog+=c});
  const deadline=Date.now()+15000;let healthy=false;
  while(Date.now()<deadline){if(child.exitCode!==null)throw new Error('host exited '+child.exitCode+' '+hostLog.slice(-1500));try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});if(r.ok){healthy=true;break;}}catch{}await delay(100);}
  assert(healthy,'real host must become healthy');
  mode='budget-loop';
  await scenario('budget-exhaustion-is-an-explicit-failed-turn',async()=>{
    const result=await request('/chat',{canvasId:'synthetic-budget',message:'Run the synthetic bounded loop.',turnId:'aa11',revisionBefore:1});
    assert.equal(result.status,200,result.text);const end=result.events.find(e=>e.type==='turn_end');assert(end,'turn_end required');
    assert(/budget|预算|上限/.test(JSON.stringify(end.error||end.reason||'')),'budget denial must be explicit, not an empty successful turn or unrelated timeout: '+JSON.stringify(end));
    assert.equal(providerCount,1,'denied request must not reach the model');
  });
  mode='plain';
  await scenario('new-turn-after-budget-exhaustion-still-works',async()=>{
    const before=providerCount;const result=await request('/chat',{canvasId:'synthetic-budget',message:'Acknowledge.',turnId:'aa12',revisionBefore:1});
    const end=result.events.find(e=>e.type==='turn_end');assert.equal(result.status,200,result.text);assert(end&&!end.error&&!end.cancelled,'new turn must finish');assert.match(end.reply,/acknowledged/);assert.equal(providerCount,before+1);
  });
  mode='asset';
  await scenario('asset-tool-does-not-inject-unknown-canvasId',async()=>{
    const before=seen.length;await request('/chat',{canvasId:'synthetic-asset',message:'Read the referenced asset.',turnId:'aa13',revisionBefore:1,references:[{kind:'asset',id:'explicit-asset'}]});
    const call=seen.slice(before).find(c=>c.path==='/api/ops/asset.get');assert(call,'asset tool should reach ops');assert.deepEqual(Object.keys(call.body.params).sort(),['assetId']);assert.equal(call.turn,'aa13');
  });
  mode='reference';
  await scenario('explicit-reference-canvas-can-reach-backend-read-guard',async()=>{
    const before=seen.length;await request('/chat',{canvasId:'synthetic-current',message:'Read the referenced canvas.',turnId:'aa14',revisionBefore:1,references:[{kind:'canvas',id:'referenced-canvas'}]});
    const call=seen.slice(before).find(c=>c.path==='/api/ops/canvas.get'&&c.body.params.canvasId==='referenced-canvas');assert(call,'host must not unconditionally reject an explicitly referenced read');assert.equal(call.turn,'aa14');
  });
} catch(error){results.push({name:'probe-runtime',passed:false,error:error.message});console.error(error.message);}
finally{
  if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');await Promise.race([exited,delay(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  for(const server of [ops,provider])if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(destination)writeFileSync(destination,JSON.stringify({kind:'real-host-scripted-model-no-paid-calls',results,modelRequests:providerCount,opsCalls:seen,hostLog:hostLog.slice(-5000)},null,2));
  rmSync(scratch,{recursive:true,force:true});
}
if(results.some(r=>!r.passed))process.exitCode=1;
