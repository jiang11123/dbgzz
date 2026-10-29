import type { BrowserView, BrowserWindow } from 'electron';

/** Each account needs its own native host: stacked views hide the lower editors. */
export class BackgroundPageHost {
  private hosts = new Map<BrowserView, BrowserWindow>();
  constructor(private readonly createWindow: () => BrowserWindow) {}

  attach(view: BrowserView) {
    if (view.webContents.isDestroyed()) throw new Error('账号窗口已关闭');
    // Lazy initialization also permits an in-process upgrade of an existing host.
    this.hosts ??= new Map();
    let host = this.hosts.get(view);
    if (!host || host.isDestroyed()) {
      host = this.createWindow();
      this.hosts.set(view, host);
    }
    if (!host.getBrowserViews().includes(view)) host.addBrowserView(view);
    view.setAutoResize({ width: false, height: false });
    view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
    return view;
  }

  detach(view: BrowserView) {
    const host = this.hosts?.get(view);
    this.hosts?.delete(view);
    if (host && !host.isDestroyed()) {
      if (host.getBrowserViews().includes(view)) host.removeBrowserView(view);
      host.destroy();
    }
  }

  destroy() {
    for (const view of [...(this.hosts?.keys() ?? [])]) this.detach(view);
  }
}
