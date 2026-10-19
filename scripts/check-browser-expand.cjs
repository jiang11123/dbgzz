const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
require('../dist/main/main/main.js');
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      const accounts = await win.webContents.executeJavaScript('window.workspace.load().then(data => data.accounts)');
      assert.ok(accounts.length >= 2);
      await win.webContents.executeJavaScript(`window.workspace.openAccount(${accounts[0].id})`);
      await win.webContents.executeJavaScript('window.workspace.setBrowserFullscreen(true)');
      const check = () => {
        const [width, height] = win.getContentSize();
        assert.deepEqual(win.getBrowserViews()[0].getBounds(), { x: 0, y: 134, width, height: height - 134 });
      };
      check();
      await win.webContents.executeJavaScript(`window.workspace.openAccount(${accounts[1].id})`);
      check();
      // The split/sidebar layout was removed, so the native view is always full width.
      // Hiding it is the only remaining shrink behaviour left to verify.
      await win.webContents.executeJavaScript('window.workspace.hideBrowser()');
      assert.equal(win.getBrowserViews().length, 0);
      console.log('PASS: expanded view fills below the account bar; switching accounts preserves bounds; hiding removes the native view');
      app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
