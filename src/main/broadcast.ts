import { BrowserWindow } from 'electron';

/** 向所有未销毁的窗口广播事件（已销毁窗口的 webContents.send 会抛异常）。 */
export function broadcast(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}
