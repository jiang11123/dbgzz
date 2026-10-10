import { app, BrowserView, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import chokidar, { type FSWatcher } from 'chokidar';
import { WorkspaceDatabase } from './database';
import { ImageAssetStore } from './image-assets';
import { setupAccountSend } from './account-send';
import type { DownloadCandidate } from '../shared/types';
import { CanvasBridge } from './canvas-bridge';
import { DownloadTracker } from './download-tracker';
import { DoubaoShareService } from './doubao-share';
import { attachVideoContextMenu } from './video-context';
import { platformConfig } from './account-platform';
import { accountShortcut, normalizeAccountShortcut, shortcutFromKey } from '../shared/account-shortcuts';
import type { DownloadStatus } from '../shared/types';
import { UpscaleQueue, validateEligiblePaths, runCommand } from './video-upscale';
import type { UpscaleTarget } from '../shared/types';

function upscaleTools() {
  const portable = path.join(app.getAppPath(), 'tools', 'video2x', 'video2x.exe');
  return {
    video2x: db.getSetting('video2xPath') || process.env.VIDEO2X_PATH || (fs.existsSync(portable) ? portable : 'video2x'),
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH || 'ffprobe'
  };
}
async function ensureUpscaleTools() {
  const tools = upscaleTools();
  try {
    await Promise.all([runCommand(tools.video2x, ['--version']), runCommand(tools.ffprobe, ['-version']), runCommand(tools.ffmpeg, ['-version'])]);
  } catch { throw new Error('无法启动超分引擎。请在视频库配置 Video2X 6.x，并确保 FFmpeg / ffprobe 可用。'); }
}
const upscaleQueue = new UpscaleQueue(upscaleTools, () => {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('upscale:changed');
}, (job) => {
  db.recordUpscaleVideo(job.inputPath, job.outputPath!);
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('workspace:changed');
});

let windowRef: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let assetsWindow: BrowserWindow | null = null;
let donationWindow: BrowserWindow | null = null;
let imageAssets: ImageAssetStore;
let assetUploading = false;
const stagedImageAssets = new Map<number, string[]>();
const stagedImageUrls = new Map<number, string>();
let currentView: BrowserView | null = null;
let browserFullscreen = true;
let imageBarHeight = 76;
let accountBarHeight = 58;
let db: WorkspaceDatabase;
let downloadWatcher: FSWatcher | null = null;
let watchedDirectory = '';
const pendingDownloads = new Set<string>();
let canvasBridge: CanvasBridge | null = null;
let canvasDownloadPoll: NodeJS.Timeout | null = null;
const accountViews = new Map<number, BrowserView>();
const downloadTracker = new DownloadTracker();
const shareService = new DoubaoShareService();
let shareParsing = false;
const contextDownloads = new Set<string>();
function accountShortcuts(): Record<string, string> {
  try { const value = JSON.parse(db.getSetting('accountShortcuts') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function attachAccountShortcuts(contents: Electron.WebContents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isComposing || !windowRef || settingsWindow?.isVisible() || assetsWindow?.isVisible()) return;
    if (contents !== windowRef.webContents && contents !== currentView?.webContents) return;
    const shortcut = shortcutFromKey(input);
    if (!shortcut) return;
    const accounts = db.accounts(), custom = accountShortcuts();
    const index = accounts.findIndex((_account, index) => accountShortcut(index, custom) === shortcut);
    if (index < 0) return;
    event.preventDefault();
    if (input.isAutoRepeat) return;
    try { const view = openAccountBrowser(accounts[index].id); view?.webContents.focus(); }
    catch (error) { windowRef.webContents.send('browser:error', String(error)); }
  });
}

function rendererUrl() { return process.env.VITE_DEV_SERVER_URL || pathToFileURL(path.join(__dirname, '../../renderer/index.html')).toString(); }
function browserBounds() {
  if (!windowRef) return { x: 760, y: 106, width: 600, height: 600 };
  const [width, height] = windowRef.getContentSize();
  const top = accountBarHeight + imageBarHeight;
  return { x: 0, y: top, width, height: Math.max(1, height - top) };
}
function resizeBrowser() {
  if (!windowRef || !currentView?.webContents || currentView.webContents.isDestroyed()) return;
  currentView.setAutoResize({ width: false, height: false });
  currentView.setBounds(browserBounds());
  setImmediate(() => {
    if (windowRef && currentView?.webContents && !currentView.webContents.isDestroyed()) currentView.setBounds(browserBounds());
  });
}
function setBrowserFullscreen(value: boolean) {
  browserFullscreen = value;
  resizeBrowser();
  if (windowRef) windowRef.webContents.send('browser:fullscreen-changed', value);
}
function hideBrowser() { if (windowRef && currentView?.webContents && !currentView.webContents.isDestroyed()) windowRef.removeBrowserView(currentView); browserFullscreen = false; }
function attachCanvasDownloadHandler(accountId: number, view: BrowserView) {
  view.webContents.session.on('will-download', (_event, item) => {
    const name = item.getFilename();
    const sourceUrl = item.getURL();
    const notify = (status: DownloadStatus) => windowRef?.webContents.send('download:status', status);
    const tracked = downloadTracker.begin(accountId, sourceUrl);
    if (db.hasRecentManualDownload(accountId, name) || !tracked) {
      const options = {
        type: 'question' as const,
        title: '是否继续下载？',
        message: '检测到可能重复的下载，是否继续？',
        detail: `文件：${name}\n同一个任务中的不同视频也可能使用相同文件名。继续下载将另存一份，不覆盖已有文件。`,
        buttons: ['继续下载', '取消'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const choice = windowRef ? dialog.showMessageBoxSync(windowRef, options) : dialog.showMessageBoxSync(options);
      if (choice !== 0) {
        if (tracked) downloadTracker.finish(accountId, sourceUrl);
        item.cancel();
        notify({ state: 'failed', accountId, name, reason: '你已取消此次下载' });
        return;
      }
      if (!tracked) downloadTracker.begin(accountId, sourceUrl, true);
    }
    const directory = watchedDirectory || path.join(app.getPath('downloads'), 'DoubaoWorkspace');
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}-${name}`);
    item.setSavePath(target);
    for (const source of item.getURLChain()) canvasBridge?.trackDownload(accountId, source, target);
    notify({ state: 'started', accountId, name, path: target });
    item.once('done', (_doneEvent, state) => {
      if (state === 'completed') {
        const recorded = db.recordManualDownload(accountId, target, name);
        canvasBridge?.completeFromDownload(accountId, target);
        windowRef?.webContents.send('workspace:changed');
        notify(recorded ? { state: 'completed', accountId, name, path: target } : { state: 'duplicate', accountId, name, path: target, reason: '视频已在本地库中' });
      } else {
        canvasBridge?.failDownload(accountId, target);
        notify({ state: 'failed', accountId, name, reason: state === 'cancelled' ? '下载已取消' : '下载被中断' });
      }
      downloadTracker.finish(accountId, sourceUrl);
    });
  });
}
function openAccountBrowser(accountId: number, background = false, preloadOnly = false) {
  const account = db.accounts().find((a) => a.id === accountId); if (!account || !windowRef) return;
  const keepFullscreen = browserFullscreen;
  let view = accountViews.get(accountId);
  if (!view?.webContents || view.webContents.isDestroyed()) {
    view = new BrowserView({ webPreferences: { partition: account.sessionName, preload: path.join(__dirname, '../preload/video-context.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    accountViews.set(accountId, view);
    attachAccountShortcuts(view.webContents);
    attachCanvasDownloadHandler(accountId, view);
    if (account.platform === 'doubao') attachVideoContextMenu(view.webContents, () => view && windowRef?.getBrowserViews().includes(view) ? windowRef : null, async (target) => {
      const key = `${accountId}:${target.vid}`;
      const name = '选中的豆包视频';
      const notify = (status: DownloadStatus) => windowRef?.webContents.send('download:status', status);
      if (contextDownloads.has(key)) {
        notify({ state: 'duplicate', accountId, name, reason: '这个视频正在高清下载，请稍候' });
        return;
      }
      contextDownloads.add(key);
      notify({ state: 'started', accountId, name, reason: '正在获取无水印原视频' });
      try {

        const video = await shareService.resolveVideo(target);
        const directory = watchedDirectory || path.join(app.getPath('downloads'), 'DoubaoWorkspace');
        const saved = await shareService.save(video.id, directory);
        pendingDownloads.add(saved.path);
        db.recordShareDownload(saved.path, path.basename(saved.path));

        windowRef?.webContents.send('workspace:changed');
        notify({ state: 'completed', accountId, name: path.basename(saved.path), path: saved.path });
      } catch (error) {
        let reason = error instanceof Error ? error.message : '下载失败，请重新右键选择视频';
        if (/https?:\/\//.test(reason) || error instanceof SyntaxError || error instanceof TypeError) reason = '豆包暂未返回可用视频，请稍后重新右键下载';
        if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) reason = '下载超时，请检查网络后重试';
        notify({ state: 'failed', accountId, name, reason });
      } finally { contextDownloads.delete(key); }
    });
    // OAuth needs a real child window and its opener (postMessage + window.close).
    // Navigating the account page to the popup URL destroys that relationship.
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: windowRef ?? undefined,
          width: 640, height: 800, autoHideMenuBar: true,
          webPreferences: {
            partition: account.sessionName,
            contextIsolation: true, sandbox: true, nodeIntegration: false,
          },
        },
      };
    });
    view.webContents.on('did-create-window', (child) => {
      child.setMenuBarVisibility(false);
      child.on('closed', () => {
        // The provider closes only its own window. Keep Dola and its JS callback alive.
        if (view?.webContents && !view.webContents.isDestroyed() && currentView === view) {
          resizeBrowser();
          view.webContents.focus();
        }
      });
    });
    view.webContents.on('did-finish-load', () => { if (!db.accounts().some(item => item.id === accountId)) return; db.updateAccount(accountId, { isLoggedIn: true }); windowRef?.webContents.send('workspace:changed'); });
    void view.webContents.loadURL(platformConfig(account.platform, account.id).homeUrl).catch((error) => {
      windowRef?.webContents.send('browser:error', `${account.name} 网页加载失败：${error.message}`);
    });
  }
  // Warm pages without changing the selected account or covering the workspace.
  if (preloadOnly) return view;
  // Attach the replacement before detaching the previous view: failed creation must
  // not leave the workspace without a visible account page.
  if (background) {
    if (windowRef && !windowRef.getBrowserViews().includes(view)) windowRef.addBrowserView(view);
    view.setBounds(browserBounds());
    if (currentView && !currentView.webContents.isDestroyed()) windowRef.setTopBrowserView(currentView);
    return view;
  }
  const previousView = currentView;
  windowRef.addBrowserView(view);
  if (previousView?.webContents && previousView !== view && !previousView.webContents.isDestroyed()) windowRef.removeBrowserView(previousView);
  currentView = view;
  browserFullscreen = keepFullscreen;
  resizeBrowser();
  windowRef.setTopBrowserView(view);
  if (!view.webContents.isLoading() && !view.webContents.getURL()) {
    void view.webContents.loadURL(platformConfig(account.platform, account.id).homeUrl).catch((error) => windowRef?.webContents.send('browser:error', `${account.name} 网页加载失败：${error.message}`));
  }
  windowRef.webContents.send('browser:fullscreen-changed', browserFullscreen);
  windowRef.webContents.send('account:opened', accountId);
  return view;
}
function openDonationWindow() {
  if (!windowRef) return;
  if (donationWindow && !donationWindow.isDestroyed()) { donationWindow.show(); donationWindow.focus(); return; }
  const panel = new BrowserWindow({ parent: windowRef, modal: true, width: 420, height: 680,
    resizable: false, title: '打赏作者', autoHideMenuBar: true, backgroundColor: '#ffffff', show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  donationWindow = panel;
  const url = new URL(rendererUrl()); url.searchParams.set('panel', 'donation');
  void panel.loadURL(url.toString());
  panel.once('ready-to-show', () => { if (!panel.isDestroyed()) { panel.show(); panel.focus(); } });
  panel.on('closed', () => { donationWindow = null; });
}
function openSettingsWindow() {
  if (!windowRef) return;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    settingsWindow.moveTop();
    return;
  }
  const parent = windowRef;
  settingsWindow = new BrowserWindow({
    parent,
    width: 860,
    height: 700,
    minWidth: 680,
    minHeight: 480,
    autoHideMenuBar: true,
    backgroundColor: '#f7f9fc',
    title: '设置',
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.setAlwaysOnTop(true, 'pop-up-menu');
  const url = new URL(rendererUrl());
  url.searchParams.set('panel', 'settings');
  void settingsWindow.loadURL(url.toString());
  settingsWindow.once('ready-to-show', () => {
    if (!settingsWindow || settingsWindow.isDestroyed() || !windowRef) return;
    const bounds = windowRef.getBounds();
    const size = settingsWindow.getBounds();
    settingsWindow.setPosition(Math.round(bounds.x + (bounds.width - size.width) / 2), Math.round(bounds.y + (bounds.height - size.height) / 2));
    settingsWindow.show();
    settingsWindow.moveTop();
    settingsWindow.focus();
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}
function openImageAssets() {
  if (!windowRef) return;
  if (assetsWindow && !assetsWindow.isDestroyed()) { assetsWindow.show(); assetsWindow.focus(); return; }
  assetsWindow = new BrowserWindow({ parent: windowRef, width: 900, height: 720, minWidth: 620, minHeight: 480,
    title: '图片资产', autoHideMenuBar: true, backgroundColor: '#f7f9fc',
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const url = new URL(rendererUrl()); url.searchParams.set('panel', 'image-assets');
  void assetsWindow.loadURL(url.toString());
  assetsWindow.on('closed', () => { assetsWindow = null; });
}
async function useImageAssets(ids: string[], accountId: number) {
  if (assetUploading) throw new Error('正在添加图片，请稍候');
  if (!Array.isArray(ids) || !ids.length) throw new Error('请先选择图片');
  const files = [...new Set(ids)].map(id => imageAssets.resolve(id));
  const view = accountViews.get(accountId);
  if (!view || view !== currentView || view.webContents.isDestroyed()) throw new Error('当前账号已切换，请刷新后重试');
  if (view.webContents.isLoading()) throw new Error('请等待豆包页面加载完成');
  assetUploading = true;
  const client = view.webContents.debugger;
  const owned = !client.isAttached();
  try {
    // Select the enabled image input itself; do not open an OS file chooser.
    const target = await view.webContents.executeJavaScript(`(() => {
      const inputs = [...document.querySelectorAll('input[type=file]')];
      const eligible = inputs.filter(n => !n.disabled && (!n.accept || /image|png|jpg|jpeg|webp|gif/i.test(n.accept)));
      const input = eligible.find(n => n.accept && /image/i.test(n.accept)) || eligible[0];
      if (!input) return null;
      return { index: inputs.indexOf(input), multiple: input.multiple };
    })()`);
    if (!target) throw new Error('未找到图片上传入口，请先在豆包打开聊天或图片/视频生成输入框');
    if (files.length > 1 && !target.multiple) throw new Error('当前入口一次只能添加一张图片，请只选一张');
    if (owned) client.attach('1.3');
    const { root } = await client.sendCommand('DOM.getDocument');
    const { nodeIds } = await client.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
    const nodeId = nodeIds[target.index];
    if (!nodeId) throw new Error('上传入口发生变化，请重试');
    await client.sendCommand('DOM.setFileInputFiles', { nodeId, files });
    stagedImageAssets.set(accountId, [...new Set(ids)]);
    stagedImageUrls.set(accountId, view.webContents.getURL());
    return true;
  } finally { if (owned && client.isAttached()) client.detach(); assetUploading = false; }
}
function watchDownloads(directory: string) {
  downloadWatcher?.close(); watchedDirectory = directory; fs.mkdirSync(directory, { recursive: true }); db.setSetting('downloadDirectory', directory);
  downloadWatcher = chokidar.watch(directory, { ignoreInitial: true, depth: 0, awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 150 } });
  downloadWatcher.on('add', (filePath: string) => { if (/\.mp4$/i.test(filePath) && !pendingDownloads.has(filePath)) { pendingDownloads.add(filePath); windowRef?.webContents.send('download:detected', { path: filePath, name: path.basename(filePath) } satisfies DownloadCandidate); } });
}
function archiveDownload(taskId: number, sourcePath: string, accountId: number) {
  const task = db.task(taskId); if (!task) throw new Error('任务不存在');
  const project = db.project(task.projectId); if (!project) throw new Error('项目不存在');
  if (!fs.existsSync(sourcePath)) throw new Error('下载文件不存在');
  const extension = path.extname(sourcePath) || '.mp4'; const base = String(task.sceneNumber).padStart(2, '0');
  let destination = path.join(project.directory, 'videos', `${base}${extension}`); let suffix = 2;
  while (fs.existsSync(destination)) { destination = path.join(project.directory, 'videos', `${base}-${suffix}${extension}`); suffix++; }
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(sourcePath, destination);
  pendingDownloads.delete(sourcePath);
  canvasBridge?.completeFromDownload(accountId, destination);
  return db.completeTask(taskId, destination, accountId);
}
function notifyImageAssets() {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('image-assets:changed');
}
function quickImageIds(): string[] {
  try { const ids = JSON.parse(db.getSetting('quickImageIds') || '[]'); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
}
function orderedQuickImages() {
  const available = new Map(imageAssets.list().map(item => [item.id, item]));
  return [...new Set(quickImageIds())].flatMap(id => available.has(id) ? [available.get(id)!] : []);
}
function setupIpc() {
  ipcMain.handle('image-assets:quick-list', () => orderedQuickImages());
  ipcMain.handle('image-assets:quick-reorder', (event, requested: string[]) => {
    if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('无效的图片排序请求');
    const current = orderedQuickImages().map(item => item.id);
    if (!Array.isArray(requested) || requested.length !== current.length || new Set(requested).size !== current.length
      || requested.some(id => typeof id !== 'string' || !current.includes(id))) throw new Error('图片列表已改变，请重试排序');
    db.setSetting('quickImageIds', JSON.stringify(requested)); notifyImageAssets();
    return orderedQuickImages();
  });
  ipcMain.handle('image-assets:quick-add', (_event, requested: string[]) => {
    if (!Array.isArray(requested) || !requested.length) throw new Error('请先选择图片资产');
    for (const id of requested) imageAssets.resolve(id);
    const available = imageAssets.list();
    const ids = [...new Set([...quickImageIds().filter(id => available.some(item => item.id === id)), ...requested])];
    db.setSetting('quickImageIds', JSON.stringify(ids)); notifyImageAssets();
    return orderedQuickImages();
  });
  ipcMain.handle('image-assets:quick-remove', (_event, requested: string[]) => {
    if (!Array.isArray(requested)) throw new Error('请选择要移出的快捷预览');
    const ids = quickImageIds().filter(id => !requested.includes(id));
    db.setSetting('quickImageIds', JSON.stringify(ids)); notifyImageAssets();
    return orderedQuickImages();
  });
  ipcMain.on('image-assets:drag', (event, ids: string[]) => {
    try {
      if (!Array.isArray(ids) || !ids.length) return;
      const files = [...new Set(ids)].map(id => imageAssets.resolve(id));
      const icon = nativeImage.createFromPath(files[0]).resize({ width: 64, height: 64 });
      if (icon.isEmpty()) throw new Error('图片无法读取，请重新导入');
      event.sender.startDrag({ file: files[0], files, icon });
    } catch (error) { event.sender.send('browser:error', error instanceof Error ? error.message : String(error)); }
  });
  ipcMain.handle('image-assets:open', () => { openImageAssets(); return true; });
  ipcMain.handle('image-assets:list', () => ({ items: imageAssets.list(), accountId: [...accountViews].find(([, view]) => view === currentView)?.[0] ?? null }));
  ipcMain.handle('image-assets:import', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) throw new Error('资产窗口已关闭');
    const result = await dialog.showOpenDialog(owner, { properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    const items = result.canceled ? imageAssets.list() : imageAssets.import(result.filePaths);
    notifyImageAssets(); return items;
  });
  ipcMain.handle('image-assets:remove', (_event, id: string) => { const items = imageAssets.remove(id); notifyImageAssets(); return items; });
  ipcMain.handle('image-assets:use', (_event, ids: string[], accountId: number) => useImageAssets(ids, accountId));
  ipcMain.handle('share:parse', async (_event, text: string) => {
    if (shareParsing) return { error: '正在解析，请稍候' };
    shareParsing = true;
    try { return { result: await shareService.parse(text) }; }
    catch (error) { return { error: error instanceof Error ? error.message : '解析失败，请稍后重试' }; }
    finally { shareParsing = false; }
  });
  ipcMain.handle('share:save', async (_event, id: string) => {
    try {
      const directory = watchedDirectory || path.join(app.getPath('downloads'), 'DoubaoWorkspace');
      const saved = await shareService.save(id, directory);
      // The watcher ignores .part files; suppress the final rename notification too.
      pendingDownloads.add(saved.path);
      db.recordShareDownload(saved.path, path.basename(saved.path));
      windowRef?.webContents.send('workspace:changed');
      return { path: saved.path };
    } catch (error) { return { error: error instanceof Error ? error.message : '保存失败，请重试' }; }
  });
  ipcMain.handle('workspace:load', () => ({ accounts: db.accounts(), projects: db.projects(), dashboard: db.dashboard(), downloadDirectory: db.getSetting('downloadDirectory') || '', imageBarHeight, accountBarHeight, accountShortcuts: accountShortcuts() }));
  ipcMain.handle('settings:account-shortcut', (event, index: number, value: string) => {
    if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('只能在工作站设置快捷键');
    const accounts = db.accounts();
    if (!Number.isSafeInteger(index) || index < 0 || index >= accounts.length || typeof value !== 'string' || value.length > 60) throw new Error('快捷键设置无效');
    const shortcut = normalizeAccountShortcut(value), custom = accountShortcuts();
    const conflict = accounts.findIndex((_account, other) => other !== index && shortcut && accountShortcut(other, custom) === shortcut);
    if (conflict >= 0) throw new Error(`该快捷键已用于第 ${conflict + 1} 个账号，请先清除或更改它`);
    custom[String(index)] = shortcut; db.setSetting('accountShortcuts', JSON.stringify(custom));
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('workspace:changed');
    return custom;
  });
  ipcMain.handle('settings:account-shortcuts-reset', event => {
    if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('只能在工作站设置快捷键');
    db.setSetting('accountShortcuts', '{}');
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('workspace:changed');
    return {};
  });
  ipcMain.handle('browser:image-bar-height', (event, value: number, save: boolean) => {
    if (event.sender !== windowRef?.webContents || !Number.isFinite(value)) throw new Error('图片栏尺寸无效');
    const max = Math.min(360, Math.max(56, windowRef.getContentSize()[1] - accountBarHeight - 200));
    imageBarHeight = Math.round(Math.max(56, Math.min(max, value)));
    resizeBrowser();
    if (save) db.setSetting('imageBarHeight', String(imageBarHeight));
    return imageBarHeight;
  });
  ipcMain.handle('browser:account-bar-height', (event, value: number, save: boolean) => {
    if (event.sender !== windowRef?.webContents || !Number.isFinite(value)) throw new Error('账号栏尺寸无效');
    const max = Math.min(160, Math.max(42, windowRef.getContentSize()[1] - imageBarHeight - 200));
    accountBarHeight = Math.round(Math.max(42, Math.min(max, value)));
    resizeBrowser();
    if (save) db.setSetting('accountBarHeight', String(accountBarHeight));
    return accountBarHeight;
  });
  ipcMain.handle('videos:list', () => db.videoLibrary());
  ipcMain.handle('upscale:list', () => upscaleQueue.list());
  ipcMain.handle('upscale:start', async (_event, paths: string[], target: UpscaleTarget) => {
    const eligible = validateEligiblePaths(paths, db.videoLibrary().map(item => item.videoPath));
    await ensureUpscaleTools();
    return upscaleQueue.enqueue(eligible, target);
  });
  ipcMain.handle('upscale:cancel', () => upscaleQueue.cancel());
  ipcMain.handle('upscale:configure', async () => {
    const result = await dialog.showOpenDialog({ title: '选择 Video2X 6.x 命令行程序', properties: ['openFile'], filters: [{ name: 'Video2X', extensions: ['exe'] }] });
    if (result.canceled || !result.filePaths[0]) return '';
    await runCommand(result.filePaths[0], ['--version']);
    db.setSetting('video2xPath', result.filePaths[0]);
    return result.filePaths[0];
  });
  ipcMain.handle('accounts:update', (_e, id, patch) => { const next = db.updateAccount(id, patch); windowRef?.webContents.send('workspace:changed'); return next; });
  ipcMain.handle('accounts:move', (event, id: number, targetId: number, before: boolean) => {
    if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('只能在工作站窗口操作');
    const accounts = db.moveAccount(id, targetId, before);
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('workspace:changed');
    return accounts;
  });
  const deleteAccount = (id: number) => {
    if (db.accounts().length <= 1) throw new Error('至少保留一个账号');
    if (canvasBridge?.isBusy(id)) throw new Error('该账号正在生成视频，请任务完成后再删除');
    // Commit first; a failed delete must not close a working account page.
    const removed = db.deleteAccount(id);
    const view = accountViews.get(id);
    const wasCurrent = view != null && currentView === view;
    accountViews.delete(id); stagedImageAssets.delete(id); stagedImageUrls.delete(id);
    if (wasCurrent) { currentView = null; }
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('workspace:changed');
    if (view && !view.webContents.isDestroyed()) {
      if (windowRef && !windowRef.isDestroyed()) windowRef.removeBrowserView(view);
      view.webContents.close({ waitForBeforeUnload: false });
    }
    if (wasCurrent) {
      const next = db.accounts()[0];
      if (next) {
        try { openAccountBrowser(next.id); }
        catch (error) { windowRef?.webContents.send('browser:error', `账号已删除，打开下一个账号失败：${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    return removed;
  };
  ipcMain.handle('accounts:delete', (_event, id: number) => deleteAccount(id));
  ipcMain.handle('accounts:confirm-delete', async (event, id: number) => {
    const account = db.accounts().find(item => item.id === id);
    if (!account) throw new Error('账号不存在');
    if (db.accounts().length <= 1) throw new Error('至少保留一个账号');
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) throw new Error('设置窗口已关闭');
    const result = await dialog.showMessageBox(owner, { type: 'question', title: '删除账号',
      message: `确定删除 ${account.name}？`, detail: '该账号将从设置和顶部切换栏移除，已下载的视频保留。',
      buttons: ['取消', '删除账号'], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response !== 1) return false;
    return deleteAccount(id);
  });
  ipcMain.handle('accounts:create', (_e, data) => { const next = db.createAccount(data); windowRef?.webContents.send('workspace:changed'); return next; });
  ipcMain.handle('settings:open', () => { openSettingsWindow(); return true; });
  ipcMain.handle('donation:open', () => { openDonationWindow(); return true; });
  ipcMain.handle('accounts:open', (_e, id) => { if (!openAccountBrowser(id)) throw new Error('账号不存在或窗口尚未就绪'); return true; });
  ipcMain.handle('browser:hide', () => { hideBrowser(); return true; });
  ipcMain.handle('browser:set-fullscreen', (_e, value) => {
    if (!currentView?.webContents || currentView.webContents.isDestroyed() || !windowRef?.getBrowserViews().includes(currentView)) return false;
    setBrowserFullscreen(Boolean(value));
    return browserFullscreen;
  });
  ipcMain.handle('projects:create', (_e, name) => db.createProject(name));
  ipcMain.handle('tasks:list', (_e, projectId) => db.tasks(projectId));
  ipcMain.handle('tasks:create', (_e, data) => db.createTask(data));
  ipcMain.handle('tasks:update', (_e, id, patch) => db.updateTask(id, patch));
  ipcMain.handle('tasks:complete', (_e, id, videoPath, accountId) => archiveDownload(id, videoPath, accountId));
  ipcMain.handle('files:select-images', async () => (await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })).filePaths);
  ipcMain.handle('files:select-directory', async () => { const owner = BrowserWindow.getFocusedWindow() ?? windowRef ?? undefined; const result = owner ? await dialog.showOpenDialog(owner, { properties: ['openDirectory', 'createDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }); return result.filePaths[0] || ''; });
  ipcMain.handle('files:watch-downloads', (_e, directory) => { if (directory) watchDownloads(directory); return directory; });
  ipcMain.handle('files:open', (_e, target) => shell.openPath(target));
  ipcMain.handle('files:folder', (_e, target) => shell.showItemInFolder(target));
  ipcMain.handle('files:url', (_e, target) => pathToFileURL(target).toString());
  ipcMain.handle('assets:add', (_e, projectId, taskId, type, filePath) => db.addAsset(projectId, taskId, type, filePath));
}
function createWindow() {
  windowRef = new BrowserWindow({ width: 1480, height: 920, minWidth: 1100, minHeight: 700, backgroundColor: '#f7f9fc', title: 'Doubao Video Workspace', webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  attachAccountShortcuts(windowRef.webContents);
  windowRef.loadURL(rendererUrl());
  windowRef.webContents.once('did-finish-load', () => {
    // Stagger cold page starts so the visible account gets a head start.
    db.accounts().forEach((account, index) => {
      const timer = setTimeout(() => {
        if (!windowRef || windowRef.isDestroyed() || !db.accounts().some(item => item.id === account.id)) return;
        if (!accountViews.get(account.id)?.webContents.isDestroyed() && accountViews.has(account.id)) return;
        openAccountBrowser(account.id, true, true);
      }, 1200 + index * 500);
      timer.unref();
    });
  });
  windowRef.on('resize', resizeBrowser);
  windowRef.on('maximize', resizeBrowser);
  windowRef.on('unmaximize', resizeBrowser);
  windowRef.on('enter-html-full-screen', () => setBrowserFullscreen(true));
  windowRef.on('leave-html-full-screen', () => setBrowserFullscreen(false));
  windowRef.on('enter-full-screen', resizeBrowser);
  windowRef.on('leave-full-screen', resizeBrowser);
  windowRef.on('closed', () => { windowRef = null; currentView = null; });
}
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  db = new WorkspaceDatabase();
  imageBarHeight = Math.max(56, Math.min(360, Number(db.getSetting('imageBarHeight')) || 76));
  accountBarHeight = Math.max(42, Math.min(160, Number(db.getSetting('accountBarHeight')) || 58));
  imageAssets = new ImageAssetStore(path.join(app.getPath('userData'), 'image-assets'));
  setupIpc();
  const saved = db.getSetting('downloadDirectory');
  if (saved) watchDownloads(saved);
  canvasBridge = new CanvasBridge({
    accounts: () => db.accounts(),
    openAccount: (accountId) => openAccountBrowser(accountId, true) ?? null,
    viewForAccount: (accountId) => accountViews.get(accountId) ?? null,
    onTaskChanged: () => { windowRef?.webContents.send('workspace:changed'); },
  }, app.getPath('userData'));
  setupAccountSend({ accounts: () => db.accounts(), views: accountViews, current: () => currentView,
    main: () => windowRef, rendererUrl, preload: path.join(__dirname, '../preload/preload.js'), bridge: () => canvasBridge,
    assets: () => imageAssets, upload: useImageAssets, staged: stagedImageAssets, stagedUrls: stagedImageUrls,
    openAccount: (id, background) => openAccountBrowser(id, background) ?? null });
  canvasBridge.start(Number(process.env.CANVAS_BRIDGE_PORT || 3219));
  canvasDownloadPoll = setInterval(() => {
    for (const account of db.accounts()) void canvasBridge?.tryDownloadCompletedVideo(account.id);
  }, 3500);
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('before-quit', () => { upscaleQueue.cancel(); canvasBridge?.stop(); if (canvasDownloadPoll) clearInterval(canvasDownloadPoll); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

