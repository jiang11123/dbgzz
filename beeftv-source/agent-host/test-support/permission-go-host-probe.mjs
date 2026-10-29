// Official default Durable, real Go SQLite, synthetic loopback provider only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
let child,base,log='',killed=false,calls=0;
const forwarded=[];
const headers={'content-type':'application/json','X-Beeftv-Agent-Token':config.hostToken};
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const body=async req=>{let raw='';for await(const data of req)raw+=data;return raw};
const api=async(route,data)=>fetch(base+route,{headers,method:data===undefined?'GET':'POST',body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(10000)});
const until=async predicate=>{const end=Date.now()+18000;while(Date.now()<end){if(await predicate())return;await delay(40)}throw Error(log)};
const kill=async()=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;const ended=new Promise(r=>child.once('close',r));child.kill('SIGKILL');await ended};
const proxy=createServer(async(req,res)=>{
 try{const raw=await body(req);const response=await fetch(config.backend+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:raw});const text=await response.text();
 if(req.url==='/ops/canvas.node.move'){const input=JSON.parse(raw),result=JSON.parse(text);forwarded.push({input,result});if(input.params.canvasId===config.otherCanvasId&&!killed&&result.code===0){killed=true;await kill();res.destroy();return}}
 res.writeHead(response.status,{'content-type':'application/json'});res.end(text);
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}))}
});
const provider=createServer(async(req,res)=>{
 const payload=JSON.parse(await body(req));calls++;
 const move=payload.tools.find(t=>t.function.name==='canvas_node_move');assert(move.function.parameters.properties.canvasId,'Go full mode must expose explicit target');
 const results=payload.messages.filter(m=>m.role==='tool');const params={canvasId:results.length?config.otherCanvasId:config.canvasId,nodeId:'n1',expectedRevision:1,position:{x:results.length?80:50,y:25}};
 res.writeHead(200,{'content-type':'text/event-stream'});
 const delta=results.length<2?{role:'assistant',tool_calls:[{index:0,id:`move-${results.length}`,type:'function',function:{name:'canvas_node_move',arguments:JSON.stringify(params)}}]}:{role:'assistant',content:'Both canvases updated.'};
 for(const choice of [{index:0,delta,finish_reason:null},{index:0,delta:{},finish_reason:results.length<2?'tool_calls':'stop'}])res.write('data: '+JSON.stringify({id:'permission',object:'chat.completion.chunk',created:1,model:payload.model,choices:[choice]})+'\n\n');res.end('data: [DONE]\n\n');
});
try{
 const proxyPort=await listen(proxy),modelPort=await listen(provider);const reservation=createServer();const port=await listen(reservation);await new Promise(r=>reservation.close(r));base=`http://127.0.0.1:${port}`;
 const env={...process.env,BEEFTV_AGENT_DATA_DIR:config.directory,BEEFTV_AGENT_PORT:String(port),BEEFTV_AGENT_HOST_TOKEN:config.hostToken,BEEFTV_OPS_URL:`http://127.0.0.1:${proxyPort}`,BEEFTV_AGENT_API_KEY:'fixture',BEEFTV_AGENT_API:'openai-completions',BEEFTV_AGENT_MODEL:'synthetic',BEEFTV_AGENT_BASE_URL:`http://127.0.0.1:${modelPort}/v1`,BEEFTV_AGENT_TOTAL_REQUEST_BUDGET:'0'};
 async function start(){child=spawn(process.execPath,[path.join(config.root,'agent-host/server.mjs')],{cwd:config.root,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>{log+=d});child.stderr.on('data',d=>{log+=d});await until(async()=>{try{return(await fetch(base+'/health',{signal:AbortSignal.timeout(200)})).ok}catch{return false}})}
 await start();const pending=api('/chat',{canvasId:config.canvasId,turnId:config.turnId,message:'Move one node in each of two canvases',permissionMode:'read-only',revisionBefore:1}).then(r=>r.text()).catch(()=>{});
 await until(()=>killed&&(child.signalCode!==null||child.exitCode!==null));await pending;
 assert.equal(forwarded.length,2);assert(forwarded.every(v=>v.result.code===0));
 await start();let history;await api('/history?canvasId='+config.canvasId);
 await until(async()=>{history=await(await api('/history?canvasId='+config.canvasId)).json();return history.turns?.length===1});
 assert.equal(history.turns[0].permissionMode,'full-access');assert.equal(history.turns[0].error,null);
 assert.equal(forwarded.length,3,'interrupted tool must replay once');assert.equal(forwarded[1].input.opId,forwarded[2].input.opId);assert.equal(forwarded[2].result.data.replayed,true);
 assert.equal(history.turns[0].change.canvasChanges.length,2);assert.equal(history.active,null);
 fs.writeFileSync(path.join(config.directory,'permission-host-receipt.json'),JSON.stringify({calls,forwarded,history},null,2));
}finally{await kill();proxy.closeAllConnections();provider.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>provider.close(r))])}
