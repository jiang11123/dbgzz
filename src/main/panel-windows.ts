import { BrowserWindow } from 'electron';

export interface PanelWindowsOptions {
  /** 主窗口；面板都以它为父窗口。 */
  main: () => BrowserWindow | null;
  icon: string;
  rendererUrl: () => string;
  preload: string;
}

/** 网关 / 赞赏 / 设置 / 图片资产四个子面板的单例窗口管理。 */
export function createPanelWindows(options: PanelWindowsOptions) {
  const { main, icon, rendererUrl, preload } = options;
  let gatewayWindow: BrowserWindow | null = null;
  let donationWindow: BrowserWindow | null = null;
  let settingsWindow: BrowserWindow | null = null;
  let assetsWindow: BrowserWindow | null = null;

  const panelUrl = (panel: string) => {
    const url = new URL(rendererUrl());
    url.searchParams.set('panel', panel);
    return url.toString();
  };
  const revive = (win: BrowserWindow | null): win is BrowserWindow => {
    if (!win || win.isDestroyed()) return false;
    win.show();
    win.focus();
    return true;
  };

  function openGateway() {
    const parent = main();
    if (!parent) return;
    if (revive(gatewayWindow)) return;
    gatewayWindow = new BrowserWindow({ icon, parent, width: 900, height: 760, minWidth: 720, minHeight: 520,
      title: 'API 网关', autoHideMenuBar: true, backgroundColor: '#f7f9fc',
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    void gatewayWindow.loadURL(panelUrl('gateway'));
    gatewayWindow.on('closed', () => { gatewayWindow = null; });
  }

  function openDonation() {
    const parent = main();
    if (!parent) return;
    if (revive(donationWindow)) return;
    const panel = new BrowserWindow({ icon, parent, modal: true, width: 420, height: 680,
      resizable: false, title: '赞赏奶蛙老师', autoHideMenuBar: true, backgroundColor: '#ffffff', show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
    donationWindow = panel;
    void panel.loadURL(panelUrl('donation'));
    panel.once('ready-to-show', () => { if (!panel.isDestroyed()) { panel.show(); panel.focus(); } });
    panel.on('closed', () => { donationWindow = null; });
  }

  function openSettings() {
    const parent = main();
    if (!parent) return;
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      settingsWindow.moveTop();
      return;
    }
    const win = new BrowserWindow({ icon, parent, width: 860, height: 700, minWidth: 680, minHeight: 480,
      autoHideMenuBar: true, backgroundColor: '#f7f9fc', title: '设置', show: false, alwaysOnTop: true,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    settingsWindow = win;
    win.setMenuBarVisibility(false);
    win.setAlwaysOnTop(true, 'pop-up-menu');
    void win.loadURL(panelUrl('settings'));
    win.once('ready-to-show', () => {
      const owner = main();
      if (win.isDestroyed() || !owner) return;
      const bounds = owner.getBounds();
      const size = win.getBounds();
      win.setPosition(Math.round(bounds.x + (bounds.width - size.width) / 2), Math.round(bounds.y + (bounds.height - size.height) / 2));
      win.show();
      win.moveTop();
      win.focus();
    });
    win.on('closed', () => { settingsWindow = null; });
  }

  function openImageAssets() {
    const parent = main();
    if (!parent) return;
    if (revive(assetsWindow)) return;
    assetsWindow = new BrowserWindow({ icon, parent, width: 900, height: 720, minWidth: 620, minHeight: 480,
      title: '图片资产', autoHideMenuBar: true, backgroundColor: '#f7f9fc',
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    void assetsWindow.loadURL(panelUrl('image-assets'));
    assetsWindow.on('closed', () => { assetsWindow = null; });
  }

  /** 设置 / 图片资产可见时，主窗口不应响应账号快捷键。 */
  function blocksAccountShortcuts() {
    return Boolean(settingsWindow?.isVisible() || assetsWindow?.isVisible());
  }

  return { openGateway, openDonation, openSettings, openImageAssets, blocksAccountShortcuts };
}
