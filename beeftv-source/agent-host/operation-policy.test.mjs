import { test, expect } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import descriptors from './operation-descriptors.fixture.json';
import { createOperationBridge } from './operation-bridge.mjs';
import { durableToolReplay } from './durable-session-owner.mjs';
import { newTurnAccumulator } from './canvas-turn.mjs';
import { mediaCapabilityContext } from './media-content.mjs';

test('Go descriptors drive default Pi discovery, calls and durable replay', async () => {
 const writes = [];
 const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/ops') {
   res.end(JSON.stringify({code:0, data:{ops:[...descriptors, {id:'unknown.write', readOnly:false}]}})); return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  writes.push(JSON.parse(raw));
  res.end(JSON.stringify({code:0,data:{result:{canvasId:'canvas-a', revision:2, created:[{id:'row-a',shotNumber:1}]}}}));
 });
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 try {
  const bridge = createOperationBridge({opsUrl:`http://127.0.0.1:${server.address().port}`,hostToken:'test',turnBudgetContext:new AsyncLocalStorage()});
  await bridge.loadDescriptors();
  const build = mode => bridge.buildTools('canvas-a',[],{aborted:false,...(mode ? {permissionMode:mode}: {})},newTurnAccumulator(),'session');
  const tools = build();
  for (const id of ['canvas.script.rows.append','canvas.script.row.update','canvas.script.row.remove','canvas.script.prepare']) {
   const tool = tools.find(tool => tool.label === id);
   expect(tool).toBeDefined(); expect(durableToolReplay(tool)).toBe('safe');
   expect(build('read-only').some(tool => tool.label === id)).toBe(false);
   expect(build('full-access').some(tool => tool.label === id)).toBe(true);
  }
  expect(tools.some(tool => tool.label === 'canvas.document.commit')).toBe(false);
  expect(build('read-only').some(tool => tool.label === 'canvas.generation.propose')).toBe(false);
  expect(build('full-access').some(tool => tool.label === 'conversation.message.attach')).toBe(false);
  expect(tools.some(tool => tool.label === 'unknown.write')).toBe(false);
  expect(build('full-access').some(tool => tool.label === 'unknown.write')).toBe(false);
  expect(durableToolReplay({label:'canvas.script.rows.append'})).toBe('unsafe');
  const review = build('read-only').find(tool => tool.label === 'media.review');
  expect(review).toBeDefined();
  expect(durableToolReplay(review)).toBe('unsafe');
  const append = tools.find(tool => tool.label === 'canvas.script.rows.append');
  await append.execute('call-1',{nodeId:'script',expectedRevision:1,rows:[{durationSeconds:6}]});
  expect(writes[0].params.canvasId).toBe('canvas-a');
  expect(writes[0].opId).toBeTruthy();
  await expect(append.execute('call-2',{canvasId:'other',nodeId:'script',expectedRevision:1,rows:[{}]})).rejects.toThrow('scope_denied');
  expect(writes).toHaveLength(1);
 } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Opus delegates independent audio to a non-replayable review and receives only observations', async () => {
 const model = {api:'anthropic-messages',modelId:'claude-opus-5-5'};
 expect(mediaCapabilityContext(model)).toContain('mode=audio');
 const received = [];
 let fail = false;
 const observation = {source:{resourceId:'audio-resource',version:'a'.repeat(64),startMs:200,endMs:1200},
  durationMs:2000,hasAudio:true,mediaSHA256:'b'.repeat(64),
  review:{model:'wand-vega-vl-1.0-flash',requestId:'audio-review',observations:'fixture sound observation',usage:{prompt_tokens:40,completion_tokens:10}}};
 const server = createServer(async (req,res) => {
  res.setHeader('content-type','application/json');
  if(req.url==='/ops') return res.end(JSON.stringify({code:0,data:{ops:descriptors}}));
  let raw='';for await (const chunk of req) raw+=chunk;
  received.push({url:req.url,...JSON.parse(raw)});
  if(fail) {res.statusCode=412;return res.end(JSON.stringify({code:412,msg:'保留原素材，不自动重复付费请求',reason:'media_review_failed'}));}
  res.end(JSON.stringify({code:0,data:{result:observation}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const bridge=createOperationBridge({opsUrl:`http://127.0.0.1:${server.address().port}`,hostToken:'fixture',mediaModel:model,turnBudgetContext:new AsyncLocalStorage()});
  await bridge.loadDescriptors();
  const turn=newTurnAccumulator(), log=[];
  const review=bridge.buildTools('canvas-a',log,{aborted:false,permissionMode:'read-only'},turn,'audio-session').find(tool=>tool.label==='media.review');
  expect(review.parameters.properties.mode.enum).toEqual(['video','audio']);
  expect(durableToolReplay(review)).toBe('unsafe');
  const args={assetId:'audio-asset',expectedVersion:'a'.repeat(64),startMs:200,endMs:1200,mode:'audio',question:'What can be heard?'};
  const result=await review.execute('audio-call',args);
  expect(result.content).toEqual([{type:'text',text:JSON.stringify({result:observation})}]);
  expect(received).toHaveLength(1);
  expect(received[0].url).toBe('/ops/media.review');
  expect(received[0].params).toEqual({...args,canvasId:'canvas-a'});
  expect(log[0].mediaFacts).toBeUndefined();
  expect(log[0].mediaEvidence).toBeUndefined();
  fail=true;
  await expect(review.execute('audio-unknown',args)).rejects.toThrow('media_review_failed');
  expect(received).toHaveLength(2);
  expect(log.at(-1).isError).toBe(true);
 } finally {await new Promise(resolve=>server.close(resolve));}
});
