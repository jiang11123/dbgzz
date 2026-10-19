import type { BrowserView, BrowserWindow } from 'electron';

/** DOM automation needs a native host: an unattached BrowserView has a 0x0 viewport. */
export class BackgroundPageHost {
  private host: BrowserWindow | null = null;
  constructor(private readonly createWindow: () => BrowserWindow) {}

  attach(view: BrowserView) {
    if (view.webContents.isDestroyed()) throw new Error('账号窗口已关闭');
    if (!this.host || this.host.isDestroyed()) this.host = this.createWindow();
    if (!this.host.getBrowserViews().includes(view)) this.host.addBrowserView(view);
    view.setAutoResize({ width: false, height: false });
    view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
    return view;
  }

  detach(view: BrowserView) {
    if (this.host && !this.host.isDestroyed() && this.host.getBrowserViews().includes(view)) this.host.removeBrowserView(view);
  }

  destroy() {
    const host = this.host;
    this.host = null;
    if (host && !host.isDestroyed()) host.destroy();
  }
}
