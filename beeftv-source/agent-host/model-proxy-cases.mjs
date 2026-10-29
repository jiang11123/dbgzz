import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {serveEmptySkillContext} from './test-support/skill-context-fixture.mjs';

// Synthetic TLS identity, only trusted by these child processes; never a real credential.
const key=`-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgw+nIcWJVVPeeZ7B9
9paSdDMc/rDVPILJd5ZmY9mqpMShRANCAATJ8Bk9sQKLzRsaXe5zKWGLcjxU+l+2
4dPjOWBo/Urf6sq1cbR3nXHIElOKEQB9lOMlwIPn5gCI6TWtUjy79hl3
-----END PRIVATE KEY-----`;
const cert=`-----BEGIN CERTIFICATE-----
MIIBuTCCAV+gAwIBAgIUXqDUvy5i90z66TiCwcZOcHJ0d2owCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVcHJveHktZml4dHVyZS5pbnZhbGlkMCAXDTI2MTAxODA4NTU0
OVoYDzIxMjYwOTI0MDg1NTQ5WjAgMR4wHAYDVQQDDBVwcm94eS1maXh0dXJlLmlu
dmFsaWQwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATJ8Bk9sQKLzRsaXe5zKWGL
cjxU+l+24dPjOWBo/Urf6sq1cbR3nXHIElOKEQB9lOMlwIPn5gCI6TWtUjy79hl3
o3UwczAdBgNVHQ4EFgQUuhTd0LMkNx7IzzPKkMbirv+/egAwHwYDVR0jBBgwFoAU
uhTd0LMkNx7IzzPKkMbirv+/egAwDwYDVR0TAQH/BAUwAwEB/zAgBgNVHREEGTAX
ghVwcm94eS1maXh0dXJlLmludmFsaWQwCgYIKoZIzj0EAwIDSAAwRQIgZB2oTmYT
r5vfpYSbOFJSart5WkVoGH1CTpgtVvO2gCgCIQCyVd20LcPddlQDuYBuL8CX05ha
FG1/yTuS0fKE2xdu9Q==
-----END CERTIFICATE-----`;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hostToken='synthetic-loopback-host-token';
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const json=async req=>{let body='';for await(const chunk of req)body+=chunk;return JSON.parse(body||'{}');};

async function fixture(t,{secure=false,disabled=false,bypassAll=false,rejectProxy=false}={}) {
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'beeftv-sdk-proxy-'));
  const sockets=new Set(),proxyTargets=[],opsPaths=[];
  let modelRequests=0,reads=0,child,hostLog='';
  const servers=[];
  t.after(async()=>{
    if(child&&child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');await Promise.race([closed,delay(2000)]);if(child.exitCode===null){child.kill('SIGKILL');await closed;}}
    for(const socket of sockets)socket.destroy();
    for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    fs.rmSync(scratch,{recursive:true,force:true});
  });
  const modelHandler=async(req,res)=>{
    const body=await json(req);modelRequests++;
    assert.equal(req.url,'/v1/chat/completions');
    assert.equal(req.headers['x-beeftv-agent-token'],undefined);
    const hasResult=body.messages.some(message=>message.role==='tool');
    assert(body.tools.some(tool=>tool.function?.name==='canvas_get'),'synthetic operation must be registered in actual SDK');
    // The host reads the current canvas before the model; the explicit model
    // tool adds one read. Neither request may enter the model proxy.
    assert.equal(reads,hasResult?2:1,hasResult?'tool must add exactly one read before the final response':'host must read the initial canvas before the model');
    res.writeHead(200,{'content-type':'text/event-stream'});
    const frame=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    frame(hasResult?{role:'assistant',content:'local proxy and operation complete'}:{role:'assistant',tool_calls:[{index:0,id:'local-read',type:'function',function:{name:'canvas_get',arguments:'{}'}}]});
    frame({},hasResult?'stop':'tool_calls');res.end('data: [DONE]\n\n');
  };
  const model=secure?https.createServer({key,cert},modelHandler):http.createServer(modelHandler);servers.push(model);
  const modelPort=await listen(model);
  const modelHost=disabled||bypassAll||rejectProxy?'127.0.0.1':'proxy-fixture.invalid';
  const destination=`${modelHost}:${modelPort}`;
  const proxy=http.createServer((req,res)=>{proxyTargets.push(req.url);res.writeHead(502).end();});servers.push(proxy);
  proxy.on('connect',(req,socket,head)=>{
    proxyTargets.push(req.url);
    assert.equal(req.headers['x-beeftv-agent-token'],undefined);
    // No DNS or external egress: only the synthetic destination can be tunneled.
    if(req.url!==destination||rejectProxy){socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;}
    const upstream=net.connect(modelPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
    for(const stream of [socket,upstream]){sockets.add(stream);stream.on('close',()=>sockets.delete(stream));stream.on('error',()=>{socket.destroy();upstream.destroy();});}
  });
  const proxyPort=await listen(proxy);
  const ops=http.createServer(async(req,res)=>{
    assert.equal(req.headers['x-beeftv-agent-token'],hostToken);
    opsPaths.push(req.url);res.setHeader('content-type','application/json');
    if(serveEmptySkillContext(req,res))return;
    if(req.url==='/api/ops/skill.catalog'){res.end(JSON.stringify({code:0,data:{op:'skill.catalog',result:{skills:[]}}}));return;}
    if(req.url==='/api/ops'){res.end(JSON.stringify({code:0,data:{ops:[{id:'canvas.get',assistantModes:['canvas','full-access','read-only'],replay:'safe',readOnly:true,scope:'canvas',summary:'Synthetic read',params:{type:'object',properties:{canvasId:{type:'string'}},required:['canvasId']}}]}}));return;}
    if(req.url.startsWith('/api/assistant/runtime/turns/')){res.end(JSON.stringify({code:0,data:{turnId:'aa11',canvasId:'canvas',permissionMode:'canvas',open:true}}));return;}
    assert.equal(req.url,'/api/ops/canvas.get');await json(req);reads++;
    res.end(JSON.stringify({code:0,data:{op:'canvas.get',replayed:false,result:{canvasId:'canvas',canvas:{id:'canvas',revision:1,nodes:[],connections:[]}}}}));
  });servers.push(ops);
  const opsPort=await listen(ops);
  const reservation=http.createServer(),hostPort=await listen(reservation);await new Promise(resolve=>reservation.close(resolve));
  const env={...process.env};
  for(const name of Object.keys(env))if(/^(?:https?_proxy|no_proxy|all_proxy|node_options|node_use_env_proxy|node_extra_ca_certs|node_tls_reject_unauthorized)$/i.test(name))delete env[name];
  const caPath=path.join(scratch,'fixture-ca.pem');fs.writeFileSync(caPath,cert);
  Object.assign(env,{NODE_USE_ENV_PROXY:disabled?'0':'1',HTTP_PROXY:`http://127.0.0.1:${proxyPort}`,HTTPS_PROXY:`http://127.0.0.1:${proxyPort}`,NO_PROXY:bypassAll?'*':disabled||rejectProxy?'localhost':'localhost,127.0.0.1,::1,[::1]',NODE_EXTRA_CA_CERTS:caPath,
    BEEFTV_AGENT_DATA_DIR:scratch,BEEFTV_AGENT_PORT:String(hostPort),BEEFTV_OPS_URL:`http://localhost:${opsPort}/api`,BEEFTV_AGENT_HOST_TOKEN:hostToken,BEEFTV_AGENT_API_KEY:'synthetic-model-key',BEEFTV_AGENT_MODEL:'fixture',BEEFTV_AGENT_API:'openai-completions',BEEFTV_AGENT_BASE_URL:`${secure?'https':'http'}://${destination}/v1`,BEEFTV_AGENT_MAX_REQUESTS_PER_TURN:rejectProxy?'1':'2',BEEFTV_AGENT_MAX_TOOL_STEPS_PER_TURN:'2',BEEFTV_AGENT_TOTAL_REQUEST_BUDGET:'0'});
  delete env.BEEFTV_AGENT_LISTEN_FD;delete env.BEEFTV_AGENT_LIFETIME_STDIN;
  child=spawn(process.execPath,[path.join(root,'agent-host/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>hostLog+=chunk);child.stderr.on('data',chunk=>hostLog+=chunk);
  const base=`http://127.0.0.1:${hostPort}`,deadline=Date.now()+12000;let healthy=false;
  while(Date.now()<deadline){assert.equal(child.exitCode,null,hostLog);try{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(300)});if(response.ok){healthy=true;break;}}catch{}await delay(50);}
  assert(healthy,'actual host must start: '+hostLog);
  const response=await fetch(base+'/chat',{method:'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostToken},body:JSON.stringify({canvasId:'canvas',message:'Use the synthetic local read then reply.',turnId:'aa11',revisionBefore:1}),signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200);
  const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
  return {end:events.find(event=>event.type==='turn_end'),modelRequests,reads,opsPaths,proxyTargets,destination};
}

for(const secure of [false,true])test(`actual host SDK + Durable ${secure?'HTTPS':'HTTP'} model uses CONNECT proxy, ops stay direct`,{timeout:30000},async t=>{
  const result=await fixture(t,{secure});
  assert.equal(result.modelRequests,2,JSON.stringify({modelRequests:result.modelRequests,proxyConnections:result.proxyTargets.length,reason:result.end?.errorReason}));
  assert(!result.end?.error,JSON.stringify(result.end));
  assert.equal(result.end?.reply,'local proxy and operation complete');
  assert.equal(result.reads,2,JSON.stringify({tools:result.end?.toolCalls,opsPaths:result.opsPaths}));
  assert(result.opsPaths.includes('/api/ops/canvas.get'));
  assert(result.proxyTargets.length>0,'actual SDK requests must reach proxy');
  assert(result.proxyTargets.every(target=>target===result.destination),'local credentials/ops must never enter proxy');
});
for(const setting of ['disabled','bypassAll'])test(`actual SDK respects ${setting==='disabled'?'NODE_USE_ENV_PROXY=0':'NO_PROXY=*'}`,{timeout:30000},async t=>{
  const result=await fixture(t,{[setting]:true});
  assert.equal(result.end?.reply,'local proxy and operation complete');assert.equal(result.modelRequests,2);assert.equal(result.reads,2);assert.deepEqual(result.proxyTargets,[]);
});
test('actual SDK does not bypass a failing explicit proxy',{timeout:30000},async t=>{
  const result=await fixture(t,{rejectProxy:true});
  assert(result.end?.error,'proxy failure must fail the turn');assert.equal(result.modelRequests,0);assert.equal(result.reads,1,'only the local initial canvas read may precede a failed model request');assert(result.proxyTargets.length>0);assert(result.proxyTargets.every(target=>target===result.destination));
});
