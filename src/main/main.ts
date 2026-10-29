import { app, BrowserView, BrowserWindow, dialog, ipcMain, Menu, Notification } from 'electron';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import chokidar, { type FSWatcher } from 'chokidar';
import { WorkspaceDatabase } from './database';
import { ImageAssetStore } from './image-assets';
import { setupAccountSend } from './account-send';
import type { DownloadCandidate, GatewayAttachment } from '../shared/types';
import { CanvasBridge, videoConversationForAccount } from './canvas-bridge';
import { BackgroundPageHost } from './background-page-host';
import { syncVideoTaskToChat, recoverLegacyVideoLink, forwardVideoChatMessage } from './video-chat-sync';
import { DoubaoGateway } from './gateway';
import { createGatewayChat, extractMediaUrls } from './gateway-chat';
import { resolveStagedAttachments } from './staged-attachments';
import { generateImages } from './doubao-image';
import { uploadImageToDoubao } from './doubao-upload';
import { waitForPageReady, streamChat } from './doubao-api';
import { waitForComposer } from './page-composer';
import { DownloadTracker } from './download-tracker';
import { DoubaoShareService } from './doubao-share';
import { attachVideoContextMenu, captureLatestVideo } from './video-context';
import { platformConfig } from './account-platform';
import { accountShortcut, shortcutFromKey } from '../shared/account-shortcuts';
import type { DownloadStatus } from '../shared/types';
import { syncAccountsToBeefTv, launchNativeBeefTv, hostedModelConfigNeedsCleanup } from './beeftv-sync';
import { BeefTvHost } from './beeftv-host';
import { beeftvWebDist, beeftvBackendExe, beeftvPluginDir } from './beeftv-paths';
import { createPanelWindows } from './panel-windows';
import { registerImageAssetsIpc } from './ipc-image-assets';
import { registerFilesIpc } from './ipc-files';
import { registerWorkspaceIpc } from './ipc-workspace';
import { broadcast } from './broadcast';
import { autoUpdater } from 'electron-updater';
import { AppUpdateService } from './app-update';

// Prevent GPU crashes on machines with conflicting GPU drivers
app.disableHardwareAcceleration();

// 主进程全局兜底：单点异步异常（如任务执行中账号视图恰好被销毁导致 capturePage reject）
// 不允许打崩整个应用——崩溃时 beeftv-backend 子进程无人回收，还会留下端口占用连锁故障。
process.on('uncaughtException', (error) => { console.error('[main] uncaughtException:', error); });
process.on('unhandledRejection', (reason) => { console.error('[main] unhandledRejection:', reason); });

// 豆包 3.0：固定 userData 为 doubao-video-workspace（与开发版一致）。
// 打包版 productName 会把 userData 指到中文目录，导致已登录账号、
// 会话分区（persist:doubao_XX）与 BeefTV 数据全部"丢失"——这里显式继承。
if (app.name !== 'doubao-video-workspace' && !process.env.DBGZZ_KEEP_USERDATA) {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'doubao-video-workspace'));
  } catch { /* 保持默认 */ }
}

const workspaceIcon = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(app.getAppPath(), 'build/icon.png');

let windowRef: BrowserWindow | null = null;
let appUpdates: AppUpdateService;
let imageAssets: ImageAssetStore;
let assetUploading = false;
const stagedImageAssets = new Map<number, string[]>();
const stagedImageUrls = new Map<number, string>();
let currentView: BrowserView | null = null;
let activeAccountId: number | null = null;
let browserFullscreen = true;
let imageBarHeight = 76;
let accountBarHeight = 58;
let db: WorkspaceDatabase;
let downloadWatcher: FSWatcher | null = null;
let watchedDirectory = '';
const pendingDownloads = new Set<string>();
let canvasBridge: CanvasBridge | null = null;
let gateway: DoubaoGateway | null = null;
// Gateway-mode chat service; wired after the database exists.
let gatewayChat: ReturnType<typeof createGatewayChat>;
let canvasDownloadPoll: NodeJS.Timeout | null = null;
let captchaProbePoll: NodeJS.Timeout | null = null;
const probeInFlight = new Set<number>();
let lastImageAccountId: number | null = null;
let lastImageConversationId: string | null = null;
let lastVideoAccountId: number | null = null;
// Chat requests that timed out but whose bridge task is still rendering; when the
// task completes, the finished video is attached to the original chat message.
const pendingChatVideos = new Map<string, number>();
const accountViews = new Map<number, BrowserView>();
// 豆包 3.0：BeefTV 宿主（静态服务 + /api 代理 + 后端子进程）；主窗口加载原生 BeefTV。
let beeftvHost: BeefTvHost | null = null;
let beeftvDataDir = '';
const scanWindows = new Map<number, BrowserWindow>();
const backgroundPages = new BackgroundPageHost(() => {
  // show:false alone stalls Doubao's animation/resize-driven editor initialization.
  // A transparent, non-focusable off-screen host renders without covering the chat.
  const host = new BrowserWindow({ icon: workspaceIcon,
    show: false, x: -10000, y: -10000, width: 1280, height: 900, useContentSize: true,
    opacity: 0, focusable: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  host.showInactive();
  return host;
});
const downloadTracker = new DownloadTracker();
const shareService = new DoubaoShareService();
let shareParsing = false;
const contextDownloads = new Set<string>();
function accountShortcuts(): Record<string, string> {
  try { const value = JSON.parse(db.getSetting('accountShortcuts') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function attachAccountShortcuts(contents: Electron.WebContents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isComposing || !windowRef || panels.blocksAccountShortcuts()) return;
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
const panels = createPanelWindows({ main: () => windowRef, icon: workspaceIcon, rendererUrl, preload: path.join(__dirname, '../preload/preload.js') });
function browserBounds() {
  if (!windowRef) return { x: 760, y: 106, width: 600, height: 600 };
  const [width, height] = windowRef.getContentSize();
  const top = accountBarHeight;
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
/**
 * 豆包 3.0：账号页面只在需要人工介入（扫码登录 / 人机验证）时以独立小窗呈现。
 * 平时会话由后台隐身保活；主窗口始终是原生 BeefTV 画布。
 */
function hostAccountInScanWindow(account: { id: number; name: string; platform: string }, view: BrowserView, wasLoggedIn: boolean) {
  // 从后台隐藏窗口彻底分离，避免双重宿主抢夺 view
  backgroundPages.detach(view);
  const existing = scanWindows.get(account.id);
  if (existing && !existing.isDestroyed()) {
    if (!existing.getBrowserViews().includes(view)) existing.addBrowserView(view);
    fitScanView(existing, view);
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    icon: workspaceIcon,
    width: 520,
    height: 760,
    minWidth: 400,
    minHeight: 520,
    title: `${account.name} · 豆包`,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    useContentSize: true,
    webPreferences: { contextIsolation: true },
  });
  scanWindows.set(account.id, win);
  win.addBrowserView(view);
  fitScanView(win, view);
  win.on('resize', () => { if (!win.isDestroyed()) fitScanView(win, view); });
  win.once('ready-to-show', () => { if (!win.isDestroyed()) fitScanView(win, view); });
  setImmediate(() => { if (!win.isDestroyed()) fitScanView(win, view); });
  // 扫码成功探测：出现会话 Cookie 即视为已登录 → 落库、同步 BeefTV、自动收起。
  const cookieTimer = setInterval(() => {
    if (win.isDestroyed() || !view.webContents || view.webContents.isDestroyed()) { clearInterval(cookieTimer); return; }
    void view.webContents.session.cookies.get({ url: 'https://www.doubao.com' }).then(cookies => {
      if (!cookies.some(item => item.name === 'sessionid' || item.name === 'sid_guard')) return;
      clearInterval(cookieTimer);
      db.updateAccount(account.id, { isLoggedIn: true });
      windowRef?.webContents.send('workspace:changed');
      void syncAccountsToBeefTv(db.accounts(), ensureGatewayApiKey(), { hostBaseUrl: beeftvHost?.url, gatewayBaseUrl: gateway?.url });
      if (!wasLoggedIn) setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 1500);
    }).catch(() => undefined);
  }, 2000);
  win.on('closed', () => {
    clearInterval(cookieTimer);
    scanWindows.delete(account.id);
    // 独立窗口关闭后，如果任务需要，重新挂回后台隐藏宿主继续执行
    if (view?.webContents && !view.webContents.isDestroyed()) {
      try { backgroundPages.attach(view); } catch { /* ignore */ }
    }
  });
  win.show();
  win.focus();
}

/** 触发人机安全验证时，自动把该账号的独立页面窗口弹到前台供用户手动拖动滑块完成验证。 */
function popupAccountForCaptcha(accountId: number, _reason = '检测到人机验证，请手动完成验证') {
  const account = db.accounts().find((a) => a.id === accountId);
  if (!account) return;
  const existingWin = scanWindows.get(accountId);
  if (existingWin && !existingWin.isDestroyed() && existingWin.isVisible()) {
    return;
  }
  const view = openAccountBrowser(accountId);
  const win = scanWindows.get(accountId);
  if (win && !win.isDestroyed()) {
    win.setTitle(`⚠️ ${account.name || `账号${accountId}`} · 请完成人机安全验证`);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (Notification.isSupported()) {
      try {
        new Notification({
          title: `豆包账号【${account.name || `账号${accountId}`}】需要人机验证`,
          body: '已为您自动弹出验证窗口，请在窗口中手动完成滑块验证。',
        }).show();
      } catch { /* ignore notification error */ }
    }
  }
}

function fitScanView(win: BrowserWindow, view: BrowserView) {
  if (win.isDestroyed() || !view.webContents || view.webContents.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  view.setAutoResize({ width: true, height: true });
  view.setBounds({ x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) });
}

function openAccountBrowser(accountId: number, background = false, preloadOnly = false) {
  const account = db.accounts().find((a) => a.id === accountId); if (!account || !windowRef) return;
  let view = accountViews.get(accountId);
  if (!view?.webContents || view.webContents.isDestroyed()) {
    view = new BrowserView({ webPreferences: { partition: account.sessionName, preload: path.join(__dirname, '../preload/video-context.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
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
    view.webContents.on('did-finish-load', () => {
      if (!db.accounts().some(item => item.id === accountId)) return;
      if (account.platform !== 'doubao') {
        db.updateAccount(accountId, { isLoggedIn: true });
        windowRef?.webContents.send('workspace:changed');
        return;
      }
      // 登录态以会话 Cookie 为准：被踢到登录页/会话过期时置 false，账号池才会把
      // 失效账号摘出调度（旧实现无条件写 true，登录态检查形同虚设）。只在值变化
      // 时写库+广播，避免登录页跳转频繁触发 IPC 风暴。
      void view?.webContents.session.cookies.get({ url: 'https://www.doubao.com' }).then((cookies) => {
        const loggedIn = cookies.some(item => item.name === 'sessionid' || item.name === 'sid_guard');
        const current = db.accounts().find(item => item.id === accountId);
        if (!current || current.isLoggedIn === loggedIn) return;
        db.updateAccount(accountId, { isLoggedIn: loggedIn });
        windowRef?.webContents.send('workspace:changed');
      }).catch(() => undefined);
    });
    void view.webContents.loadURL(platformConfig(account.platform, account.id).homeUrl).catch((error) => {
      windowRef?.webContents.send('browser:error', `${account.name} 网页加载失败：${error.message}`);
    });
  }
  // Warm pages without changing the selected account or covering the workspace.
  if (preloadOnly) return view;
  backgroundPages.detach(view);
  // 豆包 3.0：不再把账号页叠加进主窗口（主窗口已是原生 BeefTV），
  // 改由独立扫码小窗承载；后台会话继续由 accountViews 隐身保活。
  currentView = view;
  activeAccountId = accountId;
  hostAccountInScanWindow(account, view, Boolean(account.isLoggedIn));
  windowRef?.webContents.send('account:opened', accountId);
  return view;
}
/**
 * Returns a warmed account view for background work, WITHOUT showing it.
 *
 * Gateway requests must not yank the user out of the chat into an account page. An
 * unattached BrowserView still signs and fetches correctly (verified: frontierSign ok
 * and image generation ok on an unattached view), so there is no need to attach it. The
 * DOM-driven video work is different: it needs a nonzero viewport and uses
 * ensureVideoAccountView with a hidden native host. Visible screenshots remain
 * guarded separately by the bridge's isViewAttached check.
 */
function ensureAccountView(accountId: number): BrowserView | null {
  const existing = accountViews.get(accountId);
  if (existing?.webContents && !existing.webContents.isDestroyed()) return existing;
  // Warm the page in the background: preloadOnly keeps it out of the window.
  return openAccountBrowser(accountId, true, true) ?? null;
}

/**
 * Ensures the account page is opened to a clean new chat session before initiating a new turn.
 */
async function prepareAccountNewConversation(accountId: number): Promise<void> {
  const view = ensureAccountView(accountId);
  if (!view?.webContents || view.webContents.isDestroyed()) {
    throw new Error('账号页面不可用，请确认该账号已登录');
  }
  const currentUrl = view.webContents.getURL() || '';
  const isCleanNewChat = /^https?:\/\/(?:www\.)?doubao\.com\/chat\/?(?:[?#]|$)/i.test(currentUrl);
  if (!isCleanNewChat) {
    await view.webContents.loadURL('https://www.doubao.com/chat/');
  } else {
    // If already on /chat/, try clicking "开启新对话" / "新对话" button if available, or reload /chat/
    const clicked = await view.webContents.executeJavaScript(`(() => {
      try {
        const btns = [...document.querySelectorAll('button, [role="button"], a')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const btn = btns.find(el => {
          const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          return /^(?:开启)?新对话$/i.test(t);
        });
        if (btn) { btn.click(); return true; }
      } catch {}
      return false;
    })()`).catch(() => false);
    if (!clicked) {
      await view.webContents.loadURL('https://www.doubao.com/chat/').catch(() => undefined);
    }
  }
  await waitForPageReady(view);
  await waitForComposer(view).catch(() => undefined);
}

/**
 * Synchronizes the background account view to the active conversation URL so that
 * when switching to account mode, the user sees the newly created conversation.
 */
async function syncAccountConversationPage(accountId: number, conversationId: string): Promise<void> {
  if (!conversationId || conversationId.startsWith('local_')) return;
  const view = accountViews.get(accountId);
  if (!view?.webContents || view.webContents.isDestroyed()) return;
  const currentUrl = view.webContents.getURL() || '';
  if (!currentUrl.includes(conversationId)) {
    const targetUrl = `https://www.doubao.com/chat/${conversationId}`;
    await view.webContents.loadURL(targetUrl).catch(() => undefined);
  }
}

/** Keep DOM-driven video work rendered without covering the gateway chat. */
function ensureVideoAccountView(accountId: number): BrowserView | null {
  const view = ensureAccountView(accountId);
  if (!view) return null;
  if (windowRef?.getBrowserViews().includes(view)) return view;
  // 如果该账号当前正在独立窗口（如人机验证弹窗或登录窗口）中向用户展示，不能偷回后台隐藏窗口
  const scanWin = scanWindows.get(accountId);
  if (scanWin && !scanWin.isDestroyed() && scanWin.getBrowserViews().includes(view)) {
    return view;
  }
  return backgroundPages.attach(view);
}

/**
 * Attempts to capture the latest unwatermarked HD video from a Doubao page view
 * using the account's session state and DoubaoShareService.
 */
async function downloadHDVideoFromView(view: BrowserView): Promise<{ path: string; name: string } | null> {
  try {
    const target = await view.webContents.executeJavaScript(`(${captureLatestVideo.toString()})()`);
    if (target && target.vid && target.model?.fallback_api) {
      const video = await shareService.resolveVideo(target);
      const directory = watchedDirectory || db.getSetting('downloadDirectory') || path.join(app.getPath('downloads'), 'DoubaoWorkspace');
      const saved = await shareService.save(video.id, directory);
      pendingDownloads.add(saved.path);
      db.recordShareDownload(saved.path, path.basename(saved.path));
      windowRef?.webContents.send('workspace:changed');
      windowRef?.webContents.send('download:status', { state: 'completed', accountId: 0, name: path.basename(saved.path), path: saved.path });
      return { path: saved.path, name: path.basename(saved.path) };
    }
  } catch (error) {
    console.warn('[HD Video] resolution failed:', error instanceof Error ? error.message : error);
  }
  return null;
}

/**
 * Searches candidates across active or associated account views to resolve the HD unwatermarked video.
 */
async function resolveHDVideo(accountId?: number | null, threadId?: string): Promise<{ path: string; name: string } | null> {
  const candidateAccounts: number[] = [];
  const addAccount = (id?: number | null) => {
    if (id != null && !candidateAccounts.includes(id) && db.accounts().some(a => a.id === id && a.platform === 'doubao')) {
      candidateAccounts.push(id);
    }
  };

  let targetConversationId: string | null = null;
  if (threadId) {
    const thread = db.gatewayThread(threadId);
    if (thread?.doubaoConversationId) targetConversationId = thread.doubaoConversationId;
    addAccount(thread?.accountId);
  }
  addAccount(accountId);
  addAccount(lastVideoAccountId);
  addAccount(activeAccountId);
  for (const a of db.accounts()) if (a.platform === 'doubao') addAccount(a.id);

  const candidateViews: BrowserView[] = [];
  for (const accId of candidateAccounts) {
    const v = accountViews.get(accId) || ensureVideoAccountView(accId);
    if (v && !candidateViews.includes(v)) candidateViews.push(v);
  }
  for (const [, v] of accountViews) {
    if (!candidateViews.includes(v)) candidateViews.push(v);
  }

  for (const view of candidateViews) {
    if (!view.webContents || view.webContents.isDestroyed()) continue;
    if (targetConversationId && !targetConversationId.startsWith('local_')) {
      const currentUrl = view.webContents.getURL() || '';
      if (!currentUrl.includes(targetConversationId)) {
        const targetUrl = `https://www.doubao.com/chat/${targetConversationId}`;
        await view.webContents.loadURL(targetUrl).catch(() => undefined);
        await waitForPageReady(view).catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
    let result = await downloadHDVideoFromView(view);
    if (result) return result;

    try {
      const clicked = await view.webContents.executeJavaScript(`(() => {
        const nodes = Array.from(document.querySelectorAll('video, img, [role=button], button, [class*="card"]')).reverse();
        for (const node of nodes) {
          const rect = node.getBoundingClientRect();
          if (rect.width > 80 && rect.height > 40) {
            (node.closest('button,a,[role=button]') || node).click();
            return true;
          }
        }
        return false;
      })()`);
      if (clicked) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        result = await downloadHDVideoFromView(view);
        if (result) return result;
      }
    } catch { /* ignore page evaluation error */ }
  }
  return null;
}

/** Picks a usable Doubao account from the shared pool, or the first logged-in one. */
function pickDoubaoAccount(): { id: number } | null {
  const accounts = db.accounts().filter(account => account.platform === 'doubao');
  const pool = canvasBridge?.poolRef;
  if (pool) {
    const picked = pool.pick(accounts, canvasBridge?.busyIds() ?? new Set<number>());
    if (picked) return { id: picked.id };
    // 池里全员不可用（冷却/额度/验证码/未登录）时不再兜底取号：
    // 绕过健康度会把失效账号反复锤醒，也让冷却机制对这条路径完全失效。
    return null;
  }
  const fallback = accounts.find(account => account.isLoggedIn);
  return fallback ? { id: fallback.id } : null;
}

/**
 * Saves a Doubao-generated image/video to the local image-asset store.
 *
 * The CDN rejects direct downloads (403), so the bytes are fetched from inside the
 * account page — which carries the session cookies — and returned as base64.
 */
/**
 * Saves a Doubao-generated image/video to the local gateway-media store.
 *
 * The CDN links expire and need the session cookies, but a fetch from inside the account
 * page is blocked by CORS ("Failed to fetch"), and executeJavaScript on a BrowserView that is
 * not attached throws "Given BrowserView is not attached to the window". Fetching from the
 * main process with a browser User-Agent and a doubao Referer works and needs no page at all.
 */
async function downloadRemoteMedia(url: string, kind: 'image' | 'video'): Promise<GatewayAttachment | null> {
  const target = new URL(url);
  if (!/^https?:$/.test(target.protocol)) return null;
  const transport = target.protocol === 'https:' ? https : http;
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    transport.get({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: {
        // The CDN checks these; without them the signed URL is rejected with 403.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://www.doubao.com/',
        'Accept': 'image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8',
      },
    }, (response: http.IncomingMessage) => {
      // Doubao answers expired links with a redirect to a login/error page.
      if (response.statusCode !== 200) { response.resume(); reject(new Error('HTTP ' + response.statusCode)); return; }
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
  if (!bytes.length) return null;
  const folder = path.join(app.getPath('userData'), 'gateway-media');
  fs.mkdirSync(folder, { recursive: true });
  const extension = kind === 'video' ? 'mp4' : (/[.](png)/i.test(url) ? 'png' : 'jpg');
  const file = path.join(folder, `${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`);
  fs.writeFileSync(file, bytes);
  return { id: randomUUID(), kind, url: pathToFileURL(file).toString(), name: path.basename(file), path: file };
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
function setupIpc() {
  registerImageAssetsIpc({ db: () => db, imageAssets: () => imageAssets, openPanel: () => panels.openImageAssets(), activeAccountId: () => [...accountViews].find(([, view]) => view === currentView)?.[0] ?? null, useImageAssets });
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
  registerWorkspaceIpc({ db: () => db, accountShortcuts, barHeights: () => ({ imageBarHeight, accountBarHeight }), archiveDownload });
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
  ipcMain.handle('accounts:update', (_e, id, patch) => { const next = db.updateAccount(id, patch); broadcast('workspace:changed'); return next; });
  ipcMain.handle('accounts:move', (event, id: number, targetId: number, before: boolean) => {
    if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('只能在工作站窗口操作');
    const accounts = db.moveAccount(id, targetId, before);
    broadcast('workspace:changed');
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
    canvasBridge?.forgetAccount(id);
    if (wasCurrent) { currentView = null; }
    if (activeAccountId === id) { activeAccountId = null; }
    broadcast('workspace:changed');
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
    void syncAccountsToBeefTv(db.accounts(), ensureGatewayApiKey(), { gatewayBaseUrl: gateway?.url });
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
  ipcMain.handle('accounts:create', (_e, data) => {
    const next = db.createAccount(data);
    broadcast('workspace:changed');
    void syncAccountsToBeefTv(db.accounts(), ensureGatewayApiKey(), { gatewayBaseUrl: gateway?.url });
    return next;
  });
  ipcMain.handle('beeftv:sync', () => syncAccountsToBeefTv(db.accounts(), ensureGatewayApiKey(), { syncNative: true, gatewayBaseUrl: gateway?.url }));
  ipcMain.handle('beeftv:launch', () => launchNativeBeefTv());
  ipcMain.handle('settings:open', () => { panels.openSettings(); return true; });
  ipcMain.handle('donation:open', () => { panels.openDonation(); return true; });
  ipcMain.handle('accounts:open', (_e, id) => { if (!openAccountBrowser(id)) throw new Error('账号不存在或窗口尚未就绪'); return true; });
  ipcMain.handle('browser:hide', () => { hideBrowser(); return true; });
  ipcMain.handle('browser:set-fullscreen', (_e, value) => {
    if (!currentView?.webContents || currentView.webContents.isDestroyed() || !windowRef?.getBrowserViews().includes(currentView)) return false;
    setBrowserFullscreen(Boolean(value));
    return browserFullscreen;
  });
  registerFilesIpc({ mainWindow: () => windowRef });
  ipcMain.handle('files:watch-downloads', (_e, directory) => { if (directory) watchDownloads(directory); return directory; });
  ipcMain.handle('gateway:status', () => gatewayStatus());
  ipcMain.handle('gateway:open', () => { panels.openGateway(); return true; });
  ipcMain.handle('gateway:restart', (_e, config: { port?: number; apiKey?: string; enabled?: boolean }) => {
    if (config && typeof config === 'object') {
      if (Number.isSafeInteger(config.port) && config.port! > 0 && config.port! < 65536) db.setSetting('gatewayPort', String(config.port));
      if (typeof config.apiKey === 'string') db.setSetting('gatewayKey', config.apiKey.slice(0, 200));
      if (typeof config.enabled === 'boolean') db.setSetting('gatewayEnabled', String(config.enabled));
    }
    restartGateway();
    return gatewayStatus();
  });
  ipcMain.handle('accounts:probe', async (_e, id: number) => {
    // Manual "re-check" from the gateway console for an account marked 需人机验证.
    if (!canvasBridge) throw new Error('账号池未启动，请重启应用');
    const result = await canvasBridge.probeAccount(Number(id));
    windowRef?.webContents.send('workspace:changed');
    return result;
  });

  // ── Gateway mode: chat threads driven from the renderer ────────────────────
  ipcMain.handle('app:mode', () => currentAppMode());
  ipcMain.handle('app:set-mode', (_e, mode: 'gateway' | 'account') => {
    const next = mode === 'account' ? 'account' : 'gateway';
    db.setSetting('appMode', next);
    // Account mode needs the native page visible; gateway mode drives it off-screen.
    if (next === 'account') {
      const targetId = (activeAccountId != null && db.accounts().some(a => a.id === activeAccountId))
        ? activeAccountId
        : ([...accountViews].find(([, view]) => view === currentView)?.[0] ?? db.accounts()[0]?.id ?? 0);
      if (targetId) {
        try { openAccountBrowser(targetId); } catch { /* handled by caller */ }
      }
    } else {
      hideBrowser();
    }
    broadcast('app:mode-changed', next);
    return next;
  });

  const resolveStaged = (items: { id?: string; assetId?: string; name?: string; mimeType?: string }[] = []) =>
    resolveStagedAttachments(items, id => imageAssets.resolve(id));
  ipcMain.handle('chat:images', async (_event, request: { threadId?: string; prompt: string; model?: string; ratio?: string; accountId?: number | null; attachments?: { id?: string; assetId?: string; name?: string; mimeType?: string }[] }) => {
    return gatewayChat.generateImages({ threadId: request?.threadId, prompt: String(request?.prompt ?? ''), model: request?.model, ratio: request?.ratio, accountId: request?.accountId, attachments: resolveStaged(request?.attachments) as any });
  });
  ipcMain.handle('chat:videos', async (_event, request: { threadId?: string; prompt: string; model?: string; ratio?: string; duration?: number; accountId?: number | null; attachments?: { id?: string; assetId?: string; name?: string; mimeType?: string }[] }) => {
    return gatewayChat.generateVideos({ threadId: request?.threadId, prompt: String(request?.prompt ?? ''), model: request?.model, ratio: request?.ratio, duration: request?.duration, accountId: request?.accountId, attachments: resolveStaged(request?.attachments) as any });
  });
  ipcMain.handle('chat:confirm', async (_event, request: { threadId?: string; text?: string }) => {
    if (!canvasBridge) return false;
    return forwardVideoChatMessage(canvasBridge, db, request?.threadId || '', request?.text || '');
  });
  ipcMain.handle('chat:download-media', async (_event, attachment: { id?: string; kind?: 'image' | 'video'; name?: string; path?: string; url?: string }, context?: { accountId?: number | null; threadId?: string }) => {
    try {
      if (attachment?.kind === 'video') {
        const hd = await resolveHDVideo(context?.accountId, context?.threadId);
        if (hd) {
          return { path: hd.path };
        }
      }
      const directory = watchedDirectory || db.getSetting('downloadDirectory') || path.join(app.getPath('downloads'), 'DoubaoWorkspace');
      fs.mkdirSync(directory, { recursive: true });
      const filename = path.basename(attachment?.name || '') || (attachment?.kind === 'video' ? `doubao-video-${Date.now()}.mp4` : `doubao-image-${Date.now()}.png`);
      const target = path.join(directory, filename);

      // Already inside the configured download folder: nothing to copy, just report it.
      if (attachment?.path && fs.existsSync(attachment.path) && path.resolve(attachment.path) === path.resolve(target)) {
        windowRef?.webContents.send('download:status', { state: 'completed', accountId: 0, name: filename, path: target });
        return { path: target, alreadyInFolder: true };
      }

      // Never overwrite an existing file: a second click would otherwise clobber the first copy.
      let destination = target;
      if (fs.existsSync(destination)) {
        const parsed = path.parse(target);
        destination = path.join(parsed.dir, `${parsed.name}-${Date.now().toString(36)}${parsed.ext}`);
      }

      if (attachment?.path && fs.existsSync(attachment.path)) {
        fs.copyFileSync(attachment.path, destination);
      } else if (attachment?.url && /^https?:\/\//.test(attachment.url)) {
        const saved = await downloadRemoteMedia(attachment.url, attachment.kind === 'video' ? 'video' : 'image');
        if (saved?.path && fs.existsSync(saved.path)) {
          fs.copyFileSync(saved.path, destination);
        } else {
          throw new Error('下载文件失败，请检查网络');
        }
      } else {
        throw new Error('未找到该媒体的本地文件');
      }

      pendingDownloads.add(destination);
      if (attachment?.kind === 'video') db.recordShareDownload(destination, path.basename(destination));
      windowRef?.webContents.send('workspace:changed');
      windowRef?.webContents.send('download:status', { state: 'completed', accountId: 0, name: path.basename(destination), path: destination });
      return { path: destination };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '下载失败，请重试';
      windowRef?.webContents.send('download:status', { state: 'failed', accountId: 0, name: attachment?.name || '媒体文件', reason });
      return { error: reason };
    }
  });
  ipcMain.handle('chat:save-last-frame', async (_event, payload: { dataUrl: string; name?: string }) => {
    try {
      if (!payload?.dataUrl || typeof payload.dataUrl !== 'string') {
        throw new Error('未获取到有效的图像数据');
      }
      const base64Data = payload.dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const directory = watchedDirectory || db.getSetting('downloadDirectory') || path.join(app.getPath('downloads'), 'DoubaoWorkspace');
      fs.mkdirSync(directory, { recursive: true });

      const rawName = (payload.name || '').trim();
      let baseName = 'doubao-last-frame';
      if (rawName) {
        const parsed = path.parse(rawName);
        baseName = parsed.name.replace(/\.[^.]+$/, '');
      }
      const filename = `${baseName}-last-frame-${Date.now()}.png`;
      const target = path.join(directory, filename);

      let destination = target;
      if (fs.existsSync(destination)) {
        const parsed = path.parse(target);
        destination = path.join(parsed.dir, `${parsed.name}-${Date.now().toString(36)}${parsed.ext}`);
      }

      fs.writeFileSync(destination, buffer);
      pendingDownloads.add(destination);
      windowRef?.webContents.send('workspace:changed');
      windowRef?.webContents.send('download:status', { state: 'completed', accountId: 0, name: path.basename(destination), path: destination });
      return { path: destination };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '保存尾帧失败';
      windowRef?.webContents.send('download:status', { state: 'failed', accountId: 0, name: payload?.name || '尾帧图片', reason });
      return { error: reason };
    }
  });
  ipcMain.handle('chat:threads', () => gatewayChat.threads());
  ipcMain.handle('chat:messages', (event, threadId: string) => {
    const task = canvasBridge?.list().find(t => t.gatewayThreadId === String(threadId) && !['completed','failed','cancelled','needs_attention'].includes(t.status));
    if (task) setImmediate(() => { if (!event.sender.isDestroyed()) syncVideoTaskToChat(task, db, payload => event.sender.send('chat:delta', payload)); });
    return gatewayChat.messages(String(threadId));
  });
  ipcMain.handle('chat:create', (_e, model?: string) => gatewayChat.createThread(model));
  ipcMain.handle('chat:rename', (_e, id: string, title: string) => gatewayChat.renameThread(String(id), String(title)));
  ipcMain.handle('chat:delete', (_e, id: string) => gatewayChat.deleteThread(String(id)));
  ipcMain.handle('chat:send', async (event, request: { threadId?: string; prompt: string; model?: string; deepThink?: boolean; accountId?: number | null; attachments?: { id?: string; assetId?: string; name?: string; mimeType?: string }[]; imageAssetIds?: string[] }) => {
    const sender = event.sender;
    return gatewayChat.send({
      threadId: request?.threadId, prompt: String(request?.prompt ?? ''), model: request?.model, deepThink: request?.deepThink, accountId: request?.accountId,
      // Resolve the staged asset ids to real files; the main process owns the store.
      imageAssets: resolveStaged(request?.attachments ?? (request?.imageAssetIds ?? []).map(id => ({ assetId: id }))).map(item => ({ path: item.path, name: item.name })),
      // Stream partial text to the window that asked, so the UI can render it live.
      onDelta: (_chunk, full) => { if (!sender.isDestroyed()) sender.send('chat:delta', { threadId: request?.threadId, full }); },
    });
  });
  ipcMain.handle('assets:add', (_e, projectId, taskId, type, filePath) => db.addAsset(projectId, taskId, type, filePath));
}
/**
 * Which shell the renderer should show.
 *
 * Gateway mode is the default. DOUBAO_APP_MODE lets a caller force a shell — used by
 * the account-mode integration checks, which exercise UI that gateway mode does not
 * render.
 */
function currentAppMode(): 'gateway' | 'account' {
  const forced = String(process.env.DOUBAO_APP_MODE || '').trim().toLowerCase();
  if (forced === 'account' || forced === 'gateway') return forced;
  return db.getSetting('appMode') === 'account' ? 'account' : 'gateway';
}

/** Ensures an API key exists by generating a default sk-xxx key if unset. */
function ensureGatewayApiKey(): string {
  if (process.env.DOUBAO_GATEWAY_KEY) return process.env.DOUBAO_GATEWAY_KEY;
  let key = db.getSetting('gatewayKey');
  if (!key) {
    key = `sk-${randomUUID().replace(/-/g, '')}`;
    db.setSetting('gatewayKey', key);
  }
  return key;
}

/** Snapshot used by both the main window and the API gateway panel. */
function gatewayStatus() {
  const doubaoIds = new Set(db.accounts().filter(a => a.platform === 'doubao').map(a => a.id));
  const names = new Map(db.accounts().map(a => [a.id, a.name]));
  return {
    url: gateway?.url ?? '',
    enabled: db.getSetting('gatewayEnabled') !== 'false',
    running: Boolean(gateway),
    port: Number(process.env.DOUBAO_GATEWAY_PORT || db.getSetting('gatewayPort') || 8788),
    apiKey: ensureGatewayApiKey(),
    error: gateway?.error ?? null,
    requests: gateway?.requestCount ?? 0,
    model: gateway?.defaultModel ?? 'doubao',
    accounts: (canvasBridge?.poolSnapshot() ?? []).filter(entry => doubaoIds.has(entry.accountId))
      .map(({ accountId, health, available, dailyUsed, cooldownRemainingMs }) => ({ accountId, name: names.get(accountId) ?? `账号${accountId}`, health, available, dailyUsed, cooldownRemainingMs })),
  };
}

/** Starts the gateway from current settings, replacing any running instance. */
function restartGateway() {
  try { gateway?.stop(); } catch { /* already stopped */ }
  gateway = null;
  setupGateway();
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('gateway:changed');
}

function setupGateway() {
  const enabled = db.getSetting('gatewayEnabled');
  // Enabled by default: the gateway only listens on 127.0.0.1 and needs an explicit
  // opt-out, so a fresh install can be driven by any OpenAI-compatible client.
  if (enabled === 'false') return;
  const port = Number(process.env.DOUBAO_GATEWAY_PORT || db.getSetting('gatewayPort') || 8788);
  const apiKey = ensureGatewayApiKey();
  gateway = new DoubaoGateway({
    accounts: () => db.accounts(),
    viewForAccount: (accountId) => ensureAccountView(accountId),
    openAccount: (accountId) => ensureAccountView(accountId),
    prepareNewConversation: async (accountId) => {
      await prepareAccountNewConversation(accountId);
    },
    addAccount: async () => {
      const existing = db.accounts();
      const nextNum = existing.length + 1;
      const account = db.createAccount({ name: `账号${nextNum}`, platform: 'doubao' });
      openAccountBrowser(account.id);
      windowRef?.webContents.send('workspace:changed');
      void syncAccountsToBeefTv(db.accounts(), apiKey, { hostBaseUrl: beeftvHost?.url, gatewayBaseUrl: gateway?.url });
      return account;
    },
    createVideoTask: async (options) => {
      const task = await canvasBridge!.create({
        prompt: options.prompt,
        model: options.model,
        ratio: options.ratio,
        duration: options.duration,
        targetAccountId: options.accountId ?? undefined,
        referencePaths: options.referencePaths,
      });
      return { id: task.id, status: task.status, createdAt: task.createdAt };
    },
    getVideoTask: (taskId) => {
      const t = canvasBridge?.task(taskId);
      if (!t) return null;
      return {
        id: t.id,
        status: t.status,
        statusText: t.statusText,
        videoPath: t.videoPath,
        lastFramePath: t.lastFramePath,
        latestReply: t.latestReply ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        error: t.error,
      };
    },
    cancelVideoTask: (taskId) => {
      return canvasBridge?.cancelTask(taskId) ?? false;
    },
    confirmVideoTask: (taskId, text) => {
      if (!canvasBridge) throw new Error('画布桥未启动，无法发送补充消息');
      return canvasBridge.confirmTask(taskId, text);
    },
  }, {
    port,
    apiKey,
    pool: canvasBridge!.poolRef,
    busyAccountIds: () => canvasBridge?.busyIds() ?? new Set<number>(),
    onLog: (message) => {
      if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('gateway:log', message);
    },
  });
  gateway.start();
  // 迁移旧版默认模型配置；豆包节点通过网关独立读取账号。
  void syncAccountsToBeefTv(db.accounts(), apiKey, { hostBaseUrl: beeftvHost?.url, gatewayBaseUrl: gateway?.url });
  setTimeout(() => {
    const failure = gateway?.error;
    if (failure) windowRef?.webContents.send('browser:error', failure);
  }, 3500);
}

function createWindow() {
  windowRef = new BrowserWindow({ icon: workspaceIcon, width: 1480, height: 920, minWidth: 1100, minHeight: 700, backgroundColor: '#f7f9fc', title: '豆奶画布', webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  attachAccountShortcuts(windowRef.webContents);
  // 豆包 3.0：先显示启动占位页；BeefTV 宿主就绪后加载原生画布（见 whenReady 尾部），
  // 宿主失败时回退工作站自带 UI。避免旧 UI 短暂加载产生副作用（如自动打开账号页）。
  const splashIconUrl = `data:image/png;base64,${fs.readFileSync(workspaceIcon).toString('base64')}`;
  const splashHtml = `<body style="margin:0;background:#0d0d0d;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif;color:#f3f4f6"><div style="text-align:center"><img src="${splashIconUrl}" style="width:72px;height:72px;border-radius:18px;margin-bottom:16px;box-shadow:0 12px 32px rgba(0,0,0,0.5);object-fit:cover;" /><div style="font-size:15px;font-weight:600;margin-bottom:6px;letter-spacing:0.5px">正在启动豆奶画布…</div><div style="font-size:12px;opacity:.55">正在初始化画布引擎，请稍候</div></div></body>`;
  windowRef.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml));
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
  windowRef.on('closed', () => { windowRef = null; currentView = null; backgroundPages.destroy(); });
}
// A second launch must focus the running workspace instead of starting a rival
// process that would fight for the canvas bridge port and pop an error dialog.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!windowRef || windowRef.isDestroyed()) return;
    if (windowRef.isMinimized()) windowRef.restore();
    windowRef.show();
    windowRef.focus();
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') app.setAppUserModelId('com.dbgzz.doubao.workspace');
  const installed = fs.readdirSync(path.dirname(app.getPath('exe'))).some(name => /^Uninstall.*\.exe$/i.test(name));
  const disabledReason = !app.isPackaged ? '开发版不执行自动更新，请使用正式安装版。'
    : process.platform !== 'win32' || !installed ? '请先安装正式安装版后使用自动更新。' : '';
  appUpdates = new AppUpdateService(autoUpdater, app.getVersion(), {
    disabledReason,
    beforeInstall: () => {
      const activeTasks = canvasBridge?.list().some(task => !['completed', 'failed', 'cancelled', 'needs_attention'].includes(task.status));
      if (activeTasks || canvasBridge?.busyIds().size || pendingDownloads.size) throw new Error('仍有任务或下载正在进行，请等待完成后再安装更新。');
    },
    notifyAvailable: (version) => {
      if (!Notification.isSupported()) return;
      const notice = new Notification({ title: `豆奶画布 ${version} 已发布`, body: '点击打开软件，在左下角下载并安装更新。', icon: workspaceIcon });
      notice.on('click', () => {
        if (!windowRef || windowRef.isDestroyed()) return;
        if (windowRef.isMinimized()) windowRef.restore();
        windowRef.show(); windowRef.focus();
      });
      notice.show();
    },
    log: (message) => console.error('[app-update]', message),
  });
  for (const [channel, action] of Object.entries({
    'app-update:status': () => appUpdates.snapshot(),
    'app-update:check': () => appUpdates.check(),
    'app-update:download': () => appUpdates.download(),
    'app-update:install': () => appUpdates.install(),
  })) {
    ipcMain.handle(channel, (event) => {
      const url = event.senderFrame?.url || '';
      const trusted = url === rendererUrl() || Boolean(beeftvHost && new URL(url).origin === new URL(beeftvHost.url).origin);
      if (!windowRef || event.sender !== windowRef.webContents || event.senderFrame !== event.sender.mainFrame || !trusted) throw new Error('更新请求仅允许来自工作站主窗口。');
      return action();
    });
  }
  db = new WorkspaceDatabase();
  imageBarHeight = Math.max(56, Math.min(360, Number(db.getSetting('imageBarHeight')) || 76));
  accountBarHeight = Math.max(42, Math.min(160, Number(db.getSetting('accountBarHeight')) || 58));
  imageAssets = new ImageAssetStore(path.join(app.getPath('userData'), 'image-assets'));
  setupIpc();
  const saved = db.getSetting('downloadDirectory');
  if (saved) watchDownloads(saved);
  canvasBridge = new CanvasBridge({
    accounts: () => db.accounts(),
    openAccount: (accountId) => ensureVideoAccountView(accountId),
    viewForAccount: (accountId) => ensureVideoAccountView(accountId),
    isViewAttached: (view) => Boolean(
      windowRef?.getBrowserViews().includes(view) ||
      [...scanWindows.values()].some(win => !win.isDestroyed() && win.getBrowserViews().includes(view))
    ),
    onTaskChanged: (task) => {
      windowRef?.webContents.send('workspace:changed');
      if (task) {
        if (task.gatewayReplyMessageId != null) {
          if (['completed', 'failed', 'cancelled'].includes(task.status)) {
            pendingChatVideos.delete(task.id);
          } else {
            pendingChatVideos.set(task.id, task.gatewayReplyMessageId);
          }
        }
        syncVideoTaskToChat(task, db, payload => windowRef?.webContents.send('chat:delta', payload));
      }
    },
    downloadHDVideo: async (view, _task) => {
      const result = await downloadHDVideoFromView(view);
      return result?.path ?? null;
    },
    popupAccountForCaptcha: (accountId, reason) => popupAccountForCaptcha(accountId, reason),
  }, app.getPath('userData'));
  canvasBridge.poolRef.onLoggedOut = (accountId) => {
    // 池判定登录失效（classify 命中 logged_out / 页面要求重新登录）时同步落库，
    // 账号立即在界面显示"未登录"并被摘出调度，而不是冷却完又被反复调度。
    const current = db.accounts().find(item => item.id === accountId);
    if (!current || !current.isLoggedIn) return;
    db.updateAccount(accountId, { isLoggedIn: false });
    windowRef?.webContents.send('workspace:changed');
  };
  setupAccountSend({ accounts: () => db.accounts(), views: accountViews, current: () => currentView,
    main: () => windowRef, rendererUrl, preload: path.join(__dirname, '../preload/preload.js'), bridge: () => canvasBridge,
    assets: () => imageAssets, upload: useImageAssets, staged: stagedImageAssets, stagedUrls: stagedImageUrls,
    openAccount: (id, background) => openAccountBrowser(id, background) ?? null });
  gatewayChat = createGatewayChat(db as any, {
    viewForAccount: (accountId) => ensureAccountView(accountId),
    prepareNewConversation: async (accountId) => {
      await prepareAccountNewConversation(accountId);
    },
    syncConversationPage: async (accountId, conversationId) => {
      await syncAccountConversationPage(accountId, conversationId);
    },
    pickAccount: () => {
      const pool = canvasBridge?.poolRef;
      const accounts = db.accounts().filter(account => account.platform === 'doubao');
      const picked = pool ? pool.pick(accounts, canvasBridge?.busyIds() ?? new Set<number>()) : accounts.find(a => a.isLoggedIn);
      return picked ? { id: picked.id } : null;
    },
    // Which account produced the last image/video, so the reply can be labelled.
    lastImageAccountId: () => lastImageAccountId,
    lastImageConversationId: () => lastImageConversationId,
    uploadImages: async (accountId, paths, names) => {
      // Upload through the account's own page: the site does the prepare_upload + TOS
      // signing, and we read back the object key the completion payload needs.
      const view = ensureAccountView(accountId);
      if (!view?.webContents || view.webContents.isDestroyed()) throw new Error('账号页面不可用，请确认该账号已登录');
      const uploaded: unknown[] = [];
      for (let i = 0; i < paths.length; i += 1) {
        uploaded.push(await uploadImageToDoubao(view, paths[i], names[i] || path.basename(paths[i])));
      }
      return uploaded;
    },
    lastVideoAccountId: () => lastVideoAccountId,
    markAccountOk: (accountId) => canvasBridge?.poolRef.markOk(accountId),
    markAccountFailure: (accountId, message) => {
      if (!accountId) return;
      const pool = canvasBridge?.poolRef;
      if (!pool) return;
      pool.markFailure(accountId, /710022004|人机验证|安全验证/.test(message) ? 'captcha' : /额度|次数用完/.test(message) ? 'quota' : 'transient', message);
    },
    saveRemoteMedia: async (url, kind) => {
      try {
        const saved = await downloadRemoteMedia(url, kind);
        return saved;
      } catch { return null; }
    },
    generateImages: async (prompt, options: { model?: string; ratio?: string; accountId?: number | null; threadId?: string; conversationId?: string; attachments?: { path: string; name: string; mimeType: string }[] }) => {
      const accounts = db.accounts().filter(account => account.platform === 'doubao');
      if (!accounts.length) throw new Error('没有可用的豆包账号，请先在设置里添加并登录账号');
      lastImageAccountId = null;
      lastImageConversationId = null;
      // Doubao answers a burst of image requests with 710020202 'common invalid param'
      // or a plain "访问频繁" note. Neither is a payload bug, so retry on another account
      // instead of surfacing the raw server message.
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // 指定账号 wins; otherwise the pool picks one.
        const account = options.accountId != null
          ? accounts.find(item => item.id === options.accountId)
          : pickDoubaoAccount();
        if (!account) { lastError = new Error('指定的账号不存在或不可用'); break; }
        lastImageAccountId = account.id;
        const view = ensureAccountView(account.id);
        if (!view?.webContents || view.webContents.isDestroyed()) { lastError = new Error('账号页面不可用，请确认该账号已登录'); continue; }
        try {
          if (!options.conversationId) {
            await prepareAccountNewConversation(account.id);
          }
          const uploaded: unknown[] = [];
          if (options.attachments?.length) {
            for (const item of options.attachments) {
              uploaded.push(await uploadImageToDoubao(view, item.path, item.name));
            }
          }
          let images: Array<{ url: string; width?: number; height?: number; format?: string }> = [];
          if (uploaded.length > 0) {
            const chatPrompt = options.ratio ? `${prompt}（请生成 ${options.ratio} 比例的图片）` : prompt;
            const result = await streamChat(view, chatPrompt, {
              conversationId: options.conversationId,
              attachments: uploaded,
            });
            const urls = new Set<string>(result.mediaUrls?.length ? result.mediaUrls : extractMediaUrls(result.answer));
            if (!urls.size) throw new Error(`豆包未返回生成的图片：${result.answer.slice(0, 80) || '无响应内容'}`);
            images = Array.from(urls).map(url => ({ url, width: 0, height: 0, format: 'png' }));
          } else {
            images = await generateImages(view, prompt, { model: options.model, ratio: options.ratio, conversationId: options.conversationId });
          }
          const attachments: GatewayAttachment[] = [];
          for (const image of images) {
            // CDN links expire and are cookie-bound; persist the bytes locally.
            const saved = await downloadRemoteMedia(image.url, 'image').catch(() => null);
            if (saved) attachments.push(saved);
          }
          if (!attachments.length) throw new Error('图片已生成但保存失败，请重试');
          return attachments;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          // Throttling and risk control are per-account; another account can serve now.
          if (!/访问频繁|invalid param|人机验证|安全验证|验证|额度|71002200|没有返回图片/.test(lastError.message)) throw lastError;
          canvasBridge?.poolRef.markFailure(account.id, 'transient', lastError.message);
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
      }
      throw lastError ?? new Error('图片生成失败，请稍后重试');
    },
    generateVideos: async (prompt, options: { model?: string; ratio?: string; duration?: number; accountId?: number | null; replyMessageId?: number; threadId?: string; referencePaths?: string[] }) => {
      lastVideoAccountId = options.accountId ?? null;
      // The chat API cannot start a video job (the model answers "无法直接生成视频"),
      // so hand the prompt to the canvas bridge, which submits through the site's
      // chat-ability endpoint and watches the conversation page for the render.
      if (!canvasBridge) throw new Error('视频任务桥未启动，请重启应用');
      let lastError = '视频生成未完成';
      // Not every account runs video jobs; the bridge cools down a rejecting account,
      // so each retry is dispatched to a different one until one accepts.
      const thread = options.threadId ? db.gatewayThread(options.threadId) : null;
      const effectiveTargetAccount = options.accountId ?? (thread?.doubaoConversationId ? (thread.accountId ?? undefined) : undefined);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        // 指定账号也要传给桥：否则参考图上传会落到池里随便挑的账号上。
        const task = await canvasBridge.create({
          gatewayThreadId: options.threadId,
          gatewayReplyMessageId: options.replyMessageId,
          conversationId: videoConversationForAccount(thread, effectiveTargetAccount),
          prompt,
          ratio: options.ratio,
          duration: options.duration,
          model: options.model,
          targetAccountId: effectiveTargetAccount,
          referencePaths: options.referencePaths ?? []
        });
        // If the chat request times out, the bridge task keeps rendering; deliver the
        // video to the original chat bubble whenever it finishes.
        if (options.replyMessageId != null) pendingChatVideos.set(task.id, options.replyMessageId);
        // Doubao itself says "预计等待 5 分钟" but renders can take much longer on a
        // busy queue — the user's own video landed at ~35 minutes. Match the bridge's
        // 30-minute cap so the chat never gives up before the bridge does.
        // DS_VIDEO_WAIT_MS shortens this for tests.
        const waitMs = Math.max(30_000, Number(process.env.DS_VIDEO_WAIT_MS) || 30 * 60 * 1000);
        let deadline = Date.now() + waitMs;
        let timedOut = false;

        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          const current = canvasBridge.task(task.id);
          if (current?.status === 'awaiting_confirmation') deadline = Date.now() + waitMs;
          if (!current) { lastError = '视频任务丢失，请在任务面板查看'; break; }
          // Mirror the bridge's real state into the bubble. Waiting only for latestReply
          // left the bubble frozen on its placeholder while the task was still queued.
          if (current.status === 'completed' && current.videoPath) {
            if (!fs.existsSync(current.videoPath)) { lastError = '视频文件已生成但丢失，请重新生成'; break; }
            pendingChatVideos.delete(task.id);
            return [{ id: randomUUID(), kind: 'video', url: pathToFileURL(current.videoPath).toString(), name: path.basename(current.videoPath), path: current.videoPath }];
          }
          if (current.status === 'needs_attention' || current.status === 'failed' || current.status === 'cancelled') {
            lastError = current.error || current.statusText || '视频生成未完成';
            break;
          }
          timedOut = Date.now() >= deadline;
        }
        if (timedOut) throw new Error('视频生成超时（30 分钟），任务仍在后台继续，完成后会出现在任务面板');
        // A rejecting/throttled account should not surface to the user — retry on the
        // next available one; anything else (quota, captcha, page lost) is final here.
        if (!/未接受视频任务|访问频繁/.test(lastError)) break;
      }
      throw new Error(lastError);
    },
  });

  for (const task of canvasBridge.list()) {
    if (!task.gatewayThreadId && ['awaiting_reply','awaiting_confirmation','generating','downloading'].includes(task.status)) {
      const link = recoverLegacyVideoLink(task, gatewayChat.threads(), id => gatewayChat.messages(id));
      if (link) canvasBridge.linkChatTask(task.id, link.threadId, link.replyMessageId);
    }
    if (task.gatewayReplyMessageId != null && !['completed','failed','cancelled','needs_attention'].includes(task.status)) pendingChatVideos.set(task.id,task.gatewayReplyMessageId);
  }
  canvasBridge.start(Number(process.env.CANVAS_BRIDGE_PORT || 3219));
  // Report a lost bridge port once the window exists, without blocking startup.
  setTimeout(() => {
    const failure = canvasBridge?.bridgeError;
    if (failure) windowRef?.webContents.send('browser:error', failure);
  }, 3000);
  canvasDownloadPoll = setInterval(() => {
    for (const account of db.accounts()) void canvasBridge?.tryDownloadCompletedVideo(account.id);
    // Late delivery: a chat request that timed out still gets its video when the
    // bridge task finally completes in the background.
    if (pendingChatVideos.size && gatewayChat) {
      for (const [taskId, messageId] of [...pendingChatVideos]) {
        const task = canvasBridge?.task(taskId);
        if (!task) { pendingChatVideos.delete(taskId); continue; }
        if (task.status === 'completed' && task.videoPath && fs.existsSync(task.videoPath)) {
          pendingChatVideos.delete(taskId);
          const threadId = gatewayChat.deliverLateVideo(messageId, { id: randomUUID(), kind: 'video', url: pathToFileURL(task.videoPath).toString(), name: path.basename(task.videoPath), path: task.videoPath }) ?? task.gatewayThreadId;
          windowRef?.webContents.send('workspace:changed');
          if (threadId) {
            windowRef?.webContents.send('chat:delta', {
              threadId,
              messageId,
              full: '视频已生成（后台完成）',
              videoTaskId: task.id,
              videoStatus: 'completed',
            });
          }
        }
      }
    }
  }, 750);
  // A captcha block is terminal unless something re-tests the account, so the console
  // would show 需人机验证 forever even after the user verified in the Doubao window.
  // Probe blocked accounts on a slow timer; a successful load clears the block.
  captchaProbePoll = setInterval(() => {
    const blocked = canvasBridge?.poolSnapshot().filter(entry => entry.health === 'captcha') ?? [];
    for (const entry of blocked) {
      if (probeInFlight.has(entry.accountId)) continue;
      // Give the user time to finish the verification before probing again.
      if (entry.cooldownRemainingMs > 0) continue;
      probeInFlight.add(entry.accountId);
      void canvasBridge?.probeAccount(entry.accountId)
        .then(() => windowRef?.webContents.send('workspace:changed'))
        .catch(() => undefined)
        .finally(() => probeInFlight.delete(entry.accountId));
    }
  }, 20_000);
  createWindow();
  setupGateway();
  // 豆包 3.0：启动 BeefTV 宿主（静态服务 + 后端子进程）后加载主窗口。
  beeftvDataDir = path.join(app.getPath('userData'), 'beeftv-data');
  void (async () => {
    try {
      beeftvHost = new BeefTvHost({
        webRoot: beeftvWebDist(),
        backendExe: beeftvBackendExe(),
        backendDataDir: beeftvDataDir,
        backendEnv: { CANVAS_OFFICIAL_PLUGIN_DIR: beeftvPluginDir() },
        // 后端首次启动会生成 agent_owner_token；用 getter 让代理随时读到最新值。
        ownerToken: () => {
          try {
            return fs.readFileSync(path.join(beeftvDataDir, 'agent_owner_token'), 'utf8').trim();
          } catch {
            return '';
          }
        },
        onLog: (() => {
          // 打包版没有 stdout，宿主日志写入 userData 便于诊断。
          const logPath = path.join(beeftvDataDir, 'beeftv-host.log');
          return (entry: string) => {
            console.log(`[beeftv-host] ${entry}`);
            try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${entry}\n`); } catch { /* 日志失败不影响主流程 */ }
          };
        })(),
      });
      await beeftvHost.start();
    } catch (error) {
      console.error('BeefTV 宿主首次启动失败，稍后重试（主窗口不回退旧 UI）：', error);
      beeftvHost = null;
    }
    // 宿主启动失败时每 5 秒重试（端口被残留进程占用等情况恢复后自动就绪）；
    // 主窗口保持启动占位页，绝不回退旧双模式 UI——3.0 的主界面只有 BeefTV。
    if (!beeftvHost) {
      const retryTimer = setInterval(() => {
        void (async () => {
          try {
            beeftvHost = new BeefTvHost({
              webRoot: beeftvWebDist(),
              backendExe: beeftvBackendExe(),
              backendDataDir: beeftvDataDir,
              backendEnv: { CANVAS_OFFICIAL_PLUGIN_DIR: beeftvPluginDir() },
              ownerToken: () => {
                try {
                  return fs.readFileSync(path.join(beeftvDataDir, 'agent_owner_token'), 'utf8').trim();
                } catch {
                  return '';
                }
              },
              onLog: (() => {
                const logPath = path.join(beeftvDataDir, 'beeftv-host.log');
                return (entry: string) => {
                  console.log(`[beeftv-host] ${entry}`);
                  try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${entry}\n`); } catch { /* ignore */ }
                };
              })(),
            });
            await beeftvHost.start();
            clearInterval(retryTimer);
            console.log('[beeftv-host] 宿主重试启动成功');
            await syncAccountsToBeefTv(db.accounts(), ensureGatewayApiKey(), { hostBaseUrl: beeftvHost.url, gatewayBaseUrl: gateway?.url });
            if (windowRef && !windowRef.isDestroyed()) windowRef.loadURL(beeftvHost.url);
          } catch (retryError) {
            beeftvHost = null;
            console.error('BeefTV 宿主重试仍失败：', retryError instanceof Error ? retryError.message : retryError);
          }
        })();
      }, 5000);
      retryTimer.unref();
      return;
    }
    // 后端启动后同步助手可选的豆包账号渠道（只含文本），并清理旧版注入到默认模型的引用。
    const initialSync = await syncAccountsToBeefTv(db.accounts(), ensureGatewayApiKey(), { hostBaseUrl: beeftvHost?.url, gatewayBaseUrl: gateway?.url });
    console.log(`[beeftv-host] 启动时豆包助手渠道同步${initialSync.ok ? '完成' : `失败：${initialSync.error || ''}`}`);
    // 重试渠道同步，并恢复意外退出的 API 助手宿主。
    const assistantGuard = setInterval(() => {
      if (!beeftvHost) return;
      void (async () => {
        try {
          const apiKey = ensureGatewayApiKey();
          if (hostedModelConfigNeedsCleanup(beeftvDataDir, { accounts: db.accounts(), apiKey, gatewayBaseUrl: gateway?.url })) {
            const result = await syncAccountsToBeefTv(db.accounts(), apiKey, { hostBaseUrl: beeftvHost.url, gatewayBaseUrl: gateway?.url });
            console.log(`[beeftv-host] 豆包助手渠道同步${result.ok ? '完成' : `失败：${result.error || ''}`}`);
          }
          const response = await fetch(`${beeftvHost.url}/api/assistant/status`, { signal: AbortSignal.timeout(5000) });
          const payload = await response.json() as { data?: { available?: boolean; reason?: string } };
          if (payload?.data?.available) return;
          const reason = payload?.data?.reason || '';
          if (reason === 'host_start_failed' || reason === 'host_unreachable') {
            await fetch(`${beeftvHost.url}/api/assistant/host/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
            console.log(`[beeftv-host] agent 宿主自愈：已重新拉起（${reason}）`);
          }
        } catch { /* 守护失败等下一轮 */ }
      })();
    }, 30_000);
    assistantGuard.unref();
    if (windowRef && !windowRef.isDestroyed()) windowRef.loadURL(beeftvHost ? beeftvHost.url : rendererUrl());
  })();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('before-quit', () => { gateway?.stop(); canvasBridge?.stop(); beeftvHost?.stop(); if (canvasDownloadPoll) clearInterval(canvasDownloadPoll); if (captchaProbePoll) clearInterval(captchaProbePoll); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

