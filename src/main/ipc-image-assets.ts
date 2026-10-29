import { BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';
import type { WorkspaceDatabase } from './database';
import type { ImageAssetStore } from './image-assets';
import { broadcast } from './broadcast';

export interface ImageAssetsIpcDeps {
  db: () => WorkspaceDatabase;
  imageAssets: () => ImageAssetStore;
  openPanel: () => void;
  /** 当前显示的账号 id；没有激活账号视图时为 null。 */
  activeAccountId: () => number | null;
  useImageAssets: (ids: string[], accountId: number) => Promise<boolean>;
}

const notifyImageAssets = () => broadcast('image-assets:changed');

export function registerImageAssetsIpc(deps: ImageAssetsIpcDeps) {
  const { db, imageAssets, openPanel, activeAccountId, useImageAssets } = deps;

  const quickImageIds = (): string[] => {
    try { const ids = JSON.parse(db().getSetting('quickImageIds') || '[]'); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
  };
  const orderedQuickImages = () => {
    const available = new Map(imageAssets().list().map(item => [item.id, item]));
    return [...new Set(quickImageIds())].flatMap(id => available.has(id) ? [available.get(id)!] : []);
  };

  ipcMain.handle('image-assets:quick-list', () => orderedQuickImages());
  ipcMain.handle('image-assets:quick-reorder', (event, requested: string[]) => {
    if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('无效的图片排序请求');
    const current = orderedQuickImages().map(item => item.id);
    if (!Array.isArray(requested) || requested.length !== current.length || new Set(requested).size !== current.length
      || requested.some(id => typeof id !== 'string' || !current.includes(id))) throw new Error('图片列表已改变，请重试排序');
    db().setSetting('quickImageIds', JSON.stringify(requested)); notifyImageAssets();
    return orderedQuickImages();
  });
  ipcMain.handle('image-assets:quick-add', (_event, requested: string[]) => {
    if (!Array.isArray(requested) || !requested.length) throw new Error('请先选择图片资产');
    for (const id of requested) imageAssets().resolve(id);
    const available = imageAssets().list();
    const ids = [...new Set([...quickImageIds().filter(id => available.some(item => item.id === id)), ...requested])];
    db().setSetting('quickImageIds', JSON.stringify(ids)); notifyImageAssets();
    return orderedQuickImages();
  });
  ipcMain.handle('image-assets:quick-remove', (_event, requested: string[]) => {
    if (!Array.isArray(requested)) throw new Error('请选择要移出的快捷预览');
    const ids = quickImageIds().filter(id => !requested.includes(id));
    db().setSetting('quickImageIds', JSON.stringify(ids)); notifyImageAssets();
    return orderedQuickImages();
  });
  ipcMain.on('image-assets:drag', (event, ids: string[]) => {
    try {
      if (!Array.isArray(ids) || !ids.length) return;
      const files = [...new Set(ids)].map(id => imageAssets().resolve(id));
      const icon = nativeImage.createFromPath(files[0]).resize({ width: 64, height: 64 });
      if (icon.isEmpty()) throw new Error('图片无法读取，请重新导入');
      event.sender.startDrag({ file: files[0], files, icon });
    } catch (error) { event.sender.send('browser:error', error instanceof Error ? error.message : String(error)); }
  });
  ipcMain.handle('image-assets:open', () => { openPanel(); return true; });
  ipcMain.handle('image-assets:list', () => ({ items: imageAssets().list(), accountId: activeAccountId() }));
  ipcMain.handle('image-assets:import', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) throw new Error('资产窗口已关闭');
    const result = await dialog.showOpenDialog(owner, { properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    const items = result.canceled ? imageAssets().list() : imageAssets().import(result.filePaths);
    notifyImageAssets(); return items;
  });
  // 网关模式：按路径直接导入（支持文档/代码/音频等），不弹对话框。
  ipcMain.handle('image-assets:import-paths', (_event, paths: string[]) => {
    const items = imageAssets().import(Array.isArray(paths) ? paths : []);
    notifyImageAssets(); return items;
  });
  ipcMain.handle('image-assets:remove', (_event, id: string) => { const items = imageAssets().remove(id); notifyImageAssets(); return items; });
  ipcMain.handle('image-assets:use', (_event, ids: string[], accountId: number) => useImageAssets(ids, accountId));
}
