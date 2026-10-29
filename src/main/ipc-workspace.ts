import { BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { accountShortcut, normalizeAccountShortcut } from '../shared/account-shortcuts';
import type { WorkspaceDatabase } from './database';
import { broadcast } from './broadcast';

export interface WorkspaceIpcDeps {
  db: () => WorkspaceDatabase;
  accountShortcuts: () => Record<string, string>;
  barHeights: () => { imageBarHeight: number; accountBarHeight: number };
  archiveDownload: (taskId: number, sourcePath: string, accountId: number) => unknown;
}

/** 只依赖数据库的 IPC：工作区快照、账号快捷键、项目/任务、视频库及零散小工具。 */
export function registerWorkspaceIpc(deps: WorkspaceIpcDeps) {
  const { db, accountShortcuts, barHeights, archiveDownload } = deps;

  ipcMain.handle('workspace:load', () => ({
    accounts: db().accounts(), projects: db().projects(), dashboard: db().dashboard(),
    downloadDirectory: db().getSetting('downloadDirectory') || '',
    ...barHeights(), accountShortcuts: accountShortcuts(),
  }));
  ipcMain.handle('settings:account-shortcut', (event, index: number, value: string) => {
    if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('只能在工作站设置快捷键');
    const accounts = db().accounts();
    if (!Number.isSafeInteger(index) || index < 0 || index >= accounts.length || typeof value !== 'string' || value.length > 60) throw new Error('快捷键设置无效');
    const shortcut = normalizeAccountShortcut(value), custom = accountShortcuts();
    const conflict = accounts.findIndex((_account, other) => other !== index && shortcut && accountShortcut(other, custom) === shortcut);
    if (conflict >= 0) throw new Error(`该快捷键已用于第 ${conflict + 1} 个账号，请先清除或更改它`);
    custom[String(index)] = shortcut; db().setSetting('accountShortcuts', JSON.stringify(custom));
    broadcast('workspace:changed');
    return custom;
  });
  ipcMain.handle('settings:account-shortcuts-reset', event => {
    if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('只能在工作站设置快捷键');
    db().setSetting('accountShortcuts', '{}');
    broadcast('workspace:changed');
    return {};
  });
  ipcMain.handle('videos:list', () => db().videoLibrary());
  ipcMain.handle('projects:create', (_e, name) => db().createProject(name));
  ipcMain.handle('tasks:list', (_e, projectId) => db().tasks(projectId));
  ipcMain.handle('tasks:create', (_e, data) => db().createTask(data));
  ipcMain.handle('tasks:update', (_e, id, patch) => db().updateTask(id, patch));
  ipcMain.handle('tasks:complete', (_e, id, videoPath, accountId) => archiveDownload(id, videoPath, accountId));
  ipcMain.handle('author:open-douyin', () => shell.openExternal('https://v.douyin.com/Mm0paOp_7fE/'));
  ipcMain.handle('gateway:copy', (_e, text: string) => { clipboard.writeText(String(text ?? '').slice(0, 2000)); return true; });
}
