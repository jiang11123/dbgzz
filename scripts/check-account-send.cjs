const {app,BrowserWindow,Menu,dialog,nativeImage,net,ipcMain}=require('electron');
// These checks assert the account-mode shell, which is no longer the default.
process.env.DOUBAO_APP_MODE = process.env.DOUBAO_APP_MODE || 'account';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),http=require('node:http');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'doubao-right-send-'));
app.setPath('userData',profile);process.env.CANVAS_BRIDGE_PORT='0';
const sourceImage=path.join(profile,'原图.png');fs.writeFileSync(sourceImage,nativeImage.createFromBitmap(Buffer.from([80,160,240,255]),{width:1,height:1}).toPNG());
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[sourceImage]});
// Generated inline: test fixtures must not depend on the gitignored exports/ directory.
const videoBytes=Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from('ftypmp42'),Buffer.alloc(1024,0x20)]);
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'video/mp4','content-length':videoBytes.length,'content-disposition':'attachment; filename=generated.mp4'});res.end(videoBytes);});server.listen(0,'127.0.0.1');
const menus=[];const build=Menu.buildFromTemplate;
Menu.buildFromTemplate=function(items){const menu=build.call(Menu,items);menu.popup=()=>{menus.push(menu);};return menu;};
const page=premium=>`<!DOCTYPE html><meta charset="utf-8"><style>body{font:16px sans-serif;padding:20px}#composer{position:absolute;left:30px;top:300px;width:650px}textarea{width:540px;height:120px}button{padding:10px;margin:4px}#send{position:absolute;right:0;top:110px}#params{display:none}.options{position:absolute;left:20px;top:200px;background:white;z-index:10}.options button{display:block}</style>
<button id="mode" onclick="setMode('video')">视频生成</button><button onclick="setMode('chat')">新对话</button><button>${premium?'VIP会员 · 剩余额度 300 秒':'免费账号'}</button>
<div id="history"><div data-message-id="1" data-message-role="user">猫咪穿绿色卫衣，兜帽盖住耳朵。</div><div data-message-id="2" data-message-role="assistant">第一个镜头已完成。</div></div>
<div id="composer"><button id="imageMode" onclick="setMode('image')">图片生成</button><div id="params"><button id="model" aria-label="模型" onclick="modelOptions()">Seedance 2.0 Fast</button><button id="ratio" onclick="ratioOptions()">16:9</button><button id="duration" onclick="durationOptions()">5 秒</button></div><textarea role="textbox" id="draft"></textarea><input type="file" accept="image/*" multiple><button id="send" aria-label="发送">发送</button></div>
<script>
window.sent=0;window.modeName='chat';window.filesChanged=0;
function closeOptions(){document.querySelectorAll('.options').forEach(n=>n.remove());}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeOptions();});
function setMode(mode){window.modeName=mode;document.getElementById('params').style.display=mode==='video'?'block':'none';document.getElementById('imageMode').setAttribute('aria-pressed',mode==='image'?'true':'false');}
function options(labels,fn){closeOptions();const box=document.createElement('div');box.className='options';labels.forEach(label=>{const button=document.createElement('button');button.setAttribute('role','option');button.textContent=label;button.onclick=()=>{fn(label);closeOptions();};box.appendChild(button);});document.body.appendChild(box);}
function modelOptions(){options(${JSON.stringify(premium?['Seedance 2.0 Fast','Seedance 2.5']:['Seedance 2.0 Fast'])},label=>{document.getElementById('model').textContent=label;document.getElementById('duration').textContent=label.includes('2.5')?'20 秒':'5 秒';});}
function durationOptions(){options(document.getElementById('model').textContent.includes('2.5')?['20 秒','30 秒']:['5 秒','10 秒'],label=>document.getElementById('duration').textContent=label);}
function ratioOptions(){options(['16:9','9:16','1:1'],label=>document.getElementById('ratio').textContent=label);}
document.querySelector('input').onchange=()=>{window.filesChanged++;for(const file of document.querySelector('input').files)file.arrayBuffer().then(bytes=>window.receivedImages.push(Array.from(new Uint8Array(bytes))));document.querySelectorAll('.attachment-preview').forEach(n=>n.remove());for(const file of document.querySelector('input').files){const img=document.createElement('img');img.className='attachment-preview';img.style.cssText='width:60px;height:60px;position:absolute;top:-65px;left:0';img.src=URL.createObjectURL(file);document.getElementById('composer').prepend(img);}};
window.receivedImages=[];window.syntheticPastes=0;document.addEventListener('paste',async event=>{window.syntheticPastes++;if(!event.isTrusted)return;if(event.clipboardData?.files.length){const existing=[...document.querySelectorAll('.attachment-preview')];const files=event.clipboardData.files;window.receivedImages.push(Array.from(new Uint8Array(await files[0].arrayBuffer())));document.querySelector('input').files=files;document.querySelector('input').onchange();for(const old of existing)document.getElementById('composer').insertBefore(old,document.querySelector('.attachment-preview'));document.querySelectorAll('.attachment-preview').forEach((n,i)=>n.style.left=(i*70)+'px');}});
document.getElementById('send').onclick=()=>{window.sent++;window.sentImages=document.querySelectorAll('.attachment-preview').length;document.querySelectorAll('.attachment-preview').forEach(n=>n.remove());const n=document.createElement('div');n.setAttribute('data-message-id','posted-'+window.sent);n.setAttribute('data-message-role','user');n.textContent=document.getElementById('draft').value;document.getElementById('history').appendChild(n);document.getElementById('draft').value='';};
</script>`;
const registered=new WeakSet();
app.on('web-contents-created',(_event,contents)=>{if(registered.has(contents.session))return;registered.add(contents.session);const premium=Boolean(contents.session.getStoragePath()?.includes('doubao_02'));
contents.session.protocol.handle('https',req=>new URL(req.url).hostname==='www.doubao.com'?new Response(page(premium),{headers:{'content-type':'text/html; charset=utf-8'}}):net.fetch(req,{bypassCustomProtocolHandlers:true}));});
const delay=ms=>new Promise(r=>setTimeout(r,ms));const wait=async(fn,message)=>{for(let n=0;n<160;n++){const value=await fn();if(value)return value;await delay(100);}throw new Error(message);};
const timeout=setTimeout(()=>{console.error('Timed out');app.exit(1);},65000);let started=false;
require('../dist/main/main/main.js');
app.on('browser-window-created',(_event,main)=>{if(started)return;started=true;main.webContents.once('did-finish-load',async()=>{try{
main.setBounds({x:0,y:0,width:1200,height:900});const invoke=code=>main.webContents.executeJavaScript(code);await invoke('window.testErrors=[];window.workspace.onBrowserError(text=>window.testErrors.push(text));true');const accounts=(await invoke('window.workspace.load()')).accounts;
await invoke(`window.workspace.openAccount(${accounts[0].id})`);const source=main.getBrowserViews()[0];await wait(()=>source.webContents.executeJavaScript('Boolean(document.getElementById("draft"))'),'source not ready');
// A browser-renderable BMP must be converted rather than rejected by signature checks.
const bmp=Buffer.alloc(58);bmp.write('BM');bmp.writeUInt32LE(58,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(1,18);bmp.writeInt32LE(1,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);bmp.writeUInt32LE(4,34);bmp[54]=60;bmp[55]=80;bmp[56]=250;
const {browserPngScript,decodeImageData}=require('../dist/main/main/image-data.js');
const converted=await source.webContents.executeJavaScript(browserPngScript('data:image/bmp;base64,'+bmp.toString('base64')));
const convertedFile=decodeImageData(converted);assert.equal(convertedFile.extension,'png');assert.deepEqual(nativeImage.createFromDataURL(converted).getSize(),{width:1,height:1});
const nativeClick=async(view,right=false)=>{const point=await view.webContents.executeJavaScript('(()=>{const r=document.getElementById("send").getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()');view.webContents.sendInputEvent({type:'mouseMove',...point});view.webContents.sendInputEvent({type:'mouseDown',button:right?'right':'left',clickCount:1,...point});view.webContents.sendInputEvent({type:'mouseUp',button:right?'right':'left',clickCount:1,...point});};
const rightMenu=async(references=[])=>{await invoke('window.workspace.setBrowserFullscreen(true)');const before=menus.length;const prompt=await source.webContents.executeJavaScript('document.getElementById("draft").value');ipcMain.emit('account-send:context',{sender:source.webContents},{prompt,references,previewCount:0});return wait(()=>menus.length>before?menus.at(-1):null,'captured draft menu missing');};
const choose=(menu,text)=>{const item=menu.items.find(n=>n.label.includes(text));assert.ok(item,`missing menu item ${text}: ${menu.items.map(i=>i.label)}`);item.click(item,main,{});return item;};
const findTarget=menu=>menu.items.find(n=>n.label.startsWith(accounts[1].name));
// No configured groups: all other accounts still appear as valid targets.
const image=(await invoke('window.workspace.importImageAssets()'))[0];await invoke(`window.workspace.useImageAssets(${JSON.stringify([image.id])},${accounts[0].id})`);
// No recognizable source thumbnails and an empty native input: asset originals must survive.
await source.webContents.executeJavaScript(`document.querySelector('input[type=file]').value='';document.querySelectorAll('img').forEach(n=>n.remove());`);
await source.webContents.executeJavaScript('document.getElementById("draft").value="发送给另一个账号的文字"');
const ordinary=await rightMenu();assert.ok(ordinary.items[0].label.includes('1 张图片'));assert.equal(ordinary.items.filter(i=>i.submenu).length,accounts.length-1);
choose(findTarget(ordinary).submenu,'同步到此账号');
const target=await wait(()=>main.getBrowserViews().find(view=>view!==source),'target not opened');await wait(()=>target.webContents.executeJavaScript('document.getElementById("draft").value==="发送给另一个账号的文字"'),'ordinary draft not imported');await delay(350);await target.webContents.executeJavaScript('document.getElementById("send").click()');
await delay(850);assert.equal(await source.webContents.executeJavaScript('window.sent'),0);assert.equal(await target.webContents.executeJavaScript('window.sentImages'),1);
assert.deepEqual(Buffer.from(await target.webContents.executeJavaScript('(async()=>Array.from(new Uint8Array(await document.querySelector("input[type=file]").files[0].arrayBuffer())))()')),fs.readFileSync(sourceImage));
// Only chat synchronization remains: no video controls or privileged video API.
assert.ok(ordinary.items.filter(i=>i.submenu).every(i=>i.submenu.items.length===2));
assert.equal(await invoke("typeof window.workspace.captureVideoDraft"),'undefined');
assert.equal(await invoke("typeof window.workspace.submitRoutedVideo"),'undefined');
assert.equal(await invoke("typeof window.workspace.readAccountCapabilities"),'undefined');
await invoke(`window.workspace.openAccount(${accounts[0].id})`);
await source.webContents.executeJavaScript('document.getElementById("draft").value="仅同步草稿"');
const staged=await rightMenu();choose(findTarget(staged).submenu,'同步到此账号');
await wait(()=>target.webContents.executeJavaScript('document.getElementById("draft").value==="仅同步草稿"'),'draft not synchronized');await delay(350);
assert.equal(await target.webContents.executeJavaScript('window.sent'),1);
assert.equal(await source.webContents.executeJavaScript('document.getElementById("draft").value'),'仅同步草稿');
await invoke(`window.workspace.openAccount(${accounts[0].id})`);
await source.webContents.executeJavaScript('document.getElementById("draft").value="保留目标原草稿"');
const blocked=await rightMenu();choose(findTarget(blocked).submenu,'发送到此账号');
await wait(()=>invoke('window.testErrors.some(s=>s.includes("未发送草稿"))'),'existing draft was not protected');
assert.equal(await target.webContents.executeJavaScript('document.getElementById("draft").value'),'仅同步草稿');
// Upload failure must block sending the text too.
await invoke(`window.workspace.openAccount(${accounts[2].id})`);
const failedTarget=await wait(()=>main.getBrowserViews().find(v=>v!==source && v!==target),'failure target not opened');
await wait(()=>failedTarget.webContents.executeJavaScript('Boolean(document.getElementById("draft"))'),'failure target not ready');
await failedTarget.webContents.executeJavaScript(`document.querySelector('input').onchange=()=>{document.querySelectorAll('.attachment-preview').forEach(n=>n.remove());if(document.querySelector('input').files.length){const warning=document.createElement('span');warning.textContent='上传失败';document.getElementById('composer').appendChild(warning);}};true`);
await invoke(`window.workspace.openAccount(${accounts[0].id})`);
const failureMenu=await rightMenu();const failedItem=failureMenu.items.find(n=>n.label.startsWith(accounts[2].name));choose(failedItem.submenu,'发送到此账号');
await wait(()=>invoke('window.testErrors.some(s=>s.includes("图片上传失败"))'),'image failure not reported');
assert.equal(await failedTarget.webContents.executeJavaScript('window.sent'),0);
assert.equal(await source.webContents.executeJavaScript('document.getElementById("draft").value'),'保留目标原草稿');
// Read two different images from a sent message, reorder in the real preview UI,
// and re-upload one by one to a fresh account via paste.
const secondBytes=convertedFile.bytes;
await invoke(`window.workspace.openAccount(${accounts[0].id})`);
await source.webContents.executeJavaScript(`(()=>{const m=document.createElement('div');m.setAttribute('data-message-id','images');m.setAttribute('data-message-role','user');for(const [i,src] of ${JSON.stringify([`data:image/png;base64,${fs.readFileSync(sourceImage).toString('base64')}`,`data:image/bmp;base64,${bmp.toString('base64')}`])}.entries()){const img=document.createElement(i===1?'div':'img');if(i===1)img.style.backgroundImage='url('+src+')';else img.src=src;img.alt='参考图'+(i+1);img.style.cssText+=';display:inline-block;width:60px;height:60px;margin-left:30px';m.appendChild(img);}document.getElementById('history').appendChild(m);})()`);
await source.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page(false)+'<!--automatic draft image-->'));
await invoke(`window.workspace.openAccount(${accounts[0].id})`);
await source.webContents.executeJavaScript(`(()=>{const img=document.createElement('img');img.src=${JSON.stringify('data:image/png;base64,'+fs.readFileSync(sourceImage).toString('base64'))};img.alt='automatic draft';img.className='attachment-preview';img.style.cssText='width:60px;height:60px;position:absolute;top:-65px;left:0';document.getElementById('composer').prepend(img);document.getElementById('draft').value='automatic image draft';})()`);
await target.webContents.executeJavaScript("document.getElementById('draft').value='';document.querySelectorAll('.attachment-preview').forEach(n=>n.remove());window.receivedImages=[];");
const automaticMenu=await rightMenu();
assert.deepEqual(findTarget(automaticMenu).submenu.items.map(item=>item.label),['发送到此账号','同步到此账号']);
assert.ok(automaticMenu.items[0].label.includes('1 张图片'));
choose(findTarget(automaticMenu).submenu,'同步到此账号');
await wait(()=>target.webContents.executeJavaScript('window.receivedImages.length===1'),'automatic draft image not synchronized');
assert.deepEqual(Buffer.from(await target.webContents.executeJavaScript('window.receivedImages[0]')),fs.readFileSync(sourceImage));
await wait(()=>target.webContents.executeJavaScript('document.getElementById("draft").value==="automatic image draft"'),'automatic image text missing');
assert.equal(await target.webContents.executeJavaScript('window.syntheticPastes'),0);
assert.equal(await invoke('document.querySelector(".topbar").innerText.includes("共享聊天")'), false);
assert.equal(await invoke('typeof window.workspace.openCollaboration'), 'undefined');
assert.equal(await invoke('typeof window.workspace.collaborationState'), 'undefined');
assert.equal(await invoke('document.body.innerText.includes("视频代发")'),false);
console.log('PASS: two-action account menu; automatic draft image synchronization retains original bytes; staged images, draft-only sync, send and draft protection verified');
clearTimeout(timeout);server.close();app.quit();
}catch(error){console.error(error);try{console.error(await main.webContents.executeJavaScript('window.testErrors'));for(const v of main.getBrowserViews()) console.error(await v.webContents.executeJavaScript('JSON.stringify({sent:window.sent,changes:window.filesChanged,sendRect:document.getElementById("send")?.getBoundingClientRect().toJSON(),size:[innerWidth,innerHeight],text:document.getElementById("draft")?.value,imgs:[...document.querySelectorAll("img")].map(n=>({complete:n.complete,w:n.naturalWidth,rect:n.getBoundingClientRect().toJSON()}))})'));}catch{}app.exit(1);}});});
