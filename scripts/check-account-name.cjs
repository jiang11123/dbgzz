const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-name-')));
process.env.CANVAS_BRIDGE_PORT = '0';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => app.exit(1), 20000);
let started = false;
app.on('browser-window-created', (_event, main) => {
  if (started) return; started = true;
  main.webContents.once('did-finish-load', async () => {
    try {
      const invoke = code => main.webContents.executeJavaScript(code);
      const accounts = (await invoke('window.workspace.load()')).accounts;
      await invoke('window.workspace.openSettings()');
      const settings = BrowserWindow.getAllWindows().find(win => win !== main);
      if (settings.webContents.isLoading()) await new Promise(resolve => settings.webContents.once('did-finish-load', resolve));
      const ui = code => settings.webContents.executeJavaScript(code);
      for (let i = 0; i < 50 && !await ui('Boolean(document.querySelector(".account-setting input"))'); i++) await pause(50);
      await ui(`window.field=document.querySelector('.account-setting input');field.focus();field.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'nihao');field.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'nihao',inputType:'insertCompositionText'}));field.setSelectionRange(2,2);`);
      await pause(100);
      assert.equal((await invoke('window.workspace.load()')).accounts[0].name, accounts[0].name);
      // A refresh from another account must not overwrite the in-progress draft.
      await invoke(`window.workspace.updateAccount(${accounts[1].id},{note:'refresh during composition'})`);
      await pause(100);
      assert.equal(await ui('field.value'), 'nihao');
      assert.equal(await ui('field.selectionStart'), 2);
      await ui(`field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,isComposing:true}));`);
      assert.equal(await ui('document.activeElement===field'), true);
      await ui(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'你好');field.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'你好'}));field.dispatchEvent(new InputEvent('input',{bubbles:true,data:'你好'}));`);
      await pause(50);
      assert.equal((await invoke('window.workspace.load()')).accounts[0].name, accounts[0].name);
      await ui('field.blur()');
      await pause(150);
      assert.equal((await invoke('window.workspace.load()')).accounts[0].name, '你好');
      await ui(`field.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'  Alice  ');field.dispatchEvent(new InputEvent('input',{bubbles:true,data:'Alice'}));field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));`);
      await pause(150);
      assert.equal((await invoke('window.workspace.load()')).accounts[0].name, 'Alice');
      await ui(`field.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'   ');field.dispatchEvent(new InputEvent('input',{bubbles:true,data:' '}));field.blur();`);
      await pause(100);
      assert.equal((await invoke('window.workspace.load()')).accounts[0].name, 'Alice');
      assert.equal(await ui('field.value'), 'Alice');
      console.log('PASS: Chinese composition is not saved as pinyin; external refresh preserves draft and caret; IME Enter does not submit; blur saves Chinese; Enter saves trimmed English; empty names rejected');
      clearTimeout(timeout); app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../dist/main/main/main.js');
