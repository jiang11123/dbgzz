const { app, webContents } = require('electron');
// These checks assert the account-mode shell, which is no longer the default.
process.env.DOUBAO_APP_MODE = process.env.DOUBAO_APP_MODE || 'account';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-preload-')));
process.env.CANVAS_BRIDGE_PORT = '0';
const loads = new Map();
app.on('web-contents-created', (_event, contents) => {
  const load = contents.loadURL.bind(contents);
  contents.loadURL = (url, options) => {
    if (/^https:\/\/(www\.)?(doubao|dola)\.com\/?$/.test(url)) {
      loads.set(contents.id, (loads.get(contents.id) || 0) + 1);
      return load('data:text/html,<h1>Account fixture</h1><textarea id="draft"></textarea>', options);
    }
    return load(url, options);
  };
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
  for (let i = 0; i < 120; i++) { if (await check()) return; await delay(100); }
  throw new Error('Timed out waiting for preloaded account pages');
}
const timeout = setTimeout(() => app.exit(1), 20000);
let started = false;
app.on('browser-window-created', (_event, main) => {
  if (started) return; started = true;
  main.webContents.once('did-finish-load', async () => {
    try {
      const invoke = code => main.webContents.executeJavaScript(code);
      const accounts = (await invoke('window.workspace.load()')).accounts;
      await waitFor(() => loads.size === accounts.length);
      await waitFor(() => [...loads.keys()].every(id => !webContents.fromId(id).isLoading()));
      const activeTab = await invoke('document.querySelector(".account-tabs .active").textContent');
      assert.equal(activeTab, accounts[0].name);
      assert.equal(main.getBrowserViews().length, 1);
      assert.equal(await invoke('Boolean(document.querySelector(".sidebar,.content,.task-pane,.share-download"))'), false);
      assert.equal(await invoke('document.querySelector(".topbar").innerText.includes("去水印")'), false);
      assert.equal(await invoke('typeof window.workspace.parseShare'), 'function');
      const [width, height] = main.getContentSize();
      assert.deepEqual(main.getBrowserViews()[0].getBounds(), { x: 0, y: 134, width, height: height - 134 });
      for (const id of loads.keys()) assert.equal(webContents.fromId(id).getBackgroundThrottling(), false);
      await invoke(`window.workspace.openAccount(${accounts[1].id})`);
      const page = main.getBrowserViews()[0];
      const identity = page.webContents.id;
      await page.webContents.executeJavaScript('document.querySelector("#draft").value="unsent draft";window.auditMarker=42');
      for (let i = 0; i < 4; i++) {
        await invoke(`window.workspace.openAccount(${accounts[0].id})`);
        await invoke(`window.workspace.openAccount(${accounts[1].id})`);
      }
      assert.equal(main.getBrowserViews()[0].webContents.id, identity);
      const screenshot = path.join(app.getPath('userData'), 'light-workspace.png');
      main.showInactive();
      await delay(300);
      const handle = await invoke(`(() => { const r=document.querySelector('.image-bar-resizer').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
      main.focus();
      await delay(100);
      main.webContents.sendInputEvent({ type: 'mouseMove', ...handle });
      main.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...handle });
      for (let offset = 10; offset <= 100; offset += 10) {
        main.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: handle.x, y: handle.y + offset });
        await delay(25);
      }
      main.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: handle.x, y: handle.y + 100 });
      await waitFor(async () => (await invoke('window.workspace.load()')).imageBarHeight > 150);
      await delay(100);
      const barHeight = await invoke('document.querySelector(".image-assets-bar").getBoundingClientRect().height');
      assert.equal(await invoke('document.querySelector(".asset-bar-label small")'), null);
      assert.ok(await invoke('parseFloat(getComputedStyle(document.querySelector(".asset-bar-label")).fontSize)>13'));
      assert.ok(await invoke('parseFloat(getComputedStyle(document.querySelector(".asset-bar-controls button")).fontSize)>12'));
      assert.equal(main.getBrowserViews()[0].getBounds().y, 58 + barHeight);
      const { WorkspaceDatabase } = require('../dist/main/main/database.js');
      assert.equal(Number(new WorkspaceDatabase().getSetting('imageBarHeight')), barHeight);
      const { ImageAssetStore } = require('../dist/main/main/image-assets.js');
      const { nativeImage } = require('electron');
      const fixture = path.join(app.getPath('userData'), 'resize-fixture.png');
      fs.writeFileSync(fixture, nativeImage.createFromBitmap(Buffer.from([80,160,240,255]),{width:1,height:1}).toPNG());
      const image = new ImageAssetStore(path.join(app.getPath('userData'), 'image-assets')).import([fixture], true)[0];
      await invoke(`window.workspace.addQuickImages([${JSON.stringify(image.id)}])`);
      await waitFor(() => invoke('Boolean(document.querySelector(".asset-bar-thumb"))'));
      assert.equal(await invoke('document.querySelector(".asset-bar-thumb").getBoundingClientRect().height'), barHeight - 20);
      await invoke(`document.querySelector('.image-bar-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`);
      await waitFor(async () => (await invoke('window.workspace.load()')).imageBarHeight === barHeight - 10);
      assert.equal(await invoke('document.querySelector(".asset-bar-thumb").getBoundingClientRect().height'), barHeight - 30);
      await invoke(`document.querySelector('.image-bar-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
      await waitFor(async () => (await invoke('window.workspace.load()')).imageBarHeight === 76);
      assert.equal(main.getBrowserViews()[0].getBounds().y, 134);
      const accountFont = await invoke('parseFloat(getComputedStyle(document.querySelector(".account-tabs .account")).fontSize)');
      const accountHandle = await invoke(`(() => {const r=document.querySelector('.account-bar-resizer').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
      main.webContents.sendInputEvent({type:'mouseMove',...accountHandle});
      main.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...accountHandle});
      for (let offset=10;offset<=50;offset+=10) {
        main.webContents.sendInputEvent({type:'mouseMove',modifiers:['leftButtonDown'],x:accountHandle.x,y:accountHandle.y+offset});
        await delay(25);
      }
      main.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:accountHandle.x,y:accountHandle.y+50});
      await waitFor(async ()=>(await invoke('window.workspace.load()')).accountBarHeight>90);
      const accountHeight = await invoke('document.querySelector(".topbar").getBoundingClientRect().height');
      assert.equal(main.getBrowserViews()[0].getBounds().y,accountHeight+76);
      assert.ok(await invoke('parseFloat(getComputedStyle(document.querySelector(".account-tabs .account")).fontSize)')>accountFont);
      assert.equal(Number(new WorkspaceDatabase().getSetting('accountBarHeight')),accountHeight);
      await invoke(`document.querySelector('.account-bar-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
      await waitFor(async ()=>(await invoke('window.workspace.load()')).accountBarHeight===58);
      assert.equal(main.getBrowserViews()[0].getBounds().y,134);
      console.log('PASS: helper text removed; image-bar text/buttons scale; account-bar mouse resize scales tabs and persists height; browser follows both bars');
      console.log('PASS: real mouse drag resizes image bar and browser together; thumbnails resize; height is persisted; keyboard resize and double-click reset work');
      fs.writeFileSync(screenshot, (await main.webContents.capturePage()).toPNG());
      assert.ok(fs.statSync(screenshot).size > 0);
      console.log('Workspace screenshot: ' + screenshot);
      assert.equal(await page.webContents.executeJavaScript('document.querySelector("#draft").value'), 'unsent draft');
      assert.equal(await page.webContents.executeJavaScript('window.auditMarker'), 42);
      assert.ok([...loads.values()].every(count => count === 1));
      assert.equal(main.getBrowserViews().length, 1);
      await invoke('window.workspace.hideBrowser()');
      assert.equal(main.getBrowserViews().length, 0);
      await invoke(`window.workspace.openAccount(${accounts[1].id})`);
      assert.equal(main.getBrowserViews()[0].webContents.id, identity);
      console.log('PASS: all accounts preload without switching tabs; background throttling disabled; repeated switches reuse the same page without reloading or losing drafts; hide/restore remains correct');
      clearTimeout(timeout); app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../dist/main/main/main.js');
