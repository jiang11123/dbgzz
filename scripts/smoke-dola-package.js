// Smoke-test this build only, using a fresh profile and a localhost-only DevTools endpoint.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const out=path.join(root,'verification');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'dola-package-smoke-'));
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const child=spawn(path.join(root,'release/win-unpacked/豆包工作站.exe'),[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{windowsHide:true,env:{...process.env,DOUBAO_USER_DATA_DIR:profile,DOUBAO_GATEWAY_PORT:'0',CANVAS_BRIDGE_PORT:'0'},stdio:['ignore','pipe','pipe']});
 const processLog=fs.createWriteStream(path.join(out,'package-process.log'));
 child.stdout.pipe(processLog);child.stderr.pipe(processLog);
 let ws,report={profile,checks:[],ok:false};
 const until=async(test,label,ms=25000)=>{let last;const end=Date.now()+ms;while(Date.now()<end){try{const value=await test();if(value)return value}catch(e){last=e}await pause(200)}throw new Error(label+': '+(last||'timeout'))};
 try{
  const targets=()=>fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
  const main=await until(async()=> (await targets()).find(t=>t.url.startsWith('file:')&&t.url.includes('index.html')),'packaged renderer');
  ws=new WebSocket(main.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
  let next=0;const pending=new Map();ws.onmessage=e=>{const message=JSON.parse(e.data);const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(new Error(message.error.message)):p.resolve(message.result)}};
  const call=(method,params={},timeout=10000)=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},timeout);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id,method,params}))});
  const run=async (expression,timeout)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},timeout);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
  await until(()=>run('!!window.workspace && !!document.querySelector(".add-account")'),'packaged UI');
  report.checks.push('Packaged executable launches with the bundled native SQLite module');
  const account=await run(`window.workspace.createAccount({platform:'dola',name:'Dola 安装包验证'})`);
  assert.equal(account.platform,'dola');assert.match(account.sessionName,/^persist:dola_/);
  report.checks.push('Packaged account creation persists Dola platform and isolated session');
  await run('document.querySelector(".add-account").click()');
  assert.equal(await run(`!!document.querySelector('select option[value="dola"]')`),true);
  report.checks.push('Packaged add-account dialog contains Dola');
  await run(`window.workspace.openAccount(${account.id})`);
  await pause(12000);
  report.realDolaPages=(await targets()).filter(t=>/dola\.com/.test(t.url)).map(t=>({url:t.url,title:t.title}));
  report.realDolaVerified=false;
  if(process.env.DOUBAO_VERIFY_REAL_DOLA==='1'){
    const reply=await run(`window.workspace.chatSend({prompt:'请只回复 DOLA_OK_20261026，不要添加其他文字。',accountId:${account.id}}).then(result=>({ok:true,threadId:result.thread.id,accountId:result.assistantMessage.accountId,status:result.assistantMessage.status,content:result.assistantMessage.content}),error=>({ok:false,error:error.message}))`,240000);
    report.realReply=reply;
    report.realDolaVerified=reply.ok && reply.status==='done' && reply.accountId===account.id && reply.content.includes('DOLA_OK_20261026');
  }
  report.checks.push('Actual Dola navigation attempted; no real model reply is claimed');
  report.ok=true;
  await call('Browser.close').catch(()=>undefined);
 }catch(error){report.error=String(error.stack||error);process.exitCode=1;}
 finally{ws?.close();child.kill();fs.writeFileSync(path.join(out,'package-smoke-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1});
