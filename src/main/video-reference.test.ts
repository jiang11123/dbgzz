import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BrowserView } from 'electron';
import { uploadVideoReferences } from './video-reference';

// Runtime fixture artifacts live only in a fresh OS temporary directory, never account storage.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
function localFiles(t:{after:(fn:()=>void)=>void}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'video-reference-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const image=path.join(directory,'reference.png');fs.writeFileSync(image,png);
  return {directory,image};
}
const empty={count:0,ready:0,loading:false,failed:false};
const ready={count:1,ready:1,loading:false,failed:false};
function fake(states:typeof empty[],attached=false) {
  let index=0,detach=0;const calls:{method:string;params:Record<string,unknown>}[]=[];
  const wc={isDestroyed:()=>false,executeJavaScript:async(script:string)=>{
    // 清理脚本（以 return cleared 结尾）：模拟点掉一个附件，并推进状态序列。
    if(script.includes('return cleared'))return {value:1};
    return {value:states[Math.min(index++,states.length-1)]};
  },debugger:{
    isAttached:()=>attached,attach:()=>{attached=true;},detach:()=>{attached=false;detach++;},
    sendCommand:async(method:string,params:Record<string,unknown>={})=>{
      calls.push({method,params});
      if(method==='Runtime.evaluate')return {result:{objectId:'input-object'}};
      if(method==='DOM.requestNode')return {nodeId:7};return {};
    },
  }};
  return {view:{webContents:wc} as unknown as BrowserView,calls,detaches:()=>detach};
}

test('empty references do not touch a page',async()=>{
  await uploadVideoReferences({} as BrowserView,[]);
});
test('waits for actual upload readiness, preserves caller debugger, and uses exact CDP input',async t=>{
  const {image}=localFiles(t);const f=fake([empty,{...ready,ready:0},{...ready,loading:true},ready,ready,ready],true);
  await uploadVideoReferences(f.view,[image],{pollMs:1,timeoutMs:100});
  assert.deepEqual(f.calls.filter(c=>c.method==='DOM.setFileInputFiles').map(c=>c.params),[{nodeId:7,files:[image]}]);
  assert.equal(f.detaches(),0);
});
test('FileList-only or preview-only never resolves, and owned debugger detaches',async t=>{
  const {image}=localFiles(t);const f=fake([empty,{...ready,ready:0}]);
  await assert.rejects(uploadVideoReferences(f.view,[image],{pollMs:1,timeoutMs:10}),/未确认.*上传完成/);
  assert.equal(f.detaches(),1);
});
test('failed upload rejects rather than falling back to text sending',async t=>{
  const {image}=localFiles(t);const f=fake([empty,{...ready,failed:true}]);
  await assert.rejects(uploadVideoReferences(f.view,[image],{pollMs:1,timeoutMs:100}),/上传失败/);
  assert.equal(f.calls.filter(c=>c.method==='DOM.setFileInputFiles').length,1);
  assert.equal(f.detaches(),1);
});
test('existing draft is auto-cleared, then files upload',async t=>{
  const {image}=localFiles(t);const f=fake([ready,empty,{...ready,ready:0},ready,ready,ready]);
  await uploadVideoReferences(f.view,[image],{pollMs:1,timeoutMs:100});
  assert.equal(f.calls.filter(c=>c.method==='DOM.setFileInputFiles').length,1);
});
test('unclearable draft rejects with manual guidance',async t=>{
  const {image}=localFiles(t);
  const stuck={view:{webContents:{isDestroyed:()=>false,executeJavaScript:async(script:string)=>{
    if(script.includes('return cleared'))return {value:0};
    return {value:{...ready,ready:1}};
  },debugger:{isAttached:()=>true,attach:()=>{},detach:()=>{},sendCommand:async()=>({})}}} as unknown as BrowserView};
  // 宽限窗（约 1s）内连续点不到删除按钮才会报"无法自动清理"，
  // 所以这里的超时预算必须大于宽限窗。
  await assert.rejects(uploadVideoReferences(stuck.view,[image],{pollMs:1,timeoutMs:2000}),/无法自动清理/);
});
test('delayed delete-button render does not abort clearing',async t=>{
  const {image}=localFiles(t);
  let clicks=0,uploaded=false;
  const wc={isDestroyed:()=>false,executeJavaScript:async(script:string)=>{
    if(script.includes('return cleared')){clicks+=1;return {value:clicks>=4?1:0};}
    if(uploaded)return {value:{count:1,ready:1,loading:false,failed:false}};
    return {value:clicks>=4?empty:{...ready,ready:1}};
  },debugger:{isAttached:()=>true,attach:()=>{},detach:()=>{},sendCommand:async(method:string)=>{
    if(method==='DOM.setFileInputFiles')uploaded=true;
    if(method==='Runtime.evaluate')return {result:{objectId:'input-object'}};
    if(method==='DOM.requestNode')return {nodeId:7};return {};
  }}};
  // 前 3 轮删除按钮未渲染（点击数 0），第 4 轮才出现：不应立刻报"无法自动清理"。
  await uploadVideoReferences({webContents:wc} as unknown as BrowserView,[image],{pollMs:1,timeoutMs:500});
  assert.ok(clicks>=4);
});
test('residual upload-failed banner without cards waits for it to clear',async t=>{
  const {image}=localFiles(t);
  let polls=0,uploaded=false;
  const wc={isDestroyed:()=>false,executeJavaScript:async(script:string)=>{
    if(script.includes('return cleared'))return {value:0};
    polls+=1;
    if(uploaded)return {value:{count:1,ready:1,loading:false,failed:false}};
    return {value:{count:0,ready:0,loading:false,failed:polls<=5}};
  },debugger:{isAttached:()=>true,attach:()=>{},detach:()=>{},sendCommand:async(method:string)=>{
    if(method==='DOM.setFileInputFiles')uploaded=true;
    if(method==='Runtime.evaluate')return {result:{objectId:'input-object'}};
    if(method==='DOM.requestNode')return {nodeId:7};return {};
  }}};
  // count=0 且只剩"上传失败"文案残留：应等待文案消失后正常上传，而不是报
  // "已有 0 个残留附件且无法自动清理"这类自相矛盾的错误。
  await uploadVideoReferences({webContents:wc} as unknown as BrowserView,[image],{pollMs:1,timeoutMs:500});
  assert.ok(uploaded);
});
test('disappearing or duplicated attachments reject',async t=>{
  const {image}=localFiles(t);
  await assert.rejects(uploadVideoReferences(fake([empty,ready,ready,empty]).view,[image],{pollMs:1,timeoutMs:100}),/状态发生变化/);
  await assert.rejects(uploadVideoReferences(fake([empty,{...ready,count:2}]).view,[image],{pollMs:1,timeoutMs:100}),/数量异常/);
});
test('all requested images are uploaded serially and confirmed',async t=>{
  const {image}=localFiles(t);const two={...ready,count:2,ready:2};const f=fake([empty,ready,ready,two,two,two]);
  await uploadVideoReferences(f.view,[image,image],{pollMs:1,timeoutMs:100});
  assert.equal(f.calls.filter(c=>c.method==='DOM.setFileInputFiles').length,2);
});
test('rejects invalid files before touching page',async t=>{
  const {directory}=localFiles(t);const bad=path.join(directory,'bad.png');fs.writeFileSync(bad,'not an image');
  await assert.rejects(uploadVideoReferences({} as BrowserView,[bad]),/格式不支持/);
});

/** A real Electron/CDP fixture: only data: pages and fresh in-memory session, no app/main/accounts. */
const electronFixture=String.raw`
const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=process.env.VIDEO_REFERENCE_ROOT;
const ts=require(path.join(root,'node_modules/typescript'));
require.extensions['.ts']=(m,p)=>m._compile(ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,p);
const {uploadVideoReferences,videoReferenceStateScript}=require(path.join(root,'src/main/video-reference.ts'));
const directory=process.env.VIDEO_REFERENCE_TEMP;
app.setPath('userData',path.join(directory,'user-data'));
app.disableHardwareAcceleration();
(async()=>{
 await app.whenReady();
 const isolated=session.fromPartition('video-reference-fixture-'+Date.now());
 let network=0;isolated.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(d,done)=>{network++;done({cancel:true});});
 const win=new BrowserWindow({show:false,width:900,height:700,webPreferences:{session:isolated,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true}});
 const wc=win.webContents,view={webContents:wc},image=path.join(directory,'reference.png');
 const data='data:image/png;base64,'+fs.readFileSync(image).toString('base64');
 const html='<style>textarea{width:500px;height:100px}img{width:48px;height:48px}</style>'+ 
 '<aside><input id="wrong" type="file" accept="image/*"><img src="'+data+'"></aside>'+ 
 '<article data-message-id="old"><div data-testid="attachment-image-card"><img src="'+data+'"></div></article>'+ 
 '<section id="composer"><div data-testid="attachment_area" id="cards"></div><textarea></textarea><input id="upload" type="file" accept="image/*"><button id="send">发送</button></section>';
 async function reset(mode){
  await wc.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  await wc.executeJavaScript('window.mode='+JSON.stringify(mode)+';window.submits=0;window.changes=0;window.wrong=0;'+
   'document.querySelector("#send").onclick=()=>window.submits++;document.querySelector("#wrong").onchange=()=>window.wrong++;'+
   'document.querySelector("#upload").onchange=()=>{window.changes++;if(window.mode==="ignored")return;'+
   'const card=document.createElement("div");card.setAttribute("data-testid","attachment-image-card");card.setAttribute("data-kind","image");'+
   'const img=document.createElement("img");img.src=URL.createObjectURL(document.querySelector("#upload").files[0]);card.append(img);document.querySelector("#cards").append(card);'+
   'if(window.mode==="preview")return;'+
   'if(window.mode==="uploading"){const bar=document.createElement("div");bar.setAttribute("role","progressbar");bar.setAttribute("aria-valuenow","70");card.append(bar);return;}'+
   'if(window.mode==="failed"){const note=document.createElement("span");note.textContent="上传失败";card.append(note);return;}'+
   'setTimeout(()=>{const done=document.createElement("button");done.setAttribute("data-testid","attachment-delete-btn");done.onclick=()=>card.remove();card.append(done);},180);};void 0;');
 }
 const results=[];
 for(const mode of ['ignored','preview','uploading','failed','success','token','preexisting']){
  await reset(mode);
  if(mode==='preexisting'){
   // 模拟上次任务残留：composer 里已有一张可删除的附件卡片，新任务应自动清掉再上传。
   await wc.executeJavaScript('(function(){const card=document.createElement("div");card.setAttribute("data-testid","attachment-image-card");card.setAttribute("data-kind","image");const img=document.createElement("img");img.src="data:image/png;base64,iVBORw0KGgo=";const done=document.createElement("button");done.setAttribute("data-testid","attachment-delete-btn");done.onclick=()=>card.remove();card.append(img);card.append(done);document.querySelector("#cards").append(card);})()');
  }
  const start=Date.now();let rejected=false;
  try{await uploadVideoReferences(view,[image],{timeoutMs:650,pollMs:25});}catch(e){rejected=true;if(['success','token','preexisting'].includes(mode))throw e;}
  assert.equal(rejected,!['success','token','preexisting'].includes(mode));
  const state=await wc.executeJavaScript(videoReferenceStateScript);
  const counters=await wc.executeJavaScript('({submits:window.submits,changes:window.changes,wrong:window.wrong})');
  assert.deepEqual(counters,{submits:0,changes:1,wrong:0});
  if(!rejected){assert.equal(state.ready,1);assert.ok(Date.now()-start>=180);}
  assert.equal(wc.debugger.isAttached(),false);results.push({mode,rejected,ready:state.ready,...counters});
 }
 await reset('success');await uploadVideoReferences(view,[image,image],{timeoutMs:1000,pollMs:25});
 assert.equal((await wc.executeJavaScript(videoReferenceStateScript)).ready,2);
 await reset('success');await wc.executeJavaScript('const extra=document.createElement("input");extra.type="file";extra.accept="image/*";document.querySelector("#composer").append(extra)');
 await assert.rejects(uploadVideoReferences(view,[image],{timeoutMs:300,pollMs:25}),/多个图片上传入口/);
 assert.equal(network,0);
 console.log('VIDEO_REFERENCE_FIXTURE '+JSON.stringify({results,twoOrdered:true,ambiguousBlocked:true,networkRequests:network,submitted:0}));
 win.destroy();app.exit(0);
})().catch(e=>{console.error(e.stack||e);app.exit(1);});
`;

test('isolated Electron executes real upload scripts without network or submit', {timeout:30000}, t=>{
  const {directory,image}=localFiles(t);assert.ok(fs.existsSync(image));
  const root=process.cwd();
  const entry=path.join(directory,'fixture.cjs');fs.writeFileSync(entry,electronFixture);
  const executable=path.join(root,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':'electron');
  if(!fs.existsSync(executable)){t.skip('Electron executable unavailable');return;}
  const env:NodeJS.ProcessEnv={...process.env,VIDEO_REFERENCE_ROOT:root,VIDEO_REFERENCE_TEMP:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawnSync(executable,[entry],{env,encoding:'utf8',timeout:25000,windowsHide:true});
  assert.equal(child.error,undefined,String(child.error));
  assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
  assert.match(child.stdout,/VIDEO_REFERENCE_FIXTURE/);
  console.log(child.stdout.trim());
});


test('waits for composer remount after video settings change before uploading', async t => {
  const {image}=localFiles(t);
  const missing={...empty,error:'视频参考图：未找到作曲器输入框'};
  const f=fake([missing,missing,empty,ready,ready,ready,ready]);
  await uploadVideoReferences(f.view,[image],{pollMs:1,timeoutMs:500});
  assert.equal(f.calls.filter(c=>c.method==='DOM.setFileInputFiles').length,1);
});

test('persistent missing composer times out without attaching or sending', async t => {
  const {image}=localFiles(t);
  const f=fake([{...empty,error:'视频参考图：未找到作曲器输入框'} as typeof empty]);
  await assert.rejects(uploadVideoReferences(f.view,[image],{pollMs:1,timeoutMs:15}),/未找到作曲器输入框/);
  assert.equal(f.calls.length,0);
});
