// Isolated Electron integration test. The HTTPS site is a controlled fixture, not real Dola.
const {app, BrowserWindow, session} = require('electron');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const out=path.join(root,'verification');
fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'doubao2-dola-e2e-'));
app.setPath('userData',profile);
process.env.DOUBAO_APP_MODE='gateway';
process.env.CANVAS_BRIDGE_PORT='0';
process.env.DOUBAO_GATEWAY_PORT='0';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const report={fixture:true,profile,checks:[]};
function pass(s){report.checks.push(s); console.log('PASS '+s);}
const fixture=`<!doctype html><meta charset="utf-8"><style>body{font:18px sans-serif}textarea{width:700px;height:100px}button{padding:12px}article{margin:12px}</style>
<main id="messages"></main><textarea data-testid="chat_input_input"></textarea><button data-testid="chat_input_send_button">Send</button><button data-testid="chat_input_local_break_button" style="display:none">Stop</button>
<script>
const historyKey='fixture-history';
let messages=location.pathname==='/chat/'?[]:JSON.parse(sessionStorage.getItem(historyKey)||'[]');
function render(){document.getElementById('messages').innerHTML='';for(const m of messages){let e=document.createElement('article');e.dataset.messageId=m.id;e.dataset.messageRole=m.role;e.textContent=m.text;document.getElementById('messages').append(e)}}
render();
document.querySelector('[data-testid=chat_input_send_button]').onclick=async()=>{
 const input=document.querySelector('textarea'),text=input.value;if(!text)return;
 const previous=messages.filter(m=>m.role==='user').map(m=>m.text).join(' / ');
 messages.push({id:'u'+Date.now(),role:'user',text});input.value='';render();
 document.querySelector('[data-testid=chat_input_local_break_button]').style.display='inline';
 const response=await fetch('/chat/completion',{method:'POST',body:JSON.stringify({text,previous})});
 const raw=await response.text();const answer=JSON.parse(raw.replace(/^data: /,'').trim()).text;
 messages.push({id:'a'+Date.now(),role:'assistant',text:answer});render();
 sessionStorage.setItem(historyKey,JSON.stringify(messages));history.pushState({},'', '/chat/fixture-conversation');
 document.querySelector('[data-testid=chat_input_local_break_button]').style.display='none';
};
</script>`;
app.on('session-created',ses=>{
 ses.protocol.handle('https',async request=>{
  const u=new URL(request.url);
  if(u.hostname==='www.dola.com'){
   if(u.pathname==='/chat/completion'){
    const body=await request.json();
    const answer='Dola 测试回复：'+body.text+(body.previous?'；上文：'+body.previous:'');
    return new Response(new ReadableStream({start(controller){setTimeout(()=>{controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({text:answer,end_type:3})+'\n\n'));controller.close()},450)}}),{headers:{'content-type':'text/event-stream'}});
   }
   return new Response(fixture,{headers:{'content-type':'text/html; charset=utf-8'}});
  }
  if(u.hostname==='www.doubao.com')return new Response('<p>Domestic fixture (not contacted)</p>',{headers:{'content-type':'text/html'}});
  return new Response('',{status:404});
 });
});
require(path.join(root,'dist/main/main/main.js'));
app.whenReady().then(async()=>{
 let main;
 try{
  async function until(test,label,ms=20000){const deadline=Date.now()+ms;while(Date.now()<deadline){try{const result=await test();if(result)return result}catch{}await pause(100)}throw new Error('TIMEOUT '+label)}
  main=await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html')),'main window');
  const run=code=>main.webContents.executeJavaScript(code,true);
  await until(()=>run('!!window.workspace && !!document.querySelector(".add-account")'),'renderer');
  await run('document.querySelector(".add-account").click()');
  await until(()=>run('!!document.querySelector(".modal select")'),'platform selector');
  await run(`(()=>{const s=document.querySelector('.modal select');s.value='dola';s.dispatchEvent(new Event('change',{bubbles:true}));const i=document.querySelector('.modal input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Dola 验证账号');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await pause(100);
  await run(`document.querySelector('.modal form').requestSubmit()`);
  const account=await until(()=>run(`window.workspace.load().then(d=>d.accounts.find(a=>a.platform==='dola'))`),'Dola database account');
  assert.match(account.sessionName,/^persist:dola_/);
  pass('Dola created from the real 2.0 account dialog with its own session');
  await run(`window.workspace.setAppMode('gateway')`);
  await until(()=>run('!!document.querySelector(".gateway-chat")'),'unified chat');
  await run(`document.querySelector('[title="发送账号"]').click()`);
  await until(()=>run(`!![...document.querySelectorAll('[role=menuitemradio]')].find(e=>e.textContent.includes('Dola 验证账号'))`),'Dola sender option');
  await run(`([...document.querySelectorAll('[role=menuitemradio]')].find(e=>e.textContent.includes('Dola 验证账号'))).click()`);
  pass('Dola selectable in the existing unified-chat sender menu');
  async function sendViaUI(prompt){
   await run(`(()=>{const i=document.querySelector('textarea[aria-label="消息输入框"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(i,${JSON.stringify(prompt)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await pause(100);
   await run(`document.querySelector('.chat-composer-row button.primary').click()`);
   return until(()=>run(`window.workspace.chatThreads().then(async ts=>{const t=ts[0];if(!t)return null;const ms=await window.workspace.chatMessages(t.id);const m=ms.at(-1);if(m?.status==='failed')throw new Error(m.error);return m?.role==='assistant'&&m.status==='done'&&m.content.includes(${JSON.stringify(prompt)})?{thread:t,message:m}:null})`),'reply for '+prompt,30000);
  }
  const first=await sendViaUI('记住测试口令青蛙');
  assert.equal(first.thread.accountId,account.id);
  assert.equal(first.thread.doubaoConversationId,'fixture-conversation');
  assert.equal(first.message.accountId,account.id);
  assert.equal(await run(`document.body.innerText.includes('Dola 测试回复：记住测试口令青蛙')`),true);
  pass('Message travels from unified UI through IPC and Dola transport back to a rendered reply');
  const second=await sendViaUI('上一条测试口令是什么');
  assert.match(second.message.content,/上文：记住测试口令青蛙/);
  pass('Second turn preserves the same Dola account and remote conversation');
  fs.writeFileSync(path.join(out,'dola-unified-chat-fixture.png'),(await main.webContents.capturePage()).toPNG());
  const other=await run(`window.workspace.createAccount({platform:'dola',name:'Dola 隔离账号'})`);
  const isolated=await run(`window.workspace.chatSend({prompt:'独立会话',accountId:${other.id}})`);
  assert.doesNotMatch(isolated.assistantMessage.content,/青蛙/);
  assert.equal(isolated.thread.accountId,other.id);
  pass('Separate Dola accounts and sessions do not leak conversation history');
  const media=await run(`window.workspace.chatVideos({prompt:'test',accountId:${account.id}}).then(()=>'',e=>e.message)`);
  assert.match(media,/Dola/);
  pass('Unsupported media requests report an error without switching platform');
  report.ok=true;
 }catch(error){report.ok=false;report.error=String(error.stack||error);console.error(report.error);if(main&&!main.isDestroyed())fs.writeFileSync(path.join(out,'dola-fixture-failure.png'),(await main.webContents.capturePage()).toPNG());}
 fs.writeFileSync(path.join(out,'dola-e2e-report.json'),JSON.stringify(report,null,2));
 app.exit(report.ok?0:1);
});
