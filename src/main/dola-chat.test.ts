import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { observeDolaSubmission, dolaPageStateScript, waitForDolaPage, prepareDolaConversation } from './dola-chat';

test('all serialized Dola scripts compile before reaching the remote page', () => {
  new vm.Script(dolaPageStateScript);
  new vm.Script(observeDolaSubmission('request-1', '你好 "quote"\nline'));
});

test('Dola observer only watches the matching native submission and restores fetch', async () => {
  const original = async () => new Response('data: {"end_type":3}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const window = { fetch: original } as any;
  vm.runInNewContext(observeDolaSubmission('one', '测试'), { window, TextDecoder });
  await window.fetch('/chat/completion', { body: JSON.stringify({text:'别的消息'}) });
  assert.equal(window.__dolaResults.one.started, false);
  await window.fetch('/chat/completion?aid=495671', { body: JSON.stringify({text:'测试'}) });
  for (let i=0; i<30 && !window.__dolaResults.one.done; i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(window.__dolaResults.one.done, true);
  assert.equal(window.__dolaResults.one.error, '');
  assert.equal(window.fetch, original);
  assert.equal(window.__dolaSubmission, undefined);
});

test('Dola HTTP failure is surfaced and never reported as a successful reply', async () => {
  const original = async () => new Response('{}', {status:403});
  const window = { fetch: original } as any;
  vm.runInNewContext(observeDolaSubmission('one', '测试'), { window });
  await window.fetch('/chat/completion', { body: JSON.stringify({text:'测试'}) });
  assert.match(window.__dolaResults.one.error, /403/);
  assert.equal(window.fetch, original);
});

test('a second Dola submission cannot replace an active observer', () => {
  const window = { fetch: async () => undefined } as any;
  vm.runInNewContext(observeDolaSubmission('one', '测试'), { window });
  assert.throws(() => vm.runInNewContext(observeDolaSubmission('two', '测试'), { window }), /尚未结束/);
});

test('region restriction fails immediately rather than waiting for the composer', async () => {
  const view = { webContents: { isDestroyed: () => false, executeJavaScript: async () => ({blocked:'Dola 当前网络所在地区不可用'}) } } as any;
  await assert.rejects(waitForDolaPage(view), /地区不可用/);
});

test('Dola cannot report a truncated stream as a completed answer', async () => {
  const window = {fetch:async()=>new Response('data: {"text":"half"}\n\n',{headers:{'content-type':'text/event-stream'}})} as any;
  vm.runInNewContext(observeDolaSubmission('partial','测试'),{window,TextDecoder});
  await window.fetch('/chat/completion',{body:JSON.stringify({text:'测试'})});
  for(let i=0;i<30&&!window.__dolaResults.partial.done;i++)await new Promise(r=>setTimeout(r,10));
  assert.match(window.__dolaResults.partial.error,/未完整结束/);
});

test('Dola navigation preserves unsent account-page drafts',async()=>{
  let navigated=false;
  const view={webContents:{isDestroyed:()=>false,isLoading:()=>false,
    executeJavaScript:async()=>({hasInput:true,draft:'用户尚未发送的内容',sending:false}),
    loadURL:async()=>{navigated=true;},getURL:()=> 'https://www.dola.com/chat/old'}} as any;
  await assert.rejects(prepareDolaConversation(view),/未发送草稿/);
  assert.equal(navigated,false);
});
