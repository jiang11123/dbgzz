const { app, BrowserWindow } = require('electron');
// These checks assert the account-mode shell, which is no longer the default.
process.env.DOUBAO_APP_MODE = process.env.DOUBAO_APP_MODE || 'account';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-order-')));
process.env.CANVAS_BRIDGE_PORT = '0';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) { for (let i = 0; i < 80; i++) { if (await check()) return; await pause(50); } throw new Error('Timed out'); }
const timeout = setTimeout(() => app.exit(1), 20000);
let started = false;
app.on('browser-window-created', (_event, main) => {
  if (started) return; started = true;
  main.webContents.once('did-finish-load', async () => {
    try {
      const invoke = code => main.webContents.executeJavaScript(code);
      const accounts = (await invoke('window.workspace.load()')).accounts;
      await invoke(`window.workspace.openAccount(${accounts[1].id})`);
      await main.getBrowserViews()[0].webContents.loadURL('data:text/html,<p>selected account</p>');
      const currentPage = main.getBrowserViews()[0].webContents.id;
      await invoke('window.workspace.openSettings()');
      const settings = BrowserWindow.getAllWindows().find(win => win !== main);
      if (settings.webContents.isLoading()) await new Promise(resolve => settings.webContents.once('did-finish-load', resolve));
      const ui = code => settings.webContents.executeJavaScript(code);
      await waitFor(() => ui('Boolean(document.querySelector(".account-drag-handle"))'));
      const move = async (sourceIndex, targetIndex, before) => {
        await ui(`(() => {
          const rows=[...document.querySelectorAll('.account-setting')];
          const handle=rows[${sourceIndex}].querySelector('.account-drag-handle'), target=rows[${targetIndex}];
          const dataTransfer=new DataTransfer(), rect=target.getBoundingClientRect();
          const clientY=${before} ? rect.top+3 : rect.bottom-3;
          handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer}));
          target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer,clientY}));
          target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientY}));
          handle.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));
        })()`);
      };
      await move(4, 0, true);
      const expected = [accounts[4], ...accounts.slice(0, 4)];
      await waitFor(async () => (await invoke('window.workspace.load()')).accounts[0].id === accounts[4].id);
      await waitFor(async () => JSON.stringify(await ui('[...document.querySelectorAll(".account-setting")].map(row => row.querySelector("input").value)')) === JSON.stringify(expected.map(a => a.name)));
      assert.deepEqual(await invoke('[...document.querySelectorAll(".account-tabs .account")].map(n=>n.textContent)'), expected.map(a => a.name));
      assert.equal(main.getBrowserViews()[0].webContents.id, currentPage);
      assert.equal(await invoke('document.querySelector(".account-tabs .active").textContent'), accounts[1].name);
      await move(0, 4, false);
      await waitFor(async () => (await invoke('window.workspace.load()')).accounts.at(-1).id === accounts[4].id);
      const { WorkspaceDatabase } = require('../dist/main/main/database.js');
      const db = new WorkspaceDatabase();
      assert.deepEqual(db.accounts().map(a => a.id), accounts.map(a => a.id));
      db.moveAccount(accounts[3].id, accounts[0].id, true);
      assert.deepEqual(new WorkspaceDatabase().accounts().map(a => a.id), [accounts[3].id, accounts[0].id, accounts[1].id, accounts[2].id, accounts[4].id]);
      assert.throws(() => db.moveAccount(99999, accounts[0].id, true));
      assert.equal(db.accounts()[0].id, accounts[3].id);
      const added = db.createAccount({ name: 'append at end' });
      assert.equal(db.accounts().at(-1).id, added.id);
      db.deleteAccount(accounts[2].id);
      assert.deepEqual(new WorkspaceDatabase().accounts().map(a => a.id), [accounts[3].id, accounts[0].id, accounts[1].id, accounts[4].id, added.id]);
      console.log('PASS: settings drag/drop moves accounts up and down; toolbar synchronizes without changing active page; order survives reopen; invalid moves are rejected; new accounts append and deletion preserves remaining order');
      clearTimeout(timeout); app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../dist/main/main/main.js');
