const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-context-')));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { preload: path.join(root, 'dist/main/preload/video-context.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  try {
    const { captureVideoAtPoint, attachVideoContextMenu } = require('../dist/main/main/video-context');
    const html = `<div id="a"><img width="200" height="160" src="https://example.invalid/a.jpg"></div><div id="b"><img width="200" height="160" src="https://example.invalid/b.jpg"><span id="overlay" style="position:absolute;top:210px;left:50px">play</span></div><p id="text">ordinary text</p><div id="ambiguous"><video width="100" height="100"></video><video width="100" height="100"></video></div>`;
    await win.loadURL('data:text/html,' + encodeURIComponent(html));
    await win.webContents.executeJavaScript(`(() => {
      const video=(id)=>({vid:id,duration:4,videoModel:JSON.stringify({video_id:id,fallback_api:'https://vas-lf-x.snssdk.com/video/fplay/1/test/'+id+'?key_seed=test'})});
      document.querySelector('#a').__reactProps$test={children:{props:{video:video('video_A')}}};
      document.querySelector('#b').__reactProps$test={children:{props:{video:video('video_B')}}};
      document.querySelector('#ambiguous').__reactProps$test={children:[{props:{video:video('video_C')}},{props:{video:video('video_D')}}]};
    })()`);
    const capture = async (selector) => {
      const point = await win.webContents.executeJavaScript(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      return win.webContents.executeJavaScript(`(${captureVideoAtPoint.toString()})(${JSON.stringify(point)})`);
    };
    assert.equal((await capture('#a img')).vid, 'video_A');
    assert.equal((await capture('#b img')).vid, 'video_B');
    assert.equal((await capture('#overlay')).vid, 'video_B');
    assert.equal(await capture('#text'), null);
    assert.equal(await capture('#ambiguous video'), null);
    console.log('PASS: selected cover/overlay maps to its own video; text and ambiguous selection rejected');

    if (process.env.DOUBAO_CONTEXT_LIVE !== '1') { app.exit(0); return; }
    await win.loadURL('https://www.doubao.com/thread/xUF6vABXorRMawhRM');
    let point;
    for (let attempt = 0; attempt < 40; attempt++) {
      point = await win.webContents.executeJavaScript(`(() => { const img=Array.from(document.querySelectorAll('img')).find(e=>e.width>100&&e.height>100);if(!img)return null;const r=img.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      if (point) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(point, 'live video cover must load');
    let menu; const popup = Menu.prototype.popup;
    Menu.prototype.popup = function () { menu = this; };
    let downloaded;
    attachVideoContextMenu(win.webContents, () => win, async (target) => {
      const { DoubaoShareService } = require('../dist/main/main/doubao-share');
      const service = new DoubaoShareService();
      const video = await service.resolveVideo(target);
      downloaded = await service.save(video.id, path.join(root, 'exports/context-download'));
    });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'right', clickCount: 1 });
    for (let attempt=0; !menu && attempt<30; attempt++) await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(menu, 'native context menu created');
    const item = menu.items.find(item=>item.label==='高清下载');
    assert.ok(item?.enabled, 'clean download action enabled on selected video');
    await item.click();
    for(let attempt=0;!downloaded&&attempt<120;attempt++)await new Promise(resolve=>setTimeout(resolve,250));
    Menu.prototype.popup = popup;
    assert.ok(downloaded && fs.statSync(downloaded.path).size > 100000);
    assert.equal(downloaded.video.vid, 'v0369cg10004damh41i7dlddqb0o8chg');
    console.log('PASS: native right-click action downloaded the selected live video without clipboard');
    console.log('Saved:', downloaded.path);
    app.exit(0);
  } catch (error) { console.error(error.message); app.exit(1); }
});
