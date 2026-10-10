const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'doubao-hotkeys-')));process.env.CANVAS_BRIDGE_PORT='0';
app.on('web-contents-created',(_e,wc)=>{const load=wc.loadURL.bind(wc);wc.loadURL=(url,opts)=>/^https:\/\/(www\.)?(doubao|dola)\.com\/?$/.test(url)?load('data:text/html,<textarea id="draft"></textarea>',opts):load(url,opts);});
const delay=ms=>new Promise(r=>setTimeout(r,ms));const wait=async(fn)=>{for(let i=0;i<100;i++){if(await fn())return;await delay(50);}throw new Error('timeout');};
const timeout=setTimeout(()=>app.exit(1),30000);let started=false;
app.on('browser-window-created',(_e,main)=>{if(started)return;started=true;main.webContents.once('did-finish-load',async()=>{try{
const run=s=>main.webContents.executeJavaScript(s);let accounts=(await run('window.workspace.load()')).accounts;
while(accounts.length<7){await run('window.workspace.createAccount({name:"added",note:"",platform:"doubao"})');accounts=(await run('window.workspace.load()')).accounts;}
const active=()=>run('document.querySelector(".account.active")?.textContent');
const press=(wc,key,modifiers)=>{wc.sendInputEvent({type:'keyDown',keyCode:key,modifiers});wc.sendInputEvent({type:'keyUp',keyCode:key,modifiers});};
await run(`window.workspace.openAccount(${accounts[0].id})`);const first=main.getBrowserViews()[0];await wait(()=>first.webContents.executeJavaScript('Boolean(document.querySelector("textarea"))'));await first.webContents.executeJavaScript('document.querySelector("textarea").value="保留草稿";document.querySelector("textarea").focus()');
press(first.webContents,'7',['alt']);await wait(async()=>await active()===accounts[6].name);assert.notEqual(main.getBrowserViews()[0],first);
press(main.webContents,'1',['alt']);await wait(()=>Promise.resolve(main.getBrowserViews()[0]===first));assert.equal(await first.webContents.executeJavaScript('document.querySelector("textarea").value'),'保留草稿');
await run('window.workspace.setAccountShortcut(1,"Ctrl+Alt+K")');
press(first.webContents,'K',['control','alt']);await wait(async()=>await active()===accounts[1].name);
const second=main.getBrowserViews()[0];press(second.webContents,'2',['alt']);await delay(80);assert.equal(main.getBrowserViews()[0],second);
await assert.rejects(run('window.workspace.setAccountShortcut(0,"Alt+3")'),/第 3 个账号/);
// Customization is persisted in SQLite and survives renderer reload.
const {WorkspaceDatabase}=require('../dist/main/main/database.js');assert.equal(JSON.parse(new WorkspaceDatabase().getSetting('accountShortcuts'))['1'],'Ctrl+Alt+K');
await run('window.workspace.openSettings()');const settings=BrowserWindow.getAllWindows().find(w=>w!==main);await wait(()=>settings.webContents.executeJavaScript('Boolean(document.querySelector(".account-shortcut-control"))'));
await settings.webContents.executeJavaScript('document.querySelectorAll(".account-shortcut-control input")[2].focus()');press(settings.webContents,'J',['control','shift']);
await wait(async()=>(await run('window.workspace.load()')).accountShortcuts['2']==='Ctrl+Shift+J');
await settings.webContents.executeJavaScript('document.querySelector(".account-setting").scrollIntoView()');await delay(80);fs.writeFileSync(path.join(app.getPath('userData'),'settings.png'),(await settings.webContents.capturePage()).toPNG());
assert.equal(await settings.webContents.executeJavaScript('document.querySelector(".account-shortcut-settings")'),null);
settings.close();await delay(80);press(second.webContents,'J',['control','shift']);await wait(async()=>await active()===accounts[2].name);
await run(`window.workspace.moveAccount(${accounts[6].id},${accounts[0].id},true)`);press(main.webContents,'1',['alt']);await wait(async()=>await active()===accounts[6].name);
await run('window.workspace.resetAccountShortcuts()');assert.deepEqual((await run('window.workspace.load()')).accountShortcuts,{});press(main.webContents,'2',['alt']);await wait(async()=>await active()===accounts[0].name);
console.log('PASS: default Alt+7 from chat input; Alt+1 from shell; custom combos in settings work immediately; duplicates rejected; persistent config; reorder follows position; reset and draft retention');console.log(path.join(app.getPath('userData'),'settings.png'));clearTimeout(timeout);app.quit();
}catch(e){console.error(e);app.exit(1);}});});require('../dist/main/main/main.js');
