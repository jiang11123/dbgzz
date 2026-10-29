import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createModels} from '@earendil-works/pi-ai/models';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {createDurableSessionStore, durableStreamEvents} from './durable-session-owner.mjs';
import {fetchModelWithProgressIdle, DEFAULT_MODEL_STREAM_IDLE_MS} from './model-stream-idle.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = data => `data: ${JSON.stringify(data)}\n\n`;
async function fixture(t, run, contentType = 'text/event-stream') {
  let closed = 0;
  const server = http.createServer((req, res) => {
    req.resume(); res.writeHead(200, {'content-type': contentType}); res.flushHeaders();
    res.on('close', () => closed++); run(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  return {url:`http://127.0.0.1:${server.address().port}`, closed: () => closed};
}
const request = (path='/chat/completions', body={messages:[],stream:true}, signal) => ({path, options:{method:'POST',body:JSON.stringify(body),signal}});
async function read(response) {
  const reader=response.body.getReader(); const chunks=[];
  try { while(true) {const next=await reader.read(); if(next.done) return {text:Buffer.concat(chunks).toString()}; chunks.push(Buffer.from(next.value));} }
  catch(error) {return {text:Buffer.concat(chunks).toString(),error};}
}
test('95s production default; partial then comment and empty delta cannot extend body idle',async t=>{
  assert.equal(DEFAULT_MODEL_STREAM_IDLE_MS,95000);
  const prefix=event({choices:[{delta:{content:'partial'}}]});
  const f=await fixture(t,res=>{res.write(prefix);const timer=setInterval(()=>res.write(': ping\n\n'+event({choices:[{delta:{content:''}}]})),15);res.on('close',()=>clearInterval(timer));});
  const caller=new AbortController();const req=request(undefined,undefined,caller.signal);
  const result=await read(await fetchModelWithProgressIdle(f.url+req.path,req.options,{timeoutMs:100}));
  assert.match(result.error.message,/stream idle timeout/);assert(result.text.startsWith(prefix));assert(!caller.signal.aborted);
  await delay(30);assert.equal(f.closed(),1);
});
for(const [path,body,progress,empty,terminal] of [
  ['/chat/completions',{messages:[],stream:true},{choices:[{delta:{reasoning_content:'thinking',tool_calls:[{function:{arguments:'{"x":'}}]}}]}, {choices:[{delta:{role:'assistant'}}]}, {choices:[{delta:{},finish_reason:'stop'}]}],
  ['/responses',{input:[],stream:true},{type:'response.function_call_arguments.delta',delta:'value'}, {type:'response.created'}, {type:'response.completed'}],
  ['/messages',{messages:[],stream:true},{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'think'}},{type:'ping'},{type:'message_stop'}],
  ['/messages',{messages:[],stream:true},{type:'content_block_delta',delta:{type:'signature_delta',signature:'sig'}},{type:'ping'},{type:'message_stop'}],
]) test(`actual ${path} progress permits a stream longer than total timeout`,async t=>{
  const f=await fixture(t,res=>{let count=0;res.write(event(empty));const timer=setInterval(()=>{if(count++<5)res.write(event(progress));else{clearInterval(timer);res.end(event(terminal));}},40);res.on('close',()=>clearInterval(timer));});
  const req=request(path,body);const begin=Date.now(); const result=await read(await fetchModelWithProgressIdle(f.url+path,req.options,{timeoutMs:120}));
  assert(!result.error);assert(Date.now()-begin>220);assert(result.text.includes(JSON.stringify(terminal)));await delay(140);assert.equal(f.closed(),1);
});
test('fragmented UTF8 and CRLF preserve bytes and recognize only complete progress',async t=>{
  const bytes=Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'咖啡'}}]})+'\r\n\r\n');
  const f=await fixture(t,res=>{res.write(bytes.subarray(0,bytes.length-5));setTimeout(()=>res.end(bytes.subarray(bytes.length-5)),30);});
  const req=request();const result=await read(await fetchModelWithProgressIdle(f.url+req.path,req.options,{timeoutMs:100}));
  assert(!result.error);assert.equal(result.text,bytes.toString());
});
for(const field of ['text','thinking']) test(`Anthropic nonempty initial ${field} is progress; empty starts are not`,async t=>{
  const f=await fixture(t,res=>{
    const timer=setInterval(()=>res.write(event({type:'content_block_start',content_block:{type:field,[field]:''}})),15);
    setTimeout(()=>res.write(event({type:'content_block_start',content_block:{type:field,[field]:'actual initial content'}})),70);
    setTimeout(()=>{clearInterval(timer);res.end(event({type:'message_stop'}));},140);
    res.on('close',()=>clearInterval(timer));
  });
  const result=await read(await fetchModelWithProgressIdle(f.url+'/messages',request('/messages',{stream:true,messages:[]}).options,{timeoutMs:100}));assert(!result.error);
});
for(const [route,body,empty] of [
  ['/messages',{stream:true,messages:[]},{type:'content_block_start',content_block:{type:'text',text:''}}],
  ['/responses',{stream:true,input:[]},{type:'response.output_item.added',item:{type:'message',content:[]}}],
]) test(`${route} empty initial/metadata events cannot keep a stalled response alive`,async t=>{
  const f=await fixture(t,res=>{const timer=setInterval(()=>res.write(event(empty)),15);res.on('close',()=>clearInterval(timer));});
  const result=await read(await fetchModelWithProgressIdle(f.url+route,request(route,body).options,{timeoutMs:100}));assert.match(result.error.message,/idle timeout/);
});
test('Responses complete text/function arguments and custom tool input carry actual progress',async t=>{
  const progress=[{type:'response.output_item.done',item:{type:'message',content:[{type:'output_text',text:'actual text'}]}},{type:'response.function_call_arguments.done',arguments:'{}'},{type:'response.custom_tool_call_input.delta',delta:'actual input'}];
  const f=await fixture(t,res=>{let count=0;const timer=setInterval(()=>{if(count<progress.length)res.write(event(progress[count++]));else{clearInterval(timer);res.end(event({type:'response.completed'}));}},60);res.on('close',()=>clearInterval(timer));});
  const result=await read(await fetchModelWithProgressIdle(f.url+'/responses',request('/responses',{stream:true,input:[]}).options,{timeoutMs:110}));assert(!result.error);
});
test('Stop aborts promptly; consumer cancellation closes transport without idle leakage',async t=>{
  const f=await fixture(t,res=>res.write(event({choices:[{delta:{content:'partial'}}]})));
  const caller=new AbortController(); const req=request(undefined,undefined,caller.signal);
  const reading=read(await fetchModelWithProgressIdle(f.url+req.path,req.options,{timeoutMs:200}));
  caller.abort(new DOMException('User Stop','AbortError'));const result=await reading;assert.equal(result.error.name,'AbortError');
  const response=await fetchModelWithProgressIdle(f.url+req.path,request().options,{timeoutMs:200});await response.body.cancel();await delay(240);assert.equal(f.closed(),2);
});
for(const [path,body,type] of [['/models/gemini:streamGenerateContent',{stream:true,messages:[]},'text/event-stream'],['/chat/completions',{stream:false,messages:[]},'text/event-stream'],['/chat/completions',{stream:true,messages:[]},'application/json']]) test(`unsupported ${path}/${type}/${body.stream} passes through`,async t=>{
  const f=await fixture(t,res=>setTimeout(()=>res.end('unchanged'),80),type);
  const result=await read(await fetchModelWithProgressIdle(f.url+path,request(path,body).options,{timeoutMs:20}));assert(!result.error);assert.equal(result.text,'unchanged');
});
test('official Durable retries idle body with partial retained, one completed tool and SQLite history reopen', {timeout:20000}, async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'beeftv-model-idle-'));let calls=0;const toolIds=[];let store;
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw);calls++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    const frame=(delta,finish_reason=null)=>res.write(event({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]}));
    if(calls===1){frame({role:'assistant',tool_calls:[{index:0,id:'one-stable-tool',type:'function',function:{name:'canvas_nodes_create',arguments:'{}'}}]});frame({},'tool_calls');res.end('data: [DONE]\n\n');}
    else if(calls===2){assert(payload.messages.some(message=>message.role==='tool'));frame({role:'assistant',content:'retained current partial'});frame({tool_calls:[{index:0,id:'unfinished-tool',type:'function',function:{name:'canvas_nodes_create',arguments:'{"unfinished":'}}]});const timer=setInterval(()=>res.write(': keepalive\n\n'),20);res.on('close',()=>clearInterval(timer));}
    else {
      assert(calls===3 || calls===4);
      const wireCalls=payload.messages.flatMap(message=>message.tool_calls || []).map(call=>call.id);
      const wireResults=payload.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id);
      assert.deepEqual(wireCalls,['one-stable-tool']);
      assert.deepEqual(wireResults,wireCalls,'retry and reopen must not send an orphan result for a partial call');
      frame({role:'assistant',content:'completed after official retry'});frame({},'stop');res.end('data: [DONE]\n\n');
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const realFetch=globalThis.fetch;
  globalThis.fetch=(input,options)=>fetchModelWithProgressIdle(input,options,{fetch:realFetch,timeoutMs:150});
  t.after(async()=>{globalThis.fetch=realFetch;await store?.disposeAll();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
  const runtime=await ModelRuntime.create({authPath:path.join(directory,'auth.json'),modelsPath:null,refreshOnCreate:false});
  runtime.registerProvider('fixture',{api:'openai-completions',apiKey:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:200000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
  const models=createModels();models.setProvider(runtime.getProvider('fixture'));
  const makeStore=()=>createDurableSessionStore({sessionRoot:path.join(directory,'sessions'),workspaceRoot:path.join(directory,'workspace'),getModels:()=>models,getModelRef:()=>({provider:'fixture',modelId:'fixture'}),
    buildTools:()=>[{name:'canvas_nodes_create',label:'canvas.nodes.create',description:'synthetic local write',parameters:{type:'object',properties:{}},execute:async id=>{toolIds.push(id);return {content:[{type:'text',text:'one synthetic write'}]};}}],
    authorizeTurn:async()=>({turnId:'idle-turn',canvasId:'canvas',permissionMode:'canvas',open:true}),completeTurn:async()=>{},settings:{retry:{maxRetries:1,baseDelayMs:1}}});
  store=makeStore();const entry=await store.ensureSession('canvas');
  const submission=await store.submit(entry,{turnId:'idle-turn',permissionMode:'canvas',content:'write once then summarize',userText:'write once then summarize',revisionBefore:1});
  const events=[];const record=await store.wait(entry,submission,{onEvent:event=>{events.push(event);}});
  assert.equal(record.reply,'completed after official retry');assert.equal(record.error,null);assert.equal(calls,3);assert.equal(toolIds.length,1);
  // The official retry reaches the panel as classified progress, never as the upstream error text.
  assert(events.some(event=>event.type==='auto_retry_start'&&/idle timeout/.test(event.errorMessage)));
  const progress=events.flatMap(durableStreamEvents).filter(line=>line.type==='lifecycle'&&line.phase.startsWith('retry'));
  assert.deepEqual(progress,[{type:'lifecycle',phase:'retry',attempt:1,reason:'timeout'},{type:'lifecycle',phase:'retry_end',attempt:1}]);
  assert(!JSON.stringify(progress).includes('idle'));
  const view=await entry.root.context(BACKGROUND_CONTEXT);const errors=view.entries.flatMap(item=>item.model||[]).filter(message=>message.role==='assistant'&&message.stopReason==='error');
  assert(errors.some(message=>JSON.stringify(message.content).includes('retained current partial')&&/idle timeout/.test(message.errorMessage)));
  assert(errors.some(message=>message.content.some(part=>part.type==='toolCall'&&part.id==='unfinished-tool')),'the regression must retain an actual partial call in the audit transcript');
  assert(!view.messages.some(message=>message.toolCallId==='unfinished-tool'||(Array.isArray(message.content)&&message.content.some(part=>part.type==='toolCall'&&part.id==='unfinished-tool'))),'official context excludes the failed call');
  const sessionId=entry.sessionId;await store.disposeAll();store=makeStore();const history=await store.history('canvas',sessionId);assert.equal(history.turns[0].reply,record.reply);assert.equal(calls,3);assert.equal(toolIds.length,1);
  const reopened=await store.ensureSession('canvas',sessionId);
  const next=await store.submit(reopened,{turnId:'idle-turn-2',permissionMode:'canvas',content:'summarize the preserved result',userText:'summarize the preserved result',revisionBefore:1});
  assert.equal((await store.wait(reopened,next)).error,null);assert.equal(calls,4);assert.equal(toolIds.length,1);
});
