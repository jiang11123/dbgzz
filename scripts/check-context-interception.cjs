const { app, BrowserWindow, Menu, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-context-intercept-')));
app.whenReady().then(async () => {
  try {
    const { attachVideoContextMenu } = require('../dist/main/main/video-context');
    const partition = session.fromPartition('context-interception');
    await partition.protocol.handle('https', () => new Response(`<html><body><div id="card"><video style="width:240px;height:200px"></video><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E" style="position:absolute;left:8px;top:8px;width:240px;height:200px"><span style="position:absolute;left:60px;top:60px">play</span></div><script>
      window.blocked=0;
      window.addEventListener('contextmenu',e=>{window.blocked++;e.preventDefault();e.stopImmediatePropagation()},true);
      document.querySelector('#card').__reactProps$test={children:{props:{video:{vid:'selected_video',duration:4,videoModel:JSON.stringify({video_id:'selected_video',fallback_api:'https://vas-lf-x.snssdk.com/video/fplay/1/test/selected_video?key_seed=test'})}}}};
      </script></body></html>`, { headers: { 'content-type': 'text/html' } }));
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { session: partition, preload: path.resolve(__dirname, '../dist/main/preload/video-context.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    let menus = 0; let selected; const actions = [];
    const popup = Menu.prototype.popup;
    Menu.prototype.popup = function () { menus++; assert.deepEqual(this.items.map(item=>item.label), ['高清下载']); for (const label of ['高清下载']) { const item = this.items.find(item=>item.label===label); assert.ok(item?.enabled, label + ' must be available'); item.click(); } };
    attachVideoContextMenu(win.webContents, () => win, async (video, target) => { selected=video.vid; actions.push({ vid: video.vid, target }); });
    await win.loadURL('https://www.doubao.com/chat/test');
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 70, y: 65, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 70, y: 65, button: 'right', clickCount: 1 });
    await new Promise(resolve=>setTimeout(resolve,600));
    assert.equal(menus,1,'actual right-click must open exactly one menu despite page interception');
    assert.equal(selected,'selected_video','menu action targets the clicked video');
    assert.deepEqual(actions.map(a=>a.target), [undefined]);
    assert.ok(actions.every(a=>a.vid==='selected_video'));
    assert.equal(await win.webContents.executeJavaScript('typeof window.require'), 'undefined');
    assert.equal(await win.webContents.executeJavaScript('typeof window.ipcRenderer'), 'undefined');
    await win.reload();
    await new Promise(resolve=>setTimeout(resolve,500));
    selected=null;
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 100, y: 120, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 100, y: 120, button: 'right', clickCount: 1 });
    await new Promise(resolve=>setTimeout(resolve,600));
    assert.equal(menus,2,'listener survives reload without duplicate menus');
    assert.equal(selected,'selected_video');
    Menu.prototype.popup=popup;
    console.log('PASS: real mouse right-click on overlay and video survives page preventDefault, remains isolated, works after reload');
    app.exit(0);
  } catch (e) { console.error(e.message); app.exit(1); }
});
