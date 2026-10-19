// Real Electron regression: no account data, network request, or generation is used.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { app, BrowserWindow, BrowserView } = require('electron');
const { BackgroundPageHost } = require('../dist/main/main/background-page-host.js');
const { waitForComposer, ensureComposerMode, readComposerSettings } = require('../dist/main/main/page-composer.js');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-background-host-'));
app.setPath('userData', data);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
console.log('BOOT');
const timeout = setTimeout(() => { console.error('FAIL: Electron host test timed out'); app.exit(1); }, 20000);
let host;
(async () => {
try {
  await app.whenReady(); console.log('READY');
  const view = new BrowserView({ webPreferences: { backgroundThrottling: false } });
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
  const html = '<html><body><button id="decoy" style="position:absolute;left:10px;top:240px"><svg><path d="M12 0 L12 10"></path></svg></button><textarea style="position:absolute;left:250px;top:200px;width:900px;height:80px"></textarea><button id="more" style="position:absolute;left:300px;top:300px">更多</button><script>document.getElementById("decoy").onclick=()=>{window.sidebarClicked=true};document.getElementById("more").onclick=()=>{if(document.getElementById("video"))return;const b=document.createElement("button");b.id="video";b.textContent="视频生成";b.style="position:absolute;left:400px;top:300px";b.onclick=()=>{b.textContent="模型 Seedance 2.0"};document.body.appendChild(b)};</script></body></html>';
  const loaded = view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await delay(1000); console.log('WARM_CREATED',view.webContents.isLoading());
  assert.equal(await view.webContents.executeJavaScript('innerWidth'), 0);
  const identity = view.webContents.id;
  let nativeHost;
  host = new BackgroundPageHost(() => {
    nativeHost = new BrowserWindow({ show: false, x: -10000, y: -10000, opacity: 0, focusable: false, skipTaskbar: true, width: 1280, height: 900, useContentSize: true });
    nativeHost.showInactive();
    return nativeHost;
  });
  host.attach(view); console.log('ATTACHED');
  await loaded; console.log('LOADED');
  await waitForComposer(view); console.log('COMPOSER_READY');
  assert.equal(nativeHost.getOpacity(), 0);
  assert.equal(nativeHost.isFocusable(), false);
  assert.equal(await view.webContents.executeJavaScript('document.hidden'), false);
  assert.equal(await view.webContents.executeJavaScript('innerWidth'), 1280);
  assert.equal((await readComposerSettings(view)).mode, 'chat');
  await ensureComposerMode(view, { mode: 'video' });
  assert.equal((await readComposerSettings(view)).mode, 'video');
  assert.equal(await view.webContents.executeJavaScript('Boolean(window.sidebarClicked)'), false);
  host.detach(view);
  const foreground = new BrowserWindow({ show: false, width: 1100, height: 700 });
  foreground.addBrowserView(view);
  await delay(100);
  assert.equal(view.webContents.id, identity);
  foreground.removeBrowserView(view);
  host.attach(view);
  assert.equal(view.webContents.id, identity);
  foreground.destroy();
  host.destroy();
  console.log('PASS: 0x0 warm page rendered at 1280x900; hidden trusted video click and foreground transfer verified');
  clearTimeout(timeout);
  app.exit(0);
} catch (error) {
  console.error(error);
  clearTimeout(timeout);
  host?.destroy();
  app.exit(1);
}
})();
