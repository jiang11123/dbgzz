// Uses an isolated database/session; never opens or changes existing account sessions.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-share-ui-'));
app.setPath('userData', path.join(testRoot, 'profile'));
const { WorkspaceDatabase } = require('../dist/main/main/database');
const { DoubaoShareService } = require('../dist/main/main/doubao-share');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1480, height: 1080, webPreferences: { preload: path.join(root, 'dist/main/preload/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  try {
    const db = new WorkspaceDatabase();
    const service = new DoubaoShareService();
    let hidden = false; let parsedCount = 0;
    ipcMain.handle('workspace:load', () => ({ accounts: db.accounts(), projects: db.projects(), dashboard: db.dashboard(), downloadDirectory: path.join(testRoot, 'videos') }));
    ipcMain.handle('videos:list', () => db.videoLibrary());
    ipcMain.handle('browser:hide', () => { hidden = true; return true; });
    ipcMain.handle('accounts:open', () => true);
    ipcMain.handle('browser:set-fullscreen', (_event, value) => Boolean(value));
    ipcMain.handle('files:url', (_event, target) => require('node:url').pathToFileURL(target).toString());
    ipcMain.handle('share:parse', async (_event, text) => {
      try { const result = await service.parse(text); parsedCount = result.videos.length; return { result }; }
      catch (e) { return { error: e.message }; }
    });
    ipcMain.handle('share:save', async (_event, id) => {
      try {
        const saved = await service.save(id, path.join(testRoot, 'videos'));
        db.recordShareDownload(saved.path, path.basename(saved.path));
        win.webContents.send('workspace:changed');
        return { path: saved.path };
      } catch (e) { return { error: e.message }; }
    });
    const evaluate = (code) => win.webContents.executeJavaScript(code);
    const waitFor = async (code, timeout = 70000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(code)) return; await pause(200); }
      const error = await evaluate(`document.querySelector('.share-error')?.textContent || ''`);
      throw new Error(`UI timed out: ${error || code}`);
    };
    await win.loadFile(path.join(root, 'dist/renderer/index.html'));
    await waitFor(`Array.from(document.querySelectorAll('nav button')).some(b => b.textContent === '豆包去水印')`, 15000);
    await evaluate(`document.querySelector('.account-tabs .account').click()`);
    await waitFor(`!document.querySelector('.browser-size-toggle').disabled`, 5000);
    await evaluate(`Array.from(document.querySelectorAll('nav button')).find(b => b.textContent === '豆包去水印').click()`);
    await waitFor(`Boolean(document.querySelector('#doubao-share-link'))`);
    assert.ok(hidden, 'native BrowserView must be hidden');
    assert.ok(await evaluate(`document.querySelector('.browser-size-toggle').disabled`), 'fullscreen toggle must be disabled while share page hides BrowserView');
    await evaluate(`(() => { const e = document.querySelector('#doubao-share-link'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, 'https://www.doubao.com/thread/xUF6vABXorRMawhRM'); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await evaluate(`Array.from(document.querySelectorAll('.share-actions button')).find(b=>b.textContent==='解析视频').click()`);
    await waitFor(`Boolean(document.querySelector('.share-video'))`);
    assert.equal(parsedCount, 1);
    await waitFor(`document.querySelector('.share-video video')?.readyState >= 2`, 30000);
    console.log('PASS: live share parsed and preview decoded');
    await evaluate(`document.querySelector('.share-video .primary').click()`);
    await waitFor(`Boolean(document.querySelector('.share-success'))`);
    const library = db.videoLibrary();
    assert.equal(library.length, 1);
    assert.ok(fs.statSync(library[0].videoPath).size > 100000);
    assert.equal(library[0].accountId, null);
    assert.equal('duration' in library[0], false);
    console.log('PASS: saved to video library without duration tracking');
    await evaluate(`document.querySelector('.share-video video').currentTime = 2`);
    await evaluate(`document.querySelector('.share-result-heading').scrollIntoView({block:'center'})`);
    await pause(700);
    fs.mkdirSync(path.join(root, 'exports/doubao-share'), { recursive: true });
    fs.writeFileSync(path.join(root, 'exports/doubao-share/workspace-preview.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector('.share-result-heading button').click()`);
    await waitFor(`Boolean(document.querySelector('.library-card'))`);
    console.log('PASS: video library displays the downloaded file');
    console.log('Test output:', testRoot);
    app.exit(0);
  } catch (error) { console.error(error.message); app.exit(1); }
});
