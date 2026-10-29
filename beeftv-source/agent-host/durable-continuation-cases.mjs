import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelFixture } from './test-support/durable-model-switch-probe.mjs';

const input = { continuationId: 'receipt', turnId: 'fixed-turn', requestId: 'generation_fixed', content: '【自动继续】检查实际结果并继续原计划', userText: '【自动继续】检查实际结果并继续原计划', selectedNodeIds: ['actual-result'] };
const failure = reason => Object.assign(new Error(reason), { reason });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };

test('automatic continuation keeps one official request across duplicate observers and restart', {timeout:30000}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-auto-dedupe-'));
  let fixture;
  const entered=deferred(), release=deferred();
  try {
    fixture=await modelFixture(directory,'fixture',['fixture'],async()=>{entered.resolve();await release.promise;},{authorizeContinuation:async()=>{}});
    const entry=await fixture.store.createSession('canvas');
    const first=await fixture.store.submit(entry,input);
    const waiting=fixture.store.wait(entry,first);
    await entered.promise;
    assert.equal((await fixture.store.history('canvas',entry.sessionId)).active.continuationId,input.continuationId);
    const duplicate=await fixture.store.submit(entry,input);
    assert.equal(duplicate.id,first.id);
    release.resolve();
    const result=await waiting;
    assert.equal(result.requestId,input.requestId); assert.equal(result.turnId,input.turnId);
    assert.equal(result.continuationId,input.continuationId);
    assert.equal(result.userText,input.userText);
    assert.equal(fixture.requests.length,1);
    const session=entry.sessionId;
    await fixture.close();
    fixture=await modelFixture(directory,'fixture',['fixture'],()=>{},{authorizeContinuation:async()=>{}});
    const restored=await fixture.store.ensureCurrentSession('canvas',session);
    const replay=await fixture.store.submit(restored,input);
    assert.equal(replay.id,first.id);
    assert.equal((await fixture.store.history('canvas',session)).turns.length,1);
    assert.equal((await fixture.store.history('canvas',session)).turns[0].continuationId,input.continuationId);
    assert.equal(fixture.requests.length,0);
  } finally { release.resolve(); await fixture?.close(); fs.rmSync(directory,{recursive:true,force:true}); }
});

test('manual text with an automatic-looking prefix stays manual after recovery', {timeout:30000}, async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'beeftv-auto-display-'));let fixture;
  try {
    fixture=await modelFixture(directory,'fixture',['fixture'],()=>{});
    const entry=await fixture.store.createSession('canvas');
    const manual={turnId:'manual',requestId:'manual',content:input.content,userText:input.userText};
    const submission=await fixture.store.submit(entry,manual);
    const result=await fixture.store.wait(entry,submission);
    assert.equal(result.continuationId,undefined);assert.equal(result.userText,input.userText);
    const session=entry.sessionId;
    await fixture.close();fixture=await modelFixture(directory,'fixture',['fixture'],()=>{});
    const restored=(await fixture.store.history('canvas',session)).turns[0];
    assert.equal(restored.continuationId,undefined);assert.equal(restored.userText,input.userText);
  } finally {await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('automatic restore and submit never activate an old session, including after restart', {timeout:30000}, async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'beeftv-auto-session-'));let fixture;
  try {
    fixture=await modelFixture(directory,'fixture',['fixture'],()=>{},{authorizeContinuation:async()=>{}});
    const old=await fixture.store.createSession('canvas');
    const current=await fixture.store.createSession('canvas');
    await assert.rejects(fixture.store.ensureCurrentSession('canvas',old.sessionId),{reason:'session_not_current'});
    await assert.rejects(fixture.store.submit(old,input),{reason:'session_not_current'});
    assert.equal(fixture.store.sessions.get('canvas'),current);
    await fixture.close();fixture=await modelFixture(directory,'fixture',['fixture'],()=>{},{authorizeContinuation:async()=>{}});
    await assert.rejects(fixture.store.ensureCurrentSession('canvas',old.sessionId),{reason:'session_not_current'});
    assert.equal((await fixture.store.ensureCurrentSession('canvas',current.sessionId)).sessionId,current.sessionId);
    assert.equal(fixture.requests.length,0);
  } finally {await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

for(const reason of ['continuation_cancelled','continuation_scope_changed']) test(`Go ${reason} during final admission settles without model dispatch`,{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'beeftv-auto-revoked-'));let fixture;
  try {
    fixture=await modelFixture(directory,'fixture',['fixture'],()=>{},{authorizeContinuation:async()=>{throw failure(reason);}});
    const entry=await fixture.store.createSession('canvas');
    assert.equal(await fixture.store.submit(entry,input),null);
    const history=await fixture.store.history('canvas',entry.sessionId);
    assert.equal(history.turns[0].cancelled,true);assert.equal(fixture.requests.length,0);
    const manual=await fixture.store.submit(entry,{turnId:'manual',requestId:'manual',content:'我的新要求'});
    await fixture.store.wait(entry,manual);
    assert.equal(fixture.requests.length,1);
  }finally{await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('recovery of a Go-revoked prepared turn acknowledges Stop and releases the active owner',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'beeftv-auto-closed-'));let fixture;
  try{
    fixture=await modelFixture(directory,'fixture',['fixture'],()=>{},{authorizeContinuation:async()=>{throw failure('temporary_database_error');}});
    let entry=await fixture.store.createSession('canvas');const session=entry.sessionId;
    await assert.rejects(fixture.store.submit(entry,input),{reason:'temporary_database_error'});
    await fixture.close();fixture=await modelFixture(directory,'fixture',['fixture'],()=>{}, {
      authorizeTurn:async({turnId})=>({turnId,canvasId:'canvas',open:false,permissionMode:'canvas',continuationRevoked:true}),
      authorizeContinuation:async()=>{throw new Error('must not reauthorize paid/model work');},
    });
    entry=await fixture.store.ensureCurrentSession('canvas',session);
    assert.equal(await fixture.store.recover(entry),null);
    const history=await fixture.store.history('canvas',session);
    assert.equal(history.turns.at(-1).cancelled,true);assert.equal((await fixture.store.status(entry)).active,null);
    assert.equal(fixture.requests.length,0);assert.deepEqual(fixture.completed,[input.turnId]);
  }finally{await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('transient final validation failure retains the fixed pair for recovery; Stop wins before official admission',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'beeftv-auto-recover-'));let fixture;
  try{
    fixture=await modelFixture(directory,'fixture',['fixture'],()=>{},{authorizeContinuation:async()=>{throw failure('temporary_database_error');}});
    let entry=await fixture.store.createSession('canvas');const session=entry.sessionId;
    await assert.rejects(fixture.store.submit(entry,input),{reason:'temporary_database_error'});
    assert.equal((await fixture.store.status(entry)).active.turnId,input.turnId);assert.equal(fixture.requests.length,0);
    await fixture.close();fixture=await modelFixture(directory,'fixture',['fixture'],()=>{},{authorizeContinuation:async()=>{}});
    entry=await fixture.store.ensureCurrentSession('canvas',session);
    const recovered=await fixture.store.recover(entry);await fixture.store.wait(entry,recovered);
    assert.equal(fixture.requests.length,1);
    const entered=deferred(),release=deferred();
    await fixture.close();fixture=await modelFixture(directory,'fixture',['fixture'],()=>{},{authorizeContinuation:async()=>{entered.resolve();await release.promise;}});
    entry=await fixture.store.ensureCurrentSession('canvas',session);
    const next={...input,turnId:'next-turn',requestId:'generation_next'};
    const submitting=fixture.store.submit(entry,next);await entered.promise;
    await fixture.store.cancelRequest('canvas',session,next.requestId);release.resolve();
    assert.equal(await submitting,null);assert.equal(fixture.requests.length,0);
    assert.equal((await fixture.store.history('canvas',session)).turns.at(-1).cancelled,true);
  }finally{await fixture?.close();fs.rmSync(directory,{recursive:true,force:true});}
});
