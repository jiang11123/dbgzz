const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1480, height: 920 });
  try {
    const css = fs.readFileSync(path.join(__dirname, '../src/renderer/style.css'), 'utf8');
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style><main class="app-shell"><div class="download-notice completed"><div><b>视频已保存到视频库</b><span>shoujihao · 初二分班初见豆角.mp4</span></div></div></main>`));
    for (const fullscreen of [false, true]) {
      const bounds = await win.webContents.executeJavaScript(`(() => {
        document.querySelector('main').classList.toggle('browser-fullscreen', ${fullscreen});
        const r = document.querySelector('.download-notice').getBoundingClientRect();
        return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:innerWidth };
      })()`);
      const visible = fullscreen ? bounds.bottom <= 58 : bounds.right <= Math.round(bounds.width * .59);
      if (!visible || bounds.left < 0 || bounds.top < 0) throw new Error(`Notice overlaps BrowserView (${fullscreen ? 'fullscreen' : 'split'}): ${JSON.stringify(bounds)}`);
      console.log(`PASS: ${fullscreen ? 'fullscreen' : 'split'} notification is outside BrowserView`);
    }
    app.exit(0);
  } catch (error) { console.error(error.message); app.exit(1); }
});
