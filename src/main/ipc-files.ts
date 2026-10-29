import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { pathToFileURL } from 'node:url';

export interface FilesIpcDeps {
  mainWindow: () => BrowserWindow | null;
}

/** 文件选择与打开相关的 IPC（下载目录监听依赖主进程状态，仍在 main.ts）。 */
export function registerFilesIpc(deps: FilesIpcDeps) {
  ipcMain.handle('files:select-images', async () => (await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })).filePaths);
  // 网关模式发任意文件给模型：豆包 accept 列表覆盖文档/代码/音频等。
  ipcMain.handle('files:select-files', async () => (await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: '文件', extensions: ['pdf', 'txt', 'csv', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'md', 'mobi', 'epub', 'png', 'jpeg', 'jpg', 'webp', 'mp3', 'wav', 'm4a', 'flac', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'sh'] }] })).filePaths);
  ipcMain.handle('files:select-directory', async () => { const owner = BrowserWindow.getFocusedWindow() ?? deps.mainWindow() ?? undefined; const result = owner ? await dialog.showOpenDialog(owner, { properties: ['openDirectory', 'createDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }); return result.filePaths[0] || ''; });
  ipcMain.handle('files:open', (_e, target) => shell.openPath(target));
  ipcMain.handle('files:folder', (_e, target) => shell.showItemInFolder(target));
  ipcMain.handle('files:url', (_e, target) => pathToFileURL(target).toString());
}
