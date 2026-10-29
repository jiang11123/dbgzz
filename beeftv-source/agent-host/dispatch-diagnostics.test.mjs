import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDispatchDiagnostics } from './dispatch-diagnostics.mjs';

test('dispatch evidence survives reopen with exact identities and no request payload', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-evidence-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'agent-requests.jsonl');
  const first=createDispatchDiagnostics(file,'launch-1');
  assert.equal(first.record({requestId:'request-admitted-1',turnId:'1122334455667788',canvasId:'canvas-123',sessionId:'durable:11111111-2222-3333-4444-555555555555',model:'model-1',origin:'https://private.example',path:'/secret',apiKey:'PRIVATE',body:'prompt PRIVATE'}),true);
  createDispatchDiagnostics(file,'launch-2').record({turnId:'2233445566778899',canvasId:'canvas-123',model:'model-1'});
  const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,2);assert.equal(rows[0].launchId,'launch-1');assert.equal(rows[1].launchId,'launch-2');
  assert.equal(rows[0].sessionId,'durable:11111111-2222-3333-4444-555555555555');
  assert.equal(rows[0].requestId,'request-admitted-1');
  assert.equal(new Set(rows.map(x=>x.id)).size,2);
  assert.equal(/PRIVATE|private\.example|apiKey|prompt|origin/.test(JSON.stringify(rows)),false);
});

test('dispatch files rotate within a fixed byte budget and old files expire', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-bounded-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'ledger');const recorder=createDispatchDiagnostics(file,'launch-1',{maxBytes:300,segments:2,maxAgeMs:1000});
  for(let i=0;i<20;i++)assert.equal(recorder.record({turnId:'1122334455667788',model:'model-1',dispatchIndex:i}),true);
  const files=fs.readdirSync(dir);assert.equal(files.length,2);
  assert.ok(files.reduce((sum,name)=>sum+fs.statSync(path.join(dir,name)).size,0)<=600);
  fs.utimesSync(`${file}.1`,new Date(0),new Date(0));recorder.record({model:'model-1'});
  if(fs.existsSync(`${file}.1`)) assert.ok(fs.statSync(`${file}.1`).mtimeMs>Date.now()-10000);
});

test('an unavailable diagnostic path reports failure without throwing into dispatch', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-unavailable-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const blocker=path.join(dir,'file');fs.writeFileSync(blocker,'');const recorder=createDispatchDiagnostics(path.join(blocker,'ledger'),'launch-1');
  assert.equal(recorder.record({model:'model-1'}),false);assert.equal(recorder.writeErrors(),1);
});
